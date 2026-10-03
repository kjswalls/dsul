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
/** When set, fetchItems waits on it — the preview cases need the load held open. */
let heldItems: Promise<unknown[]> | null = null;
vi.mock('@/lib/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/db');
  return {
    ...actual,
    fetchItems: async () => {
      if (failNext) {
        failNext = false;
        throw { message: 'boom' };
      }
      return heldItems ?? [];
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

vi.mock('@/lib/planner-snapshot', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/planner-snapshot');
  return { ...actual, readPlannerSnapshot: vi.fn(async () => null), markPreviewPending: vi.fn() };
});

import { usePlannerStore } from '@/lib/planner-store';
import { readPlannerSnapshot, type PlannerSnapshotData } from '@/lib/planner-snapshot';
import {
  isPlannerLoaded,
  isPlannerPreviewing,
  selectPlannerLoaded,
  selectPlannerPending,
  selectPlannerSettled,
  selectPlannerVisible,
} from '@/lib/planner-ready';

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

/**
 * The preview's two readings beside settled (lib/planner-ready.ts):
 *   visible — fresh data OR the look-only preview; the views mount on it;
 *   loaded  — fresh data actually landed for THIS account; every surface that
 *             acts gates on it, because settled also counts a failed load.
 * And the invariant that makes the preview safe at all: settled ⇒ not
 * previewing, because `isLoading` stays true for the whole preview.
 */
type State = {
  userId: string | null;
  isLoading: boolean;
  isPreview?: boolean;
  error?: string | null;
  loadFailedUserId?: string | null;
};

describe('selectPlannerVisible / selectPlannerLoaded: truth tables', () => {
  const cases: [string, State, { visible: boolean; loaded: boolean }][] = [
    ['pre-init', { userId: null, isLoading: false }, { visible: false, loaded: false }],
    ['identified / loading', { userId: 'u1', isLoading: true }, { visible: false, loaded: false }],
    [
      'previewing (still loading)',
      { userId: 'u1', isLoading: true, isPreview: true },
      { visible: true, loaded: false },
    ],
    [
      'loaded',
      { userId: 'u1', isLoading: false, isPreview: false, error: null, loadFailedUserId: null },
      { visible: true, loaded: true },
    ],
    // The optional fields are optional: an old-shape snapshot still answers.
    ['loaded (two-field snapshot)', { userId: 'u1', isLoading: false }, { visible: true, loaded: true }],
    [
      // Settled and visible — the views show today's failure state — but
      // nothing may act on an empty store that only means "the fetch broke".
      'failed',
      { userId: 'u1', isLoading: false, error: 'boom', loadFailedUserId: 'u1' },
      { visible: true, loaded: false },
    ],
    [
      'an error with no failed account still is not loaded',
      { userId: 'u1', isLoading: false, error: 'boom', loadFailedUserId: null },
      { visible: true, loaded: false },
    ],
  ];
  it.each(cases)('%s', (_name, s, want) => {
    expect(selectPlannerVisible(s)).toBe(want.visible);
    expect(selectPlannerLoaded(s)).toBe(want.loaded);
    // loaded ⊂ settled ⊂ visible, in every row.
    if (selectPlannerLoaded(s)) expect(selectPlannerSettled(s)).toBe(true);
    if (selectPlannerSettled(s)) expect(selectPlannerVisible(s)).toBe(true);
  });
});

describe('settled ⇒ not previewing: the real store', () => {
  const SNAPSHOT: PlannerSnapshotData = {
    items: [
      { type: 'task', id: 'cached', title: 'Cached', status: 'pending', isScheduled: false, order: 0, completedDates: [] },
    ],
    projects: [],
    itemTypes: [],
    routines: [],
    seasons: [],
    goals: [],
    itemTypesAvailable: true,
    collectionsAvailable: true,
    goalsAvailable: true,
  };

  beforeEach(() => {
    usePlannerStore.getState().clearStore();
    failNext = false;
    vi.mocked(readPlannerSnapshot).mockResolvedValue(SNAPSHOT);
  });

  /** Identify, offer the preview, let it paint, then land or fail the held load. */
  async function walk(outcome: 'land' | 'fail') {
    let release!: (rows: unknown[]) => void;
    let fail!: (err: unknown) => void;
    heldItems = new Promise((resolve, reject) => {
      release = resolve;
      fail = reject;
    });
    const seen: { previewing: boolean; settled: boolean; loaded: boolean }[] = [];
    const unsub = usePlannerStore.subscribe((s) =>
      seen.push({ previewing: s.isPreview, settled: selectPlannerSettled(s), loaded: selectPlannerLoaded(s) })
    );
    usePlannerStore.getState().identifyUser('u1');
    const loading = usePlannerStore.getState().initializeStore('u1', { preview: () => true });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(usePlannerStore.getState().isPreview).toBe(true);
    expect(isPlannerPreviewing()).toBe(true);
    expect(isPlannerLoaded()).toBe(false);
    if (outcome === 'land') release([]);
    else fail({ message: 'boom' });
    heldItems = null;
    await loading;
    unsub();
    return seen;
  }

  it('never reports settled (or loaded) while the preview is up, through a landing', async () => {
    const seen = await walk('land');
    expect(seen.some((s) => s.previewing)).toBe(true);
    expect(seen.filter((s) => s.previewing && (s.settled || s.loaded))).toEqual([]);
    expect(isPlannerPreviewing()).toBe(false);
    expect(isPlannerLoaded()).toBe(true);
  });

  it('never reports settled while the preview is up, through a failure — and a failure is not loaded', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen = await walk('fail');
    err.mockRestore();
    expect(seen.some((s) => s.previewing)).toBe(true);
    expect(seen.filter((s) => s.previewing && s.settled)).toEqual([]);
    expect(selectPlannerSettled(usePlannerStore.getState())).toBe(true);
    expect(isPlannerPreviewing()).toBe(false);
    expect(isPlannerLoaded()).toBe(false);
  });

  it('the non-reactive forms answer false, not throw, against a mock with no getState', () => {
    const getState = usePlannerStore.getState;
    try {
      (usePlannerStore as unknown as { getState?: unknown }).getState = undefined;
      expect(isPlannerPreviewing()).toBe(false);
      expect(isPlannerLoaded()).toBe(false);
    } finally {
      usePlannerStore.getState = getState;
    }
  });
});
