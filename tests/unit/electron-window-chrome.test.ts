import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import chrome from '../../electron/lib/window-chrome.cjs';

// The desktop window's top edge (electron/lib/window-chrome.cjs) and the page's top band
// (app/globals.css, components/sidebar/sidebar.tsx) are two halves of one geometry that ship
// on different schedules. These hold the numbers on each side to each other.
const { TITLE_BAND_PX, MAC_LIGHTS, windowChrome } = chrome;
const read = (p: string) => readFileSync(path.resolve(__dirname, '../..', p), 'utf8');

/** desktop-shell.tsx's p-3, and the sidebar column's wordmark row (pt-[31px] / h-[31px]). */
const SHELL_PAD = 12;
const WORDMARK_ROW = 31;

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
