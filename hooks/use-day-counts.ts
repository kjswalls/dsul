'use client';

import { useEffect, useMemo, useState } from 'react';
import { useDayItems } from '@/hooks/use-day-items';
import { usePlannerStore } from '@/lib/planner-store';
import { flattenDayRows } from '@/lib/day-items';
import { isRowCompletedOn } from '@/lib/sort-rows';
import { isRecurring, isSkippedOnDate, toDateStr } from '@/lib/recurrence';

/**
 * Skipped for the day, or cancelled: on the list, but neither open nor done.
 * Per-date for a recurring item, `status` for a one-off — never `status` for a
 * recurring one (CLAUDE.md: completedDates, not scalar status).
 */
function isSetAside(item: { repeatFrequency?: string; skippedDates?: string[]; status?: string }, dateStr: string): boolean {
  if (isRecurring(item)) return isSkippedOnDate(item, dateStr);
  return item.status === 'skipped' || item.status === 'cancelled';
}

/**
 * How much of the selected day is open and done, for the shell's status
 * ornaments (status-line, status-bar). Counted off the same useDayItems the
 * views draw from, so the numbers agree with what is on screen (filters,
 * paused items hidden) rather than re-deriving "what is on today".
 */
export function useDayCounts(): { open: number; done: number } {
  const day = useDayItems();
  const selectedDate = usePlannerStore((s) => s.selectedDate);
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  return useMemo(() => {
    const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const dateStr = toDateStr(selectedDate, tz);
    let open = 0;
    let done = 0;
    for (const row of flattenDayRows(day)) {
      if (isRowCompletedOn(row, dateStr)) done++;
      else if (!isSetAside(row.item, dateStr)) open++;
    }
    return { open, done };
  }, [day, selectedDate, userTimezone]);
}

/** The wall clock, to the minute, re-aimed at each minute's edge. Null until mounted. */
export function useMinuteClock(): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    let timer: number;
    const tick = () => {
      const d = new Date();
      setNow(d);
      timer = window.setTimeout(tick, 60_000 - (d.getSeconds() * 1000 + d.getMilliseconds()) + 50);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, []);
  return now;
}
