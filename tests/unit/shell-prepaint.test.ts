// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  BOOT_SIDEBAR_VAR,
  PREPAINT_SIDEBAR,
  SIDEBAR_PREPAINT,
  SIDEBAR_SETTINGS_KEY,
} from '@/lib/shell-prepaint';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_CANVAS,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  renderedSidebarWidth,
  useSidebarStore,
} from '@/lib/sidebar-store';

/**
 * lib/shell-prepaint.ts sizes the server shell's braindump silhouette before
 * paint, so it must land where the real column will: renderedSidebarWidth of
 * the width the store rehydrates to, with no rail reserve, or 0 when closed.
 * It cannot import the store, so its numbers are held equal here.
 */

const run = (innerWidth: number) => {
  Object.defineProperty(window, 'innerWidth', { value: innerWidth, configurable: true });
  document.documentElement.style.removeProperty(BOOT_SIDEBAR_VAR);
  new Function(SIDEBAR_PREPAINT)();
  return document.documentElement.style.getPropertyValue(BOOT_SIDEBAR_VAR);
};

const store = (state: Record<string, unknown>) =>
  localStorage.setItem(SIDEBAR_SETTINGS_KEY, JSON.stringify({ state, version: 3 }));

afterEach(() => {
  localStorage.clear();
  document.documentElement.style.removeProperty(BOOT_SIDEBAR_VAR);
});

describe('the braindump pre-paint', () => {
  it('mirrors the store: its key and its bounds', () => {
    expect(useSidebarStore.persist.getOptions().name).toBe(SIDEBAR_SETTINGS_KEY);
    expect(PREPAINT_SIDEBAR).toEqual({
      min: SIDEBAR_MIN_WIDTH,
      max: SIDEBAR_MAX_WIDTH,
      fallback: SIDEBAR_DEFAULT_WIDTH,
      minCanvas: SIDEBAR_MIN_CANVAS,
    });
  });

  it('lands where the column renders, for any stored width and window', () => {
    const widths: unknown[] = [undefined, null, 'wide', 0, 100, 280, 406, 480, 719.6, 720, 900];
    for (const vw of [800, 1000, 1181, 1280, 1600, 2400]) {
      for (const w of widths) {
        store({ leftSidebarOpen: true, leftSidebarWidth: w });
        // What merge() rehydrates, then what sidebar.tsx publishes with nothing docked.
        const expected = renderedSidebarWidth(clampSidebarWidth(w as number), vw, 0);
        expect(run(vw), `stored ${String(w)} at ${vw}`).toBe(`${expected}px`);
      }
    }
  });

  it('is 0 for a closed braindump, so the canvas starts at the window edge', () => {
    store({ leftSidebarOpen: false, leftSidebarWidth: 480 });
    expect(run(1600)).toBe('0px');
  });

  it('takes the default for a browser with no record, or one it cannot read', () => {
    expect(run(1600)).toBe(`${SIDEBAR_DEFAULT_WIDTH}px`);
    expect(run(900)).toBe(`${renderedSidebarWidth(SIDEBAR_DEFAULT_WIDTH, 900)}px`);
    localStorage.setItem(SIDEBAR_SETTINGS_KEY, '{not json');
    expect(run(1600)).toBe('');
    localStorage.setItem(SIDEBAR_SETTINGS_KEY, '"a string"');
    expect(run(1600)).toBe(`${SIDEBAR_DEFAULT_WIDTH}px`);
  });
});
