import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * loadPlannerData: the planner's first load as one `load_planner` RPC
 * (migration 050), with the per-table fetchers as the fallback.
 *
 * What has to hold:
 * - PARITY. The same raw rows through the RPC and through the six fetchers
 *   assemble to the same planner. Both paths run the same pure assemblers, and
 *   this is what keeps it that way.
 * - Only a MISSING RPC falls back, and it latches — the next load calls the
 *   fallback synchronously, with no doomed round trip first, which is what
 *   keeps the store's fetchers starting in initializeStore's own frame.
 * - Any other error fails the load: falling back there would stack the
 *   ten-request burst on top of the call that just failed.
 * - An answer for a different session is a failure, never an empty success.
 */

type Result = { data: unknown; error: { code?: string; message?: string } | null };

const state = {
  rpcCalls: [] as string[],
  fromCalls: [] as string[],
  orders: {} as Record<string, [string, unknown][]>,
  rpcResult: { data: null, error: null } as Result,
  tables: {} as Record<string, unknown[]>,
};

vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    rpc: (fn: string) => {
      state.rpcCalls.push(fn);
      return Promise.resolve(state.rpcResult);
    },
    from: (relation: string) => {
      state.fromCalls.push(relation);
      const chain = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        in: () => chain,
        order: (column: string, opts: unknown) => {
          (state.orders[relation] ??= []).push([column, opts]);
          return chain;
        },
        limit: () => chain,
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: state.tables[relation] ?? [], error: null }).then(resolve),
      };
      return chain;
    },
  }),
}));
vi.mock('@/lib/openclaw-registry', () => ({ notifyPlugins: vi.fn() }));

const U = 'user-1';
const T0 = '2026-01-01T00:00:00+00:00';

// Raw rows, as both PostgREST and to_jsonb serve them. Deliberately awkward:
// a null sort_order, an unknown goal role, a memberless goal.
const ROWS = {
  items: [
    {
      id: 'i1', user_id: U, type: 'task', title: 'Write', status: 'pending', order: 0,
      completed_dates: [], skipped_dates: [], created_at: T0, deleted_at: null,
    },
    {
      id: 'i2', user_id: U, type: 'habit', title: 'Run', status: 'pending', order: 1,
      repeat_frequency: 'daily', completed_dates: ['2026-01-02'], skipped_dates: [],
      project: 'Health', created_at: T0, deleted_at: null,
    },
  ],
  projects: [{ id: 'p1', user_id: U, name: 'Health', emoji: '🏃', color: null, notes: null }],
  item_types: [{ id: 't1', name: 'errand', label: 'Errand', label_plural: 'Errands', icon: null, color: null, config: {} }],
  routines: [
    { id: 'r1', user_id: U, name: 'Morning', icon: null, color: null, paused_at: null, paused_until: null, sort_order: 0, usual_time: '07:00', notes: null },
    { id: 'r2', user_id: U, name: 'Evening', icon: null, color: null, paused_at: null, paused_until: null, sort_order: null, usual_time: null, notes: null },
  ],
  routine_items: [
    { routine_id: 'r1', item_id: 'i2', sort_order: 0 },
    { routine_id: 'r1', item_id: 'i1', sort_order: null },
  ],
  seasons: [
    { id: 's1', user_id: U, name: 'Spring', icon: null, color: null, state: 'active', starts_on: '2026-03-01', ends_on: null, sort_order: null, updated_at: T0, notes: null },
  ],
  season_items: [{ season_id: 's1', item_id: 'i1' }],
  season_routines: [{ season_id: 's1', routine_id: 'r1' }],
  goals: [
    { id: 'g1', user_id: U, name: 'Marathon', why: 'because', icon: null, color: null, state: 'active', starts_on: null, target_on: '2026-10-01', achieved_at: null, sort_order: 0 },
    { id: 'g2', user_id: U, name: 'Empty', why: null, icon: null, color: null, state: null, starts_on: null, target_on: null, achieved_at: null, sort_order: null },
    { id: 'g3', user_id: U, name: 'Also empty', why: null, icon: null, color: null, state: 'active', starts_on: null, target_on: null, achieved_at: null, sort_order: null },
  ],
  goal_items: [
    { goal_id: 'g1', item_id: 'i1', role: 'milestone', sort_order: 0 },
    { goal_id: 'g1', item_id: 'i2', role: 'someday-role', sort_order: null },
  ],
};

const bundle = (overrides: Record<string, unknown> = {}) => ({ v: 1, uid: U, ...ROWS, ...overrides });

type Db = typeof import('@/lib/db');
type PlannerData = import('@/lib/db').PlannerData;

/** A fresh module per case, so the page-lifetime latch starts open. */
async function freshDb(): Promise<Db> {
  vi.resetModules();
  return import('@/lib/db');
}

/** The per-table fallback, exactly as the store builds it. */
const perTableOf = (db: Db) =>
  vi.fn(
    async (): Promise<PlannerData> => {
      const [items, projects, itemTypes, routines, seasons, goals] = await Promise.all([
        db.fetchItems(U),
        db.fetchProjects(U),
        db.fetchItemTypes(U),
        db.fetchRoutines(U),
        db.fetchSeasons(U),
        db.fetchGoals(U),
      ]);
      return { items, projects, itemTypes, routines, seasons, goals };
    },
  );

const sentinel = (): PlannerData => ({ items: [], projects: [], itemTypes: null, routines: null, seasons: null, goals: null });

beforeEach(() => {
  state.rpcCalls = [];
  state.fromCalls = [];
  state.orders = {};
  state.rpcResult = { data: bundle(), error: null };
  state.tables = {
    items_windowed: ROWS.items,
    projects: ROWS.projects,
    item_types: ROWS.item_types,
    routines: ROWS.routines,
    routine_items: ROWS.routine_items,
    seasons: ROWS.seasons,
    season_items: ROWS.season_items,
    season_routines: ROWS.season_routines,
    goals: ROWS.goals,
    goal_items: ROWS.goal_items,
  };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('the RPC path', () => {
  it('is one request: no table reads, no fallback', async () => {
    const db = await freshDb();
    const perTable = vi.fn(async () => sentinel());
    await db.loadPlannerData(U, perTable);

    expect(state.rpcCalls).toEqual(['load_planner']);
    expect(state.fromCalls).toEqual([]);
    expect(perTable).not.toHaveBeenCalled();
  });

  it('assembles the same planner the per-table fetchers do', async () => {
    const db = await freshDb();
    const viaRpc = await db.loadPlannerData(U, vi.fn(async () => sentinel()));
    const viaTables = await perTableOf(db)();

    expect(viaRpc).toEqual(viaTables);
    // And it is the real thing, not two empty answers agreeing.
    expect(viaRpc.items.map((i) => i.id)).toEqual(['i1', 'i2']);
    expect(viaRpc.routines?.[0].itemIds).toEqual(['i2', 'i1']);
    expect(viaRpc.routines?.[1].itemIds).toEqual([]);
    expect(viaRpc.seasons?.[0]).toMatchObject({ itemIds: ['i1'], routineIds: ['r1'] });
    // The unknown role files as a plain member rather than vanishing.
    expect(viaRpc.goals?.[0]).toMatchObject({ milestoneIds: ['i1'], memberIds: ['i2'], checkinIds: [] });
    expect(viaRpc.goals?.[1].state).toBe('active');
  });

  it('gives every memberless goal its own arrays', async () => {
    const db = await freshDb();
    const { goals } = await db.loadPlannerData(U, vi.fn(async () => sentinel()));
    const [, g2, g3] = goals!;
    expect(g2.memberIds).not.toBe(g3.memberIds);
    expect(g2.milestoneIds).not.toBe(g3.milestoneIds);
    expect(g2.checkinIds).not.toBe(g3.checkinIds);
  });

  it('serves all four nullable collections as arrays (050 implies 021, 024, 036)', async () => {
    const db = await freshDb();
    const data = await db.loadPlannerData(U, vi.fn(async () => sentinel()));
    expect(data.itemTypes).not.toBeNull();
    expect(data.routines).not.toBeNull();
    expect(data.seasons).not.toBeNull();
    expect(data.goals).not.toBeNull();
  });
});

describe('a missing RPC', () => {
  it.each(['PGRST202', '42883', '42P01'])('(%s) falls back once, then latches', async (code) => {
    const db = await freshDb();
    state.rpcResult = { data: null, error: { code, message: 'missing' } };
    const perTable = vi.fn(async () => sentinel());

    await db.loadPlannerData(U, perTable);
    expect(state.rpcCalls).toHaveLength(1);
    expect(perTable).toHaveBeenCalledTimes(1);
    expect(db.getPlannerRpcAvailable()).toBe(false);

    // Latched: the fallback runs in the caller's own frame, before anything
    // is awaited, and the RPC is never probed again.
    const again = db.loadPlannerData(U, perTable);
    expect(perTable).toHaveBeenCalledTimes(2);
    await again;
    expect(state.rpcCalls).toHaveLength(1);
  });

  it('returns what the fallback returns', async () => {
    const db = await freshDb();
    state.rpcResult = { data: null, error: { code: 'PGRST202' } };
    const out = sentinel();
    await expect(db.loadPlannerData(U, async () => out)).resolves.toBe(out);
  });
});

describe('an unknown bundle shape', () => {
  it('falls back to the per-table load and latches', async () => {
    const db = await freshDb();
    state.rpcResult = { data: bundle({ v: 2 }), error: null };
    const perTable = vi.fn(async () => sentinel());

    await db.loadPlannerData(U, perTable);
    expect(perTable).toHaveBeenCalledTimes(1);
    expect(db.getPlannerRpcAvailable()).toBe(false);
  });

  it('treats a null answer the same way', async () => {
    const db = await freshDb();
    state.rpcResult = { data: null, error: null };
    const perTable = vi.fn(async () => sentinel());
    await db.loadPlannerData(U, perTable);
    expect(perTable).toHaveBeenCalledTimes(1);
  });
});

describe('any other error', () => {
  it.each([
    ['a 5xx', { code: '500', message: 'upstream' }],
    ['an expired JWT', { code: 'PGRST301', message: 'JWT expired' }],
    ['a statement timeout', { code: '57014', message: 'canceling statement' }],
  ])('%s fails the load, without the fallback and without latching', async (_label, error) => {
    const db = await freshDb();
    state.rpcResult = { data: null, error };
    const perTable = vi.fn(async () => sentinel());

    await expect(db.loadPlannerData(U, perTable)).rejects.toBe(error);
    expect(perTable).not.toHaveBeenCalled();
    expect(db.getPlannerRpcAvailable()).toBe(true);
  });

  it('an answer for a different session fails the load', async () => {
    const db = await freshDb();
    state.rpcResult = { data: bundle({ uid: 'someone-else' }), error: null };
    const perTable = vi.fn(async () => sentinel());

    await expect(db.loadPlannerData(U, perTable)).rejects.toThrow(/different session/);
    expect(perTable).not.toHaveBeenCalled();
  });

  it('so does an anonymous answer (uid null)', async () => {
    const db = await freshDb();
    state.rpcResult = { data: bundle({ uid: null }), error: null };
    await expect(db.loadPlannerData(U, vi.fn(async () => sentinel()))).rejects.toThrow(/different session/);
  });
});

describe('fetchProjects', () => {
  it('orders by created_at, then id, as load_planner does', async () => {
    const db = await freshDb();
    await db.fetchProjects(U);
    expect(state.orders.projects).toEqual([
      ['created_at', { ascending: true }],
      ['id', { ascending: true }],
    ]);
  });
});
