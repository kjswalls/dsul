import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  GOAL_FIELDS,
  HABIT_FIELDS,
  ItemTypeDefSchema,
  PROJECT_FIELDS,
  ROUTINE_FIELDS,
  SEASON_FIELDS,
  TASK_FIELDS,
} from '@dsul/types';

import type { PlannerSnapshotData, PlannerSnapshotRecord } from '@/lib/planner-snapshot';
import type { Item, Project } from '@/lib/planner-types';

/**
 * lib/planner-snapshot.ts against a real (fake) IndexedDB.
 *
 * fake-indexeddb is imported HERE, per file, and nowhere global: every other
 * suite keeps running the no-IndexedDB path jsdom gives it, which is the path
 * planner-snapshot-no-idb.test.ts pins.
 *
 * Each case gets a fresh database universe AND a fresh module, because the
 * module's epoch, memoized connection and prefetch are page-lifetime state.
 */

type Snap = typeof import('@/lib/planner-snapshot');
let snap: Snap;

const U = 'user-a';
const V = 'user-b';

async function freshModule(): Promise<Snap> {
  vi.resetModules();
  return import('@/lib/planner-snapshot');
}

beforeEach(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  sessionStorage.clear();
  snap = await freshModule();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const item = (id: string, title = id) =>
  ({ id, type: 'task', title, status: 'pending', completedDates: [], skippedDates: [] }) as unknown as Item;

function data(overrides: Partial<PlannerSnapshotData> = {}): PlannerSnapshotData {
  return {
    items: [item('i1', 'Write')],
    projects: [{ id: 'p1', name: 'Health' } as Project],
    itemTypes: [],
    routines: [],
    seasons: [],
    goals: [],
    itemTypesAvailable: true,
    collectionsAvailable: true,
    goalsAvailable: false,
    ...overrides,
  };
}

const write = (userId: string, d: PlannerSnapshotData, baseAt = Date.now()) =>
  snap.writePlannerSnapshot(userId, d, baseAt, snap.getSnapshotEpoch());

/* ── a second connection, so assertions read the disk rather than the module ── */

function rawOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(snap.SNAPSHOT_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(snap.SNAPSHOT_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function raw<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await rawOpen();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(snap.SNAPSHOT_STORE, mode);
      const req = op(tx.objectStore(snap.SNAPSHOT_STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const rawKeys = async () => (await raw('readonly', (s) => s.getAllKeys())).map(String).sort();
const rawRecord = (userId: string) =>
  raw('readonly', (s) => s.get(userId)) as Promise<PlannerSnapshotRecord | undefined>;
const rawPut = (value: unknown, key: string) => raw('readwrite', (s) => s.put(value, key));

/* ── round trip and ownership ─────────────────────────────────────────────── */

describe('a snapshot', () => {
  it('round-trips for its user', async () => {
    const d = data({ extensionsEnabled: { goals: true } });
    expect(await write(U, d)).toBe(true);
    expect(await snap.readPlannerSnapshot(U)).toEqual(d);
  });

  it('is stamped with the build, the user and both clocks', async () => {
    const baseAt = Date.now() - 1000;
    await write(U, data(), baseAt);
    const rec = await rawRecord(U);
    expect(rec).toMatchObject({ v: snap.SNAPSHOT_VERSION, userId: U, baseAt });
    expect(rec!.savedAt).toBeGreaterThanOrEqual(baseAt);
  });

  it('keeps one account on disk: a write clears every other key', async () => {
    await write(U, data());
    await write(V, data({ items: [item('v1')] }));
    expect(await rawKeys()).toEqual([V, `${V}#base`]);
    expect(await snap.readPlannerSnapshot(U)).toBeNull();
  });

  it('aborts an uncloneable write and leaves the previous copy', async () => {
    await write(U, data());
    const poisoned = data({ items: [{ ...item('i9'), oops: () => {} } as unknown as Item] });
    expect(await write(U, poisoned)).toBe(false);
    expect((await snap.readPlannerSnapshot(U))?.items.map((i) => i.id)).toEqual(['i1']);
  });
});

describe('a record that may not be painted is discarded AND deleted', () => {
  async function expectDiscarded() {
    expect(await snap.readPlannerSnapshot(U)).toBeNull();
    await vi.waitFor(async () => expect(await rawKeys()).toEqual([]));
  }

  it('on a version mismatch', async () => {
    await write(U, data());
    await rawPut({ ...(await rawRecord(U)), v: '0:deadbeef' }, U);
    await expectDiscarded();
  });

  it('on an origin mismatch (dev pointed at the other Supabase stack)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
    snap = await freshModule();
    await write(U, data());

    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://elsewhere.supabase.co');
    snap = await freshModule();
    await expectDiscarded();
  });

  it('on a userId mismatch inside the record', async () => {
    await write(U, data());
    await rawPut({ ...(await rawRecord(U)), userId: V }, U);
    await expectDiscarded();
  });

  it('past the TTL, measured from baseAt rather than savedAt', async () => {
    // savedAt is NOW: a days-old tab that just flushed is still days old.
    await write(U, data(), Date.now() - snap.SNAPSHOT_TTL_MS - 1);
    await expectDiscarded();
  });

  it('with a base stamped well in the future (a skewed clock)', async () => {
    await write(U, data(), Date.now() + 6 * 60_000);
    await expectDiscarded();
  });

  it.each([
    ['an item with no id', { items: [{ title: 'no id' } as unknown as Item] }],
    ['an item with a numeric id', { items: [{ id: 7 } as unknown as Item] }],
    ['a null project', { projects: [null as unknown as Project] }],
    ['a list that is not an array', { goals: {} as unknown as PlannerSnapshotData['goals'] }],
    ['a flag that is not a boolean', { goalsAvailable: 'yes' as unknown as boolean }],
  ])('on a malformed shape: %s', async (_label, overrides) => {
    await write(U, data(overrides as Partial<PlannerSnapshotData>));
    await expectDiscarded();
  });

  it('but a record inside the TTL and the skew allowance is kept', async () => {
    await write(U, data(), Date.now() - snap.SNAPSHOT_TTL_MS + 60_000);
    expect(await snap.readPlannerSnapshot(U)).not.toBeNull();
    await write(U, data(), Date.now() + 4 * 60_000);
    expect(await snap.readPlannerSnapshot(U)).not.toBeNull();
  });
});

describe('a malformed extensionsEnabled', () => {
  it.each([
    ['a non-boolean value', { goals: 'yes' }],
    ['an array', [true]],
    ['null', null],
  ])('is stripped, not rejected: %s', async (_label, bad) => {
    const d = data({ extensionsEnabled: bad as unknown as Record<string, boolean> });
    await write(U, d);
    const read = await snap.readPlannerSnapshot(U);
    expect(read).not.toBeNull();
    expect(read).not.toHaveProperty('extensionsEnabled');
    expect(read!.items.map((i) => i.id)).toEqual(['i1']);
  });

  it('a sparse boolean map survives', async () => {
    await write(U, data({ extensionsEnabled: { goals: true, streaks: false } }));
    expect((await snap.readPlannerSnapshot(U))?.extensionsEnabled).toEqual({ goals: true, streaks: false });
  });
});

/* ── the epoch ───────────────────────────────────────────────────────────── */

describe('a clear', () => {
  it('turns a read already in flight into null', async () => {
    await write(U, data());
    const inFlight = snap.readPlannerSnapshot(U);
    snap.clearPlannerSnapshot();
    expect(await inFlight).toBeNull();
  });

  it('empties the store, and a read queued after it sees nothing', async () => {
    await write(U, data());
    snap.clearPlannerSnapshot();
    expect(await snap.readPlannerSnapshot(U)).toBeNull();
    expect(await rawKeys()).toEqual([]);
  });

  it('bumps the epoch synchronously, every time', () => {
    const before = snap.getSnapshotEpoch();
    snap.clearPlannerSnapshot();
    snap.clearPlannerSnapshot();
    expect(snap.getSnapshotEpoch()).toBe(before + 2);
  });

  it('creates no database in a browser that never had one (/login, signed out)', async () => {
    // The provider purges at mount with no owner and on the no-session branch:
    // a visitor who never signs in must not be left an empty database.
    snap.clearPlannerSnapshot();
    snap.warmPlannerSnapshot(null);
    await new Promise((r) => setTimeout(r, 10));
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain(snap.SNAPSHOT_DB);
  });

  it('with nothing open in this page, still empties what another page left, before a later read', async () => {
    await write(U, data());
    // A new page (or a tab that never opened it): this module has no connection.
    const other = await freshModule();
    other.clearPlannerSnapshot();
    expect(await other.readPlannerSnapshot(U)).toBeNull();
    expect(await rawKeys()).toEqual([]);
  });

  it('with a connection that comes up, clears the store and deletes nothing', async () => {
    await write(U, data());
    const del = vi.spyOn(indexedDB, 'deleteDatabase');
    snap.clearPlannerSnapshot();
    await vi.waitFor(async () => expect(await rawKeys()).toEqual([]));
    expect(del).not.toHaveBeenCalled();
  });
});

/**
 * A clear asked for while this page's first open is still out: the warm-up
 * opened for the on-disk owner A, then the session came back as B and the
 * adoption cleared. Whatever becomes of that open, A's planner must not stay
 * on disk under B's stamp.
 */
describe('a clear asked for while the first open is still pending', () => {
  /** A's record, written by an earlier page; this test's `snap` is the next page. */
  async function previousPageWroteA() {
    const earlier = await freshModule();
    expect(await earlier.writePlannerSnapshot(U, data(), Date.now(), earlier.getSnapshotEpoch())).toBe(true);
    snap = await freshModule();
    expect(await rawKeys()).toEqual([U, `${U}#base`]);
  }

  /** The next open this page asks for gets `request` instead of a real one. */
  const stubNextOpen = (request: () => IDBOpenDBRequest) =>
    vi.spyOn(indexedDB, 'open').mockImplementationOnce(request);

  it('deletes the database when that open fails', async () => {
    await previousPageWroteA();
    stubNextOpen(() => {
      const req = {} as IDBOpenDBRequest;
      setTimeout(() => req.onerror?.(new Event('error')), 5);
      return req;
    });
    const del = vi.spyOn(indexedDB, 'deleteDatabase');

    snap.warmPlannerSnapshot(U);
    snap.clearPlannerSnapshot();
    await vi.waitFor(() => expect(del).toHaveBeenCalledWith(snap.SNAPSHOT_DB));
    expect(await rawKeys()).toEqual([]);
    expect(await snap.readPlannerSnapshot(V)).toBeNull();
  });

  it('deletes the database when that open times out', async () => {
    await previousPageWroteA();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stubNextOpen(() => ({}) as IDBOpenDBRequest); // a stalled open: never a single event
    const del = vi.spyOn(indexedDB, 'deleteDatabase');

    snap.warmPlannerSnapshot(U);
    snap.clearPlannerSnapshot();
    await vi.advanceTimersByTimeAsync(2999);
    expect(del).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await vi.waitFor(() => expect(del).toHaveBeenCalledWith(snap.SNAPSHOT_DB));
    expect(await rawKeys()).toEqual([]);
  });

  it('deletes the database when the connection is gone by the time the clear runs', async () => {
    await previousPageWroteA();
    // The open succeeds, then refuses the clear's transaction (the warm-up's
    // readonly get goes first and is left alone): a connection closed under it.
    const real = IDBDatabase.prototype.transaction;
    let refused = false;
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
      this: IDBDatabase,
      ...args: Parameters<IDBDatabase['transaction']>
    ) {
      if (args[1] === 'readwrite' && !refused) {
        refused = true;
        throw new DOMException('The database connection is closing.', 'InvalidStateError');
      }
      return real.apply(this, args);
    });
    const del = vi.spyOn(indexedDB, 'deleteDatabase');

    snap.warmPlannerSnapshot(U);
    snap.clearPlannerSnapshot();
    await vi.waitFor(() => expect(del).toHaveBeenCalledWith(snap.SNAPSHOT_DB));
    expect(refused).toBe(true);
    // This page's own connection closes on the delete's versionchange, so it goes through.
    await vi.waitFor(async () => expect(await rawKeys()).toEqual([]));
  });

  it('deletes the database when the clear transaction aborts', async () => {
    await write(U, data());
    const clear = vi.spyOn(IDBObjectStore.prototype, 'clear').mockImplementationOnce(function (this: IDBObjectStore) {
      this.transaction.abort();
      return {} as IDBRequest<undefined>;
    });
    const del = vi.spyOn(indexedDB, 'deleteDatabase');

    snap.clearPlannerSnapshot();
    await vi.waitFor(() => expect(del).toHaveBeenCalledWith(snap.SNAPSHOT_DB));
    expect(clear).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => expect(await rawKeys()).toEqual([]));
  });
});

describe('a write with a stale epoch', () => {
  it('is dropped when the clear came before the call', async () => {
    const epoch = snap.getSnapshotEpoch();
    snap.clearPlannerSnapshot();
    expect(await snap.writePlannerSnapshot(U, data(), Date.now(), epoch)).toBe(false);
    expect(await rawKeys()).toEqual([]);
  });

  it('is dropped when the clear lands while the database is still opening', async () => {
    const pending = write(U, data());
    snap.clearPlannerSnapshot();
    expect(await pending).toBe(false);
    expect(await rawKeys()).toEqual([]);
  });
});

describe('the newer-base refusal', () => {
  it('refuses a write whose base is OLDER than the stored one, and keeps the stored copy', async () => {
    const t = Date.now();
    await write(U, data({ items: [item('fresh')] }), t);
    expect(await write(U, data({ items: [item('stale')] }), t - 1000)).toBe(false);
    expect((await snap.readPlannerSnapshot(U))?.items.map((i) => i.id)).toEqual(['fresh']);
    expect((await rawRecord(`${U}#base`) as unknown as { baseAt: number }).baseAt).toBe(t);
  });

  it('writes an equal base (the same tab saving again) and a newer one', async () => {
    const t = Date.now() - 5000;
    await write(U, data({ items: [item('one')] }), t);
    expect(await write(U, data({ items: [item('two')] }), t)).toBe(true);
    expect(await write(U, data({ items: [item('three')] }), t + 1)).toBe(true);
    expect((await snap.readPlannerSnapshot(U))?.items.map((i) => i.id)).toEqual(['three']);
  });
});

/* ── the prefetch ────────────────────────────────────────────────────────── */

describe('the prefetch', () => {
  it('is reused for the same user and epoch', async () => {
    await write(U, data({ items: [item('old')] }));
    snap.warmPlannerSnapshot(U);
    // Created after the prefetch's get, so IndexedDB orders it after: a read
    // that re-fetched would see 'new'.
    await rawPut({ ...(await rawRecord(U)), data: data({ items: [item('new')] }) }, U);
    expect((await snap.readPlannerSnapshot(U))?.items.map((i) => i.id)).toEqual(['old']);
  });

  it('is ignored after a clear', async () => {
    await write(U, data({ items: [item('old')] }));
    snap.warmPlannerSnapshot(U);
    snap.clearPlannerSnapshot();
    await write(U, data({ items: [item('new')] }));
    expect((await snap.readPlannerSnapshot(U))?.items.map((i) => i.id)).toEqual(['new']);
  });

  it('is ignored for another user, and is single use', async () => {
    await write(U, data({ items: [item('old')] }));
    snap.warmPlannerSnapshot(U);
    expect(await snap.readPlannerSnapshot(V)).toBeNull();
    // V's read consumed it: U's read now goes to disk and sees the new copy.
    await rawPut({ ...(await rawRecord(U)), data: data({ items: [item('new')] }) }, U);
    expect((await snap.readPlannerSnapshot(U))?.items.map((i) => i.id)).toEqual(['new']);
  });

  it('touches neither the store nor the DOM — it only reads', async () => {
    await write(U, data());
    snap.warmPlannerSnapshot(U);
    snap.warmPlannerSnapshot(null);
    expect(await rawKeys()).toEqual([U, `${U}#base`]);
  });
});

/* ── the crash marker ────────────────────────────────────────────────────── */

describe('the crash marker', () => {
  const MARKER = 'dsul-preview-pending';

  it('is set and removed by markPreviewPending', () => {
    snap.markPreviewPending(true);
    expect(sessionStorage.getItem(MARKER)).toBe('1');
    snap.markPreviewPending(false);
    expect(sessionStorage.getItem(MARKER)).toBeNull();
  });

  it('present at a read: the snapshot is purged, the read is null, the marker is gone', async () => {
    await write(U, data());
    snap.markPreviewPending(true);

    expect(await snap.readPlannerSnapshot(U)).toBeNull();
    expect(sessionStorage.getItem(MARKER)).toBeNull();
    await vi.waitFor(async () => expect(await rawKeys()).toEqual([]));
  });

  it('present at a warm-up: consumed there, so the read after it finds nothing', async () => {
    await write(U, data());
    snap.markPreviewPending(true);

    snap.warmPlannerSnapshot(U);
    expect(sessionStorage.getItem(MARKER)).toBeNull();
    expect(await snap.readPlannerSnapshot(U)).toBeNull();
  });

  it('skips the preview ONCE: the next write and read work again', async () => {
    snap.markPreviewPending(true);
    expect(await snap.readPlannerSnapshot(U)).toBeNull();
    await write(U, data());
    expect(await snap.readPlannerSnapshot(U)).not.toBeNull();
  });
});

/**
 * What the writer asks before it removes the marker from a page being left
 * mid-preview: did the preview get onto the screen cleanly? SettleHost holds
 * while the preview is committed; the crash boundary reports every catch.
 */
describe('previewRenderedCleanly', () => {
  it('is false until SettleHost holds a committed preview, and false again once it lets go', () => {
    expect(snap.previewRenderedCleanly()).toBe(false);
    const release = snap.notePreviewRendered();
    expect(snap.previewRenderedCleanly()).toBe(true);
    release();
    expect(snap.previewRenderedCleanly()).toBe(false);
  });

  it('counts holds, and a release is spent once (a second call cannot drop another hold)', () => {
    const one = snap.notePreviewRendered();
    const two = snap.notePreviewRendered();
    one();
    one();
    expect(snap.previewRenderedCleanly()).toBe(true);
    two();
    expect(snap.previewRenderedCleanly()).toBe(false);
  });

  it('is false for the rest of the page once the crash boundary caught a throw, held or not', () => {
    const release = snap.notePreviewRendered();
    snap.notePreviewThrew();
    expect(snap.previewRenderedCleanly()).toBe(false);
    release();
    snap.notePreviewRendered();
    expect(snap.previewRenderedCleanly()).toBe(false);
  });

  it('is page state: a new page starts with neither', async () => {
    snap.notePreviewRendered();
    snap.notePreviewThrew();
    const next = await freshModule();
    expect(next.previewRenderedCleanly()).toBe(false);
    next.notePreviewRendered();
    expect(next.previewRenderedCleanly()).toBe(true);
  });
});

/* ── a hostile or missing database ───────────────────────────────────────── */

describe('an open that fails', () => {
  it('a synchronous SecurityError → null, and the next call tries again', async () => {
    const open = vi.fn(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.stubGlobal('indexedDB', { open, deleteDatabase: vi.fn() });

    expect(await snap.readPlannerSnapshot(U)).toBeNull();
    expect(await write(U, data())).toBe(false);
    expect(open).toHaveBeenCalledTimes(2); // a null result is not memoized
  });

  it('an error event → null', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        const req = {} as IDBOpenDBRequest;
        queueMicrotask(() => req.onerror?.(new Event('error')));
        return req;
      },
      deleteDatabase: vi.fn(),
    });
    expect(await snap.readPlannerSnapshot(U)).toBeNull();
  });

  it('three seconds of silence → null', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('indexedDB', { open: () => ({}) as IDBOpenDBRequest, deleteDatabase: vi.fn() });

    let result: unknown = 'pending';
    void snap.readPlannerSnapshot(U).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(2999);
    expect(result).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBeNull();
  });
});

/* ── the kill switch ─────────────────────────────────────────────────────── */

describe('PREVIEW_MODE', () => {
  it.each([
    [undefined, 'on'],
    ['on', 'on'],
    ['static', 'static'],
    [' OFF ', 'off'],
    ['banana', 'on'],
  ])('NEXT_PUBLIC_PLANNER_PREVIEW=%j reads as %s', async (value, mode) => {
    vi.stubEnv('NEXT_PUBLIC_PLANNER_PREVIEW', value);
    expect((await freshModule()).PREVIEW_MODE).toBe(mode);
  });
});

describe('off mode', () => {
  beforeEach(async () => {
    vi.stubEnv('NEXT_PUBLIC_PLANNER_PREVIEW', 'off');
    snap = await freshModule();
  });

  it('purgePlannerSnapshotDb deletes the database, and a clear purges too', () => {
    const del = vi.spyOn(indexedDB, 'deleteDatabase');
    snap.purgePlannerSnapshotDb();
    expect(del).toHaveBeenCalledWith('dsul-planner-cache');

    const before = snap.getSnapshotEpoch();
    snap.clearPlannerSnapshot();
    expect(del).toHaveBeenCalledTimes(2);
    expect(snap.getSnapshotEpoch()).toBe(before + 1);
  });

  it('read, write and warm never open it', async () => {
    const open = vi.spyOn(indexedDB, 'open');
    expect(snap.snapshotSupported()).toBe(false);
    snap.warmPlannerSnapshot(U);
    expect(await snap.readPlannerSnapshot(U)).toBeNull();
    expect(await write(U, data())).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});

/* ── the version fingerprint ─────────────────────────────────────────────── */

describe('SNAPSHOT_VERSION', () => {
  const LISTS: string[][] = [
    TASK_FIELDS,
    HABIT_FIELDS,
    PROJECT_FIELDS,
    ROUTINE_FIELDS,
    SEASON_FIELDS,
    GOAL_FIELDS,
    Object.keys(ItemTypeDefSchema.shape),
  ].map((list) => [...list]);

  it('is the hand-bumped format plus a fingerprint of every field list', () => {
    expect(snap.SNAPSHOT_VERSION).toBe(`${snap.SNAPSHOT_FORMAT}:${snap.snapshotFingerprint(LISTS)}`);
  });

  it('changes when any field list gains, loses or moves a key', () => {
    const base = snap.snapshotFingerprint(LISTS);
    const variants: string[] = [];
    LISTS.forEach((list, i) => {
      const swap = (next: string[]) => LISTS.map((l, j) => (j === i ? next : l));
      variants.push(snap.snapshotFingerprint(swap([...list, 'newField'])));
      variants.push(snap.snapshotFingerprint(swap(list.slice(1))));
      if (i + 1 < LISTS.length) {
        // The same keys in a different list is a different shape.
        const moved = LISTS.map((l) => [...l]);
        moved[i + 1].unshift(moved[i].pop()!);
        variants.push(snap.snapshotFingerprint(moved));
      }
    });
    expect(variants).not.toContain(base);
    expect(new Set(variants).size).toBe(variants.length);
  });

  it('fnv1a is the 32-bit reference hash', () => {
    expect(snap.fnv1a('')).toBe('811c9dc5');
    expect(snap.fnv1a('a')).toBe('e40c292c');
    expect(snap.fnv1a('foobar')).toBe('bf9cf968');
  });
});
