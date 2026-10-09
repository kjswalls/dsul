'use client';

import { useCallback, useSyncExternalStore } from 'react';
import type { TimeBucket } from '@/lib/planner-types';

/** One minute clock for every caller, started by the first and stopped with the last. */
const ticks = new Set<() => void>();
let clock: ReturnType<typeof setInterval> | null = null;

function subscribe(tick: () => void) {
  ticks.add(tick);
  if (clock === null) {
    clock = setInterval(() => {
      for (const notify of ticks) notify();
    }, 60_000);
  }
  return () => {
    ticks.delete(tick);
    if (ticks.size > 0 || clock === null) return;
    clearInterval(clock);
    clock = null;
  };
}

function bucketNow(dayKey: string | undefined): TimeBucket | null {
  const now = new Date();
  if (dayKey !== undefined && now.toDateString() !== dayKey) return null;
  const hour = now.getHours();
  return hour >= 5 && hour < 12 ? 'morning' : hour >= 12 && hour < 17 ? 'afternoon' : 'evening';
}

const getServerSnapshot = () => null;

/**
 * The time-of-day bucket you are currently in, minute-refreshed.
 *
 * Pass a date to scope it — the result is null unless that date is today. Pass
 * nothing to mean "whatever bucket it is right now, regardless of what is on
 * screen"; week does that and gates per column with isToday, because seven
 * columns must not mount seven clocks.
 *
 * Lifted out of day-buckets.tsx so week can use it too. Call it ONCE per view
 * and thread the result down — a week column renders four bucket cells across
 * seven days, and calling this per cell would mount 28 subscriptions for one
 * clock.
 *
 * The server snapshot is null, and that is the hydration guard: the answer
 * depends on the client's wall clock, so a server pass that rendered a real
 * bucket would hydrate a mismatch. Callers do NOT need their own `mounted`
 * flag on top of this. A render on the client gets the real bucket at once.
 * It used to be a useState that started null and an effect that measured,
 * which rendered every view a second time right after it mounted: every row
 * of the look-only preview twice, for one halo.
 */
export function useCurrentBucket(date?: Date): TimeBucket | null {
  // Key off the calendar day, never the Date identity. `useCurrentBucket(new
  // Date())` in a render body produces a fresh object every pass.
  const dayKey = date?.toDateString();
  const getSnapshot = useCallback(() => bucketNow(dayKey), [dayKey]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
