import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same harness as sweep-receipt.test.ts: the db layer is fully mocked so the
// verb tests drive the real Zustand store.
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
import * as db from '@/lib/db';
import { planFiling, selectFilingCandidates } from '@/lib/completion-filing';
import type { Item } from '@/lib/planner-types';

const USER = 'user-1';
const TODAY = '2026-09-27';
const TZ = 'America/Los_Angeles';

const task = (id: string, over: Partial<Item> = {}): Item =>
  ({
    type: 'task',
    id,
    title: `Task ${id}`,
    status: 'completed',
    isScheduled: false,
    order: 0,
    completedDates: [],
    ...over,
  }) as Item;

const none = { milestones: new Set<string>(), inactive: new Set<string>() };

describe('selectFilingCandidates — finished one-offs in the braindump', () => {
  it('takes a completed, dateless, unbucketed one-off', () => {
    expect(selectFilingCandidates([task('a')], none).map((i) => i.id)).toEqual(['a']);
  });

  it('leaves open items where they are', () => {
    expect(selectFilingCandidates([task('a', { status: 'pending' })], none)).toEqual([]);
  });

  it('leaves anything already on a day alone', () => {
    const items = [
      task('bucketed', { timeBucket: 'morning' }),
      task('scheduled', { isScheduled: true, timeBucket: 'afternoon', startTime: '14:00' }),
    ];
    expect(selectFilingCandidates(items, none)).toEqual([]);
  });

  it('never files a recurring item — it never finishes as a whole', () => {
    expect(selectFilingCandidates([task('r', { repeatFrequency: 'daily' } as Partial<Item>)], none)).toEqual([]);
  });

  it('never files a subtask — it follows its parent', () => {
    expect(selectFilingCandidates([task('s', { parentItemId: 'p' } as Partial<Item>)], none)).toEqual([]);
  });

  it('never files a habit', () => {
    const habit = {
      type: 'habit',
      id: 'h',
      title: 'Habit',
      status: 'done',
      project: '',
      streak: 0,
      completedDates: [],
      skippedDates: [],
      dailyCounts: {},
      repeatFrequency: 'none',
    } as unknown as Item;
    expect(selectFilingCandidates([habit], none)).toEqual([]);
  });

  it('refuses milestones and suppressed items', () => {
    const items = [task('m'), task('p'), task('ok')];
    const picked = selectFilingCandidates(items, {
      milestones: new Set(['m']),
      inactive: new Set(['p']),
    });
    expect(picked.map((i) => i.id)).toEqual(['ok']);
  });
});

describe('planFiling — the day it was finished, in the user’s zone', () => {
  it('files a completion from before today onto its local day', () => {
    const stamps = new Map([['a', '2026-09-20T18:00:00Z']]);
    expect(planFiling([task('a')], stamps, TODAY, TZ)).toEqual([{ id: 'a', date: '2026-09-20' }]);
  });

  it('keeps today’s completions in the braindump until the day turns', () => {
    const stamps = new Map([['a', '2026-09-27T17:00:00Z']]);
    expect(planFiling([task('a')], stamps, TODAY, TZ)).toEqual([]);
  });

  it('resolves the day in the user’s timezone, not UTC', () => {
    // 05:30 UTC on the 27th is 22:30 on the 26th in Los Angeles.
    const stamps = new Map([['late', '2026-09-27T05:30:00Z']]);
    expect(planFiling([task('late')], stamps, TODAY, TZ)).toEqual([
      { id: 'late', date: '2026-09-26' },
    ]);
  });

  it('leaves an unstamped or unparseable row where it is rather than guess', () => {
    const stamps = new Map([['bad', 'not a date']]);
    expect(planFiling([task('none'), task('bad')], stamps, TODAY, TZ)).toEqual([]);
  });
});

describe('fileCompletedToDays — the store verb', () => {
  const store = () => usePlannerStore.getState();

  beforeEach(async () => {
    store().clearStore();
    vi.clearAllMocks();
    vi.mocked(db.fetchItems).mockResolvedValue([task('a'), task('b')]);
    await store().initializeStore(USER);
  });

  it('dates each item to its own day, untimed, in the anytime bucket', () => {
    store().fileCompletedToDays([
      { id: 'a', date: '2026-09-20' },
      { id: 'b', date: '2026-09-22' },
    ]);
    const byId = new Map(store().items.map((i) => [i.id, i]));
    expect(byId.get('a')).toMatchObject({ startDate: '2026-09-20', timeBucket: 'anytime', isScheduled: false });
    expect(byId.get('b')).toMatchObject({ startDate: '2026-09-22', timeBucket: 'anytime', isScheduled: false });
    expect(byId.get('a')?.startTime).toBeUndefined();
    expect(db.updateItem).toHaveBeenCalledTimes(2);
    expect(db.updateItem).toHaveBeenCalledWith(
      'a',
      'task',
      expect.objectContaining({ startDate: '2026-09-20', timeBucket: 'anytime' }),
    );
  });

  it('is one undo, and the undo puts both back in the braindump', () => {
    store().fileCompletedToDays([
      { id: 'a', date: '2026-09-20' },
      { id: 'b', date: '2026-09-22' },
    ]);
    store().undo();
    for (const item of store().items) {
      expect(item).toMatchObject({ isScheduled: false });
      expect(item.timeBucket).toBeUndefined();
      expect((item as { startDate?: string }).startDate).toBeUndefined();
    }
  });

  it('does not raise the undo toast — it ran unattended', () => {
    store().fileCompletedToDays([{ id: 'a', date: '2026-09-20' }]);
    const label = store().actionLog[0]?.label ?? '';
    expect(label.startsWith('Filed finished items')).toBe(true);
  });

  it('writes nothing for an unknown id', () => {
    store().fileCompletedToDays([{ id: 'ghost', date: '2026-09-20' }]);
    expect(db.updateItem).not.toHaveBeenCalled();
  });
});
