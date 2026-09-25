import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

/**
 * A failed load can be retried, and a good one still cannot be.
 *
 * `initializeStore`'s opening guard used to read `userId` and `isLoading`
 * alone, and a failed load leaves the first stamped and the second false,
 * which is exactly what a finished load looks like. So the notice's Retry, and
 * the provider's retry on the next SIGNED_IN, both re-entered the function and
 * were turned away: the planner stayed empty until the page was reloaded, or
 * the user signed out and back in. `loadFailedUserId` is what tells the two
 * apart now, and these cases pin both sides of it. The guard exists to stop a
 * re-entry resetting a planner that loaded, and a retry that opened it wider
 * than a failed account would bring that bug back.
 *
 * Every failure is a Supabase error in the shape the fetchers really rethrow:
 * a plain object, not an Error. Every item fetch is a deferred the test
 * settles by hand, and any left open is settled after the test, so no load is
 * ever left pending for a later one.
 */

type Pending = { resolve: (rows: unknown[]) => void; reject: (error: unknown) => void };
const pending: Pending[] = [];
/** The Nth `fetchItems` call, counting from 0 across the whole test. */
const fetchNo = (n: number) => {
  const call = pending[n];
  if (!call) throw new Error(`fetch #${n} was never made (${pending.length} so far)`);
  return call;
};

vi.mock('@/lib/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/db');
  return {
    ...actual,
    fetchItems: vi.fn(() => new Promise((resolve, reject) => pending.push({ resolve, reject }))),
    fetchProjects: vi.fn(async () => []),
    fetchItemTypes: vi.fn(async () => []),
    fetchRoutines: vi.fn(async () => []),
    fetchPrograms: vi.fn(async () => []),
    fetchGoals: vi.fn(async () => []),
    createProject: vi.fn(async () => {}),
    adoptContainerMembers: vi.fn(async () => {}),
  };
});

import { usePlannerStore } from '@/lib/planner-store';
import { DEFAULT_PROJECTS } from '@/lib/planner-types';
import * as db from '@/lib/db';

const A = 'user-a';
const B = 'user-b';
const store = () => usePlannerStore.getState();
const fetches = () => vi.mocked(db.fetchItems).mock.calls.length;
const task = (id: string) => ({ id, title: id, type: 'task', completedDates: [] });
/** A PostgREST error as supabase-js returns it when throwOnError is off. */
const postgrestError = (message = 'canceling statement due to statement timeout') => ({
  message,
  details: null,
  hint: null,
  code: '57014',
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  store().clearStore();
  pending.length = 0;
  vi.mocked(db.fetchItems).mockClear();
  vi.mocked(db.createProject).mockClear();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  // A guard that regressed starts a load these tests never settle. Settled
  // here, it finishes against a store the next beforeEach has cleared, where
  // the generation check discards it.
  for (const call of pending) call.resolve([]);
  consoleError.mockRestore();
});

/** Sign A in and fail its first load, the way the provider starts one. */
async function failFirstLoad() {
  store().identifyUser(A);
  const loading = store().initializeStore(A);
  await settle();
  fetchNo(0).reject(postgrestError());
  await loading;
}

/** Record one ordinary change, so there is undo history to lose. */
async function editSomething() {
  usePlannerStore.setState({ items: [...store().items, task('typed')] } as never);
  await settle();
}

describe('a failed load', () => {
  it('is recorded as failed, for the account it failed for', async () => {
    await failFirstLoad();

    expect(store().isLoading).toBe(false);
    expect(store().error).toBe('Failed to load data');
    expect(store().loadFailedUserId).toBe(A);
  });

  it('loads when it is asked again', async () => {
    await failFirstLoad();

    const retry = store().initializeStore(A);
    await settle();
    expect(fetches()).toBe(2);
    fetchNo(1).resolve([task('a1')]);
    await retry;

    expect(store().items.map((i) => i.id)).toEqual(['a1']);
    expect(store().error).toBeNull();
    expect(store().loadFailedUserId).toBeNull();
    expect(store().isLoading).toBe(false);
  });

  it('can fail again, and be retried again', async () => {
    await failFirstLoad();

    const retry = store().initializeStore(A);
    await settle();
    fetchNo(1).reject(postgrestError());
    await retry;
    expect(store().loadFailedUserId).toBe(A);

    const again = store().initializeStore(A);
    await settle();
    expect(fetches()).toBe(3);
    fetchNo(2).resolve([task('a1')]);
    await again;
    expect(store().items.map((i) => i.id)).toEqual(['a1']);
  });

  it('logs its cause, which the stored message never carries', async () => {
    const cause = postgrestError('JWT expired');
    store().identifyUser(A);
    const loading = store().initializeStore(A);
    await settle();
    fetchNo(0).reject(cause);
    await loading;

    expect(consoleError).toHaveBeenCalledWith('planner load failed', cause);
    expect(consoleError.mock.calls.filter(([what]) => what === 'planner load failed')).toHaveLength(1);
  });

  it('is forgotten when another account signs in', async () => {
    await failFirstLoad();

    store().identifyUser(B);

    expect(store().loadFailedUserId).toBeNull();
    expect(store().error).toBeNull();
  });

  it('is forgotten on sign-out', async () => {
    await failFirstLoad();

    store().clearStore();

    expect(store().loadFailedUserId).toBeNull();
    expect(store().error).toBeNull();
  });
});

describe('the retry', () => {
  it('shows no undo history while it runs', async () => {
    await failFirstLoad();
    // The failed state records history like any other: the catch's own write
    // lands with the subscriber awake, and so does anything typed after it.
    await editSomething();
    expect(store().canUndo).toBe(true);

    const retry = store().initializeStore(A);

    // Read before anything settles: the load's first write is synchronous, and
    // the retry's own success write would set these anyway.
    expect(store().isLoading).toBe(true);
    expect(store().canUndo).toBe(false);
    expect(store().canRedo).toBe(false);
    expect(store().actionLog).toEqual([]);
    expect(store().historyIndex).toBe(-1);
    await settle();
    fetchNo(1).resolve([]);
    await retry;
  });
});

describe('an account that loaded', () => {
  it('is never reloaded', async () => {
    const loading = store().initializeStore(A);
    await settle();
    fetchNo(0).resolve([task('a1')]);
    await loading;
    await editSomething();
    const history = store().actionLog;

    // Not awaited: a guard that let this through would wait on a fetch no one
    // settles, and the test would time out rather than say what went wrong.
    void store().initializeStore(A);
    await settle();

    expect(fetches()).toBe(1);
    expect(store().isLoading).toBe(false);
    expect(store().canUndo).toBe(true);
    expect(store().actionLog).toEqual(history);
  });

  it('is never reloaded after recovering from a failure', async () => {
    await failFirstLoad();
    const retry = store().initializeStore(A);
    await settle();
    fetchNo(1).resolve([task('a1')]);
    await retry;
    await editSomething();

    // A Retry-button recovery leaves the provider unlatched, so its next
    // SIGNED_IN, on a tab switch, reaches the store and only the guard stops it.
    void store().initializeStore(A);
    await settle();

    expect(fetches()).toBe(2);
    expect(store().isLoading).toBe(false);
    expect(store().canUndo).toBe(true);
  });

  it('is never reloaded because of an `error` the load did not write', async () => {
    const loading = store().initializeStore(A);
    await settle();
    fetchNo(0).resolve([task('a1')]);
    await loading;
    await editSomething();

    // Nothing writes `error` but a failed load today. The guard must not care
    // if something does: keyed on `error`, any caller that reaches the store (a
    // Retry, or the provider's first SIGNED_IN after it unlatches) would reset
    // the planner and its undo stack.
    usePlannerStore.setState({ error: 'Failed to save' });
    void store().initializeStore(A);
    await settle();

    expect(fetches()).toBe(1);
    expect(store().isLoading).toBe(false);
    expect(store().canUndo).toBe(true);
  });
});

describe('a failure that is no longer the current load', () => {
  it('records nothing when a newer load for the same account replaced it', async () => {
    const older = store().initializeStore(A);
    await settle();
    const newer = store().initializeStore(A);
    await settle();

    fetchNo(0).reject(postgrestError());
    await older;
    expect(store().error).toBeNull();
    expect(store().loadFailedUserId).toBeNull();
    expect(consoleError).not.toHaveBeenCalledWith('planner load failed', expect.anything());

    fetchNo(1).resolve([task('fresh')]);
    await newer;
    expect(store().items.map((i) => i.id)).toEqual(['fresh']);
  });

  it('records nothing against the account that signed in after it', async () => {
    const aLoading = store().initializeStore(A);
    await settle();
    store().identifyUser(B);

    fetchNo(0).reject(postgrestError());
    await aLoading;

    expect(store().userId).toBe(B);
    expect(store().error).toBeNull();
    expect(store().loadFailedUserId).toBeNull();
  });
});

describe('the first-run seed', () => {
  it('is refused in the failed state, where empty means the fetch broke', async () => {
    await failFirstLoad();
    expect(store().projects).toEqual([]);

    const result = store().seedStarterContainers(
      { reason: 'new-account', projects: DEFAULT_PROJECTS },
      A
    );

    expect(result).toBe('refused');
    expect(store().projects).toEqual([]);
    expect(db.createProject).not.toHaveBeenCalled();
  });
});
