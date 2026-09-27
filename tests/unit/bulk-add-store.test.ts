import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * addTasksBulk — the paste-a-list store verb.
 *
 * The contract under test is the one every bulk verb holds (#205 / Phase 5):
 * one gesture, one set(), one history entry, one ⌘Z — and, specific to this
 * verb, ONE batch INSERT on the wire rather than N createItem calls, because
 * N parallel fire-and-forget inserts widen the undo-races-insert window
 * N-fold (see createItems in lib/db.ts).
 */

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  createItemType: vi.fn(async () => {}),
  updateItemType: vi.fn(async () => {}),
  deleteItemType: vi.fn(async () => {}),
  createItem: vi.fn(async () => {}),
  createItems: vi.fn(async () => {}),
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
  createGoal: vi.fn(async () => {}),
  updateGoal: vi.fn(async () => {}),
  deleteGoal: vi.fn(async () => {}),
  restoreGoal: vi.fn(async () => {}),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));

import { usePlannerStore, getActionLog } from '@/lib/planner-store';
import * as db from '@/lib/db';
import type { Item, ItemTypeDef, TaskItem } from '@/lib/planner-types';

const USER = 'user-1';

const store = () => usePlannerStore.getState();

const seededTask = (id: string, order: number): Item =>
  ({
    type: 'task',
    id,
    title: `Task ${id}`,
    status: 'pending',
    isScheduled: false,
    order,
    completedDates: [],
    skippedDates: [],
  }) as Item;

function seed(over: Partial<Parameters<typeof usePlannerStore.setState>[0]> = {}) {
  usePlannerStore.setState({
    userId: USER,
    userTimezone: 'UTC',
    items: [],
    tasks: [],
    habits: [],
    projects: [{ id: 'proj-1', name: 'Groceries', emoji: '🛒' }],
    itemTypes: [],
    ...over,
  });
}

const bulk = () => store().addTasksBulk;
const taskItems = () => store().items.filter((i): i is TaskItem => i.type === 'task');

describe('addTasksBulk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed();
  });

  it('creates every row in one set() and one history entry', () => {
    const before = getActionLog().length;
    bulk()('task', [{ title: 'one' }, { title: 'two' }, { title: 'three' }]);

    expect(taskItems().map((t) => t.title)).toEqual(['one', 'two', 'three']);
    expect(getActionLog().length).toBe(before + 1);
    expect(getActionLog()[0].label).toBe('Bulk add: 3 items');
  });

  it('issues ONE batch insert, not one create per row', () => {
    bulk()('task', [{ title: 'one' }, { title: 'two' }]);
    expect(db.createItems).toHaveBeenCalledTimes(1);
    expect(db.createItem).not.toHaveBeenCalled();
    const [, rows] = vi.mocked(db.createItems).mock.calls[0];
    expect(rows).toHaveLength(2);
  });

  it('stamps sequential order continuing from the existing tasks', () => {
    seed({
      items: [seededTask('a', 0), seededTask('b', 1)],
      tasks: [seededTask('a', 0), seededTask('b', 1)] as TaskItem[],
    });
    bulk()('task', [{ title: 'one' }, { title: 'two' }]);
    const added = taskItems().slice(2);
    expect(added.map((t) => t.order)).toEqual([2, 3]);
  });

  it('fills defaults and resolves the project id', () => {
    bulk()('task', [
      { title: 'milk', project: 'Groceries', startDate: '2026-08-24', timeBucket: 'anytime' },
      { title: 'stray' },
    ]);
    const [milk, stray] = taskItems();
    expect(milk.status).toBe('pending');
    expect(milk.projectId).toBe('proj-1');
    expect(milk.isScheduled).toBe(true);
    expect(stray.projectId).toBeUndefined();
    expect(stray.isScheduled).toBe(false);
  });

  it('one undo removes the whole paste', () => {
    bulk()('task', [{ title: 'one' }, { title: 'two' }, { title: 'three' }]);
    expect(store().items).toHaveLength(3);
    store().undo();
    expect(store().items).toHaveLength(0);
  });

  it('a single row delegates to addTask and keeps its natural label', () => {
    bulk()('task', [{ title: 'only one' }]);
    expect(getActionLog()[0].label).toBe('Add task: only one');
    expect(db.createItem).toHaveBeenCalledTimes(1);
    expect(db.createItems).not.toHaveBeenCalled();
  });

  it('creates custom-type rows under the envelope, order 0, one insert each', async () => {
    seed({
      itemTypes: [{ id: 't1', name: 'errand', label: 'Errand', labelPlural: 'Errands' } as ItemTypeDef],
    });
    bulk()('errand', [{ title: 'post office' }, { title: 'dry cleaning' }]);
    const items = store().items;
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.type === 'custom' && i.customType === 'errand')).toBe(true);
    // Order stays 0 (registry: created_at sorts custom types) — which is why
    // these go over the wire one at a time rather than in the batch statement:
    // a single INSERT stamps one created_at across the paste and the order
    // would scramble on reload.
    expect(items.every((i) => i.type === 'custom' && i.order === 0)).toBe(true);
    await vi.waitFor(() => expect(db.createItem).toHaveBeenCalledTimes(2));
    expect(db.createItems).not.toHaveBeenCalled();
  });

  it("refuses 'habit', 'custom', and unhydrated slugs outright", () => {
    for (const type of ['habit', 'custom', 'no-such-type']) {
      bulk()(type, [{ title: 'a' }, { title: 'b' }]);
    }
    expect(store().items).toHaveLength(0);
    expect(db.createItems).not.toHaveBeenCalled();
  });

  it('does nothing with an empty array', () => {
    const before = getActionLog().length;
    bulk()('task', []);
    expect(getActionLog().length).toBe(before);
    expect(db.createItems).not.toHaveBeenCalled();
  });
});
