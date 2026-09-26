import type { Goal, HabitItem, Item, Program, Project, Routine, Task } from './planner-types';
import { deriveDayItems, flattenDayRows } from './day-items';
import { inactiveItemIdsOn } from './active';
import { isCompletedOnDate, isRecurring, isSkippedOnDate } from './recurrence';
import { sameContainerName } from './container-registry';
import { getItemTypeConfig, itemTypeName } from './item-registry';

/**
 * WHERE A CONTAINER'S ITEMS LAND — the data behind every schedule chart (the
 * rhythm grid, the season heatmap, the goal timeline and bar graph).
 *
 * Nothing here re-derives "does this want doing" (CLAUDE.md). Each day is the
 * GRID's answer for that day — `deriveDayItems`, fed `inactiveItemIdsOn` for the
 * same date, exactly as hooks/use-day-items.ts builds a column — narrowed to the
 * container's members. So a task the grid drops (no bucket, a recurring task
 * before its anchor) is absent here too, and a paused routine's members vanish
 * from the chart on the days they vanish from the planner.
 *
 * Where it knowingly differs from a grid column, because a chart is not a view:
 * completed one-offs always show (the grid honours showCompletedTasks), the
 * canvas filters and "show paused on grid" are ignored, and a task inside a
 * project block is counted on its date whether or not the block lands there
 * (day-schedule.tsx only draws it inside a block).
 *
 * WHAT THE PAST CAN AND CANNOT SAY. The app stores no creation date for items
 * and no dates on memberships, keeps one pause interval per routine or item,
 * and loads completions for a bounded window (lib/completion-window.ts). So a
 * past day's "it was due and not done" is not knowable — a habit shows on days
 * before it existed, and a member added today reads as the container's whole
 * history. The only honest past states are what was RECORDED: `done` and
 * `skipped`. Everything else in the past is `open`, which the charts draw as a
 * faint wash (the habit heatmap's convention), never as "missed" — the
 * guilt-free law (lib/collections.ts) forbids a warning mark in any case.
 */

export type OccurrenceState = 'done' | 'skipped' | 'due' | 'open';

export interface Occurrence {
  itemId: string;
  date: string;
  /**
   * `done`/`skipped`: recorded on that date. `due`: today or later, not yet
   * marked. `open`: an earlier day with nothing recorded — NOT a claim that it
   * was missed (see above).
   */
  state: OccurrenceState;
  /** A one-off (non-recurring) item — the charts draw it as a diamond. */
  once: boolean;
}

export interface ScheduleDay {
  date: string;
  occurrences: Occurrence[];
  /** A project's recurring time block, when the container is that project. */
  block?: Project;
}

export interface ContainerSchedule {
  days: ScheduleDay[];
  /** Members with no date at all — one-off work waiting in the braindump. */
  unscheduled: Item[];
}

export interface ScheduleSource {
  items: readonly Item[];
  tasks: readonly Task[];
  habits: readonly HabitItem[];
  routines: readonly Routine[];
  programs: readonly Program[];
  timezone: string;
}

/* ── calendar arithmetic on yyyy-MM-dd, zone-free ─────────────────────── */

const parts = (d: string) => d.split('-').map(Number) as [number, number, number];
const fmt = (dt: Date) =>
  `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;

/** `date` plus `n` calendar days. Built on Date.UTC so no process zone can move it. */
export function addDaysStr(date: string, n: number): string {
  const [y, m, d] = parts(date);
  return fmt(new Date(Date.UTC(y, m - 1, d + n)));
}

/** 0 = Sunday … 6 = Saturday, for the calendar date itself. */
export function weekdayOf(date: string): number {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export type WeekStartDay = 'sunday' | 'monday' | 'saturday';

/** The first day of `date`'s week, per the user's Week starts on setting. */
export function weekStartOf(date: string, weekStartDay: WeekStartDay): string {
  const first = weekStartDay === 'monday' ? 1 : weekStartDay === 'saturday' ? 6 : 0;
  return addDaysStr(date, -((weekdayOf(date) - first + 7) % 7));
}

/** Whole days from `a` to `b` (b − a). */
export function daysBetween(a: string, b: string): number {
  const [ya, ma, da] = parts(a);
  const [yb, mb, db] = parts(b);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86_400_000);
}

/**
 * The longest range a chart may ask for. Past ~400 days the completion window
 * has nothing to say about the past, and deriving each day costs a resolver
 * pass over every item — a multi-year goal's "whole window" is capped, and the
 * chart says so.
 */
export const MAX_SCHEDULE_DAYS = 400;

/* ── who is in a container ─────────────────────────────────────────────── */

export type ScheduleContainer =
  | { kind: 'routine'; routine: Routine }
  | { kind: 'program'; program: Program }
  | { kind: 'goal'; goal: Goal }
  | { kind: 'project'; project: Project };

/**
 * The item ids a container answers for. A program counts its routines' members
 * too — they ride along when it is on, so they land on its calendar. A project
 * holds items BY NAME (items.project), folded as every project lookup is.
 */
export function containerMemberIds(
  c: ScheduleContainer,
  items: readonly Item[],
  routines: readonly Routine[],
): string[] {
  switch (c.kind) {
    case 'routine':
      return c.routine.itemIds;
    case 'program': {
      const ids = new Set(c.program.itemIds);
      for (const rid of c.program.routineIds) {
        const r = routines.find((x) => x.id === rid);
        r?.itemIds.forEach((id) => ids.add(id));
      }
      return [...ids];
    }
    case 'goal':
      return [...c.goal.milestoneIds, ...c.goal.checkinIds, ...c.goal.memberIds];
    case 'project':
      return items
        .filter((i) => {
          const name = (i as { project?: string }).project;
          return !!name && sameContainerName('project', name, c.project.name);
        })
        .map((i) => i.id);
  }
}

/* ── the derivation ────────────────────────────────────────────────────── */

function stateOn(item: Task | HabitItem, date: string, todayStr: string): OccurrenceState {
  if (isRecurring(item)) {
    // Per-date, never scalar status. A counted habit writes its date here only
    // on reaching its target, so a partial day honestly reads as not done.
    if (isCompletedOnDate(item, date)) return 'done';
    if (isSkippedOnDate(item, date)) return 'skipped';
  } else {
    // The registry's done word, not a literal — a custom type brings its own.
    const status = (item as { status?: string }).status;
    if (status === getItemTypeConfig(itemTypeName(item as unknown as Item)).doneStatus) return 'done';
    // Cancelled still renders on the grid, but it is a recorded decision, not
    // work: it must not count as due.
    if (status === 'cancelled') return 'skipped';
  }
  return date >= todayStr ? 'due' : 'open';
}

/**
 * Every day from `from` for `days` days, as the grid would draw it, narrowed to
 * `memberIds`. `routines`/`programs` may include a DRAFT container the store has
 * not seen yet (the create modal's preview) — activation is resolved against
 * exactly what is passed.
 */
export function deriveContainerSchedule({
  memberIds,
  source,
  from,
  days,
  todayStr,
  block,
}: {
  memberIds: readonly string[];
  /* `todayStr` below must be the USER's today (lib/collections.ts useToday). */
  source: ScheduleSource;
  from: string;
  days: number;
  todayStr: string;
  /** A project container: its time block rides along on the days it lands. */
  block?: Project;
}): ContainerSchedule {
  const members = new Set(memberIds);
  const n = Math.max(0, Math.min(days, MAX_SCHEDULE_DAYS));
  // Only members are asked about; the full item list is still what activation
  // resolves against, because a member's paths run through other containers.
  const tasks = source.tasks.filter((t) => members.has(t.id));
  const habits = source.habits.filter((h) => members.has(h.id));
  const ctx = { userTimezone: source.timezone, routines: source.routines, programs: source.programs };
  // Activation is resolved for the MEMBERS only: paths come from the routine
  // and program lists, and the item list only drives the final pass, so this is
  // the same answer for a fraction of the work on every one of up to 400 days.
  const memberItems = source.items.filter((i) => members.has(i.id));

  const out: ScheduleDay[] = [];
  for (let i = 0; i < n; i += 1) {
    const date = addDaysStr(from, i);
    const day = deriveDayItems({
      tasks: tasks as Task[],
      habits: habits as HabitItem[],
      projects: block ? [block] : [],
      dateStr: date,
      timezone: source.timezone,
      typeFilter: 'all',
      // A finished one-off still happened on its day.
      showCompletedTasks: true,
      inactiveItemIds: inactiveItemIdsOn(memberItems, date, ctx),
    });
    out.push({
      date,
      occurrences: flattenDayRows(day).map(({ item }) => ({
        itemId: item.id,
        date,
        state: stateOn(item, date, todayStr),
        once: !isRecurring(item),
      })),
      block: day.recurringProjects[0],
    });
  }

  // The braindump's own rule (components/sidebar/braindump.tsx): an open task
  // with no bucket and not scheduled. From the TASKS projection, so subtasks
  // (which carry a project but no scheduling) never appear; and not while held
  // off today, which the braindump hides too.
  const heldToday = inactiveItemIdsOn(memberItems, todayStr, ctx);
  const unscheduled = tasks.filter(
    (t) =>
      !t.isScheduled &&
      !t.timeBucket &&
      !isRecurring(t) &&
      // Still open, by the type's own vocabulary — a custom type's open
      // status need not be 'pending'.
      t.status !== getItemTypeConfig(itemTypeName(t as unknown as Item)).doneStatus &&
      t.status !== 'cancelled' &&
      !heldToday.has(t.id),
  ) as unknown as Item[];

  return { days: out, unscheduled };
}

/**
 * Occurrences grouped per member — the rhythm grid's rows. Seeded from
 * `memberIds` when given, so the map iterates in the container's own order and
 * a member with nothing in range still has an (empty) row.
 */
export function occurrencesByItem(
  schedule: ContainerSchedule,
  memberIds?: readonly string[],
): Map<string, Map<string, Occurrence>> {
  const byItem = new Map<string, Map<string, Occurrence>>();
  memberIds?.forEach((id) => byItem.set(id, new Map()));
  for (const day of schedule.days) {
    for (const o of day.occurrences) {
      let row = byItem.get(o.itemId);
      if (!row) byItem.set(o.itemId, (row = new Map()));
      row.set(o.date, o);
    }
  }
  return byItem;
}

export interface WeekBucket {
  /** First day of the week. */
  start: string;
  done: number;
  /** today-or-later, not yet marked */
  due: number;
  /** earlier, nothing recorded — never read as "missed" */
  open: number;
  skipped: number;
  /** one-off items (deadlines, milestones) landing this week */
  once: Occurrence[];
}

/** Per-week totals — the bar graph's bars and the heatmap's columns. */
export function weekBuckets(schedule: ContainerSchedule, weekStartDay: WeekStartDay): WeekBucket[] {
  const weeks: WeekBucket[] = [];
  let current: WeekBucket | null = null;
  for (const day of schedule.days) {
    const start = weekStartOf(day.date, weekStartDay);
    if (!current || current.start !== start) {
      current = { start, done: 0, due: 0, open: 0, skipped: 0, once: [] };
      weeks.push(current);
    }
    for (const o of day.occurrences) {
      current[o.state] += 1;
      if (o.once) current.once.push(o);
    }
  }
  return weeks;
}
