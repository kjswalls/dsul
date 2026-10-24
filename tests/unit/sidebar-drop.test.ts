import { describe, it, expect } from 'vitest';
import { sidebarDropPlan } from '@/lib/dnd/sidebar-drop';
import type { HabitItem, Task } from '@/lib/planner-types';

const task = (id: string, extra: Partial<Task> = {}) =>
  ({ type: 'task', id, title: id, status: 'pending', ...extra }) as Task;
const habit = (id: string, extra: Partial<HabitItem> = {}) =>
  ({
    type: 'habit',
    id,
    title: id,
    status: 'pending',
    repeatFrequency: 'daily',
    timeBucket: 'morning',
    completedDates: [],
    ...extra,
  }) as unknown as HabitItem;

const tasks = [
  task('placed', { isScheduled: true, timeBucket: 'morning', startDate: '2026-10-01' }),
  task('loose'),
  task('milestone', { isScheduled: true, timeBucket: 'morning', startDate: '2026-10-01' }),
];
const habits = [
  habit('daily'),
  habit('paused', { pausedAt: '2026-09-01T00:00:00Z' }),
  habit('resumed', { pausedAt: '2026-09-01T00:00:00Z', pausedUntil: '2026-09-15' }),
  habit('loose', { repeatFrequency: 'none', timeBucket: undefined }),
  habit('sub', { parentItemId: 'placed' } as Partial<HabitItem>),
];
const plan = (ids: string[]) =>
  sidebarDropPlan(ids, tasks, habits, new Set(['milestone']), '2026-10-01', 'UTC');

describe('sidebarDropPlan', () => {
  it('unschedules placed tasks, minus milestones and braindump rows', () => {
    expect(plan(['placed', 'loose', 'milestone']).unschedule).toEqual(['placed']);
  });

  it('pauses canvas habits that can pause and are not paused today', () => {
    expect(plan(['daily', 'paused', 'resumed', 'loose', 'sub']).pause).toEqual(['daily', 'resumed']);
  });

  it('splits a mixed selection into both verbs', () => {
    const { unschedule, pause } = plan(['placed', 'daily']);
    expect({ unschedule, pause }).toEqual({ unschedule: ['placed'], pause: ['daily'] });
  });
});

/**
 * Week and blocks PR 11: the group's half of a braindump drop asks the same
 * gate as the single drop (lib/block-moves.ts planBlockDrop, whose braindump
 * answer is Move to Braindump's, lib/row-moves.ts canSendToBraindump). A
 * series, a finished task, one in a project block and a milestone stay where
 * they are; a row already in the braindump is already there. Habits pause as
 * before. Ran on the code before the rule, where the first case failed (it
 * unscheduled the series, the finished rows and the in-block row) and the
 * other two passed.
 */
describe('sidebarDropPlan follows the shared drop rule (PR 11)', () => {
  const custom = (id: string, extra: Partial<Task> = {}) =>
    ({ type: 'custom', customType: 'errand', id, title: id, status: 'pending', ...extra }) as unknown as Task;
  const placed = { isScheduled: true, timeBucket: 'morning', startDate: '2026-10-01' } as const;
  const more = [
    ...tasks,
    task('series', { ...placed, startDate: '2026-09-01', repeatFrequency: 'daily' }),
    task('done', { ...placed, status: 'completed' }),
    task('let-go', { ...placed, status: 'cancelled' }),
    task('in-block', { ...placed, inProjectBlock: true }),
    task('dated-row', { startDate: '2026-10-01' }),
    custom('custom-placed', { ...placed }),
    custom('custom-series', { ...placed, repeatFrequency: 'weekdays' }),
  ];
  const planOf = (ids: string[]) => sidebarDropPlan(ids, more, habits, new Set(['milestone']), '2026-10-01', 'UTC');
  const ALL = more.map((t) => t.id);

  it('unschedules only the placed, open, one-off rows outside a block that are not milestones', () => {
    expect(planOf(ALL).unschedule).toEqual(['placed', 'custom-placed']);
  });

  it('unschedules a placed one-off and a custom one as before', () => {
    expect(planOf(['placed', 'custom-placed']).unschedule).toEqual(['placed', 'custom-placed']);
  });

  it('pauses the same habits as before', () => {
    expect(planOf([...ALL, 'daily', 'paused', 'resumed', 'loose', 'sub']).pause).toEqual(['daily', 'resumed']);
  });

  // `rewrite` is what the shell's group drop hands unscheduleTasks
  // (app-shell.tsx handleDragEnd). Before the rule that was every task-like in
  // the selection minus milestones; now a canvas task the rule keeps is left
  // out, and a row already in the braindump is still written again.
  it('rewrites the rows the group wrote before when no canvas task is kept', () => {
    expect(plan(['placed', 'loose', 'milestone', 'daily']).rewrite).toEqual(['placed', 'loose']);
    expect(plan(['loose', 'milestone']).rewrite).toEqual(['loose']);
    expect(plan(['milestone', 'daily']).rewrite).toEqual([]);
  });

  it('leaves out every canvas task the rule keeps, and keeps the braindump rows', () => {
    expect(planOf(ALL).rewrite).toEqual(['placed', 'loose', 'dated-row', 'custom-placed']);
    expect(planOf(['series', 'dated-row', 'daily']).rewrite).toEqual(['dated-row']);
  });

  it('writes nothing when a kept canvas task is all that would move, so the drop falls through', () => {
    expect(planOf(['series', 'dated-row'])).toEqual({ unschedule: [], pause: [], rewrite: [] });
    expect(planOf(['series', 'done', 'milestone']).rewrite).toEqual([]);
  });
});
