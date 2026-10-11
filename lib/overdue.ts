/**
 * overdue.ts — the ONE definition of "past due".
 *
 * Before this file the predicate lived in three places that had already drifted
 * apart: components/ai/morning-check.tsx (the banner), lib/item-registry.ts
 * (Beacon's chat context) and lib/commands/registry.ts (the `goto.overdue`
 * command). None of them guarded recurrence, which meant a daily chore anchored
 * to some date in April was reported as overdue every single morning forever —
 * planner-store's toggle deliberately never moves a recurring item's scalar
 * `status` (it writes completedDates instead), so a recurring item is
 * `status: 'pending'` for the rest of time. lib/day-items.ts has always had the
 * guard; this module brings everyone else onto the same rule.
 *
 * Everything here is pure and string-based. Nothing reads a store or `new
 * Date()` — callers pass the day, which is what makes the whole thing testable
 * and timezone-stable.
 */

import { getItemTypeConfig, itemTypeName } from './item-registry';
import { isRecurring } from './recurrence';
import type { Item, TaskItem } from './planner-types';

/**
 * Cohort boundary, in whole calendar days. `<=` is the recent slice, `>` is the
 * earlier one — so 7 days is still recent and 8 is earlier.
 */
export const RECENT_OVERDUE_DAYS = 7;

/**
 * Section headings for the two cohorts, so the tray and mobile sheet agree.
 *
 * "Recent" / "Earlier", NOT "Recently missed" / "Long overdue". These headings
 * exist to make a long list navigable, and the old pair did that by ranking the
 * user's failures — every row below the second one was labelled as rotting, and
 * the heading was the first thing the eye landed on. The replacements say
 * exactly as much about CHRONOLOGY and nothing at all about the person, which
 * is the posture the whole surface is built on (see the copy contract at the
 * top of components/ai/morning-check.tsx). Sort order is unchanged; only the
 * words are.
 */
export const OVERDUE_COHORT_LABELS = {
  recent: 'Recent',
  long: 'Earlier',
} as const;

const DAY_MS = 86_400_000;

/**
 * yyyy-MM-dd, tolerating legacy full-ISO rows. Same convention as
 * lib/day-items.ts:73-75 — the app has stored both forms over its life and the
 * date-only prefix is the only thing that compares correctly as a string.
 */
export function toDateOnly(dateStr: string): string {
  return dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
}

function toUTCms(dateStr: string): number {
  const [y, m, d] = toDateOnly(dateStr).split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return NaN;
  // Date.UTC, not local — a whole-day difference must not be perturbed by DST.
  return Date.UTC(y, m - 1, d);
}

/**
 * Whole calendar days between an item's start date and `todayStr`.
 *
 * Positive = overdue by that many days (1 = yesterday). 0 = due today, missing
 * a start date, or unparseable. Negative = scheduled in the future. Callers
 * that only ever pass items from {@link selectOverdue} can rely on `>= 1`.
 */
export function daysOverdue(item: { startDate?: string }, todayStr: string): number {
  if (!item.startDate) return 0;
  const start = toUTCms(item.startDate);
  const today = toUTCms(todayStr);
  if (!Number.isFinite(start) || !Number.isFinite(today)) return 0;
  return Math.round((today - start) / DAY_MS);
}

/**
 * Every item that is past its date and still wants doing, in display order.
 *
 * An item qualifies when all of these hold:
 *  - its type is `carryForwardEligible` and `dateAnchored` (registry capability
 *    — habits are neither, custom types are both, see buildCustomTypeConfig)
 *  - it is NOT recurring. A recurring item's misses are per-date state, not a
 *    property of the item, so it can never be "past due" as a whole.
 *  - `status === 'pending'`. That is the only non-terminal task status, so this
 *    one check also excludes 'completed' and — deliberately — 'cancelled',
 *    which the agent API can write (MCP's dsul_update_task, lib/mcp/tools.ts;
 *    TaskStatusSchema) but which has no UI producer and no inverse. A cancelled
 *    item must never reappear in a surface whose only exits assume it can be
 *    completed.
 *  - it has a startDate strictly before `todayStr`.
 *
 * Sort: the recent cohort first, newest first (what you most plausibly still
 * care about), then the earlier tail oldest first, which puts the deepest end of
 * the list at the bottom rather than buried in the middle of it. Ties keep store
 * order — Array#sort is stable.
 *
 * Return type note: custom-type items are date-anchored and carry-forward
 * eligible, so they DO come back from here, narrowed to `TaskItem`. That
 * narrowing is structural, not literal — CustomItem is taskShape plus a
 * `customType` — and matches what components/ai/morning-check.tsx has always
 * done. `itemTypeName(t)` still returns the real registry name at runtime.
 *
 * @param items  the store's unified `items` array (NOT the `tasks` projection —
 *               the registry lookup wants the discriminated item). Accepts a
 *               readonly array so the registry's context renderers can pass
 *               their `readonly Item[]` slice straight through.
 * @param todayStr yyyy-MM-dd for "today", already timezone-resolved by the caller
 * @param inactiveIds ids suppressed today, from lib/active.ts
 *   `inactiveItemIdsOn`. REQUIRED, with no default, on purpose: this predicate
 *   feeds the auto-age sweep, the app's only unattended writer, and a defaulted
 *   parameter would let a future caller silently fail open — nagging about
 *   paused work in the bar, and eventually unscheduling it. Callers whose items
 *   are already filtered (the byte-pinned Beacon renderers) pass an empty set,
 *   which is a deliberate statement rather than an omission.
 */
export function selectOverdue(
  items: readonly Item[],
  todayStr: string,
  inactiveIds: ReadonlySet<string>,
): TaskItem[] {
  const today = toDateOnly(todayStr);

  const overdue = items.filter((t): t is TaskItem => {
    const config = getItemTypeConfig(itemTypeName(t));
    if (!config.carryForwardEligible || !config.dateAnchored) return false;
    // Suppressed work is not "past due" — it is deliberately set aside. Leaving
    // it in would put paused items in the bar's count and, worse, expose them
    // to the auto-age sweep.
    if (inactiveIds.has(t.id)) return false;
    // Subtasks are invisible outside their parent's detail surface — they must
    // not surface in the morning check or be mutated by the auto-age sweep
    // ("move to today" on an item no view shows is a dead-end loop).
    if ('parentItemId' in t && t.parentItemId) return false;
    // THE fix: recurring items never carry forward as a whole.
    if (isRecurring(t)) return false;
    if (t.status !== 'pending') return false;
    if (!('startDate' in t) || !t.startDate) return false;
    return toDateOnly(t.startDate) < today;
  });

  // Decorate/sort/undecorate so daysOverdue runs once per item, not once per
  // comparison.
  return overdue
    .map((item) => ({ item, age: daysOverdue(item, today) }))
    .sort((a, b) => {
      const aLong = a.age > RECENT_OVERDUE_DAYS ? 1 : 0;
      const bLong = b.age > RECENT_OVERDUE_DAYS ? 1 : 0;
      if (aLong !== bLong) return aLong - bLong; // recent cohort first
      return aLong === 0 ? a.age - b.age : b.age - a.age; // newest first / oldest first
    })
    .map((d) => d.item);
}

export interface OverdueCohorts {
  /** Overdue by <= RECENT_OVERDUE_DAYS days, newest first. */
  recent: TaskItem[];
  /** Overdue by > RECENT_OVERDUE_DAYS days, oldest first. */
  long: TaskItem[];
}

/**
 * Split an already-selected list into its two age cohorts. Takes the OUTPUT of
 * {@link selectOverdue} so no consumer ever re-runs the predicate; both slices
 * keep the order they arrived in.
 */
export function splitOverdueCohorts(overdue: TaskItem[], todayStr: string): OverdueCohorts {
  const recent: TaskItem[] = [];
  const long: TaskItem[] = [];
  for (const item of overdue) {
    (daysOverdue(item, todayStr) > RECENT_OVERDUE_DAYS ? long : recent).push(item);
  }
  return { recent, long };
}

/**
 * NO `oldestOverdueDate` HERE, deliberately, and please don't add one back.
 *
 * There used to be one, and its only consumer was the "· oldest Apr 9" tail of
 * the bar copy. A per-row date is orientation — it tells you what a line is
 * about. The MINIMUM of those dates is not: it is a single aggregate whose only
 * possible reading is how far behind you are, printed on a bar you cannot help
 * seeing every time you open the app. It answered a question nobody asked and
 * the answer was always an accusation.
 *
 * The count stays (it is a fact, and it sizes the job), the per-row stamps stay,
 * and the summary below is deliberately the whole of what a surface may know
 * about the pile in aggregate.
 */
export interface OverdueSummary extends OverdueCohorts {
  /** All overdue items in display order (recent cohort, then earlier cohort). */
  items: TaskItem[];
  /** `items.length` — the number the bar counts. */
  count: number;
}

/**
 * One call for everything the past-due surfaces render: the ordered list, the
 * two cohorts and the count. Runs the predicate exactly once.
 */
export function summarizeOverdue(
  items: readonly Item[],
  todayStr: string,
  inactiveIds: ReadonlySet<string>,
): OverdueSummary {
  const overdue = selectOverdue(items, todayStr, inactiveIds);
  return {
    items: overdue,
    ...splitOverdueCohorts(overdue, todayStr),
    count: overdue.length,
  };
}
