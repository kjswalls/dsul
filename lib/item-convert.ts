/**
 * Changing an existing item's type — habit → task, task → a custom type, and
 * back.
 *
 * The two shapes do not line up field for field (a habit has a streak and a
 * per-day count, a task has a date anchor, an order and subtasks), so this is
 * where the translation lives, asked once so the edit pane, the store action
 * and undo all agree. What CAN travel, travels: title, notes, time, length,
 * repeat, the project, pause and reminder state, and the per-date history
 * (`completedDates` / `skippedDates` are the same columns for every type).
 *
 * Every rule below answers to a registry capability, not to a type name, so a
 * custom type gets the same treatment as the built-ins (CLAUDE.md, "the type
 * registry is the extension point").
 *
 * Refused outright (`conversionBlock`), because each would leave the item
 * somewhere no view can reach or break a rule another feature relies on:
 * - it has subtasks, or is one, and the target type has no subtasks;
 * - it is a goal milestone and the target type can't be one;
 * - it sits inside a project block, and the target type can't be ordered into
 *   one (habits);
 * - it is assigned to Beacon and the target type can't be.
 */
import { getItemTypeConfig, itemTypeName } from '@/lib/item-registry';
import { firstRepeatDayFrom, isRecurring } from '@/lib/recurrence';
import type { HabitItem, Item, RepeatFrequency } from '@/lib/planner-types';

/** The repeats a switch into a repeat-only type can pick from without asking for days. */
export const CONVERT_REPEAT_CHOICES = ['daily', 'weekdays', 'weekends'] as const;
export type ConvertRepeat = (typeof CONVERT_REPEAT_CHOICES)[number];

export interface ConvertContext {
  /** Every item, for the subtask check. */
  items: readonly Item[];
  /** Goal milestone item ids (lib/goals.ts milestoneItemIds). */
  milestoneIds: ReadonlySet<string>;
}

const isHabitType = (typeName: string) => typeName === 'habit';

/** Does the target type refuse a one-off item (every allowed repeat is a real repeat)? */
function repeatOnly(typeName: string): boolean {
  return !getItemTypeConfig(typeName).allowedFrequencies.includes('none');
}

/** Why this item can't become `toType`, in words for the menu, or null when it can. */
export function conversionBlock(item: Item, toType: string, ctx: ConvertContext): string | null {
  const to = getItemTypeConfig(toType);
  const parent = (item as { parentItemId?: string }).parentItemId;
  if (!to.subtasks) {
    if (parent) return 'It’s a subtask';
    if (ctx.items.some((i) => (i as { parentItemId?: string }).parentItemId === item.id && i.id !== item.id)) {
      return 'It has subtasks';
    }
  }
  if (!to.milestoneEligible && ctx.milestoneIds.has(item.id)) return 'It’s a goal milestone';
  if (!to.orderable && (item as { inProjectBlock?: boolean }).inProjectBlock) return 'It’s in a project block';
  if (!to.agentAssignable && (item as { assignee?: string }).assignee) return 'It’s assigned to Beacon';
  return null;
}

export interface ConversionSummary {
  /** What stops existing on the item, in plain words. */
  drops: string[];
  /** What changes shape without being lost. */
  changes: string[];
  /** True when the target needs a repeat and the item has none (the confirm asks). */
  needsRepeat: boolean;
}

/**
 * What switching `item` to `toType` does, for the menu line and the confirm.
 * A summary with nothing in it switches without asking.
 */
export function summarizeConversion(item: Item, toType: string): ConversionSummary {
  const fromConfig = getItemTypeConfig(itemTypeName(item));
  const to = getItemTypeConfig(toType);
  const drops: string[] = [];
  const changes: string[] = [];

  if (item.type === 'habit') {
    if (fromConfig.counters.streak && !to.counters.streak) {
      drops.push(item.streak === 1 ? 'The 1 day streak' : `The ${item.streak} day streak`);
    }
    if (item.timesPerDay && item.timesPerDay > 1 && !to.counters.dailyCounts) {
      drops.push(`The ${item.timesPerDay}× a day target`);
    }
  } else {
    const task = item;
    if (task.priority && isHabitType(toType)) drops.push('Its priority');
    if (!isRecurring(task) && task.startDate && isHabitType(toType)) {
      changes.push('It stops being tied to one date and follows its repeat');
    }
    if (!task.project && to.containerRequired && to.orphanContainerFallback) {
      changes.push(`It goes in ${to.orphanContainerFallback}`);
    }
  }

  const needsRepeat = repeatOnly(toType) && !isRecurring(item);
  return { drops, changes, needsRepeat };
}

/** One short line for the type menu: what the switch keeps or costs. */
export function conversionHint(item: Item, toType: string): string {
  const s = summarizeConversion(item, toType);
  if (s.drops.length > 0) return `Drops ${lowerFirst(s.drops.join(' and '))}`;
  if (s.needsRepeat) return 'Asks how often it repeats';
  if (s.changes.length > 0) return s.changes[0];
  return 'Keeps everything';
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * The scalar status the switched item carries. Only a one-off task-like item
 * ever reads it; a recurring one keeps its state per date (CLAUDE.md), and its
 * scalar can still hold whatever the last toggle wrote — a habit ticked today
 * holds 'done'. Carried across a switch into a recurring item, that stale
 * value would become a permanent 'completed' on the whole series. So: task-like
 * to task-like keeps the status (same vocabulary), everything else starts over
 * at 'pending'.
 */
function switchedStatus(item: Item, toHabit: boolean): string {
  if (!toHabit && item.type !== 'habit') return item.status;
  return 'pending';
}

export interface ConvertOptions {
  /** YYYY-MM-DD in the user's timezone. */
  todayStr: string;
  /**
   * The latest a switch into a dated type may anchor its series: the first day
   * of the week on screen. A habit has no start, so it shows on every matching
   * day; anchored at today, a Thursday habit switched on a Friday vanished from
   * that week's Thursday column. Defaults to `todayStr`.
   */
  anchorFloor?: string;
  /** The repeat a one-off item picks up when the target type requires one. */
  repeat?: ConvertRepeat;
  /** A container id for a name, from the store's in-memory list. */
  projectIdFor?: (name: string) => string | undefined;
  /** `order` for a switch into an orderable type (the end of the list). */
  nextOrder?: number;
}

/**
 * The item as `toType`. Pure; the caller checks `conversionBlock` first.
 *
 * Into a habit: streak starts at 0, the per-day count is empty, and a one-off
 * gets `opts.repeat` (default: the type's own default repeat). A missing
 * project falls back to the type's orphan container, as a habit made anywhere
 * else would.
 *
 * Into a task-like type from a habit: the repeat becomes the series and needs
 * an anchor, so `startDate` is the earliest day it was ever checked off or
 * skipped, or its first repeat day from the start of this week (`anchorFloor`) —
 * every day it already has history for, and every day of the week you're
 * looking at, keeps showing it.
 * It lands on the grid (`isScheduled`) in its own time bucket, `anytime` if it
 * had none, since the day views only bucket tasks that carry one.
 */
export function convertItem(item: Item, toType: string, opts: ConvertOptions): Item {
  const to = getItemTypeConfig(toType);
  const envelope = toType === 'task' || toType === 'habit'
    ? ({ type: toType } as const)
    : ({ type: 'custom', customType: toType } as const);

  const shared = {
    id: item.id,
    title: item.title,
    notes: item.notes,
    timeBucket: item.timeBucket,
    startTime: item.startTime,
    duration: item.duration,
    repeatDays: item.repeatDays,
    repeatMonthDay: item.repeatMonthDay,
    completedDates: item.completedDates ?? [],
    skippedDates: item.skippedDates ?? [],
    pausedAt: item.pausedAt,
    pausedUntil: item.pausedUntil,
    reminderTime: item.reminderTime,
    reminderAnchor: item.reminderAnchor,
  };

  if (isHabitType(toType)) {
    const recurring = isRecurring(item);
    const repeatFrequency: RepeatFrequency = recurring
      ? (item.repeatFrequency as RepeatFrequency)
      : (opts.repeat ?? (to.defaultFrequency as RepeatFrequency));
    const project = item.project || to.orphanContainerFallback || '';
    const habit: HabitItem = {
      ...shared,
      type: 'habit',
      project,
      projectId: item.project ? item.projectId : opts.projectIdFor?.(project),
      streak: 0,
      status: switchedStatus(item, true) as HabitItem['status'],
      dailyCounts: {},
      repeatFrequency,
      // A one-off picking up a weekly-style repeat has no days of its own.
      ...(recurring ? {} : { repeatDays: undefined, repeatMonthDay: undefined }),
    };
    return habit;
  }

  if (item.type === 'habit') {
    const history = [...(item.completedDates ?? []), ...(item.skippedDates ?? [])].sort();
    const floor = opts.anchorFloor && opts.anchorFloor < opts.todayStr ? opts.anchorFloor : opts.todayStr;
    // A task's start date is itself an occurrence (anchoredSeriesOn), so the
    // floor snaps to the first day the repeat actually falls on: a Thursday
    // habit switched mid-week must not also appear on that Sunday.
    const firstDay = firstRepeatDayFrom(item, floor);
    const anchor = history[0] && history[0] < firstDay ? history[0] : firstDay;
    return {
      ...shared,
      ...envelope,
      project: item.project || undefined,
      projectId: item.project ? item.projectId : undefined,
      status: switchedStatus(item, false),
      repeatFrequency: item.repeatFrequency,
      startDate: anchor,
      timeBucket: item.timeBucket ?? 'anytime',
      isScheduled: true,
      order: opts.nextOrder ?? 0,
    } as Item;
  }

  // Task-like to task-like: the same shape under another name.
  // Drop the old envelope's slug first, or a custom → task switch would carry a
  // stray `customType` on a plain task.
  const { customType: _customType, ...rest } = item as Item & { customType?: string };
  return { ...rest, ...envelope } as Item;
}
