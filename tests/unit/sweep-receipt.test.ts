import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same harness as undo-redo-store.test.ts: the db layer is fully mocked so
// these drive the real Zustand store, including the module-level history
// subscriber that decides what the undo toast sees.

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  createItemType: vi.fn(async () => {}),
  updateItemType: vi.fn(async () => {}),
  deleteItemType: vi.fn(async () => {}),
  createItem: vi.fn(async () => {}),
  updateItem: vi.fn(async () => {}),
  deleteItem: vi.fn(async () => {}),
  restoreItem: vi.fn(async () => {}),
  setItemCompletion: vi.fn(async () => {}),
  createProject: vi.fn(async () => {}),
  updateProject: vi.fn(async () => {}),
  deleteProject: vi.fn(async () => {}),
  restoreProject: vi.fn(async () => {}),
  fetchRoutines: vi.fn(async () => []),
  createRoutine: vi.fn(async () => {}),
  updateRoutine: vi.fn(async () => {}),
  deleteRoutine: vi.fn(async () => {}),
  restoreRoutine: vi.fn(async () => {}),
  fetchSeasons: vi.fn(async () => []),
  createSeason: vi.fn(async () => {}),
  updateSeason: vi.fn(async () => {}),
  deleteSeason: vi.fn(async () => {}),
  restoreSeason: vi.fn(async () => {}),
  fetchGoals: vi.fn(async () => []),
  // No RPC: the per-table fallback, started synchronously (the fetchers above).
  loadPlannerData: vi.fn((_u: string, perTable: () => Promise<unknown>) => perTable()),
  createGoal: vi.fn(async () => {}),
  updateGoal: vi.fn(async () => {}),
  deleteGoal: vi.fn(async () => {}),
  restoreGoal: vi.fn(async () => {}),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));

import { usePlannerStore } from '@/lib/planner-store';
import { useMorningStore } from '@/lib/morning-store';
import * as db from '@/lib/db';
import type { Item } from '@/lib/planner-types';

const USER = 'user-1';
const TODAY = '2026-08-11';

const scheduled = (id: string, startDate: string): Item => ({
  type: 'task',
  id,
  title: `Task ${id}`,
  status: 'pending',
  isScheduled: true,
  startDate,
  timeBucket: 'morning',
  startTime: '09:00',
  order: 0,
  completedDates: [],
});

const store = () => usePlannerStore.getState();
const morning = () => useMorningStore.getState();

beforeEach(async () => {
  store().clearStore();
  vi.clearAllMocks();
  vi.mocked(db.fetchItems).mockResolvedValue([
    scheduled('a', '2026-06-01'),
    scheduled('b', '2026-06-02'),
  ]);
  await store().initializeStore(USER);
  useMorningStore.setState({ morningAutoAgeReceiptByUser: {} });
});

/**
 * The sweep's receipt, end to end.
 *
 * The behaviour under test is the reason the receipt exists at all: hours after
 * an unattended write, "put those back" must still mean those specific rows.
 */
describe('the auto-age receipt round-trip', () => {
  it('restores exactly the fields the sweep cleared', () => {
    const before = store().items.filter((i) => i.type !== 'habit');
    const receipt = before.map((i) => ({
      id: i.id,
      isScheduled: 'isScheduled' in i ? !!i.isScheduled : false,
      startDate: 'startDate' in i ? i.startDate : undefined,
      timeBucket: i.timeBucket,
      startTime: i.startTime,
    }));

    store().unscheduleTasks(['a', 'b'], { label: 'Aged out: 2 items' });

    for (const item of store().items) {
      expect(item.isScheduled).toBe(false);
      expect(item.startDate).toBeUndefined();
      expect(item.timeBucket).toBeUndefined();
      expect(item.startTime).toBeUndefined();
    }

    store().restoreScheduling(receipt);

    const after = new Map(store().items.map((i) => [i.id, i]));
    expect(after.get('a')).toMatchObject({
      isScheduled: true,
      startDate: '2026-06-01',
      timeBucket: 'morning',
      startTime: '09:00',
    });
    expect(after.get('b')).toMatchObject({ startDate: '2026-06-02' });
  });

  it('survives unrelated work done in between — it is not a stack pop', () => {
    // The whole argument for restoreScheduling over undo(). The sweep happens,
    // the user does something else, and only then reads the line. An undo here
    // would reverse the rename, not the sweep.
    const receipt = [
      { id: 'a', isScheduled: true, startDate: '2026-06-01', timeBucket: 'morning', startTime: '09:00' },
    ];
    store().unscheduleTasks(['a'], { label: 'Aged out: 1 items' });
    store().updateTask('b', { title: 'Renamed since' });

    store().restoreScheduling(receipt);

    const after = new Map(store().items.map((i) => [i.id, i]));
    expect(after.get('a')).toMatchObject({ isScheduled: true, startDate: '2026-06-01' });
    // Untouched: the restore is addressed at ids, so it cannot reach past them.
    expect(after.get('b')?.title).toBe('Renamed since');
  });

  it('skips rows deleted since the sweep rather than resurrecting them', () => {
    const receipt = [
      { id: 'a', isScheduled: true, startDate: '2026-06-01' },
      { id: 'gone', isScheduled: true, startDate: '2026-06-05' },
    ];
    store().unscheduleTasks(['a'], { label: 'Aged out: 1 items' });

    store().restoreScheduling(receipt);

    expect(store().items.some((i) => i.id === 'gone')).toBe(false);
    expect(store().items.find((i) => i.id === 'a')).toMatchObject({ isScheduled: true });
  });

  it('is a no-op when every recorded row is gone', () => {
    const count = store().items.length;
    store().restoreScheduling([{ id: 'nobody', isScheduled: true }]);
    expect(store().items).toHaveLength(count);
  });
});

/**
 * The label override is the toast arbitration. `Unschedule task:` is a
 * SIGNIFICANT_ACTIONS prefix in hooks/use-undo-toast.ts and `Aged out:` is
 * deliberately not one — that is the entire mechanism by which the sweep stops
 * raising a five-second toast for something that happened before the tab opened.
 */
describe('the sweep’s history label', () => {
  // actionLog is exposed most-recent-FIRST (planner-store.ts:528), which is
  // also the order hooks/use-undo-toast.ts reads it in.
  const latest = () => store().actionLog[0]?.label;

  it('defaults to the toast-raising prefix for a user-initiated unschedule', () => {
    store().unscheduleTasks(['a', 'b']);
    expect(latest()).toMatch(/^Unschedule task:/);
  });

  it('takes the override, which matches no toast prefix', () => {
    store().unscheduleTasks(['a', 'b'], { label: 'Aged out: 2 items' });
    expect(latest()).toBe('Aged out: 2 items');
  });

  it('still writes a history entry, so ⌘Z reverses the sweep either way', () => {
    store().unscheduleTasks(['a', 'b'], { label: 'Aged out: 2 items' });
    expect(store().canUndo).toBe(true);
    store().undo();
    expect(store().items.every((i) => i.isScheduled)).toBe(true);
  });
});

describe('receipt storage', () => {
  it('is only readable on the day it was written', () => {
    morning().setAutoAgeReceipt(USER, { date: TODAY, items: [{ id: 'a', title: 'A', isScheduled: true }] });
    expect(morning().getAutoAgeReceipt(USER, TODAY)).not.toBeNull();
    // Left open across midnight: the write-side prune has not run, so the read
    // has to be the one that refuses.
    expect(morning().getAutoAgeReceipt(USER, '2026-08-12')).toBeNull();
  });

  it('prunes other days on write, so the map cannot accumulate', () => {
    morning().setAutoAgeReceipt('old-user', { date: '2026-08-01', items: [{ id: 'x', title: 'X', isScheduled: true }] });
    morning().setAutoAgeReceipt(USER, { date: TODAY, items: [{ id: 'a', title: 'A', isScheduled: true }] });
    expect(Object.keys(morning().morningAutoAgeReceiptByUser)).toEqual([USER]);
  });

  it('keeps a same-day receipt belonging to another account on this browser', () => {
    morning().setAutoAgeReceipt('other', { date: TODAY, items: [{ id: 'x', title: 'X', isScheduled: true }] });
    morning().setAutoAgeReceipt(USER, { date: TODAY, items: [{ id: 'a', title: 'A', isScheduled: true }] });
    expect(Object.keys(morning().morningAutoAgeReceiptByUser).sort()).toEqual(['other', USER]);
  });

  it('reads as nothing once cleared, and once emptied', () => {
    morning().setAutoAgeReceipt(USER, { date: TODAY, items: [{ id: 'a', title: 'A', isScheduled: true }] });
    morning().clearAutoAgeReceipt(USER);
    expect(morning().getAutoAgeReceipt(USER, TODAY)).toBeNull();

    morning().setAutoAgeReceipt(USER, { date: TODAY, items: [] });
    expect(morning().getAutoAgeReceipt(USER, TODAY)).toBeNull();
  });
});
