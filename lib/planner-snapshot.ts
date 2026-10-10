import {
  GOAL_FIELDS,
  HABIT_FIELDS,
  ItemTypeDefSchema,
  PROJECT_FIELDS,
  ROUTINE_FIELDS,
  SEASON_FIELDS,
  TASK_FIELDS,
  type Goal,
  type Item,
  type ItemTypeDef,
  type Project,
  type Routine,
  type Season,
} from '@dsul/types';

/**
 * planner-snapshot — THIS BROWSER's copy of the last session's planner, kept so
 * a reload can paint it look-only while the fresh load is in flight.
 *
 * IndexedDB, never localStorage: zustand persist rewrites its whole blob on
 * every set(), and a ~1MB planner in the shared localStorage quota would make
 * every planner set() throw QuotaExceededError the day it filled
 * (lib/local-state.ts says why that throw is unwrapped). IDB is async, isolated
 * and structured-clones.
 *
 * Imports only @dsul/types, so local-state (RAW_CLEARERS) and planner-store can
 * both import it without a cycle. Every entry point no-ops when IndexedDB is
 * missing (jsdom, the server, a locked-down browser), and nothing here throws or
 * rejects: a cache must never be able to fail the load it is decorating.
 *
 * ── OWNERSHIP ────────────────────────────────────────────────────────────────
 * One account at most is on disk: every write clear()s first. The record is
 * re-validated on read against the build (`v`), the Supabase project (`origin` —
 * dev can point one origin at prod or a local stack) and the user. A module
 * EPOCH, bumped synchronously by every clear, drops any read, prefetch or write
 * that was in flight when the clear was asked for: the IDB clear itself is
 * async and a sign-out's hard navigation can abort it, but the epoch cannot be
 * outrun.
 *
 * Wholly disclosive (every title and note), so it is in local-state's
 * RAW_CLEARERS. RETIRE IT ONLY VIA `NEXT_PUBLIC_PLANNER_PREVIEW=off`, never by
 * reverting: this code is the only thing that ever deletes the database.
 */

export const SNAPSHOT_DB = 'dsul-planner-cache';
export const SNAPSHOT_STORE = 'snapshots';
const DB_VERSION = 1;
/** Tiny sibling of the record, so the newer-base check never deserializes ~1MB. */
const BASE_KEY = (userId: string) => `${userId}#base`;
/** sessionStorage, tab-scoped, holds '1' while a preview is on screen. */
const CRASH_MARKER = 'dsul-preview-pending';
/** On <html> while a preview may still come for this page (expectPreview). */
export const PREVIEW_EXPECTED_ATTR = 'data-preview-expected';
const OPEN_TIMEOUT_MS = 3000;
/** A base stamped this far in the future is a skewed clock, not a fresh copy. */
const FUTURE_SKEW_MS = 5 * 60_000;

/** Bump BY HAND when loadPlannerData's output changes meaning — the ledger test in
 *  tests/unit/planner-bundle.test.ts fails until you do. */
export const SNAPSHOT_FORMAT = 2;

/** 32-bit FNV-1a over UTF-16 code units, as 8 hex digits. A fingerprint, not a MAC. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function snapshotFingerprint(lists: readonly (readonly string[])[]): string {
  return fnv1a(lists.map((list) => list.join(',')).join('|'));
}

/**
 * Exact-match only: a cache discards, it never migrates. The fingerprint catches
 * an added, removed or renamed key automatically; a change in what a key MEANS
 * (a mapper fold, a new default) is SNAPSHOT_FORMAT's job.
 */
export const SNAPSHOT_VERSION = `${SNAPSHOT_FORMAT}:${snapshotFingerprint([
  TASK_FIELDS,
  HABIT_FIELDS,
  PROJECT_FIELDS,
  ROUTINE_FIELDS,
  SEASON_FIELDS,
  GOAL_FIELDS,
  Object.keys(ItemTypeDefSchema.shape),
])}`;

/** Measured from `baseAt` — when this tab's data was last fetched fresh — not from savedAt. */
export const SNAPSHOT_TTL_MS = 7 * 86_400_000;

export type PreviewMode = 'on' | 'static' | 'off';

function parsePreviewMode(raw: string | undefined): PreviewMode {
  const mode = raw?.trim().toLowerCase();
  return mode === 'static' || mode === 'off' ? mode : 'on';
}

/**
 * The kill switch. `static` previews with no settle animation; `off` reads and
 * writes nothing and deletes the database. A LITERAL process.env reference, so
 * Next inlines it into the client bundle — an indirect lookup would read
 * undefined in the browser and silently mean 'on'.
 */
export const PREVIEW_MODE: PreviewMode = parsePreviewMode(process.env.NEXT_PUBLIC_PLANNER_PREVIEW);

const ORIGIN = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';

export interface PlannerSnapshotData {
  items: Item[];
  projects: Project[];
  itemTypes: ItemTypeDef[];
  routines: Routine[];
  seasons: Season[];
  goals: Goal[];
  itemTypesAvailable: boolean;
  collectionsAvailable: boolean;
  goalsAvailable: boolean;
  /** Display-only preview of the user's extension toggles (sparse). Optional; malformed → stripped. */
  extensionsEnabled?: Record<string, boolean>;
}

export interface PlannerSnapshotRecord {
  v: string;
  origin: string;
  userId: string;
  baseAt: number;
  savedAt: number;
  data: PlannerSnapshotData;
}

const SNAPSHOT_LISTS = ['items', 'projects', 'itemTypes', 'routines', 'seasons', 'goals'] as const;
const SNAPSHOT_FLAGS = ['itemTypesAvailable', 'collectionsAvailable', 'goalsAvailable'] as const;

let epoch = 0;
let dbPromise: Promise<IDBDatabase | null> | null = null;
let prefetched: { userId: string; epoch: number; promise: Promise<unknown> } | null = null;

/** `indexedDB` itself can throw on access (sandboxed frames, some private modes). */
function idbPresent(): boolean {
  try {
    return typeof window !== 'undefined' && typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

export function snapshotSupported(): boolean {
  return PREVIEW_MODE !== 'off' && idbPresent();
}

export function getSnapshotEpoch(): number {
  return epoch;
}

const isBooleanMap = (value: unknown): value is Record<string, boolean> =>
  Object.prototype.toString.call(value) === '[object Object]' &&
  Object.values(value as object).every((v) => typeof v === 'boolean');

/**
 * Whether a stored record may be painted for `userId`.
 *
 * Checks the SHAPE the preview's render relies on — every list element an object
 * with a string id — because a cached planner that throws while rendering would
 * otherwise crash each reload until the TTL. Under 1ms at 800 items.
 *
 * MUTATES a passing record: a malformed `extensionsEnabled` is deleted rather
 * than rejecting the whole planner over a display hint.
 */
export function isValidSnapshot(
  rec: unknown,
  userId: string,
  now = Date.now()
): rec is PlannerSnapshotRecord {
  if (!rec || typeof rec !== 'object') return false;
  const r = rec as Partial<PlannerSnapshotRecord>;
  if (r.v !== SNAPSHOT_VERSION || r.origin !== ORIGIN || r.userId !== userId) return false;
  if (typeof r.baseAt !== 'number' || !Number.isFinite(r.baseAt)) return false;
  const age = now - r.baseAt;
  if (age < -FUTURE_SKEW_MS || age >= SNAPSHOT_TTL_MS) return false;
  const data = r.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object') return false;
  for (const key of SNAPSHOT_LISTS) {
    const list = data[key];
    if (!Array.isArray(list)) return false;
    for (const el of list) {
      if (!el || typeof el !== 'object' || typeof (el as { id?: unknown }).id !== 'string') return false;
    }
  }
  for (const flag of SNAPSHOT_FLAGS) {
    if (typeof data[flag] !== 'boolean') return false;
  }
  if (data.extensionsEnabled !== undefined && !isBooleanMap(data.extensionsEnabled)) {
    delete data.extensionsEnabled;
  }
  return true;
}

/**
 * The one connection, memoized. Resolves null rather than rejecting on every
 * failure — a synchronous SecurityError, an error, a blocked upgrade, or 3s of
 * silence — and a null result is not memoized, so the next caller tries again.
 */
function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  const opening = new Promise<IDBDatabase | null>((resolve) => {
    let settled = false;
    const done = (db: IDBDatabase | null) => {
      if (settled) {
        db?.close(); // a late success after the timeout gave up on it
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(db);
    };
    const timer = setTimeout(() => done(null), OPEN_TIMEOUT_MS);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(SNAPSHOT_DB, DB_VERSION);
    } catch {
      done(null);
      return;
    }
    req.onupgradeneeded = () => {
      try {
        const db = req.result;
        if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) db.createObjectStore(SNAPSHOT_STORE);
      } catch {
        /* the success check below catches a store that did not get made */
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
        // A v1 database with no store can only be a broken earlier open; it can
        // never be upgraded at the same version, so start over next time.
        db.close();
        try {
          indexedDB.deleteDatabase(SNAPSHOT_DB);
        } catch {
          /* nothing more to do */
        }
        done(null);
        return;
      }
      // Another tab's deleteDatabase (`off` mode) must not be blocked by us.
      db.onversionchange = () => {
        db.close();
        if (dbPromise === opening) dbPromise = null;
      };
      done(db);
    };
    req.onerror = () => done(null);
    req.onblocked = () => done(null);
  });
  dbPromise = opening;
  void opening.then((db) => {
    if (!db && dbPromise === opening) dbPromise = null;
  });
  return opening;
}

/** A readonly get that resolves null on any error, never rejects. */
function getRecord(key: string): Promise<unknown> {
  return openDb()
    .then(
      (db) =>
        new Promise<unknown>((resolve) => {
          if (!db) {
            resolve(null);
            return;
          }
          try {
            const tx = db.transaction(SNAPSHOT_STORE, 'readonly');
            const req = tx.objectStore(SNAPSHOT_STORE).get(key);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => resolve(null);
            tx.onabort = () => resolve(null);
          } catch {
            resolve(null);
          }
        })
    )
    .catch(() => null);
}

/** Fire-and-forget: drop one account's record and its base. */
function deleteRecord(userId: string): void {
  void openDb()
    .then((db) => {
      if (!db) return;
      const store = db.transaction(SNAPSHOT_STORE, 'readwrite').objectStore(SNAPSHOT_STORE);
      store.delete(userId);
      store.delete(BASE_KEY(userId));
    })
    .catch(() => {});
}

/**
 * The crash marker is set before a preview is applied and removed when it ends,
 * or when the page is left or hidden with a preview it rendered cleanly (the
 * writer asks `previewRenderedCleanly`). Still present at the next read means
 * the last preview neither ended nor was left cleanly: the page hung on it (a
 * hung page runs no pagehide) or a throw unmounted it. So purge the snapshot
 * and skip the preview once.
 */
function consumeCrashMarker(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.sessionStorage.getItem(CRASH_MARKER) === null) return false;
  } catch {
    return false;
  }
  markPreviewPending(false);
  clearPlannerSnapshot();
  return true;
}

/**
 * `<html data-preview-expected>`: a preview may still come for this page, so
 * PlannerSkeleton holds its bars back past their usual 250ms (app/globals.css,
 * "Planner skeleton"). On a warm reload the skeleton mounts at the shell's
 * mount and the cached planner replaces it once the read lands, but that
 * render is one long task: the bars' fade ran on the compositor through it and
 * flashed on screen just before the preview painted.
 *
 * Set by warmPlannerSnapshot when a preview can come, which is before the
 * skeleton first mounts (the provider's effect runs in the same flush as
 * AppShell's mount effect, ahead of the render that effect asks for).
 * Cleared the moment one can no longer come or is no longer needed: the
 * prefetch finding nothing usable, a clear (sign-out, account switch, the
 * crash marker), the offer's end whatever its outcome (nothing on disk,
 * declined, applied, thrown; offerPreview in lib/planner-store.ts), and the
 * load settling (the writer). The CSS delay is a cap, so a page that never
 * clears it (an offline launch whose session never confirms) shows the bars
 * at 1.5s, not never.
 */
export function expectPreview(on: boolean): void {
  if (typeof document === 'undefined') return;
  try {
    const root = document.documentElement;
    if (on) root.setAttribute(PREVIEW_EXPECTED_ATTR, '');
    else if (root.hasAttribute(PREVIEW_EXPECTED_ATTR)) root.removeAttribute(PREVIEW_EXPECTED_ATTR);
  } catch {
    /* a missing attribute only costs the bars their longer hold */
  }
}

export function markPreviewPending(on: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (on) window.sessionStorage.setItem(CRASH_MARKER, '1');
    else window.sessionStorage.removeItem(CRASH_MARKER);
  } catch {
    /* no sessionStorage: no backstop, the error boundary still stands */
  }
}

/**
 * Page-lifetime: SettleHost's holds on a committed preview, whether one was
 * ever taken, and whether the crash boundary ever caught a throw.
 */
let previewHolds = 0;
let previewCommitted = false;
let previewThrew = false;

/**
 * SettleHost, in an effect while previewing: the real views committed the
 * cached rows without throwing. Returns the release for the effect's cleanup,
 * which also runs when a throw above AppShell unmounts the tree, so a preview
 * that crashed the page is never held at its pagehide.
 */
export function notePreviewRendered(): () => void {
  previewHolds += 1;
  previewCommitted = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    previewHolds = Math.max(0, previewHolds - 1);
  };
}

/** PreviewCrashBoundary caught a render throw. For the rest of this page, no preview counts as clean. */
export function notePreviewThrew(): void {
  previewThrew = true;
}

/**
 * Whether the preview on screen got there cleanly: committed, still mounted,
 * and no throw caught on this page. A page left or hidden in that state is a
 * reload, a navigation, pull-to-refresh or a tab put away, not a crash, so the
 * writer removes the marker and the next page previews again.
 *
 * Off `/` the hold is gone with AppShell (a client navigation unmounts it while
 * the preview stays up), so there a preview that committed once counts. Nothing
 * off `/` renders it, and a throw above AppShell unmounts the provider too,
 * which stops the writer that would ask. On `/` a released hold under a live
 * preview can only be a throw, so it never counts there.
 */
export function previewRenderedCleanly(): boolean {
  if (previewThrew) return false;
  if (previewHolds > 0) return true;
  return previewCommitted && typeof window !== 'undefined' && window.location.pathname !== '/';
}

/**
 * Open the database and PREFETCH `ownerHint`'s record into memory, in parallel
 * with getSession. Nothing reaches the store or the DOM: the hint is only the
 * on-disk owner stamp, and painting before the session is confirmed would show
 * a revoked account's planner. `readPlannerSnapshot` adopts the prefetch only
 * for the same user and epoch.
 *
 * No hint opens nothing. An unowned browser's adoption clears the snapshot
 * before any read (RAW_CLEARERS), so an early open would buy that read nothing
 * — and would create the database for a visitor who never signs in.
 *
 * A hint is also what makes a preview possible, so it raises expectPreview
 * here, before the skeleton first mounts.
 */
export function warmPlannerSnapshot(ownerHint: string | null): void {
  try {
    if (!snapshotSupported() || consumeCrashMarker()) return;
    if (ownerHint) {
      expectPreview(true);
      const promise = getRecord(ownerHint);
      prefetched = { userId: ownerHint, epoch, promise };
      // Nothing usable on disk (none yet, expired, an older build's): no
      // preview can come, so the bars go back to their own delay at once,
      // without waiting for the session and the offer.
      void promise.then((rec) => {
        try {
          if (!isValidSnapshot(rec, ownerHint)) expectPreview(false);
        } catch {
          expectPreview(false);
        }
      });
    }
  } catch {
    /* a warm-up is only ever an optimisation */
  }
}

/** The user's cached planner, or null. NEVER rejects or throws. */
export function readPlannerSnapshot(userId: string): Promise<PlannerSnapshotData | null> {
  try {
    if (!snapshotSupported() || consumeCrashMarker()) return Promise.resolve(null);
    const start = epoch;
    const pre = prefetched;
    prefetched = null; // single use
    const pending =
      pre && pre.userId === userId && pre.epoch === start ? pre.promise : getRecord(userId);
    return pending
      .then((rec) => {
        if (epoch !== start) return null;
        if (!isValidSnapshot(rec, userId)) {
          if (rec != null) deleteRecord(userId);
          return null;
        }
        return rec.data;
      })
      .catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

function abortQuietly(tx: IDBTransaction): void {
  try {
    tx.abort();
  } catch {
    /* already finished */
  }
}

/**
 * How a write ended, so the writer knows whether trying again can help.
 * `refused` would meet the same answer again, or was not wanted: no snapshot
 * support, a clear since the caller read the epoch, or a NEWER base on disk.
 * `failed` might not: no connection (the open errored, was blocked or timed
 * out) or a transaction that errored or aborted on its own (a quota, an
 * uncloneable value).
 */
export type SnapshotWriteResult = 'written' | 'refused' | 'failed';

/**
 * Store `data` as `userId`'s snapshot, replacing whatever is on disk. NEVER
 * rejects or throws; resolves with how it ended (SnapshotWriteResult).
 *
 * Refused when a clear has happened since the caller read `expectEpoch`, and —
 * in the same readwrite transaction, so two tabs cannot interleave — when the
 * stored base is NEWER than `baseAt`: a days-old tab (Electron hides to tray)
 * must not overwrite a fresher tab's copy with its own.
 */
export function writePlannerSnapshot(
  userId: string,
  data: PlannerSnapshotData,
  baseAt: number,
  expectEpoch: number
): Promise<SnapshotWriteResult> {
  try {
    if (!snapshotSupported() || expectEpoch !== epoch) return Promise.resolve('refused');
    return openDb()
      .then((db): SnapshotWriteResult | Promise<SnapshotWriteResult> => {
        if (!db) return 'failed';
        if (expectEpoch !== epoch) return 'refused';
        const record: PlannerSnapshotRecord = {
          v: SNAPSHOT_VERSION,
          origin: ORIGIN,
          userId,
          baseAt,
          savedAt: Date.now(),
          data,
        };
        return new Promise<SnapshotWriteResult>((resolve) => {
          let tx: IDBTransaction;
          try {
            tx = db.transaction(SNAPSHOT_STORE, 'readwrite');
          } catch {
            resolve('failed');
            return;
          }
          // Set before the abort that a newer base asks for, so that abort reads as a refusal.
          let newerBase = false;
          const unwritten = () => resolve(newerBase ? 'refused' : 'failed');
          tx.oncomplete = () => resolve('written');
          tx.onerror = unwritten;
          tx.onabort = unwritten;
          try {
            const store = tx.objectStore(SNAPSHOT_STORE);
            const base = store.get(BASE_KEY(userId));
            base.onsuccess = () => {
              try {
                const stored = (base.result as { baseAt?: unknown } | undefined)?.baseAt;
                if (typeof stored === 'number' && stored > baseAt) {
                  newerBase = true;
                  abortQuietly(tx); // a newer base wins
                  return;
                }
                store.clear(); // one account at most on disk
                store.put(record, userId); // DataCloneError throws here → abort → 'failed'
                store.put({ baseAt }, BASE_KEY(userId));
              } catch {
                abortQuietly(tx);
              }
            };
          } catch {
            abortQuietly(tx);
          }
        });
      })
      .catch((): SnapshotWriteResult => 'failed');
  } catch {
    return Promise.resolve('failed');
  }
}

/**
 * Forget the snapshot. The epoch bump is SYNCHRONOUS and unconditional — it is
 * what makes a clear win against reads and writes already in flight. The IDB
 * clear is fire-and-forget; IDB runs overlapping transactions in creation
 * order, so a clear asked for in adoptLocalState lands before any later read.
 *
 * With no connection opened in this page, it DELETES the database instead. An
 * open creates it, and the clears that run with nothing open (the /login mount
 * purge, the no-session branch, a first adoption) would otherwise leave one in
 * every browser that has never signed in. Deleting a missing database is a
 * no-op, and IDB queues opens and deletes in request order, so a read asked
 * for after this still finds nothing.
 *
 * A clear that waited on an open must erase even when that connection never
 * comes up (the open failed, was blocked or timed out) or is gone by the time
 * it runs (the transaction throws or aborts): each of those DELETES the
 * database too. The epoch already keeps the record off this page; only the
 * delete gets the previous owner's planner off the disk.
 */
export function clearPlannerSnapshot(): void {
  epoch++;
  prefetched = null;
  // Every read in flight now comes back null, so no preview can follow.
  expectPreview(false);
  if (PREVIEW_MODE === 'off' || !dbPromise) {
    purgePlannerSnapshotDb();
    return;
  }
  try {
    void dbPromise
      .then((db) => {
        if (!db) {
          purgePlannerSnapshotDb();
          return;
        }
        const tx = db.transaction(SNAPSHOT_STORE, 'readwrite');
        tx.onabort = () => purgePlannerSnapshotDb();
        tx.objectStore(SNAPSHOT_STORE).clear();
      })
      .catch(() => purgePlannerSnapshotDb());
  } catch {
    purgePlannerSnapshotDb();
  }
}

/** Delete the whole database — `off` mode, retirement, and a clear with nothing open. Other tabs' connections close on versionchange. */
export function purgePlannerSnapshotDb(): void {
  if (!idbPresent()) return;
  try {
    indexedDB.deleteDatabase(SNAPSHOT_DB);
  } catch {
    /* nothing more to do */
  }
}
