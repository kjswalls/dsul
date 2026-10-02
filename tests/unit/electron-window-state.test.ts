import { describe, expect, it } from 'vitest';
import chrome from '../../electron/lib/window-chrome.cjs';
import state from '../../electron/lib/window-state.cjs';
import { fnSource, read } from './helpers/electron-main';

// Where the desktop window reopens (electron/lib/window-state.cjs). CI can't run Electron, so
// everything main.cjs decides about a saved window is decided here and held to these cases.
const {
  VERSION,
  DEFAULT_SIZE,
  MIN_SIZE,
  BAND_PX,
  GRAB_PX,
  displayAreas,
  grabbable,
  fitBounds,
  placeWindow,
  parseWindowState,
  serializeWindowState,
  windowStateToSave,
} = state;

type Rect = { x: number; y: number; width: number; height: number };
const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

// Work areas as Electron reports them: DIP, the menu bar and the taskbar already taken out.
const MAC = r(0, 25, 1440, 875); // a 14" MacBook, menu bar 25
const MAC_EXT = r(1440, 25, 2560, 1415); // a 27" to its right, with its own menu bar (Spaces per display)
const WIN = r(0, 0, 1920, 1032); // 1080p at 100%, taskbar 48
const WIN_150 = r(0, 0, 1280, 688); // the same panel at 150%
const WIN_LEFT = r(-2560, -200, 2560, 1392); // a secondary LEFT of and above the primary
const WIN_TOP_BAR = r(0, 48, 1920, 1032); // taskbar docked at the top

const file = (b: Rect, maximized = false) => JSON.stringify({ v: VERSION, ...b, maximized });
const bounds = (p: Record<string, unknown>) => r(p.x as number, p.y as number, p.width as number, p.height as number);

// The band's whole height and GRAB_PX of its width on one work area.
function bandOn(b: Rect, wa: Rect) {
  const w = Math.min(b.x + b.width, wa.x + wa.width) - Math.max(b.x, wa.x);
  return b.y >= wa.y && b.y + BAND_PX <= wa.y + wa.height && w >= GRAB_PX;
}

describe('electron/lib/window-state.cjs', () => {
  it('stays pure: no requires and no imports, so this suite can load it without Electron', () => {
    const source = read('electron/lib/window-state.cjs');
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/^\s*import\b/m);
  });

  it("keeps today's numbers, and the band is the page's", () => {
    expect(DEFAULT_SIZE).toEqual({ width: 1280, height: 860 });
    expect(MIN_SIZE).toEqual({ width: 900, height: 600 });
    expect(BAND_PX).toBe(chrome.TITLE_BAND_PX);
  });
});

// main.cjs can't run in CI. These hold the few lines the behaviour hangs on.
describe('main.cjs wiring', () => {
  const main = read('electron/main.cjs');

  it('gives the window the minimum this file places to, and no fixed size', () => {
    expect(main).toContain('minWidth: windowState.MIN_SIZE.width,');
    expect(main).toContain('minHeight: windowState.MIN_SIZE.height,');
    expect(main).not.toMatch(/\bwidth: 1280\b/);
    // Two restorers would fight over one window.
    expect(main).not.toContain('windowStatePersistence');
  });

  it('writes the file in one place, straight over the old one', () => {
    expect(main.split('fs.writeFileSync(stateFile(), text);')).toHaveLength(2);
    expect(main).not.toContain('renameSync');
  });

  it('never saves from a hidden window or on macOS occlusion', () => {
    // macOS emits 'hide' whenever the window is covered, not only when the shell hides it.
    expect(main).not.toMatch(/\.(on|once)\(\s*'hide'/);
    expect(main).toContain('if (!shown || parked || !win || win.isDestroyed()) return;');
    // Tracking starts once the window is first on screen, and a reveal from the tray unparks it.
    expect(fnSource(main, 'firstShow')).toMatch(/\n {2}win\.show\(\);\n(?: {2}\/\/[^\n]*\n)* {2}shown = true;\n\}/);
    expect(fnSource(main, 'bringForward')).toContain('const wasParked = parked;\n    parked = false;');
    // Only a window the shell hid is moved on a reveal.
    expect(main).toContain('if (wasParked) refitWindow();');
  });

  it('saves at a quit and a Windows log-off after marking the quit, and keeps the page from moving the window', () => {
    expect(main).toMatch(/win\.on\('session-end', \(\) => \{\s*isQuitting = true;\s*saveState\(\);/);
    expect(main).toMatch(/app\.on\('before-quit', \(\) => \{\n {4}isQuitting = true;\n(?: {4}\/\/[^\n]*\n)* {4}saveState\(\);/);
    expect(main).toContain("contents.on('content-bounds-updated', (event) => event.preventDefault());");
  });

  it('saves as the window closes, while it is still on screen, then parks it, on both close paths', () => {
    // Parked first would skip the save; hidden first, macOS answers from AppKit's idea of it.
    expect(main).toMatch(
      /\nfunction park\(\) \{\n {2}parked = false;\n {2}saveState\(\);\n {2}parked = true;\n {2}win\.hide\(\);\n\}/,
    );
    expect(main.match(/\.hide\(\)/g)).toHaveLength(1);
    // The full-screen close is parked before the animation, and saves once it has left.
    expect(main).toMatch(/parked = true;\n {6}win\.once\('leave-full-screen', park\);\n {6}win\.setFullScreen\(false\);/);
  });

  it("saves the constructor's rounding as the bounds it asked for, so an untouched window never grows", () => {
    const opened = main.indexOf("if ('x' in bounds) openedAs = { asked: bounds, got: win.getBounds() };");
    expect(opened).toBeGreaterThan(main.indexOf('win = new BrowserWindow('));
    expect(opened).toBeLessThan(main.indexOf("win.once('ready-to-show'"));
    expect(main).toMatch(/windowState\.windowStateToSave\(\n[\s\S]*?\n {4}lastState,\n {4}process\.platform,\n {4}openedAs,\n {2}\);/);
  });
});

describe('parseWindowState', () => {
  it('reads back what serializeWindowState wrote', () => {
    for (const s of [
      { bounds: r(120, 80, 1280, 860), maximized: false },
      { bounds: r(-2400, -150, 1600, 1000), maximized: true },
    ]) {
      expect(parseWindowState(serializeWindowState(s))).toEqual(s);
    }
  });

  it('writes only the version, the rect and the flag', () => {
    const text = serializeWindowState({ bounds: { ...r(1, 2, 3, 4), extra: 1 }, maximized: false });
    expect(JSON.parse(text)).toEqual({ v: 1, x: 1, y: 2, width: 3, height: 4, maximized: false });
  });

  it('ignores keys it does not know', () => {
    const text = JSON.stringify({ v: 1, ...r(0, 0, 1000, 700), maximized: false, display: 7 });
    expect(parseWindowState(text)).toEqual({ bounds: r(0, 0, 1000, 700), maximized: false });
  });

  it('refuses a corrupt or foreign file, so the window opens at the default', () => {
    const good = file(r(10, 20, 1000, 700));
    for (const text of [
      '',
      ' ',
      '{',
      good.slice(0, -1), // cut short mid-write
      good.slice(0, 20),
      'null',
      '[]',
      '42',
      '"x"',
      '\u0000\u0000\u0000',
      JSON.stringify({ ...JSON.parse(good), v: 2 }),
      JSON.stringify({ ...JSON.parse(good), v: '1' }),
      JSON.stringify({ x: 10, y: 20, width: 1000, height: 700, maximized: false }),
      JSON.stringify({ ...JSON.parse(good), maximized: 'true' }),
      JSON.stringify({ v: 1, x: 10, y: 20, width: 1000, height: 700 }), // no flag
      JSON.stringify({ ...JSON.parse(good), x: 10.5 }),
      JSON.stringify({ ...JSON.parse(good), y: '20' }),
      JSON.stringify({ ...JSON.parse(good), width: 0 }),
      JSON.stringify({ ...JSON.parse(good), height: -700 }),
      JSON.stringify({ ...JSON.parse(good), x: 1e9 }),
      JSON.stringify({ ...JSON.parse(good), width: 1e300 }),
      JSON.stringify({ ...JSON.parse(good), x: null }),
      good + ' '.repeat(2000), // longer than anything this version writes
    ]) {
      expect(parseWindowState(text), text.slice(0, 60)).toBeNull();
    }
    for (const notText of [undefined, null, 42, {}, Buffer.from(good)]) {
      expect(parseWindowState(notText)).toBeNull();
    }
  });
});

describe('displayAreas', () => {
  const display = (id: number, workArea: Rect, over: Record<string, unknown> = {}) => ({
    id,
    detected: true,
    size: { width: workArea.width, height: workArea.height + 48 },
    workArea,
    ...over,
  });

  it('takes every real display, and the primary from among them', () => {
    const primary = display(1, WIN);
    expect(displayAreas([display(2, WIN_LEFT), primary], primary)).toEqual({
      workAreas: [WIN_LEFT, WIN],
      primary: WIN,
    });
  });

  it("leaves out Chromium's stand-ins, so the window never lands on a display that isn't there", () => {
    const real = display(1, WIN);
    const stand = [
      display(7, r(0, 0, 1920, 1080), { detected: false }), // Windows' made-up display, or one asleep
      display(-2, r(0, 0, 1920, 1080)), // kDefaultDisplayId: no display connected
      display(-1, r(0, 0, 1920, 1080)), // kInvalidDisplayId: not known yet
      display(8, r(0, 0, 1920, 1080), { size: { width: 0, height: 0 } }),
      display(9, r(0, 0, 0, 0)),
      null,
      'x',
    ];
    expect(displayAreas([...stand, real], real)).toEqual({ workAreas: [WIN], primary: WIN });
    // A placeholder primary falls back to the first real display, through fitBounds.
    const fake = display(-2, r(0, 0, 1920, 1080));
    const areas = displayAreas([fake, display(3, WIN_LEFT)], fake);
    expect(areas).toEqual({ workAreas: [WIN_LEFT], primary: null });
    expect(fitBounds(null, areas.workAreas, areas.primary)).toEqual(r(-1920, 66, 1280, 860));
    // A primary that isn't among the displays isn't taken on trust.
    expect(displayAreas([real], display(4, WIN_LEFT)).primary).toBeNull();
  });

  it('has nothing to offer when nothing real is connected, and Electron centres the window', () => {
    const fake = display(-2, r(0, 0, 1920, 1080));
    const areas = displayAreas([fake], fake);
    expect(areas).toEqual({ workAreas: [], primary: null });
    expect(placeWindow(null, areas.workAreas, areas.primary)).toEqual({ width: 1280, height: 860, maximized: false });
    for (const junk of [undefined, null, 'x', {}]) {
      expect(displayAreas(junk, junk)).toEqual({ workAreas: [], primary: null });
    }
  });
});

describe('fitBounds', () => {
  it('leaves a window that fits exactly where it was, so nothing creeps between launches', () => {
    for (const [b, areas] of [
      [r(120, 80, 1280, 860), [WIN]],
      [r(0, 25, 1440, 875), [MAC]], // filling the work area
      [r(-2400, -150, 1600, 1000), [WIN, WIN_LEFT]], // negative coordinates are a place
      [r(1000, 60, 1400, 900), [MAC, MAC_EXT]], // across two displays, fitting the one it is mostly on
      [r(1200, 300, 1280, 860), [WIN]], // half off the right edge, band still in reach
      [r(-900, 0, 1280, 860), [WIN]], // off the left edge with 380px of band on screen
      [r(-7, 0, 974, 1039), [WIN]], // Aero-snapped left: invisible borders hang off the edges
    ] as [Rect, Rect[]][]) {
      expect(fitBounds(b, areas, areas[0])).toEqual(b);
    }
  });

  it('moves a window whose band is out of reach wholly onto the display it overlaps most', () => {
    // Only 100px of band left on screen: not enough to grab beside the caption buttons.
    expect(fitBounds(r(1820, 100, 1280, 860), [WIN], WIN)).toEqual(r(640, 100, 1280, 860));
    expect(fitBounds(r(-1180, 100, 1280, 860), [WIN], WIN)).toEqual(r(0, 100, 1280, 860));
    // Band under the Mac's menu bar.
    expect(fitBounds(r(100, 0, 1200, 800), [MAC], MAC)).toEqual(r(100, 25, 1200, 800));
    // Band above the top of the work area, under a taskbar docked at the top.
    expect(fitBounds(r(100, 20, 1280, 860), [WIN_TOP_BAR], WIN_TOP_BAR)).toEqual(r(100, 48, 1280, 860));
    // Band below the bottom of the work area, behind the taskbar.
    expect(fitBounds(r(300, 1000, 1280, 860), [WIN], WIN)).toEqual(r(300, 172, 1280, 860));
  });

  it('picks the display the window overlaps most when its band is out of reach', () => {
    // Band above both displays; most of the window is on the external one.
    expect(fitBounds(r(1200, -30, 1400, 900), [MAC, MAC_EXT], MAC)).toEqual(r(1440, 25, 1400, 900));
  });

  it('fits a window across two displays to the one it is mostly on', () => {
    // Taller than the MacBook, and mostly on it: shrunk and moved wholly onto it.
    expect(fitBounds(r(600, 60, 1200, 1000), [MAC, MAC_EXT], MAC)).toEqual(r(240, 25, 1200, 875));
  });

  it('centres a window whose display was unplugged on the primary, fitted to it', () => {
    // Left on the 27"; only the MacBook now.
    expect(fitBounds(r(1800, 200, 2000, 1200), [MAC], MAC)).toEqual(r(0, 25, 1440, 875));
    expect(fitBounds(r(2000, 300, 1000, 700), [MAC], MAC)).toEqual(r(220, 112, 1000, 700));
    // Left on a secondary left of the primary (negative x); only the primary now.
    expect(fitBounds(r(-2000, 100, 1280, 860), [WIN], WIN)).toEqual(r(320, 86, 1280, 860));
    // Coordinates from a layout that no longer exists at all.
    expect(fitBounds(r(90000, -90000, 1280, 860), [WIN, WIN_LEFT], WIN)).toEqual(r(320, 86, 1280, 860));
  });

  it('shrinks a window to a display that got smaller, or a scale that got larger', () => {
    // Saved at 100%, reopened at 150%: the same panel is 1280x688 DIP.
    expect(fitBounds(r(100, 100, 1800, 900), [WIN_150], WIN_150)).toEqual(r(0, 0, 1280, 688));
    expect(fitBounds(r(100, 50, 1200, 900), [WIN_150], WIN_150)).toEqual(r(80, 0, 1200, 688));
  });

  it('never goes below the minimum, even from a tiny saved size', () => {
    expect(fitBounds(r(200, 200, 10, 10), [WIN], WIN)).toEqual(r(200, 200, 900, 600));
    expect(fitBounds(r(1800, 900, 10, 10), [WIN], WIN)).toEqual(r(1020, 432, 900, 600));
  });

  it('pins a window larger than a small work area to its top-left, band showing', () => {
    const small = r(0, 0, 1024, 560); // 1024x600 with a 40px taskbar
    expect(fitBounds(r(50, 50, 1280, 860), [small], small)).toEqual(r(0, 0, 1024, 600));
    const tiny = r(0, 0, 800, 560);
    expect(fitBounds(r(50, 50, 1280, 860), [tiny], tiny)).toEqual(r(0, 0, 900, 600));
  });

  it('starts at the default size centred on the primary when nothing was saved', () => {
    expect(fitBounds(null, [WIN_LEFT, WIN], WIN)).toEqual(r(320, 86, 1280, 860));
    expect(fitBounds(undefined, [MAC], MAC)).toEqual(r(80, 32, 1280, 860));
    expect(fitBounds(null, [WIN_150], WIN_150)).toEqual(r(0, 0, 1280, 688));
  });

  it('has nothing to place on without a display', () => {
    expect(fitBounds(r(0, 0, 1280, 860), [], null)).toBeNull();
    expect(fitBounds(r(0, 0, 1280, 860), undefined, undefined)).toBeNull();
    expect(fitBounds(r(0, 0, 1280, 860), [r(0, 0, 0, 0)], r(0, 0, 0, 0))).toBeNull();
    // A bad primary falls back to the first good display.
    expect(fitBounds(null, [WIN], null)).toEqual(r(320, 86, 1280, 860));
  });

  it('always opens grabbable and at least the minimum, and is stable from launch to launch', () => {
    // A seeded walk over saved rects and display layouts, sane and absurd.
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const layouts = [[WIN], [MAC], [MAC, MAC_EXT], [WIN, WIN_LEFT], [WIN_150], [WIN_TOP_BAR]];
    for (let i = 0; i < 3000; i++) {
      const areas = layouts[rand(layouts.length)];
      const b = r(rand(12000) - 6000, rand(8000) - 4000, rand(4000) + 1, rand(3000) + 1);
      for (const fit of [fitBounds(b, areas, areas[0]) as Rect, bounds(placeWindow({ bounds: b, maximized: false }, areas, areas[0]))]) {
        expect(fit.width).toBeGreaterThanOrEqual(MIN_SIZE.width);
        expect(fit.height).toBeGreaterThanOrEqual(MIN_SIZE.height);
        expect(areas.some((wa) => bandOn(fit, wa))).toBe(true);
        expect(grabbable(fit, areas)).toBe(true);
        expect(fitBounds(fit, areas, areas[0])).toEqual(fit);
      }
      // What a launch opens with is what the next launch opens with.
      const placed = placeWindow({ bounds: b, maximized: false }, areas, areas[0]);
      expect(placeWindow({ bounds: bounds(placed), maximized: placed.maximized }, areas, areas[0])).toEqual(placed);
    }
  });
});

describe('grabbable', () => {
  it('needs the whole band height and GRAB_PX of its width on one display', () => {
    expect(grabbable(r(1920 - GRAB_PX, 100, 1280, 860), [WIN])).toBe(true);
    expect(grabbable(r(1920 - GRAB_PX + 1, 100, 1280, 860), [WIN])).toBe(false);
    expect(grabbable(r(100, 1032 - BAND_PX, 1280, 860), [WIN])).toBe(true);
    expect(grabbable(r(100, 1032 - BAND_PX + 1, 1280, 860), [WIN])).toBe(false);
    expect(grabbable(r(100, 24, 1280, 860), [MAC])).toBe(false);
    expect(grabbable(r(100, 25, 1280, 860), [MAC])).toBe(true);
  });

  it('is false for anything that is not a rect', () => {
    expect(grabbable(null, [WIN])).toBe(false);
    expect(grabbable(r(0, 0, 1280, 860), null)).toBe(false);
    expect(grabbable(r(0, 0, 1280, 860), [null, r(0, 0, 0, 0)])).toBe(false);
  });
});

describe('placeWindow', () => {
  it('opens a first launch at the default size, centred, not maximized', () => {
    expect(placeWindow(null, [WIN], WIN)).toEqual({ ...r(320, 86, 1280, 860), maximized: false });
  });

  it('keeps the maximized flag and fits the bounds it un-maximizes to', () => {
    const saved = parseWindowState(file(r(-2400, 100, 1600, 1000), true));
    expect(placeWindow(saved, [WIN, WIN_LEFT], WIN)).toEqual({
      ...r(-2400, 100, 1600, 1000),
      maximized: true,
    });
    // Its display is gone: maximized on the primary instead.
    expect(placeWindow(saved, [WIN], WIN)).toEqual({ ...r(160, 16, 1600, 1000), maximized: true });
  });

  it('opens maximized from the default size when the window would have to fill the work area', () => {
    // A large window left on the 27", which has since been unplugged. Opened at exactly the
    // MacBook's work area, macOS would already count it as zoomed, and the green button would have
    // no smaller frame to go back to.
    const big = parseWindowState(file(r(1800, 200, 2000, 1200)));
    expect(placeWindow(big, [MAC], MAC)).toEqual({ ...r(80, 32, 1280, 860), maximized: true });
    expect(placeWindow({ ...big, maximized: true }, [MAC], MAC)).toEqual({ ...r(80, 32, 1280, 860), maximized: true });
    // The same window on a display that is still there, but at a larger scale.
    expect(placeWindow(parseWindowState(file(r(100, 100, 1800, 900))), [WIN_150], WIN_150)).toEqual({
      ...r(0, 0, 1280, 688),
      maximized: true,
    });
    // As wide as the display already, and shrunk to its height: the work area all the same.
    expect(placeWindow(parseWindowState(file(r(0, 0, 1280, 900))), [WIN_150], WIN_150)).toEqual({
      ...r(0, 0, 1280, 688),
      maximized: true,
    });
  });

  it('keeps a window that still has room on one axis, or that the user left filling the work area', () => {
    expect(placeWindow(parseWindowState(file(r(100, 50, 1200, 900))), [WIN_150], WIN_150)).toEqual({
      ...r(80, 0, 1200, 688),
      maximized: false,
    });
    expect(placeWindow(parseWindowState(file(MAC)), [MAC], MAC)).toEqual({ ...MAC, maximized: false });
    // Below the minimum on one axis, the window is pinned top-left as before, not maximized.
    const small = r(0, 0, 1024, 560);
    expect(placeWindow(parseWindowState(file(r(50, 50, 1280, 860))), [small], small)).toEqual({
      ...r(0, 0, 1024, 600),
      maximized: false,
    });
  });

  it('has only a size, which Electron centres, when there is no display', () => {
    const saved = parseWindowState(file(r(0, 0, 1000, 700), true));
    expect(placeWindow(saved, [], null)).toEqual({ width: 1280, height: 860, maximized: false });
  });

  it('treats anything but a parsed state as nothing saved', () => {
    for (const saved of [undefined, {}, { bounds: null, maximized: true }, { bounds: r(0, 0, 0, 0) }]) {
      expect(placeWindow(saved, [WIN], WIN)).toEqual({ ...r(320, 86, 1280, 860), maximized: false });
    }
  });
});

describe('windowStateToSave', () => {
  const now = (over: Record<string, unknown> = {}) => ({
    bounds: r(100, 100, 1200, 800),
    normalBounds: r(100, 100, 1200, 800),
    maximized: false,
    minimized: false,
    fullScreen: false,
    ...over,
  });
  const last = { bounds: r(40, 50, 1100, 700), maximized: false };

  it('saves a normal window as it is', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      expect(windowStateToSave(now(), last, platform)).toEqual({
        bounds: r(100, 100, 1200, 800),
        maximized: false,
      });
    }
  });

  it('saves nothing while full screen or minimized, so the state from before stands', () => {
    for (const platform of ['darwin', 'win32']) {
      expect(windowStateToSave(now({ fullScreen: true }), last, platform)).toBeNull();
      expect(windowStateToSave(now({ minimized: true }), last, platform)).toBeNull();
      // Windows reports a minimized maximized window as not maximized.
      expect(windowStateToSave(now({ minimized: true, maximized: false }), last, platform)).toBeNull();
    }
  });

  it('saves a maximized window with the bounds it un-maximizes to', () => {
    const maxed = now({ bounds: r(-8, -8, 1936, 1048), normalBounds: r(300, 200, 1000, 700), maximized: true });
    // Windows: the placement's restore rect.
    expect(windowStateToSave(maxed, last, 'win32')).toEqual({ bounds: r(300, 200, 1000, 700), maximized: true });
    // macOS: getNormalBounds can be stale after AppKit's own zoom, so the last normal bounds.
    expect(windowStateToSave(maxed, last, 'darwin')).toEqual({ bounds: r(40, 50, 1100, 700), maximized: true });
    expect(windowStateToSave(maxed, null, 'darwin')).toEqual({ bounds: r(300, 200, 1000, 700), maximized: true });
  });

  it('saves bounds the window was given as the bounds it asked for', () => {
    // At 125% the constructor's DIP-to-pixel trips hand back a slightly larger window.
    const opened = { asked: r(81, 62, 1281, 801), got: r(81, 62, 1283, 802) };
    const untouched = now({ bounds: opened.got, normalBounds: opened.got });
    expect(windowStateToSave(untouched, last, 'win32', opened)).toEqual({ bounds: opened.asked, maximized: false });
    // Maximized on Windows: the restore rect is the window it was given.
    const maxed = now({ bounds: r(-8, -8, 1936, 1048), normalBounds: opened.got, maximized: true });
    expect(windowStateToSave(maxed, last, 'win32', opened)).toEqual({ bounds: opened.asked, maximized: true });
    // A window the user moved saves what it reports.
    const moved = now({ bounds: r(82, 62, 1283, 802) });
    expect(windowStateToSave(moved, last, 'win32', opened)).toEqual({ bounds: r(82, 62, 1283, 802), maximized: false });
    // Junk in `opened` changes nothing.
    for (const junk of [null, {}, { asked: null, got: opened.got }, { asked: opened.asked, got: 'x' }]) {
      expect(windowStateToSave(untouched, last, 'win32', junk)).toEqual({ bounds: opened.got, maximized: false });
    }
  });

  it('keeps an untouched window the same size from launch to launch', () => {
    // A stand-in for Chromium's round trips at 125%: each construction comes out a little larger.
    const construct = (b: Rect) => r(b.x, b.y, b.width + 2, b.height + 1);
    for (const maximized of [false, true]) {
      const start = serializeWindowState({ bounds: r(81, 62, 1281, 801), maximized });
      let text = start;
      let unmapped = start;
      for (let launch = 0; launch < 5; launch++) {
        for (const [mapped, current] of [
          [true, text],
          [false, unmapped],
        ] as [boolean, string][]) {
          const placed = placeWindow(parseWindowState(current), [WIN], WIN);
          const asked = bounds(placed);
          const got = construct(asked);
          const seen = now({ bounds: maximized ? r(-8, -8, 1936, 1048) : got, normalBounds: got, maximized });
          const next = windowStateToSave(seen, { bounds: asked, maximized }, 'win32', mapped ? { asked, got } : null);
          if (mapped) text = serializeWindowState(next);
          else unmapped = serializeWindowState(next);
        }
      }
      expect(text).toBe(start);
      // Without the mapping the same five launches grow it by 10x5.
      expect(parseWindowState(unmapped)?.bounds).toEqual(r(81, 62, 1291, 806));
    }
  });

  it('saves nothing it could not read back', () => {
    expect(windowStateToSave(null, last, 'win32')).toBeNull();
    expect(windowStateToSave(now({ bounds: r(0, 0, 0, 0) }), last, 'win32')).toBeNull();
    expect(windowStateToSave(now({ maximized: true, normalBounds: undefined }), last, 'win32')).toBeNull();
    const saved = windowStateToSave(now({ bounds: { ...r(1, 2, 1000, 700), extra: true } }), null, 'win32');
    expect(parseWindowState(serializeWindowState(saved))).toEqual(saved);
  });
});
