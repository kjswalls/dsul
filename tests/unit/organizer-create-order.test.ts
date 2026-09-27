import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Organizer creates that write more than one row (Kirby, 2026-09-27):
 *
 *  1. A routine, season or goal the database REFUSES comes back out of the
 *     store and out of history — the project rollback, for every kind.
 *  2. A container born holding brand-new items waits for those items' INSERTs
 *     before writing the join rows that point at them (composite FKs).
 *  3. A routine born into seasons gets its season holds written only after
 *     its own row lands — all in one undo entry.
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
  createGoal: vi.fn(async () => {}),
  updateGoal: vi.fn(async () => {}),
  deleteGoal: vi.fn(async () => {}),
  restoreGoal: vi.fn(async () => {}),
  itemDbType: (item: { type: string; customType?: string }) =>
    item.type === 'custom' ? item.customType : item.type,
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));

const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }));

import { batchHistory, usePlannerStore } from '@/lib/planner-store';
import * as db from '@/lib/db';

const USER = 'user-1';
const store = () => usePlannerStore.getState();
const settle = () => new Promise((r) => setTimeout(r, 0));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(async () => {
  store().clearStore();
  vi.clearAllMocks();
  vi.mocked(db.fetchItems).mockResolvedValue([]);
  vi.mocked(db.fetchProjects).mockResolvedValue([]);
  vi.mocked(db.createItem).mockResolvedValue(undefined as never);
  vi.mocked(db.createRoutine).mockResolvedValue(undefined);
  vi.mocked(db.createSeason).mockResolvedValue(undefined);
  vi.mocked(db.createGoal).mockResolvedValue(undefined);
  vi.mocked(db.updateSeason).mockResolvedValue(undefined);
  await store().initializeStore(USER);
});

describe('a refused organizer create', () => {
  it('takes a routine back out, says so, and leaves no phantom for undo to revive', async () => {
    vi.mocked(db.createRoutine).mockRejectedValue(new Error('boom'));
    store().addRoutine({ name: 'Mornings', itemIds: [] });
    expect(store().routines).toHaveLength(1);
    await settle();
    expect(store().routines).toEqual([]);
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('Mornings'));
    store().undo();
    expect(store().routines).toEqual([]);
  });

  it('does the same for a season and a goal', async () => {
    vi.mocked(db.createSeason).mockRejectedValue(new Error('boom'));
    vi.mocked(db.createGoal).mockRejectedValue(new Error('boom'));
    store().addSeason({ name: 'Term', state: 'auto', itemIds: [], routineIds: [] });
    store().addGoal({ name: 'Run', state: 'active', memberIds: [], milestoneIds: [], checkinIds: [] });
    await settle();
    expect(store().seasons).toEqual([]);
    expect(store().goals).toEqual([]);
  });

  it('frees the seasons that were holding a refused routine', async () => {
    store().addSeason({ name: 'Term', state: 'auto', itemIds: [], routineIds: [] });
    await settle();
    vi.mocked(db.createRoutine).mockRejectedValue(new Error('boom'));
    store().addRoutine({ name: 'Mornings', itemIds: [] }, { seasonIds: [store().seasons[0].id] });
    expect(store().seasons[0].routineIds).toHaveLength(1);
    await settle();
    expect(store().seasons[0].routineIds).toEqual([]);
    expect(db.updateSeason).not.toHaveBeenCalled();
  });
});

describe('saves in order', () => {
  it('writes a goal only after its brand-new milestone has landed', async () => {
    const item = deferred();
    vi.mocked(db.createItem).mockReturnValue(item.promise as never);
    let goalId = '';
    batchHistory('Add goal: Run', 2, () => {
      const m = store().addTask({ title: 'Run 10k', completedDates: [], skippedDates: [] } as never);
      goalId = store().addGoal({ name: 'Run', state: 'active', memberIds: [], milestoneIds: [m], checkinIds: [] });
    });
    await settle();
    expect(db.createGoal).not.toHaveBeenCalled();
    item.resolve();
    await settle();
    expect(db.createGoal).toHaveBeenCalledWith(USER, expect.objectContaining({ id: goalId }));
    // One gesture, one entry.
    expect(store().actionLog.map((a) => a.label).filter((l) => l !== 'Session start')).toEqual(['Add goal: Run']);
  });

  it('writes a routine\'s season holds only after the routine lands, as one undo', async () => {
    store().addSeason({ name: 'Term', state: 'auto', itemIds: [], routineIds: [] });
    await settle();
    const routine = deferred();
    vi.mocked(db.createRoutine).mockReturnValue(routine.promise);
    const pid = store().seasons[0].id;
    const rid = store().addRoutine({ name: 'Mornings', itemIds: [] }, { seasonIds: [pid] });
    expect(store().seasons[0].routineIds).toEqual([rid]);
    await settle();
    expect(db.updateSeason).not.toHaveBeenCalled();
    routine.resolve();
    await settle();
    expect(db.updateSeason).toHaveBeenCalledWith(USER, pid, { routineIds: [rid] });

    store().undo();
    expect(store().routines).toEqual([]);
    expect(store().seasons[0].routineIds).toEqual([]);
  });

  it('keeps the routine when only the season hold fails, and says so', async () => {
    store().addSeason({ name: 'Term', state: 'auto', itemIds: [], routineIds: [] });
    await settle();
    vi.mocked(db.updateSeason).mockRejectedValue(new Error('boom'));
    store().addRoutine({ name: 'Mornings', itemIds: [] }, { seasonIds: [store().seasons[0].id] });
    await settle();
    await settle();
    expect(store().routines).toHaveLength(1);
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("couldn't be added to Term"));
  });
});

describe('the review\'s follow-ups', () => {
  it('queues an edit made while the create is still waiting, instead of losing it', async () => {
    const item = deferred();
    vi.mocked(db.createItem).mockReturnValue(item.promise as never);
    const m = store().addTask({ title: 'Stretch', completedDates: [], skippedDates: [] } as never);
    const rid = store().addRoutine({ name: 'Mornings', itemIds: [m] });
    store().updateRoutine(rid, { name: 'Early mornings' });
    await settle();
    expect(db.updateRoutine).not.toHaveBeenCalled();
    item.resolve();
    await settle();
    await settle();
    const createOrder = vi.mocked(db.createRoutine).mock.invocationCallOrder[0];
    const updateOrder = vi.mocked(db.updateRoutine).mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(updateOrder);
  });

  it('relabels the create that failed, not an older one with the same name', async () => {
    store().addRoutine({ name: 'Mornings', itemIds: [] });
    await settle();
    vi.mocked(db.createRoutine).mockRejectedValue(new Error('boom'));
    store().addRoutine({ name: 'Mornings', itemIds: [] });
    await settle();
    const labels = store().actionLog.map((a) => a.label);
    expect(labels.filter((l) => l === 'Add routine: Mornings')).toHaveLength(1);
    expect(labels).toContain('Couldn’t add routine: Mornings');
    expect(store().routines).toHaveLength(1);
  });

  it('says the new items were kept when the container is refused', async () => {
    vi.mocked(db.createGoal).mockRejectedValue(new Error('boom'));
    batchHistory('Add goal: Run', 2, () => {
      const m = store().addTask({ title: 'Run 10k', completedDates: [], skippedDates: [] } as never);
      store().addGoal({ name: 'Run', state: 'active', memberIds: [], milestoneIds: [m], checkinIds: [] }, { newItemCount: 1 });
    });
    await settle();
    await settle();
    expect(store().goals).toEqual([]);
    expect(store().items.map((i) => i.title)).toEqual(['Run 10k']);
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('1 new item was kept'));
  });
});
