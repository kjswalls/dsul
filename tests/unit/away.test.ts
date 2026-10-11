import { describe, it, expect } from 'vitest';
import {
  awayHoldOn,
  currentAway,
  easeDays,
  easingAway,
  lastReturnDay,
  planReturns,
  returnDayOf,
  suggestKeeps,
  tripTasks,
  upcomingAway,
  addDays,
  EMPTY_KEEP,
  type AwayPeriod,
} from '@/lib/away';
import {
  inactiveItemIdsOn,
  isItemActiveOn,
  isOpenLoopSuppressedOn,
  suppressionLabel,
  suppressionReason,
  type ActivationContext,
} from '@/lib/active';
import type { Item, Routine } from '@dsul/types';

const task = (over: Partial<Item> = {}): Item =>
  ({ type: 'task', id: 't', title: 'T', status: 'pending', isScheduled: false, order: 0, ...over }) as Item;

const habit = (over: Partial<Item> = {}): Item =>
  ({
    type: 'habit', id: 'h', title: 'H', streak: 0, status: 'pending',
    completedDates: [], skippedDates: [], dailyCounts: {}, repeatFrequency: 'daily',
    ...over,
  }) as Item;

const trip = (over: Partial<AwayPeriod> = {}): AwayPeriod => ({
  id: 'p', startsOn: '2026-10-11', endsOn: '2026-10-20', keep: EMPTY_KEEP, returns: {}, fromTrip: {}, ...over,
});

const ctx = (away: AwayPeriod[], routines?: Routine[]): ActivationContext => ({
  userTimezone: 'America/New_York', away, routines,
});

describe('awayHoldOn: what rests', () => {
  it('holds a habit from the first day up to, not including, the end day', () => {
    const p = [trip()];
    expect(awayHoldOn(habit(), '2026-10-10', p, undefined)).toBeUndefined();
    expect(awayHoldOn(habit(), '2026-10-11', p, undefined)).toBe(p[0]);
    expect(awayHoldOn(habit(), '2026-10-19', p, undefined)).toBe(p[0]);
    expect(awayHoldOn(habit(), '2026-10-20', p, undefined)).toBeUndefined();
  });

  it('holds a dated task, and never an undated braindump item', () => {
    const p = [trip()];
    expect(awayHoldOn(task({ startDate: '2026-10-14' } as Partial<Item>), '2026-10-14', p, undefined)).toBe(p[0]);
    expect(awayHoldOn(task(), '2026-10-14', p, undefined)).toBeUndefined();
  });

  it('keeps what the trip lists: the item, its parent, its project or a routine holding it', () => {
    const routines = [{ id: 'r1', itemIds: ['h'] } as Routine];
    const d = '2026-10-14';
    expect(awayHoldOn(habit(), d, [trip({ keep: { ...EMPTY_KEEP, itemIds: ['h'] } })], undefined)).toBeUndefined();
    expect(awayHoldOn(habit(), d, [trip({ keep: { ...EMPTY_KEEP, routineIds: ['r1'] } })], routines)).toBeUndefined();
    expect(
      awayHoldOn(habit({ projectId: 'pr' } as Partial<Item>), d, [trip({ keep: { ...EMPTY_KEEP, projectIds: ['pr'] } })], undefined),
    ).toBeUndefined();
    const sub = task({ id: 's', parentItemId: 'h', startDate: d } as Partial<Item>);
    expect(awayHoldOn(sub, d, [trip({ keep: { ...EMPTY_KEEP, itemIds: ['h'] } })], undefined)).toBeUndefined();
  });

  it('holds an open-ended trip forever', () => {
    expect(awayHoldOn(habit(), '2030-01-01', [trip({ endsOn: undefined })], undefined)).toBeDefined();
  });

  it('holds a habit through its easing wave after the trip', () => {
    const p = [trip({ returns: { h: '2026-10-24' } })];
    expect(awayHoldOn(habit(), '2026-10-22', p, undefined)).toBe(p[0]);
    expect(awayHoldOn(habit(), '2026-10-24', p, undefined)).toBeUndefined();
    expect(returnDayOf('h', p[0])).toBe('2026-10-24');
    expect(returnDayOf('other', p[0])).toBe('2026-10-20');
  });

  it('ignores a wave earlier than the end (an early "I\'m back" rewrites them)', () => {
    expect(returnDayOf('h', trip({ returns: { h: '2026-10-12' } }))).toBe('2026-10-20');
  });
});

describe('active.ts: the trip is the outer, conjunctive layer', () => {
  it('makes a held item inactive whatever else says', () => {
    expect(isItemActiveOn(habit(), '2026-10-14', ctx([trip()]))).toBe(false);
    expect(isItemActiveOn(habit(), '2026-10-21', ctx([trip()]))).toBe(true);
  });

  it('answers exactly as before with no trips', () => {
    expect(isItemActiveOn(habit(), '2026-10-14', { userTimezone: 'UTC' })).toBe(true);
  });

  it('hides open loops only: a habit ticked on day one keeps its tick', () => {
    const ticked = habit({ completedDates: ['2026-10-11'] } as Partial<Item>);
    expect(isOpenLoopSuppressedOn(ticked, '2026-10-11', ctx([trip()]))).toBe(false);
    expect(isOpenLoopSuppressedOn(ticked, '2026-10-12', ctx([trip()]))).toBe(true);
  });

  it('agrees between the bulk and single-item predicates', () => {
    const items = [habit(), habit({ id: 'kept' }), task({ id: 'b' }), task({ id: 'd', startDate: '2026-10-14' } as Partial<Item>)];
    const c = ctx([trip({ keep: { ...EMPTY_KEEP, itemIds: ['kept'] } })]);
    const ids = inactiveItemIdsOn(items, '2026-10-14', c);
    expect([...ids].sort()).toEqual(['d', 'h']);
    for (const i of items) expect(ids.has(i.id)).toBe(isOpenLoopSuppressedOn(i, '2026-10-14', c));
  });

  it('names the trip as the reason, with the day it comes back', () => {
    const reason = suppressionReason(habit(), '2026-10-14', ctx([trip({ returns: { h: '2026-10-22' } })]));
    expect(reason).toEqual({ kind: 'away', until: '2026-10-22' });
    expect(suppressionLabel(reason!)).toBe('Back Oct 22');
    expect(suppressionLabel(reason!, { long: true })).toBe('Resting for vacation mode until Oct 22');
  });

  it('lets an item\'s own pause win the explanation', () => {
    const paused = habit({ pausedAt: '2026-10-01T12:00:00Z' } as Partial<Item>);
    expect(suppressionReason(paused, '2026-10-14', ctx([trip()]))?.kind).toBe('paused');
  });
});

describe('which trip', () => {
  const p = trip();
  it('finds the current, upcoming and easing trip', () => {
    expect(currentAway([p], '2026-10-11')).toBe(p);
    expect(currentAway([p], '2026-10-20')).toBeUndefined();
    expect(upcomingAway([p], '2026-10-10')).toBe(p);
    const easing = trip({ returns: { h: '2026-10-24' } });
    expect(easingAway([easing], '2026-10-20')).toBe(easing);
    expect(easingAway([easing], '2026-10-24')).toBeUndefined();
    expect(lastReturnDay(easing)).toBe('2026-10-24');
  });
});

describe('coming back gently', () => {
  it('eases over as many days as you were away, up to a week', () => {
    expect(easeDays('2026-10-11', '2026-10-12')).toBe(0);
    expect(easeDays('2026-10-11', '2026-10-14')).toBe(3);
    expect(easeDays('2026-10-11', '2026-10-20')).toBe(7);
  });

  it('brings the longest streak back first and the rest in waves on days 2, 4 and 6', () => {
    const habits = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, i) => habit({ id, title: id, streak: 10 - i } as Partial<Item>));
    const r = planReturns(habits, trip(), '2026-10-20', undefined);
    expect(r.a).toBeUndefined();
    expect([r.b, r.c]).toEqual([addDays('2026-10-20', 2), addDays('2026-10-20', 2)]);
    expect([r.d, r.e]).toEqual(['2026-10-24', '2026-10-24']);
    expect([r.f, r.g]).toEqual(['2026-10-26', '2026-10-26']);
  });

  it('uses the last day for a short ease, and nothing for a day trip or kept habits', () => {
    const habits = [habit({ id: 'a', streak: 5 } as Partial<Item>), habit({ id: 'b' })];
    expect(planReturns(habits, trip({ startsOn: '2026-10-17' }), '2026-10-20', undefined)).toEqual({ b: '2026-10-22' });
    expect(planReturns(habits, trip({ startsOn: '2026-10-19' }), '2026-10-20', undefined)).toEqual({});
    expect(planReturns(habits, trip({ keep: { ...EMPTY_KEEP, itemIds: ['a'] } }), '2026-10-20', undefined)).toEqual({});
  });

  it('never eases a task', () => {
    expect(planReturns([task(), task({ id: 'u' })], trip(), '2026-10-20', undefined)).toEqual({});
  });
});

describe('suggestKeeps', () => {
  it('suggests habits done on each of the last 30 days', () => {
    const every = Array.from({ length: 30 }, (_, i) => addDays('2026-10-11', -(i + 1)));
    const meds = habit({ id: 'meds', completedDates: every } as Partial<Item>);
    const gaps = habit({ id: 'gym', completedDates: every.slice(1) } as Partial<Item>);
    expect(suggestKeeps([meds, gaps, task()], '2026-10-11')).toEqual(['meds']);
  });
});

describe('tripTasks', () => {
  it('lists pending tasks dated inside the trip that were not kept', () => {
    const inside = task({ id: 'in', startDate: '2026-10-14' } as Partial<Item>);
    const before = task({ id: 'pre', startDate: '2026-10-10' } as Partial<Item>);
    const onEnd = task({ id: 'end', startDate: '2026-10-20' } as Partial<Item>);
    const done = task({ id: 'done', startDate: '2026-10-14', status: 'completed' } as Partial<Item>);
    const kept = task({ id: 'kept', startDate: '2026-10-14' } as Partial<Item>);
    const p = trip({ keep: { ...EMPTY_KEEP, itemIds: ['kept'] } });
    expect(tripTasks([inside, before, onEnd, done, kept, habit()], p, undefined).map((i) => i.id)).toEqual(['in']);
  });
});
