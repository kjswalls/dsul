import { useExtensionsStore } from './extensions-store';
import { localStateOwner } from './local-state';
import { selectPlannerLoaded } from './planner-ready';
import {
  PREVIEW_MODE,
  expectPreview,
  getSnapshotEpoch,
  markPreviewPending,
  previewRenderedCleanly,
  purgePlannerSnapshotDb,
  snapshotSupported,
  writePlannerSnapshot,
  type PlannerSnapshotData,
  type SnapshotWriteResult,
} from './planner-snapshot';
import { usePlannerStore } from './planner-store';

/**
 * planner-snapshot-writer — keeps lib/planner-snapshot.ts's copy of the planner
 * current, off the critical path.
 *
 * A change to any data slice (or to the extension toggles) marks the snapshot
 * dirty; 2s after the LAST change, at idle, the store as it stands then is
 * written. Hiding the tab or leaving the page flushes at once, since that is
 * usually the last chance this tab gets. A landing that replaced NO preview
 * is written at the first idle instead, taking any change made before that
 * idle with it: there is no settle to keep smooth, and a first visit reloaded
 * inside those 2s would otherwise find nothing on disk (a reload's pagehide
 * flush rarely commits before the page goes).
 *
 * It writes only FRESH data for the account that owns this browser's local
 * state: never identifyUser's empty store, a lean route, a failed load, the
 * preview itself, a previous account after a cross-tab switch, or anything a
 * clear has overtaken (the epoch). A write that may not go yet stays dirty, so
 * the next chance takes it. One the database failed (no connection, a
 * transaction error) is tried again, at most WRITE_RETRIES times, each wait
 * twice the last; one it refused (a newer base on disk, a clear) is not, since
 * the same copy would meet the same answer.
 *
 * `base` is when THIS tab last fetched the planner fresh. The record carries
 * it, the TTL is measured from it, and the store refuses a write whose base is
 * older than the one on disk — a days-old tab (Electron hides to tray) must not
 * overwrite a fresher tab's copy with its own.
 *
 * It also keeps the crash marker honest (lib/planner-snapshot.ts). The marker
 * goes when the preview ends, and when the page is left or hidden with a
 * preview it rendered cleanly: a reload, a navigation, pull-to-refresh or a tab
 * put away mid-preview is not a crash. It comes back if the page is shown again
 * with the preview still up.
 *
 * And it ends the skeleton's hold (expectPreview) when the preview goes up or
 * the load settles, however the offer itself is faring: a read still out when
 * the load lands can no longer bring a preview.
 */

export const SNAPSHOT_WRITE_DEBOUNCE_MS = 2000;
/** Past this the record costs more to clone and store than the preview saves. */
export const SNAPSHOT_MAX_ITEMS = 5000;
const IDLE_TIMEOUT_MS = 2000;
/** How many times a write the database failed is tried again (4s, 8s, 16s after). */
export const WRITE_RETRIES = 3;

type Base = { userId: string; at: number };

/** Structural, as lib/planner-ready.ts's selectors are: PlannerStore is not exported. */
type WritableState = {
  userId: string | null;
  isLoading: boolean;
  isPreview: boolean;
  error: string | null;
  loadFailedUserId: string | null;
  items: readonly unknown[];
};

type PlannerState = ReturnType<typeof usePlannerStore.getState>;

/** The slices a snapshot is made of; a new reference on any one of them is a change worth writing. */
const SLICES = ['items', 'projects', 'itemTypes', 'routines', 'seasons', 'goals'] as const;

export function snapshotWritable(s: WritableState, owner: string | null, base: Base | null): boolean {
  return (
    !!s.userId &&
    selectPlannerLoaded(s) &&
    !s.isPreview &&
    owner === s.userId &&
    base?.userId === s.userId &&
    s.items.length <= SNAPSHOT_MAX_ITEMS
  );
}

/** The record's data. The extension toggles ride along only once they have loaded for THIS user. */
function pick(s: PlannerState): PlannerSnapshotData {
  const data: PlannerSnapshotData = {
    items: s.items,
    projects: s.projects,
    itemTypes: s.itemTypes,
    routines: s.routines,
    seasons: s.seasons,
    goals: s.goals,
    itemTypesAvailable: s.itemTypesAvailable,
    collectionsAvailable: s.collectionsAvailable,
    goalsAvailable: s.goalsAvailable,
  };
  const ext = useExtensionsStore.getState();
  if (ext.configsLoaded && ext.hydratedUserId === s.userId) data.extensionsEnabled = { ...ext.enabled };
  return data;
}

const noop = () => {};

/**
 * Start writing; returns the stop. Mounted once, by the provider. A no-op on
 * the server and where IndexedDB is missing; under `off` it deletes the
 * database instead, so a retired feature leaves nothing on disk.
 */
export function startPlannerSnapshotWriter(): () => void {
  if (typeof window === 'undefined') return noop;
  if (PREVIEW_MODE === 'off') {
    purgePlannerSnapshotDb();
    return noop;
  }
  if (!snapshotSupported()) return noop;

  let dirty = false;
  let base: Base | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let idle: (() => void) | null = null;
  /** Tries of the current change the database has failed; a new change starts again at 0. */
  let failures = 0;
  /**
   * A landing with no preview has its write waiting for the first idle. A
   * change before then rides along (the write reads the store when it runs),
   * rather than putting it off another 2s: the extensions and the AI gate
   * answer just after the landing, and each would otherwise restart the wait.
   */
  let early = false;
  let stopped = false;

  const cancel = () => {
    if (debounce !== null) clearTimeout(debounce);
    debounce = null;
    idle?.();
    idle = null;
    early = false;
  };

  const write = () => {
    try {
      if (!dirty) return;
      const s = usePlannerStore.getState();
      const b = base;
      // Refused stays DIRTY: the change is still unwritten, and the next
      // chance (a landing, a flush) should take it.
      if (!b || !snapshotWritable(s, localStateOwner(), b)) return;
      const data = pick(s);
      dirty = false;
      void writePlannerSnapshot(b.userId, data, b.at, getSnapshotEpoch()).then(written);
    } catch (err) {
      console.warn('[preview] snapshot write skipped', err);
    }
  };

  // Only a write the database FAILED is tried again, and a few times at most:
  // a refusal would meet the same answer, and retrying it on a clock is the hot
  // loop this must never become. A change made since already has a write
  // coming, which carries this one's data too.
  const written = (result: SnapshotWriteResult) => {
    if (stopped) return;
    if (result !== 'failed') {
      if (result === 'written') failures = 0;
      return;
    }
    dirty = true;
    if (debounce !== null || idle !== null || failures >= WRITE_RETRIES) return;
    failures += 1;
    later(SNAPSHOT_WRITE_DEBOUNCE_MS * 2 ** failures);
  };

  // At idle where the browser can say so; a bare macrotask where it cannot
  // (Safari has long shipped without requestIdleCallback, and so does jsdom).
  const whenIdle = () => {
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(
        () => {
          idle = null;
          early = false;
          write();
        },
        { timeout: IDLE_TIMEOUT_MS }
      );
      idle = () => window.cancelIdleCallback(handle);
    } else {
      const handle = setTimeout(() => {
        idle = null;
        early = false;
        write();
      }, 0);
      idle = () => clearTimeout(handle);
    }
  };

  /** A write at the first idle after `ms`, replacing any already planned. */
  const later = (ms: number) => {
    cancel();
    debounce = setTimeout(() => {
      debounce = null;
      whenIdle();
    }, ms);
  };

  /** Trailing: each change restarts the 2s, so a burst of edits is one write. */
  const schedule = () => {
    dirty = true;
    failures = 0;
    if (early) return;
    later(SNAPSHOT_WRITE_DEBOUNCE_MS);
  };

  /** The landing with nothing previewed: at the first idle, with no settle to wait out. */
  const soon = () => {
    dirty = true;
    failures = 0;
    cancel();
    early = true;
    whenIdle();
  };

  // Runs INSIDE every planner set() — initializeStore's landing included — so
  // nothing may escape it.
  const stopPlanner = usePlannerStore.subscribe((s, prev) => {
    try {
      // Every way a preview ends (fresh landing, failure drop, dropPreview, an
      // account reset) passes this edge; a marker left behind would purge a
      // good snapshot at the next read.
      if (prev.isPreview && !s.isPreview) markPreviewPending(false);
      // Up, or settled either way: no preview is coming after this.
      if ((s.isPreview && !prev.isPreview) || (prev.isLoading && !s.isLoading)) expectPreview(false);
      // The first landing and a successful Retry. A failed load is settled but
      // not loaded, and never moves the base.
      const landed = prev.isLoading && !s.isLoading && selectPlannerLoaded(s);
      if (landed && s.userId) base = { userId: s.userId, at: Date.now() };
      if (s.userId !== base?.userId) base = null;
      if (SLICES.some((key) => s[key] !== prev[key])) {
        // A preview at the landing means a settle is running; keep its 2s.
        if (landed && !prev.isPreview) soon();
        else schedule();
      }
    } catch (err) {
      console.warn('[preview] snapshot writer skipped a change', err);
    }
  });

  const stopExtensions = useExtensionsStore.subscribe((s, prev) => {
    try {
      if (s.enabled !== prev.enabled && s.configsLoaded) schedule();
    } catch (err) {
      console.warn('[preview] snapshot writer skipped a change', err);
    }
  });

  const flush = () => {
    cancel();
    write();
  };

  // The marker is for a preview that hung or crashed the page. Leaving or
  // hiding the page while a preview it rendered cleanly is still up is neither,
  // so the marker goes and the next page previews again. A hung page runs none
  // of this, and a throw unmounts SettleHost's hold, so both keep it. Hidden
  // counts as leaving: it is the last event a page killed in the background
  // (a discarded tab, a phone reclaiming memory) is sure to get.
  const standDown = () => {
    try {
      if (usePlannerStore.getState().isPreview && previewRenderedCleanly()) markPreviewPending(false);
    } catch (err) {
      console.warn('[preview] crash marker left as it was', err);
    }
  };
  // Shown again, or back from the back/forward cache, with the preview still
  // up: armed again, as offerPreview armed it.
  const rearm = () => {
    try {
      if (usePlannerStore.getState().isPreview) markPreviewPending(true);
    } catch (err) {
      console.warn('[preview] crash marker left as it was', err);
    }
  };

  const onPageHide = () => {
    flush();
    standDown();
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') onPageHide();
    else rearm();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', rearm);

  return () => {
    stopped = true;
    stopPlanner();
    stopExtensions();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', rearm);
    cancel();
  };
}
