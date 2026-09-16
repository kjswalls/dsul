import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `identifyUser` during another account's in-flight load.
 *
 * This is the one window where the difference between a hard
 * `isUpdatingUndoRedo = false` and the save-and-restore the store mandates is
 * observable, so it needs a REAL load held open rather than a flag poked from
 * outside — the flag is module-private, and a test that cannot hold it true
 * cannot tell the two versions apart.
 *
 * `initializeStore` sets the flag true and keeps it there across its ENTIRE
 * fetch, deliberately: the history subscriber must not wake while the store is
 * being replaced wholesale. An account switch with no intervening SIGNED_OUT
 * (Supabase delivers no event for it — see lib/local-state.ts) lands
 * `identifyUser` inside exactly that window. Handing the flag back unblocked
 * there is the bug `removeRefusedContainer`'s note was written for: the
 * subscriber's lazy-baseline branch fires mid-load, seeds a second 'Session
 * start', and leaves `historyIndex` naming a snapshot the store does not hold —
 * one ⌘Z after which soft-deletes every row the load just brought in.
 *
 * Verified by mutation: replacing the `finally { isUpdatingUndoRedo =
 * wasSuppressed }` in identifyUser with `isUpdatingUndoRedo = false` turns this
 * file red and nothing else in the suite.
 */

/** Held open for the whole test — this is what keeps the load in flight. */
let releaseItems: (value: unknown[]) => void = () => {};
let itemsInFlight = new Promise<unknown[]>((resolve) => {
  releaseItems = resolve;
});
const reopenItemsFetch = () => {
  itemsInFlight = new Promise<unknown[]>((resolve) => {
    releaseItems = resolve;
  });
};

vi.mock('@/lib/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/db');
  return {
    ...actual,
    fetchItems: () => itemsInFlight,
    fetchProjects: async () => [],
    fetchItemTypes: async () => [],
    fetchRoutines: async () => [],
    fetchPrograms: async () => [],
    fetchGoals: async () => [],
  };
});

import { usePlannerStore } from '@/lib/planner-store';

const A = 'user-a';
const B = 'user-b';

describe('identifyUser inside another load', () => {
  beforeEach(() => {
    usePlannerStore.getState().clearStore();
  });

  it('leaves the history subscriber suppressed while the load is still open', async () => {
    // A's load starts and parks on fetchItems.
    const loading = usePlannerStore.getState().initializeStore(A);
    await Promise.resolve();
    expect(usePlannerStore.getState().isLoading).toBe(true);

    // The switch, mid-flight.
    usePlannerStore.getState().identifyUser(B);
    expect(usePlannerStore.getState().userId).toBe(B);

    // Any write at all is enough to wake the subscriber IF the flag was handed
    // back false. It must stay asleep: the load that is still running owns it.
    usePlannerStore.setState({ error: 'a write that must not be recorded' });
    await Promise.resolve();

    expect(usePlannerStore.getState().actionLog).toEqual([]);
    expect(usePlannerStore.getState().historyIndex).toBe(-1);

    // Let A's load finish so it cannot leak into another test.
    releaseItems([]);
    await loading;
  });
});

/**
 * The account switch that outlives the load it interrupted.
 *
 * `initializeStore` takes ~6 requests to resolve, and an account switch with no
 * intervening SIGNED_OUT can land inside that window — Supabase delivers no
 * event for it (lib/local-state.ts), so nothing cancels the fetch. The apply
 * that follows belonged to nobody's current session.
 *
 * This was survivable while `userId` was stamped only by `initializeStore`: the
 * next load's own stamp went in first and the guard let it through. Once
 * `identifyUser` stamps the new account WITHOUT loading, a stale apply lands
 * user A's rows under user B's id and clears `isLoading` — and B then looks, to
 * initializeStore's opening guard, exactly like an account already loaded. The
 * leak stops being a flash and becomes the rest of the session.
 */
describe('a load that resolves after the account changed', () => {
  beforeEach(() => {
    usePlannerStore.getState().clearStore();
    reopenItemsFetch();
  });

  it('is dropped wholesale rather than applied to whoever is signed in now', async () => {
    const loading = usePlannerStore.getState().initializeStore(A);
    await Promise.resolve();

    // B arrives on a lean route: stamped, nothing fetched.
    usePlannerStore.getState().identifyUser(B);

    // A's fetch comes back late.
    releaseItems([{ id: 'a-item', title: 'A', type: 'task', completedDates: [] }]);
    await loading;

    const s = usePlannerStore.getState();
    expect(s.userId).toBe(B);
    // A's rows must not have landed...
    expect(s.items).toEqual([]);
    // ...and B must still read as unsettled, or its own load is refused by
    // initializeStore's opening guard and never runs at all.
    expect(s.isLoading).toBe(true);
  });

  it("leaves the new account's own load free to run", async () => {
    const loading = usePlannerStore.getState().initializeStore(A);
    await Promise.resolve();
    usePlannerStore.getState().identifyUser(B);
    releaseItems([{ id: 'a-item', title: 'A', type: 'task', completedDates: [] }]);
    await loading;

    // The navigation effect asking for B's items, for real this time.
    reopenItemsFetch();
    const bLoading = usePlannerStore.getState().initializeStore(B);
    releaseItems([{ id: 'b-item', title: 'B', type: 'task', completedDates: [] }]);
    await bLoading;

    const s = usePlannerStore.getState();
    expect(s.userId).toBe(B);
    expect(s.items.map((i) => i.id)).toEqual(['b-item']);
    expect(s.isLoading).toBe(false);
  });
});

/**
 * The identity stamp must not look like a finished load.
 *
 * `initializeStore` opens with `if (current.userId === userId &&
 * !current.isLoading) return` — a guard whose whole job is to refuse a re-entry
 * that would reset the store under a planner that is already loaded. An
 * identity stamp has to fall on the other side of it, or the route the user
 * navigates TO is refused its items and the planner stays empty for the rest of
 * the session.
 *
 * Asserted by driving the REAL initializeStore rather than re-deriving the
 * guard's expression, which would pass just as happily if the `!isLoading` term
 * were dropped from the real one.
 */
describe('identifyUser then a real load', () => {
  beforeEach(() => {
    usePlannerStore.getState().clearStore();
    reopenItemsFetch();
  });

  it('is not mistaken for an account that has already loaded', async () => {
    // A lands on /settings: stamped, nothing fetched.
    usePlannerStore.getState().identifyUser(A);
    expect(usePlannerStore.getState().items).toEqual([]);

    // ...then navigates to the planner.
    const loading = usePlannerStore.getState().initializeStore(A);
    releaseItems([{ id: 'a-item', title: 'A', type: 'task', completedDates: [] }]);
    await loading;

    expect(usePlannerStore.getState().items.map((i) => i.id)).toEqual(['a-item']);
    expect(usePlannerStore.getState().isLoading).toBe(false);
  });
});
