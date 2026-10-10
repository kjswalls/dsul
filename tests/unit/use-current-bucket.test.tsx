import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

import { useCurrentBucket } from '@/hooks/use-current-bucket';

/**
 * hooks/use-current-bucket.ts. The server pass answers null (the hydration
 * guard); a client render answers at once. It used to answer null on every
 * first render and fix it in an effect, which rendered the whole view, every
 * row of the look-only preview included, a second time for one halo.
 */

const at = (hhmm: string) => new Date(`2026-10-09T${hhmm}:00`);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at('09:30'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useCurrentBucket', () => {
  it('answers on the FIRST client render, with no null render before it', () => {
    const seen: unknown[] = [];
    function Probe() {
      seen.push(useCurrentBucket(new Date()));
      return null;
    }
    const { unmount } = render(createElement(Probe));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((v) => v === 'morning')).toBe(true);
    unmount();
  });

  it('answers null on the server, so hydration cannot mismatch', () => {
    let seen: unknown = 'unset';
    function Probe() {
      seen = useCurrentBucket();
      return null;
    }
    renderToString(createElement(Probe));
    expect(seen).toBeNull();
  });

  it.each([
    ['04:59', 'evening'],
    ['05:00', 'morning'],
    ['11:59', 'morning'],
    ['12:00', 'afternoon'],
    ['16:59', 'afternoon'],
    ['17:00', 'evening'],
  ])('at %s is %s', (hhmm, bucket) => {
    vi.setSystemTime(at(hhmm));
    const { result, unmount } = renderHook(() => useCurrentBucket());
    expect(result.current).toBe(bucket);
    unmount();
  });

  it('is null for a day that is not today, and unscoped means right now', () => {
    const other = renderHook(() => useCurrentBucket(new Date('2026-10-10T12:00:00')));
    const unscoped = renderHook(() => useCurrentBucket());
    expect(other.result.current).toBeNull();
    expect(unscoped.result.current).toBe('morning');
    other.unmount();
    unscoped.unmount();
  });

  it('moves on with the minute clock, one clock for every caller', () => {
    const a = renderHook(() => useCurrentBucket());
    const b = renderHook(() => useCurrentBucket(new Date()));
    expect(vi.getTimerCount()).toBe(1);

    // The fake clock moves with the timers: this tick lands at 11:59, the next at noon.
    vi.setSystemTime(at('11:58'));
    act(() => void vi.advanceTimersByTime(60_000));
    expect([a.result.current, b.result.current]).toEqual(['morning', 'morning']);
    act(() => void vi.advanceTimersByTime(60_000));
    expect([a.result.current, b.result.current]).toEqual(['afternoon', 'afternoon']);

    a.unmount();
    expect(vi.getTimerCount()).toBe(1);
    b.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a day scoped by a fresh Date every render keeps one subscription', () => {
    const { result, rerender, unmount } = renderHook(() => useCurrentBucket(new Date()));
    rerender();
    rerender();
    expect(result.current).toBe('morning');
    expect(vi.getTimerCount()).toBe(1);
    unmount();
  });
});
