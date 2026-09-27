import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The WRITE half of first-run seeding.
 *
 * `planSeed` decides what should exist; this decides whether to commit it, and
 * the guards here are the ones standing between a load-window race and a second
 * starter set in someone's account. The plan is computed across three awaits —
 * the latch read, the guard re-check, the bin read — and Supabase re-emits
 * SIGNED_IN on every hidden→visible transition, so "the store changed under the
 * plan" is an ordinary event rather than a freak one.
 */

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  fetchRoutines: vi.fn(async () => []),
  fetchSeasons: vi.fn(async () => []),
  fetchGoals: vi.fn(async () => []),
  createItem: vi.fn(async () => {}),
  updateItem: vi.fn(async () => {}),
  deleteItem: vi.fn(async () => {}),
  createProject: vi.fn(async () => {}),
  updateProject: vi.fn(async () => {}),
  deleteProject: vi.fn(async () => {}),
  renameContainerMembers: vi.fn(async () => {}),
  adoptContainerMembers: vi.fn(async () => 0),
  itemDbType: (item: { type: string; customType?: string }) =>
    item.type === 'custom' ? item.customType : item.type,
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { usePlannerStore } from '@/lib/planner-store';
import { planSeed, type SeedPlan } from '@/lib/seed-containers';
import * as db from '@/lib/db';
import type { Item } from '@/lib/planner-types';

const store = () => usePlannerStore.getState();
const settle = () => new Promise((r) => setTimeout(r, 0));

const habit = (over: Partial<Item> = {}): Item =>
  ({
    id: 'h1', type: 'habit', title: 'Stretch', status: 'pending', repeatFrequency: 'daily',
    completedDates: [], skippedDates: [], streak: 0, project: 'Personal', order: 0, isScheduled: false,
    ...over,
  }) as Item;

const FULL: SeedPlan = planSeed({ items: [], projects: [] });

beforeEach(async () => {
  store().clearStore();
  vi.clearAllMocks();
  vi.mocked(db.fetchItems).mockResolvedValue([]);
  vi.mocked(db.fetchProjects).mockResolvedValue([]);
  // Reset the WRITES explicitly, not just their call lists. `clearAllMocks`
  // wipes recorded calls and leaves implementations, so a `mockRejectedValue`
  // in one rollback test leaks forward and quietly breaks every later one — the
  // same leak that cost failed-container-create.test.ts four tests.
  vi.mocked(db.createProject).mockResolvedValue(undefined);
  vi.mocked(db.adoptContainerMembers).mockResolvedValue(0);
  await store().initializeStore('user-1');
});

describe('seedStarterContainers', () => {
  it('creates the plan, and writes it', async () => {
    store().seedStarterContainers(FULL, 'user-1');
    await settle();

    // ONE list of six since 039 — the two old starter sets, concatenated.
    expect(store().projects.map((p) => p.name)).toEqual([
      'Work', 'Home', 'Health', 'Morning', 'Movement', 'Wind-down',
    ]);
    expect(vi.mocked(db.createProject)).toHaveBeenCalledTimes(6);
  });

  it('mints a fresh id per row, never a constant baked into the module', () => {
    // An id in the seed constant would be the same uuid in every account.
    store().seedStarterContainers(FULL, 'user-1');
    const ids = store().projects.map((c) => c.id);
    expect(new Set(ids).size).toBe(6);
    expect(ids.every((id) => /^[0-9a-f-]{36}$/i.test(id))).toBe(true);
  });

  it('leaves NO history entry, and a new account arrives with ⌘Z disarmed', async () => {
    /**
     * The first version pushed one entry, on the plan's instruction that seeds
     * be "undoable like anything else". The review priced that: a brand-new
     * account arrives with `canUndo: true` and one logged action its owner did
     * not perform, and ⌘Z — the very first thing many people try — SOFT-DELETES
     * all six rows. That drops six containers they never made into a Trash they
     * have never opened and reserves all six names for thirty days, because the
     * unique indexes have no `WHERE deleted_at IS NULL`.
     *
     * Decision 2 asks for "fully deletable", which they are, through the
     * console's ordinary delete. It does not ask for undoable, and a seed is not
     * a user action.
     */
    const before = store().actionLog.length;
    store().seedStarterContainers(FULL, 'user-1');
    await settle();

    expect(store().actionLog.length).toBe(before);
    expect(store().canUndo).toBe(false);
  });

  it('does not let the NEXT real action undo the seed away', async () => {
    // The baseline has to move with the seed, or the user's first edit is
    // diffed against a snapshot that predates the containers.
    store().seedStarterContainers(FULL, 'user-1');
    await settle();
    store().addProject('Mine', 'icon:Star');
    await settle();

    store().undo();
    expect(store().projects.map((p) => p.name)).toEqual([
      'Work', 'Home', 'Health', 'Morning', 'Movement', 'Wind-down',
    ]);
  });
});

describe('the guards, which are what stand between a race and a duplicate set', () => {
  it('refuses once the account has containers — the plan may be stale', async () => {
    // Three awaits happen between planning and committing, and a tab switch
    // re-enters the whole load. This is the check that a fetch resolving in
    // between cannot become a second starter set.
    usePlannerStore.setState({ projects: [{ id: 'p1', name: 'Existing', emoji: '' }] } as never);
    store().seedStarterContainers(FULL, 'user-1');
    await settle();

    expect(store().projects.map((p) => p.name)).toEqual(['Existing']);
    expect(vi.mocked(db.createProject)).not.toHaveBeenCalled();
  });

  it('refuses mid-load, because initializeStore replaces the arrays wholesale', async () => {
    // The documented trap: anything written inside the load window is silently
    // discarded when the fetch resolves. Seeding there means the user believes
    // they have containers until the next reload proves otherwise.
    usePlannerStore.setState({ isLoading: true } as never);
    store().seedStarterContainers(FULL, 'user-1');
    await settle();
    expect(store().projects).toEqual([]);
    expect(vi.mocked(db.createProject)).not.toHaveBeenCalled();
  });

  it('refuses with no userId, rather than seating rows nothing will persist', async () => {
    usePlannerStore.setState({ userId: null } as never);
    store().seedStarterContainers(FULL, 'user-1');
    await settle();
    expect(store().projects).toEqual([]);
  });

  it('refuses to commit ONE account’s plan into ANOTHER account’s store', async () => {
    /**
     * The review's HIGH. `runFirstRunSeed` re-checks the account before two more
     * awaits — the bin read and the latch write — and nothing re-checked after.
     * Supabase delivers a bare SIGNED_IN for a different user with no
     * intervening SIGNED_OUT, which the provider already handles in two other
     * places, so this is an ordinary event.
     *
     * With adoption in the mix the failure is worse than a stray starter set: B
     * receives a container named after A's data.
     */
    await store().initializeStore('user-2');
    const result = store().seedStarterContainers(FULL, 'user-1');

    expect(result).toBe('refused');
    expect(store().projects).toEqual([]);
    expect(vi.mocked(db.createProject)).not.toHaveBeenCalled();
  });

  it('reports a refusal rather than swallowing it, so the latch is not spent', async () => {
    // `commit` returned void, so every guard here was invisible to the caller —
    // which had already latched. The account ended with zero containers and no
    // path that could ever retry.
    usePlannerStore.setState({ isLoading: true } as never);
    expect(store().seedStarterContainers(FULL, 'user-1')).toBe('refused');
  });

  it('distinguishes an empty plan from a refusal', async () => {
    // A stable answer, so the caller latches on it. A refusal means "ask again".
    expect(store().seedStarterContainers({ reason: 'adopt', projects: [] }, 'user-1'))
      .toBe('nothing-to-do');
  });

  it('rolls a REFUSED seed container back out, the way a hand-made one is', async () => {
    /**
     * Reachable with no network fault at all: two tabs opening a first run both
     * read the latch as false, both plan the same names, and the second one's
     * insert meets `projects_user_id_name_key`. Left behind, that tab shows six
     * containers that do not exist — and because `items_project_id_fkey` is
     * composite, the first item filed into one is rejected in full and lost.
     */
    vi.mocked(db.createProject).mockRejectedValue(
      Object.assign(new Error('duplicate key value'), { code: '23505' })
    );
    store().seedStarterContainers(FULL, 'user-1');
    await settle();

    // ALL six roll back here, because the mock rejects every insert. The
    // per-container property is asserted by the next test, which rejects one.
    expect(store().projects).toEqual([]);
  });

  it('rolls back only the container the database refused', async () => {
    // A rollback is per container: one 23505 must not take the other five with
    // it. `mockRejectedValueOnce` is the whole test — the first insert fails and
    // the remaining five are left standing.
    vi.mocked(db.createProject).mockRejectedValueOnce(
      Object.assign(new Error('duplicate key value'), { code: '23505' })
    );
    store().seedStarterContainers(FULL, 'user-1');
    await settle();

    expect(store().projects).toHaveLength(5);
    expect(store().projects.map((p) => p.name)).not.toContain('Work');
  });

  it('does not adopt members into a container the database refused', async () => {
    vi.mocked(db.createProject).mockRejectedValue(new Error('offline'));
    vi.mocked(db.fetchItems).mockResolvedValue([habit()]);
    store().clearStore();
    await store().initializeStore('user-1');
    store().seedStarterContainers(
      planSeed({ items: [habit()], projects: [] }),
      'user-1'
    );
    await settle();

    expect(vi.mocked(db.adoptContainerMembers)).not.toHaveBeenCalled();
    // …and the item is not left pointing at an id no row will ever match.
    const item = store().items[0];
    expect(item.type === 'habit' && item.projectId).toBeUndefined();
  });

  it('writes nothing at all for an empty plan, including a history entry', async () => {
    const before = store().actionLog.length;
    store().seedStarterContainers({ reason: 'adopt', projects: [] }, 'user-1');
    await settle();
    expect(store().actionLog.length).toBe(before);
    expect(vi.mocked(db.createProject)).not.toHaveBeenCalled();
  });
});

describe('adoption — 027 backfill, re-run for a container that now exists', () => {
  const adopt = async (items: Item[]) => {
    vi.mocked(db.fetchItems).mockResolvedValue(items);
    store().clearStore();
    await store().initializeStore('user-1');
    store().seedStarterContainers(planSeed({ items, projects: [] }), 'user-1');
    await settle();
  };

  it('links the members in the store, in the same commit', async () => {
    // Otherwise the store holds a member whose projectId is undefined while the
    // database has just linked it, and the next edit writes the stale shape back.
    await adopt([habit({ id: 'h1' }), habit({ id: 'h2' })]);
    const container = store().projects.find((p) => p.name === 'Personal')!;
    for (const item of store().items) {
      expect(item.type === 'habit' && item.projectId).toBe(container.id);
    }
  });

  it('links them in the DATABASE too, after the insert and not before', async () => {
    // The composite items_project_id_fkey rejects the whole UPDATE if the row is
    // not there yet, so the adopt must be chained onto the create.
    await adopt([habit()]);
    const container = store().projects.find((p) => p.name === 'Personal')!;
    expect(vi.mocked(db.adoptContainerMembers)).toHaveBeenCalledWith(
      'user-1', container.id, 'Personal'
    );
    const createOrder = vi.mocked(db.createProject).mock.invocationCallOrder[0];
    const adoptOrder = vi.mocked(db.adoptContainerMembers).mock.invocationCallOrder[0];
    expect(adoptOrder).toBeGreaterThan(createOrder);
  });

  it('does not re-point a member that already resolves', async () => {
    await adopt([habit({ id: 'h1', projectId: 'already-linked' } as never)]);
    const item = store().items.find((i) => i.id === 'h1')!;
    expect(item.type === 'habit' && item.projectId).toBe('already-linked');
  });

  it('does not fire the link when the create fails', async () => {
    vi.mocked(db.createProject).mockRejectedValueOnce(new Error('offline'));
    await adopt([habit()]);
    expect(vi.mocked(db.adoptContainerMembers)).not.toHaveBeenCalled();
  });
});
