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
import { hydrateCustomTypes } from '@/lib/item-registry';
import type { Item, Project } from '@/lib/planner-types';

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
  for (let i = 0; i < 10; i++) await Promise.resolve();
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
  // Implementations too, not only calls: a test's fake must not leak into the next.
  for (const write of [
    db.createItem,
    db.createItems,
    db.updateItem,
    db.deleteItem,
    db.changeItemType,
    db.setItemCompletion,
  ]) {
    vi.mocked(write).mockReset();
    vi.mocked(write).mockImplementation(async () => undefined);
  }
  vi.mocked(db.fetchItemsAnyState).mockClear();
  dbHolds([]);
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
    // Kept, as rows, until a landing confirms them: the writes may have failed with the load.
    expect(held()).toEqual(store().items.map((i) => ({ userId: A, title: i.title, item: i, filed: i })));
  });

  it('adds at once over a failed load, and keeps it until a landing confirms it', async () => {
    await failLoad(startLoad(A));

    expect(captureTask('After the failure')).toBe('added');
    // Synchronously, as on main: the row is there and written at once.
    expect(titles()).toEqual(['After the failure']);
    expect(written()).toEqual(['After the failure']);
    expect(held()).toEqual([{ userId: A, title: 'After the failure', item: store().items[0], filed: store().items[0] }]);
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
const writesFail = () =>
  vi.mocked(db.createItem).mockImplementation(async () => {
    throw { message: 'network' };
  });
const writesWork = () => vi.mocked(db.createItem).mockImplementation(async () => undefined);
/** The titles each multi-row insert carried, one list per statement. */
const writtenTogether = () =>
  vi.mocked(db.createItems).mock.calls.map((call) => (call as unknown as [string, Item[]])[1].map((i) => i.title));
/** The ids written to the database, in the order written. */
const writtenIds = () =>
  vi.mocked(db.createItem).mock.calls.map((call) => (call as unknown as [string, { id: string }])[1].id);
/** A Retry for A that lands with `items` (and `projects`). */
const retryLanding = async (items: Item[], projects: Project[] = []) => {
  const retry = store().initializeStore(A);
  pendingLoads.shift()!.resolve({ ...FRESH(), items, projects });
  await retry;
  await flush();
};
/** What the database says it holds under the ids it is asked about. */
const dbHolds = (rows: { item: Item; deleted: boolean }[]) =>
  vi.mocked(db.fetchItemsAnyState).mockImplementation(async () => rows);

describe('a row filed over a failed load, until a landing settles it', () => {
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
    // Nothing to ask about.
    expect(db.fetchItemsAnyState).not.toHaveBeenCalled();
  });

  it('waits out a Retry that fails too, then files on the one that lands', async () => {
    writesFail();
    await failLoad(startLoad(A));
    captureTask('Still down');

    const retry = store().initializeStore(A);
    expect(captureTask('During the retry')).toBe('held');
    await failLoad(retry);
    expect(titles()).toEqual(['Still down', 'During the retry']);
    expect(held().map((e) => [e.title, !!e.item])).toEqual([
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
    // Marked, not dropped: a restore would put it back in line.
    expect(held().map((e) => [e.title, !!e.gone])).toEqual([
      ['Never mind', true],
      ['Keep this', false],
    ]);

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

  // The undo strip and ⌘Z both run undo(). Its restore is an UPDATE of
  // deleted_at, which finds nothing when the insert never committed.
  it('files again a row deleted and then put back by undo over the failed load', async () => {
    writesFail();
    await failLoad(startLoad(A));
    captureTask('Keep me');
    const id = store().items[0].id;
    store().deleteTask(id);
    expect(held()).toMatchObject([{ title: 'Keep me', gone: true }]);

    store().undo();
    expect(titles()).toEqual(['Keep me']);
    expect(held()).toMatchObject([{ title: 'Keep me', gone: false }]);

    writesWork();
    await retryLanding([task('t-fresh', 'Already there')]);
    // Before: ['Already there'], the row erased for good.
    expect(titles()).toEqual(['Already there', 'Keep me']);
    expect(store().items[1].id).toBe(id);
    expect(writtenIds()).toEqual([id, id]);
    expect(held()).toEqual([]);
  });

  it('files again a capture whose add was undone and then redone over the failed load', async () => {
    writesFail();
    await failLoad(startLoad(A));
    captureTask('Redo me');
    const id = store().items[0].id;
    store().undo();
    expect(titles()).toEqual([]);
    expect(held()).toMatchObject([{ gone: true }]);
    store().redo();
    expect(held()).toMatchObject([{ title: 'Redo me', gone: false }]);

    writesWork();
    await retryLanding([task('t-fresh', 'Already there')]);
    // Before: ['Already there'].
    expect(titles()).toEqual(['Already there', 'Redo me']);
    expect(store().items[1].id).toBe(id);
  });

  it('files again the whole row as the person left it, not just its title', async () => {
    writesFail();
    await failLoad(startLoad(A));
    captureTask('Call mom');
    const id = store().items[0].id;
    store().updateTask(id, {
      notes: 'ask about the flight on the 14th',
      startDate: '2026-10-08',
      timeBucket: 'morning',
      priority: 'high',
      project: 'Family',
    });

    writesWork();
    await retryLanding([task('t-fresh', 'Already there')], [{ id: 'p-family', name: 'Family' } as Project]);
    const kept = {
      id,
      title: 'Call mom',
      notes: 'ask about the flight on the 14th',
      startDate: '2026-10-08',
      timeBucket: 'morning',
      priority: 'high',
      project: 'Family',
    };
    // Before: notes and startDate undefined, the row filed again from its title.
    // Its order and project id are stamped again against the landed store.
    expect(store().items.find((i) => i.id === id)).toMatchObject({ ...kept, order: 1, projectId: 'p-family' });
    // And written so: the second insert carries the whole row.
    expect(vi.mocked(db.createItem).mock.calls.at(-1)![1]).toMatchObject(kept);
    expect(store().actionLog.map((e) => e.label)).toEqual(['Add task: Call mom', 'Session start']);
  });

  it('files rows again in the order the person left them', async () => {
    writesFail();
    await failLoad(startLoad(A));
    captureTask('Milk');
    captureTask('Eggs');
    const [milk, eggs] = store().items.map((i) => i.id);
    store().reorderTasks([eggs, milk]);

    writesWork();
    await retryLanding([task('t-fresh', 'Already there')]);
    // Before: Milk back above Eggs, each filed again in the order it was captured.
    const byOrder = [...store().tasks].sort((a, b) => a.order - b.order).map((t) => `${t.title}:${t.order}`);
    expect(byOrder).toEqual(['Already there:0', 'Eggs:1', 'Milk:2']);
  });

  it('sends a subtask filed again only once its parent\'s insert has settled', async () => {
    writesFail();
    await failLoad(startLoad(A));
    captureTask('Plan trip');
    const parentId = store().items[0].id;
    store().addTasksBulk('task', [
      { title: 'Book hotel', parentItemId: parentId },
      { title: 'Book train', parentItemId: parentId },
    ]);
    // The paste's own insert waited on the parent's (failed) one.
    await flush();

    // items_parent_item_id_fkey: a subtask that reaches the table before its
    // parent commits fails with 23503.
    const parentInsert = deferred<void>();
    vi.mocked(db.createItem).mockImplementation((_userId, item) =>
      item.id === parentId ? parentInsert.promise : Promise.resolve()
    );
    vi.mocked(db.createItem).mockClear();
    vi.mocked(db.createItems).mockClear();
    await retryLanding([task('t-fresh', 'Already there')]);
    expect(titles()).toEqual(['Already there', 'Plan trip', 'Book hotel', 'Book train']);
    // Before: all three left in the same tick.
    expect(written()).toEqual(['Plan trip']);
    expect(db.createItems).not.toHaveBeenCalled();

    parentInsert.resolve();
    await flush();
    // The pasted list goes back as the one insert it was.
    expect(writtenTogether()).toEqual([['Book hotel', 'Book train']]);
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

/**
 * A landing that did not bring a filed row back asks the database about it
 * first: the row may have been saved and deleted elsewhere since, or saved
 * after the landing's read began.
 */
describe('before filing a row again, the database is asked', () => {
  afterEach(() => writesWork());

  it('leaves in the bin a row deleted on another device, and does not file it again', async () => {
    // The insert committed; only the read failed.
    await failLoad(startLoad(A));
    captureTask('Captured during a read outage');
    const id = store().items[0].id;
    // Deleted on the phone since: the Retry's read leaves it out, the bin keeps it.
    dbHolds([{ item: task(id, 'Captured during a read outage'), deleted: true }]);

    await retryLanding([task('t-fresh', 'Already there')]);
    expect(db.fetchItemsAnyState).toHaveBeenCalledWith(A, [id]);
    // Before: shown again under the same id, its second insert failing on the
    // primary key while the store kept a row the database had trashed.
    expect(titles()).toEqual(['Already there']);
    expect(writtenIds()).toEqual([id]);
    expect(held()).toEqual([]);
  });

  it('shows a live row the landing missed without inserting it again', async () => {
    await failLoad(startLoad(A));
    captureTask('Slow insert');
    const id = store().items[0].id;
    // Its insert committed after the Retry's read began.
    dbHolds([{ item: task(id, 'Slow insert'), deleted: false }]);
    vi.mocked(db.updateItem).mockClear();

    await retryLanding([task('t-fresh', 'Already there')]);
    expect(titles()).toEqual(['Already there', 'Slow insert']);
    expect(store().items[1]).toMatchObject({ id, order: 1 });
    expect(writtenIds()).toEqual([id]);
    // Only its order moved, to after the landed rows. A date list it never had
    // reads back empty, and that is not a difference.
    expect(vi.mocked(db.updateItem).mock.calls).toStrictEqual([[id, 'task', { order: 1 }]]);
    expect(store().actionLog.map((e) => e.label)).toEqual(['Add task: Slow insert', 'Session start']);
    expect(held()).toEqual([]);
  });

  it('writes over a live row the landing missed what the person changed since its insert', async () => {
    // The insert is slow: the UPDATE for the notes leaves while it is in
    // flight and finds nothing, and it commits after the Retry's read began.
    const insert = deferred<void>();
    vi.mocked(db.createItem).mockImplementation(() => insert.promise);
    await failLoad(startLoad(A));
    captureTask('Slow insert');
    const id = store().items[0].id;
    store().updateTask(id, { notes: 'typed over the failed load' });
    dbHolds([{ item: task(id, 'Slow insert'), deleted: false }]);
    vi.mocked(db.updateItem).mockClear();

    const retry = retryLanding([task('t-fresh', 'Already there')]);
    insert.resolve();
    await retry;
    // Before: the database's copy was shown, the notes gone from the store and the table.
    expect(store().items[1]).toMatchObject({ id, notes: 'typed over the failed load' });
    expect(writtenIds()).toEqual([id]);
    expect(vi.mocked(db.updateItem).mock.calls).toStrictEqual([
      [id, 'task', { notes: 'typed over the failed load', order: 1 }],
    ]);
  });

  it('keeps the container id the insert resolved for a live row, when the landing cannot resolve its name', async () => {
    await failLoad(startLoad(A));
    captureTask('Call mom');
    const id = store().items[0].id;
    store().updateTask(id, { project: 'Family' });
    expect(store().items[0].projectId).toBeUndefined();
    // The insert resolved the name; the landing's read began before the project existed.
    dbHolds([{ item: { ...task(id, 'Call mom'), project: 'Family', projectId: 'p-family' }, deleted: false }]);
    vi.mocked(db.updateItem).mockClear();

    await retryLanding([task('t-fresh', 'Already there')]);
    expect(store().items[1]).toMatchObject({ id, project: 'Family', projectId: 'p-family' });
    // Never an UPDATE that unlinks it.
    expect(vi.mocked(db.updateItem).mock.calls).toStrictEqual([[id, 'task', { order: 1 }]]);
  });

  it('switches the type of a live row the landing missed when the person switched it', async () => {
    const insert = deferred<void>();
    vi.mocked(db.createItem).mockImplementation(() => insert.promise);
    await failLoad(startLoad(A));
    captureTask('Stretch');
    const id = store().items[0].id;
    store().changeItemType(id, 'habit');
    expect(store().items[0].type).toBe('habit');
    await flush();
    dbHolds([{ item: task(id, 'Stretch'), deleted: false }]);
    vi.mocked(db.changeItemType).mockClear();
    vi.mocked(db.updateItem).mockClear();

    const retry = retryLanding([task('t-fresh', 'Already there')]);
    insert.resolve();
    await retry;
    expect(store().items[1]).toMatchObject({ id, type: 'habit' });
    expect(vi.mocked(db.changeItemType).mock.calls).toEqual([[id, 'task', store().items[1], A]]);
    expect(db.updateItem).not.toHaveBeenCalled();
  });

  it('files every row again when the question goes unanswered, and ignores a late answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      writesFail();
      await failLoad(startLoad(A));
      captureTask('Waiting on a read');
      const id = store().items[0].id;
      let answer!: (rows: { item: Item; deleted: boolean }[]) => void;
      vi.mocked(db.fetchItemsAnyState).mockImplementation(
        () => new Promise((resolve) => (answer = resolve))
      );

      writesWork();
      await retryLanding([task('t-fresh', 'Already there')]);
      expect(titles()).toEqual(['Already there']);
      expect(held()).toMatchObject([{ title: 'Waiting on a read', asking: true }]);

      // Before: off the planner, and in memory only, for as long as the read hung.
      await vi.advanceTimersByTimeAsync(4000);
      expect(titles()).toEqual(['Already there', 'Waiting on a read']);
      expect(writtenIds()).toEqual([id, id]);
      expect(held()).toEqual([]);

      answer([{ item: task(id, 'Waiting on a read'), deleted: true }]);
      await flush();
      expect(titles()).toEqual(['Already there', 'Waiting on a read']);
      expect(writtenIds()).toEqual([id, id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('files every row again when the question fails, under its own id', async () => {
    writesFail();
    await failLoad(startLoad(A));
    captureTask('Unasked');
    const id = store().items[0].id;
    vi.mocked(db.fetchItemsAnyState).mockImplementation(async () => {
      throw { message: 'network' };
    });

    writesWork();
    await retryLanding([task('t-fresh', 'Already there')]);
    expect(titles()).toEqual(['Already there', 'Unasked']);
    expect(writtenIds()).toEqual([id, id]);
    expect(held()).toEqual([]);
  });

  it('still counts the row while it asks, and never files it into the next account', async () => {
    writesFail();
    await failLoad(startLoad(A));
    captureTask('Only for A');
    let answer!: (rows: { item: Item; deleted: boolean }[]) => void;
    vi.mocked(db.fetchItemsAnyState).mockImplementation(
      () => new Promise((resolve) => (answer = resolve))
    );
    writesWork();
    await retryLanding([task('t-fresh', 'Already there')]);
    expect(held()).toMatchObject([{ userId: A, title: 'Only for A', asking: true }]);
    const { result } = renderHook(() => useHeldCount());
    expect(result.current).toBe(1);

    vi.mocked(db.createItem).mockClear();
    act(() => store().identifyUser(B));
    expect(held()).toEqual([]);
    const loadingB = store().initializeStore(B);
    answer([]);
    await flush();
    await landFresh(loadingB);
    expect(store().userId).toBe(B);
    expect(titles()).toEqual(['Already there']);
    expect(db.createItem).not.toHaveBeenCalled();
  });
});

/**
 * A list pasted (or typed into "Add many items…") over a failed load is the
 * same typed text as a capture, so addTasksBulk's rows are kept the same way
 * (lib/filed-rows.ts reports them).
 */
describe('a list filed over a failed load', () => {
  afterEach(() => writesWork());

  it('is kept as rows, and filed again as the one undo entry it was', async () => {
    writesFail();
    await failLoad(startLoad(A));
    // The paste's one insert fails with the outage.
    vi.mocked(db.createItems).mockImplementationOnce(async () => {
      throw { message: 'network' };
    });
    store().addTasksBulk('task', [{ title: 'Milk' }, { title: 'Eggs', notes: 'a dozen' }]);
    const ids = store().items.map((i) => i.id);
    expect(held().map((e) => [e.title, e.item?.id])).toEqual([
      ['Milk', ids[0]],
      ['Eggs', ids[1]],
    ]);
    expect(held()[0].batch).toBeDefined();
    expect(held()[1].batch).toBe(held()[0].batch);

    writesWork();
    await retryLanding([task('t-fresh', 'Already there')]);
    // Before: ['Already there'], the list lost with its failed insert.
    expect(titles()).toEqual(['Already there', 'Milk', 'Eggs']);
    expect(store().items.slice(1).map((i) => i.id)).toEqual(ids);
    expect(store().items[2]).toMatchObject({ notes: 'a dozen' });
    // As the one insert the paste was, under the same ids.
    expect(vi.mocked(db.createItems).mock.calls.map((c) => c[1].map((i) => i.id))).toEqual([ids, ids]);
    expect(db.createItem).not.toHaveBeenCalled();
    expect(store().actionLog.map((e) => e.label)).toEqual(['Bulk add: 2 items', 'Session start']);
    expect(held()).toEqual([]);
    expect(withoutReleasedCaptures(A, store().items).map((i) => i.title)).toEqual(['Already there']);
  });

  it('files again only the lines left after a removal', async () => {
    writesFail();
    await failLoad(startLoad(A));
    store().addTasksBulk('task', [{ title: 'Milk' }, { title: 'Eggs' }, { title: 'Bread' }]);
    store().deleteTask(store().items[0].id);

    writesWork();
    await retryLanding([task('t-fresh', 'Already there')]);
    expect(titles()).toEqual(['Already there', 'Eggs', 'Bread']);
    expect(store().actionLog.map((e) => e.label)).toEqual(['Bulk add: 2 items', 'Session start']);
  });

  it('keeps a one-line list as a capture', async () => {
    writesFail();
    await failLoad(startLoad(A));
    store().addTasksBulk('task', [{ title: 'Just one' }]);
    expect(held()).toMatchObject([{ userId: A, title: 'Just one', batch: undefined }]);

    writesWork();
    await retryLanding([task('t-fresh', 'Already there')]);
    expect(titles()).toEqual(['Already there', 'Just one']);
    expect(store().actionLog.map((e) => e.label)).toEqual(['Add task: Just one', 'Session start']);
  });

  it('keeps nothing for a list filed on a landed planner', async () => {
    await landFresh(startLoad(A));
    store().addTasksBulk('task', [{ title: 'Milk' }, { title: 'Eggs' }]);
    expect(held()).toEqual([]);
  });

  it('never files it into another account', async () => {
    writesFail();
    await failLoad(startLoad(A));
    store().addTasksBulk('task', [{ title: 'Milk' }, { title: 'Eggs' }]);

    store().identifyUser(B);
    expect(held()).toEqual([]);
    writesWork();
    await landFresh(store().initializeStore(B));
    expect(titles()).toEqual(['Already there']);
    expect(db.createItem).not.toHaveBeenCalled();
  });
});

/**
 * A Retry leaves the failed load's rows on the store until it lands (no
 * preview is offered on a retry), and neither the item panel nor the bulk-add
 * dialog waits on it. So what the person does to those rows in that window
 * counts, and a list filed in it is kept like one filed over the failure.
 */
describe('while a Retry is in flight', () => {
  afterEach(() => writesWork());

  it('files again the edit made during the Retry', async () => {
    writesFail();
    await failLoad(startLoad(A));
    captureTask('Call mom');
    const id = store().items[0].id;

    const retry = store().initializeStore(A);
    store().updateTask(id, { notes: 'ask about the flight on the 14th' });
    writesWork();
    await landFresh(retry);
    // Before: the row as it was when the Retry began, the notes gone.
    expect(store().items.find((i) => i.id === id)).toMatchObject({ notes: 'ask about the flight on the 14th' });
    expect(vi.mocked(db.createItem).mock.calls.at(-1)![1]).toMatchObject({
      id,
      notes: 'ask about the flight on the 14th',
    });
  });

  it('does not file again a row deleted during the Retry', async () => {
    writesFail();
    await failLoad(startLoad(A));
    captureTask('Never mind');
    captureTask('Keep me');

    const retry = store().initializeStore(A);
    store().deleteTask(store().items[0].id);
    writesWork();
    await landFresh(retry);
    // Before: ['Already there', 'Never mind', 'Keep me'], the delete undone.
    expect(titles()).toEqual(['Already there', 'Keep me']);
  });

  it('keeps a list filed during the Retry, and files it again when the Retry lands without it', async () => {
    writesFail();
    await failLoad(startLoad(A));

    const retry = store().initializeStore(A);
    store().addTasksBulk('task', [{ title: 'Milk' }, { title: 'Eggs' }]);
    const ids = store().items.map((i) => i.id);
    expect(held().map((e) => e.title)).toEqual(['Milk', 'Eggs']);
    writesWork();
    await landFresh(retry);
    // Before: ['Already there'], the list erased by the landing.
    expect(titles()).toEqual(['Already there', 'Milk', 'Eggs']);
    expect(store().items.slice(1).map((i) => i.id)).toEqual(ids);
    expect(store().actionLog.map((e) => e.label)).toEqual(['Bulk add: 2 items', 'Session start']);
    expect(held()).toEqual([]);
  });

  it('keeps a list filed during a Retry that fails too, for the landing after it', async () => {
    writesFail();
    await failLoad(startLoad(A));

    const retry = store().initializeStore(A);
    store().addTasksBulk('task', [{ title: 'Milk' }, { title: 'Eggs' }]);
    expect(captureTask('Captured in the same window')).toBe('held');
    await failLoad(retry);
    expect(titles()).toEqual(['Milk', 'Eggs', 'Captured in the same window']);
    // Before: only the capture was kept, the list on screen and tracked nowhere.
    expect(held().map((e) => e.title)).toEqual(['Milk', 'Eggs', 'Captured in the same window']);

    writesWork();
    await retryLanding([task('t-fresh', 'Already there')]);
    expect(titles()).toEqual(['Already there', 'Milk', 'Eggs', 'Captured in the same window']);
    expect(held()).toEqual([]);
  });

  it('keeps a list filed while the first load is in flight, too', async () => {
    const loading = startLoad(A);
    store().addTasksBulk('task', [{ title: 'Milk' }, { title: 'Eggs' }]);
    expect(held().map((e) => e.title)).toEqual(['Milk', 'Eggs']);
    // Their insert committed after the load's read began.
    dbHolds(store().items.map((item) => ({ item, deleted: false })));

    await landFresh(loading);
    // Before: ['Already there'] until a reload.
    expect(titles()).toEqual(['Already there', 'Milk', 'Eggs']);
    expect(db.createItem).not.toHaveBeenCalled();
    expect(withoutReleasedCaptures(A, store().items).map((i) => i.title)).toEqual(['Already there']);
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

  it('does not count a row removed over the failed load, and counts it again once restored', async () => {
    await failLoad(startLoad(A));
    const { result } = renderHook(() => useHeldCount());
    act(() => {
      captureTask('Over the failure');
    });
    expect(result.current).toBe(1);

    act(() => store().undo());
    expect(titles()).toEqual([]);
    expect(result.current).toBe(0);
    act(() => store().redo());
    expect(result.current).toBe(1);
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

/**
 * Against a table that answers as Postgres does on the points that matter:
 * an INSERT under an id it holds fails 23505 and a multi-row INSERT is
 * all-or-nothing, an UPDATE or a per-date write matching no row (id and type)
 * changes nothing, changeItemType leaves the date lists alone and throws on no
 * match, and a soft delete takes the row's subtasks with it.
 */
type TableRow = { item: Item; deleted: boolean };
const table = new Map<string, TableRow>();
const slugOf = (i: Item) => (i.type === 'custom' ? i.customType : i.type);
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const network = async () => {
  throw { message: 'network' };
};

function useTable() {
  table.clear();
  vi.mocked(db.createItem).mockImplementation(async (_userId, item) => {
    if (table.has(item.id)) throw { code: '23505', message: 'duplicate key value violates unique constraint "items_pkey"' };
    table.set(item.id, { item: copy(item), deleted: false });
  });
  vi.mocked(db.createItems).mockImplementation(async (_userId, items) => {
    if (items.some((item) => table.has(item.id))) throw { code: '23505', message: 'duplicate key value' };
    for (const item of items) table.set(item.id, { item: copy(item), deleted: false });
  });
  vi.mocked(db.updateItem).mockImplementation(async (id, type, patch) => {
    const row = table.get(id);
    if (!row || slugOf(row.item) !== type) return;
    const next = { ...row.item, ...copy(patch) } as Record<string, unknown>;
    // updateItem sets a date list as per-date intents: an absent list is empty.
    for (const key of ['completedDates', 'skippedDates']) if (key in patch) next[key] = next[key] ?? [];
    row.item = next as Item;
  });
  vi.mocked(db.changeItemType).mockImplementation(async (id, fromType, target) => {
    const row = table.get(id);
    if (!row || slugOf(row.item) !== fromType) throw new Error(`changeItemType: no ${fromType} row ${id}`);
    const kept = row.item as { completedDates?: string[]; skippedDates?: string[] };
    row.item = { ...copy(target), completedDates: kept.completedDates, skippedDates: kept.skippedDates } as Item;
  });
  vi.mocked(db.setItemCompletion).mockImplementation(async (id, type, date, done) => {
    const row = table.get(id);
    if (!row || slugOf(row.item) !== type) return;
    const dates = new Set((row.item as { completedDates?: string[] }).completedDates ?? []);
    if (done) dates.add(date);
    else dates.delete(date);
    row.item = { ...row.item, completedDates: [...dates] } as Item;
  });
  vi.mocked(db.deleteItem).mockImplementation(async (id, type) => {
    const row = table.get(id);
    if (!row || slugOf(row.item) !== type) return;
    row.deleted = true;
    for (const child of table.values()) {
      if ((child.item as { parentItemId?: string }).parentItemId === id) child.deleted = true;
    }
  });
  vi.mocked(db.fetchItemsAnyState).mockImplementation(async (_userId, ids) =>
    ids.flatMap((id) => {
      const row = table.get(id);
      // itemFromRow reads both date lists back as [] when empty.
      return row ? [{ item: { completedDates: [], skippedDates: [], ...copy(row.item) } as Item, deleted: row.deleted }] : [];
    })
  );
}

/** Holds the next insert until released: a slow network. */
function parkNextInsert() {
  const gate = deferred<void>();
  const insert = vi.mocked(db.createItem).getMockImplementation()!;
  vi.mocked(db.createItem).mockImplementationOnce(async (userId, item) => {
    await gate.promise;
    return insert(userId, item);
  });
  return gate;
}

const saved = (id: string) => table.get(id)!.item as Item & Record<string, unknown>;
const row = (id: string) => store().items.find((i) => i.id === id) as (Item & Record<string, unknown>) | undefined;

describe('settling a filed row against what the database holds', () => {
  it('replays the dates of a live row the landing missed, after switching its type', async () => {
    useTable();
    await failLoad(startLoad(A));
    const insert = parkNextInsert();
    captureTask('Stretch');
    const id = store().items[0].id;
    // Both sent while the insert is out, so both find nothing.
    store().changeItemType(id, 'habit');
    store().toggleHabitStatus(id, 'done');
    await flush();
    const today = (row(id) as { completedDates: string[] }).completedDates[0];
    expect(today).toBeDefined();
    insert.resolve();
    await flush();
    expect(saved(id)).toMatchObject({ type: 'task' });

    // The Retry's read began before that insert committed.
    await retryLanding([task('t-fresh', 'Already there')]);
    await flush();
    expect(row(id)).toMatchObject({ type: 'habit', completedDates: [today], streak: 1 });
    // Before: a habit with streak 1 and no completion, so a reload showed today unticked.
    expect(saved(id)).toMatchObject({ type: 'habit', completedDates: [today], streak: 1 });
  });

  it('asks only once this tab\'s own first insert has settled, and writes the edit its UPDATE missed', async () => {
    useTable();
    await failLoad(startLoad(A));
    const insert = parkNextInsert();
    captureTask('Slow insert');
    const id = store().items[0].id;
    store().updateTask(id, { notes: 'typed over the failed load' });
    await flush();

    // The Retry's read began before the insert committed.
    await retryLanding([task('t-fresh', 'Already there')]);
    // Before: asked at once, told "no row", and inserted again while the first was out.
    expect(db.fetchItemsAnyState).not.toHaveBeenCalled();
    expect(db.createItem).toHaveBeenCalledTimes(1);

    insert.resolve();
    await flush();
    expect(db.createItem).toHaveBeenCalledTimes(1);
    expect(row(id)).toMatchObject({ notes: 'typed over the failed load', order: 1 });
    expect(saved(id)).toMatchObject({ notes: 'typed over the failed load', order: 1 });
  });

  it('writes the edit over a row the database had after all, when the question fails', async () => {
    useTable();
    await failLoad(startLoad(A));
    captureTask('Call mom');
    await flush();
    const id = store().items[0].id;
    vi.mocked(db.updateItem).mockImplementationOnce(network);
    store().updateTask(id, { notes: 'flight on the 14th' });
    await flush();

    vi.mocked(db.fetchItemsAnyState).mockImplementationOnce(network);
    // The Retry's read missed the row, and the question fails.
    await retryLanding([task('t-fresh', 'Already there')]);
    await flush();
    expect(row(id)).toMatchObject({ notes: 'flight on the 14th' });
    // Before: the second insert failed on the primary key, was only logged, and the notes never reached the table.
    expect(saved(id)).toMatchObject({ notes: 'flight on the 14th' });
    expect(table.size).toBe(1);
  });

  it('takes off the planner a row filed again that the database had in the bin, when the question failed', async () => {
    useTable();
    await failLoad(startLoad(A));
    captureTask('Deleted on the phone');
    await flush();
    const id = store().items[0].id;
    table.get(id)!.deleted = true;

    vi.mocked(db.fetchItemsAnyState).mockImplementationOnce(network);
    await retryLanding([task('t-fresh', 'Already there')]);
    await flush();
    expect(titles()).toEqual(['Already there']);
    expect(table.get(id)!.deleted).toBe(true);
    // Gone from the history too: an undo never puts it back.
    store().undo();
    await flush();
    expect(titles()).toEqual(['Already there']);
  });

  it('keeps an edit whose UPDATE failed on a row the landing brought back', async () => {
    useTable();
    await failLoad(startLoad(A));
    captureTask('Call mom');
    await flush();
    const id = store().items[0].id;
    vi.mocked(db.updateItem).mockImplementationOnce(network);
    store().updateTask(id, { notes: 'ask about the flight on the 14th' });
    await flush();

    await retryLanding([task('t-fresh', 'Already there'), copy(saved(id))]);
    await flush();
    // Before: the landing's copy, without the notes, on the planner and in the table.
    expect(row(id)).toMatchObject({ notes: 'ask about the flight on the 14th' });
    expect(saved(id)).toMatchObject({ notes: 'ask about the flight on the 14th' });
    expect(held()).toEqual([]);
    expect(db.fetchItemsAnyState).not.toHaveBeenCalled();
    // What the person had before the landing: no entry of its own to undo.
    expect(store().actionLog.map((e) => e.label)).toEqual(['Session start']);
  });

  it('leaves alone an edit made on another device to a field the person never touched', async () => {
    useTable();
    await failLoad(startLoad(A));
    captureTask('Call mom');
    await flush();
    const id = store().items[0].id;
    vi.mocked(db.updateItem).mockImplementationOnce(network);
    store().updateTask(id, { title: 'Call mom back' });
    await flush();
    // On the phone, meanwhile.
    table.get(id)!.item = { ...saved(id), notes: 'from the phone' };
    vi.mocked(db.updateItem).mockClear();

    await retryLanding([task('t-fresh', 'Already there'), copy(saved(id))]);
    await flush();
    expect(row(id)).toMatchObject({ title: 'Call mom back', notes: 'from the phone' });
    expect(saved(id)).toMatchObject({ title: 'Call mom back', notes: 'from the phone' });
    expect(vi.mocked(db.updateItem).mock.calls).toStrictEqual([[id, 'task', { title: 'Call mom back' }]]);
  });

  it('removes again a row the person deleted over the failed load, when the landing brings it back', async () => {
    useTable();
    await failLoad(startLoad(A));
    captureTask('Never mind');
    await flush();
    const id = store().items[0].id;
    vi.mocked(db.deleteItem).mockImplementationOnce(network);
    store().deleteTask(id);
    await flush();
    expect(held()).toMatchObject([{ gone: true }]);

    await retryLanding([task('t-fresh', 'Already there'), copy(saved(id))]);
    await flush();
    // Before: back on the planner and live in the table, its entry dropped.
    expect(titles()).toEqual(['Already there']);
    expect(table.get(id)!.deleted).toBe(true);
    expect(held()).toEqual([]);
    expect(store().canUndo).toBe(false);
  });

  it('does not file again the subtasks of a parent in the bin', async () => {
    useTable();
    await failLoad(startLoad(A));
    captureTask('Plan trip');
    await flush();
    const parentId = store().items[0].id;
    // The paste's one insert fails with the outage.
    vi.mocked(db.createItems).mockImplementationOnce(network);
    store().addTasksBulk('task', [
      { title: 'Book hotel', parentItemId: parentId },
      { title: 'Book train', parentItemId: parentId },
    ]);
    await flush();
    // Deleted on the phone since. Its delete found no subtasks: they never committed.
    table.get(parentId)!.deleted = true;

    await retryLanding([task('t-fresh', 'Already there')]);
    await flush();
    expect(store().items.map((i) => i.title)).toEqual(['Already there']);
    // Before: both inserted live, under a parent in the bin, out of every view.
    expect([...table.keys()]).toEqual([parentId]);
  });

  it('files again the subtasks of a live parent the landing missed', async () => {
    useTable();
    await failLoad(startLoad(A));
    captureTask('Plan trip');
    await flush();
    const parentId = store().items[0].id;
    vi.mocked(db.createItems).mockImplementationOnce(network);
    store().addTasksBulk('task', [
      { title: 'Book hotel', parentItemId: parentId },
      { title: 'Book train', parentItemId: parentId },
    ]);
    await flush();

    await retryLanding([task('t-fresh', 'Already there')]);
    await flush();
    expect(titles()).toEqual(['Already there', 'Plan trip', 'Book hotel', 'Book train']);
    expect([...table.values()].map((r) => [r.item.title, r.deleted])).toEqual([
      ['Plan trip', false],
      ['Book hotel', false],
      ['Book train', false],
    ]);
  });

  it('folds the rows in with no entry when the person acted while it asked, so the next undo is theirs', async () => {
    useTable();
    await failLoad(startLoad(A));
    store().addTasksBulk('task', [{ title: 'Milk' }, { title: 'Eggs' }]);
    await flush();
    const ids = store().items.map((i) => i.id);
    const answer = deferred<{ item: Item; deleted: boolean }[]>();
    vi.mocked(db.fetchItemsAnyState).mockImplementationOnce(() => answer.promise);

    // The Retry's read began before the list's insert committed.
    await retryLanding([task('t-fresh', 'Already there')]);
    store().deleteTask('t-fresh');
    answer.resolve(ids.map((id) => ({ item: copy(saved(id)), deleted: false })));
    await flush();
    expect(titles()).toEqual(['Milk', 'Eggs']);
    // Before: "Bulk add: 2 items" on top, and the ⌘Z meant for the delete
    // soft-deleted the two rows instead.
    expect(store().actionLog.map((e) => e.label)).toEqual(['Delete task: Already there', 'Session start']);
    store().undo();
    await flush();
    expect(titles()).toEqual(['Already there', 'Milk', 'Eggs']);
    expect(ids.map((id) => table.get(id)!.deleted)).toEqual([false, false]);
  });

  it('files a list missed by a cold load again as one insert, not one per row', async () => {
    useTable();
    const loading = startLoad(A);
    vi.mocked(db.createItems).mockImplementationOnce(network);
    store().addTasksBulk('task', Array.from({ length: 5 }, (_, i) => ({ title: `Line ${i}` })));
    const ids = store().items.map((i) => i.id);

    await landFresh(loading);
    await flush();
    expect(titles()).toEqual(['Already there', 'Line 0', 'Line 1', 'Line 2', 'Line 3', 'Line 4']);
    // Before: five single-row inserts in one tick.
    expect(db.createItem).not.toHaveBeenCalled();
    expect(vi.mocked(db.createItems).mock.calls.map((c) => c[1].map((i) => i.id))).toEqual([ids, ids]);
    expect(ids.map((id) => saved(id).order)).toEqual([1, 2, 3, 4, 5]);
  });

  it('files a custom-type list again one row at a time, in the order pasted', async () => {
    useTable();
    const itemTypes = [{ id: 'ty1', name: 'grocery', label: 'Grocery', userId: A }];
    const loading = startLoad(A);
    usePlannerStore.setState({ itemTypes: itemTypes as never });
    hydrateCustomTypes(itemTypes as never);
    let inFlight = 0;
    let most = 0;
    const insert = vi.mocked(db.createItem).getMockImplementation()!;
    let failing = true;
    vi.mocked(db.createItem).mockImplementation(async (userId, item) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await flush();
      inFlight--;
      if (failing) throw { message: 'network' };
      return insert(userId, item);
    });
    store().addTasksBulk('grocery', [{ title: 'Apples' }, { title: 'Bread' }, { title: 'Cheese' }]);
    for (let i = 0; i < 10; i++) await flush();
    expect(written()).toEqual(['Apples', 'Bread', 'Cheese']);
    failing = false;

    pendingLoads.shift()!.resolve({ ...FRESH(), itemTypes });
    await loading;
    for (let i = 0; i < 10; i++) await flush();
    expect(titles()).toEqual(['Already there', 'Apples', 'Bread', 'Cheese']);
    expect(written()).toEqual(['Apples', 'Bread', 'Cheese', 'Apples', 'Bread', 'Cheese']);
    // Before: the three re-file inserts left together, so created_at (which
    // sorts a custom type) could come back in any order.
    expect(most).toBe(1);
    expect([...table.values()].map((r) => r.item.title)).toEqual(['Apples', 'Bread', 'Cheese']);
  });
});
