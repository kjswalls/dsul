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
const itemsInFlight = new Promise<unknown[]>((resolve) => {
  releaseItems = resolve;
});

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
