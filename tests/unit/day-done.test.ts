import { describe, it, expect } from 'vitest';

import { isDayCleared } from '@/lib/day-done';
import type { ActivationContext } from '@/lib/active';
import type { Item, Routine, Season } from '@dsul/types';

/**
 * "Is today cleared?" (lib/day-done.ts) — what turns the tab Lime.
 *
 * Two conditions: nothing that occurs and is active today is still open, and
 * at least one thing was genuinely done. A skip or a cancel never holds the
 * day open, but it never earns it either.
 */

const TZ = 'America/New_York';
const ctx: ActivationContext = { userTimezone: TZ };
const DAY = '2026-08-10';
const YESTERDAY = '2026-08-09';
// Noon UTC, so the pause starts on DAY in New York too.
const PAUSED_AT = '2026-08-05T12:00:00Z';

const habit = (over: Partial<Item> = {}): Item => ({
  type: 'habit', id: 'h', title: 'Vitamins', project: 'G', streak: 0, status: 'pending',
  completedDates: [], skippedDates: [], dailyCounts: {}, repeatFrequency: 'daily',
  ...over,
} as Item);

const task = (over: Partial<Item> = {}): Item => ({
  type: 'task', id: 't', title: 'File taxes', status: 'pending', isScheduled: false, order: 0,
  startDate: DAY,
  ...over,
} as Item);

describe('isDayCleared', () => {
  it('is true when every item that occurs today is done', () => {
    const items = [habit({ completedDates: [DAY] }), task({ status: 'completed' })];
    expect(isDayCleared(items, DAY, ctx)).toBe(true);
  });

  it('is false while one item is still pending', () => {
    const items = [habit({ completedDates: [DAY] }), task()];
    expect(isDayCleared(items, DAY, ctx)).toBe(false);
  });

  // An empty day is not an accomplishment; Lime is earned.
  it('is false on an empty day', () => {
    expect(isDayCleared([], DAY, ctx)).toBe(false);
  });

  it('ignores a paused item, which the grid has hidden', () => {
    const items = [habit({ completedDates: [DAY] }), task({ id: 'p', pausedAt: PAUSED_AT })];
    expect(isDayCleared(items, DAY, ctx)).toBe(true);
  });

  it('ignores an item held by a paused routine', () => {
    const routine: Routine = { id: 'r', name: 'Morning', itemIds: ['h2'], pausedAt: PAUSED_AT };
    const items = [habit({ completedDates: [DAY] }), habit({ id: 'h2' })];
    expect(isDayCleared(items, DAY, { ...ctx, routines: [routine] })).toBe(true);
  });

  it('ignores an item held by a paused season', () => {
    const season = { id: 's', name: 'Summer', state: 'paused', itemIds: ['h2'], routineIds: [] } as Season;
    const items = [habit({ completedDates: [DAY] }), habit({ id: 'h2' })];
    expect(isDayCleared(items, DAY, { ...ctx, seasons: [season] })).toBe(true);
  });

  it('holds a counted habit open below its target and clears it at the target', () => {
    const below = habit({ timesPerDay: 3, dailyCounts: { [DAY]: 2 } } as Partial<Item>);
    const at = habit({ timesPerDay: 3, dailyCounts: { [DAY]: 3 } } as Partial<Item>);
    expect(isDayCleared([below], DAY, ctx)).toBe(false);
    expect(isDayCleared([at], DAY, ctx)).toBe(true);
  });

  it('ignores an undated braindump task', () => {
    const items = [habit({ completedDates: [DAY] }), task({ id: 'b', startDate: undefined })];
    expect(isDayCleared(items, DAY, ctx)).toBe(true);
  });

  it("ignores an overdue task from yesterday — it belongs to yesterday's day", () => {
    const items = [habit({ completedDates: [DAY] }), task({ id: 'o', startDate: YESTERDAY })];
    expect(isDayCleared(items, DAY, ctx)).toBe(true);
  });

  it('ignores a subtask; its parent is the row the day draws', () => {
    const items = [task({ status: 'completed' }), task({ id: 'sub', parentItemId: 't' })];
    expect(isDayCleared(items, DAY, ctx)).toBe(true);
  });

  it("is false today when only yesterday's items were cleared", () => {
    const items = [habit({ completedDates: [YESTERDAY] }), task({ id: 'y', startDate: YESTERDAY, status: 'completed' })];
    expect(isDayCleared(items, YESTERDAY, ctx)).toBe(true);
    expect(isDayCleared(items, DAY, ctx)).toBe(false);
  });

  it('lets a skip sit beside a real completion', () => {
    const items = [habit({ completedDates: [DAY] }), habit({ id: 'h2', skippedDates: [DAY] })];
    expect(isDayCleared(items, DAY, ctx)).toBe(true);
  });

  it('is false on a day of nothing but skips', () => {
    const items = [habit({ skippedDates: [DAY] }), habit({ id: 'h2', skippedDates: [DAY] })];
    expect(isDayCleared(items, DAY, ctx)).toBe(false);
  });

  it('is false on a day of nothing but cancellations', () => {
    expect(isDayCleared([task({ status: 'cancelled' })], DAY, ctx)).toBe(false);
  });

  it("asks the registry for a one-shot item's done status, so a one-off skip earns nothing", () => {
    const oneOff = (status: string) =>
      habit({ repeatFrequency: 'none', startDate: DAY, status } as Partial<Item>);
    expect(isDayCleared([oneOff('skipped')], DAY, ctx)).toBe(false);
    expect(isDayCleared([oneOff('done')], DAY, ctx)).toBe(true);
  });
});
