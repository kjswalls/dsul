import { isPausedOn } from './active';
import { getItemTypeConfig, isPausable, isSkippable, itemTypeName } from './item-registry';
import { isCompletedOnDate, isRecurring } from './recurrence';
import { occursOn } from './reminders/due';
import { canMoveToNextDay, canReschedule, canSendToBraindump, nextDayTarget } from './row-moves';
import type { OccurrenceState } from './container-schedule';
import type { HabitItem, Item } from './planner-types';

/**
 * The pure half of lib/item-verbs.ts: the context, the shared predicates and
 * every gate that reads nothing but (item, context). Split out so server code
 * (the recipe runner, lib/recipes/server/) can ask the SAME gates without
 * importing the planner store, the UI store or the extension gates, which are
 * client modules.
 *
 * lib/item-verbs.ts re-exports every name here and sets each verb's `eligible`
 * to its gate below, so the browser and the server cannot disagree, and the
 * names ios/ ItemVerbs.swift cites still export from lib/item-verbs.ts.
 * tests/unit/item-verbs.test.ts pins `ITEM_VERBS[v].eligible === VERB_GATES[v]`.
 *
 * resetStreak (reads the Streaks extension, a client gate) and delete (always
 * eligible, behind a confirm) stay in lib/item-verbs.ts.
 */

export interface VerbContext {
  /** The day the verb acts on, yyyy-MM-dd in the user's zone. */
  dateStr: string;
  /** The same day as the Date the store resolves writes against. */
  date: Date;
  /** Wall-clock today in the user's zone. Pausing is dateless and reads this, not `dateStr`. */
  todayStr: string;
  tz: string;
  /** Items that are some goal's milestone — they never go to the braindump. */
  milestoneIds: ReadonlySet<string>;
  /**
   * What the caller KNOWS about this item on `dateStr`, when it knows:
   * an OccurrenceState when the item falls on that day, `'absent'` when it
   * does not. Undefined means unknown (the palette has no schedule to hand),
   * and the per-day verbs then gate on the item's own records alone.
   */
  occurrence?: OccurrenceState | 'absent';
}

export type VerbId =
  | 'complete'
  | 'tick'
  | 'skip'
  | 'unskip'
  | 'pause'
  | 'resume'
  | 'nextDay'
  | 'reschedule'
  | 'braindump'
  | 'resetStreak'
  | 'leaveProjectBlock'
  | 'delete';

/** The verbs whose gate is pure. */
export type GatedVerbId = Exclude<VerbId, 'resetStreak' | 'delete'>;

/* ── shared predicates ─────────────────────────────────────────────────── */

export function isHabit(item: Item): item is HabitItem {
  return item.type === 'habit';
}

/** Task-shaped: a task or a custom type, which rides the task pipeline. */
export function isTaskLike(item: Item): item is Exclude<Item, HabitItem> {
  return item.type !== 'habit';
}

export function isCancelled(item: Item): boolean {
  return item.type !== 'habit' && item.status === 'cancelled';
}

/**
 * "Done" means three different things depending on the item: a habit and a
 * recurring task track completion per date, a one-shot item carries a scalar
 * status whose done value comes from its type config.
 */
export function isDoneOn(item: Item, dateStr: string): boolean {
  if (item.type === 'habit') return item.completedDates.includes(dateStr);
  if (isRecurring(item)) return isCompletedOnDate(item, dateStr);
  return item.status === getItemTypeConfig(itemTypeName(item)).doneStatus;
}

/** Skips are per-DATE on every type that has them (`skippedDates`). */
export function isSkippedOn(item: Item, dateStr: string): boolean {
  return (item.skippedDates ?? []).includes(dateStr);
}

/**
 * What "drawn on this day" says about an item there, for the per-day verbs.
 * A one-off has no per-day state; a recurring item's day is what was recorded,
 * else due from today on and merely open before it (never "missed").
 */
export function drawnState(item: Item, dateStr: string, todayStr: string): OccurrenceState | undefined {
  if (!isRecurring(item as { repeatFrequency?: string })) return undefined;
  if (isDoneOn(item, dateStr)) return 'done';
  if (isSkippedOn(item, dateStr)) return 'skipped';
  return dateStr >= todayStr ? 'due' : 'open';
}

/**
 * `drawnState` for a caller that was not handed the day by a schedule — the
 * phone's item sheet, opened on whatever day is selected: it first asks
 * whether the item falls on the day at all (lib/reminders/due.ts `occursOn`),
 * so a weekday habit opened on a Saturday answers `'absent'` rather than due.
 * Undefined for a one-off, as with `drawnState`.
 */
export function occurrenceOn(
  item: Item,
  dateStr: string,
  todayStr: string,
  tz: string
): OccurrenceState | 'absent' | undefined {
  if (!isRecurring(item as { repeatFrequency?: string })) return undefined;
  return occursOn(item, dateStr, tz) ? drawnState(item, dateStr, todayStr) : 'absent';
}

/** A recurring item whose caller knows it does not fall on the day. */
function absent(item: Item, ctx: VerbContext): boolean {
  return isRecurring(item as { repeatFrequency?: string }) && ctx.occurrence === 'absent';
}

/** The day a dated row is drawn on, for the put-off verbs' gates. */
function rowDateOf(item: Item, ctx: VerbContext): string {
  return (isTaskLike(item) && item.startDate) || ctx.dateStr;
}

function kindOf(item: Item): 'task' | 'habit' {
  return isHabit(item) ? 'habit' : 'task';
}

/**
 * NEXT DAY's target: the day after the later of the row's own day and today,
 * so an overdue carry never lands in the past.
 */
export function nextDayOf(item: Item, ctx: VerbContext): string {
  return nextDayTarget(rowDateOf(item, ctx), ctx.todayStr);
}

/* ── the gates (lib/item-verbs.ts explains each verb) ──────────────────── */

export const VERB_GATES: Readonly<Record<GatedVerbId, (item: Item, ctx: VerbContext) => boolean>> = {
  complete: (item, ctx) => !isDoneOn(item, ctx.dateStr) && !isCancelled(item) && !absent(item, ctx),
  tick: (item, ctx) => {
    if (isCancelled(item) || absent(item, ctx)) return false;
    if (!isRecurring(item as { repeatFrequency?: string })) return true;
    return !isSkippedOn(item, ctx.dateStr);
  },
  skip: (item, ctx) =>
    isSkippable(item) &&
    !isDoneOn(item, ctx.dateStr) &&
    !isSkippedOn(item, ctx.dateStr) &&
    // A caller that knows the day's state offers a skip only on a live one:
    // not on a day the item does not fall on, not on a past open day.
    (ctx.occurrence === undefined || ctx.occurrence === 'due'),
  unskip: (item, ctx) => isSkippedOn(item, ctx.dateStr) && !absent(item, ctx),
  pause: (item, ctx) => isPausable(item) && !isPausedOn(item, ctx.todayStr, ctx.tz),
  resume: (item, ctx) => isPausedOn(item, ctx.todayStr, ctx.tz),
  nextDay: (item, ctx) =>
    isTaskLike(item) && !!item.startDate && canMoveToNextDay(item, kindOf(item), rowDateOf(item, ctx)),
  reschedule: (item, ctx) => isTaskLike(item) && canReschedule(item, kindOf(item), rowDateOf(item, ctx)),
  braindump: (item, ctx) =>
    isTaskLike(item) &&
    !!item.startDate &&
    canSendToBraindump(item, kindOf(item), rowDateOf(item, ctx), ctx.milestoneIds),
  leaveProjectBlock: (item) => isTaskLike(item) && !!item.inProjectBlock,
};
