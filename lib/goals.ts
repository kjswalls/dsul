import {
  getItemTypeConfig,
  isCheckinEligible,
  isMilestoneEligible,
  itemTypeName,
} from './item-registry';
import {
  anchoredSeriesOn,
  firstRepeatDayFrom,
  isCompletedOnDate,
  isRecurring,
  isSkippedOnDate,
  shouldShowOnDate,
} from './recurrence';
import { toDateOnly } from './overdue';
import { formatDay } from './active';
import type { Goal, GoalRole, Item } from './planner-types';

/**
 * goals.ts — everything derived about a goal, stated once.
 *
 * The lib/overdue.ts bargain: that module exists because three copies of one
 * predicate drifted, and every question here is the same shape — cheap to
 * re-derive badly at a call site, and wrong in a way nobody notices for weeks.
 * The console detail pane, the /goal/[id] page, Beacon's section and the agent
 * projection all ask THIS module; none of them re-derives.
 *
 * Pure and store-free by construction: everything takes the items it needs.
 * See memory/plans/long-term-goals.md.
 */

/** `2026-08-21` + 3 → `2026-08-24`, in pure calendar terms. */
export function addDaysToDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/* ── membership ───────────────────────────────────────────────────────────── */

/** The three role arrays of one goal, flattened to (itemId, role) pairs. */
export function goalRoleEntries(goal: Goal): { itemId: string; role: GoalRole }[] {
  return [
    ...goal.milestoneIds.map((itemId) => ({ itemId, role: 'milestone' as const })),
    ...goal.checkinIds.map((itemId) => ({ itemId, role: 'checkin' as const })),
    ...goal.memberIds.map((itemId) => ({ itemId, role: 'member' as const })),
  ];
}

export interface ItemGoalRole {
  goalId: string;
  goalName: string;
  role: GoalRole;
}

/**
 * item id → the goals it serves and how.
 *
 * Built once and handed down, rather than asked per row: the role glyph on a
 * task row, the auto-age sweep's milestone exclusion, and the demotion rule
 * that fires on an item edit all need the SAME reverse lookup, and each of them
 * would otherwise scan every goal's three arrays per item.
 *
 * ACTIVE goals only by default — an achieved goal's milestone is history, and a
 * row should not still wear a flag for a goal that is finished. Pass
 * `includeEnded` where the question is "what did this item ever serve" (the
 * item dialog's Ended divider), never where it is "what is this item doing".
 */
let cachedIndexGoals: readonly Goal[] | null = null;
let cachedIndexEnded = false;
let cachedIndex: Map<string, ItemGoalRole[]> = new Map();

export function goalRolesByItem(
  goals: readonly Goal[],
  { includeEnded = false }: { includeEnded?: boolean } = {},
): Map<string, ItemGoalRole[]> {
  // Memoized on the goals array's identity, so the docblock's "built once and
  // handed down" is true even when the caller is a row that cannot be handed
  // anything. Every row in a week grid asks this on mount; without the cache
  // that is N full index builds, which measured at 34ms for a realistic
  // two-year account and grows with both goals and rows.
  if (goals === cachedIndexGoals && includeEnded === cachedIndexEnded) return cachedIndex;

  const index = new Map<string, ItemGoalRole[]>();
  for (const goal of goals) {
    if (!includeEnded && goal.state !== 'active') continue;
    for (const { itemId, role } of goalRoleEntries(goal)) {
      const entry = { goalId: goal.id, goalName: goal.name, role };
      const list = index.get(itemId);
      if (list) list.push(entry);
      else index.set(itemId, [entry]);
    }
  }
  cachedIndexGoals = goals;
  cachedIndexEnded = includeEnded;
  cachedIndex = index;
  return index;
}

/**
 * Every item id that is a milestone of a LIVE goal.
 *
 * The set the auto-age sweep and the bulk date verbs subtract, because for a
 * milestone `startDate` is not stale scheduling residue — it is the target
 * date, the one piece of the checkpoint that says when it was meant to happen.
 * `unscheduleTasks` clears it; "Move all to tomorrow" rewrites it. Both are
 * right for an ordinary task and destructive here.
 *
 * Deliberately NOT filtered by goal state: an abandoned goal's milestone should
 * still not have its date silently erased, because un-abandoning is one click
 * and the date would not come back.
 */
export function milestoneItemIds(goals: readonly Goal[]): Set<string> {
  const ids = new Set<string>();
  for (const goal of goals) for (const id of goal.milestoneIds) ids.add(id);
  return ids;
}

/* ── display selection ────────────────────────────────────────────────────── */

/**
 * The goals a DISPLAY surface may organise by — live work only.
 *
 * The same cut `goalRolesByItem` makes for the role glyph, and for the same
 * reason: an achieved goal's members are history, and a section heading (or a
 * filter row) naming a goal that is finished offers to organise today's work by
 * something that is over. Ended goals stay browsable in the console, which is
 * where the record lives.
 *
 * A row whose only goal has ended is not hidden by this — it falls into the
 * grouping's loose "No goal" bucket. Nothing an aspire container does may
 * remove a row from a surface; see lib/container-registry.ts.
 */
export function displayGoals(goals: readonly Goal[]): Goal[] {
  return goals.filter(isGoalActive);
}

/**
 * Every item one goal holds, whatever role it holds it in.
 *
 * `goalRoleEntries`' order — milestones (their own timeline order), then
 * check-ins, then plain members — so a grouped section leads with the
 * checkpoints the goal is measured by. No dedupe is needed: `goal_items`'
 * primary key is `(goal_id, item_id)`, so the three arrays are disjoint on read
 * (see packages/types GoalSchema).
 */
export function goalItemIds(goal: Goal): string[] {
  return goalRoleEntries(goal).map((e) => e.itemId);
}

/**
 * The item ids a goal SELECTION admits — or `null` when the clause cannot
 * narrow anything, which every caller must read as "inert", not as "empty".
 *
 * ALL THREE ROLES are in. The role says what an item does FOR the goal, not
 * whether it serves it, so a "Learn Chinese" filter that dropped the HSK 3
 * milestone and the Sunday check-in would hide the two things the goal is
 * actually measured by. (A milestone's `startDate` is its TARGET date, so on
 * the canvas it appears on the day it is aimed at, and an undated one stays in
 * the braindump where the plan puts it — both are the same rows those surfaces
 * already showed, now narrowed rather than moved.)
 *
 * `null` for a selection that names no ACTIVE goal — a goal achieved or
 * abandoned while it was selected, or one deleted out from under the filter.
 * The alternative is an empty set, which empties the surface completely with
 * nothing on it to say why: the exact failure mode lib/view-store.ts's
 * `renameContainerRef` exists to prevent for a stale container ref. A goal that
 * is live and simply holds none of these rows still narrows to nothing, which
 * is truthful — that goal has no work here.
 */
export function goalFilterItemIds(
  goals: readonly Goal[],
  selectedGoalIds: readonly string[],
): ReadonlySet<string> | null {
  if (selectedGoalIds.length === 0) return null;
  const selected = new Set(selectedGoalIds);
  const live = displayGoals(goals).filter((goal) => selected.has(goal.id));
  if (live.length === 0) return null;
  const ids = new Set<string>();
  for (const goal of live) for (const id of goalItemIds(goal)) ids.add(id);
  return ids;
}

/* ── progress ─────────────────────────────────────────────────────────────── */

export interface GoalProgress {
  achieved: number;
  total: number;
  /** null when there are no milestones to measure — never 0, which reads as "none done". */
  fraction: number | null;
}

/**
 * Has this one-shot item reached its type's terminal status?
 *
 * Exported because the timeline needs the same question, and this module's
 * header promises that no surface re-derives: a copy would let the timeline
 * render a checkpoint as still ahead while the fraction above it counted the
 * same checkpoint as done.
 */
export function isAchieved(item: Item): boolean {
  return item.status === getItemTypeConfig(itemTypeName(item)).doneStatus;
}

/**
 * Milestones achieved out of milestones defined.
 *
 * Derived on every read and never stored: a stored percentage drifts the first
 * time a milestone is added, completed elsewhere, or trashed.
 *
 * Two exclusions, and both are decisions rather than tidying:
 *
 * TRASHED milestones leave both sides — the dangling-id rule (join rows outlive
 * an item's soft delete so a restore is intact), so the arrays legitimately
 * name ids that are in the bin, and `itemsById` holds only live items.
 *
 * CANCELLED milestones leave both sides too. A cancelled milestone is a dropped
 * checkpoint, not a failed one: it can never reach `doneStatus`, no UI produces
 * or reverses it, and selectOverdue already excludes it — so counting it in the
 * denominator would make the goal read permanently behind with no visible cause
 * and no way out.
 */
export function goalProgress(goal: Goal, itemsById: Map<string, Item>): GoalProgress {
  let achieved = 0;
  let total = 0;
  for (const id of goal.milestoneIds) {
    const item = itemsById.get(id);
    if (!item) continue;
    if (item.status === 'cancelled') continue;
    total += 1;
    if (isAchieved(item)) achieved += 1;
  }
  return { achieved, total, fraction: total === 0 ? null : achieved / total };
}

/**
 * "3/7", "No milestones yet", or "2/2 so far": the fraction, in words.
 *
 * The suffix is the load-bearing part. The plan's own example is a three-year
 * business with two near-term milestones defined, and a bare "2/2" there reads
 * as finished — so while the goal is still running, a full fraction says what
 * it actually means: everything defined SO FAR. Once the goal is achieved, 2/2
 * means what it says and the suffix goes.
 *
 * Here rather than in goal-sections.tsx so the iPhone's Organize list says the
 * same words (ios/DsulCore Goals.swift, pinned by tests/fixtures/organize/goals.json).
 */
export function progressLabel(goal: Goal, achieved: number, total: number): string {
  if (total === 0) return 'No milestones yet';
  const bare = `${achieved}/${total}`;
  if (!isGoalActive(goal)) return bare;
  return achieved === total ? `${bare} so far` : bare;
}

/**
 * How far through its own window the goal is, 0..1, or null when it has no
 * window (or an inverted one).
 *
 * Rendered BESIDE the milestone fraction, never merged into it. They answer
 * different questions — "how much is done" and "how much time is gone" — and a
 * single blended number would hide exactly the case the pair exists to show: a
 * three-year goal that is 2/2 on milestones and three months in.
 *
 * Inverted ranges return null rather than a negative or clamped value: a goal
 * whose target precedes its start is live on no sensible reading, and reporting
 * a number for it would make the behind/ahead line confidently wrong.
 */
export function timeElapsed(goal: Goal, todayStr: string): number | null {
  if (!goal.startsOn || !goal.targetOn) return null;
  const start = toDateOnly(goal.startsOn);
  const target = toDateOnly(goal.targetOn);
  if (target <= start) return null;
  const today = toDateOnly(todayStr);
  if (today <= start) return 0;
  if (today >= target) return 1;
  const span = Date.parse(`${target}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  const gone = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  return gone / span;
}

/**
 * "40% of the way to Mar 15": {@link timeElapsed} in words, or null when the
 * goal has no window. The caller shows it only beside at least one milestone,
 * as GoalProgressTrack does (goal-sections.tsx): at zero there is no track to
 * read it against. Here so the iPhone's goal page says the same words.
 */
export function timeElapsedLabel(goal: Goal, todayStr: string): string | null {
  const elapsed = timeElapsed(goal, todayStr);
  if (elapsed === null) return null;
  return `${Math.round(elapsed * 100)}% of the way to ${formatDay(goal.targetOn!)}`;
}

/**
 * The days left to a goal's target, in the page header's words: "12 days to
 * Mar 15", "target is today", "3 days past Mar 15". Null when the goal is not
 * active or has no target. Past the target is a count, never an alarm: the
 * guilt-free law. Moved out of GoalSummary (goal-sections.tsx).
 */
export function goalCountdown(goal: Goal, todayStr: string): string | null {
  if (!goal.targetOn || !isGoalActive(goal)) return null;
  const days = Math.round(
    (Date.parse(`${toDateOnly(goal.targetOn)}T00:00:00Z`) - Date.parse(`${toDateOnly(todayStr)}T00:00:00Z`)) /
      86_400_000,
  );
  const n = (k: number) => `${k} ${k === 1 ? 'day' : 'days'}`;
  if (days > 0) return `${n(days)} to ${formatDay(goal.targetOn)}`;
  if (days === 0) return 'target is today';
  return `${n(Math.abs(days))} past ${formatDay(goal.targetOn)}`;
}

/**
 * The next checkpoint to aim at: the earliest un-achieved milestone.
 *
 * Dated ones first, in date order, because a date is a commitment and an
 * undated milestone is a checkpoint someone has not scheduled yet. Undated ones
 * follow in their stored order (goal_items.sort_order, which is the order the
 * arrays already arrive in). Cancelled and trashed milestones are not
 * candidates, for the reasons goalProgress gives.
 */
export function nextMilestone(goal: Goal, itemsById: Map<string, Item>): Item | null {
  const open: Item[] = [];
  for (const id of goal.milestoneIds) {
    const item = itemsById.get(id);
    if (!item || item.status === 'cancelled' || isAchieved(item)) continue;
    open.push(item);
  }
  if (open.length === 0) return null;
  // Stable within each half: `open` is built in array order, and sort() is
  // stable, so undated milestones keep their stored sequence.
  return [...open].sort(byTargetDay)[0];
}

/** A milestone's target day, yyyy-MM-dd, or null when it has none. */
function targetDayOf(item: Item): string | null {
  return 'startDate' in item && item.startDate ? toDateOnly(item.startDate) : null;
}

/** Dated first, by date; undated after, in their stored order (the sort is stable). */
function byTargetDay(a: Item, b: Item): number {
  const da = targetDayOf(a);
  const db = targetDayOf(b);
  if (da && db) return da < db ? -1 : da > db ? 1 : 0;
  if (da) return -1;
  if (db) return 1;
  return 0;
}

/* ── the milestone timeline ───────────────────────────────────────────────── */

export type MilestoneState = 'achieved' | 'next' | 'overdue' | 'dropped' | 'ahead';

/**
 * Where one milestone stands on the timeline.
 *
 * `next` OUTRANKS `overdue`, which is the opposite of the first version and
 * the difference between a timeline that points somewhere and one that does
 * not. The earliest open milestone of a goal that has slipped is BOTH, and
 * ranking overdue first meant no row was highlighted at all on exactly the
 * goals where "what now?" is the question. Lateness still shows, in the
 * caption ({@link milestoneTimeline}).
 */
export function milestoneState(item: Item, isNext: boolean, todayStr: string): MilestoneState {
  if (item.status === 'cancelled') return 'dropped';
  if (isAchieved(item)) return 'achieved';
  if (isNext) return 'next';
  const date = targetDayOf(item);
  if (date && date < toDateOnly(todayStr)) return 'overdue';
  return 'ahead';
}

/** One row of a goal's milestone timeline. */
export interface MilestoneRow {
  item: Item;
  state: MilestoneState;
  /** The target day as stored, or undefined when it has none. */
  date?: string;
  /** Dated before today, whatever its state. */
  late: boolean;
  /** "Oct 4", or "No date yet". */
  dateLabel: string;
  /**
   * The caption's notes after the date, each drawn "· {note}": "reached",
   * "next up", "still ahead of you", "dropped". Never "overdue": the same
   * information, in the register the app uses for work that has slipped.
   */
  annotations: string[];
}

/**
 * The checkpoints, in the order they are meant to happen: the order
 * {@link nextMilestone} reads them in, dated first by date, then the undated
 * in their stored sequence. Trashed ones (absent from `itemsById`) are left
 * out; a dropped (cancelled) one stays, quietly, because it is part of the
 * record of how the goal went. Moved out of MilestoneTimeline
 * (goal-sections.tsx) so the iPhone draws the same rows with the same words.
 */
export function milestoneTimeline(goal: Goal, itemsById: Map<string, Item>, todayStr: string): MilestoneRow[] {
  const next = nextMilestone(goal, itemsById);
  const today = toDateOnly(todayStr);
  return goal.milestoneIds
    .map((id) => itemsById.get(id))
    .filter((i): i is Item => !!i)
    .sort(byTargetDay)
    .map((item) => {
      const state = milestoneState(item, item.id === next?.id, todayStr);
      const date = 'startDate' in item ? item.startDate : undefined;
      const late = !!date && toDateOnly(date) < today;
      const annotations: string[] = [];
      if (state === 'achieved') annotations.push('reached');
      if (state === 'next') annotations.push('next up');
      // For the NEXT row too when it is late, since `next` outranks `overdue`.
      if (state === 'overdue' || (state === 'next' && late)) annotations.push('still ahead of you');
      if (state === 'dropped') annotations.push('dropped');
      return { item, state, date, late, dateLabel: date ? formatDay(date) : 'No date yet', annotations };
    });
}

/* ── the supporting work ──────────────────────────────────────────────────── */

/**
 * Members grouped by type (its `itemTypeName`), each group in the order its
 * first member appears and its members in `ids` order, so a goal's five habits
 * read as a practice and its three tasks as errands. Trashed ids are skipped.
 * A group is headed by its type's `labelPlural`.
 */
export function goalMemberGroups(
  ids: readonly string[],
  itemsById: Map<string, Item>,
): { typeName: string; items: Item[] }[] {
  const byType = new Map<string, Item[]>();
  for (const id of ids) {
    const item = itemsById.get(id);
    if (!item) continue;
    const name = itemTypeName(item);
    const list = byType.get(name);
    if (list) list.push(item);
    else byType.set(name, [item]);
  }
  return [...byType].map(([typeName, items]) => ({ typeName, items }));
}

/**
 * An ended goal's members that still come round (decision 5's wind-down):
 * check-ins, then supporting work, then milestones, recurring ones only,
 * trashed ones skipped. The goal changes none of them.
 */
export function windDownMembers(goal: Goal, itemsById: Map<string, Item>): Item[] {
  return [...goal.checkinIds, ...goal.memberIds, ...goal.milestoneIds]
    .map((id) => itemsById.get(id))
    .filter((i): i is Item => !!i && isRecurring(i));
}

/** The latest day a recurring item was done, or undefined. yyyy-MM-dd sorts as text. */
export function lastDoneOn(item: Item): string | undefined {
  const dates = 'completedDates' in item ? (item.completedDates ?? []) : [];
  return dates.reduce<string | undefined>((max, d) => (!max || d > max ? d : max), undefined);
}

/* ── check-ins ────────────────────────────────────────────────────────────── */

export interface CheckinStanding {
  /** The check-in item this describes, or null when the goal has none. */
  item: Item | null;
  /** yyyy-MM-dd of the next occurrence on or after today, or null. */
  nextDue: string | null;
  /** yyyy-MM-dd of the most recent completed occurrence, or null. */
  lastDone: string | null;
  /** True when today's occurrence is due and unmarked. */
  dueToday: boolean;
}

/**
 * Where the goal's check-in rhythm stands.
 *
 * Reads the FIRST check-in — goals are expected to have one, and a second is a
 * user choice this v1 does not try to summarise. Looks forward a bounded window
 * rather than solving the recurrence algebraically: `shouldShowOnDate` is the
 * one definition of when an occurrence falls, and asking it 35 times is
 * cheaper than a second implementation that can disagree with the grid.
 */
export function checkinStanding(
  goal: Goal,
  itemsById: Map<string, Item>,
  todayStr: string,
  userTimezone: string,
): CheckinStanding {
  const item = goal.checkinIds.map((id) => itemsById.get(id)).find((i): i is Item => !!i) ?? null;
  if (!item) return { item: null, nextDue: null, lastDone: null, dueToday: false };

  const completed: string[] = ('completedDates' in item ? item.completedDates : undefined) ?? [];
  const lastDone = completed.length > 0 ? [...completed].sort().at(-1)! : null;

  // Walked in DATE-STRING space, never by constructing a Date and reading it
  // back through the user's zone. That round trip was wrong by a whole
  // occurrence, not a day: `new Date('yyyy-MM-ddT12:00:00')` parses in the
  // RUNTIME's zone, so for a user more than 12h east of the server, offset 0
  // already formatted as tomorrow — today's occurrence was never probed, and on
  // a weekly cadence the page reported next week for a check-in due now.
  // `todayStr` already arrives resolved in the user's zone; incrementing it
  // arithmetically keeps it that way. Same reasoning as lib/overdue.ts's
  // Date.UTC day math.
  let nextDue: string | null = null;
  for (let offset = 0; offset < 35; offset += 1) {
    const dateStr = addDaysToDateStr(toDateOnly(todayStr), offset);
    // The grid's rule (deriveDayItems): a dated check-in counts its own start
    // day, then the repeat, and nothing before the start.
    const start = 'startDate' in item && item.startDate ? toDateOnly(item.startDate) : null;
    const falls = start
      ? anchoredSeriesOn(item, start, dateStr, userTimezone)
      : shouldShowOnDate(item, dateStr, userTimezone);
    if (!falls) continue;
    // Completed AND skipped. A skip is the other per-date terminal mark a
    // recurring item can carry — "not this one" — so treating only completion
    // as answered made the page say "Due today" for an occurrence the user had
    // explicitly struck off the grid an hour earlier.
    if (isCompletedOnDate(item, dateStr)) continue;
    if (isSkippedOnDate(item, dateStr)) continue;
    nextDue = dateStr;
    break;
  }

  return {
    item,
    nextDue,
    lastDone,
    dueToday: nextDue === toDateOnly(todayStr),
  };
}

/**
 * The next milestone a reader may actually be told to act on.
 *
 * `nextMilestone` answers "what is next" about the goal; this answers "what is
 * next that is not currently hidden", which is the question every PROMPT is
 * really asking. Naming a suppressed item as next recommends the exact work the
 * paused/set-aside section forbids in the same breath — two contradictory
 * instructions in one prompt — while dropping the line entirely leaves a goal
 * with a milestone count and no milestone. So it advances instead.
 *
 * Not used by the UI: the goal surface renders the whole timeline, where a
 * suppressed checkpoint is visible in context rather than quoted alone.
 */
export function nextMilestoneVisible(
  goal: Goal,
  itemsById: Map<string, Item>,
  suppressedIds: ReadonlySet<string>,
): Item | null {
  const visible = new Map(
    [...itemsById].filter(([id]) => !suppressedIds.has(id)),
  );
  return nextMilestone(goal, visible);
}

/* ── lifecycle ────────────────────────────────────────────────────────────── */

/**
 * What a state change actually writes.
 *
 * The `resolvePauseWrite` bargain, for the same reason: the read side
 * (`achievedAt` is when this was achieved) and the write side must not be
 * derived twice, or they disagree the first time either changes.
 *
 * Returns an EMPTY patch for a same-state write. Re-achieving an achieved goal
 * would otherwise drag its achievement date forward — and retried writes are
 * expected traffic, since whole-array membership replacement is designed to be
 * idempotent. Returning to 'active' clears the stamp, so undo of "Mark
 * achieved" restores both halves in one replay rather than stranding a
 * timestamp on a goal that is running again.
 */
export function resolveGoalStateWrite(
  goal: Goal,
  state: Goal['state'],
  nowIso: string,
): Partial<Goal> {
  if (goal.state === state) return {};
  if (state === 'achieved') return { state, achievedAt: nowIso };
  if (state === 'active') return { state, achievedAt: undefined };
  // Abandoned keeps whatever stamp it had: a goal achieved and later abandoned
  // is a strange history, but it is the user's history and nothing here should
  // quietly rewrite it.
  return { state };
}

/** Is this goal still live work, as opposed to a record of finished work? */
export const isGoalActive = (goal: Goal): boolean => goal.state === 'active';

/**
 * Sort for every goal list: live work first, then the record, each newest-named
 * order preserved.
 *
 * Ended goals sink rather than interleaving by `sort_order`. Over the horizon a
 * goal actually spans, a list that mixes them reads as clutter by year two —
 * and the console's list is the only place they are browsable.
 */
export function sortGoalsForDisplay(goals: readonly Goal[]): Goal[] {
  return [...goals].sort((a, b) => Number(!isGoalActive(a)) - Number(!isGoalActive(b)));
}

/**
 * Whether a role is still valid for the item that holds it.
 *
 * The demotion rule's predicate (locked decision 3): a milestone must stay
 * one-shot and a check-in must stay recurring, but the item dialog and the
 * agent PATCH route can flip `repeatFrequency` long after the role was granted.
 * Rather than blocking the edit — which would let a goal constrain its members,
 * the one thing goals must never do — the holder demotes to 'member'.
 *
 * The predicate must match the GRANT predicate, not just its recurrence half.
 * Making a milestone a SUBTASK is the other way to strand one: a subtask leaves
 * the tasks projection, so it drops off the grid, the braindump, the EOD review
 * and selectOverdue — decision 2's "being behind on a milestone shows up in the
 * past-due bar" quietly stops being true — while it stays in items[], so
 * progress goes on counting it in the denominator. isMilestoneEligible and
 * isCheckinEligible both start from isCollectible, which excludes subtasks; so
 * does this.
 *
 * 'member' is always valid, so demotion terminates. A subtask arguably should
 * not hold plain membership either, but that would be a REMOVAL rather than a
 * demotion, and removing a membership the user did not ask to remove is a
 * bigger promise than this rule makes. Recorded in the plan instead.
 */
export function roleStillValid(role: GoalRole, item: Item): boolean {
  if (role === 'milestone') return isMilestoneEligible(item);
  if (role === 'checkin') return isCheckinEligible(item);
  return true;
}

/**
 * The task a new goal member is born as, per role — shared by the goal pane's
 * add rows and the create forms, so a milestone made in either place is the
 * same row. The reasoning lives on the goal pane's createCheckin/createMilestone
 * (organize/sections/goals.tsx): a milestone and a plain member are UNDATED (a
 * checkpoint's date is a commitment nobody should guess), and a check-in is a
 * weekly Sunday task anchored at the first Sunday from today, in the anytime
 * bucket — without the anchor a recurring task renders on no column at all.
 */
export function newMemberTaskShape(role: GoalRole, title: string, todayStr: string) {
  const base = { title, completedDates: [] as string[], skippedDates: [] as string[] };
  if (role !== 'checkin') return base;
  return {
    ...base,
    startDate: firstRepeatDayFrom({ repeatFrequency: 'custom', repeatDays: [0] }, todayStr),
    timeBucket: 'anytime' as const,
    repeatFrequency: 'custom' as const,
    repeatDays: [0],
  };
}
