import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import { createElement } from 'react';

import { useIsMobile } from '@/hooks/use-mobile';

/**
 * hooks/use-mobile.ts. A client render must get the real answer at once: the
 * old useState(false) + effect answered "desktop" first, so on a phone every
 * row of the look-only preview mounted as a desktop row and remounted a commit
 * later. The answer itself is unchanged, `innerWidth < 768`, re-read when the
 * `(max-width: 767px)` query changes.
 */

const realMatchMedia = window.matchMedia;
const realWidth = window.innerWidth;

/** A matchMedia whose listeners this test can fire, as a browser does when the query flips. */
let listeners: Set<() => void>;
let opened: number;
const setWidth = (px: number) =>
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: px });
const resize = (px: number) => {
  setWidth(px);
  act(() => {
    for (const fire of [...listeners]) fire();
  });
};

beforeEach(() => {
  listeners = new Set();
  opened = 0;
  window.matchMedia = vi.fn((query: string) => {
    opened += 1;
    return {
      matches: false,
      media: query,
      onchange: null,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  });
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  setWidth(realWidth);
});

describe('useIsMobile', () => {
  it('answers a phone on its FIRST client render, with no desktop render before it', () => {
    setWidth(390);
    const seen: boolean[] = [];
    function Probe() {
      seen.push(useIsMobile());
      return null;
    }
    const { unmount } = render(createElement(Probe));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((v) => v === true)).toBe(true);
    unmount();
  });

  it.each([
    [767, true],
    [768, false],
    [1024, false],
  ])('at %ipx answers %s', (px, mobile) => {
    setWidth(px);
    const { result, unmount } = renderHook(() => useIsMobile());
    expect(result.current).toBe(mobile);
    unmount();
  });

  it('follows the query across the breakpoint, every caller at once', () => {
    setWidth(1024);
    const a = renderHook(() => useIsMobile());
    const b = renderHook(() => useIsMobile());
    expect([a.result.current, b.result.current]).toEqual([false, false]);
    // One listener for every caller.
    expect(opened).toBe(1);
    expect(listeners.size).toBe(1);

    resize(500);
    expect([a.result.current, b.result.current]).toEqual([true, true]);
    resize(900);
    expect([a.result.current, b.result.current]).toEqual([false, false]);
    a.unmount();
    b.unmount();
  });

  it('lets go when the last caller unmounts, and the next first caller measures afresh', () => {
    setWidth(1024);
    const a = renderHook(() => useIsMobile());
    const b = renderHook(() => useIsMobile());
    a.unmount();
    expect(listeners.size).toBe(1);
    b.unmount();
    expect(listeners.size).toBe(0);

    // A width change nobody was listening for.
    setWidth(390);
    const c = renderHook(() => useIsMobile());
    expect(c.result.current).toBe(true);
    c.unmount();
  });
});
