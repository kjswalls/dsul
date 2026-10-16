import { beforeAll, beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import pocket from '../../electron/lib/pocket.cjs';
import builder from '../../electron/electron-builder.config.cjs';
import { fnSource, read } from './helpers/electron-main';

// Do stuff's pocket in the desktop shell: the pure decisions (electron/lib/pocket.cjs), the
// pocket's page (pocket.html) and its wiring (pocket-preload.cjs, run here against the markup
// with a stand-in ipcRenderer), and the lines in main.cjs that hold them together.
// memory/plans/power-mode.md, the polish round; electron/main.cjs "Pocket".
const { POCKET, POCKET_BG, MAX_TEXT, shapePocket, parseAction, pocketBounds } = pocket;

describe('electron/lib/pocket.cjs', () => {
  it('stays pure: no requires and no imports', () => {
    const source = read('electron/lib/pocket.cjs');
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/^\s*import\b/m);
  });

  it('passes only the fields the pocket shows, as plain strings and numbers', () => {
    const sprint = { startedAt: 1000, endsAt: 61_000, until: 'Lunch with Ana', extra: 'x' };
    expect(
      shapePocket({ id: 'a', title: '  Text   Priya ', done: 2.7, sprint, html: '<b>' })
    ).toEqual({ id: 'a', title: 'Text Priya', done: 2, sprint: { startedAt: 1000, endsAt: 61_000, until: 'Lunch with Ana' } });
    // Nothing current, or a shape this shell doesn't know.
    for (const none of [null, undefined, 'x', {}, { id: 'a' }, { title: 'x' }, { id: 1, title: 'x' }]) {
      expect(shapePocket(none)).toBeNull();
    }
    // A sprint that can't be drawn is dropped; the item still shows.
    expect(shapePocket({ id: 'a', title: 'x', sprint: { startedAt: 5, endsAt: 5 } })!.sprint).toBeNull();
    expect(shapePocket({ id: 'a', title: 'x', sprint: { startedAt: Number.NaN, endsAt: 9 } })!.sprint).toBeNull();
    expect(shapePocket({ id: 'a', title: 'x', sprint: { startedAt: 1, endsAt: 9 } })!.sprint!.until).toBeNull();
    // Long text is cut, never refused.
    expect(shapePocket({ id: 'a', title: 'y'.repeat(500) })!.title).toHaveLength(MAX_TEXT);
    expect(shapePocket({ id: 'a', title: 'x', done: -3 })!.done).toBe(0);
  });

  it('takes only its four actions, and done and skip only with an id', () => {
    expect(parseAction({ action: 'done', id: 'a' })).toEqual({ action: 'done', id: 'a' });
    expect(parseAction({ action: 'skip', id: 'a' })).toEqual({ action: 'skip', id: 'a' });
    expect(parseAction({ action: 'open', id: '' })).toEqual({ action: 'open' });
    expect(parseAction({ action: 'close' })).toEqual({ action: 'close' });
    for (const bad of [null, 'done', { action: 'done' }, { action: 'done', id: '' }, { action: 'delete', id: 'a' }]) {
      expect(parseAction(bad)).toBeNull();
    }
  });

  it("opens in the work area's top-right corner, or where it was left while that is on a display", () => {
    const area = { x: 0, y: 25, width: 1440, height: 875 };
    const corner = { x: 1440 - POCKET.width - POCKET.margin, y: 25 + POCKET.margin, width: POCKET.width, height: POCKET.height };
    expect(pocketBounds(area, null, [])).toEqual(corner);
    const displays = [{ workArea: area }, { workArea: { x: 1440, y: 0, width: 1920, height: 1040 } }];
    expect(pocketBounds(area, { x: 2000, y: 300 }, displays)).toEqual({ x: 2000, y: 300, width: POCKET.width, height: POCKET.height });
    // Left on a display that has gone, or hanging off one.
    expect(pocketBounds(area, { x: 4000, y: 300 }, displays)).toEqual(corner);
    expect(pocketBounds(area, { x: 1300, y: 300 }, [{ workArea: area }])).toEqual(corner);
  });
});

describe('electron/pocket.html', () => {
  const html = read('electron/pocket.html');

  it('runs no script of its own', () => {
    expect(html).toMatch(/script-src 'none'/);
    expect(html).not.toMatch(/<script/i);
  });

  it("paints lib/pocket.cjs's ground in each scheme", () => {
    expect(html).toContain(`--bg: ${POCKET_BG.light}`);
    expect(html).toContain(`--bg: ${POCKET_BG.dark}`);
  });

  it('is dragged by its body, and its buttons stay clickable', () => {
    expect(html).toMatch(/body \{[^}]*-webkit-app-region: drag/);
    expect(html).toMatch(/button \{ -webkit-app-region: no-drag; \}/);
  });
});

describe('electron/pocket-preload.cjs', () => {
  const sent: unknown[][] = [];
  const required: string[] = [];
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => void>();
  const $ = (id: string) => document.getElementById(id)!;
  const emit = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);

  beforeAll(() => {
    const page = new DOMParser().parseFromString(read('electron/pocket.html'), 'text/html');
    document.body.innerHTML = page.body.innerHTML;
    const ipcRenderer = {
      send: (...args: unknown[]) => sent.push(args),
      on: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) => handlers.set(channel, fn),
    };
    const fakeRequire = (name: string) => {
      required.push(name);
      if (name !== 'electron') throw new Error(`module not found: ${name}`);
      return { ipcRenderer };
    };
    new Function('require', 'process', 'exports', 'module', read('electron/pocket-preload.cjs'))(
      fakeRequire,
      {},
      {},
      { exports: {} },
    );
  });
  beforeEach(() => {
    sent.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('requires nothing but electron, and says when it is listening', () => {
    expect(required).toEqual(['electron']);
    expect(handlers.has('dsul-pocket:state')).toBe(true);
  });

  it('shows the item and how many are done', () => {
    emit('dsul-pocket:state', { id: 'a', title: 'Text Priya', done: 2, sprint: null });
    expect($('title').textContent).toBe('Text Priya');
    expect($('line').textContent).toBe('now · 2 done');
    expect(($('sprint') as HTMLElement).hidden).toBe(true);
  });

  it("counts a sprint down in the web's words, and says when it is up", () => {
    vi.useFakeTimers();
    const start = new Date('2026-10-16T10:00:00Z').getTime();
    vi.setSystemTime(start);
    emit('dsul-pocket:state', {
      id: 'a',
      title: 'Text Priya',
      done: 0,
      sprint: { startedAt: start, endsAt: start + 75 * 60_000, until: 'Lunch with Ana' },
    });
    expect($('line').textContent).toBe('1h 15m left · till Lunch with Ana');
    expect(($('sprint') as HTMLElement).hidden).toBe(false);
    vi.advanceTimersByTime(45 * 60_000);
    expect($('line').textContent).toBe('30m left · till Lunch with Ana');
    vi.advanceTimersByTime(30 * 60_000);
    expect($('line').textContent).toBe("time's up · Lunch with Ana next");
  });

  it('sends each button with the id it was pressed on, and Escape closes', () => {
    emit('dsul-pocket:state', { id: 'b', title: 'Call the bank', done: 0, sprint: null });
    for (const id of ['done', 'skip', 'open', 'close']) $(id).click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(sent).toEqual([
      ['dsul-pocket:action', { action: 'done', id: 'b' }],
      ['dsul-pocket:action', { action: 'skip', id: 'b' }],
      ['dsul-pocket:action', { action: 'open', id: 'b' }],
      ['dsul-pocket:action', { action: 'close', id: 'b' }],
      ['dsul-pocket:action', { action: 'close', id: 'b' }],
    ]);
  });
});

describe('electron/main.cjs: the pocket', () => {
  const main = read('electron/main.cjs');

  it('gives the pocket a sandboxed, isolated preload and no frame', () => {
    const open = fnSource(main, 'openPocket');
    expect(open).toMatch(
      /preload: path\.join\(__dirname, 'pocket-preload\.cjs'\),\s+contextIsolation: true,\s+sandbox: true,\s+nodeIntegration: false,/
    );
    expect(open).toMatch(/frame: false/);
    expect(open).toMatch(/showInactive\(\)/);
    expect(open).not.toMatch(/\.focus\(\)/);
  });

  it('never lets the pocket navigate or open anything', () => {
    expect(fnSource(main, 'guardNavigation')).toMatch(/if \(isFindBar\(contents\) \|\| isPocket\(contents\)\) \{\s+event\.preventDefault\(\);/);
    expect(fnSource(main, 'harden')).toMatch(/!isApp\(url\) && !isFindBar\(contents\) && !isPocket\(contents\)/);
  });

  it("answers the pocket's channels only from its own page, and the page's only from the app", () => {
    expect(fnSource(main, 'fromPocket')).toMatch(/frame\.url === POCKET_URL/);
    const ipc = fnSource(main, 'registerIpc');
    expect(ipc).toMatch(/'dsul:pocket-state', \(event, raw\) => \{\s+if \(fromApp\(event\)\)/);
    expect(ipc).toMatch(/'dsul:pocket-open', \(event\) => \(fromApp\(event\)/);
    expect(ipc).toMatch(/'dsul-pocket:ready', \(event\) => \{\s+if \(fromPocket\(event\)\)/);
    expect(ipc).toMatch(/'dsul-pocket:action', \(event, raw\) => \{\s+if \(fromPocket\(event\)\) onPocketAction\(pocket\.parseAction\(raw\)\)/);
  });

  it('passes done and skip to the page only for the item it shows', () => {
    expect(fnSource(main, 'onPocketAction')).toMatch(/message\.id === pocketState\.id/);
  });

  it('closes the pocket when the page goes: a new document or a crash has no Do stuff run', () => {
    const create = fnSource(main, 'createWindow');
    expect(create).toMatch(/closeFind\(\);\s+setPocketState\(null\);\s+\/\/ Each document/);
    expect(create).toMatch(/captureReady = false;\s+closeFind\(\);\s+setPocketState\(null\);\s+const now/);
  });

  it('is packed into the installed app', () => {
    expect(builder.files).toEqual(expect.arrayContaining(['pocket.html', 'pocket-preload.cjs', 'lib/**']));
  });
});

describe('electron/preload.cjs: the pocket', () => {
  const preload = read('electron/preload.cjs');

  it('sends only the state, and passes the page only the action and the id', () => {
    expect(preload).toMatch(/setPocket\(state\) \{\s+ipcRenderer\.send\('dsul:pocket-state'/);
    expect(preload).toMatch(/const plain = \{ action: message && message\.action, id: message && message\.id \};/);
  });
});
