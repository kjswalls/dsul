import { usePlannerStore } from './planner-store';
import { useUIStore } from './ui-store';
import { isPausedOn } from './active';
import { streaksEnabled } from './extension-gates';
import { getItemTypeConfig, isPausable, isSkippable, itemTypeName } from './item-registry';
import { toggleRowDone, toggleTaskDone } from './item-toggle';
import { isCompletedOnDate, isRecurring } from './recurrence';
import { canMoveToNextDay, canReschedule, canSendToBraindump, formatTargetDay, nextDayLabel, nextDayTarget } from './row-moves';
import type { OccurrenceState } from './container-schedule';
import type { HabitItem, Item, Task } from './planner-types';

/**
 * WHAT CAN BE DONE TO ONE ITEM, declared once.
 *
 * Every surface that offers a verb on an item — the ⌘K item commands
 * (lib/commands/registry.ts), the Organize console's member rows and the
 * routine's Today checklist (components/planner/organize/member-row-actions.tsx)
 * — asks here, so "may I?" and "what does it write?" have one answer. They used
 * to carry their own copies, and the copies had drifted: the palette's Snooze
 * wrote a recurring task's series anchor, which the rows had refused all along.
 *
 * The one thing that legitimately differs between surfaces is WHICH DAY a verb
 * acts on, so that is an argument, never a lookup:
 *  · the palette passes the day on screen (lib/commands/entities.ts activeDateStr);
 *  · the console and the Today checklist pass the real today;
 *  · a surface drawn per day (a week column) passes the day it drew.
 *
 * Each verb is pure over (item, context) for its gate and reads the store only
 * when it runs, so a caller may gate at render time and run at click time with
 * a fresh context.
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

export interface ItemVerb {
  id: VerbId;
  /** The label for this item on this day ("Count one (1/3)", "Move to next day"). */
  label: (item: Item, ctx: VerbContext) => string;
  /** The muted second line or trailing hint, when there is one. */
  detail?: (item: Item, ctx: VerbContext) => string | undefined;
  eligible: (item: Item, ctx: VerbContext) => boolean;
  /**
   * Performs the verb. Callers re-read the item from the store before calling
   * and re-check `eligible` — the row may have been painted from a snapshot.
   * `reschedule` takes the target day as `arg`; nothing else takes one.
   */
  run: (item: Item, ctx: VerbContext, arg?: string) => void;
}

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

const planner = () => usePlannerStore.getState();

/** The two store actions a tick can reach, read at click time. */
function toggleActions() {
  const { toggleTaskStatus, toggleHabitStatus } = planner();
  return { toggleTaskStatus, toggleHabitStatus };
}

/* ── the verbs ─────────────────────────────────────────────────────────── */

/**
 * COMPLETE — one-directional: done on the day, never undone. The palette's
 * verb, where "complete" must not quietly un-complete a row it was offered.
 * A counted habit is filled to its target in one go, as it always was here.
 */
const complete: ItemVerb = {
  id: 'complete',
  label: () => 'Complete',
  eligible: (item, ctx) =>
    !isDoneOn(item, ctx.dateStr) && !isCancelled(item) && !absent(item, ctx),
  run: (item, ctx) =>
    isHabit(item)
      ? planner().toggleHabitStatus(item.id, 'done', undefined, ctx.date)
      : // A one-off carries a scalar status and no per-date dimension, so it
        // is not handed a date the store would resolve and then ignore.
        planner().toggleTaskStatus(item.id, 'completed', isRecurring(item) ? ctx.date : undefined),
};

/**
 * TICK — the row checkbox's meaning (lib/item-toggle.ts): toggles, steps a
 * counted habit one at a time, and on a SKIPPED day is not offered at all —
 * that day's answer is `unskip`. A recurring item is ticked only on a day it
 * falls on; ticking a weekday habit on a Saturday would write an off-schedule
 * completion and bump its streak.
 */
const tick: ItemVerb = {
  id: 'tick',
  label: (item, ctx) => {
    const done = isDoneOn(item, ctx.dateStr);
    if (!isRecurring(item as { repeatFrequency?: string })) return done ? 'Mark not done' : 'Mark done';
    if (done) return 'Undo today';
    const target = isHabit(item) ? (item.timesPerDay ?? 1) : 1;
    if (target > 1) {
      const count = ((item as HabitItem).dailyCounts ?? {})[ctx.dateStr] ?? 0;
      return `Count one (${count}/${target})`;
    }
    return 'Done today';
  },
  eligible: (item, ctx) => {
    if (isCancelled(item) || absent(item, ctx)) return false;
    if (!isRecurring(item as { repeatFrequency?: string })) return true;
    return !isSkippedOn(item, ctx.dateStr);
  },
  run: (item, ctx) => {
    const on = { date: ctx.date, dateStr: ctx.dateStr };
    if (!isRecurring(item as { repeatFrequency?: string })) {
      toggleTaskDone(item as unknown as Task, on, toggleActions());
      return;
    }
    toggleRowDone(
      isHabit(item)
        ? { itemType: 'habit', item }
        : { itemType: 'task', item: item as unknown as Task },
      on,
      toggleActions()
    );
  },
};

/** Registry capability, not "is it a habit": any recurring occurrence of a skippable type. */
const skip: ItemVerb = {
  id: 'skip',
  label: () => 'Skip today',
  eligible: (item, ctx) =>
    isSkippable(item) &&
    !isDoneOn(item, ctx.dateStr) &&
    !isSkippedOn(item, ctx.dateStr) &&
    // A caller that knows the day's state offers a skip only on a live one:
    // not on a day the item does not fall on, not on a past open day.
    (ctx.occurrence === undefined || ctx.occurrence === 'due'),
  run: (item, ctx) => planner().setItemSkipped(item.id, true, ctx.date),
};

/**
 * The skipped day's own answer, NOT a tick: ticking a skipped day wrote
 * skipped-AND-completed on a task and a count step on a counted habit
 * (lib/item-toggle.ts toggleRowDone refuses it for that reason).
 */
const unskip: ItemVerb = {
  id: 'unskip',
  label: () => 'Unskip today',
  eligible: (item, ctx) => isSkippedOn(item, ctx.dateStr) && !absent(item, ctx),
  run: (item, ctx) => planner().setItemSkipped(item.id, false, ctx.date),
};

/**
 * Pause and Resume read WALL-CLOCK today, never the day being acted on:
 * pausing is dateless (plan decision 3), and keyed on the browsed day the two
 * would trade places as the user walked the week past a resume boundary.
 * Not AND-ed with recurrence — the registry deliberately lets a one-off pause.
 */
const pause: ItemVerb = {
  id: 'pause',
  label: () => 'Pause',
  eligible: (item, ctx) => isPausable(item) && !isPausedOn(item, ctx.todayStr, ctx.tz),
  run: (item) => planner().setItemPaused(item.id, true),
};

const resume: ItemVerb = {
  id: 'resume',
  label: () => 'Resume',
  eligible: (item, ctx) => isPausedOn(item, ctx.todayStr, ctx.tz),
  run: (item) => planner().setItemPaused(item.id, false),
};

/**
 * NEXT DAY — the carry. lib/row-moves.ts decides who may take it: never a
 * recurring item (its date is the series anchor, and there is no per-occurrence
 * override), a habit, finished work or a task inside a project block. Only a
 * DATED item: an undated one has no day to be put off from, so its verb is
 * `reschedule`. Lands on the day after the later of its own day and today, so
 * an overdue carry never lands in the past.
 */
function nextDayOf(item: Item, ctx: VerbContext): string {
  return nextDayTarget(rowDateOf(item, ctx), ctx.todayStr);
}

const nextDay: ItemVerb = {
  id: 'nextDay',
  label: (item, ctx) => nextDayLabel(nextDayOf(item, ctx), ctx.todayStr),
  detail: (item, ctx) => formatTargetDay(nextDayOf(item, ctx)),
  eligible: (item, ctx) =>
    isTaskLike(item) && !!item.startDate && canMoveToNextDay(item, kindOf(item), rowDateOf(item, ctx)),
  run: (item, ctx) => planner().moveTaskToDate(item.id, nextDayOf(item, ctx)),
};

/**
 * The carry's gate with the day left open, so an undated item may take it too,
 * and a recurring task: its picked day becomes the series start.
 */
const reschedule: ItemVerb = {
  id: 'reschedule',
  label: (item) => (isTaskLike(item) && item.startDate ? 'Reschedule' : 'Schedule'),
  eligible: (item, ctx) => isTaskLike(item) && canReschedule(item, kindOf(item), rowDateOf(item, ctx)),
  run: (item, _ctx, dateStr) => {
    if (dateStr) planner().moveTaskToDate(item.id, dateStr);
  },
};

/** Milestones never: unscheduling erases the target date. */
const braindump: ItemVerb = {
  id: 'braindump',
  label: () => 'Move to Braindump',
  eligible: (item, ctx) =>
    isTaskLike(item) &&
    !!item.startDate &&
    canSendToBraindump(item, kindOf(item), rowDateOf(item, ctx), ctx.milestoneIds),
  run: (item) => planner().unscheduleTask(item.id),
};

const resetStreak: ItemVerb = {
  id: 'resetStreak',
  label: () => 'Reset streak',
  eligible: (item) => isHabit(item) && item.streak > 0 && streaksEnabled(),
  run: (item) => planner().resetHabitStreak(item.id),
};

/**
 * Task-like, matching the verb: moveTaskOutOfProjectBlock resolves against
 * findTaskLike, so a custom item that got into a block can get out of one.
 */
const leaveProjectBlock: ItemVerb = {
  id: 'leaveProjectBlock',
  label: () => 'Move out of project block',
  eligible: (item) => isTaskLike(item) && !!item.inProjectBlock,
  run: (item) => planner().moveTaskOutOfProjectBlock(item.id),
};

/**
 * Confirmed, not immediate. Every other verb is a single undo away; this one
 * destroys a habit's whole history with it, so it goes through the same prompt
 * the item dialog uses, with that type's copy. Always eligible — you can
 * delete anything, including something already finished.
 */
const del: ItemVerb = {
  id: 'delete',
  label: () => 'Delete',
  eligible: () => true,
  run: (item) => {
    const config = getItemTypeConfig(itemTypeName(item));
    useUIStore.getState().confirm({
      title: `Delete ${config.label.toLowerCase()}?`,
      description: config.form.deleteDescription(item.title),
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: () => (isHabit(item) ? planner().deleteHabit(item.id) : planner().deleteTask(item.id)),
    });
  },
};

export const ITEM_VERBS: Readonly<Record<VerbId, ItemVerb>> = {
  complete,
  tick,
  skip,
  unskip,
  pause,
  resume,
  nextDay,
  reschedule,
  braindump,
  resetStreak,
  leaveProjectBlock,
  delete: del,
};

/** Every verb that may act on this item on this day, in declaration order. */
export function eligibleVerbs(item: Item, ctx: VerbContext): ItemVerb[] {
  return Object.values(ITEM_VERBS).filter((verb) => verb.eligible(item, ctx));
}
