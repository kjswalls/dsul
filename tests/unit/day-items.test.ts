import { describe, it, expect } from 'vitest';
import { deriveDayItems, type DayItemsInput } from '@/lib/day-items';
import type { Task, HabitItem, Project } from '@/lib/planner-types';

const TZ = 'America/New_York';
const DATE_STR = '2026-07-08'; // a Wednesday

function task(overrides: Partial<Task>): Task {
  return {
    id: Math.random().toString(36).slice(2),
    title: 'task',
    status: 'pending',
    isScheduled: true,
    order: 0,
    ...overrides,
  } as Task;
}

function habit(overrides: Partial<HabitItem>): HabitItem {
  return {
    id: Math.random().toString(36).slice(2),
    title: 'habit',
    project: 'wellness',
    status: 'pending',
    streak: 0,
    completedDates: [],
    repeatFrequency: 'daily',
    ...overrides,
  } as HabitItem;
}

function input(overrides: Partial<DayItemsInput>): DayItemsInput {
  return {
    tasks: [],
    habits: [],
    projects: [],
    dateStr: DATE_STR,
    timezone: TZ,
    typeFilter: 'all',
    showCompletedTasks: true,
    ...overrides,
  };
}

describe('deriveDayItems', () => {
  it('buckets one-off tasks by exact date match', () => {
    const onDay = task({ startDate: DATE_STR, timeBucket: 'morning' });
    const otherDay = task({ startDate: '2026-07-09', timeBucket: 'morning' });
    const noDate = task({ timeBucket: 'morning' });

    const result = deriveDayItems(input({ tasks: [onDay, otherDay, noDate] }));
    expect(result.tasksByBucket.morning.map((t) => t.id)).toEqual([onDay.id]);
  });

  it('sorts timed tasks first by time, then untimed by order', () => {
    const nine = task({ startDate: DATE_STR, timeBucket: 'morning', startTime: '09:00' });
    const eight = task({ startDate: DATE_STR, timeBucket: 'morning', startTime: '08:00' });
    const untimedSecond = task({ startDate: DATE_STR, timeBucket: 'morning', order: 2 });
    const untimedFirst = task({ startDate: DATE_STR, timeBucket: 'morning', order: 1 });

    const result = deriveDayItems(
      input({ tasks: [untimedSecond, nine, untimedFirst, eight] })
    );
    expect(result.tasksByBucket.morning.map((t) => t.id)).toEqual([
      eight.id,
      nine.id,
      untimedFirst.id,
      untimedSecond.id,
    ]);
  });

  it('hides completed tasks when showCompletedTasks is false', () => {
    const done = task({ startDate: DATE_STR, timeBucket: 'evening', status: 'completed' });
    const pending = task({ startDate: DATE_STR, timeBucket: 'evening' });

    const shown = deriveDayItems(input({ tasks: [done, pending], showCompletedTasks: false }));
    expect(shown.tasksByBucket.evening.map((t) => t.id)).toEqual([pending.id]);

    const all = deriveDayItems(input({ tasks: [done, pending], showCompletedTasks: true }));
    expect(all.tasksByBucket.evening).toHaveLength(2);
  });

  it('shows daily recurring tasks that started earlier', () => {
    const recurring = task({
      startDate: '2026-07-01',
      timeBucket: 'morning',
      repeatFrequency: 'daily',
    });
    const result = deriveDayItems(input({ tasks: [recurring] }));
    expect(result.tasksByBucket.morning).toHaveLength(1);
  });

  it('shows a recurring task on its own start date, even off its repeat days', () => {
    // A Monday task moved to Wednesday: the move means "this day", and the
    // series carries on from there.
    const moved = task({
      startDate: DATE_STR,
      timeBucket: 'morning',
      repeatFrequency: 'custom',
      repeatDays: [1],
    });
    expect(deriveDayItems(input({ tasks: [moved] })).tasksByBucket.morning).toHaveLength(1);
    // Not the day before it starts, and not the next Wednesday.
    expect(deriveDayItems(input({ tasks: [moved], dateStr: '2026-07-07' })).tasksByBucket.morning).toHaveLength(0);
    expect(deriveDayItems(input({ tasks: [moved], dateStr: '2026-07-15' })).tasksByBucket.morning).toHaveLength(0);
    expect(deriveDayItems(input({ tasks: [moved], dateStr: '2026-07-13' })).tasksByBucket.morning).toHaveLength(1);
  });

  it('applies the type filter both ways', () => {
    const t = task({ startDate: DATE_STR, timeBucket: 'morning' });
    const h = habit({ timeBucket: 'morning' });

    const tasksOnly = deriveDayItems(input({ tasks: [t], habits: [h], typeFilter: 'tasks' }));
    expect(tasksOnly.tasksByBucket.morning).toHaveLength(1);
    expect(tasksOnly.habitsByBucket.morning).toHaveLength(0);

    const habitsOnly = deriveDayItems(input({ tasks: [t], habits: [h], typeFilter: 'habits' }));
    expect(habitsOnly.tasksByBucket.morning).toHaveLength(0);
    expect(habitsOnly.habitsByBucket.morning).toHaveLength(1);
  });

  it('includes weekday-recurring projects on a Wednesday', () => {
    const project = {
      id: 'p1',
      name: 'Deep work',
      emoji: '🛠',
      startTime: '09:00',
      timeBucket: 'morning',
      repeatFrequency: 'weekdays',
    } as unknown as Project;
    const weekendOnly = {
      id: 'p2',
      name: 'Chores',
      emoji: '🧺',
      startTime: '10:00',
      timeBucket: 'morning',
      repeatFrequency: 'weekends',
    } as unknown as Project;

    const result = deriveDayItems(input({ projects: [project, weekendOnly] }));
    expect(result.recurringProjects.map((p) => p.id)).toEqual(['p1']);
  });

  it('counts everything it bucketed', () => {
    const t = task({ startDate: DATE_STR, timeBucket: 'afternoon' });
    const h = habit({ timeBucket: 'anytime' });
    const result = deriveDayItems(input({ tasks: [t], habits: [h] }));
    expect(result.totalCount).toBe(2);
  });
});

/**
 * A project block's weekday comes from `dateStr`, the same string everything
 * else on the day is resolved against.
 *
 * It used to come from a `date: Date` passed beside it, read with `getDay()` —
 * which answers in the BROWSER's zone, while `dateStr` and `shouldShowOnDate`
 * answer in the USER's. When the two differed the same column was Thursday for
 * a task and Wednesday for a block, so a Thursday block rendered on Wednesday.
 *
 * What fixed it is structural: `DayItemsInput` no longer HAS a Date, so the two
 * cannot disagree. These cases pin the resolution itself — they would have
 * passed before the fix too, given a Date that agreed with its dateStr, and
 * that is the point. There is no longer a way to hand it one that doesn't.
 */
describe('deriveDayItems — the weekday comes from dateStr', () => {
  const block = (over: Record<string, unknown>) =>
    ({
      id: 'p',
      name: 'Block',
      emoji: '🧱',
      startTime: '09:00',
      timeBucket: 'morning',
      ...over,
    }) as unknown as Project;

  const on = (dateStr: string, project: Project) =>
    deriveDayItems(input({ dateStr, projects: [project] })).recurringProjects.length === 1;

  it('reads a custom weekday set off the calendar date', () => {
    // 2026-08-13 is a Thursday (weekday 4) in every zone that calls it that,
    // because the only thing being asked is the string.
    expect(on('2026-08-13', block({ repeatFrequency: 'custom', repeatDays: [4] }))).toBe(true);
    expect(on('2026-08-13', block({ repeatFrequency: 'custom', repeatDays: [3] }))).toBe(false);
  });

  it('splits weekdays from weekends on the same rule', () => {
    expect(on('2026-08-15', block({ repeatFrequency: 'weekends' }))).toBe(true); // Saturday
    expect(on('2026-08-15', block({ repeatFrequency: 'weekdays' }))).toBe(false);
    expect(on('2026-08-14', block({ repeatFrequency: 'weekdays' }))).toBe(true); // Friday
  });

  it('clamps a monthly block to the last day of a SHORT month', () => {
    // The other half of the removed Date: `lastDayOfMonth` was built with
    // `new Date(y, m + 1, 0)` off the same local-zone Date object.
    const thirty_first = block({ repeatFrequency: 'monthly', repeatMonthDay: 31 });
    expect(on('2026-02-28', thirty_first)).toBe(true);
    expect(on('2026-02-27', thirty_first)).toBe(false);
    expect(on('2026-03-31', thirty_first)).toBe(true);
    expect(on('2026-03-30', thirty_first)).toBe(false);
  });

  it('handles a leap February', () => {
    const thirty_first = block({ repeatFrequency: 'monthly', repeatMonthDay: 31 });
    expect(on('2028-02-29', thirty_first)).toBe(true);
    expect(on('2028-02-28', thirty_first)).toBe(false);
  });
});
