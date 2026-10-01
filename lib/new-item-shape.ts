import { firstRepeatDayFrom } from './recurrence';
import type { GoalRole, Item, TimeBucket } from './planner-types';

/**
 * WHEN a member typed into a create form happens — chosen on its row before
 * the container exists, so the form's charts can draw it and the item is born
 * with that timing instead of a guessed one fixed up afterwards.
 *
 * One model for every create form. What each form OFFERS is narrower
 * (`whenOptions`): a routine's items are habits, which always repeat; a
 * milestone is one-shot by definition (a repeating item never finishes); a
 * check-in is a cadence by definition. A plain member may be either.
 */
export type RepeatWhen = 'daily' | 'weekdays' | 'weekends' | 'custom' | 'monthly';

export type NewItemWhen =
  /** A one-off. Undated lands it in the braindump; a date puts it on that day. */
  | { kind: 'once'; date?: string }
  | { kind: 'repeat'; frequency: RepeatWhen; days?: number[]; monthDay?: number };

/** Which create form, and which of its lists, a new row was typed into. */
export type NewItemContext = { container: 'routine' | 'season' | 'goal'; role: 'items' | GoalRole };

export function whenOptions({ container, role }: NewItemContext): { once: boolean; repeat: boolean } {
  if (container === 'routine') return { once: false, repeat: true };
  if (role === 'milestone') return { once: true, repeat: false };
  if (role === 'checkin') return { once: false, repeat: true };
  return { once: true, repeat: true };
}

/**
 * The seeded answer, the same one the create forms have always given: a
 * routine's item is a daily habit, a check-in is weekly on Sundays, and
 * anything one-shot is undated (a checkpoint's date is a commitment nobody
 * should guess — lib/goals.ts newMemberTaskShape).
 */
export function defaultWhen(ctx: NewItemContext): NewItemWhen {
  if (ctx.container === 'routine') return { kind: 'repeat', frequency: 'daily' };
  if (ctx.role === 'checkin') return { kind: 'repeat', frequency: 'custom', days: [0] };
  return { kind: 'once' };
}

export interface NewItemPayload {
  itemType: 'habit' | 'task';
  /** What addHabit / addTask receive. */
  data: Record<string, unknown>;
}

/**
 * The add call a new row becomes. Shared by the create (createFromDraft) and
 * the preview (previewItem), so the chart draws exactly the row that will be
 * written.
 *
 * The date rules are the goal pane's, learned the hard way (see createCheckin
 * and createMilestone in organize/sections/goals.tsx):
 * - an UNDATED one-off carries no bucket — a bucket without a date shows on no
 *   day column AND keeps it out of the braindump, so it is visible nowhere;
 * - a recurring TASK needs a start date, or deriveDayItems shows it on no day —
 *   anchored at its first occurrence from today, never before;
 * - habits are date-blind, so they take no anchor.
 */
export function newItemPayload(
  ctx: NewItemContext,
  title: string,
  when: NewItemWhen,
  bucket: TimeBucket,
  todayStr: string,
): NewItemPayload {
  const base = { title, completedDates: [] as string[], skippedDates: [] as string[] };
  const rule =
    when.kind === 'repeat'
      ? {
          repeatFrequency: when.frequency,
          repeatDays: when.frequency === 'custom' ? [...(when.days ?? [])].sort((a, b) => a - b) : undefined,
          repeatMonthDay: when.frequency === 'monthly' ? when.monthDay : undefined,
        }
      : undefined;

  if (ctx.container === 'routine') {
    // A routine is a run of habits. Unfiled, like a new task: a habit's
    // project is optional (Kirby, 2026-10-01).
    return {
      itemType: 'habit',
      data: { ...base, timeBucket: bucket, ...(rule ?? { repeatFrequency: 'daily' }) },
    };
  }
  if (rule) {
    return {
      itemType: 'task',
      data: { ...base, ...rule, timeBucket: bucket, startDate: firstRepeatDayFrom(rule, todayStr) },
    };
  }
  if (when.kind === 'once' && when.date) {
    return { itemType: 'task', data: { ...base, startDate: when.date, timeBucket: bucket } };
  }
  return { itemType: 'task', data: base };
}

/**
 * The row as the store WOULD hold it — enough of an Item for the schedule to
 * draw. Never written anywhere; its id is the draft row's key.
 */
export function previewItem(id: string, payload: NewItemPayload): Item {
  const d = payload.data as Record<string, unknown>;
  if (payload.itemType === 'habit') {
    return {
      ...d,
      id,
      type: 'habit',
      status: 'pending',
      streak: 0,
      dailyCounts: {},
      currentDayCount: 0,
    } as unknown as Item;
  }
  return {
    ...d,
    id,
    type: 'task',
    status: 'pending',
    isScheduled: !!d.timeBucket,
  } as unknown as Item;
}
