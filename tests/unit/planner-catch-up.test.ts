import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Catching up with other devices (planner-store `catchUpPlanner`). The planner
 * re-reads the server when it is looked at again and folds in what changed
 * elsewhere. The fold is the server's news, never the user's action: no undo
 * entry, no write-back, and nothing this tab changed and has not saved yet is
 * put back to the server's older value.
 *
 * The db layer is fully mocked (agent-freshness.test.tsx's pattern), so the
 * real store and its history subscriber run, and every write is observed.
 */

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
  changeItemType: vi.fn(async () => {}),
  restoreItem: vi.fn(async () => {}),
  setItemCompletion: vi.fn(async () => {}),
  createProject: vi.fn(async () => {}),
  updateProject: vi.fn(async () => {}),
  deleteProject: vi.fn(async () => {}),
  restoreProject: vi.fn(async () => {}),
  renameContainerMembers: vi.fn(async () => {}),
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
  loadPlannerData: vi.fn((_u: string, perTable: () => Promise<unknown>) => perTable()),
  createGoal: vi.fn(async () => {}),
  updateGoal: vi.fn(async () => {}),
  deleteGoal: vi.fn(async () => {}),
  restoreGoal: vi.fn(async () => {}),
  fetchAgentStates: vi.fn(async () => []),
  itemDbType: (i: { type: string; customType?: string }) => (i.type === 'custom' ? i.customType : i.type),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));

import { catchUpPlanner, usePlannerStore } from '@/lib/planner-store';
import * as db from '@/lib/db';
import type { Item, Project, TaskItem } from '@/lib/planner-types';

const USER = 'user-1';

const task = (id: string, over: Partial<TaskItem> = {}): Item => ({
  type: 'task',
  id,
  title: id,
  status: 'pending',
  isScheduled: false,
  order: 0,
  completedDates: [],
  ...over,
} as Item);

const project = (id: string, name: string): Project => ({ id, name } as Project);

const store = () => usePlannerStore.getState();
const byId = (id: string) => store().items.find((i) => i.id === id) as TaskItem | undefined;

/** What the server answers on the next read. */
function serverHas(items: Item[], projects: Project[] = [project('p1', 'Work')]) {
  vi.mocked(db.fetchItems).mockResolvedValue(JSON.parse(JSON.stringify(items)));
  vi.mocked(db.fetchProjects).mockResolvedValue(JSON.parse(JSON.stringify(projects)));
}

const loaded = () => [task('a', { title: 'Call mum' }), task('b', { title: 'Buy milk' })];

beforeEach(async () => {
  store().clearStore();
  vi.clearAllMocks();
  serverHas(loaded());
  await store().initializeStore(USER);
});

describe('catchUpPlanner', () => {
  it('takes a change made elsewhere, with no undo entry and no write', async () => {
    const { historyIndex, canUndo } = store();
    serverHas([task('a', { title: 'Call mum back' }), task('b', { title: 'Buy milk' })]);

    expect(await catchUpPlanner()).toEqual(['a']);

    expect(byId('a')?.title).toBe('Call mum back');
    expect(store().tasks.find((t) => t.id === 'a')?.title).toBe('Call mum back');
    expect(store().historyIndex).toBe(historyIndex);
    expect(store().canUndo).toBe(canUndo);
    expect(db.updateItem).not.toHaveBeenCalled();
  });

  it('keeps a change made here that the server has not seen yet', async () => {
    store().updateTask('a', { title: 'Call dad' });
    // The save is still on its way: the server reads as it did at load.
    serverHas(loaded());

    expect(await catchUpPlanner()).toEqual([]);
    expect(byId('a')?.title).toBe('Call dad');
  });

  it('merges field by field: their field taken, this tab’s field kept', async () => {
    store().updateTask('a', { title: 'Call dad' });
    serverHas([task('a', { title: 'Call mum', notes: 'after lunch' }), task('b', { title: 'Buy milk' })]);

    await catchUpPlanner();
    expect(byId('a')).toMatchObject({ title: 'Call dad', notes: 'after lunch' });
  });

  it('adds an item made elsewhere and drops one deleted elsewhere', async () => {
    serverHas([task('a', { title: 'Call mum' }), task('c', { title: 'Book dentist' })]);

    await catchUpPlanner();
    expect(byId('b')).toBeUndefined();
    expect(byId('c')?.title).toBe('Book dentist');
    expect(db.deleteItem).not.toHaveBeenCalled();
    expect(db.createItem).not.toHaveBeenCalled();
  });

  it('never drops an item made here before its insert lands, nor brings back one deleted here', async () => {
    store().addTask({ title: 'New here', isScheduled: false } as never);
    const added = store().items.find((i) => i.title === 'New here');
    expect(added).toBeDefined();
    store().deleteTask('b');
    // Neither write has reached the server yet.
    serverHas(loaded());

    await catchUpPlanner();
    expect(byId(added!.id)).toBeDefined();
    expect(byId('b')).toBeUndefined();
  });

  it('an undo after a catch-up takes back only this tab’s own edit', async () => {
    store().updateTask('b', { title: 'Buy oat milk' });
    serverHas([task('a', { title: 'Call mum back' }), task('b', { title: 'Buy oat milk' })]);
    await catchUpPlanner();
    vi.mocked(db.updateItem).mockClear();

    store().undo();

    expect(byId('b')?.title).toBe('Buy milk');
    expect(byId('a')?.title).toBe('Call mum back');
    const writes = JSON.stringify(vi.mocked(db.updateItem).mock.calls);
    expect(writes).toContain('Buy milk');
    expect(writes).not.toContain('Call mum');
  });

  it('an undo never brings back an item deleted elsewhere, nor removes one added elsewhere', async () => {
    store().updateTask('a', { title: 'Call dad' });
    serverHas([task('a', { title: 'Call dad' }), task('c', { title: 'Book dentist' })]);
    await catchUpPlanner();

    store().undo();

    expect(byId('a')?.title).toBe('Call mum');
    expect(byId('b')).toBeUndefined();
    expect(byId('c')).toBeDefined();
    expect(db.restoreItem).not.toHaveBeenCalled();
    expect(db.deleteItem).not.toHaveBeenCalled();
  });

  it('leaves a held item alone, and takes its change on the next catch-up', async () => {
    serverHas([task('a', { title: 'Call mum back' }), task('b', { title: 'Buy milk' })]);
    await catchUpPlanner({ heldItemIds: () => new Set(['a']) });
    expect(byId('a')?.title).toBe('Call mum');

    await catchUpPlanner();
    expect(byId('a')?.title).toBe('Call mum back');
  });

  it('takes a container renamed elsewhere', async () => {
    serverHas(loaded(), [project('p1', 'Day job')]);

    await catchUpPlanner();
    expect(store().projects.find((p) => p.id === 'p1')?.name).toBe('Day job');
    expect(db.updateProject).not.toHaveBeenCalled();
  });

  it('does nothing for a signed-out store', async () => {
    store().clearStore();
    serverHas([task('z')]);
    expect(await catchUpPlanner()).toEqual([]);
    expect(store().items).toEqual([]);
  });
});

describe('heldItemIds', () => {
  it('holds the item open over the phone’s Ask tab', async () => {
    const { heldItemIds } = await import('@/hooks/use-planner-catch-up');
    const { useRailStore } = await import('@/lib/rail-store');
    const before = useRailStore.getState().stacks;
    useRailStore.setState({ stacks: { ...before, phone: [...before.phone, { kind: 'item', itemId: 'a' }] } });
    try {
      expect(heldItemIds().has('a')).toBe(true);
    } finally {
      useRailStore.setState({ stacks: before });
    }
  });
});
