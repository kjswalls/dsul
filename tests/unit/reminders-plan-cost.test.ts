import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Item, Routine } from '@dsul/types';
import { planNotifications } from '@/lib/reminders/plan';
import { instantOf } from '@/lib/reminders/clock';

/**
 * What a plan costs, counted rather than timed: the plan runs on every local
 * write, every foreground and every day change, and an item under a pause
 * once asked wantsDoingOn about the same days for its series, for each of its
 * slots and again for each slot's later rings. Sixty paused habits took
 * seconds. Each item now asks about each day once.
 */
const asked = vi.hoisted(() => [] as string[]);

// Hoisted above the imports, so plan.ts's own './due' is this one.
vi.mock('@/lib/reminders/due', async (importOriginal) => {
  const due = await importOriginal<typeof import('@/lib/reminders/due')>();
  return {
    ...due,
    wantsDoingOn: (item: Item, dateStr: string, ctx: Parameters<typeof due.wantsDoingOn>[2]) => {
      asked.push(`${item.id}|${dateStr}`);
      return due.wantsDoingOn(item, dateStr, ctx);
    },
  };
});

const NY = 'America/New_York';
const MON = '2026-10-05';
const habit = (id: string, over: Record<string, unknown> = {}): Item =>
  ({
    type: 'habit', id, title: id, streak: 0, status: 'pending', completedDates: [], skippedDates: [],
    dailyCounts: {}, repeatFrequency: 'daily', reminderTime: '07:30', ...over,
  }) as Item;

describe('planNotifications: cost', () => {
  beforeEach(() => {
    asked.length = 0;
  });

  it('asks wantsDoingOn about each day at most once per item, and no further than a year', () => {
    const items = [
      habit('open', { pausedAt: '2026-10-01T12:00:00Z' }),
      habit('long', { pausedAt: '2026-10-01T12:00:00Z', pausedUntil: '2027-08-01' }),
      habit('six', { repeatFrequency: 'custom', repeatDays: [0, 1, 2, 3, 4, 5], pausedAt: '2026-10-01T12:00:00Z' }),
      habit('held', { completedDates: [MON] }),
      habit('member'),
    ];
    const routines = [{ id: 'r', name: 'r', itemIds: ['member'], pausedAt: '2026-10-01T12:00:00Z' } as Routine];
    planNotifications({ nowMs: instantOf(MON, 360, NY)!, timezone: NY, items, routines, remindersEnabled: true });
    // The open pause is walked through for a year, once.
    expect(asked.filter((a) => a.startsWith('open|'))).toHaveLength(366);
    expect(new Set(asked).size).toBe(asked.length);
    for (const item of items) {
      expect(asked.filter((a) => a.startsWith(`${item.id}|`)).length, item.id).toBeLessThanOrEqual(366);
    }
    // A held daily asks about its next month, not its next year.
    expect(asked.filter((a) => a.startsWith('held|')).length).toBeLessThanOrEqual(40);
  });
});
