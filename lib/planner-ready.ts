import { usePlannerStore } from '@/lib/planner-store';

/**
 * "Has the planner's load for this account LANDED?" — one definition, read by
 * the canvas routers' skeleton swap and `data-loaded` marker, the braindump,
 * the EOD deep link (lib/eod-link.ts) and the Display summary.
 *
 * Hydration is not the same thing: initializeStore replaces `projects` /
 * `items` / the containers wholesale when it resolves, so a surface (or a
 * test) that treated "mounted" as "loaded" would render an empty store as
 * though the account owned nothing, and a write made in that window is
 * silently discarded.
 *
 * `userId &&`, not `!isLoading` alone: isLoading is FALSE at rest and only
 * flips true once identifyUser / initializeStore stamps an account, so the
 * bare check is satisfied by the pre-init state and would wave everything
 * through before the fetch has even been issued. userId is set in the same
 * set() that raises the flag.
 *
 * A FAILED load counts as settled, on purpose. Every writer that clears
 * `isLoading` does it in the same set() that records the outcome (success
 * lands the data, failure lands `error` + `loadFailedUserId`), so there is no
 * half-state to guard with a `loadFailedUserId` clause. A surface that must
 * also distrust a failed load's empty store asks `selectPlannerLoaded` below
 * (the braindump's count predates it and adds `&& !s.error` itself).
 *
 * On a LEAN route (lib/route-data.ts) identifyUser stamps the account and
 * leaves `isLoading: true` with no load to clear it. Anything gated on this
 * stays pending there forever — so never mount a gated surface on a lean
 * route.
 *
 * SETTLED ⇒ NOT PREVIEWING. The look-only preview (lib/planner-snapshot.ts)
 * paints cached rows while `isLoading` stays TRUE, and every set() that clears
 * `isLoading` clears `isPreview` with it, so nothing gated on this ever runs on
 * cached data. Three readings, three questions:
 *   - settled: the load has finished, either way (above).
 *   - visible: there is something to SHOW — fresh data or the preview. The
 *     views mount on it; nothing may write on it.
 *   - loaded: fresh data actually landed for this account. Every surface that
 *     ACTS on the planner gates here, not on settled, because settled counts a
 *     failed load's empty store. Two exceptions act on settled, a failed load
 *     included, because what they carry is typed text with no other copy:
 *     quick capture (lib/held-captures.ts) and a waiting pasted list's
 *     promotion (hooks/use-deferred-dialog.ts).
 *
 * The state type is structural because `PlannerStore` is not exported; any
 * snapshot carrying `userId` and `isLoading` can be asked. The other fields are
 * optional so every existing caller still type-checks.
 */
type Readiness = {
  userId: string | null;
  isLoading: boolean;
  isPreview?: boolean;
  error?: string | null;
  loadFailedUserId?: string | null;
};

export const selectPlannerSettled = (s: Readiness): boolean => !!s.userId && !s.isLoading;
export const selectPlannerPending = (s: Readiness): boolean => !selectPlannerSettled(s);

/** Mount the views: fresh data OR the look-only preview. DISPLAY gates only — never a write gate. */
export const selectPlannerVisible = (s: Readiness): boolean => selectPlannerSettled(s) || !!s.isPreview;

/**
 * Fresh data actually landed for this account (not a failed load's empty store). The gate for
 * every surface that ACTS: notice actions, proposal accept, deferred-dialog promotion. Not quick
 * capture or a waiting pasted list, which act on settled (above). `error` is written only by the
 * load and cleared by its opening set(), so nothing else can trip this.
 */
export const selectPlannerLoaded = (s: Readiness): boolean =>
  selectPlannerSettled(s) && !s.error && s.loadFailedUserId !== s.userId;

export function usePlannerSettled(): boolean {
  return usePlannerStore(selectPlannerSettled);
}

export function usePlannerVisible(): boolean {
  return usePlannerStore(selectPlannerVisible);
}

export function usePlannerPreviewing(): boolean {
  return usePlannerStore((s) => s.isPreview);
}

export function usePlannerLoaded(): boolean {
  return usePlannerStore(selectPlannerLoaded);
}

/** Non-reactive and defensive: some unit-test mocks of planner-store have no getState. */
export const isPlannerPreviewing = (): boolean => usePlannerStore.getState?.()?.isPreview === true;

/** Non-reactive and defensive, as isPlannerPreviewing. */
export const isPlannerLoaded = (): boolean => {
  const s = usePlannerStore.getState?.();
  return !!s && selectPlannerLoaded(s);
};
