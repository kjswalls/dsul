import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `restoreFromTrash` — the store half of Phase 4.
 *
 * Decision 3: "Restore participates in undo. A Trash restore stamps a normal
 * history entry; ⌘Z after a restore re-deletes the row." That contract is
 * carried entirely by HOW the action writes, and there are exactly two ways to
 * get it wrong — both silent, both tested here.
 *
 * TRAP A — a label armed with no state change. `setNextActionLabel` sets a
 * module-level variable that only `saveToHistory` consumes, and `saveToHistory`
 * runs only when the subscriber sees the snapshot JSON actually move. Label a
 * restore that turns out to be a no-op and the string stays armed: the user's
 * NEXT unrelated edit is logged, undone and receipted as "Restore project:
 * Work".
 *
 * TRAP B — two set() calls. The second produces a history entry the label has
 * already been spent on, so it logs as "Unknown action" and ⌘Z undoes half the
 * restore — the container goes back in the bin while its members stay re-filed.
 *
 * These tests drive the REAL store, including its module-level history
 * subscriber, because both traps live in the interaction between set() and that
 * subscriber. A mocked action would prove only that a button is wired to a name.
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
  // No RPC: the per-table fallback, started synchronously (the fetchers above).
  loadPlannerData: vi.fn((_u: string, perTable: () => Promise<unknown>) => perTable()),
  createGoal: vi.fn(async () => {}),
  updateGoal: vi.fn(async () => {}),
  deleteGoal: vi.fn(async () => {}),
  restoreGoal: vi.fn(async () => {}),
  itemDbType: (item: { type: string; customType?: string }) =>
    item.type === 'custom' ? item.customType : item.type,
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));

import { usePlannerStore } from '@/lib/planner-store';
import * as db from '@/lib/db';
import type { TrashEntry } from '@/lib/db';
import type { Item, Project, Routine } from '@/lib/planner-types';

const USER = 'user-1';
const store = () => usePlannerStore.getState();
/** The action log is newest-first. */
const latestLabel = () => store().actionLog[0]?.label;

/** `Item` is a union and a habit carries no `project`, so narrow before reading. */
const filed = (id: string) => {
  const found = store().items.find((i) => i.id === id);
  if (!found) throw new Error(`no item ${id}`);
  if (found.type === 'habit') throw new Error(`${id} is a habit, not a task-like item`);
  return found;
};

const task = (over: Partial<Item> = {}): Item =>
  ({
    type: 'task', id: 'task-1', title: 'Write tests', status: 'pending',
    isScheduled: false, order: 0, completedDates: [], ...over,
  }) as Item;

const project: Project = { id: 'pr-1', name: 'Work', emoji: 'icon:Briefcase' };

const entry = (over: Partial<TrashEntry>): TrashEntry =>
  ({
    kind: 'project', id: 'pr-1', name: 'Work',
    deletedAt: '2026-08-12T10:00:00.000Z', entity: project, ...over,
  }) as TrashEntry;

beforeEach(async () => {
  store().clearStore();
  vi.clearAllMocks();
  vi.mocked(db.fetchItems).mockResolvedValue([]);
  vi.mocked(db.fetchProjects).mockResolvedValue([]);
  await store().initializeStore(USER);
});

describe('restoreFromTrash — the history contract (decision 3)', () => {
  it('stamps a NAMED history entry, never "Unknown action"', () => {
    store().restoreFromTrash(entry({}));
    expect(latestLabel()).toBe('Restore project: Work');
  });

  it('names the kind, because the bin is the one list that mixes them', () => {
    // 'group' left TrashKind with the classify kind (039) — a former habit
    // group is in the bin as a 'project', because the migration moved the row
    // rather than orphaning it in a table nothing reads.
    store().restoreFromTrash(
      entry({ kind: 'routine', id: 'r-1', name: 'Morning', entity: { id: 'r-1', name: 'Morning', itemIds: [] } })
    );
    expect(latestLabel()).toBe('Restore routine: Morning');
  });

  it('⌘Z after a restore re-deletes the row — the gate, in the store', () => {
    store().restoreFromTrash(entry({}));
    expect(store().projects.map((p) => p.id)).toEqual(['pr-1']);

    store().undo();

    expect(store().projects).toEqual([]);
    expect(db.deleteProject).toHaveBeenCalledWith(USER, 'pr-1');
  });

  it('is ONE history entry, so one ⌘Z takes the whole restore back (trap B)', async () => {
    // The member has to EXIST for this test to mean anything. With an empty
    // items array the re-file is a no-op, the second set() would be
    // JSON-identical to the first, and a two-set() implementation would sail
    // through — which is exactly what a first draft of this did.
    vi.mocked(db.fetchItems).mockResolvedValue([task({ id: 'task-1' })]);
    store().clearStore();
    await store().initializeStore(USER);

    const before = store().actionLog.length;
    store().restoreFromTrash(entry({ memberIds: ['task-1'] }));

    expect(store().actionLog.length - before).toBe(1);
    expect(store().actionLog.filter((a) => a.label === 'Unknown action')).toHaveLength(0);

    // And the whole thing comes back in one press — not the container alone
    // with its members left re-filed.
    store().undo();
    expect(store().projects).toEqual([]);
    expect(filed('task-1').project).toBeUndefined();
  });
});

describe('restoreFromTrash — trap A: an armed label with no state change', () => {
  /**
   * The mechanism, tested directly with a labelless mutation.
   *
   * Going through a real second action would prove nothing: almost every store
   * action arms its OWN label before its set(), which overwrites a stale one —
   * a first draft of this test did exactly that and stayed green with the guard
   * removed. What a stale label actually lands on is a mutation that does not
   * label itself, so that is what this drives. `cleanupOrphanedReferences` is
   * the shape of thing in the real store (it rebuilds `items` with no label),
   * and setState stands in for it without depending on an action that today has
   * no callers.
   *
   * Same variable also holds `pendingActionReceipt`, so a stale label means a
   * wrong undo-toast title as well as a wrong log line.
   */
  it('leaves no label armed when the row is already back', () => {
    store().restoreFromTrash(entry({}));
    expect(latestLabel()).toBe('Restore project: Work');

    // Second click on a stale bin row: nothing changes, nothing to label.
    store().restoreFromTrash(entry({}));

    usePlannerStore.setState({ items: [task({ id: 'unrelated' })] });
    expect(latestLabel()).toBe('Unknown action');
  });

  it('writes nothing to the database for a row that is already back', () => {
    store().restoreFromTrash(entry({}));
    vi.mocked(db.restoreProject).mockClear();
    store().restoreFromTrash(entry({}));
    expect(db.restoreProject).not.toHaveBeenCalled();
  });

  it('does not seat the row twice', () => {
    store().restoreFromTrash(entry({}));
    store().restoreFromTrash(entry({}));
    expect(store().projects.filter((p) => p.id === 'pr-1')).toHaveLength(1);
  });
});

describe('restoreFromTrash — what comes back with it', () => {
  it('re-files the members the DB link kept, in the same set()', async () => {
    // removeProject clears the store's copy and writes nothing to items, so the
    // link survives the delete on purpose (027). listDeleted reads it back;
    // without this the restored project comes back visibly empty until reload.
    vi.mocked(db.fetchItems).mockResolvedValue([task({ id: 'task-1' })]);
    store().clearStore();
    await store().initializeStore(USER);

    store().restoreFromTrash(entry({ memberIds: ['task-1'] }));

    const restored = filed('task-1');
    expect(restored.project).toBe('Work');
    expect(restored.projectId).toBe('pr-1');
  });

  it('re-files a habit member exactly as it re-files a task', async () => {
    // This used to be the group-side twin, guarded on `type === 'habit'` so a
    // restored habit group wrote `group` and a restored project wrote
    // `project`. One CLASSIFY axis (039) means one branch and one column: the
    // restore re-files EVERY member id it was given, whatever their types.
    //
    // The re-file is still load-bearing rather than cosmetic. `removeProject`
    // reassigns a habit to a fallback container while `dbDeleteProject` only
    // stamps deleted_at, so the project_id link survives and the store's copy
    // is a lie until reload; without this the restored container comes back
    // empty and its habits stay filed under "Personal".
    const habit = {
      type: 'habit', id: 'h-1', title: 'Stretch', project: 'Personal', projectId: 'g-old',
      status: 'pending', streak: 0, completedDates: [], skippedDates: [],
      dailyCounts: {}, repeatFrequency: 'daily',
    } as unknown as Item;
    vi.mocked(db.fetchItems).mockResolvedValue([habit, task({ id: 'task-1' })]);
    store().clearStore();
    await store().initializeStore(USER);

    store().restoreFromTrash(
      entry({
        kind: 'project', id: 'pr-1', name: 'Wellness',
        entity: { id: 'pr-1', name: 'Wellness', emoji: 'icon:Heart' },
        memberIds: ['h-1', 'task-1'],
      })
    );

    const back = store().items.find((i) => i.id === 'h-1')!;
    expect(back.project).toBe('Wellness');
    expect(back.projectId).toBe('pr-1');
    // …and the task named alongside it comes back too, which is the half the
    // old type guard made impossible.
    expect(filed('task-1').project).toBe('Wellness');
    expect(filed('task-1').projectId).toBe('pr-1');
  });

  it('leaves items that were never members alone', async () => {
    vi.mocked(db.fetchItems).mockResolvedValue([task({ id: 'task-1' }), task({ id: 'task-2' })]);
    store().clearStore();
    await store().initializeStore(USER);

    store().restoreFromTrash(entry({ memberIds: ['task-1'] }));

    expect(filed('task-2').project).toBeUndefined();
  });

  it('seats a restored item and its co-deleted subtasks together', () => {
    const parent = task({ id: 'parent', title: 'Plan trip' });
    const kid = task({ id: 'kid', title: 'Book flight', parentItemId: 'parent' });

    store().restoreFromTrash(
      entry({ kind: 'item', id: 'parent', name: 'Plan trip', entity: parent, children: [kid] })
    );

    expect(store().items.map((i) => i.id).sort()).toEqual(['kid', 'parent']);
    // The projections rebuild in the same set(): a subtask must NOT surface as
    // a free-floating task, and the parent must.
    expect(store().tasks.map((t) => t.id)).toEqual(['parent']);
  });

  it('carries a routine back with its membership rather than an empty shell', () => {
    const routine: Routine = { id: 'r-1', name: 'Morning', itemIds: ['a', 'b'] };
    store().restoreFromTrash(entry({ kind: 'routine', id: 'r-1', name: 'Morning', entity: routine }));

    expect(store().routines[0].itemIds).toEqual(['a', 'b']);
  });

  it('calls the restore matching the kind, and only that one', () => {
    store().restoreFromTrash(
      entry({ kind: 'routine', id: 'r-1', name: 'Morning', entity: { id: 'r-1', name: 'Morning', itemIds: [] } })
    );
    expect(db.restoreRoutine).toHaveBeenCalledWith(USER, 'r-1');
    expect(db.restoreProject).not.toHaveBeenCalled();
    expect(db.restoreItem).not.toHaveBeenCalled();
  });

  it('resolves a custom item to its DB slug, never the envelope discriminant', () => {
    // db.ts filters .eq('type', type); 'custom' matches zero rows, so the
    // restore would report success and change nothing.
    const goal = task({ type: 'custom', customType: 'goal', id: 'goal-1' } as Partial<Item>);
    store().restoreFromTrash(entry({ kind: 'item', id: 'goal-1', name: 'Run a 10k', entity: goal }));
    expect(db.restoreItem).toHaveBeenCalledWith('goal-1', 'goal');
  });
});
