import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

/**
 * The day done aurora (components/celebrate/day-done-aurora.tsx): it shows on
 * the tick that clears today, once a day, and a key closes it. jsdom has no
 * canvas, so this checks the moment and its words, not the drawing.
 */

const readTodayDone = vi.fn();
vi.mock('@/lib/day-done-moment', async (orig) => ({
  ...(await orig<typeof import('@/lib/day-done-moment')>()),
  readTodayDone: () => readTodayDone(),
}));

import { DayDoneAurora } from '@/components/celebrate/day-done-aurora';
import { raiseModEvent, __resetModEventsForTests } from '@/lib/mod-events';
import { useViewStore } from '@/lib/view-store';

const TODAY = '2026-11-08';
const tick = (date = TODAY) =>
  act(() => {
    raiseModEvent({ kind: 'item.completed', itemId: 'i', date } as never);
    vi.advanceTimersByTime(400);
  });

describe('DayDoneAurora', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
    useViewStore.setState({ celebrateDayDone: true });
    readTodayDone.mockReturnValue({ today: TODAY, count: 5 });
    render(<DayDoneAurora />);
  });
  afterEach(() => {
    cleanup();
    __resetModEventsForTests();
    vi.useRealTimers();
  });

  it('shows the count on the tick that clears today', () => {
    tick();
    expect(screen.getByText('5 of 5 done')).toBeTruthy();
  });

  it('says nothing while today is still open', () => {
    readTodayDone.mockReturnValue({ today: TODAY, count: null });
    tick();
    expect(screen.queryByText(/of .* done/)).toBeNull();
  });

  it('plays once a day', () => {
    tick();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(document.querySelector('[data-day-done]')).toBeNull();
    tick();
    expect(document.querySelector('[data-day-done]')).toBeNull();
  });

  it('closes by itself', () => {
    tick();
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(document.querySelector('[data-day-done]')).toBeNull();
  });

  it('stays off when the setting is off', () => {
    act(() => useViewStore.setState({ celebrateDayDone: false }));
    tick();
    expect(document.querySelector('[data-day-done]')).toBeNull();
  });
});
