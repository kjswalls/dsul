/**
 * day-done.ts — "is today cleared?", the question the tab icon asks.
 *
 * Pure and string-based, so the client (components/providers/favicon-sync.tsx)
 * and any later server reader share one answer. It decides nothing of its own:
 * it composes the same three predicates lib/stakes/day.ts does — occursOn,
 * isItemActiveOn, isOpenLoopOn — because a tab that turns lime while the grid
 * still shows an open row is the app arguing with itself.
 *
 * TWO CONDITIONS, and both matter:
 *   - nothing that occurs and is active today is still open, AND
 *   - at least one of those was genuinely DONE.
 * A skip or a cancellation discharges an item (isOpenLoopOn), so it never keeps
 * the day open — but it does not earn the day either. Otherwise an empty day,
 * or a day of nothing but skips, would read as finished, and the icon would be
 * a reward for doing nothing.
 *
 * Overdue items from earlier days and undated braindump tasks fall out through
 * occursOn: they belong to no day, so they cannot hold this one open. Subtasks
 * are left to their parent, which is the row the grid draws.
 */

import { isItemActiveOn, isOpenLoopOn, type ActivationContext } from './active'
import { occursOn } from './reminders/due'
import { getItemTypeConfig, itemTypeName } from './item-registry'
import { isRecurring, isSkippedOnDate } from './recurrence'
import type { Item } from './planner-types'

export function isDayCleared(
  items: readonly Item[],
  dateStr: string,
  ctx: ActivationContext,
): boolean {
  let anyDone = false

  for (const item of items) {
    if ('parentItemId' in item && item.parentItemId) continue
    if (!occursOn(item, dateStr, ctx.userTimezone)) continue
    // A paused item, or one held by a paused routine or season, is hidden from
    // the day — the user decided it does not want doing, so it neither holds
    // the day open nor counts towards it.
    if (!isItemActiveOn(item, dateStr, ctx)) continue

    if (isOpenLoopOn(item, dateStr)) return false
    if (wasDone(item, dateStr)) anyDone = true
  }

  return anyDone
}

/**
 * Discharged by a completion or a tally, as opposed to a skip or a cancel.
 * Only asked of an item isOpenLoopOn has already closed, so "not skipped" is
 * enough for a recurring one: completed and counted-to-target are the rest. A
 * one-shot item asks the registry which status is its type's "done", so a
 * closed vocabulary with more than one non-done ending (a habit's 'skipped')
 * never earns the day.
 */
function wasDone(item: Item, dateStr: string): boolean {
  if (isRecurring(item)) {
    const skipped = 'skippedDates' in item ? item.skippedDates : undefined
    return !isSkippedOnDate({ skippedDates: skipped }, dateStr)
  }
  return item.status === getItemTypeConfig(itemTypeName(item)).doneStatus
}
