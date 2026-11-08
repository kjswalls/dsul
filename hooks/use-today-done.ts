'use client';

import { useMemo } from 'react';

import { useToday } from '@/lib/collections';
import { dayDoneCount } from '@/lib/day-done';
import { usePlannerStore } from '@/lib/planner-store';
import { useAwayStore } from '@/lib/away-store';
import { selectPlannerSettled } from '@/lib/planner-ready';

/**
 * How many things today was, once it is cleared (lib/day-done.ts), else null.
 * The tab icon turns Lime on it and the header shows the "perfect" chip.
 *
 * Null until the planner has settled: a failed load counts as settled
 * (lib/planner-ready.ts), but its store is not the account's items, so it is
 * not read as today's. `today` is recomputed every render (useToday), so a
 * caller that must notice midnight on its own re-renders itself (favicon-sync
 * ticks once a minute).
 */
export function useTodayDone(): number | null {
  const items = usePlannerStore((s) => s.items);
  const routines = usePlannerStore((s) => s.routines);
  const seasons = usePlannerStore((s) => s.seasons);
  const away = useAwayStore((s) => s.periods);
  const loaded = usePlannerStore((s) => selectPlannerSettled(s) && s.loadFailedUserId !== s.userId);
  const { todayStr, tz } = useToday();

  return useMemo(
    () => (loaded ? dayDoneCount(items, todayStr, { userTimezone: tz, routines, seasons, away }) : null),
    [loaded, items, todayStr, tz, routines, seasons, away]
  );
}
