import { describe, it, expect } from 'vitest';
import {
  GHOST_PILE_THRESHOLD,
  ghostFoldStartsCollapsed,
  ghostWeekday,
  selectGhostRows,
} from '@/lib/ghost-rows';
import type { Item } from '@/lib/planner-types';

/**
 * lib/ghost-rows.ts: which items ghost at the top of Today, and in what order.
 * The predicate is lib/overdue.ts selectOverdue (overdue.test.ts pins it in
 * depth); this pins that the ghosts inherit every one of its exclusions, add
 * the milestone one, and come out newest first.
 */

const TODAY = '2026-07-15'; // a Wednesday
const NONE: ReadonlySet<string> = new Set();

let seq = 0;
function task(over: Partial<Item> & { id?: string } = {}): Item {
  return {
    type: 'task',
    id: over.id ?? `t${++seq}`,
    title: 'task',
    status: 'pending',
    isScheduled: true,
    timeBucket: 'anytime',
    order: 0,
    completedDates: [],
    ...over,
  } as Item;
}

const ids = (items: { id: string }[]) => items.map((i) => i.id);
const ghosts = (items: Item[], opts: { inactive?: Set<string>; milestones?: Set<string> } = {}) =>
  ids(selectGhostRows(items, TODAY, opts.inactive ?? NONE, opts.milestones ?? NONE));

describe('selectGhostRows: who ghosts', () => {
  it('a one-off pending task from an earlier day', () => {
    expect(ghosts([task({ id: 'a', startDate: '2026-07-14' })])).toEqual(['a']);
  });

  it('never a recurring item: its misses are per-date state', () => {
    expect(ghosts([task({ id: 'r', startDate: '2026-07-01', repeatFrequency: 'daily' })])).toEqual([]);
  });

  it('never a habit', () => {
    const habit = {
      type: 'habit',
      id: 'h',
      title: 'Stretch',
      status: 'pending',
      streak: 0,
      completedDates: [],
      skippedDates: [],
      dailyCounts: {},
      repeatFrequency: 'none',
      startDate: '2026-07-10',
    } as unknown as Item;
    expect(ghosts([habit])).toEqual([]);
  });

  it('never a completed or cancelled item', () => {
    expect(
      ghosts([
        task({ id: 'done', startDate: '2026-07-14', status: 'completed' }),
        task({ id: 'gone', startDate: '2026-07-14', status: 'cancelled' }),
      ])
    ).toEqual([]);
  });

  it('never a goal milestone: its date is a target, not a plan that slipped', () => {
    const items = [task({ id: 'm', startDate: '2026-07-10' }), task({ id: 'plain', startDate: '2026-07-10' })];
    expect(ghosts(items, { milestones: new Set(['m']) })).toEqual(['plain']);
  });

  it('never an item set aside today (paused, a season off, away)', () => {
    const items = [task({ id: 'paused', startDate: '2026-07-12' }), task({ id: 'live', startDate: '2026-07-12' })];
    expect(ghosts(items, { inactive: new Set(['paused']) })).toEqual(['live']);
  });

  it('never a subtask: no view shows it outside its parent', () => {
    expect(ghosts([task({ id: 'sub', startDate: '2026-07-12', parentItemId: 'p' } as Partial<Item>)])).toEqual([]);
  });

  it('never today, the future, or an undated item', () => {
    expect(
      ghosts([
        task({ id: 'today', startDate: TODAY }),
        task({ id: 'later', startDate: '2026-07-20' }),
        task({ id: 'undated', startDate: undefined, isScheduled: false }),
      ])
    ).toEqual([]);
  });

  it('a custom type is date-anchored and carries forward, so it ghosts', () => {
    const goal = {
      type: 'custom',
      customType: 'errand',
      id: 'c',
      title: 'Post office',
      status: 'pending',
      isScheduled: true,
      order: 0,
      startDate: '2026-07-13',
      completedDates: [],
    } as unknown as Item;
    expect(ghosts([goal])).toEqual(['c']);
  });
});

describe('selectGhostRows: order', () => {
  it('newest first, all the way down (not the tray’s two cohorts)', () => {
    const items = [
      task({ id: 'd30', startDate: '2026-06-15' }),
      task({ id: 'd1', startDate: '2026-07-14' }),
      task({ id: 'd10', startDate: '2026-07-05' }),
      task({ id: 'd3', startDate: '2026-07-12' }),
      task({ id: 'd100', startDate: '2026-04-06' }),
    ];
    expect(ghosts(items)).toEqual(['d1', 'd3', 'd10', 'd30', 'd100']);
  });

  it('ties keep store order', () => {
    const items = [
      task({ id: 'x', startDate: '2026-07-14' }),
      task({ id: 'y', startDate: '2026-07-14' }),
      task({ id: 'z', startDate: '2026-07-14' }),
    ];
    expect(ghosts(items)).toEqual(['x', 'y', 'z']);
  });

  it('tolerates a legacy full-ISO start date', () => {
    const items = [
      task({ id: 'iso', startDate: '2026-07-10T00:00:00.000Z' }),
      task({ id: 'plain', startDate: '2026-07-14' }),
    ];
    expect(ghosts(items)).toEqual(['plain', 'iso']);
  });
});

describe('the fold’s pile rule and weekday stamp', () => {
  it('starts collapsed only past the threshold', () => {
    expect(GHOST_PILE_THRESHOLD).toBe(5);
    expect(ghostFoldStartsCollapsed(5)).toBe(false);
    expect(ghostFoldStartsCollapsed(6)).toBe(true);
  });

  it('stamps the weekday from the string, in no timezone', () => {
    expect(ghostWeekday('2026-07-16')).toBe('Thu');
    expect(ghostWeekday('2026-07-12T23:30:00.000Z')).toBe('Sun');
  });
});
