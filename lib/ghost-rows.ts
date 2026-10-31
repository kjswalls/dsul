/**
 * ghost-rows.ts — which items show as ghosts at the top of Today, and in what
 * order. Pure and string-based, like lib/overdue.ts: callers pass the day.
 *
 * A ghost is an item left undone on an earlier day, drawn faded on today until
 * the person says what happens to it (memory/plans/ghost-rows.md). Ghosts are a
 * VIEW: this module selects, it never writes, and nothing is written until a
 * verb on the row is picked.
 *
 * The predicate is `selectOverdue`, the one definition of "past due", so the
 * auto-age sweep, Beacon's context and the ghosts can never disagree about what
 * is left from earlier. That already rules out recurring items, habits,
 * subtasks, anything not pending (completed, cancelled), anything dated today
 * or later, and anything set aside today (`inactiveIds`). On top of it, goal
 * milestones never ghost: a milestone's date is its TARGET, not a plan that
 * slipped, and the fold's sweeping verbs (Keep all, Send all to sidebar) would
 * walk or erase it (lib/goals.ts milestoneItemIds, long-term-goals.md).
 */

import { selectOverdue, toDateOnly } from './overdue';
import type { Item, TaskItem } from './planner-types';

/** Past this many ghosts the fold starts collapsed, with its bulk verbs shown. */
export const GHOST_PILE_THRESHOLD = 5;

/**
 * The ghosts for `todayStr`, newest first (yesterday's at the top, the oldest at
 * the bottom). Ties keep store order, as selectOverdue's do.
 *
 * @param inactiveIds ids set aside today, from lib/active.ts `inactiveItemIdsOn`
 *   (REQUIRED, as selectOverdue's is, for the same fail-closed reason).
 * @param milestoneIds every goal milestone's item id (lib/goals.ts
 *   `milestoneItemIds`, over the RAW goals, never the display list).
 */
export function selectGhostRows(
  items: readonly Item[],
  todayStr: string,
  inactiveIds: ReadonlySet<string>,
  milestoneIds: ReadonlySet<string>,
): TaskItem[] {
  return selectOverdue(items, todayStr, inactiveIds)
    .filter((t) => !milestoneIds.has(t.id))
    .map((item, index) => ({ item, index, day: toDateOnly(item.startDate!) }))
    .sort((a, b) => (a.day === b.day ? a.index - b.index : a.day < b.day ? 1 : -1))
    .map((d) => d.item);
}

/** Does a fold of `count` ghosts start collapsed? */
export function ghostFoldStartsCollapsed(count: number): boolean {
  return count > GHOST_PILE_THRESHOLD;
}

/** "Thu" for a YYYY-MM-DD, from the string's own parts, so no timezone shifts it. */
const WEEKDAY_FORMAT = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
export function ghostWeekday(dateStr: string): string {
  const [y, m, d] = toDateOnly(dateStr).split('-').map(Number);
  return WEEKDAY_FORMAT.format(new Date(Date.UTC(y, m - 1, d)));
}
