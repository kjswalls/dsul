'use client';

import { useEffect, useMemo, useState } from 'react';
import { addDays, startOfWeek } from 'date-fns';
import { useDayItemsForDates } from '@/hooks/use-day-items';
import { useViewStore } from '@/lib/view-store';
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

/** date-fns' weekStartsOn for the planner's week-start setting. */
export const WEEK_STARTS = { sunday: 0, monday: 1, saturday: 6 } as const;

/**
 * How much of what is on screen is open and done, for the shell's status
 * ornaments (status-line, status-bar): the selected day, or with `followScope`
 * the whole week while the canvas shows one. Counted off the same day items the
 * views draw from, so the numbers agree with what is on screen (filters,
 * paused items hidden) rather than re-deriving "what is on today"; each day's
 * rows are judged on that day's own date.
 */
export function useDayCounts({ followScope = false }: { followScope?: boolean } = {}): {
  open: number;
  done: number;
} {
  const selectedDate = usePlannerStore((s) => s.selectedDate);
  const weekStartDay = usePlannerStore((s) => s.weekStartDay);
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const week = useViewStore((s) => s.scope === 'week') && followScope;
  const dates = useMemo(() => {
    if (!week) return [selectedDate];
    const start = startOfWeek(selectedDate, { weekStartsOn: WEEK_STARTS[weekStartDay] ?? 0 });
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [week, selectedDate, weekStartDay]);
  const days = useDayItemsForDates(dates);
  return useMemo(() => {
    const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    let open = 0;
    let done = 0;
    days.forEach((day, i) => {
      const dateStr = toDateStr(dates[i], tz);
      for (const row of flattenDayRows(day)) {
        if (isRowCompletedOn(row, dateStr)) done++;
        else if (!isSetAside(row.item, dateStr)) open++;
      }
    });
    return { open, done };
  }, [days, dates, userTimezone]);
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
