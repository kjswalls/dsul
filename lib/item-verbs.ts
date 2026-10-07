import { usePlannerStore } from './planner-store';
import { useUIStore } from './ui-store';
import { streaksEnabled } from './extension-gates';
import { getItemTypeConfig, itemTypeName } from './item-registry';
import { toggleRowDone, toggleTaskDone } from './item-toggle';
import { isRecurring } from './recurrence';
import { formatTargetDay, nextDayLabel } from './row-moves';
import {
  isDoneOn,
  isHabit,
  isTaskLike,
  nextDayOf,
  VERB_GATES,
  type VerbContext,
  type VerbId,
} from './verb-gates';
import type { HabitItem, Item, Task } from './planner-types';

// The pure half lives in lib/verb-gates.ts (server code asks the same gates);
// every name ItemVerbs.swift cites still exports from here.
export {
  drawnState,
  isCancelled,
  isDoneOn,
  isHabit,
  isSkippedOn,
  isTaskLike,
  nextDayOf,
  occurrenceOn,
  VERB_GATES,
  type GatedVerbId,
  type VerbContext,
  type VerbId,
} from './verb-gates';

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
  eligible: VERB_GATES.complete,
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
  eligible: VERB_GATES.tick,
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
  eligible: VERB_GATES.skip,
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
  eligible: VERB_GATES.unskip,
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
  eligible: VERB_GATES.pause,
  run: (item) => planner().setItemPaused(item.id, true),
};

const resume: ItemVerb = {
  id: 'resume',
  label: () => 'Resume',
  eligible: VERB_GATES.resume,
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

const nextDay: ItemVerb = {
  id: 'nextDay',
  label: (item, ctx) => nextDayLabel(nextDayOf(item, ctx), ctx.todayStr),
  detail: (item, ctx) => formatTargetDay(nextDayOf(item, ctx)),
  eligible: VERB_GATES.nextDay,
  run: (item, ctx) => planner().moveTaskToDate(item.id, nextDayOf(item, ctx)),
};

/**
 * The carry's gate with the day left open, so an undated item may take it too,
 * and a recurring task: its picked day becomes the series start.
 */
const reschedule: ItemVerb = {
  id: 'reschedule',
  label: (item) => (isTaskLike(item) && item.startDate ? 'Reschedule' : 'Schedule'),
  eligible: VERB_GATES.reschedule,
  run: (item, _ctx, dateStr) => {
    if (dateStr) planner().moveTaskToDate(item.id, dateStr);
  },
};

/** Milestones never: unscheduling erases the target date. */
const braindump: ItemVerb = {
  id: 'braindump',
  label: () => 'Move to Braindump',
  eligible: VERB_GATES.braindump,
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
  eligible: VERB_GATES.leaveProjectBlock,
  run: (item) => planner().moveTaskOutOfProjectBlock(item.id),
};

/**
 * The delete prompt's title, "Delete task?", in the type's own noun. Exported
 * so the iPhone's confirm is pinned to it (tests/fixtures/day/caps.json).
 */
export function deleteConfirmTitle(label: string): string {
  return `Delete ${label.toLowerCase()}?`;
}

/**
 * Confirmed, not immediate. Every other verb is a single undo away; this one
 * takes a habit's whole history to the Trash with it, so it goes through the
 * same prompt the item dialog uses, with that type's copy. Always eligible —
 * you can delete anything, including something already finished.
 */
const del: ItemVerb = {
  id: 'delete',
  label: () => 'Delete',
  eligible: () => true,
  run: (item) => {
    const config = getItemTypeConfig(itemTypeName(item));
    useUIStore.getState().confirm({
      title: deleteConfirmTitle(config.label),
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
