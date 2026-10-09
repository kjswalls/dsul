/**
 * The two one-item "get this off today" verbs a row or a schedule block offers:
 * carry it to the next day, or send it back to the braindump.
 *
 * Both verbs already exist in the store (`moveTaskToDate`, `unscheduleTask`);
 * what lives here is WHICH items may take them, asked once so the day rows, the
 * schedule blocks and the mobile sheet can't drift apart.
 *
 * Refused, and why:
 * - Types the registry says have no date (habits) or can't reach the braindump.
 * - Recurring items. `startDate` is the series anchor, and there is no
 *   per-occurrence date override, so either verb would rewrite the whole series
 *   (the issue #187 note in eod-review.tsx). Their row answer is "Skip today".
 *   Reschedule is the exception (`canReschedule`): picking a day on purpose
 *   moves the series start, which is what the item panel's date field does.
 * - Done or cancelled items: there is nothing left to put off.
 * - Tasks inside a project block. Neither verb clears `inProjectBlock`, and the
 *   untimed lists skip in-block tasks, so the item would land nowhere visible.
 * - Milestones, for the braindump only. Unscheduling erases the target date;
 *   carrying it one day is a single deliberate move, which the goals rule allows
 *   (memory/plans/long-term-goals.md, decision 4).
 */
import { addDaysToDateStr } from '@/lib/goals';
import { getItemTypeConfig } from '@/lib/item-registry';
import { isCompletedOnDate, isRecurring } from '@/lib/recurrence';
import type { Item, Task } from '@/lib/planner-types';

/**
 * Where "move to tomorrow" sends an item drawn on `rowDateStr`: the day after
 * the later of the row's day and today. On today, or on a future week column,
 * that is the next day; on an overdue day it is real tomorrow, so a carry never
 * lands in the past.
 */
export function nextDayTarget(rowDateStr: string, todayStr: string): string {
  return addDaysToDateStr(rowDateStr > todayStr ? rowDateStr : todayStr, 1);
}

/** Tooltip copy for the carry: "tomorrow" only when it is. */
export function nextDayLabel(target: string, todayStr: string): string {
  return target === addDaysToDateStr(todayStr, 1) ? 'Move to tomorrow' : 'Move to next day';
}

type Movable = Pick<Task, 'id' | 'repeatFrequency' | 'status' | 'inProjectBlock' | 'completedDates'> & {
  type?: string;
  customType?: string;
};

function typeNameOf(item: Movable, itemType: 'task' | 'habit'): string {
  return item.type === 'custom' && item.customType ? item.customType : itemType;
}

function isOpenOn(item: Movable, dateStr: string): boolean {
  if (item.status === 'cancelled') return false;
  if (isRecurring(item)) return !isCompletedOnDate(item as Task, dateStr);
  return item.status !== 'completed';
}

export function canMoveToNextDay(
  item: Item | Movable,
  itemType: 'task' | 'habit',
  dateStr: string,
): boolean {
  const it = item as Movable;
  if (itemType !== 'task') return false;
  if (!getItemTypeConfig(typeNameOf(it, itemType)).dateAddressable) return false;
  if (isRecurring(it) || it.inProjectBlock) return false;
  return isOpenOn(it, dateStr);
}

/**
 * The Reschedule picker's gate: the carry's, except a recurring task may take
 * it too. A picked day becomes the series start, and that day always shows as
 * an occurrence (`anchoredSeriesOn`), so the move lands where the person put it.
 */
export function canReschedule(
  item: Item | Movable,
  itemType: 'task' | 'habit',
  dateStr: string,
): boolean {
  const it = item as Movable;
  if (itemType !== 'task') return false;
  if (!getItemTypeConfig(typeNameOf(it, itemType)).dateAddressable) return false;
  if (it.inProjectBlock) return false;
  return isOpenOn(it, dateStr);
}

export function canSendToBraindump(
  item: Item | Movable,
  itemType: 'task' | 'habit',
  dateStr: string,
  milestoneIds: ReadonlySet<string>,
): boolean {
  const it = item as Movable;
  if (itemType !== 'task') return false;
  if (!getItemTypeConfig(typeNameOf(it, itemType)).braindumpEligible) return false;
  if (isRecurring(it) || it.inProjectBlock || milestoneIds.has(it.id)) return false;
  return isOpenOn(it, dateStr);
}

/** Built once: every row with a carry formats its target day on each render. */
const TARGET_DAY_FORMAT = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

/** "Sat, Sep 27" for a YYYY-MM-DD — the carry tooltip's second line. Formatted
 *  in UTC from the string's own parts, so no timezone can shift it. */
export function formatTargetDay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return TARGET_DAY_FORMAT.format(new Date(Date.UTC(y, m - 1, d)));
}
