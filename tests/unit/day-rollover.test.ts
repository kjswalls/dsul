import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * A planner left open across midnight (hooks/use-day-rollover.ts): the view
 * follows to the new day only if it was on today, the day store moves (which
 * re-runs the once-a-day jobs), and it catches up with the server.
 */

const TZ = 'America/New_York';

const hoisted = vi.hoisted(() => ({
  catchUp: vi.fn(async () => [] as string[]),
  state: {
    userId: 'user-1' as string | null,
    isLoading: false,
    userTimezone: 'America/New_York',
    selectedDate: new Date(),
    setSelectedDate: vi.fn(),
  },
}));

vi.mock('@/lib/planner-store', () => {
  const usePlannerStore = <T,>(sel: (s: typeof hoisted.state) => T) => sel(hoisted.state);
  usePlannerStore.getState = () => hoisted.state;
  return { catchUpPlanner: hoisted.catchUp, usePlannerStore };
});
vi.mock('@/hooks/use-planner-catch-up', () => ({ heldItemIds: () => new Set() }));

import { useDayRollover } from '@/hooks/use-day-rollover';
import { DAY_CHECK_MS, useDayStore } from '@/lib/day-clock';

// 23:59:40 on 24 Oct in New York.
const BEFORE = new Date('2026-10-25T03:59:40Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BEFORE);
  vi.clearAllMocks();
  useDayStore.setState({ todayStr: null });
  hoisted.state.selectedDate = new Date(BEFORE);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useDayRollover', () => {
  it('moves a view that was on today to the new day, and catches up', () => {
    renderHook(() => useDayRollover());
    expect(useDayStore.getState().todayStr).toBe('2026-10-24');

    act(() => {
      vi.advanceTimersByTime(DAY_CHECK_MS);
    });
    expect(useDayStore.getState().todayStr).toBe('2026-10-25');
    expect(hoisted.state.setSelectedDate).toHaveBeenCalledTimes(1);
    expect(hoisted.catchUp).toHaveBeenCalledTimes(1);
  });

  it('leaves a view on another day where it is', () => {
    hoisted.state.selectedDate = new Date('2026-10-28T16:00:00Z');
    renderHook(() => useDayRollover());
    act(() => {
      vi.advanceTimersByTime(DAY_CHECK_MS);
    });
    expect(useDayStore.getState().todayStr).toBe('2026-10-25');
    expect(hoisted.state.setSelectedDate).not.toHaveBeenCalled();
    expect(hoisted.catchUp).toHaveBeenCalledTimes(1);
  });

  it('does nothing while the day has not moved', () => {
    vi.setSystemTime(new Date('2026-10-24T16:00:00Z'));
    hoisted.state.selectedDate = new Date('2026-10-24T16:00:00Z');
    renderHook(() => useDayRollover());
    act(() => {
      vi.advanceTimersByTime(DAY_CHECK_MS * 3);
    });
    expect(hoisted.state.setSelectedDate).not.toHaveBeenCalled();
    expect(hoisted.catchUp).not.toHaveBeenCalled();
  });

  it('rolls over on return to a page whose timers slept through midnight', () => {
    renderHook(() => useDayRollover());
    // The laptop slept: the clock jumps, no interval fired.
    vi.setSystemTime(new Date('2026-10-25T13:00:00Z'));
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(useDayStore.getState().todayStr).toBe('2026-10-25');
    expect(hoisted.state.setSelectedDate).toHaveBeenCalledTimes(1);
  });

  it('reads the day in the user’s timezone, not the browser’s', () => {
    // 00:30 UTC on the 25th is still the 24th in New York.
    vi.setSystemTime(new Date('2026-10-25T00:30:00Z'));
    renderHook(() => useDayRollover());
    expect(useDayStore.getState().todayStr).toBe('2026-10-24');
    expect(TZ).toBe(hoisted.state.userTimezone);
  });
});
