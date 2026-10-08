import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The look-only preview inside initializeStore (lib/planner-store.ts).
 *
 * The cached planner is painted while the fresh load is in flight, and every
 * rule below is about it never becoming anything more than paint:
 *   - `isLoading` stays true, so every settled gate stays shut;
 *   - it is applied only to the load that offered it, for the account that
 *     offered it, over an EMPTY store;
 *   - it is never a history entry or the undo baseline, and a failed load
 *     drops it in the same set() that records the failure — otherwise ⌘Z
 *     would replay cached rows against the server;
 *   - the snapshot read can neither delay nor fail the load.
 *
 * Both the load and the snapshot read are held open by hand, because every
 * race here is about which of the two resolves first.
 */

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** One deferred per loadPlannerData call, oldest first. */
const pendingLoads: Deferred<unknown>[] = [];

vi.mock('@/lib/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/db');
  const mocked: Record<string, unknown> = { ...actual };
  for (const [name, value] of Object.entries(actual)) {
    if (typeof value !== 'function' || name === 'itemDbType') continue;
    mocked[name] = vi.fn(async () => (name.startsWith('fetch') ? [] : undefined));
  }
  mocked.loadPlannerData = vi.fn(() => {
    const d = deferred<unknown>();
    pendingLoads.push(d);
    return d.promise;
  });
  return mocked;
});
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/planner-snapshot', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/planner-snapshot');
  return { ...actual, readPlannerSnapshot: vi.fn(async () => null), markPreviewPending: vi.fn() };
});

import * as db from '@/lib/db';
import { readPlannerSnapshot, markPreviewPending, type PlannerSnapshotData } from '@/lib/planner-snapshot';
import { getHistoryInfo, usePlannerStore } from '@/lib/planner-store';
import { useExtensionsStore } from '@/lib/extensions-store';
import { getCustomTypeDefs } from '@/lib/item-registry';
import {
  selectPlannerLoaded,
  selectPlannerSettled,
  selectPlannerVisible,
} from '@/lib/planner-ready';
import type { Item, ItemTypeDef } from '@/lib/planner-types';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

const A = 'user-a';
const B = 'user-b';

const ERRAND: ItemTypeDef = { id: 'type-errand', name: 'errand', label: 'Errand', labelPlural: 'Errands' };

const task = (id: string, title: string): Item => ({
  type: 'task',
  id,
  title,
  status: 'pending',
  isScheduled: false,
  order: 0,
  completedDates: [],
});

/** What the browser remembers from last session. */
const CACHED = (): PlannerSnapshotData => ({
  items: [task('t-cached', 'Cached'), task('t-gone', 'Deleted elsewhere since')],
  projects: [{ id: 'p-cached', name: 'Old name', emoji: '' }],
  itemTypes: [ERRAND],
  routines: [],
  seasons: [],
  goals: [],
  itemTypesAvailable: true,
  collectionsAvailable: true,
  goalsAvailable: true,
  extensionsEnabled: { goals: true },
});

/** What the server says now. */
const FRESH = () => ({
  items: [task('t-cached', 'Renamed elsewhere'), task('t-new', 'Made elsewhere')],
  projects: [{ id: 'p-cached', name: 'New name', emoji: '' }],
  itemTypes: [],
  routines: [],
  seasons: [],
  goals: [],
});

const store = () => usePlannerStore.getState();
const ids = (items: Item[]) => items.map((i) => i.id).sort();
const CACHED_IDS = ids(CACHED().items);
const FRESH_IDS = ids(FRESH().items);

const read = vi.mocked(readPlannerSnapshot);
const loadPlannerData = vi.mocked(db.loadPlannerData);

/** Hold the snapshot read open; returns its resolver. */
function holdRead() {
  const d = deferred<PlannerSnapshotData | null>();
  read.mockImplementationOnce(() => d.promise);
  return d;
}

/** Let resolved promises run their continuations. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/**
 * Start A's first load, offering the preview, and land the cache. The load's
 * promise comes back boxed: returned bare, the async function would adopt it
 * and wait for the very landing the caller has not released yet.
 */
async function previewA(allowed = () => true) {
  store().identifyUser(A);
  const snap = holdRead();
  const loading = store().initializeStore(A, { preview: allowed });
  snap.resolve(CACHED());
  await flush();
  return { loading };
}

const landFresh = async (loading: Promise<void>) => {
  pendingLoads.shift()!.resolve(FRESH());
  await loading;
};

const failLoad = async (loading: Promise<void>) => {
  pendingLoads.shift()!.reject({ message: 'boom' });
  await loading;
};

let consoleError: ReturnType<typeof vi.spyOn>;
let consoleWarn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  store().clearStore();
  pendingLoads.length = 0;
  vi.clearAllMocks();
  read.mockImplementation(async () => null);
  useExtensionsStore.setState({
    hydratedUserId: A,
    configsLoaded: false,
    available: true,
    enabled: {},
    previewEnabled: null,
  });
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  // Never leave a load open for the next test.
  while (pendingLoads.length) pendingLoads.shift()!.resolve(FRESH());
  await flush();
  consoleError.mockRestore();
  consoleWarn.mockRestore();
});

describe('applying the preview', () => {
  it('paints the cache while the load is still out: previewing, loading, visible, not settled or loaded', async () => {
    const { loading } = await previewA();

    const s = store();
    expect(ids(s.items)).toEqual(CACHED_IDS);
    expect(s.projects.map((p) => p.name)).toEqual(['Old name']);
    expect(s.isPreview).toBe(true);
    expect(s.isLoading).toBe(true);
    expect(selectPlannerSettled(s)).toBe(false);
    expect(selectPlannerVisible(s)).toBe(true);
    expect(selectPlannerLoaded(s)).toBe(false);

    await landFresh(loading);
  });

  it('never writes userId, isLoading, error, loadFailedUserId, userTimezone or any history field', async () => {
    store().identifyUser(A);
    // hydrateSettings lands the zone first, as it can in the provider.
    usePlannerStore.setState({ userTimezone: 'Europe/Paris' });
    const snap = holdRead();
    const loading = store().initializeStore(A, { preview: () => true });

    const edges: { prev: ReturnType<typeof store>; next: ReturnType<typeof store> }[] = [];
    const unsub = usePlannerStore.subscribe((next, prev) => {
      if (next.isPreview && !prev.isPreview) edges.push({ prev, next });
    });
    snap.resolve(CACHED());
    await flush();
    unsub();

    expect(edges).toHaveLength(1);
    const { prev, next } = edges[0];
    for (const key of [
      'userId', 'isLoading', 'error', 'loadFailedUserId', 'userTimezone',
      'canUndo', 'canRedo', 'actionLog', 'historyIndex',
    ] as const) {
      expect(next[key], key).toBe(prev[key]);
    }
    expect(next.userTimezone).toBe('Europe/Paris');

    await landFresh(loading);
  });

  it('starts the fetch synchronously, BEFORE the snapshot read and before any await', () => {
    store().identifyUser(A);
    void store().initializeStore(A, { preview: () => true });
    // Still inside the call's synchronous run: nothing has been awaited yet.
    expect(loadPlannerData).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(A);
    expect(loadPlannerData.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0]);
  });

  it('reads nothing without a preview option — a Retry is bare', async () => {
    store().identifyUser(A);
    const loading = store().initializeStore(A);
    expect(read).not.toHaveBeenCalled();
    await landFresh(loading);
    expect(read).not.toHaveBeenCalled();
  });

  it('applies the cached custom types and the extension seed BEFORE the preview set(), behind the crash marker', async () => {
    store().identifyUser(A);
    const snap = holdRead();
    const loading = store().initializeStore(A, { preview: () => true });

    let seen: { types: string[]; ext: unknown; marked: boolean } | null = null;
    const unsub = usePlannerStore.subscribe((next, prev) => {
      if (next.isPreview && !prev.isPreview) {
        seen = {
          types: getCustomTypeDefs().map((d) => d.name),
          ext: useExtensionsStore.getState().previewEnabled,
          marked: vi.mocked(markPreviewPending).mock.calls.some(([on]) => on === true),
        };
      }
    });
    snap.resolve(CACHED());
    await flush();
    unsub();

    expect(seen).toEqual({ types: ['errand'], ext: { goals: true }, marked: true });
    // The seed is display-only: the real toggles are untouched.
    expect(useExtensionsStore.getState().enabled).toEqual({});

    await landFresh(loading);
  });

  it('evaluates allowed() at APPLY time, and a false answer means no preview', async () => {
    store().identifyUser(A);
    const allowed = vi.fn(() => false);
    const snap = holdRead();
    const loading = store().initializeStore(A, { preview: allowed });
    expect(allowed).not.toHaveBeenCalled();

    snap.resolve(CACHED());
    await flush();
    expect(allowed).toHaveBeenCalledTimes(1);
    expect(store().isPreview).toBe(false);
    expect(store().items).toEqual([]);
    expect(markPreviewPending).not.toHaveBeenCalled();
    expect(getCustomTypeDefs()).toEqual([]);

    await landFresh(loading);
  });

  it.each(['items', 'projects', 'itemTypes', 'routines', 'seasons', 'goals'] as const)(
    'paints over an EMPTY store only (%s already holds something)',
    async (slice) => {
      store().identifyUser(A);
      const snap = holdRead();
      const loading = store().initializeStore(A, { preview: () => true });
      const row =
        slice === 'items'
          ? task('t-typed', 'Typed during the load')
          : slice === 'itemTypes'
            ? { ...ERRAND, id: 'type-other', name: 'other' }
            : { id: 'x', name: 'x' };
      usePlannerStore.setState({ [slice]: [row] } as never);

      snap.resolve(CACHED());
      await flush();
      expect(store().isPreview).toBe(false);
      expect((store()[slice] as unknown[]).length).toBe(1);

      await landFresh(loading);
    }
  );
});

describe('a read that resolves too late is ignored', () => {
  it('after the fresh set()', async () => {
    store().identifyUser(A);
    const snap = holdRead();
    const loading = store().initializeStore(A, { preview: () => true });
    await landFresh(loading);

    snap.resolve(CACHED());
    await flush();
    expect(store().isPreview).toBe(false);
    expect(ids(store().items)).toEqual(FRESH_IDS);
  });

  it('for a superseded load generation', async () => {
    store().identifyUser(A);
    const snap = holdRead();
    const first = store().initializeStore(A, { preview: () => true });
    // A second load for the same account while the first is out replaces it.
    const second = store().initializeStore(A);

    snap.resolve(CACHED());
    await flush();
    expect(store().isPreview).toBe(false);
    expect(store().items).toEqual([]);

    await landFresh(first);
    await landFresh(second);
    expect(ids(store().items)).toEqual(FRESH_IDS);
  });

  it('after identifyUser(B)', async () => {
    store().identifyUser(A);
    const snap = holdRead();
    const loading = store().initializeStore(A, { preview: () => true });
    store().identifyUser(B);

    snap.resolve(CACHED());
    await flush();
    expect(store().userId).toBe(B);
    expect(store().isPreview).toBe(false);
    expect(store().items).toEqual([]);

    await landFresh(loading);
  });

  it('after clearStore', async () => {
    store().identifyUser(A);
    const snap = holdRead();
    const loading = store().initializeStore(A, { preview: () => true });
    store().clearStore();

    snap.resolve(CACHED());
    await flush();
    expect(store().userId).toBe(null);
    expect(store().isPreview).toBe(false);
    expect(store().items).toEqual([]);

    await landFresh(loading);
  });
});

describe('the landing', () => {
  it('clears isPreview in the SAME set() as the fresh slices — no subscriber sees a mixed state', async () => {
    const { loading } = await previewA();

    const states: { items: string[]; isPreview: boolean; isLoading: boolean }[] = [];
    const unsub = usePlannerStore.subscribe((s) =>
      states.push({ items: ids(s.items), isPreview: s.isPreview, isLoading: s.isLoading })
    );
    await landFresh(loading);
    unsub();

    expect(states.length).toBeGreaterThan(0);
    for (const s of states) {
      if (s.isPreview) expect(s).toEqual({ items: CACHED_IDS, isPreview: true, isLoading: true });
      else expect(s.items).toEqual(FRESH_IDS);
    }
    expect(states[0]).toEqual({ items: FRESH_IDS, isPreview: false, isLoading: false });
  });

  it('keeps the preview out of history: no undo through it, and the baseline is FRESH', async () => {
    const { loading } = await previewA();
    expect(store().canUndo).toBe(false);
    expect(getHistoryInfo().totalEntries).toBe(0);

    await landFresh(loading);
    expect(store().canUndo).toBe(false);
    expect(getHistoryInfo().totalEntries).toBe(1);
    expect(store().actionLog.map((e) => e.label)).toEqual(['Session start']);

    // One edit, one undo: back to FRESH, and the only write is the edit's own.
    store().updateTask('t-new', { title: 'Edited' });
    vi.clearAllMocks();
    store().undo();
    expect(store().items.map((i) => i.title).sort()).toEqual(['Made elsewhere', 'Renamed elsewhere']);
    expect(db.restoreItem).not.toHaveBeenCalled();
    expect(db.deleteItem).not.toHaveBeenCalled();
    expect(db.updateItem).toHaveBeenCalledTimes(1);
    expect(db.updateItem).toHaveBeenCalledWith('t-new', 'task', { title: 'Made elsewhere' });
    expect(store().canUndo).toBe(false);
  });

  it('commits the fresh rows only AFTER the landing set(): a subscriber inside it still reads the PREVIEW DOM', async () => {
    // The settle conductor (lib/settle.ts) captures FIRST from exactly such a
    // subscriber, so this ordering is its foundation: a concurrent root flushes
    // a store-driven (sync-lane) update in a microtask, never inside set().
    // Outside act(), as a browser runs it — act() would batch the render itself.
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const wasAct = g.IS_REACT_ACT_ENVIRONMENT;
    g.IS_REACT_ACT_ENVIRONMENT = false;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    function Titles() {
      const items = usePlannerStore((s) => s.items);
      return createElement('ul', null, ...items.map((i) => createElement('li', { key: i.id }, i.title)));
    }
    try {
      const { loading } = await previewA();
      flushSync(() => root.render(createElement(Titles)));
      expect(host.textContent).toContain('Deleted elsewhere since');

      let seen: string | null = null;
      const unsub = usePlannerStore.subscribe((s, prev) => {
        if (prev.isPreview && !s.isPreview) seen = host.textContent;
      });
      await landFresh(loading);
      unsub();

      expect(seen).toContain('Cached');
      expect(seen).toContain('Deleted elsewhere since');
      expect(seen).not.toContain('Renamed elsewhere');
      await flush();
      expect(host.textContent).toContain('Renamed elsewhere');
      expect(host.textContent).toContain('Made elsewhere');
      expect(host.textContent).not.toContain('Deleted elsewhere since');
    } finally {
      flushSync(() => root.unmount());
      host.remove();
      g.IS_REACT_ACT_ENVIRONMENT = wasAct;
    }
  });
});

describe('a failed load', () => {
  it('drops the preview in the SAME set() as the error, unregisters its types, and ⌘Z writes nothing', async () => {
    const { loading } = await previewA();
    expect(getCustomTypeDefs().map((d) => d.name)).toEqual(['errand']);

    const states: { items: number; projects: number; isPreview: boolean; error: string | null }[] = [];
    const unsub = usePlannerStore.subscribe((s) =>
      states.push({ items: s.items.length, projects: s.projects.length, isPreview: s.isPreview, error: s.error })
    );
    await failLoad(loading);
    unsub();

    const failed = states.find((s) => s.error !== null);
    expect(failed).toEqual({ items: 0, projects: 0, isPreview: false, error: 'Failed to load data' });
    // Never a state that carries the error AND cached rows.
    expect(states.filter((s) => s.error !== null && s.items > 0)).toEqual([]);

    const s = store();
    expect(s.loadFailedUserId).toBe(A);
    expect(s.isLoading).toBe(false);
    expect(selectPlannerSettled(s)).toBe(true);
    expect(selectPlannerLoaded(s)).toBe(false);
    expect(getCustomTypeDefs()).toEqual([]);

    vi.clearAllMocks();
    store().undo();
    store().redo();
    for (const writer of [
      db.restoreItem, db.deleteItem, db.updateItem, db.createItem,
      db.restoreProject, db.deleteProject, db.updateProject,
      db.restoreRoutine, db.deleteRoutine, db.updateRoutine,
      db.restoreSeason, db.deleteSeason, db.updateSeason,
      db.restoreGoal, db.deleteGoal, db.updateGoal,
    ]) {
      expect(writer).not.toHaveBeenCalled();
    }
  });

  it('without a preview leaves the data untouched, exactly as before', async () => {
    store().identifyUser(A);
    // Offered, but nothing on disk.
    const loading = store().initializeStore(A, { preview: () => true });
    await flush();
    // A capture typed during the load window (not previewing, so not refused).
    store().addTask({ title: 'Typed while loading', timeBucket: 'anytime' });
    usePlannerStore.setState({ userTimezone: 'Europe/Paris' });

    await failLoad(loading);
    const s = store();
    expect(s.items.map((i) => i.title)).toEqual(['Typed while loading']);
    expect(s.userTimezone).toBe('Europe/Paris');
    expect(s.error).toBe('Failed to load data');
  });
});

describe('the read cannot fail the load', () => {
  it('survives a synchronous throw', async () => {
    read.mockImplementationOnce(() => {
      throw new Error('IndexedDB exploded');
    });
    store().identifyUser(A);
    const loading = store().initializeStore(A, { preview: () => true });
    await landFresh(loading);
    expect(store().error).toBe(null);
    expect(ids(store().items)).toEqual(FRESH_IDS);
  });

  it('survives a rejection', async () => {
    read.mockImplementationOnce(() => Promise.reject(new Error('IndexedDB exploded')));
    store().identifyUser(A);
    const loading = store().initializeStore(A, { preview: () => true });
    await flush();
    await landFresh(loading);
    expect(store().error).toBe(null);
    expect(ids(store().items)).toEqual(FRESH_IDS);
  });
});

describe('dropPreview', () => {
  it('empties the data, keeps the load pending, records no history, and the landing renders fresh', async () => {
    const { loading } = await previewA();

    expect(store().dropPreview()).toBe(true);
    const s = store();
    expect(s.isPreview).toBe(false);
    expect(s.items).toEqual([]);
    expect(s.projects).toEqual([]);
    expect(s.isLoading).toBe(true);
    expect(selectPlannerVisible(s)).toBe(false);
    expect(getCustomTypeDefs()).toEqual([]);
    expect(getHistoryInfo().totalEntries).toBe(0);
    expect(s.canUndo).toBe(false);

    await landFresh(loading);
    expect(ids(store().items)).toEqual(FRESH_IDS);
    expect(store().isLoading).toBe(false);
    expect(getHistoryInfo().totalEntries).toBe(1);
  });

  it('returns false and touches nothing when not previewing', async () => {
    store().identifyUser(A);
    const loading = store().initializeStore(A);
    await landFresh(loading);
    const before = store();
    expect(store().dropPreview()).toBe(false);
    expect(store()).toBe(before);
  });
});
