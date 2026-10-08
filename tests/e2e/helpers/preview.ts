import { expect, type Page, type Route } from '@playwright/test';
import { testUserId } from './api';

/**
 * The instant planner's cache, read from the browser, and the one network gate
 * that holds a reload on its look-only preview.
 *
 * Every reload now paints THIS BROWSER's copy of the last session
 * (lib/planner-snapshot.ts) while load_planner is in flight, and swaps to the
 * fresh data when it lands. These helpers let a spec see both halves: what is
 * on disk, and the preview held on screen for as long as the spec needs it.
 *
 * The names are re-typed here rather than imported from lib/: a spec runs in
 * Node and reaches the page only through evaluate(), and the database's name
 * and store are the on-disk contract a retirement shim deletes by name — a
 * rename there is a migration, not a refactor, and should break this loudly.
 */

const SNAPSHOT_DB = 'dsul-planner-cache';
const SNAPSHOT_STORE = 'snapshots';

/** The planner as the snapshot carries it — only the fields a spec reads. */
export interface SnapshotData {
  items: Array<{ id: string; title?: string; [key: string]: unknown }>;
  projects: Array<{ id: string; name?: string }>;
  [key: string]: unknown;
}

export interface SnapshotRecord {
  v: string;
  origin: string;
  userId: string;
  baseAt: number;
  savedAt: number;
  data: SnapshotData;
}

/**
 * One read-only pass over the cache, inside the page.
 *
 * Opens the database ONLY if `indexedDB.databases()` lists it. A bare
 * `indexedDB.open(name)` creates a missing database — and an empty one with no
 * object store, which the app's own open then has to detect and delete — so a
 * spec asserting "nothing is on disk" would be the thing that put something
 * there. If the database vanishes between the listing and the open (the app's
 * deleteDatabase), the upgrade that open would run is aborted, which fails the
 * open instead of creating anything.
 *
 * The connection closes before this returns, and closes itself on
 * `versionchange`: a held connection would block the app's deleteDatabase
 * (sign-out with nothing open, the `off` kill switch) for as long as it lived.
 */
function inPage<T extends 'record' | 'keys'>(
  page: Page,
  what: T,
  userId: string
): Promise<T extends 'record' ? SnapshotRecord | null : string[]> {
  return page.evaluate(
    async ({ db: name, store, what, userId }) => {
      const listed = await indexedDB.databases();
      if (!listed.some((d) => d.name === name)) return what === 'keys' ? [] : null;

      const db = await new Promise<IDBDatabase | null>((resolve) => {
        let gaveUp = false;
        const req = indexedDB.open(name);
        req.onupgradeneeded = () => req.transaction?.abort();
        // A blocked open (a delete is pending) can still succeed later; that
        // late connection is closed at once rather than left holding the
        // database open against the app's next delete.
        req.onsuccess = () => (gaveUp ? req.result.close() : resolve(req.result));
        req.onerror = () => resolve(null);
        req.onblocked = () => {
          gaveUp = true;
          resolve(null);
        };
      });
      if (!db) return what === 'keys' ? [] : null;
      db.onversionchange = () => db.close();

      try {
        if (!db.objectStoreNames.contains(store)) return what === 'keys' ? [] : null;
        return await new Promise<unknown>((resolve) => {
          const os = db.transaction(store, 'readonly').objectStore(store);
          const req = what === 'keys' ? os.getAllKeys() : os.get(userId);
          req.onsuccess = () =>
            resolve(what === 'keys' ? (req.result as IDBValidKey[]).map(String) : (req.result ?? null));
          req.onerror = () => resolve(what === 'keys' ? [] : null);
        });
      } finally {
        db.close();
      }
    },
    { db: SNAPSHOT_DB, store: SNAPSHOT_STORE, what, userId }
  ) as Promise<T extends 'record' ? SnapshotRecord | null : string[]>;
}

/** The signed-in test user's snapshot record, or null when there is none on disk. */
export function readSnapshot(page: Page): Promise<SnapshotRecord | null> {
  return inPage(page, 'record', testUserId());
}

/**
 * Every key in the snapshot store — the record's and its `#base` sibling's —
 * or [] when the database does not exist. Spec 4 asserts this is empty after a
 * sign-out, so it must be a pure read: see `inPage`.
 */
export function snapshotKeys(page: Page): Promise<string[]> {
  return inPage(page, 'keys', testUserId());
}

/**
 * Wait until the snapshot on disk satisfies `predicate`, and return it.
 *
 * CONTENT-AWARE on purpose. The writer runs 2s after the planner's last change,
 * at idle (lib/planner-snapshot-writer.ts), so a record written BEFORE the
 * spec's own change is already on disk while the change is still queued. A
 * predicate that only asked "is there a snapshot" (or "does it hold N items")
 * would pass on that older record, and the reload that follows would preview a
 * planner the spec never meant to show.
 */
export async function waitForSnapshot(
  page: Page,
  predicate: (data: SnapshotData) => boolean,
  message = 'the planner snapshot never caught up with the change'
): Promise<SnapshotRecord> {
  let found: SnapshotRecord | null = null;
  await expect
    .poll(
      async () => {
        const record = await readSnapshot(page);
        found = record && predicate(record.data) ? record : null;
        return found !== null;
      },
      { message, timeout: 10_000 }
    )
    .toBe(true);
  return found!;
}

const LOAD_PLANNER = '**/rest/v1/rpc/load_planner**';

export interface HeldPlannerLoad {
  /** Resolves once the app has ASKED for the planner — the request is now held. */
  requested: Promise<void>;
  /** Let every held and future load_planner request go on (or fail, under `failWith`). Idempotent. */
  release: () => void;
  /** Remove the route, so the next load goes to the server untouched. */
  unroute: () => Promise<void>;
}

/**
 * Hold every `load_planner` request until `release()`.
 *
 * The planner arrives in ONE rpc (smoke.spec pins that), so gating it is
 * enough to keep a reload on its look-only preview for as long as a spec needs
 * — without it the preview is up for ~50–1700ms, which no assertion can rely
 * on. By default the request is then continued untouched, so what lands is the
 * real load.
 *
 * `failWith` answers the held request with that HTTP status instead, as
 * PostgREST would for a server error: a code that is NOT one of the "rpc
 * missing" codes, so lib/db.ts's loadPlannerData fails the load rather than
 * falling back to the per-table fan-out. CORS is spelled out because the app
 * (localhost) and Supabase (127.0.0.1) are different origins, and a fulfilled
 * response without it reaches the app as a network error, not as a 5xx.
 *
 * Install it BEFORE the reload. The gate stays open once released, so with no
 * `failWith` a later reload goes straight through; `unroute` is for the spec
 * that needs the server back after a failure.
 */
export async function holdPlannerLoad(
  page: Page,
  options: { failWith?: number } = {}
): Promise<HeldPlannerLoad> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  let asked!: () => void;
  const requested = new Promise<void>((resolve) => (asked = resolve));

  const handler = async (route: Route) => {
    asked();
    await gate;
    // The page may have navigated away while the request was held; that
    // request is dead, and answering it would throw into the runner.
    if (options.failWith === undefined) {
      await route.continue().catch(() => {});
      return;
    }
    await route
      .fulfill({
        status: options.failWith,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({
          code: 'XX000',
          message: 'e2e: load_planner held to fail',
          details: null,
          hint: null,
        }),
      })
      .catch(() => {});
  };
  await page.route(LOAD_PLANNER, handler);

  return {
    requested,
    release: () => open(),
    unroute: () => page.unroute(LOAD_PLANNER, handler),
  };
}
