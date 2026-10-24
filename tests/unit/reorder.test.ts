import { describe, it, expect } from 'vitest';
import {
  inPlannerOrder,
  isRowMovable,
  movePeers,
  ordersFor,
  peersOf,
  reorderAllowed,
  stepPeers,
} from '@/lib/reorder';
import type { HabitItem, Task } from '@/lib/planner-types';

const task = (id: string, extra: Partial<Task> = {}) =>
  ({
    itemType: 'task' as const,
    item: { type: 'task', id, title: id, status: 'pending', isScheduled: true, order: 0, ...extra } as Task,
  });
const habit = (id: string, extra: Partial<HabitItem> = {}) =>
  ({
    itemType: 'habit' as const,
    item: {
      type: 'habit', id, title: id, status: 'pending', streak: 0, completedDates: [], skippedDates: [],
      dailyCounts: {}, repeatFrequency: 'daily', ...extra,
    } as HabitItem,
  });

const ids = (rows: { item: { id: string } }[]) => rows.map((r) => r.item.id);

describe('reorderAllowed', () => {
  it('is on under Default ordering and a grouping with no order of its own', () => {
    for (const g of ['none', 'project', 'priority', 'bucket', 'type'] as const) {
      expect(reorderAllowed('default', g)).toBe(true);
    }
  });
  it('is off under another Ordering', () => {
    expect(reorderAllowed('priority', 'none')).toBe(false);
    expect(reorderAllowed('title', 'project')).toBe(false);
  });
  it('is off where Organize owns the sequence', () => {
    for (const g of ['routine', 'season', 'goal'] as const) {
      expect(reorderAllowed('default', g)).toBe(false);
    }
  });
});

describe('who may move', () => {
  it('an untimed open task or habit', () => {
    expect(isRowMovable(task('a'), '2026-10-24')).toBe(true);
    expect(isRowMovable(habit('h'), '2026-10-24')).toBe(true);
  });
  it('not a timed row: its place is its time', () => {
    expect(isRowMovable(task('a', { startTime: '09:30' }), '2026-10-24')).toBe(false);
  });
  it('not a finished row: it sinks below the order', () => {
    expect(isRowMovable(task('a', { status: 'completed' }), '2026-10-24')).toBe(false);
    expect(isRowMovable(habit('h', { completedDates: ['2026-10-24'] }), '2026-10-24')).toBe(false);
  });
  it('not a row inside a project block', () => {
    expect(isRowMovable(task('a', { inProjectBlock: true }), '2026-10-24')).toBe(false);
  });
  it('peers split by kind, in the order drawn', () => {
    const peers = peersOf([habit('h1'), task('t1'), task('t2', { startTime: '10:00' }), habit('h2'), task('t3')], null);
    expect(peers).toEqual({ habit: ['h1', 'h2'], task: ['t1', 't3'] });
  });
});

describe('inPlannerOrder', () => {
  it('timed rows by time, then untimed rows by order, ignoring the hidden bucket', () => {
    const rows = [
      task('anytime-late', { timeBucket: 'anytime', order: 5 }),
      task('morning-first', { timeBucket: 'morning', order: 1 }),
      task('ten', { timeBucket: 'morning', startTime: '10:00', order: 9 }),
      task('nine', { timeBucket: 'anytime', startTime: '09:00', order: 9 }),
    ];
    expect(ids(inPlannerOrder(rows))).toEqual(['nine', 'ten', 'morning-first', 'anytime-late']);
  });
  it('keeps each kind in the slots it held', () => {
    const rows = [habit('h2', { order: 2 }), habit('h1', { order: 1 }), task('t2', { order: 2 }), task('t1', { order: 1 })];
    expect(ids(inPlannerOrder(rows))).toEqual(['h1', 'h2', 't1', 't2']);
  });
  it('a missing order sorts last, as the load does', () => {
    const rows = [habit('none'), habit('one', { order: 1 })];
    expect(ids(inPlannerOrder(rows))).toEqual(['one', 'none']);
  });
  it('the same array back when nothing moves', () => {
    const rows = [task('a', { order: 0 }), task('b', { order: 1 })];
    expect(inPlannerOrder(rows)).toBe(rows);
  });
});

describe('movePeers', () => {
  const peers = ['a', 'b', 'c', 'd'];
  it('puts the row before the one it was dropped above', () => {
    expect(movePeers(peers, ['d'], 'b')).toEqual(['a', 'd', 'b', 'c']);
  });
  it('at the end when dropped below the last', () => {
    expect(movePeers(peers, ['a'], null)).toEqual(['b', 'c', 'd', 'a']);
  });
  it('null when it lands where it was', () => {
    expect(movePeers(peers, ['b'], 'c')).toBeNull();
    expect(movePeers(peers, ['b'], 'b')).toBeNull();
  });
  it('moves a selection as a block, in its drawn order', () => {
    expect(movePeers(peers, ['d', 'b'], 'a')).toEqual(['b', 'd', 'a', 'c']);
  });
  it('steps one up or down, and not past either end', () => {
    expect(stepPeers(peers, 'c', -1)).toEqual(['a', 'c', 'b', 'd']);
    expect(stepPeers(peers, 'a', -1)).toBeNull();
    expect(stepPeers(peers, 'd', 1)).toBeNull();
  });
});

describe('ordersFor', () => {
  it('reuses the numbers the rows already hold, so the block keeps its place among unseen rows', () => {
    const current = new Map([['a', 3], ['b', 7], ['c', 12]]);
    expect(ordersFor(['c', 'a', 'b'], current)).toEqual(new Map([['c', 3], ['a', 7], ['b', 12]]));
  });
  it('pulls ties apart upwards, writing only what changes', () => {
    const current = new Map([['a', 0], ['b', 0], ['c', 0]]);
    expect(ordersFor(['a', 'b', 'c'], current)).toEqual(new Map([['b', 1], ['c', 2]]));
  });
  it('gives a row with no order the next number up', () => {
    const current = new Map<string, number | undefined>([['a', 4], ['b', undefined]]);
    expect(ordersFor(['b', 'a'], current)).toEqual(new Map([['b', 4], ['a', 5]]));
  });
});
