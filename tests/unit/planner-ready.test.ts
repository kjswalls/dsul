import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The one readiness predicate (lib/planner-ready.ts) — read by the canvas
 * routers' skeleton swap and `data-loaded`, the braindump, AppShell's EOD deep
 * link and the Display summary. A truth table over the states the store's
 * writers actually produce, then the real store walked through them, because
 * the predicate is only right if every writer clears `isLoading` in the same
 * set() that settles the outcome.
 */

let failNext = false;
vi.mock('@/lib/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/db');
  return {
    ...actual,
    fetchItems: async () => {
      if (failNext) {
        failNext = false;
        throw { message: 'boom' };
      }
      return [];
    },
    fetchProjects: async () => [],
    fetchItemTypes: async () => [],
    fetchRoutines: async () => [],
    fetchSeasons: async () => [],
    fetchGoals: async () => [],
    // No RPC: the per-table fallback (the fetchers above).
    loadPlannerData: vi.fn((_u: string, perTable: () => Promise<unknown>) => perTable()),
  };
});

import { usePlannerStore } from '@/lib/planner-store';
import { selectPlannerPending, selectPlannerSettled } from '@/lib/planner-ready';

describe('selectPlannerSettled: truth table', () => {
  const cases: [string, { userId: string | null; isLoading: boolean }, boolean][] = [
    // isLoading is FALSE at rest: the bare `!isLoading` would call this loaded.
    ['pre-init (no account, not loading)', { userId: null, isLoading: false }, false],
    ['no account, loading (never written, still pending)', { userId: null, isLoading: true }, false],
    ['identified / loading', { userId: 'u1', isLoading: true }, false],
    ['loaded', { userId: 'u1', isLoading: false }, true],
  ];
  it.each(cases)('%s', (_name, s, settled) => {
    expect(selectPlannerSettled(s)).toBe(settled);
    expect(selectPlannerPending(s)).toBe(!settled);
  });

  it('counts a failed load as settled — the error rides in the same set()', () => {
    const failed = { userId: 'u1', isLoading: false, error: 'boom', loadFailedUserId: 'u1' };
    expect(selectPlannerSettled(failed)).toBe(true);
  });
});

describe('selectPlannerSettled: the real store', () => {
  beforeEach(() => {
    usePlannerStore.getState().clearStore();
    failNext = false;
  });

  const settled = () => selectPlannerSettled(usePlannerStore.getState());

  it('is pending after clearStore and after identifyUser', () => {
    expect(settled()).toBe(false);
    usePlannerStore.getState().identifyUser('u1');
    expect(settled()).toBe(false);
  });

  it('settles on a FAILED load, with loadFailedUserId stamped', async () => {
    failNext = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    usePlannerStore.getState().identifyUser('u1');
    await usePlannerStore.getState().initializeStore('u1');
    err.mockRestore();
    expect(usePlannerStore.getState().loadFailedUserId).toBe('u1');
    expect(settled()).toBe(true);
  });

  it('settles when the fetchers resolve', async () => {
    usePlannerStore.getState().identifyUser('u1');
    const loading = usePlannerStore.getState().initializeStore('u1');
    expect(settled()).toBe(false);
    await loading;
    expect(settled()).toBe(true);
  });

  it('never emits a pending state for a repeat initializeStore on a loaded account', async () => {
    usePlannerStore.getState().identifyUser('u1');
    await usePlannerStore.getState().initializeStore('u1');
    expect(settled()).toBe(true);

    // The tab-focus / token-refresh re-entry: a skeleton flashing here would
    // be the tab-switch blank-screen bug with bars on it.
    const seen: boolean[] = [];
    const unsub = usePlannerStore.subscribe((s) => seen.push(selectPlannerSettled(s)));
    usePlannerStore.getState().identifyUser('u1');
    await usePlannerStore.getState().initializeStore('u1');
    unsub();
    expect(seen.every(Boolean)).toBe(true);
    expect(settled()).toBe(true);
  });
});
