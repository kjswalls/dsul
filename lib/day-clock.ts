import { create } from 'zustand';
import { toDateStr } from './recurrence';

/**
 * Today, as the user's own calendar day (YYYY-MM-DD in their timezone), for a
 * page that stays open across midnight. Null until the planner's day clock
 * (hooks/use-day-rollover.ts) has read it once.
 *
 * The once-a-day jobs that run on load (the overdue sweep, completion filing,
 * the vacation settle) take it as an effect dependency, so a new day re-runs
 * them the way a reload would, with their own once-per-day guards intact.
 */
export const useDayStore = create<{ todayStr: string | null }>(() => ({ todayStr: null }));

/** How often an open page re-reads the date. Timers stall in a sleeping laptop, so focus re-reads it too. */
export const DAY_CHECK_MS = 30_000;

export function todayIn(timezone: string | null | undefined, now: Date = new Date()): string {
  return toDateStr(now, timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
}

/**
 * Re-read the date. Returns the day it moved from when it has moved since the
 * last read (the first read moves nothing), or null.
 */
export function readDay(timezone: string | null | undefined, now: Date = new Date()): string | null {
  const next = todayIn(timezone, now);
  const prev = useDayStore.getState().todayStr;
  if (prev === next) return null;
  useDayStore.setState({ todayStr: next });
  return prev;
}
