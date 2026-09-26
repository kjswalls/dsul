import type { Task, HabitItem, Project, TimeBucket } from './planner-types';
import { anchoredSeriesOn, shouldShowOnDate, isCompletedOnDate, isSkippedOnDate, isRecurring } from './recurrence';
import { EMPTY_VIEW_FILTERS, passesFilters, type ViewFilters } from './filters';
import { containerRef } from './container-registry';

/**
 * Pure derivation of what a single day shows, per bucket. Extracted from
 * timeline.tsx (P5a) so all six views share one data path
 * (hooks/use-day-items.ts is the store-connected wrapper).
 */

export const BUCKET_ORDER: TimeBucket[] = ['anytime', 'morning', 'afternoon', 'evening'];

/**
 * Canvas filter set (view-store `canvasFilters`). All-empty = no-op.
 *
 * @deprecated Alias of the one shape in lib/filters.ts. Was a fourth
 * independent declaration of the same three fields.
 */
export type DayItemFilters = ViewFilters;

const NO_FILTERS = EMPTY_VIEW_FILTERS;

export interface DayItemsInput {
  tasks: Task[];
  habits: HabitItem[];
  projects: Project[];
  /**
   * yyyy-MM-dd for the selected day (already timezone-resolved).
   *
   * The ONLY thing that says which day this is. There used to be a `date: Date`
   * beside it, used for the project-block weekday and month-day checks — and it
   * answered in the BROWSER's zone while `dateStr` and `shouldShowOnDate` answer
   * in the USER's. When the two differ the same column was Thursday for a task
   * and Wednesday for a block, so a Thursday block rendered on Wednesday. One
   * date in, one weekday out.
   */
  dateStr: string;
  timezone: string;
  typeFilter: 'all' | 'tasks' | 'habits';
  showCompletedTasks: boolean;
  /** Optional canvas filters (priority/container/goal/hide-finished); defaults to none. */
  filters?: DayItemFilters;
  /**
   * Ids suppressed ON THIS DATE — from lib/active.ts `inactiveItemIdsOn`.
   *
   * Resolved per-date by the caller rather than computed here, for two reasons:
   * this module is deliberately store-free and pure, and from Phase 2 resolving
   * one item means walking item → routine → program, which should happen once
   * per rendered day rather than once per item per filter pass.
   *
   * Already the open-loop rule (a suppressed item that WAS marked on this date
   * is absent from the set and keeps rendering), so this is a plain exclusion.
   * Optional so week columns and tests that predate pausing keep working.
   */
  inactiveItemIds?: ReadonlySet<string>;
  /**
   * `filters.goals` RESOLVED to item ids — `goalFilterItemIds` in lib/goals.ts.
   *
   * Threaded rather than derived for the same two reasons `inactiveItemIds` is:
   * this module is store-free and pure, and goal membership lives in a join
   * table the item rows know nothing about. Resolved once per surface in
   * hooks/use-day-items.ts, not once per item per day.
   *
   * Absent means the goal clause is inert, never that it matched nothing — see
   * `passesGoalFilter`. Every week column shares one set because membership is
   * DATELESS; a goal narrows the same items on every day it is on, which is
   * exactly why `inactiveItemIds` is per-column and this is not.
   */
  goalMemberIds?: ReadonlySet<string> | null;
}

export interface DayItems {
  tasksByBucket: Record<TimeBucket, Task[]>;
  habitsByBucket: Record<TimeBucket, HabitItem[]>;
  /** Projects with a recurring time block that lands on this day. */
  recurringProjects: Project[];
  totalCount: number;
}

function emptyBuckets<T>(): Record<TimeBucket, T[]> {
  return { anytime: [], morning: [], afternoon: [], evening: [] };
}

/**
 * One day's buckets as a flat row list — habits first, then tasks, each in
 * BUCKET_ORDER and time order within a bucket.
 *
 * The shape `lib/grouping.ts` and `lib/sort-rows.ts` both take. Habits lead
 * because that is the order every list surface already rendered them in; the
 * grouping and ordering passes are both stable, so this IS the tie-break for
 * everything downstream.
 */
export function flattenDayRows(day: DayItems): { itemType: 'task' | 'habit'; item: Task | HabitItem }[] {
  return [
    ...BUCKET_ORDER.flatMap((b) => day.habitsByBucket[b]).map((h) => ({
      itemType: 'habit' as const,
      item: h,
    })),
    ...BUCKET_ORDER.flatMap((b) => day.tasksByBucket[b]).map((t) => ({
      itemType: 'task' as const,
      item: t,
    })),
  ];
}

function byTimeThenOrder(a: { startTime?: string; order?: number }, b: { startTime?: string; order?: number }): number {
  if (a.startTime && b.startTime) return a.startTime.localeCompare(b.startTime);
  if (a.startTime && !b.startTime) return -1;
  if (!a.startTime && b.startTime) return 1;
  return (a.order ?? 0) - (b.order ?? 0);
}

/**
 * The weekday and calendar day of a yyyy-MM-dd string, read as that calendar
 * date and nothing else.
 *
 * Built through Date.UTC so the process zone cannot move it. `new Date('2026-08-13')`
 * parses as midnight UTC and then reports `getDay()` in local time, which is the
 * previous day anywhere west of Greenwich — the same class of bug this replaces.
 */
function calendarParts(dateStr: string): { weekday: number; dateOfMonth: number; lastDayOfMonth: number } {
  const [y, m, d] = dateStr.split('-').map(Number);
  return {
    weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay(),
    dateOfMonth: d,
    // Day 0 of the NEXT month is the last day of this one.
    lastDayOfMonth: new Date(Date.UTC(y, m, 0)).getUTCDate(),
  };
}

export function deriveDayItems(input: DayItemsInput): DayItems {
  const { tasks, habits, projects, dateStr, timezone, typeFilter, showCompletedTasks } = input;
  const filters = input.filters ?? NO_FILTERS;
  const inactive = input.inactiveItemIds;
  const goalMembers = input.goalMemberIds;
  // hideFinished stacks on the existing showCompletedTasks preference
  const hideDoneTasks = !showCompletedTasks || filters.hideFinished;
  /**
   * Skips hang on the Display toggle ALONE, never on showCompletedTasks.
   *
   * That global's settings copy promises "Tasks only — habits always stay", and
   * a skip is overwhelmingly a habit gesture; folding it in would make a
   * tasks-only setting start hiding habits.
   */
  const hideSkipped = filters.hideFinished;

  // Tasks that belong to this day
  const dayTasks =
    typeFilter === 'habits'
      ? []
      : tasks.filter((task) => {
          if (inactive?.has(task.id)) return false;
          if (hideDoneTasks && task.status === 'completed') return false;
          // One rule for every narrowing axis: priority and container resolve
          // per type through the registry, and the goal clause reads the id set
          // resolved above. An unset priority or project lands in the explicit
          // "None" value rather than being deleted by every filter.
          if (!passesFilters(task, filters, undefined, goalMembers)) return false;
          if (hideSkipped && isSkippedOnDate(task, dateStr)) return false;
          if (!task.startDate) return false;
          // startDate is yyyy-MM-dd; tolerate legacy ISO strings
          const taskStartDateStr = task.startDate.includes('T')
            ? task.startDate.split('T')[0]
            : task.startDate;
          if (isRecurring(task)) {
            if (!anchoredSeriesOn(task, taskStartDateStr, dateStr, timezone)) return false;
            if (hideDoneTasks && isCompletedOnDate(task, dateStr)) return false;
            return true;
          }
          return taskStartDateStr === dateStr;
        });

  // Habits that occur on this day.
  //
  // The wipe that used to sit here — `filters.priorities.length ||
  // filterProjects.length ? [] : …` — is gone. It deleted every habit the
  // moment any priority or project filter was on, because habits carry
  // neither field, so a project filter silently also meant "hide all habits".
  // passesFilters resolves each axis per type instead: a habit is unaffected by
  // priority (it has none) and answers the container axis with its GROUP.
  const dayHabits =
    typeFilter === 'tasks'
      ? []
      : habits.filter((h) => {
          if (inactive?.has(h.id)) return false;
          // 'habit' is passed explicitly rather than re-derived from the row's
          // runtime discriminator: this array IS the habits projection, so the
          // answer is known statically. Deriving it would make the predicate
          // depend on a field the declared Habit type does not carry — any
          // caller building a row without it would silently get task rules,
          // which is a priority filter deleting every habit all over again.
          if (!passesFilters(h, filters, 'habit', goalMembers)) return false;
          if (!shouldShowOnDate(h, dateStr, timezone)) return false;
          if (filters.hideFinished && isCompletedOnDate(h, dateStr)) return false;
          if (hideSkipped && isSkippedOnDate(h, dateStr)) return false;
          return true;
        });

  const tasksByBucket = emptyBuckets<Task>();
  dayTasks
    .filter((t) => t.timeBucket)
    .sort(byTimeThenOrder)
    .forEach((t) => tasksByBucket[t.timeBucket as TimeBucket].push(t));

  const habitsByBucket = emptyBuckets<HabitItem>();
  dayHabits
    .filter((h) => h.timeBucket)
    // The same comparator as tasks. It used to be
    // `a.startTime && b.startTime ? compare : 0`, which returns 0 the moment
    // EITHER side lacks a time — and most habits have none. A comparator that
    // answers 0 for every pair involving an untimed row is not a weak ordering:
    // it left those rows wherever the filter happened to emit them, so a 9am
    // habit could render BELOW an untimed one.
    //
    // What this fixes is exactly that: timed rows now lead, in time order. The
    // `order` tail is inert for habits — habitShape has no `order`
    // (packages/types/src/schemas.ts:206), itemFromRow's habit branch never
    // reads one, and the registry says `orderable: false` (item-registry.ts:319)
    // — so two untimed habits still compare equal. That is fine and deliberate:
    // the sort is stable and dbListItems loads `ORDER BY "order", created_at`,
    // so they hold their creation order rather than drifting.
    .sort(byTimeThenOrder)
    .forEach((h) => habitsByBucket[h.timeBucket as TimeBucket].push(h));

  // Projects with recurring time blocks that land on this day.
  //
  // A block is a fourth row kind that no filter used to touch, and the artefact
  // was visible: filter to one project and the OTHER projects' blocks stayed on
  // the grid, now empty. It is a project, so the container axis applies to it —
  // and the goal axis reaches it too, for the opposite reason. It has no
  // priority and no completion, and its position is its time, so priority and
  // hideFinished leave it alone.
  //
  // A GOAL clause drops EVERY block, and that is not the container rule with a
  // different list. A block is a `projects` row, never an item, so it holds no
  // id `goal_items` could ever name — asking "is this block in the goal" has
  // one answer for all of them, and it is no. Keeping them reproduces the exact
  // artefact the paragraph above says was fixed: a narrowed grid under a full
  // set of empty blocks. Only a RESOLVABLE clause does this — `goalMembers` is
  // absent when the selection names no live goal, which is the documented
  // "inert, never empty" state, and an inert clause must narrow nothing at all.
  const containerFilter = filters.containers;
  const goalFilterBites = filters.goals.length > 0 && !!goalMembers;
  const { weekday, dateOfMonth, lastDayOfMonth } = calendarParts(dateStr);
  const recurringProjects = projects.filter((p) => {
    if (goalFilterBites) return false;
    if (containerFilter.length && !containerFilter.includes(containerRef('project', p.name)))
      return false;
    if (!p.startTime || !p.timeBucket || !p.repeatFrequency) return false;
    switch (p.repeatFrequency) {
      case 'daily':
        return true;
      case 'weekdays':
        return weekday >= 1 && weekday <= 5;
      case 'weekends':
        return weekday === 0 || weekday === 6;
      case 'monthly': {
        const targetDay = p.repeatMonthDay || 1;
        return dateOfMonth === Math.min(targetDay, lastDayOfMonth);
      }
      case 'custom':
        return p.repeatDays?.includes(weekday) ?? false;
      default:
        // 'weekly' comes through the DB as free text on some rows
        return p.repeatDays?.includes(weekday) ?? false;
    }
  });

  const totalCount =
    BUCKET_ORDER.reduce((n, b) => n + tasksByBucket[b].length + habitsByBucket[b].length, 0);

  return { tasksByBucket, habitsByBucket, recurringProjects, totalCount };
}
