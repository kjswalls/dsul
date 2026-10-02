import { describe, expect, it } from 'vitest';
import chrome from '../../electron/lib/window-chrome.cjs';
import { fnSource, handlerSource, read } from './helpers/electron-main';

// The desktop window's top edge (electron/lib/window-chrome.cjs) and the page's top band
// (app/globals.css, components/sidebar/sidebar.tsx) are two halves of one geometry that ship
// on different schedules. These hold the numbers on each side to each other.
const {
  TITLE_BAND_PX,
  MAC_LIGHTS,
  ROW_MIDLINE_PX,
  LIGHTS_Y_MAX,
  LIGHTS_Y_ZOOM_MIN,
  LIGHTS_ZOOM_MAX,
  ZOOM_STEP,
  windowChrome,
  macLights,
  nextZoomLevel,
} = chrome;

/** desktop-shell.tsx's p-3, and the sidebar column's wordmark row (pt-[31px] / h-[31px]). */
const SHELL_PAD = 12;
const WORDMARK_ROW = 31;

/** Zoom factors from `from` to `to` in steps of `step`, without float drift. */
function zooms(from: number, to: number, step = 0.01) {
  const out: number[] = [];
  for (let i = Math.round(from / step); i * step <= to + 1e-9; i++) out.push(+(i * step).toFixed(6));
  return out;
}
/**
 * macOS's three buttons and their two gaps, for a 14pt and a 16pt button: the 0.1.1 checklist
 * expects env(titlebar-area-x) of about 128-136 at 100%, which is 2 * 37 plus this.
 */
const GROUPS = [
  { h: 14, w: 54 },
  { h: 16, w: 62 },
];
/** Blink's env(titlebar-area-x): the overlay's x in points over the page zoom, floored (local_frame.cc). */
const envX = (points: number, z: number) => Math.floor(points / z);

describe('electron/lib/window-chrome.cjs', () => {
  it('stays pure: no requires and no imports, so this suite can load it without Electron', () => {
    const source = read('electron/lib/window-chrome.cjs');
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/^\s*import\b/m);
  });

  it('hides the title bar on macOS and nowhere else', () => {
    expect(windowChrome('darwin')).toEqual({
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 37, y: 20 },
      titleBarOverlay: { height: 43 },
    });
    // Off the Mac a framed window ignores drag regions and defines no env(titlebar-area-*),
    // which is what keeps the page's titlebar CSS inert there. 'hiddenInset' would be
    // silently ignored on Windows, so nothing here may rely on it.
    for (const platform of ['win32', 'linux', 'freebsd']) expect(windowChrome(platform)).toEqual({});
  });

  it('is spread into the BrowserWindow options', () => {
    expect(read('electron/main.cjs')).toContain('...windowChrome(process.platform),');
  });

  it('makes the band the shell padding plus the wordmark row', () => {
    expect(TITLE_BAND_PX).toBe(SHELL_PAD + WORDMARK_ROW);
    // The plate layouts (Classic) pad the shell; the flat ones put the status line in the band.
    expect(read('components/shell/desktop-shell.tsx')).toMatch(/plate\s*\?\s*'gap-3 bg-surface-0 p-3'/);
    const sidebar = read('components/sidebar/sidebar.tsx');
    expect(sidebar).toContain(`pt-[${WORDMARK_ROW}px]`);
    expect(sidebar).toContain(`h-[${WORDMARK_ROW}px]`);
  });

  it('centres a 14-16pt button on the band and keeps it inside the band', () => {
    const mid = SHELL_PAD + WORDMARK_ROW / 2;
    for (const h of [14, 16]) {
      expect(Math.abs(MAC_LIGHTS.y + h / 2 - mid)).toBeLessThanOrEqual(1);
      expect(MAC_LIGHTS.y + h).toBeLessThanOrEqual(TITLE_BAND_PX);
    }
  });

  it("keeps the buttons inside the collapsed canvas card's rounded corner, clear of the expand zone", () => {
    // Collapsed: the card starts at x 24, y 12 with a 30px radius and a 1px border
    // (desktop-shell.tsx), and the expand zone runs x 0..32 (sidebar.tsx).
    const corner = { x: 24 + 30, y: 12 + 30 };
    expect(Math.hypot(corner.x - MAC_LIGHTS.x, corner.y - MAC_LIGHTS.y)).toBeLessThanOrEqual(30 - 1);
    expect(MAC_LIGHTS.x).toBeGreaterThan(32);
  });

  it("matches the page's numbers", () => {
    expect(read('app/globals.css')).toContain(`height: min(${TITLE_BAND_PX}px, env(titlebar-area-height, 0px));`);
    // The word starts 14px past the green button: env(titlebar-area-x) is the buttons' right
    // edge plus MAC_LIGHTS.x again, and the sidebar column starts at the shell padding.
    const inset = MAC_LIGHTS.x - 14 + SHELL_PAD;
    expect(read('components/sidebar/sidebar.tsx')).toContain(
      `pl-[max(25px,calc(env(titlebar-area-x,0px)_-_${inset}px))]`
    );
    // A flat layout's status line is the window's top row (Console): it fills the band, puts
    // its text on the lights' midline and starts 14px past them from x 0, its button a hole.
    const line = read('components/shell/status-line.tsx');
    expect(line).toContain(`h-[max(2rem,min(${TITLE_BAND_PX}px,env(titlebar-area-height,0px)))]`);
    expect(line).toContain(`pl-[max(1rem,calc(env(titlebar-area-x,0px)_-_${MAC_LIGHTS.x - 14}px))]`);
    expect(line).toContain('className="titlebar-hole rounded-[3px]');
    // Notepad's day tabs are the window's top row instead: at least as tall as the band,
    // starting 14px past the lights, and every control in the strip a hole.
    const tabs = read('components/shell/day-tabs.tsx');
    expect(tabs).toContain(`pl-[max(0.75rem,calc(env(titlebar-area-x,0px)_-_${MAC_LIGHTS.x - 14}px))]`);
    expect(44).toBeGreaterThanOrEqual(TITLE_BAND_PX);
    expect(tabs).toContain("'flex h-11 flex-shrink-0");
    expect(tabs).toMatch(/const TAB =\s*'titlebar-hole /);
    const buttons = tabs.split('<button').slice(1).map((b) => b.split('</button>')[0]);
    expect(buttons.length).toBeGreaterThanOrEqual(4);
    for (const button of buttons) expect(button).toMatch(/className=\{cn\(TAB,|titlebar-hole/);
  });

  it('lets the offline page be dragged, except by its link', () => {
    const html = read('electron/offline.html');
    expect(html).toContain('body { -webkit-app-region: drag; app-region: drag; }');
    expect(html).toContain('a { -webkit-app-region: no-drag; app-region: no-drag; }');
  });
});

// Page zoom scales the page's band but not the native buttons, so main moves them
// (electron/main.cjs placeLights). The page sees env(titlebar-area-*) as points over the zoom.
describe('macLights: the traffic lights follow page zoom', () => {
  it('opens them where they sit at 100%', () => {
    expect(macLights(1)).toEqual(MAC_LIGHTS);
    expect(macLights(1)).toEqual(windowChrome('darwin').trafficLightPosition);
    expect(ROW_MIDLINE_PX).toBe(SHELL_PAD + WORDMARK_ROW / 2);
  });

  it('pins the positions at the zooms people use', () => {
    expect(macLights(0.67)).toEqual({ x: 25, y: 11 });
    expect(macLights(0.8)).toEqual({ x: 30, y: 15 });
    expect(macLights(0.9)).toEqual({ x: 33, y: 17 });
    expect(macLights(1.1)).toEqual({ x: 41, y: 23 });
    expect(macLights(1.25)).toEqual({ x: 46, y: 27 });
    expect(macLights(1.5)).toEqual({ x: 56, y: 27 });
    expect(macLights(2)).toEqual({ x: 74, y: 27 });
    // The View menu's own steps, 1.2 ** (level / 2).
    expect(macLights(1.2 ** 0.5)).toEqual({ x: 41, y: 23 });
    expect(macLights(1.2)).toEqual({ x: 44, y: 26 });
    expect(macLights(1.2 ** -1)).toEqual({ x: 31, y: 15 });
  });

  it('holds y below 67% while x keeps following, and holds still on a zoom it cannot read', () => {
    for (const z of zooms(0.25, LIGHTS_Y_ZOOM_MIN)) expect(macLights(z).y).toBe(macLights(LIGHTS_Y_ZOOM_MIN).y);
    expect(macLights(0.5)).toEqual({ x: 19, y: 11 });
    // Chromium's floor.
    expect(macLights(0.25)).toEqual({ x: 9, y: 11 });
    expect(macLights(6)).toEqual(macLights(LIGHTS_ZOOM_MAX));
    for (const z of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY, undefined]) {
      expect(macLights(z as number)).toEqual(MAC_LIGHTS);
    }
  });

  it("centres a 14-16pt button on the zoomed row until the overlay's floor stops it", () => {
    for (const z of zooms(LIGHTS_Y_ZOOM_MIN, 1.27)) {
      const { y } = macLights(z);
      for (const { h } of GROUPS) expect(Math.abs(y + h / 2 - ROW_MIDLINE_PX * z)).toBeLessThanOrEqual(1);
    }
  });

  it('keeps every button inside the 43pt overlay, which cannot grow once the window exists', () => {
    expect(LIGHTS_Y_MAX).toBe(TITLE_BAND_PX - 16);
    for (const z of zooms(0.25, LIGHTS_ZOOM_MAX, 0.05)) {
      const { y } = macLights(z);
      expect(y).toBeGreaterThan(0);
      expect(y + 16).toBeLessThanOrEqual(TITLE_BAND_PX);
    }
  });

  it("keeps the buttons inside the band when zoomed out, where globals.css's min() holds it to 43 CSS px", () => {
    for (const z of zooms(LIGHTS_Y_ZOOM_MIN, 1)) {
      expect(macLights(z).y + 16).toBeLessThanOrEqual(TITLE_BAND_PX * z);
    }
  });

  it('starts the word and the status line about 14 CSS px past the green button at every zoom', () => {
    // sidebar.tsx: 12 + env(titlebar-area-x) - 35. status-line.tsx: env(titlebar-area-x) - 23
    // from x 0. The overlay's x is the buttons' right edge plus the inset again (2x + group).
    // Rounding x to a whole point costs up to 0.5 / z CSS px, which is most below 67%.
    const gap = (z: number, w: number) => {
      const { x } = macLights(z);
      const green = (x + w) / z;
      const word = SHELL_PAD + envX(2 * x + w, z) - (MAC_LIGHTS.x - 14 + SHELL_PAD);
      const status = envX(2 * x + w, z) - (MAC_LIGHTS.x - 14);
      return [word - green, status - green];
    };
    for (const z of zooms(LIGHTS_Y_ZOOM_MIN, LIGHTS_ZOOM_MAX)) {
      for (const { w } of GROUPS) {
        for (const d of gap(z, w)) {
          expect(d).toBeGreaterThanOrEqual(12);
          expect(d).toBeLessThanOrEqual(15);
        }
      }
    }
    for (const z of zooms(0.25, LIGHTS_Y_ZOOM_MIN)) {
      for (const { w } of GROUPS) {
        for (const d of gap(z, w)) {
          expect(d).toBeGreaterThanOrEqual(11);
          expect(d).toBeLessThanOrEqual(16);
        }
      }
    }
  });

  it('keeps the buttons right of the expand zone, and inside the collapsed card corner near 100%', () => {
    for (const z of zooms(0.25, LIGHTS_ZOOM_MAX, 0.05)) expect(macLights(z).x / z).toBeGreaterThan(32);
    // The corner test above, in CSS px. Zoomed out past 90% the close button reaches the card's
    // 1px border, and past about 145% the buttons stop at the overlay's floor and cross the
    // card's top edge; both are cosmetic and on the Mac checklist.
    for (const z of zooms(0.9, 1.45)) {
      const { x, y } = macLights(z);
      expect(Math.hypot(24 + 30 - x / z, 12 + 30 - y / z)).toBeLessThanOrEqual(30 - 1);
    }
  });

  it('steps the zoom the way the zoom roles did', () => {
    expect(ZOOM_STEP).toBe(0.5);
    expect(nextZoomLevel(0, 'in')).toBe(0.5);
    expect(nextZoomLevel(0.5, 'out')).toBe(0);
    expect(nextZoomLevel(-2.5, 'reset')).toBe(0);
    expect(nextZoomLevel(1, 'sideways')).toBe(1);
  });
});

// CI can't run Electron, so these hold main.cjs's few load-bearing lines in place.
describe('main.cjs: zoom goes through main, and the lights are placed wherever it can change', () => {
  const main = read('electron/main.cjs');

  it('zooms with click items, never the zoom roles, on the same keys', () => {
    // A zoom role changes the zoom without main hearing of it.
    expect(main).not.toMatch(/role: '(zoomIn|zoomOut|resetZoom)'/i);
    for (const key of ['0', 'Plus', '=', '-']) expect(main).toContain(`accelerator: 'CommandOrControl+${key}'`);
    expect(main.match(/click: zoom\('(in|out|reset)'\)/g)).toEqual([
      "click: zoom('reset')",
      "click: zoom('in')",
      "click: zoom('in')",
      "click: zoom('out')",
    ]);
    expect(main).toContain('const zoom = (action) => (_item, focusedWindow) => zoomPage(focusedWindow, action);');
  });

  it("zooms only the window's own page, and only while that window has focus", () => {
    // Whatever has focus can be a view inside the window (the find bar), whose zoom Chromium
    // would save under that view's own URL.
    expect(main).not.toContain('getFocusedWebContents');
    const zoomPage = fnSource(main, 'zoomPage');
    expect(zoomPage).toMatch(/^function zoomPage\(focusedWindow, action\) \{\n {2}if \(!win \|\| win\.isDestroyed\(\) \|\| focusedWindow !== win\) return;/);
    expect(zoomPage).toContain('const contents = win.webContents;');
  });

  it('never touches the macOS-only button calls off the Mac', () => {
    // setWindowButtonPosition is not bound on Windows or Linux, so a call there throws inside a
    // main-process listener on every navigation.
    expect(fnSource(main, 'placeLights')).toMatch(/^function placeLights\([^)]*\) \{\n {2}if \(!IS_MAC/);
    expect(main.match(/WindowButtonPosition\(/g)).toHaveLength(2);
  });

  it('places the lights last on each navigation, after each View zoom, and again on leaving full screen', () => {
    const navigate = handlerSource(main, "contents.on('did-navigate',");
    expect(navigate.trimEnd()).toMatch(/\n {4}placeLights\(\);\n {2}\}\);$/);
    expect(navigate.match(/placeLights\(/g)).toHaveLength(1);
    expect(fnSource(main, 'zoomPage')).toMatch(
      /\n {2}contents\.zoomLevel = nextZoomLevel\(contents\.zoomLevel, action\);\n {2}placeLights\(\);\n\}/,
    );
    expect(main).toContain("win.on('leave-full-screen', () => placeLights(true));");
    expect(fnSource(main, 'placeLights')).toContain('if (!leavingFullScreen && win.isFullScreen()) return;');
  });
});
