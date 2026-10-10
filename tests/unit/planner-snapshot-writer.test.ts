import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * lib/planner-snapshot-writer.ts, driven through the REAL planner store.
 *
 * The writer decides WHEN the snapshot is written and WHAT may be: only fresh
 * data, for the account that owns this browser, stamped with the moment THIS
 * tab fetched it. lib/planner-snapshot.ts (its own suite, against fake
 * IndexedDB) decides whether the disk takes it; here its entry points are
 * spies, so every assertion is about the writer's choice and nothing else.
 *
 * Both the load and the snapshot read are held open by hand, as in
 * planner-preview-store.test.ts, and the clock is fake: the debounce, the idle
 * fallback and `baseAt` are all time.
 */

const hoisted = vi.hoisted(() => ({ mode: { value: 'on' as 'on' | 'static' | 'off' } }));

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
  const actual = await vi.importActual<typeof import('@/lib/planner-snapshot')>('@/lib/planner-snapshot');
  return {
    ...actual,
    // The kill switch is a build-time constant; a getter lets a case flip it.
    get PREVIEW_MODE() {
      return hoisted.mode.value;
    },
    snapshotSupported: vi.fn(() => true),
    readPlannerSnapshot: vi.fn(async () => null),
    markPreviewPending: vi.fn(),
    previewRenderedCleanly: vi.fn(() => false),
    writePlannerSnapshot: vi.fn(async (): Promise<SnapshotWriteResult> => 'written'),
    purgePlannerSnapshotDb: vi.fn(),
  };
});

import {
  PREVIEW_EXPECTED_ATTR,
  clearPlannerSnapshot,
  getSnapshotEpoch,
  markPreviewPending,
  previewRenderedCleanly,
  purgePlannerSnapshotDb,
  readPlannerSnapshot,
  snapshotSupported,
  writePlannerSnapshot,
  type PlannerSnapshotData,
  type SnapshotWriteResult,
} from '@/lib/planner-snapshot';
import {
  SNAPSHOT_MAX_ITEMS,
  SNAPSHOT_WRITE_DEBOUNCE_MS,
  WRITE_RETRIES,
  snapshotWritable,
  startPlannerSnapshotWriter,
} from '@/lib/planner-snapshot-writer';
import { usePlannerStore } from '@/lib/planner-store';
import { useExtensionsStore } from '@/lib/extensions-store';
import { LOCAL_STATE_OWNER_KEY } from '@/lib/local-state';
import type { Item } from '@/lib/planner-types';

const A = 'user-a';
const B = 'user-b';
const T0 = new Date('2026-10-03T09:00:00Z').getTime();

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
  items: [task('t-cached', 'Cached')],
  projects: [],
  itemTypes: [],
  routines: [],
  seasons: [],
  goals: [],
  itemTypesAvailable: true,
  collectionsAvailable: true,
  goalsAvailable: true,
});

/** What the server says now. */
const FRESH = () => ({
  items: [task('t-cached', 'Renamed elsewhere'), task('t-new', 'Made elsewhere')],
  projects: [{ id: 'p1', name: 'Health', emoji: '' }],
  itemTypes: [],
  routines: [],
  seasons: [],
  goals: [],
});

const store = () => usePlannerStore.getState();
const ids = (items: readonly Item[]) => items.map((i) => i.id).sort();
const FRESH_IDS = ids(FRESH().items);

const write = vi.mocked(writePlannerSnapshot);
const marker = vi.mocked(markPreviewPending);
const cleanly = vi.mocked(previewRenderedCleanly);
const purge = vi.mocked(purgePlannerSnapshotDb);
const supported = vi.mocked(snapshotSupported);
const read = vi.mocked(readPlannerSnapshot);

/** The `data` argument of the nth write. */
const written = (n = 0) => write.mock.calls[n][1];

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const setOwner = (userId: string | null) => {
  if (userId) localStorage.setItem(LOCAL_STATE_OWNER_KEY, userId);
  else localStorage.removeItem(LOCAL_STATE_OWNER_KEY);
};

let stop: () => void = () => {};
const start = () => {
  stop = startPlannerSnapshotWriter();
};

/** Past the debounce and the idle fallback (jsdom has no requestIdleCallback, so setTimeout 0). */
const settle = () => vi.advanceTimersByTime(SNAPSHOT_WRITE_DEBOUNCE_MS + 1);

const setVisibility = (state: DocumentVisibilityState) =>
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
const hide = () => {
  setVisibility('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
};
const pagehide = () => window.dispatchEvent(new Event('pagehide'));
const show = () => {
  setVisibility('visible');
  document.dispatchEvent(new Event('visibilitychange'));
};
const pageshow = () => window.dispatchEvent(new Event('pageshow'));

const landFresh = async (loading: Promise<void>) => {
  pendingLoads.shift()!.resolve(FRESH());
  await loading;
};
const failLoad = async (loading: Promise<void>) => {
  pendingLoads.shift()!.reject({ message: 'boom' });
  await loading;
};

/** A first load, start to fresh landing. */
async function land(userId = A) {
  store().identifyUser(userId);
  await landFresh(store().initializeStore(userId));
}

/**
 * Start A's first load offering the preview, and paint the cache. The load's
 * promise comes back boxed, or the async function would adopt it and wait for
 * the landing the caller has not released yet.
 */
async function previewA() {
  store().identifyUser(A);
  const snap = deferred<PlannerSnapshotData | null>();
  read.mockImplementationOnce(() => snap.promise);
  const loading = store().initializeStore(A, { preview: () => true });
  snap.resolve(CACHED());
  await flush();
  return { loading };
}

let consoleError: ReturnType<typeof vi.spyOn>;
let consoleWarn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  hoisted.mode.value = 'on';
  store().clearStore();
  pendingLoads.length = 0;
  vi.clearAllMocks();
  supported.mockImplementation(() => true);
  read.mockImplementation(async () => null);
  write.mockImplementation(async () => 'written');
  marker.mockImplementation(() => {});
  cleanly.mockImplementation(() => false);
  setOwner(A);
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
  stop();
  stop = () => {};
  // Never leave a load open for the next test.
  while (pendingLoads.length) pendingLoads.shift()!.resolve(FRESH());
  await flush();
  vi.useRealTimers();
  delete (document as { visibilityState?: unknown }).visibilityState;
  localStorage.removeItem(LOCAL_STATE_OWNER_KEY);
  consoleError.mockRestore();
  consoleWarn.mockRestore();
});

describe('snapshotWritable', () => {
  const LOADED = {
    userId: A,
    isLoading: false,
    isPreview: false,
    error: null,
    loadFailedUserId: null,
    items: [] as unknown[],
  };
  const BASE = { userId: A, at: T0 };

  it('says yes to fresh data, for the owner, from a landing this tab saw', () => {
    expect(snapshotWritable(LOADED, A, BASE)).toBe(true);
    expect(snapshotWritable({ ...LOADED, items: new Array(SNAPSHOT_MAX_ITEMS).fill(0) }, A, BASE)).toBe(true);
  });

  it.each([
    ['no account', { ...LOADED, userId: null }, A, BASE],
    ['still loading (identifyUser, a lean route)', { ...LOADED, isLoading: true }, A, BASE],
    ['the preview', { ...LOADED, isLoading: true, isPreview: true }, A, BASE],
    ['a failed load', { ...LOADED, error: 'boom', loadFailedUserId: A }, A, BASE],
    ['a failed load, by its stamp alone', { ...LOADED, loadFailedUserId: A }, A, BASE],
    ['another owner', LOADED, B, BASE],
    ['no owner', LOADED, null, BASE],
    ['no landing seen', LOADED, A, null],
    ["another account's landing", LOADED, A, { userId: B, at: T0 }],
    ['too many items', { ...LOADED, items: new Array(SNAPSHOT_MAX_ITEMS + 1).fill(0) }, A, BASE],
  ] as const)('says no to %s', (_, s, owner, base) => {
    expect(snapshotWritable(s, owner, base)).toBe(false);
  });
});

describe('writing', () => {
  it('writes a landing that replaced no preview at the first idle, with the landing as its base', async () => {
    start();
    store().identifyUser(A);
    const loading = store().initializeStore(A);
    // The base is when the data ARRIVED, not when it was asked for.
    vi.setSystemTime(T0 + 700);
    await landFresh(loading);

    // No settle to keep smooth, so no 2s: only the idle (setTimeout 0 without rIC).
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledTimes(1);

    const s = store();
    expect(write).toHaveBeenCalledWith(A, expect.any(Object), T0 + 700, getSnapshotEpoch());
    expect(written()).toEqual({
      items: s.items,
      projects: s.projects,
      itemTypes: s.itemTypes,
      routines: s.routines,
      seasons: s.seasons,
      goals: s.goals,
      itemTypesAvailable: s.itemTypesAvailable,
      collectionsAvailable: s.collectionsAvailable,
      goalsAvailable: s.goalsAvailable,
    });
    expect(ids(written().items)).toEqual(FRESH_IDS);
  });

  it('takes a change made before the first idle along with the landing, rather than waiting 2s more', async () => {
    start();
    store().identifyUser(A);
    const loading = store().initializeStore(A);
    await landFresh(loading);

    // The answers that follow a landing (extensions, the AI gate, a goal
    // slice) arrive before the idle. They must not put the first save off.
    usePlannerStore.setState({ items: [...store().items, task('t-after', 'After')] });
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(ids(written().items)).toEqual(expect.arrayContaining([...FRESH_IDS, 't-after']));

    // After that write, changes are trailing again.
    write.mockClear();
    usePlannerStore.setState({ items: [...store().items, task('t-later', 'Later')] });
    vi.advanceTimersByTime(SNAPSHOT_WRITE_DEBOUNCE_MS - 1);
    expect(write).not.toHaveBeenCalled();
    settle();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('writes a landing that replaced a preview 2s after, at idle: the settle runs in those 2s', async () => {
    start();
    const { loading } = await previewA();
    await landFresh(loading);

    vi.advanceTimersByTime(SNAPSHOT_WRITE_DEBOUNCE_MS - 1);
    expect(write).not.toHaveBeenCalled();
    // The debounce is up; the write itself then waits for idle (setTimeout 0 without rIC).
    vi.advanceTimersByTime(2);
    expect(write).toHaveBeenCalledTimes(1);
    expect(ids(written().items)).toEqual(FRESH_IDS);
  });

  it('is trailing: a burst of edits is one write, 2s after the last', async () => {
    start();
    await land(A);
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledTimes(1); // the landing's
    write.mockClear();

    usePlannerStore.setState({ items: [...store().items, task('t-early', 'Early')] });
    vi.advanceTimersByTime(1500);
    usePlannerStore.setState({ items: [...store().items, task('t-typed', 'Typed')] });
    vi.advanceTimersByTime(1500);
    expect(write).not.toHaveBeenCalled();
    settle();
    expect(write).toHaveBeenCalledTimes(1);
    expect(ids(written().items)).toEqual(expect.arrayContaining(['t-early', 't-typed']));
  });

  it('keeps the base of the landing: a later edit is not a fresher fetch', async () => {
    start();
    await land(A);
    settle();
    vi.advanceTimersByTime(60_000);
    usePlannerStore.setState({ items: [] });
    settle();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][2]).toBe(T0);
  });

  it('a successful Retry stamps a new base', async () => {
    start();
    store().identifyUser(A);
    await failLoad(store().initializeStore(A));
    vi.setSystemTime(T0 + 60_000);
    await landFresh(store().initializeStore(A));
    settle();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe(A);
    expect(write.mock.calls[0][2]).toBe(T0 + 60_000);
  });

  it('carries the epoch as it stands at write time, so a clear after the call drops it', async () => {
    start();
    await land(A);
    clearPlannerSnapshot();
    const epoch = getSnapshotEpoch();
    settle();
    expect(write.mock.calls[0][3]).toBe(epoch);
  });

  it('waits for idle where the browser has requestIdleCallback, with a 2s ceiling', async () => {
    const callbacks: IdleRequestCallback[] = [];
    const ric = vi.fn((cb: IdleRequestCallback) => callbacks.push(cb));
    const cancelIdle = vi.fn();
    Object.assign(window, { requestIdleCallback: ric, cancelIdleCallback: cancelIdle });
    try {
      start();
      // The landing's write asks for idle at once.
      await land(A);
      expect(ric).toHaveBeenCalledWith(expect.any(Function), { timeout: 2000 });
      vi.advanceTimersByTime(10_000);
      expect(write).not.toHaveBeenCalled();

      // A change while it waits rides along: the wait is not started again.
      usePlannerStore.setState({ items: [] });
      expect(cancelIdle).not.toHaveBeenCalled();
      callbacks[0]({ didTimeout: false, timeRemaining: () => 50 });
      expect(write).toHaveBeenCalledTimes(1);
      expect(written().items).toEqual([]);

      // After it, an edit waits 2s and then for idle, and an edit while that
      // waits starts the 2s again.
      usePlannerStore.setState({ items: [task('t-one', 'One')] });
      vi.advanceTimersByTime(SNAPSHOT_WRITE_DEBOUNCE_MS);
      expect(ric).toHaveBeenCalledTimes(2);
      usePlannerStore.setState({ items: [] });
      expect(cancelIdle).toHaveBeenCalledWith(2);
      vi.advanceTimersByTime(SNAPSHOT_WRITE_DEBOUNCE_MS);
      expect(ric).toHaveBeenCalledTimes(3);

      callbacks[2]({ didTimeout: false, timeRemaining: () => 50 });
      expect(write).toHaveBeenCalledTimes(2);
      expect(written(1).items).toEqual([]);
    } finally {
      delete (window as { requestIdleCallback?: unknown }).requestIdleCallback;
      delete (window as { cancelIdleCallback?: unknown }).cancelIdleCallback;
    }
  });
});

/**
 * A write the database failed (no connection, a transaction error) is tried
 * again, a few times, each wait twice the last. One it refused is not: the same
 * copy would meet the same answer, and a refusal retried on a clock is a hot loop.
 */
describe('a write that did not land', () => {
  /** Lets the write's promise settle, so the writer hears how it ended. */
  const heard = () => flush();

  it(`tries a failed write again at most ${WRITE_RETRIES} times, each wait twice the last`, async () => {
    write.mockImplementation(async () => 'failed');
    start();
    await land(A);
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledTimes(1);

    for (let n = 1; n <= WRITE_RETRIES; n++) {
      await heard();
      const wait = SNAPSHOT_WRITE_DEBOUNCE_MS * 2 ** n;
      vi.advanceTimersByTime(wait - 1);
      expect(write).toHaveBeenCalledTimes(n);
      vi.advanceTimersByTime(2);
      expect(write).toHaveBeenCalledTimes(n + 1);
    }

    await heard();
    vi.advanceTimersByTime(10 * 60_000);
    expect(write).toHaveBeenCalledTimes(WRITE_RETRIES + 1);
    expect(vi.getTimerCount()).toBe(0);
    // Still unwritten, so the next chance takes it.
    pagehide();
    expect(write).toHaveBeenCalledTimes(WRITE_RETRIES + 2);
  });

  it('a new change after the retries ran out gets its own', async () => {
    write.mockImplementation(async () => 'failed');
    start();
    await land(A);
    vi.advanceTimersByTime(1);
    for (let n = 1; n <= WRITE_RETRIES; n++) {
      await heard();
      vi.advanceTimersByTime(SNAPSHOT_WRITE_DEBOUNCE_MS * 2 ** n + 1);
    }
    await heard();
    write.mockClear();

    usePlannerStore.setState({ items: [] });
    settle();
    expect(write).toHaveBeenCalledTimes(1);
    await heard();
    vi.advanceTimersByTime(SNAPSHOT_WRITE_DEBOUNCE_MS * 2 + 1);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('never tries a refused write again (a newer base on disk, a clear)', async () => {
    write.mockImplementation(async () => 'refused');
    start();
    await land(A);
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledTimes(1);
    await heard();
    vi.advanceTimersByTime(10 * 60_000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    // Nor is it left dirty for a flush to send the same copy again.
    pagehide();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('a retry is folded into a change that already has a write coming', async () => {
    const out = deferred<SnapshotWriteResult>();
    write.mockImplementationOnce(() => out.promise);
    start();
    await land(A);
    vi.advanceTimersByTime(1);
    usePlannerStore.setState({ items: [] });

    out.resolve('failed');
    await heard();
    settle();
    expect(write).toHaveBeenCalledTimes(2);
    expect(written(1).items).toEqual([]);
    vi.advanceTimersByTime(10 * 60_000);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('a write that fails after stop() plans nothing', async () => {
    const out = deferred<SnapshotWriteResult>();
    write.mockImplementationOnce(() => out.promise);
    start();
    await land(A);
    vi.advanceTimersByTime(1);
    stop();
    out.resolve('failed');
    await heard();
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * The skeleton's hold (lib/planner-snapshot.ts's expectPreview). offerPreview
 * ends it on every way the offer ends; the writer ends it on the store's own
 * edges, which also cover an offer whose read is still out when the load lands.
 */
describe('the skeleton hold', () => {
  const held = () => document.documentElement.hasAttribute(PREVIEW_EXPECTED_ATTR);

  beforeEach(() => document.documentElement.setAttribute(PREVIEW_EXPECTED_ATTR, ''));
  afterEach(() => document.documentElement.removeAttribute(PREVIEW_EXPECTED_ATTR));

  it('ends when the preview goes up', async () => {
    start();
    store().identifyUser(A);
    const snap = deferred<PlannerSnapshotData | null>();
    read.mockImplementationOnce(() => snap.promise);
    void store().initializeStore(A, { preview: () => true });
    expect(held()).toBe(true);
    // Read inside the preview's own set(), after the writer's listener and
    // before offerPreview's own clear, so only the writer's edge counts here.
    let heldAsItWentUp: boolean | null = null;
    const look = usePlannerStore.subscribe((s, prev) => {
      if (s.isPreview && !prev.isPreview) heldAsItWentUp = held();
    });
    try {
      snap.resolve(CACHED());
      await flush();
    } finally {
      look();
    }
    expect(store().isPreview).toBe(true);
    expect(heldAsItWentUp).toBe(false);
    expect(held()).toBe(false);
  });

  it.each([
    ['lands', landFresh],
    ['fails', failLoad],
  ])('ends when the load %s with the read still out', async (_, end) => {
    start();
    store().identifyUser(A);
    read.mockImplementationOnce(() => new Promise(() => {}));
    const loading = store().initializeStore(A, { preview: () => true });
    await flush();
    expect(held()).toBe(true);

    await end(loading);
    expect(held()).toBe(false);
  });
});

describe('what it never writes', () => {
  it('the identifyUser empty state — which is all a lean route ever has', () => {
    start();
    store().identifyUser(A);
    settle();
    pagehide();
    expect(write).not.toHaveBeenCalled();
  });

  it('a failed load', async () => {
    start();
    store().identifyUser(A);
    await failLoad(store().initializeStore(A));
    expect(store().error).toBe('Failed to load data');
    settle();
    pagehide();
    expect(write).not.toHaveBeenCalled();
  });

  it('the preview — the landing that replaces it is what gets written', async () => {
    start();
    const { loading } = await previewA();
    expect(store().isPreview).toBe(true);
    settle();
    pagehide();
    expect(write).not.toHaveBeenCalled();

    await landFresh(loading);
    settle();
    expect(write).toHaveBeenCalledTimes(1);
    expect(ids(written().items)).toEqual(FRESH_IDS);
  });

  it("the previous account after a switch: B's empty store, and A's pending write with it", async () => {
    start();
    await land(A);
    // adoptLocalState(B), then identifyUser(B) — the provider's order.
    setOwner(B);
    store().identifyUser(B);
    settle();
    pagehide();
    expect(write).not.toHaveBeenCalled();

    await landFresh(store().initializeStore(B));
    settle();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe(B);
  });

  it('for a browser another account now owns — and keeps the change for when it is theirs again', async () => {
    start();
    await land(A);
    setOwner(B); // another tab adopted B
    settle();
    pagehide();
    setOwner(null); // and signed out
    pagehide();
    expect(write).not.toHaveBeenCalled();

    // Refused stays dirty: the next chance takes it.
    setOwner(A);
    pagehide();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe(A);
  });
});

describe('the extension toggles', () => {
  it.each([
    ['not loaded yet', { hydratedUserId: A, configsLoaded: false }, false],
    ['loaded for another account', { hydratedUserId: B, configsLoaded: true }, false],
    ['loaded for this account', { hydratedUserId: A, configsLoaded: true }, true],
  ] as const)('ride along only once loaded for this user: %s', async (_, ext, carried) => {
    useExtensionsStore.setState({ ...ext, enabled: { goals: true } });
    start();
    await land(A);
    settle();
    expect(write).toHaveBeenCalledTimes(1);
    if (carried) {
      expect(written().extensionsEnabled).toEqual({ goals: true });
      // A copy: the record must not alias the live map.
      expect(written().extensionsEnabled).not.toBe(useExtensionsStore.getState().enabled);
    } else {
      expect(written()).not.toHaveProperty('extensionsEnabled');
    }
  });

  it('a toggle marks the snapshot dirty once they have loaded', async () => {
    useExtensionsStore.setState({ configsLoaded: true });
    start();
    await land(A);
    settle();
    expect(write).toHaveBeenCalledTimes(1);

    useExtensionsStore.setState({ enabled: { goals: true } });
    settle();
    expect(write).toHaveBeenCalledTimes(2);
    expect(written(1).extensionsEnabled).toEqual({ goals: true });
  });

  it('before then, `enabled` is only in-flight toggles and marks nothing', async () => {
    start();
    await land(A);
    settle();
    useExtensionsStore.setState({ enabled: { goals: true } });
    settle();
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('the crash marker', () => {
  it.each([
    ['the fresh landing', (loading: Promise<void>) => landFresh(loading)],
    ['a failed load', (loading: Promise<void>) => failLoad(loading)],
    ['dropPreview (the crash boundary)', async () => void store().dropPreview()],
    ['an account switch', async () => store().identifyUser(B)],
    ['sign-out', async () => store().clearStore()],
  ])('is removed when %s ends the preview', async (_, end) => {
    start();
    const { loading } = await previewA();
    expect(store().isPreview).toBe(true);
    expect(marker).toHaveBeenCalledWith(true); // offerPreview's, before the preview set()
    marker.mockClear();

    await end(loading);
    expect(store().isPreview).toBe(false);
    expect(marker).toHaveBeenCalledTimes(1);
    expect(marker).toHaveBeenCalledWith(false);
  });

  it('is left alone by a load that never previewed', async () => {
    start();
    await land(A);
    expect(marker).not.toHaveBeenCalled();
  });
});

/**
 * Leaving the page mid-preview. The marker exists for a preview that hung or
 * crashed the page; a reload, a navigation or a tab put away while the load is
 * still out is neither, and must not cost the next page its preview. Whether
 * the preview got onto the screen cleanly is lib/planner-snapshot.ts's answer
 * (its own suite); here it is a spy, and every assertion is the writer's use of it.
 */
describe('the crash marker on the way out', () => {
  it.each([
    ['pagehide (a reload, a navigation, pull-to-refresh)', pagehide],
    ['the tab going hidden (the last event a discarded tab gets)', hide],
  ])('is removed on %s while a cleanly rendered preview is up', async (_, leave) => {
    start();
    await previewA();
    cleanly.mockImplementation(() => true);
    marker.mockClear();

    leave();
    expect(marker).toHaveBeenCalledTimes(1);
    expect(marker).toHaveBeenCalledWith(false);
    expect(store().isPreview).toBe(true); // leaving ends nothing: the load is still out
  });

  it('is kept when the preview did not render cleanly (a throw unmounted it, or it never committed)', async () => {
    start();
    await previewA();
    marker.mockClear();

    pagehide();
    hide();
    expect(cleanly).toHaveBeenCalled();
    expect(marker).not.toHaveBeenCalled();
  });

  it('is not touched on the way out when no preview is up', async () => {
    start();
    await land(A);
    cleanly.mockImplementation(() => true);

    pagehide();
    hide();
    expect(marker).not.toHaveBeenCalled();
  });

  it.each([
    ['shown again', show],
    ['restored from the back/forward cache', pageshow],
  ])('is armed again when the page is %s with the preview still up', async (_, back) => {
    start();
    await previewA();
    cleanly.mockImplementation(() => true);
    hide();
    marker.mockClear();

    back();
    expect(marker).toHaveBeenCalledTimes(1);
    expect(marker).toHaveBeenCalledWith(true);
  });

  it('is not armed again by a return after the preview ended', async () => {
    start();
    const { loading } = await previewA();
    hide();
    await landFresh(loading);
    marker.mockClear();

    show();
    pageshow();
    expect(marker).not.toHaveBeenCalled();
  });

  it('a marker that cannot be written escapes neither the way out nor the way back', async () => {
    start();
    await previewA();
    cleanly.mockImplementation(() => true);
    marker.mockClear();
    marker.mockImplementation(() => {
      throw new Error('sessionStorage went away');
    });
    // A listener's throw never reaches dispatchEvent's caller; it is reported as an error event.
    const reported = vi.fn();
    window.addEventListener('error', reported);
    try {
      pagehide();
      show();
      pageshow();
    } finally {
      window.removeEventListener('error', reported);
    }
    expect(marker).toHaveBeenCalledTimes(3);
    expect(reported).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('[preview]'), expect.any(Error));
  });

  it('stop() lets go of the way back too', async () => {
    start();
    await previewA();
    cleanly.mockImplementation(() => true);
    stop();
    marker.mockClear();

    pagehide();
    show();
    pageshow();
    expect(marker).not.toHaveBeenCalled();
  });
});

describe('flushing', () => {
  it('writes at once when the tab is hidden, and the pending write goes with it', async () => {
    start();
    await land(A);
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(write).not.toHaveBeenCalled();

    const timers = vi.getTimerCount();
    hide();
    expect(write).toHaveBeenCalledTimes(1);
    // The debounce it overtook is cancelled, not left to wake for nothing.
    expect(vi.getTimerCount()).toBe(timers - 1);
    vi.advanceTimersByTime(10_000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('writes at once on pagehide', async () => {
    start();
    await land(A);
    pagehide();
    expect(write).toHaveBeenCalledTimes(1);
    expect(ids(written().items)).toEqual(FRESH_IDS);
  });

  it('a flush with nothing new writes nothing', async () => {
    start();
    await land(A);
    settle();
    pagehide();
    hide();
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('starting and stopping', () => {
  it('`off` deletes the database and starts nothing', async () => {
    hoisted.mode.value = 'off';
    start();
    expect(purge).toHaveBeenCalledTimes(1);
    await land(A);
    settle();
    pagehide();
    expect(write).not.toHaveBeenCalled();
  });

  it('without IndexedDB it starts nothing, and has nothing to purge', async () => {
    supported.mockImplementation(() => false);
    start();
    await land(A);
    settle();
    pagehide();
    expect(write).not.toHaveBeenCalled();
    expect(purge).not.toHaveBeenCalled();
  });

  it('stop() lets go of both stores, both listeners and the pending write', async () => {
    start();
    await land(A);
    stop();
    settle();
    pagehide();
    hide();
    expect(write).not.toHaveBeenCalled();

    useExtensionsStore.setState({ configsLoaded: true, enabled: { goals: true } });
    store().clearStore();
    const { loading } = await previewA();
    marker.mockClear();
    await landFresh(loading);
    settle();
    expect(marker).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});

describe('it can never throw', () => {
  it('a throwing write escapes neither the timer nor a flush', async () => {
    write.mockImplementation(() => {
      throw new Error('DataCloneError');
    });
    start();
    await land(A);
    expect(() => settle()).not.toThrow();
    usePlannerStore.setState({ items: [] });
    const reported = vi.fn();
    window.addEventListener('error', reported);
    try {
      pagehide();
    } finally {
      window.removeEventListener('error', reported);
    }
    expect(reported).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('a throw inside the subscriber never reaches the landing set() — the load still succeeds', async () => {
    // Inside initializeStore's set(), an escaping throw would land in its
    // catch and record a GOOD load as failed.
    marker.mockImplementation((on) => {
      if (!on) throw new Error('sessionStorage went away');
    });
    start();
    const { loading } = await previewA();
    await landFresh(loading);
    const s = store();
    expect(s.error).toBeNull();
    expect(s.loadFailedUserId).toBeNull();
    expect(s.isLoading).toBe(false);
    expect(s.isPreview).toBe(false);
    expect(ids(s.items)).toEqual(FRESH_IDS);
  });
});
