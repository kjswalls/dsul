import { formatShort } from './collections';
import { isRecurring } from './recurrence';
import { REPEAT_FREQUENCY_LABELS, WEEKDAY_LABELS, type RepeatFrequency } from './planner-types';

/**
 * An item's timing in a few words, for a member row's meta column: how often
 * it repeats ("Daily", "Mon, Wed", "Monthly · 12"), or — a one-off — the day
 * it is on, or "No date".
 *
 * Read from the item's own fields, never a stored summary, so a row edited in
 * the item panel says the new cadence the moment it changes.
 */
export function cadenceLabel(item: {
  repeatFrequency?: string;
  repeatDays?: number[];
  repeatMonthDay?: number;
  startDate?: string;
}): string {
  if (isRecurring(item as { repeatFrequency?: string })) {
    const f = item.repeatFrequency as RepeatFrequency;
    if (f === 'custom') {
      const days = [...(item.repeatDays ?? [])].sort((a, b) => a - b);
      if (days.length === 7) return 'Daily';
      return days.map((d) => WEEKDAY_LABELS[d]).join(', ') || REPEAT_FREQUENCY_LABELS.custom;
    }
    if (f === 'monthly') return item.repeatMonthDay ? `Monthly · ${item.repeatMonthDay}` : 'Monthly';
    return REPEAT_FREQUENCY_LABELS[f] ?? f;
  }
  return item.startDate ? formatShort(item.startDate) : 'No date';
}
