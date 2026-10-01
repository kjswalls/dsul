import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Container ids — migration 027, plan Phase 0
 * (memory/plans/organize-console.md).
 *
 * `items.project` was a NAME reference, so renaming a
 * container silently emptied it: every member kept the old string with nothing
 * left to resolve it by. The id is what survives the rename; the name stays
 * authoritative for display, because the permanent legacy projection has to
 * emit a name and a uuid would still `safeParse` past it.
 *
 * These drive the REAL store against a mocked db layer, the same harness
 * undo-redo-store.test.ts uses — the fan-out has a store half and a DB half and
 * they can fail independently, so both are asserted.
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
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));

import { usePlannerStore } from '@/lib/planner-store';
import * as db from '@/lib/db';
import type { Item, Project } from '@/lib/planner-types';

const USER = 'user-1';
const store = () => usePlannerStore.getState();

const PROJECT: Project = { id: 'pr-work', name: 'Work', emoji: 'icon:Briefcase' };
// A second container, which used to be a habit group. One CLASSIFY kind since
// 039, so it is a project row like any other — what still differs is the item
// filed under it, whose type declares `containerRequired`.
const WELLNESS: Project = { id: 'gr-well', name: 'Wellness', emoji: '⭐' };

const items = (): Item[] => [
  {
    type: 'task',
    id: 'task-member',
    title: 'Filed under Work',
    status: 'pending',
    isScheduled: false,
    order: 0,
    completedDates: [],
    project: 'Work',
    projectId: 'pr-work',
  },
  {
    // Names the same project but carries no id — one of the 12 rows on the live
    // database that name a project with no row at all. It must NOT follow a
    // rename: it is not a member, it merely shares a string.
    type: 'task',
    id: 'task-stranger',
    title: 'Says Work, belongs to nothing',
    status: 'pending',
    isScheduled: false,
    order: 1,
    completedDates: [],
    project: 'Work',
  },
  {
    type: 'habit',
    id: 'habit-member',
    title: 'Stretch',
    project: 'Wellness',
    projectId: 'gr-well',
    streak: 0,
    status: 'pending',
    completedDates: [],
    skippedDates: [],
    dailyCounts: {},
    repeatFrequency: 'daily',
  },
];

const find = (id: string) => store().items.find((i) => i.id === id)!;

type AddTaskArg = Parameters<ReturnType<typeof usePlannerStore.getState>['addTask']>[0];
type AddHabitArg = Parameters<ReturnType<typeof usePlannerStore.getState>['addHabit']>[0];

beforeEach(async () => {
  store().clearStore();
  vi.clearAllMocks();
  vi.mocked(db.fetchItems).mockResolvedValue(items());
  vi.mocked(db.fetchProjects).mockResolvedValue([PROJECT, WELLNESS]);
  await store().initializeStore(USER);
});

describe('renaming a container fans the new name out to its members', () => {
  it('moves the name on members, keyed by id', async () => {
    store().updateProject('pr-work', { name: 'Deep Work' });
    expect((find('task-member') as { project?: string }).project).toBe('Deep Work');
    // Awaited, because the DB fan-out is CHAINED onto the container write
    // rather than fired beside it — a 23505 on the container (a rename onto a
    // trashed name, which takenBy cannot see) must not leave the members
    // rewritten. A synchronous assertion here would pass on either wiring.
    await Promise.resolve();
    expect(db.renameContainerMembers).toHaveBeenCalledWith(USER, 'pr-work', 'Deep Work');
  });

  it('does NOT fan out when the container write fails', async () => {
    // The whole reason the two are chained. takenBy only sees live containers,
    // so a rename onto a soft-deleted project's name reaches the DB and raises
    // 23505 there; the member fan-out touches no unique index and would happily
    // succeed on its own, leaving the container named one thing and all of its
    // items another.
    vi.mocked(db.updateProject).mockRejectedValueOnce(new Error('23505'));
    store().updateProject('pr-work', { name: 'Trashed Name' });
    await Promise.resolve();
    await Promise.resolve();
    expect(db.renameContainerMembers).not.toHaveBeenCalled();
  });

  it('leaves a same-named non-member alone', () => {
    // The reason the fan-out is keyed on the id rather than the old name: a
    // name-keyed UPDATE would drag every unrelated row that happens to hold the
    // string into a project it was never in.
    store().updateProject('pr-work', { name: 'Deep Work' });
    expect((find('task-stranger') as { project?: string }).project).toBe('Work');
  });

  it('does not fan out when the name did not change', () => {
    // Emoji and colour edits arrive through the same action, and an unguarded
    // fan-out would issue a pointless full-table UPDATE on every one of them.
    store().updateProject('pr-work', { emoji: 'icon:Rocket' });
    expect(db.renameContainerMembers).not.toHaveBeenCalled();
    store().updateProject('pr-work', { name: 'Work' });
    expect(db.renameContainerMembers).not.toHaveBeenCalled();
  });

  it('does the same for a container whose members are habits', async () => {
    // One action for the whole axis since 039 — this used to be
    // `updateHabitGroup` fanning out on `group_id`.
    store().updateProject('gr-well', { name: 'Health' });
    expect((find('habit-member') as { project?: string }).project).toBe('Health');
    await Promise.resolve();
    expect(db.renameContainerMembers).toHaveBeenCalledWith(USER, 'gr-well', 'Health');
  });

  it('drops a fan-out whose rename was undone while the write was in flight', async () => {
    // Chaining fixed the split write but moved this dispatch AFTER undo's.
    // Undo restores the old name with plain per-item writes and no fan-out of
    // its own, so a ⌘Z landing inside the container write's round trip used to
    // be overwritten here: the container reverted while every member kept the
    // name the user had just undone — and unlike an ordinary optimistic write,
    // that state survives a reload.
    let release!: () => void;
    vi.mocked(db.updateProject).mockReturnValueOnce(
      new Promise<void>((resolve) => { release = () => resolve(); })
    );

    store().updateProject('pr-work', { name: 'Deep Work' });
    store().undo();
    release();
    await Promise.resolve();
    await Promise.resolve();

    expect(db.renameContainerMembers).not.toHaveBeenCalled();
  });

  it('still fans out when nothing intervened', async () => {
    // The guard must not swallow the ordinary case it is wrapped around.
    let release!: () => void;
    vi.mocked(db.updateProject).mockReturnValueOnce(
      new Promise<void>((resolve) => { release = () => resolve(); })
    );
    store().updateProject('pr-work', { name: 'Deep Work' });
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(db.renameContainerMembers).toHaveBeenCalledWith(USER, 'pr-work', 'Deep Work');
  });

  it('undo puts the members back, not just the container', () => {
    // The fan-out shares ONE set() with the rename, so both halves land in a
    // single history snapshot. Split across two, undo would restore the old
    // container name while every member kept the new one — the orphaning bug
    // reintroduced through the back door.
    store().updateProject('pr-work', { name: 'Deep Work' });
    store().undo();
    expect(store().projects[0].name).toBe('Work');
    expect((find('task-member') as { project?: string }).project).toBe('Work');
  });
});

describe('a name write resolves the id', () => {
  it('files a task by name and stores the id alongside', () => {
    store().addTask({ title: 'New', project: 'Work' } as AddTaskArg);
    const added = store().items.find((i) => i.title === 'New') as { projectId?: string };
    expect(added.projectId).toBe('pr-work');
  });

  it('re-filing moves the id with the name', () => {
    store().updateTask('task-stranger', { project: 'Work' });
    expect((find('task-stranger') as { projectId?: string }).projectId).toBe('pr-work');
  });

  it('unfiling clears BOTH halves', () => {
    // A cleared name with a live id left behind would follow the container's
    // next rename straight back into a project the user had taken it out of.
    store().updateTask('task-member', { project: undefined });
    const item = find('task-member') as { project?: string; projectId?: string };
    expect(item.project).toBeUndefined();
    expect(item.projectId).toBeUndefined();
  });

  it('leaves the id undefined when the name matches no container', () => {
    // Inventing a link here would file the item under whatever container is
    // created with that name next.
    store().updateTask('task-member', { project: 'Housework' });
    expect((find('task-member') as { projectId?: string }).projectId).toBeUndefined();
  });

  it('files a habit by name and stores the id alongside', () => {
    store().addHabit({ title: 'New habit', project: 'Wellness', repeatFrequency: 'daily' } as AddHabitArg);
    const added = store().items.find((i) => i.title === 'New habit') as { projectId?: string };
    expect(added.projectId).toBe('gr-well');
  });

  it('resolves a container case-insensitively, as every container surface does', () => {
    // The habit starts on gr-well, so the assertion is that the id MOVED. An
    // earlier version of this test asserted it was still 'gr-well' — the value
    // the fixture already held — and stayed green with the whole resolution
    // deleted.
    store().addProject('Focus', '🎯');
    const focus = store().projects.find((p) => p.name === 'Focus')!;
    store().updateHabit('habit-member', { project: 'focus' });
    expect((find('habit-member') as { projectId?: string }).projectId).toBe(focus.id);
  });
});

describe('deleting a container', () => {
  it('unfiles members by id and by name, clearing both halves', () => {
    store().removeProject('pr-work');
    for (const id of ['task-member', 'task-stranger']) {
      const item = find(id) as { project?: string; projectId?: string };
      expect(item.project).toBeUndefined();
      expect(item.projectId).toBeUndefined();
    }
  });

  it('reassigns habits to the destination row, id included', () => {
    // `containerRequired` is what makes this a reassignment rather than an
    // unfile — the registry answers it, `unfiled` reads the answer.
    store().removeProject('gr-well');
    const moved = find('habit-member') as { project?: string; projectId?: string };
    expect(moved.project).toBe('Work');
    expect(moved.projectId).toBe('pr-work');
  });

  it('falls back to a bare “Personal” name with no id when no row remains', () => {
    // The account the migration found with 223 habits and ZERO habit_groups
    // rows: the fallback names a container that does not exist, so claiming an
    // id for it would be a lie the FK would reject.
    store().removeProject('pr-work');
    store().removeProject('gr-well');
    const moved = find('habit-member') as { project?: string; projectId?: string };
    expect(moved.project).toBe('Personal');
    expect(moved.projectId).toBeUndefined();
  });

  /**
   * An id that resolves to no row, which is what the display-menu merge made
   * reachable. Both sides of that merge were half-right: main matched on the
   * NAME and guarded `project &&`; 027 matched on `i.projectId === project?.id`
   * and did not. Combined naively the guard covers only the name half, and the
   * id half reads `undefined === undefined` — true for every item that has not
   * been backfilled, which unfiles the entire account off one bad id.
   *
   * Not hypothetical on the way in: `restoreFromTrash` and undo both replay a
   * container id against a store that may no longer hold the row.
   */
  it('does nothing at all when the id names no container', () => {
    const before = store().items.map((i) => ({
      id: i.id,
      project: (i as { project?: string }).project,
      projectId: (i as { projectId?: string }).projectId,
      group: (i as { group?: string }).group,
      groupId: (i as { groupId?: string }).groupId,
    }));

    store().removeProject('pr-does-not-exist');

    const after = store().items.map((i) => ({
      id: i.id,
      project: (i as { project?: string }).project,
      projectId: (i as { projectId?: string }).projectId,
      group: (i as { group?: string }).group,
      groupId: (i as { groupId?: string }).groupId,
    }));

    // task-stranger is the one that proves it: it carries `project: 'Work'`
    // with NO projectId, so an unguarded id comparison matches it first.
    expect(after).toEqual(before);
    expect((find('task-stranger') as { project?: string }).project).toBe('Work');
  });
});
