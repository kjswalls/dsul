import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import findBar from '../../electron/lib/find-bar.cjs';
import chrome from '../../electron/lib/window-chrome.cjs';
import builder from '../../electron/electron-builder.config.cjs';
import { fnSource, handlerSource, read } from './helpers/electron-main';

// Find in page in the desktop shell: the pure decisions (electron/lib/find-bar.cjs), the bar's
// page (find-bar.html), its wiring (find-preload.cjs, run here against the bar's markup with a
// stand-in ipcRenderer, since find-preload.cjs requires nothing but 'electron'), and the
// lines in main.cjs that hold them together. memory/plans/desktop-app.md, "Find in page".
const {
  FIND_BAR,
  FIND_BAR_BG,
  MAX_QUERY,
  MATCH_GAP,
  barBounds,
  avoidMatch,
  cleanQuery,
  countLabel,
  isCurrentReply,
  findMenu,
  findMenuPlace,
} = findBar;
const { TITLE_BAND_PX, LIGHTS_ZOOM_MAX } = chrome;

describe('electron/lib/find-bar.cjs', () => {
  it('stays pure: no requires and no imports, so this suite can load it without Electron', () => {
    const source = read('electron/lib/find-bar.cjs');
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/^\s*import\b/m);
  });

  it('hangs the bar from the top-right corner, below the macOS drag band', () => {
    const content = { x: 0, y: 0, width: 1280, height: 833 };
    // macOS: the band is the window's drag region, and a click on the bar inside it would drag
    // the window instead.
    expect(barBounds(content, TITLE_BAND_PX)).toEqual({
      x: 1280 - FIND_BAR.right - FIND_BAR.width,
      y: TITLE_BAND_PX + FIND_BAR.top,
      width: FIND_BAR.width,
      height: FIND_BAR.height,
    });
    // Windows, and macOS full screen: nothing above the content area to keep clear of.
    expect(barBounds(content, 0).y).toBe(FIND_BAR.top);
    // Narrower than the bar (never at minWidth 900, but a bad size must not go negative).
    expect(barBounds({ width: 200, height: 100 }, 0)).toEqual({ x: 16, y: 8, width: 168, height: 44 });
    expect(barBounds({ width: Number.NaN, height: 0 }, Number.NaN)).toEqual({ x: 0, y: 8, width: 0, height: 44 });
  });

  it("clears the band's outward rounding at any zoom", () => {
    // Blink scales env(titlebar-area-height) by 1 / zoom and rounds the rect outward, so the band
    // is ceil(43 / z) * z DIPs, under 43 + z, and Chromium caps z at 5: it stays under 48 DIPs
    // (the worst of the View menu's steps is 47.3, at 430%). The bar's gap below it covers that.
    expect(FIND_BAR.top).toBeGreaterThanOrEqual(LIGHTS_ZOOM_MAX);
  });

  it("steps aside for the active match by Chrome's rule", () => {
    const bar = barBounds({ width: 1280 }, TITLE_BAND_PX); // x 904..1264, y 51..95
    // No match, an empty rect, junk: the bar stays in its corner.
    for (const none of [null, undefined, {}, { x: 950, y: 60, width: 0, height: 20 }, { x: Number.NaN, y: 60, width: 40, height: 20 }]) {
      expect(avoidMatch(bar, none)).toBe(bar);
    }
    // A match clear of the bar, above it, beside it, or touching its edge only.
    expect(avoidMatch(bar, { x: 500, y: 60, width: 40, height: 20 })).toBe(bar);
    expect(avoidMatch(bar, { x: 950, y: 20, width: 40, height: 31 })).toBe(bar);
    expect(avoidMatch(bar, { x: 864, y: 60, width: 40, height: 20 })).toBe(bar);
    // Under the bar: it moves to the match's left, MATCH_GAP clear of it, and nothing else moves.
    expect(avoidMatch(bar, { x: 950.4, y: 60, width: 40, height: 20 })).toEqual({
      ...bar,
      x: 950 - FIND_BAR.width - MATCH_GAP,
    });
    // Unless that takes it past the left edge.
    expect(avoidMatch(bar, { x: 200, y: 60, width: 1000, height: 20 })).toBe(bar);
  });

  it('shows the count the way Chrome does', () => {
    expect(countLabel({ matches: 12, activeMatchOrdinal: 3 })).toEqual({ text: '3 of 12', none: false });
    expect(countLabel({ matches: 1, activeMatchOrdinal: 1 })).toEqual({ text: '1 of 1', none: false });
    expect(countLabel({ matches: 0, activeMatchOrdinal: 0 })).toEqual({ text: 'No results', none: true });
    expect(countLabel({ matches: 12, activeMatchOrdinal: 0 })).toEqual({ text: '12 found', none: false });
    expect(countLabel({ matches: 12, activeMatchOrdinal: 13 })).toEqual({ text: '12 found', none: false });
    for (const junk of [null, undefined, {}, { matches: '3' }, { matches: -1 }, { matches: 2.5 }]) {
      expect(countLabel(junk)).toEqual({ text: 'No results', none: true });
    }
  });

  it('keeps only replies to the search the bar shows', () => {
    expect(isCurrentReply({ requestId: 7 }, 7)).toBe(true); // the search itself
    expect(isCurrentReply({ requestId: 9 }, 7)).toBe(true); // a next or previous step
    expect(isCurrentReply({ requestId: 6 }, 7)).toBe(false); // an abandoned search
    expect(isCurrentReply({ requestId: 3 }, 0)).toBe(false); // no search at all
    expect(isCurrentReply(null, 7)).toBe(false);
    expect(isCurrentReply({}, 7)).toBe(false);
  });

  it('takes the query as typed, capped', () => {
    expect(cleanQuery('  two words ')).toBe('  two words ');
    expect(cleanQuery('x'.repeat(MAX_QUERY + 50))).toHaveLength(MAX_QUERY);
    for (const junk of [undefined, null, 3, {}, ['a']]) expect(cleanQuery(junk)).toBe('');
  });

  it('binds Ctrl/⌘ F and G everywhere, a hidden Ctrl+F on a Mac, and F3 only off it', () => {
    const shared = [
      { label: 'Find…', accelerator: 'CommandOrControl+F', action: 'open' },
      { label: 'Find Next', accelerator: 'CommandOrControl+G', action: 'next' },
      { label: 'Find Previous', accelerator: 'Shift+CommandOrControl+G', action: 'previous' },
    ];
    // Kirby reaches for Ctrl, and dsul's Ctrl/⌘ F handlers take either key, so a Mac gets a hidden
    // Ctrl+F too.
    expect(findMenu('darwin')).toEqual([
      ...shared,
      { label: 'Find…', accelerator: 'Control+F', action: 'open', visible: false, acceleratorWorksWhenHidden: true },
    ]);
    // F3 is Mission Control on a Mac.
    for (const p of ['win32', 'linux']) {
      expect(findMenu(p)).toEqual([
        ...shared,
        { label: 'Find Next', accelerator: 'F3', action: 'next', visible: false },
        { label: 'Find Previous', accelerator: 'Shift+F3', action: 'previous', visible: false },
      ]);
    }
    // Escape belongs to the page (its dialogs and the Organize escape ladder): the bar closes on
    // Esc only while it has focus, which find-preload.cjs handles.
    for (const p of ['darwin', 'win32', 'linux']) {
      for (const item of findMenu(p)) expect(item.accelerator).not.toMatch(/Escape|Esc\b/);
    }
  });

  it("puts Find right after Select All in the editMenu role's own items", () => {
    // Electron 44.5.1's editMenu (menu-item-roles.ts), roles lowercased as MenuItem stores them.
    const sep = { type: 'separator' };
    const mac = [
      { role: 'undo' }, { role: 'redo' }, sep, { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
      { role: 'pasteandmatchstyle' }, { role: 'delete' }, { role: 'selectall' }, sep,
      { label: 'Substitutions', type: 'submenu' }, { label: 'Speech', type: 'submenu' },
    ];
    const win = [
      { role: 'undo' }, { role: 'redo' }, sep, { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
      { role: 'delete' }, sep, { role: 'selectall' },
    ];
    // macOS: behind the separator that already follows Select All, before Substitutions.
    expect(findMenuPlace(mac)).toEqual({ at: 10, separator: false });
    // Windows: Select All is last, so a separator goes in first.
    expect(findMenuPlace(win)).toEqual({ at: 9, separator: true });
    // A role that one day lacks Select All gets Find at the foot.
    expect(findMenuPlace([{ role: 'undo' }])).toEqual({ at: 1, separator: true });
  });
});

describe('electron/find-bar.html', () => {
  const html = read('electron/find-bar.html');

  it('runs no script of its own and loads nothing', () => {
    expect(html).not.toMatch(/<script\b/i);
    expect(html).toMatch(/default-src 'none'; script-src 'none';/);
    expect(html).toContain("form-action 'none'");
    expect(html).not.toMatch(/\b(?:src|href)=/i);
    expect(html).not.toMatch(/url\(/i);
  });

  it('paints the ground main paints the view with, in both schemes', () => {
    expect(html).toContain(`--bg: ${FIND_BAR_BG.light};`);
    expect(html).toMatch(new RegExp(`prefers-color-scheme: dark\\)[\\s\\S]*--bg: ${FIND_BAR_BG.dark};`));
    expect(html).toContain(`border-radius: ${FIND_BAR.radius}px;`);
  });

  it('labels every control and announces the count', () => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector('[role="search"]')?.getAttribute('aria-label')).toBe('Find in page');
    expect(doc.getElementById('query')?.getAttribute('aria-label')).toBe('Find in page');
    const count = doc.getElementById('count')!;
    expect(count.getAttribute('role')).toBe('status');
    expect(count.getAttribute('aria-live')).toBe('polite');
    for (const id of ['previous', 'next', 'close']) {
      const button = doc.getElementById(id)!;
      expect(button.getAttribute('type')).toBe('button');
      expect(button.getAttribute('aria-label')).toBeTruthy();
    }
  });
});

describe('electron/find-preload.cjs', () => {
  // The preload runs once against the bar's markup in this suite's document, with a stand-in
  // ipcRenderer, and the same parameters Electron's sandboxed loader passes
  // (sandboxed_renderer/preload.ts). Electron runs it before the markup exists; that path is
  // covered by the smoke run and the manual checks, since jsdom's document has already loaded.
  const sent: unknown[][] = [];
  const required: string[] = [];
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => void>();
  const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
  const key = (target: EventTarget, init: KeyboardEventInit) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const emit = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);

  beforeAll(() => {
    const bar = new DOMParser().parseFromString(read('electron/find-bar.html'), 'text/html');
    document.body.innerHTML = bar.body.innerHTML;
    const ipcRenderer = {
      send: (...args: unknown[]) => sent.push(args),
      on: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) => handlers.set(channel, fn),
    };
    const fakeRequire = (name: string) => {
      required.push(name);
      if (name !== 'electron') throw new Error(`module not found: ${name}`);
      return { ipcRenderer };
    };
    new Function('require', 'process', 'exports', 'module', read('electron/find-preload.cjs'))(
      fakeRequire,
      {},
      {},
      { exports: {} },
    );
  });
  beforeEach(() => {
    sent.length = 0;
  });

  it('requires nothing but electron', () => {
    expect(required).toEqual(['electron']);
  });

  it('sends each edit, Enter, Shift+Enter, Escape and the three buttons', () => {
    const query = $('query');
    query.value = 'apple';
    query.dispatchEvent(new Event('input', { bubbles: true }));
    expect(key(query, { key: 'Enter' })).toBe(true);
    expect(key(query, { key: 'Enter', shiftKey: true })).toBe(true);
    expect(key(query, { key: 'Escape' })).toBe(true);
    $('previous').click();
    $('next').click();
    $('close').click();
    expect(sent).toEqual([
      ['dsul-find:query', 'apple'],
      ['dsul-find:step', true],
      ['dsul-find:step', false],
      ['dsul-find:close'],
      ['dsul-find:step', false],
      ['dsul-find:step', true],
      ['dsul-find:close'],
    ]);
  });

  it('leaves an input method that is composing alone', () => {
    expect(key($('query'), { key: 'Enter', isComposing: true })).toBe(false);
    expect(key($('query'), { key: 'Escape', keyCode: 229 })).toBe(false);
    expect(sent).toEqual([]);
  });

  it("closes on Escape from a button too, but Enter there is the button's own", () => {
    expect(key($('next'), { key: 'Enter' })).toBe(false);
    expect(key($('next'), { key: 'Escape' })).toBe(true);
    expect(sent).toEqual([['dsul-find:close']]);
  });

  it("leaves Find's own keys and the zoom keys to the menu", () => {
    // The View zoom items zoom the page whichever view has focus (main.cjs zoomPage), so Ctrl/⌘ =
    // pressed in the bar zooms the page, as in Chrome, and the bar never zooms.
    for (const init of [
      { key: 'f', ctrlKey: true },
      { key: 'f', metaKey: true },
      { key: 'g', ctrlKey: true },
      { key: 'G', ctrlKey: true, shiftKey: true },
      { key: 'F3' },
      { key: 'Enter', ctrlKey: true },
      { key: '=', ctrlKey: true },
      { key: '+', metaKey: true },
      { key: '-', ctrlKey: true },
      { key: '0', metaKey: true },
    ]) {
      expect(key($('query'), init), JSON.stringify(init)).toBe(false);
    }
    expect(sent).toEqual([]);
  });

  it('shows the last search selected, and the count main sends', () => {
    emit('dsul-find:show', 'apple');
    const query = $('query');
    expect(query.value).toBe('apple');
    expect(document.activeElement).toBe(query);
    expect([query.selectionStart, query.selectionEnd]).toEqual([0, 5]);
    emit('dsul-find:count', { text: 'No results', none: true });
    expect($('count').textContent).toBe('No results');
    expect(document.querySelector('[role="search"]')!.getAttribute('data-none')).toBe('true');
    emit('dsul-find:count', { text: '3 of 12', none: false });
    expect($('count').textContent).toBe('3 of 12');
    emit('dsul-find:show', 42);
    expect(query.value).toBe('');
  });
});

// CI can't run Electron, so these hold main.cjs's load-bearing find lines in place.
describe('main.cjs: find in page', () => {
  const main = read('electron/main.cjs');

  it('loads the bar as a data: URL with its own sandboxed preload, and answers only that page', () => {
    expect(main).toContain("const FIND_URL = dataUrl('find-bar.html');");
    expect(main).toMatch(
      /preload: path\.join\(__dirname, 'find-preload\.cjs'\),\s+contextIsolation: true,\s+sandbox: true,\s+nodeIntegration: false,/,
    );
    expect(fnSource(main, 'fromFindBar')).toContain('frame.url === FIND_URL');
    expect(main.match(/ipcMain\.on\('dsul-find:/g)).toHaveLength(3);
    expect(main.match(/if \(fromFindBar\(event\)/g)).toHaveLength(3);
  });

  it('opens it from the Edit menu, never from before-input-event', () => {
    // A menu accelerator fires only for a key the page left alone, which is what keeps the
    // settings search's and the Organize filter's own Ctrl/⌘ F.
    expect(main).toMatch(/findBar\s*\.findMenu\(process\.platform\)/);
    expect(main).toContain('findBar.findMenuPlace(edit.submenu.items)');
    expect(main).not.toContain("'before-input-event'");
  });

  it('ends every search with nothing selected, and never clicks the match', () => {
    // keepSelection would focus a field holding the match, and the next key would overwrite it.
    expect(main).not.toMatch(/'(keepSelection|activateSelection)'/);
    expect(fnSource(main, 'closeFind')).toContain("stopFindInPage('clearSelection')");
    for (const m of main.match(/stopFindInPage\([^)]*\)/g) ?? []) expect(m).toBe("stopFindInPage('clearSelection')");
    expect(main).toContain("if (fromFindBar(event)) closeFind();");
  });

  it('closes the bar as the window closes to the tray or Dock, never on hide', () => {
    // No 'hide' listener at all (macOS fires it whenever the window is covered):
    // electron-window-state.test.ts holds that.
    const close = handlerSource(main, "win.on('close', (event) => {");
    expect(close).toMatch(/event\.preventDefault\(\);\n(?: {4}\/\/[^\n]*\n)* {4}closeFind\(\);\n/);
    expect(close.indexOf('closeFind();')).toBeLessThan(close.indexOf('setFullScreen(false)'));
    expect(close.indexOf('closeFind();')).toBeLessThan(close.indexOf('park()'));
  });

  it('gives the page the keyboard back before it hides the bar', () => {
    // Hiding a view that holds the focus moves it nowhere.
    const close = fnSource(main, 'closeFind');
    const hadFocus = close.indexOf('const hadFocus = !!bar && bar.isFocused();');
    const focus = close.indexOf('if (hadFocus && win.isVisible()) win.webContents.focus();');
    const hide = close.indexOf('findView.setVisible(false)');
    expect(hadFocus).toBeGreaterThan(-1);
    expect(focus).toBeGreaterThan(hadFocus);
    expect(hide).toBeGreaterThan(focus);
  });

  it('closes on a new document before the lights are placed, and on a page crash', () => {
    const navigate = handlerSource(main, "contents.on('did-navigate',");
    expect(navigate).toMatch(/\n {4}closeFind\(\);\n(?: {4}\/\/[^\n]*\n)* {4}placeLights\(\);\n {2}\}\);$/);
    expect(navigate.indexOf('closeFind();')).toBeGreaterThan(navigate.indexOf('stopOfflineRetry();'));
    const gone = handlerSource(main, "contents.on('render-process-gone', (_event, details) => {\n    if (details.reason === 'clean-exit') return;\n    captureReady = false;");
    expect(gone).toContain('closeFind();');
  });

  it('makes the bar ahead of the first press, and takes the keyboard even while it loads', () => {
    expect(main).toContain("contents.once('did-stop-loading', ensureFindView);");
    // Before the bar's page has loaded, the page's one-key shortcuts must not get what is typed.
    const open = fnSource(main, 'openFind');
    const waiting = open.slice(open.indexOf('if (findReady)'));
    expect(waiting).toMatch(/findView\.setVisible\(true\);\n {2}findView\.webContents\.focus\(\);\n\}/);
  });

  it('never leaves the keyboard in a closed bar', () => {
    // Made hidden as the window first comes to the front, the bar can be handed the focus, and
    // then nothing typed reaches the page. Both its own focus and the window's ask.
    expect(main).toContain("contents.on('focus', keepKeysOffClosedBar);");
    expect(main).toContain("win.on('focus', keepKeysOffClosedBar);");
    const keep = fnSource(main, 'keepKeysOffClosedBar');
    expect(keep).toContain('setTimeout(');
    expect(keep).toContain('if (findOpen || !bar || !bar.isFocused() || !win || win.isDestroyed() || !win.isFocused()) return;');
  });

  it("lets a bar whose renderer exits cleanly be, and moves the keyboard only if it was open", () => {
    const ensure = fnSource(main, 'ensureFindView');
    const gone = ensure.slice(ensure.indexOf("contents.on('render-process-gone'"));
    expect(gone).toMatch(/findReady = false;\n {4}if \(details\.reason === 'clean-exit'\) return;/);
    expect(gone).toContain('if (wasOpen && win && !win.isDestroyed() && win.isFocused()) win.webContents.focus();');
    // isCrashed() reads false after a clean exit, so the reload asks whether the page is there.
    expect(ensure).toContain('if (!findReady && !existing.isLoading()) load(existing, FIND_URL);');
  });

  it('gives a quick capture the keyboard whether or not the bar had it', () => {
    const capture = fnSource(main, 'capture');
    expect(capture).toMatch(/reveal\(\);\n(?: {2}\/\/[^\n]*\n)* {2}closeFind\(\);\n {2}if \(win && !win\.isDestroyed\(\)\) win\.webContents\.focus\(\);/);
  });

  it('keeps clear of the band except in full screen, and places again on the way in and out', () => {
    expect(fnSource(main, 'placeFind')).toContain('IS_MAC && !full ? TITLE_BAND_PX : 0');
    expect(main).toContain("win.on('enter-full-screen', () => placeFind(true));");
    expect(main).toContain("win.on('leave-full-screen', () => placeFind(false));");
    expect(fnSource(main, 'placeFind')).toContain('findBar.avoidMatch(bounds, findMatch)');
  });

  it('keeps the find bar from navigating or opening anything', () => {
    expect(fnSource(main, 'guardNavigation')).toMatch(
      /^function guardNavigation\(event, contents\) \{\n(?: {2}\/\/[^\n]*\n)* {2}if \(isFindBar\(contents\)\) \{\n {4}event\.preventDefault\(\);\n {4}return;/,
    );
    expect(main).toContain('if (!isApp(url) && !isFindBar(contents)) openOutside(url);');
  });

  it('packs every file main.cjs loads', () => {
    // electron-builder's `files` is an allow-list: a file left out works in `electron .` and
    // fails only in the installed app.
    const loaded = [
      ...[...main.matchAll(/path\.join\(__dirname, '([^']+)'\)/g)].map((m) => m[1]),
      ...[...main.matchAll(/dataUrl\('([^']+)'\)/g)].map((m) => m[1]),
      ...[...main.matchAll(/require\('\.\/([^']+)'\)/g)].map((m) => m[1]),
    ];
    expect(loaded).toEqual(
      expect.arrayContaining(['find-bar.html', 'find-preload.cjs', 'lib/find-bar.cjs', 'offline.html', 'preload.cjs']),
    );
    // The config's `files` is a plain list of globs (electron-builder types it more widely).
    const files = builder.files as string[];
    const packed = (file: string) =>
      files.some((glob) =>
        glob.endsWith('/**')
          ? file.startsWith(glob.slice(0, -2))
          : glob.endsWith('*')
            ? file.startsWith(glob.slice(0, -1))
            : file === glob,
      );
    for (const file of loaded) expect(packed(file), file).toBe(true);
  });
});
