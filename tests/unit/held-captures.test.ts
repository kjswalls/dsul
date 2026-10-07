import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';

/**
 * Quick captures typed before the planner has loaded (lib/held-captures.ts).
 *
 * A capture made while the planner's load is in flight (a cold load or the
 * look-only preview) is HELD and added once the load finishes — for the
 * account it was typed under, in the order typed, exactly once, each as its
 * own undo entry. This is an intended fix as well as a guard: before it, a
 * capture typed during a cold load was added optimistically and then erased
 * from view by the landing set().
 *
 * A FAILED load has finished too, so nothing is held past it: what waited is
 * filed the moment it fails, and a capture typed after it is added at once, as
 * a plain add always was. Held through a failure, the text lived only in this
 * module, and a reload or a closed tab lost it. But the write is only
 * attempted (an outage fails it too), so each row filed over a failed load is
 * kept, with its id, until a landing confirms it or files it again.
 *
 * The real store, with the load held open by hand: every case is about what
 * happens on either side of the landing.
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
import { readPlannerSnapshot, type PlannerSnapshotData } from '@/lib/planner-snapshot';
import { getHistoryInfo, usePlannerStore } from '@/lib/planner-store';
import {
  captureTask,
  useHeldCaptures,
  useHeldCount,
  withoutReleasedCaptures,
  __resetHeldCapturesForTests,
} from '@/lib/held-captures';
import type { Item } from '@/lib/planner-types';

const A = 'user-a';
const B = 'user-b';

const task = (id: string, title: string): Item => ({
  type: 'task',
  id,
  title,
  status: 'pending',
  isScheduled: false,
  order: 0,
  completedDates: [],
});

const FRESH = () => ({
  items: [task('t-fresh', 'Already there')],
  projects: [],
  itemTypes: [],
  routines: [],
  seasons: [],
  goals: [],
});

const CACHED = (): PlannerSnapshotData => ({
  items: [task('t-cached', 'From last session')],
  projects: [],
  itemTypes: [],
  routines: [],
  seasons: [],
  goals: [],
  itemTypesAvailable: true,
  collectionsAvailable: true,
  goalsAvailable: true,
});

const store = () => usePlannerStore.getState();
const titles = () => store().items.map((i) => i.title);
const held = () => useHeldCaptures.getState().held;

/** Let resolved promises (and queued microtasks) run their continuations. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** Stamp the account and start its first load; the load stays open. */
function startLoad(userId: string, opts?: { preview?: () => boolean }) {
  store().identifyUser(userId);
  return store().initializeStore(userId, opts);
}

const landFresh = async (loading: Promise<void>) => {
  pendingLoads.shift()!.resolve(FRESH());
  await loading;
  await flush();
};

const failLoad = async (loading: Promise<void>) => {
  pendingLoads.shift()!.reject({ message: 'boom' });
  await loading;
  await flush();
};

let consoleError: ReturnType<typeof vi.spyOn>;
let consoleWarn: ReturnType<typeof vi.spyOn>;

/** The titles written to the database, in the order written. */
const written = () =>
  vi.mocked(db.createItem).mock.calls.map((call) => (call as unknown as [string, { title: string }])[1].title);

beforeEach(() => {
  store().clearStore();
  __resetHeldCapturesForTests();
  pendingLoads.length = 0;
  vi.mocked(db.createItem).mockClear();
  vi.mocked(readPlannerSnapshot).mockImplementation(async () => null);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  cleanup();
  // Never leave a load open for the next test.
  while (pendingLoads.length) pendingLoads.shift()!.resolve(FRESH());
  await flush();
  consoleError.mockRestore();
  consoleWarn.mockRestore();
});

describe('captureTask', () => {
  it('adds at once when the planner has loaded', async () => {
    await landFresh(startLoad(A));

    expect(captureTask('Now')).toBe('added');
    // Synchronously: no queue in between when there is nothing to wait for.
    expect(titles()).toEqual(['Already there', 'Now']);
    expect(held()).toEqual([]);
  });

  it('drops a capture with no account to hold it for', () => {
    expect(captureTask('Nobody')).toBe('dropped');
    expect(held()).toEqual([]);
    expect(titles()).toEqual([]);
  });

  it('holds while loading, then adds exactly once, in order, in a microtask after the landing, each an undo entry', async () => {
    const loading = startLoad(A);

    expect(captureTask('One')).toBe('held');
    expect(captureTask('Two')).toBe('held');
    expect(titles()).toEqual([]);

    // Inside the landing set() the captures are NOT added yet: the history
    // suppressor is still held there, so an add inside it would be no entry.
    let atLanding: string[] | null = null;
    const unsub = usePlannerStore.subscribe((s, prev) => {
      if (prev.isLoading && !s.isLoading) atLanding = s.items.map((i) => i.title);
    });
    await landFresh(loading);
    unsub();

    expect(atLanding).toEqual(['Already there']);
    expect(titles()).toEqual(['Already there', 'One', 'Two']);
    expect(held()).toEqual([]);

    // One entry per capture, on top of the fresh baseline.
    expect(getHistoryInfo().totalEntries).toBe(3);
    expect(store().canUndo).toBe(true);
    expect(store().actionLog.map((e) => e.label)).toEqual([
      'Add task: Two',
      'Add task: One',
      'Session start',
    ]);

    // Idempotent: later changes release nothing again.
    store().setSelectedDate(new Date('2026-10-04T12:00:00Z'));
    await flush();
    expect(titles()).toEqual(['Already there', 'One', 'Two']);
  });

  it('holds through the look-only preview, where the add itself would be refused', async () => {
    vi.mocked(readPlannerSnapshot).mockImplementation(async () => CACHED());
    const loading = startLoad(A, { preview: () => true });
    await flush();
    expect(store().isPreview).toBe(true);

    expect(captureTask('Typed over the cache')).toBe('held');
    // Not refused (that would warn), and not on top of the cached rows.
    expect(consoleWarn).not.toHaveBeenCalledWith(expect.stringContaining('addTask refused'));
    expect(titles()).toEqual(['From last session']);

    await landFresh(loading);
    expect(titles()).toEqual(['Already there', 'Typed over the cache']);
  });

  it('files what was waiting the moment the load fails, in order, and writes it', async () => {
    const loading = startLoad(A);
    expect(captureTask('One')).toBe('held');
    expect(captureTask('Two')).toBe('held');

    await failLoad(loading);
    // The load has finished, so nothing is left in memory only: the rows are
    // added over the failed (empty) store and written, as a plain add was.
    expect(store().loadFailedUserId).toBe(A);
    expect(titles()).toEqual(['One', 'Two']);
    expect(written()).toEqual(['One', 'Two']);
    expect(store().actionLog.map((e) => e.label).slice(0, 2)).toEqual(['Add task: Two', 'Add task: One']);
    // Kept, by id, until a landing confirms them: the writes may have failed with the load.
    expect(held()).toEqual(store().items.map((i) => ({ userId: A, title: i.title, id: i.id })));
  });

  it('adds at once over a failed load, and keeps it until a landing confirms it', async () => {
    await failLoad(startLoad(A));

    expect(captureTask('After the failure')).toBe('added');
    // Synchronously, as on main: the row is there and written at once.
    expect(titles()).toEqual(['After the failure']);
    expect(written()).toEqual(['After the failure']);
    expect(held()).toEqual([{ userId: A, title: 'After the failure', id: store().items[0].id }]);
  });

  it('still holds while a Retry is in flight, and files on its landing', async () => {
    await failLoad(startLoad(A));
    const retry = store().initializeStore(A);
    expect(store().isLoading).toBe(true);

    expect(captureTask('During the retry')).toBe('held');
    await landFresh(retry);
    expect(titles()).toEqual(['Already there', 'During the retry']);
    expect(held()).toEqual([]);
  });

  it('drops the capture when the account changes, and never files it into the next one', async () => {
    const loadingA = startLoad(A);
    captureTask('Only for A');

    store().identifyUser(B);
    expect(held()).toEqual([]);

    // A's slow load resolving now is ignored; B's own load lands clean.
    pendingLoads.shift()!.resolve(FRESH());
    await loadingA;
    await landFresh(store().initializeStore(B));
    expect(store().userId).toBe(B);
    expect(titles()).toEqual(['Already there']);
  });

  it('drops the capture on sign-out', async () => {
    const loading = startLoad(A);
    captureTask('Before sign-out');

    store().clearStore();
    expect(store().userId).toBeNull();
    expect(held()).toEqual([]);

    pendingLoads.shift()!.resolve(FRESH());
    await loading;
    await landFresh(startLoad(A));
    expect(titles()).toEqual(['Already there']);
  });

  it('outlives the component it was typed into', async () => {
    const loading = startLoad(A);
    function Field() {
      return createElement('button', { onClick: () => captureTask('From a closed launcher') }, 'add');
    }
    const { unmount } = render(createElement(Field));
    fireEvent.click(screen.getByRole('button', { name: 'add' }));
    unmount();

    await landFresh(loading);
    expect(titles()).toEqual(['Already there', 'From a closed launcher']);
  });
});

/**
 * An outage fails the writes as well as the read, and persistNewItem only logs
 * a failed insert. The Retry's landing replaces the failed load's store, so a
 * row filed over the failure survives only if this module files it again.
 */
describe('a row filed over a failed load, until a landing settles it', () => {
  const writesFail = () =>
    vi.mocked(db.createItem).mockImplementation(async () => {
      throw { message: 'network' };
    });
  const writesWork = () => vi.mocked(db.createItem).mockImplementation(async () => undefined);
  /** The ids written to the database, in the order written. */
  const writtenIds = () =>
    vi.mocked(db.createItem).mock.calls.map((call) => (call as unknown as [string, { id: string }])[1].id);
  const retryLanding = async (items: Item[]) => {
    const retry = store().initializeStore(A);
    pendingLoads.shift()!.resolve({ ...FRESH(), items });
    await retry;
    await flush();
  };

  afterEach(() => writesWork());

  it('files a held capture again, under the same id, when the Retry lands without it', async () => {
    const loading = startLoad(A);
    expect(captureTask('Typed during an outage')).toBe('held');
    writesFail();
    await failLoad(loading);
    const id = store().items.find((i) => i.title === 'Typed during an outage')!.id;

    writesWork();
    await retryLanding([task('t-fresh', 'Already there')]);

    expect(titles()).toEqual(['Already there', 'Typed during an outage']);
    expect(store().items[1].id).toBe(id);
    // Written twice under ONE id: had the first insert committed after the
    // Retry read, the second fails on the primary key instead of duplicating.
    expect(writtenIds()).toEqual([id, id]);
    expect(held()).toEqual([]);
    expect(withoutReleasedCaptures(A, store().items).map((i) => i.title)).toEqual(['Already there']);
    // Its own undo entry, on top of the fresh baseline.
    expect(store().actionLog.map((e) => e.label)).toEqual(['Add task: Typed during an outage', 'Session start']);
  });

  it('files a capture typed after the failure again when the Retry lands without it', async () => {
    writesFail();
    await failLoad(startLoad(A));
    expect(captureTask('Typed after the failure')).toBe('added');

    writesWork();
    await retryLanding([task('t-fresh', 'Already there')]);

    expect(titles()).toEqual(['Already there', 'Typed after the failure']);
    expect(held()).toEqual([]);
  });

  it('files nothing again when the Retry brings the row back', async () => {
    await failLoad(startLoad(A));
    captureTask('Saved after all');
    const id = store().items[0].id;

    await retryLanding([task('t-fresh', 'Already there'), task(id, 'Saved after all')]);

    expect(titles()).toEqual(['Already there', 'Saved after all']);
    expect(writtenIds()).toEqual([id]);
    expect(held()).toEqual([]);
  });

  it('waits out a Retry that fails too, then files on the one that lands', async () => {
    writesFail();
    await failLoad(startLoad(A));
    captureTask('Still down');

    const retry = store().initializeStore(A);
    expect(captureTask('During the retry')).toBe('held');
    await failLoad(retry);
    expect(titles()).toEqual(['Still down', 'During the retry']);
    expect(held().map((e) => [e.title, !!e.id])).toEqual([
      ['Still down', true],
      ['During the retry', true],
    ]);

    writesWork();
    await retryLanding([task('t-fresh', 'Already there')]);
    expect(titles()).toEqual(['Already there', 'Still down', 'During the retry']);
    expect(held()).toEqual([]);
  });

  it('does not file again a row the person removed over the failed load', async () => {
    writesFail();
    await failLoad(startLoad(A));
    captureTask('Never mind');
    captureTask('Keep this');
    store().deleteTask(store().items[0].id);
    expect(held().map((e) => e.title)).toEqual(['Keep this']);

    writesWork();
    await retryLanding([task('t-fresh', 'Already there')]);
    expect(titles()).toEqual(['Already there', 'Keep this']);
  });

  it('files a renamed row again under its new title', async () => {
    writesFail();
    await failLoad(startLoad(A));
    captureTask('Cal dentist');
    store().updateTask(store().items[0].id, { title: 'Call dentist' });

    writesWork();
    await retryLanding([task('t-fresh', 'Already there')]);
    expect(titles()).toEqual(['Already there', 'Call dentist']);
  });

  it('never files it into another account', async () => {
    writesFail();
    await failLoad(startLoad(A));
    captureTask('Only for A');

    store().identifyUser(B);
    expect(held()).toEqual([]);
    writesWork();
    await landFresh(store().initializeStore(B));
    expect(titles()).toEqual(['Already there']);
  });
});

describe('withoutReleasedCaptures — what the first-run seed decides on', () => {
  it('leaves out what the release filed, for that account only', async () => {
    const loading = startLoad(A);
    captureTask('Typed while loading');
    await landFresh(loading);
    captureTask('Typed once loaded');
    expect(titles()).toEqual(['Already there', 'Typed while loading', 'Typed once loaded']);

    // The landed row and a capture made on loaded data are the account's;
    // the held one is not evidence of anything the account had.
    expect(withoutReleasedCaptures(A, store().items).map((i) => i.title)).toEqual([
      'Already there',
      'Typed once loaded',
    ]);
    expect(withoutReleasedCaptures(B, store().items)).toBe(store().items);
    expect(withoutReleasedCaptures(null, store().items)).toBe(store().items);
  });

  it('leaves out a capture filed over a failed load too, when the Retry lands it', async () => {
    await failLoad(startLoad(A));
    captureTask('Over the failure');
    const id = store().items.find((i) => i.title === 'Over the failure')!.id;

    // The write committed before the Retry's read, so the row comes back with
    // the account's data. It is still the user's text, not the account's history.
    const retry = store().initializeStore(A);
    pendingLoads.shift()!.resolve({ ...FRESH(), items: [task('t-fresh', 'Already there'), task(id, 'Over the failure')] });
    await retry;
    await flush();

    expect(titles()).toEqual(['Already there', 'Over the failure']);
    expect(withoutReleasedCaptures(A, store().items).map((i) => i.title)).toEqual(['Already there']);
  });

  it('is the list itself when nothing was held', async () => {
    await landFresh(startLoad(A));
    captureTask('Now');
    expect(withoutReleasedCaptures(A, store().items)).toBe(store().items);
  });
});

describe('useHeldCount', () => {
  it('counts what waits for the current account, back to 0 once it lands', async () => {
    const loading = startLoad(A);
    const { result } = renderHook(() => useHeldCount());
    expect(result.current).toBe(0);

    act(() => {
      captureTask('One');
      captureTask('Two');
    });
    expect(result.current).toBe(2);

    await act(async () => {
      await landFresh(loading);
    });
    expect(result.current).toBe(0);
  });

  it('counts a row filed over a failed load until a landing settles it', async () => {
    await failLoad(startLoad(A));
    const { result } = renderHook(() => useHeldCount());

    act(() => {
      captureTask('Over the failure');
    });
    expect(titles()).toEqual(['Over the failure']);
    expect(result.current).toBe(1);

    const retry = store().initializeStore(A);
    await act(async () => {
      await landFresh(retry);
    });
    expect(titles()).toEqual(['Already there', 'Over the failure']);
    expect(result.current).toBe(0);
  });
});
