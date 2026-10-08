import { isRecurring } from '@/lib/recurrence';
import { isDoneOn } from '@/lib/verb-gates';
import { itemTypeName } from '@/lib/item-registry';
import type { Item } from '@/lib/planner-types';
import type { ModOnlyEvent } from '@/lib/mod-events';

/**
 * What one ⌘Z took the completion off (memory/plans/mods.md, build order 8).
 * Pure: planner-store's undo() snapshots the items before applying history
 * and asks this of the two lists.
 *
 * - A habit or a recurring item: every date in its completion record before
 *   that is missing after.
 * - A one-off: done before and not after, dated as ModEvents date it (its
 *   startDate, else today).
 *
 * An item the undo removed or added is neither, so it raises nothing.
 */
export function uncompletionsBetween(
  before: readonly Item[],
  after: readonly Item[],
  todayStr: string
): Omit<ModOnlyEvent, 'undoneLabel'>[] {
  const now = new Map(after.map((i) => [i.id, i] as const));
  const out: Omit<ModOnlyEvent, 'undoneLabel'>[] = [];
  for (const was of before) {
    const is = now.get(was.id);
    if (!is) continue;
    const type = itemTypeName(is);
    if (was.type === 'habit' || isRecurring(was as { repeatFrequency?: string })) {
      const kept = new Set(is.completedDates ?? []);
      for (const date of was.completedDates ?? []) {
        if (!kept.has(date)) out.push({ kind: 'item.uncompleted', origin: 'undo', itemId: is.id, date, type });
      }
      continue;
    }
    if (isDoneOn(was, todayStr) && !isDoneOn(is, todayStr)) {
      const date = (was as { startDate?: string }).startDate ?? todayStr;
      out.push({ kind: 'item.uncompleted', origin: 'undo', itemId: is.id, date, type });
    }
  }
  return out;
}
