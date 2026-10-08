import { useExtensionsStore } from './extensions-store';
import { localStateOwner } from './local-state';
import { selectPlannerLoaded } from './planner-ready';
import {
  PREVIEW_MODE,
  getSnapshotEpoch,
  markPreviewPending,
  previewRenderedCleanly,
  purgePlannerSnapshotDb,
  snapshotSupported,
  writePlannerSnapshot,
  type PlannerSnapshotData,
} from './planner-snapshot';
import { usePlannerStore } from './planner-store';

/**
 * planner-snapshot-writer — keeps lib/planner-snapshot.ts's copy of the planner
 * current, off the critical path.
 *
 * A change to any data slice (or to the extension toggles) marks the snapshot
 * dirty; 2s after the LAST change, at idle, the store as it stands then is
 * written. Hiding the tab or leaving the page flushes at once, since that is
 * usually the last chance this tab gets.
 *
 * It writes only FRESH data for the account that owns this browser's local
 * state: never identifyUser's empty store, a lean route, a failed load, the
 * preview itself, a previous account after a cross-tab switch, or anything a
 * clear has overtaken (the epoch). A refused write stays dirty, so the next
 * chance takes it.
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
 */

export const SNAPSHOT_WRITE_DEBOUNCE_MS = 2000;
/** Past this the record costs more to clone and store than the preview saves. */
export const SNAPSHOT_MAX_ITEMS = 5000;
const IDLE_TIMEOUT_MS = 2000;

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

  const cancel = () => {
    if (debounce !== null) clearTimeout(debounce);
    debounce = null;
    idle?.();
    idle = null;
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
      void writePlannerSnapshot(b.userId, data, b.at, getSnapshotEpoch());
    } catch (err) {
      console.warn('[preview] snapshot write skipped', err);
    }
  };

  // At idle where the browser can say so; a bare macrotask where it cannot
  // (Safari has long shipped without requestIdleCallback, and so does jsdom).
  const whenIdle = () => {
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(
        () => {
          idle = null;
          write();
        },
        { timeout: IDLE_TIMEOUT_MS }
      );
      idle = () => window.cancelIdleCallback(handle);
    } else {
      const handle = setTimeout(() => {
        idle = null;
        write();
      }, 0);
      idle = () => clearTimeout(handle);
    }
  };

  /** Trailing: each change restarts the 2s, so a burst of edits is one write. */
  const schedule = () => {
    dirty = true;
    cancel();
    debounce = setTimeout(() => {
      debounce = null;
      whenIdle();
    }, SNAPSHOT_WRITE_DEBOUNCE_MS);
  };

  // Runs INSIDE every planner set() — initializeStore's landing included — so
  // nothing may escape it.
  const stopPlanner = usePlannerStore.subscribe((s, prev) => {
    try {
      // Every way a preview ends (fresh landing, failure drop, dropPreview, an
      // account reset) passes this edge; a marker left behind would purge a
      // good snapshot at the next read.
      if (prev.isPreview && !s.isPreview) markPreviewPending(false);
      // The first landing and a successful Retry. A failed load is settled but
      // not loaded, and never moves the base.
      if (prev.isLoading && !s.isLoading && selectPlannerLoaded(s) && s.userId) {
        base = { userId: s.userId, at: Date.now() };
      }
      if (s.userId !== base?.userId) base = null;
      if (SLICES.some((key) => s[key] !== prev[key])) schedule();
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
    stopPlanner();
    stopExtensions();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', rearm);
    cancel();
  };
}
