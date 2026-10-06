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
 * also distrust a failed load's empty store adds `&& !s.error` itself, as the
 * braindump's count does.
 *
 * On a LEAN route (lib/route-data.ts) identifyUser stamps the account and
 * leaves `isLoading: true` with no load to clear it. Anything gated on this
 * stays pending there forever — so never mount a gated surface on a lean
 * route.
 *
 * The state type is structural because `PlannerStore` is not exported; any
 * snapshot carrying the two fields can be asked.
 */
type Readiness = { userId: string | null; isLoading: boolean };

export const selectPlannerSettled = (s: Readiness): boolean => !!s.userId && !s.isLoading;
export const selectPlannerPending = (s: Readiness): boolean => !selectPlannerSettled(s);

export function usePlannerSettled(): boolean {
  return usePlannerStore(selectPlannerSettled);
}
