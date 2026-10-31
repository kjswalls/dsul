'use client';

import { useMemo } from 'react';
import { usePlannerStore } from '@/lib/planner-store';
import { useAwayStore } from '@/lib/away-store';
import { inactiveItemIdsOn } from '@/lib/active';
import { toDateStr } from '@/lib/recurrence';

/**
 * The inputs every "left from earlier" surface hands `selectOverdue`
 * (lib/overdue.ts): the store's items, today in the user's SAVED timezone, and
 * the ids set aside today (lib/active.ts `inactiveItemIdsOn`, resolved at TODAY,
 * plan decision 3, never at the navigable selectedDate).
 *
 * The inputs the ghost rows on Today (components/planner/ghost-fold.tsx) read.
 * It used to live inline in the waiting notice's usePastDue, and moved here
 * unchanged when the ghost fold became its second reader; the waiting notice
 * is gone since ghost rows phase 2.
 */
export function useOverdueInputs() {
  const items = usePlannerStore((s) => s.items);
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const routines = usePlannerStore((s) => s.routines);
  const seasons = usePlannerStore((s) => s.seasons);
  const away = useAwayStore((s) => s.periods);
  const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Bare `format(new Date(), 'yyyy-MM-dd')` would read the MACHINE tz: for a
  // user travelling with a saved tz other than the machine's, an item would
  // count as past due here while the day view still showed it as today's.
  const todayStr = toDateStr(new Date(), tz);

  const inactiveIds = useMemo(
    () => inactiveItemIdsOn(items, todayStr, { userTimezone: tz, routines, seasons, away }),
    [items, todayStr, tz, routines, seasons, away]
  );

  return { items, todayStr, inactiveIds };
}
