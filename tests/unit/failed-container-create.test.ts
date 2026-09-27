import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A container create the DATABASE REFUSED, and the phantom it used to leave.
 *
 * `projects_user_id_name_key` is a PLAIN
 * unique indexes over `(user_id, name)` — no `WHERE deleted_at IS NULL` — so a
 * soft-deleted container reserves its name for the full 30 days while being
 * invisible to the store, whose arrays come from `deleted_at`-filtered fetches.
 * The `alreadyExists` guard therefore cannot see the row about to reject the
 * insert, and the insert used to fail into a bare `.catch(console.error)` after
 * the optimistic `set()` had already landed.
 *
 * The result was worse than a missing container: `items_project_id_fkey` is a
 * COMPOSITE key, so any item filed into the phantom had its OWN insert rejected
 * in full. The item dialog's inline "new project" is the sharp end — you lose
 * the project and the task you were writing, silently.
 *
 * The console's create rows refuse trashed names with a sentence, which is the
 * good path. This is the NET under it: it covers the item dialog, the command
 * palette and anything added later, and it has to leave no trace in history.
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

import { usePlannerStore } from '@/lib/planner-store';
import * as db from '@/lib/db';

const USER = 'user-1';
const store = () => usePlannerStore.getState();
const labels = () => store().actionLog.map((a) => a.label);

/** 23505 as PostgREST reports it. */
const duplicate = Object.assign(new Error('duplicate key value violates unique constraint'), {
  code: '23505',
});

/** Let the rejected promise's .catch run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const task = (over: Record<string, unknown> = {}) =>
  ({
    type: 'task', id: 'task-1', title: 'Write tests', status: 'pending',
    isScheduled: false, order: 0, completedDates: [], ...over,
  }) as never;

beforeEach(async () => {
  store().clearStore();
  vi.clearAllMocks();
  toastError.mockClear();
  vi.mocked(db.fetchItems).mockResolvedValue([]);
  // Reset explicitly rather than relying on clearAllMocks: the load-window test
  // replaces this with a PENDING promise, and mockReturnValue outlives
  // clearAllMocks — so without this the next test's initializeStore never
  // resolves and its fixtures leak forward.
  vi.mocked(db.fetchProjects).mockResolvedValue([]);
  vi.mocked(db.createProject).mockResolvedValue(undefined);
  await store().initializeStore(USER);
});

describe('a create the database accepts', () => {
  it('is untouched — the row stays and the history entry stands', async () => {
    store().addProject('Work', 'icon:Briefcase');
    await settle();

    expect(store().projects.map((p) => p.name)).toEqual(['Work']);
    expect(labels()[0]).toBe('Add project: Work');
    expect(toastError).not.toHaveBeenCalled();
  });

  it('names every container create, which used to log as "Unknown action"', async () => {
    // Was `addHabitGroup` before 039 collapsed the two CLASSIFY kinds. One
    // action, one label.
    store().addProject('Wellness', 'icon:Heart');
    await settle();
    expect(labels()[0]).toBe('Add project: Wellness');
  });
});

describe('a create the database REFUSES', () => {
  beforeEach(() => {
    vi.mocked(db.createProject).mockRejectedValue(duplicate);
  });

  it('takes the phantom back out of the store', async () => {
    store().addProject('Work', 'icon:Briefcase');
    expect(store().projects).toHaveLength(1); // optimistic, as before

    await settle();

    expect(store().projects).toEqual([]);
  });

  it('says so, and names the trash — every other failure mode here is silent', async () => {
    store().addProject('Work', 'icon:Briefcase');
    await settle();

    expect(toastError).toHaveBeenCalledTimes(1);
    const said = toastError.mock.calls[0][0] as string;
    expect(said).toContain('Work');
    expect(said).toContain('Trash');
  });

  it('pushes no entry of its own, and stops the create’s claiming to have happened', async () => {
    // The rollback is not a user action: a bare set() would push a second entry
    // the pending label had already been spent on, landing as "Unknown action".
    // The create's own entry STAYS — removing it is what forced the index
    // arithmetic that broke the stack — but it is relabelled, and its snapshot
    // no longer holds the phantom, so undoing across it does nothing.
    const before = labels().length;
    store().addProject('Work', 'icon:Briefcase');
    await settle();

    expect(labels().length).toBe(before + 1);
    expect(labels()).not.toContain('Unknown action');
    expect(labels()).not.toContain('Add project: Work');
    expect(labels()[0]).toBe('Couldn’t add project: Work');
  });

  it('⌘Z across a refused create is a no-op, not a resurrection', async () => {
    vi.mocked(db.createProject).mockResolvedValueOnce(undefined);
    store().addProject('Real', 'icon:Star');
    await settle();

    vi.mocked(db.createProject).mockRejectedValue(duplicate);
    store().addProject('Work', 'icon:Briefcase');
    await settle();

    store().undo();
    // The failed create's snapshot was stripped, so stepping back through it
    // lands on the same state — "Real" alone, and no phantom.
    expect(store().projects.map((p) => p.name)).toEqual(['Real']);

    store().undo();
    expect(store().projects).toEqual([]);
  });

  it('⌘Z does not resurrect the phantom when the user ACTED during the round trip', async () => {
    // The case that broke the first design. It popped the create's entry and
    // decremented historyIndex, which it could only do when nothing had
    // happened meanwhile — and the item dialog's own Save flow guarantees
    // something has. In every refused branch the store lost the phantom while
    // the snapshots kept it, so one ⌘Z put it back AND fired dbRestoreProject
    // against a row that never existed.
    let reject: (e: unknown) => void = () => {};
    vi.mocked(db.createProject).mockReturnValueOnce(
      new Promise((_, r) => {
        reject = r;
      })
    );
    store().addProject('Work', 'icon:Briefcase');

    // A SECOND container create that SUCCEEDS, landing while the first is in
    // flight — the user acting during the round trip, which is what makes the
    // failed create no longer the top of the stack.
    vi.mocked(db.createProject).mockResolvedValueOnce(undefined);
    store().addProject('Wellness', 'icon:Heart');
    await settle();

    reject(duplicate);
    await settle();

    store().undo();

    expect(store().projects.map((p) => p.name)).toEqual([]);
    expect(db.restoreProject).not.toHaveBeenCalled();
  });

  it('⌘Z does not resurrect the phantom when the user UNDID during the round trip', async () => {
    vi.mocked(db.createProject).mockResolvedValueOnce(undefined);
    store().addProject('Real', 'icon:Star');
    await settle();

    let reject: (e: unknown) => void = () => {};
    vi.mocked(db.createProject).mockReturnValueOnce(
      new Promise((_, r) => {
        reject = r;
      })
    );
    store().addProject('Work', 'icon:Briefcase');

    store().undo();
    reject(duplicate);
    await settle();

    store().redo();
    expect(store().projects.map((p) => p.name)).toEqual(['Real']);
    expect(db.restoreProject).not.toHaveBeenCalled();
  });

  it('clears the phantom off any item that was filed into it', async () => {
    // An item saved in the round-trip window carries the phantom's id. Left
    // there, the next save re-sends an id no row will ever match — and undoing
    // into an older snapshot would re-file it.
    vi.mocked(db.fetchItems).mockResolvedValue([task({ id: 'task-1' })]);
    store().clearStore();
    await store().initializeStore(USER);

    let reject: (e: unknown) => void = () => {};
    vi.mocked(db.createProject).mockReturnValueOnce(
      new Promise((_, r) => {
        reject = r;
      })
    );
    store().addProject('Work', 'icon:Briefcase');
    const phantomId = store().projects[0].id;

    store().updateTask('task-1', { project: 'Work', projectId: phantomId } as never);
    reject(duplicate);
    await settle();

    const item = store().items.find((i) => i.id === 'task-1')!;
    expect(item.type !== 'habit' && item.projectId).toBeUndefined();
    expect(item.type !== 'habit' && item.project).toBeUndefined();
  });

  it('a create rejecting INSIDE the load window cannot corrupt the session', async () => {
    /**
     * The worst bug the first version of this shipped, and it was in the
     * safety net rather than the thing it protected.
     *
     * `isUpdatingUndoRedo` is a plain boolean, not a counter, and
     * `initializeStore` holds it true across its ENTIRE fetch while `userId` is
     * already stamped — so a create issued during the load really does reach
     * the database. The rollback's `finally` used to write `false` into it
     * unconditionally, handing the flag back UNBLOCKED mid-load. The republish
     * that followed then woke the history subscriber's lazy-baseline branch,
     * seeding a second 'Session start' while initializeStore went on to hard-set
     * historyIndex to 0 against a two-entry stack. From there one ⌘Z restored a
     * pre-fetch baseline and syncContainers soft-deleted every row the load had
     * just brought in.
     *
     * Saving and restoring the flag is the whole fix; this is what proves it.
     */
    store().clearStore();
    vi.clearAllMocks();

    let releaseFetch: (rows: unknown[]) => void = () => {};
    vi.mocked(db.fetchProjects).mockReturnValue(
      new Promise((resolve) => {
        releaseFetch = resolve as (rows: unknown[]) => void;
      }) as never
    );
    vi.mocked(db.fetchItems).mockResolvedValue([]);

    const loading = store().initializeStore(USER);
    // userId is stamped before the await, so the create below is a real write.
    vi.mocked(db.createProject).mockRejectedValue(duplicate);
    store().addProject('Work', 'icon:Briefcase');
    await settle();

    releaseFetch([{ id: 'p-fetched', name: 'Fetched', emoji: 'icon:Star' }]);
    await loading;

    // Exactly one baseline entry, and the index names it.
    expect(labels().filter((l) => l === 'Session start')).toHaveLength(1);

    store().undo();
    // Nothing the load brought in may be deleted by that press.
    expect(db.deleteProject).not.toHaveBeenCalled();
  });

  it('two failed creates in flight both clean up, and history stays consistent', async () => {
    const rejects: ((e: unknown) => void)[] = [];
    vi.mocked(db.createProject).mockReturnValue(
      new Promise((_, r) => {
        rejects.push(r);
      })
    );
    store().addProject('One', 'icon:Star');
    vi.mocked(db.createProject).mockReturnValue(
      new Promise((_, r) => {
        rejects.push(r);
      })
    );
    store().addProject('Two', 'icon:Star');

    rejects[0](duplicate);
    rejects[1](duplicate);
    await settle();

    expect(store().projects).toEqual([]);
    // And no snapshot anywhere still holds either of them.
    store().undo();
    expect(store().projects).toEqual([]);
    store().undo();
    expect(store().projects).toEqual([]);
  });

  it('redo cannot resurrect the phantom', async () => {
    // The whole reason the entry is dropped rather than left behind:
    // syncContainers reads "present in the restored snapshot, absent from
    // current" as a RESTORE and puts the row straight back — this time with no
    // failing write underneath to heal it.
    vi.mocked(db.createProject).mockResolvedValueOnce(undefined);
    store().addProject('Real', 'icon:Star');
    await settle();

    vi.mocked(db.createProject).mockRejectedValue(duplicate);
    store().addProject('Work', 'icon:Briefcase');
    await settle();

    store().undo();
    store().redo();

    expect(store().projects.map((p) => p.name)).toEqual(['Real']);
  });

  it('names the container in the toast, from the registry noun', () => {
    // The noun is `CONTAINER_KINDS.project.label`, not a literal — it is
    // provisional, and this string is the loudest place it appears.
    store().addProject('Wellness', 'icon:Heart');
    return settle().then(() => {
      expect(store().projects).toEqual([]);
      expect(toastError).toHaveBeenCalledTimes(1);
      expect(toastError.mock.calls[0][0]).toContain('project');
    });
  });

  it('THE POINT: an item created in the window survives, container-less', async () => {
    // Before the rollback, projectIdFor resolved the phantom's id and the
    // item's own INSERT was rejected by the composite items_project_id_fkey —
    // so the user lost the task as well as the project. With the phantom gone
    // the resolution misses, and the item is saved unfiled instead of not at
    // all. A task with no project beats no task.
    store().addProject('Work', 'icon:Briefcase');
    await settle();

    store().addTask({ title: 'Write it up', project: 'Work' } as never);

    const created = vi.mocked(db.createItem).mock.calls.at(-1)?.[1] as
      | { projectId?: string }
      | undefined;
    expect(created).toBeDefined();
    expect(created!.projectId).toBeUndefined();
  });

  it('keeps the undo flags honest after the rollback', async () => {
    /**
     * This used to assert `canUndo === canUndoAfterReal` and `canRedo === false`
     * — both of which are `true`/`false` for the whole test either way, so it
     * passed against a rollback that did nothing at all AND against one that
     * corrupted the index. Only ever seeing a flag in one state proves nothing
     * about a flag.
     *
     * So: the exact index and lengths, and both flags observed BOTH ways.
     */
    vi.mocked(db.createProject).mockResolvedValueOnce(undefined);
    store().addProject('Real', 'icon:Star');
    await settle();
    expect(store().historyIndex).toBe(1); // Session start, then the create.

    vi.mocked(db.createProject).mockRejectedValue(duplicate);
    store().addProject('Work', 'icon:Briefcase');
    await settle();

    // The refused create's entry STAYS — stripped and relabelled, not removed —
    // so the index advances exactly as a successful create's would.
    expect(store().historyIndex).toBe(2);
    expect(store().actionLog).toHaveLength(3);
    expect(store().canUndo).toBe(true);
    expect(store().canRedo).toBe(false);

    store().undo();
    expect(store().historyIndex).toBe(1);
    expect(store().canRedo).toBe(true); // ← the other direction

    store().undo();
    expect(store().historyIndex).toBe(0);
    expect(store().canUndo).toBe(false); // ← and this one
    expect(store().projects).toEqual([]);
  });

  it('a no-op create leaves no label armed for the next mutation to wear', async () => {
    /**
     * `2b65db4` moved `setNextActionLabel` to AFTER the `alreadyExists` guard in
     * both create actions, and nothing pinned it.
     *
     * Armed before the guard, a duplicate create returns without ever calling
     * `set()` — so the label is never spent and sits on a module-level variable
     * waiting. The next mutation to reach a tracked slice without arming its own
     * label picks it up, and is then logged, shown in the history popover and
     * undone as "Add project: Work". A create that did nothing renames someone
     * else's action.
     */
    vi.mocked(db.createProject).mockResolvedValue(undefined);
    store().addProject('Work', 'icon:Briefcase');
    await settle();
    expect(labels()[0]).toBe('Add project: Work');
    const settled = labels().length;

    // Same name again. The guard returns early; nothing happened.
    store().addProject('Work', 'icon:Briefcase');
    await settle();
    expect(labels().length).toBe(settled);

    // Any set() that reaches a tracked slice without arming a label lands here.
    usePlannerStore.setState((state) => ({
      projects: [...state.projects, { id: 'other', name: 'Other', emoji: 'icon:Star' }],
    }));

    expect(labels()[0]).not.toBe('Add project: Work');
    expect(labels()[0]).toBe('Unknown action');
  });

  it('does not desynchronise the stack if the user UNDID during the round trip', async () => {
    // The other half of the guard, and the subtler one. `undo()` moves
    // historyIndex back but leaves the stack and the log intact — so the failed
    // create is still the TOP entry by id, and an id-only check would happily
    // pop it. Popping while the index sits behind the top breaks the invariant
    // that historyIndex names the snapshot the store currently holds, and the
    // damage shows up one keystroke later: the NEXT ⌘Z skips a step.
    vi.mocked(db.createProject).mockResolvedValueOnce(undefined);
    store().addProject('Real', 'icon:Star');
    await settle();
    vi.mocked(db.createProject).mockResolvedValueOnce(undefined);
    store().addProject('Second', 'icon:Star');
    await settle();

    let reject: (e: unknown) => void = () => {};
    vi.mocked(db.createProject).mockReturnValueOnce(
      new Promise((_, r) => {
        reject = r;
      })
    );
    store().addProject('Work', 'icon:Briefcase');

    store().undo();
    expect(store().projects.map((p) => p.name)).toEqual(['Real', 'Second']);

    reject(duplicate);
    await settle();

    // One more step back lands on "Real" alone. Drop the entry from under a
    // moved index and this jumps all the way to empty instead.
    store().undo();
    expect(store().projects.map((p) => p.name)).toEqual(['Real']);
  });

  it('does not drop someone else’s history entry if the user acted meanwhile', async () => {
    // A round trip has passed. If the user has done something in the window,
    // the failed create is no longer the top of the stack and the rollback must
    // leave history alone rather than eat the wrong entry.
    let reject: (e: unknown) => void = () => {};
    vi.mocked(db.createProject).mockReturnValueOnce(
      new Promise((_, r) => {
        reject = r;
      })
    );
    store().addProject('Work', 'icon:Briefcase');

    vi.mocked(db.createProject).mockResolvedValueOnce(undefined);
    store().addProject('Wellness', 'icon:Heart');
    await settle();

    reject(duplicate);
    await settle();

    // The phantom is still rolled out of the store…
    expect(store().projects.map((p) => p.name)).toEqual(['Wellness']);
    // …and the later entry, which arrived after it, is untouched.
    expect(labels()).toContain('Add project: Wellness');
  });
});
