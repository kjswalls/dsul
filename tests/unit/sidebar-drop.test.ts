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
    expect(plan(['placed', 'daily'])).toEqual({ unschedule: ['placed'], pause: ['daily'] });
  });
});
