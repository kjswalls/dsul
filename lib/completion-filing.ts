import type { Item } from './planner-types';
import { getItemTypeConfig, itemTypeName } from './item-registry';
import { isRecurring, toDateStr } from './recurrence';

/**
 * Completion filing — where a finished braindump item goes.
 *
 * A one-off finished while it sits in the braindump stays there, struck
 * through, for the rest of the day it was finished on. From the next day on it
 * is FILED onto that day in the planner: dated to it, in the `anytime` bucket,
 * untimed. Not trash (a finished thing is not an unwanted one, and the trash
 * purges), and not left in the braindump forever (the braindump is things not
 * yet decided, and a done pile at its foot pushes every open row down).
 *
 * Always on. There is no setting, and the run has no receipt in the dock: a
 * notice earns a line only when there is something to answer (lib/dock-notices.ts),
 * and the only answer a receipt could offer, "put them back", would be undone
 * by the next day's run. The filing itself is still one history entry, so ⌘Z
 * reverses it for the session.
 *
 * The completion DAY comes from `items.completed_at` (migration 048), resolved
 * in the user's timezone. It is not on Item — see fetchCompletedAt in
 * lib/db.ts — which is why this module is split into a selection that needs no
 * stamps and a plan that does: the hook asks the database only about the rows
 * the selection returns.
 */

/**
 * The rows that COULD be filed: finished one-offs sitting in the braindump.
 *
 * - Braindump membership is the braindump's own test — no bucket, not
 *   scheduled (components/sidebar/braindump.tsx). Anything already on a day is
 *   already filed.
 * - Recurring items are out: their completion is per-date and resets, so they
 *   never finish as a whole.
 * - Subtasks are out: they have no standalone row and follow their parent.
 * - Types that do not live on dates are out, asked of the registry rather than
 *   of the type name (lib/item-registry.ts).
 * - Milestones are out: a milestone's `startDate` is its goal's target date,
 *   and every sweeping verb leaves it alone (lib/goals.ts).
 * - Suppressed items (paused, or in a paused routine / switched-off season)
 *   are out: they are hidden by a decision the user made, and moving them is
 *   the app arguing with it. They are filed on the first run after they return.
 */
export function selectFilingCandidates(
  items: readonly Item[],
  exclude: { milestones: ReadonlySet<string>; inactive: ReadonlySet<string> },
): Item[] {
  return items.filter((item) => {
    if (item.type === 'habit') return false;
    if (item.status !== 'completed') return false;
    if (isRecurring(item)) return false;
    if (item.parentItemId) return false;
    if (item.isScheduled || item.timeBucket) return false;
    const config = getItemTypeConfig(itemTypeName(item));
    if (!config.dateAnchored || !config.braindumpEligible) return false;
    if (exclude.milestones.has(item.id)) return false;
    if (exclude.inactive.has(item.id)) return false;
    return true;
  });
}

export interface FilingEntry {
  id: string;
  /** The user-local day the item was completed on — yyyy-MM-dd. */
  date: string;
}

/**
 * Which candidates to file, and onto which day.
 *
 * Only completions from BEFORE today: today's stay in the braindump, struck
 * through, until the day turns. A candidate with no stamp (a database that has
 * not run 048, or a row the backfill could not date) is left where it is —
 * guessing a day is worse than one more day in the braindump. So is a stamp
 * that does not parse.
 */
export function planFiling(
  candidates: readonly Item[],
  stamps: ReadonlyMap<string, string>,
  todayStr: string,
  userTimezone: string,
): FilingEntry[] {
  const entries: FilingEntry[] = [];
  for (const item of candidates) {
    const stamp = stamps.get(item.id);
    if (!stamp) continue;
    const at = new Date(stamp);
    if (Number.isNaN(at.getTime())) continue;
    const date = toDateStr(at, userTimezone);
    if (date < todayStr) entries.push({ id: item.id, date });
  }
  return entries;
}
