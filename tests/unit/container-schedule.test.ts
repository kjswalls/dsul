import { describe, expect, it } from 'vitest';
import {
  addDaysStr,
  containerMemberIds,
  deriveContainerSchedule,
  MAX_SCHEDULE_DAYS,
  occurrencesByItem,
  weekBuckets,
  weekStartOf,
  type ScheduleSource,
} from '@/lib/container-schedule';
import type { HabitItem, Item, Program, Routine, Task } from '@/lib/planner-types';

/**
 * The schedule behind the container charts. What is pinned is what the design
 * review asked of it: it is the GRID's answer per day (same exclusions, same
 * pause handling), the past only reports what was recorded, weeks follow the
 * user's setting, and undated work is reported rather than lost.
 */

const TODAY = '2026-09-26'; // a Saturday

const habit = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    type: 'habit',
    title: id,
    status: 'pending',
    repeatFrequency: 'daily',
    timeBucket: 'morning',
    completedDates: [],
    skippedDates: [],
    streak: 0,
    ...extra,
  }) as unknown as HabitItem;

const task = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    type: 'task',
    title: id,
    status: 'pending',
    order: 0,
    isScheduled: true,
    timeBucket: 'anytime',
    completedDates: [],
    skippedDates: [],
    ...extra,
  }) as unknown as Task;

function source(items: (Task | HabitItem)[], extra: Partial<ScheduleSource> = {}): ScheduleSource {
  return {
    items: items as unknown as Item[],
    tasks: items.filter((i) => (i as { type: string }).type === 'task') as Task[],
    habits: items.filter((i) => (i as { type: string }).type === 'habit') as HabitItem[],
    routines: [],
    programs: [],
    timezone: 'UTC',
    ...extra,
  };
}

describe('calendar helpers', () => {
  it('starts weeks on the user\'s day', () => {
    expect(weekStartOf(TODAY, 'sunday')).toBe('2026-09-20');
    expect(weekStartOf(TODAY, 'monday')).toBe('2026-09-21');
    expect(weekStartOf(TODAY, 'saturday')).toBe(TODAY);
    expect(addDaysStr('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('deriveContainerSchedule', () => {
  it('reports only recorded states for the past — done or skipped, else open', () => {
    const h = habit('stretch', { completedDates: ['2026-09-24'], skippedDates: ['2026-09-23'] });
    const s = deriveContainerSchedule({
      memberIds: ['stretch'],
      source: source([h]),
      from: '2026-09-22',
      days: 6,
      todayStr: TODAY,
    });
    const row = occurrencesByItem(s).get('stretch')!;
    expect(row.get('2026-09-22')?.state).toBe('open');
    expect(row.get('2026-09-23')?.state).toBe('skipped');
    expect(row.get('2026-09-24')?.state).toBe('done');
    expect(row.get('2026-09-26')?.state).toBe('due');
    expect(row.get('2026-09-27')?.state).toBe('due');
  });

  it('narrows to members, and marks one-offs', () => {
    const s = deriveContainerSchedule({
      memberIds: ['exam'],
      source: source([habit('stretch'), task('exam', { startDate: '2026-09-28' })]),
      from: TODAY,
      days: 7,
      todayStr: TODAY,
    });
    const all = s.days.flatMap((d) => d.occurrences);
    expect(all).toEqual([{ itemId: 'exam', date: '2026-09-28', state: 'due', once: true }]);
  });

  it('drops what the grid drops — a task with no bucket', () => {
    const s = deriveContainerSchedule({
      memberIds: ['loose'],
      source: source([task('loose', { startDate: TODAY, timeBucket: undefined })]),
      from: TODAY,
      days: 1,
      todayStr: TODAY,
    });
    expect(s.days[0].occurrences).toEqual([]);
  });

  it('hides members on the days a paused routine hides them', () => {
    const h = habit('stretch');
    const paused: Routine = {
      id: 'r1',
      name: 'Mornings',
      pausedAt: '2026-09-26T08:00:00Z',
      pausedUntil: '2026-09-28',
      itemIds: ['stretch'],
    };
    const s = deriveContainerSchedule({
      memberIds: ['stretch'],
      source: source([h], { routines: [paused] }),
      from: TODAY,
      days: 3,
      todayStr: TODAY,
    });
    expect(s.days.map((d) => d.occurrences.length)).toEqual([0, 0, 1]);
  });

  it('reports undated one-off members as unscheduled — the braindump\'s rule', () => {
    const s = deriveContainerSchedule({
      memberIds: ['paint', 'done', 'stretch', 'held', 'bucketed'],
      source: source(
        [
          task('paint', { startDate: undefined, isScheduled: false, timeBucket: undefined }),
          task('done', { startDate: undefined, isScheduled: false, timeBucket: undefined, status: 'completed' }),
          task('held', { startDate: undefined, isScheduled: false, timeBucket: undefined, pausedAt: '2026-09-01T00:00:00Z' }),
          task('bucketed', { startDate: undefined, isScheduled: false, timeBucket: 'morning' }),
          habit('stretch'),
        ],
      ),
      from: TODAY,
      days: 1,
      todayStr: TODAY,
    });
    expect(s.unscheduled.map((i) => i.id)).toEqual(['paint']);
  });

  it('reads a cancelled one-off as a decision, not as work due', () => {
    const s = deriveContainerSchedule({
      memberIds: ['x'],
      source: source([task('x', { startDate: '2026-09-28', status: 'cancelled' })]),
      from: '2026-09-28',
      days: 1,
      todayStr: TODAY,
    });
    expect(s.days[0].occurrences[0].state).toBe('skipped');
  });

  it('reads a recurring task per date, and a counted habit done only at its target', () => {
    const weekly = task('review', {
      startDate: '2026-09-20',
      repeatFrequency: 'custom',
      repeatDays: [0],
      completedDates: ['2026-09-20'],
    });
    const counted = habit('water', { timesPerDay: 3, dailyCounts: { '2026-09-25': 2 } });
    const s = deriveContainerSchedule({
      memberIds: ['review', 'water'],
      source: source([weekly, counted]),
      from: '2026-09-20',
      days: 7,
      todayStr: TODAY,
    });
    const rows = occurrencesByItem(s, ['review', 'water']);
    expect(rows.get('review')!.get('2026-09-20')!.state).toBe('done');
    expect(rows.get('water')!.get('2026-09-25')!.state).toBe('open');
    expect([...rows.keys()]).toEqual(['review', 'water']);
  });

  it('follows a program\'s dates when it switches on mid-range', () => {
    const p: Program = {
      id: 'p1',
      name: 'Term',
      state: 'auto',
      startsOn: '2026-09-28',
      itemIds: ['stretch'],
      routineIds: [],
    };
    const s = deriveContainerSchedule({
      memberIds: ['stretch'],
      source: source([habit('stretch')], { programs: [p] }),
      from: TODAY,
      days: 4,
      todayStr: TODAY,
    });
    expect(s.days.map((d) => d.occurrences.length)).toEqual([0, 0, 1, 1]);
  });

  it('keeps a mark made on a paused day — pausing hides open loops, never history', () => {
    const h = habit('stretch', { completedDates: [TODAY] });
    const paused: Routine = { id: 'r1', name: 'M', pausedAt: '2026-09-25T00:00:00Z', itemIds: ['stretch'] };
    const s = deriveContainerSchedule({
      memberIds: ['stretch'],
      source: source([h], { routines: [paused] }),
      from: TODAY,
      days: 2,
      todayStr: TODAY,
    });
    expect(s.days[0].occurrences).toEqual([{ itemId: 'stretch', date: TODAY, state: 'done', once: false }]);
    expect(s.days[1].occurrences).toEqual([]);
  });

  it('caps the range', () => {
    const s = deriveContainerSchedule({
      memberIds: [],
      source: source([]),
      from: TODAY,
      days: 5000,
      todayStr: TODAY,
    });
    expect(s.days).toHaveLength(MAX_SCHEDULE_DAYS);
  });
});

describe('weekBuckets', () => {
  it('totals each week from the user\'s week start', () => {
    const h = habit('stretch', { completedDates: ['2026-09-21'] });
    const s = deriveContainerSchedule({
      memberIds: ['stretch', 'exam'],
      source: source([h, task('exam', { startDate: '2026-09-29' })]),
      from: '2026-09-20',
      days: 14,
      todayStr: TODAY,
    });
    const weeks = weekBuckets(s, 'sunday');
    expect(weeks.map((w) => w.start)).toEqual(['2026-09-20', '2026-09-27']);
    expect(weeks[0]).toMatchObject({ done: 1, open: 5, due: 1 });
    expect(weeks[1].due).toBe(8);
    expect(weeks[1].once.map((o) => o.itemId)).toEqual(['exam']);
  });
});

describe('weekBuckets from mid-week', () => {
  it('opens a partial first week on a Monday start', () => {
    const s = deriveContainerSchedule({
      memberIds: ['stretch'],
      source: source([habit('stretch')]),
      from: '2026-09-24',
      days: 7,
      todayStr: TODAY,
    });
    const weeks = weekBuckets(s, 'monday');
    expect(weeks.map((w) => w.start)).toEqual(['2026-09-21', '2026-09-28']);
    expect(weeks.map((w) => w.open + w.due)).toEqual([4, 3]);
    expect(addDaysStr('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('containerMemberIds', () => {
  it('counts a program\'s routines\' members, and a project by folded name', () => {
    const r: Routine = { id: 'r1', name: 'Mornings', itemIds: ['a', 'b'] };
    const p: Program = { id: 'p1', name: 'Term', state: 'auto', itemIds: ['b', 'c'], routineIds: ['r1'] };
    expect(containerMemberIds({ kind: 'program', program: p }, [], [r]).sort()).toEqual(['a', 'b', 'c']);
    const items = [
      { id: 'x', type: 'task', title: 'x', project: 'Home' },
      { id: 'y', type: 'task', title: 'y', project: 'home' },
      { id: 'z', type: 'task', title: 'z', project: 'Work' },
    ] as unknown as Item[];
    expect(
      containerMemberIds({ kind: 'project', project: { id: 'pr', name: 'HOME', emoji: '' } }, items, [])
    ).toEqual(['x', 'y']);
  });
});

describe('chart ranges', () => {
  it('keeps today in view for a goal window longer than the chart holds', async () => {
    const { goalRange } = await import('@/components/planner/schedule/schedule-views');
    const long = goalRange('2024-01-01', '2028-01-01', TODAY);
    expect(long.capped).toBe(true);
    expect(long.from).toBe(addDaysStr(TODAY, -182));
    expect(goalRange(undefined, undefined, TODAY)).toMatchObject({ from: TODAY, days: 84, open: true });
  });

  it('week-aligns a program\'s run, and gives an undated one sixteen weeks', async () => {
    const { programRange } = await import('@/components/planner/schedule/schedule-views');
    const run = programRange({ state: 'auto', startsOn: '2026-09-01', endsOn: '2026-12-18' }, TODAY, 'monday');
    expect(run.from).toBe('2026-08-31');
    expect(programRange({ state: 'active' }, TODAY, 'sunday')).toMatchObject({ from: '2026-09-20', days: 112, bounded: false });
  });
});
