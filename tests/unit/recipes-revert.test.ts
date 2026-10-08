import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Revert of a server run (lib/recipes/revert.ts): the run's items read back
 * and folded into the store (a tab open across the run never saw it), then
 * claimed, then the run's inverse writes through the planner store as ONE quiet history entry
 * (so one ⌘Z takes the Revert back), raising no recipe event, each op asking
 * the live store first; then its own result row, since mod_runs has no UPDATE.
 *
 * Same harness as mod-events-store.test.ts: db mocked, the REAL store driven.
 */

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    fetchItems: vi.fn(async () => []),
    fetchProjects: vi.fn(async () => []),
    fetchItemTypes: vi.fn(async () => []),
    fetchRoutines: vi.fn(async () => []),
    fetchSeasons: vi.fn(async () => []),
    fetchGoals: vi.fn(async () => []),
    loadPlannerData: vi.fn((_u: string, perTable: () => Promise<unknown>) => perTable()),
    createItem: vi.fn(async () => {}),
    createItems: vi.fn(async () => {}),
    updateItem: vi.fn(async () => {}),
    deleteItem: vi.fn(async () => {}),
    restoreItem: vi.fn(async () => {}),
    setItemCompletion: vi.fn(async () => {}),
    setItemSkip: vi.fn(async () => {}),
    updateGoal: vi.fn(async () => {}),
    recordCheckin: vi.fn(),
    fetchItemById: vi.fn(async (_u: string, id: string) => serverRows.get(id) ?? null),
  };
});
vi.mock('@/lib/supabase', () => ({ createClient: () => ({}) }));
vi.mock('@/lib/openclaw-registry', () => ({ notifyPlugins: vi.fn() }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/lib/completion-confetti', () => ({ celebrateCompletion: vi.fn() }));
const runs = vi.hoisted(() => ({ claimRun: vi.fn(), logRun: vi.fn() }));
/** The rows as the database has them now, by id: by default, what the tab loaded. */
let serverRows = new Map<string, Item>();
vi.mock('@/lib/recipes/runs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/recipes/runs')>()),
  claimRun: runs.claimRun,
  logRun: runs.logRun,
}));

import { getActionLog, usePlannerStore } from '@/lib/planner-store';
import { subscribeModEvents, __resetModEventsForTests, type ModEvent } from '@/lib/mod-events';
import { revertServerRun } from '@/lib/recipes/revert';
import type { RunRow } from '@/lib/recipes/runs';
import * as db from '@/lib/db';
import type { Item } from '@/lib/planner-types';

const USER = 'user-1';
const MOD = '33333333-3333-4333-8333-333333333333';
const TODAY = '2026-03-10';
const H = '44444444-4444-4444-8444-444444444444';
const O = '55555555-5555-4555-8555-555555555555';
const R = '66666666-6666-4666-8666-666666666666';
const M = '77777777-7777-4777-8777-777777777777';
const C = '88888888-8888-4888-8888-888888888888';

const task = (id: string, over: Partial<Item> = {}): Item =>
  ({ type: 'task', id, title: `Task ${id}`, status: 'pending', isScheduled: false, order: 0, completedDates: [], skippedDates: [], ...over }) as Item;
const habit = (id: string, over: Partial<Item> = {}): Item =>
  ({
    type: 'habit', id, title: 'Run', project: '', streak: 3, status: 'done', completedDates: [], skippedDates: [], dailyCounts: {}, repeatFrequency: 'daily', ...over,
  }) as Item;

/** What a server run did: ticked H and O, skipped R, moved M on two days, added C. */
const world = () => [
  habit(H, { completedDates: [TODAY] }),
  task(O, { status: 'completed', startDate: TODAY }),
  task(R, { repeatFrequency: 'daily', startDate: '2026-03-01', skippedDates: [TODAY] }),
  task(M, { startDate: '2026-03-12', timeBucket: 'anytime', isScheduled: true }),
  task(C, { title: 'Plan the day' }),
];

const RUN: RunRow = {
  claimKey: 'time:2026-03-10:07:30:done',
  at: '2026-03-10T07:30:00Z',
  summary: {
    kind: 'run', server: true, day: TODAY, trigger: 'time', did: 5, of: 5, skipped: 0, refused: 0, stopped: 0, steps: ['done', 'done', 'done', 'done', 'done'],
    undo: [
      ['delete', C],
      ['move', M, TODAY, '2026-03-12'],
      ['unskip', R, TODAY],
      ['uncomplete', O, null],
      ['uncomplete', H, TODAY],
    ],
  },
};

const store = () => usePlannerStore.getState();
const item = (id: string) => store().items.find((i) => i.id === id);
let events: ModEvent[] = [];

async function load(items: Item[]) {
  store().clearStore();
  vi.mocked(db.fetchItems).mockResolvedValue(items);
  serverRows = new Map(items.map((i) => [i.id, i]));
  await store().initializeStore(USER);
  usePlannerStore.setState({ selectedDate: new Date(`${TODAY}T12:00:00Z`), userTimezone: 'UTC' });
  vi.runAllTimers();
  events = [];
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  __resetModEventsForTests();
  subscribeModEvents((e) => events.push(e));
  runs.claimRun.mockReset().mockResolvedValue('won');
  runs.logRun.mockReset().mockResolvedValue(undefined);
  await load(world());
});
afterEach(() => vi.useRealTimers());

describe('revertServerRun', () => {
  it('claims, puts every write back as one quiet entry, raises nothing, and logs what it did', async () => {
    expect(await revertServerRun(MOD, 'Morning', RUN)).toBe('done');

    expect(runs.claimRun).toHaveBeenCalledWith(USER, MOD, 'revert:time:2026-03-10:07:30:done');
    expect(item(H)!.type === 'habit' && (item(H) as { completedDates: string[] }).completedDates).toEqual([]);
    expect(item(O)!.status).toBe('pending');
    expect(item(R)!.skippedDates).toEqual([]);
    expect((item(M) as { startDate?: string }).startDate).toBe(TODAY);
    expect(item(C)).toBeUndefined();

    vi.runAllTimers();
    expect(events).toEqual([]);
    expect(runs.logRun).toHaveBeenCalledWith(USER, MOD, 'revert:time:2026-03-10:07:30:done:done', {
      kind: 'revert',
      of: RUN.claimKey,
      did: 5,
      skipped: 0,
    });

    // One entry, named for the recipe, and one ⌘Z takes the whole Revert back.
    expect(getActionLog()[0].label).toBe('Revert: Morning');
    store().undo();
    expect((item(H) as { completedDates: string[] }).completedDates).toEqual([TODAY]);
    expect(item(O)!.status).toBe('completed');
    expect(item(R)!.skippedDates).toEqual([TODAY]);
    expect((item(M) as { startDate?: string }).startDate).toBe('2026-03-12');
    expect(item(C)).toBeDefined();
  });

  it('leaves alone what was already put back by hand', async () => {
    await load([
      habit(H, { completedDates: [] }),
      task(O, { status: 'pending', startDate: TODAY }),
      task(R, { repeatFrequency: 'daily', startDate: '2026-03-01', skippedDates: [TODAY] }),
      task(M, { startDate: '2026-03-20', timeBucket: 'anytime', isScheduled: true }),
    ]);
    expect(await revertServerRun(MOD, 'Morning', RUN)).toBe('done');
    expect(item(R)!.skippedDates).toEqual([]);
    expect((item(M) as { startDate?: string }).startDate).toBe('2026-03-20');
    expect(runs.logRun).toHaveBeenCalledWith(USER, MOD, expect.any(String), expect.objectContaining({ did: 1, skipped: 4 }));
  });

  it('a Revert already claimed elsewhere does nothing', async () => {
    runs.claimRun.mockResolvedValue('lost');
    expect(await revertServerRun(MOD, 'Morning', RUN)).toBe('taken');
    expect(item(C)).toBeDefined();
    expect(runs.logRun).not.toHaveBeenCalled();
  });

  it('claims nothing while the planner is another account’s or not loaded', async () => {
    usePlannerStore.setState({ isLoading: true });
    expect(await revertServerRun(MOD, 'Morning', RUN)).toBe('unavailable');
    expect(runs.claimRun).not.toHaveBeenCalled();
  });

  it('refuses ops that are not the server’s own shape, and runs that are not server runs', async () => {
    const bad = { ...RUN, summary: { ...RUN.summary, undo: [['delete', 'not-a-uuid']] as never } };
    expect(await revertServerRun(MOD, 'Morning', bad)).toBe('failed');
    const browser = { ...RUN, summary: { ...RUN.summary, server: undefined } };
    expect(await revertServerRun(MOD, 'Morning', browser)).toBe('failed');
    expect(await revertServerRun(MOD, 'Morning', { ...RUN, reverted: true })).toBe('taken');
    expect(await revertServerRun(MOD, 'Morning', { ...RUN, revertClaimed: true })).toBe('taken');
    expect(runs.claimRun).not.toHaveBeenCalled();
  });

  it('a tab loaded before the run reads the run’s rows back first, then puts them back', async () => {
    // The tab as it loaded at 07:00; the run at 07:30 ticked, skipped, moved and added.
    await load([
      habit(H, { completedDates: [], status: 'pending', streak: 2 }),
      task(O, { status: 'pending', startDate: TODAY }),
      task(R, { repeatFrequency: 'daily', startDate: '2026-03-01', skippedDates: [] }),
      task(M, { startDate: TODAY, timeBucket: 'anytime', isScheduled: true }),
    ]);
    serverRows = new Map(world().map((i) => [i.id, i]));
    vi.mocked(db.deleteItem).mockClear();
    vi.mocked(db.createItem).mockClear();
    expect(await revertServerRun(MOD, 'Morning', RUN)).toBe('done');

    expect(db.fetchItemById).toHaveBeenCalledWith(USER, C);
    expect((item(H) as { completedDates: string[] }).completedDates).toEqual([]);
    expect(item(O)!.status).toBe('pending');
    expect(item(R)!.skippedDates).toEqual([]);
    expect((item(M) as { startDate?: string }).startDate).toBe(TODAY);
    expect(item(C)).toBeUndefined();
    expect(db.deleteItem).toHaveBeenCalledWith(C, expect.anything());
    // Folding the server's rows in wrote nothing back and started no recipe.
    expect(db.createItem).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(events).toEqual([]);
    expect(runs.logRun).toHaveBeenCalledWith(USER, MOD, expect.any(String), expect.objectContaining({ did: 5, skipped: 0 }));

    // ⌘Z takes back the Revert to what the server had, never to the stale tab.
    store().undo();
    expect((item(H) as { completedDates: string[] }).completedDates).toEqual([TODAY]);
    expect(item(C)).toBeDefined();
  });

  it('with nothing left to put back it claims nothing, so the Revert stays honest', async () => {
    await load([
      habit(H, { completedDates: [] }),
      task(O, { status: 'pending', startDate: TODAY }),
      task(R, { repeatFrequency: 'daily', startDate: '2026-03-01', skippedDates: [] }),
      task(M, { startDate: TODAY, timeBucket: 'anytime', isScheduled: true }),
    ]);
    expect(await revertServerRun(MOD, 'Morning', RUN)).toBe('nothing');
    expect(runs.claimRun).not.toHaveBeenCalled();
    expect(runs.logRun).not.toHaveBeenCalled();
  });

  it('an item gone from the database is not put back from a stale store', async () => {
    serverRows.delete(C);
    vi.mocked(db.deleteItem).mockClear();
    expect(await revertServerRun(MOD, 'Morning', RUN)).toBe('done');
    expect(db.deleteItem).not.toHaveBeenCalledWith(C, expect.anything());
    expect(runs.logRun).toHaveBeenCalledWith(USER, MOD, expect.any(String), expect.objectContaining({ did: 4, skipped: 1 }));
  });

  it('a failed read claims nothing', async () => {
    vi.mocked(db.fetchItemById).mockRejectedValueOnce(new Error('offline'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await revertServerRun(MOD, 'Morning', RUN)).toBe('failed');
    expect(runs.claimRun).not.toHaveBeenCalled();
    expect(item(C)).toBeDefined();
  });

  it('a claim that errors is failed, not "open your planner"', async () => {
    runs.claimRun.mockResolvedValue('error');
    expect(await revertServerRun(MOD, 'Morning', RUN)).toBe('failed');
    expect(item(C)).toBeDefined();
  });

  it('a planner gone under the claim logs that nothing was put back', async () => {
    runs.claimRun.mockImplementation(async () => {
      usePlannerStore.setState({ isLoading: true });
      return 'won';
    });
    expect(await revertServerRun(MOD, 'Morning', RUN)).toBe('failed');
    expect(runs.logRun).toHaveBeenCalledWith(USER, MOD, 'revert:time:2026-03-10:07:30:done:done', {
      kind: 'revert',
      of: RUN.claimKey,
      did: 0,
      skipped: 5,
      failed: 'planner-not-ready',
    });
    usePlannerStore.setState({ isLoading: false });
    expect(item(C)).toBeDefined();
  });
});
