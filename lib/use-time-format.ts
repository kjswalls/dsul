import { usePlannerStore } from '@/lib/planner-store';

/**
 * The date-fns format string for a stored time format, the one value the
 * schedule's formatters (components/views/day-schedule.tsx `formatClock`,
 * `formatHourLabel`) branch on. Pure, so the iPhone's fixture
 * (tests/fixtures/day/schedule-copy.json) runs the same rule.
 * '12h' → 'h:mm a'   (e.g. "9:30 am")
 * '24h' → 'HH:mm'    (e.g. "09:30")
 */
export function timeFormatPattern(timeFormat: '12h' | '24h'): 'HH:mm' | 'h:mm a' {
  return timeFormat === '24h' ? 'HH:mm' : 'h:mm a';
}

/**
 * Returns the date-fns format string for displaying times based on user preference.
 * '12h' → 'h:mm a'   (e.g. "9:30 am")
 * '24h' → 'HH:mm'    (e.g. "09:30")
 */
export function useTimeFormat(): string {
  const timeFormat = usePlannerStore((s) => s.timeFormat);
  return timeFormatPattern(timeFormat);
}
