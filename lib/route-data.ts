/**
 * Which routes need the seven-table item load, and which only need to know who
 * is signed in.
 *
 * `initializeStore` fetches items, projects, item types, routines, programs and
 * goals in one `Promise.all`, then takes two full deep clones of the result
 * (`JSON.parse(JSON.stringify(...))` for the undo baseline and a
 * `JSON.stringify` for the change detector). On the planner that is the page.
 * On `/settings` it is six requests and two main-thread passes over every row
 * the account owns, spent on a surface that renders none of them — every
 * `planner()` read in lib/settings/manifest.ts is a settings FIELD.
 *
 * THE LIST IS AN OPT-OUT, AND THAT DIRECTION IS THE WHOLE SAFETY PROPERTY.
 * A route not named here loads, which is what every route did before this
 * existed. So the cost of forgetting to add a new lean route is that it stays
 * as fast as it is today; the cost of the inverse design — an opt-IN list of
 * routes that load — is a new planner surface silently rendering an empty store
 * as though the account owned nothing. One of those is a missed optimisation
 * and the other is a data-loss-shaped bug, so the default is "load".
 *
 * `tests/unit/route-data.test.ts` reads every page under `app/` and fails if
 * one named here actually reads item data, which is the half a human reviewer
 * cannot hold in their head as the app grows.
 */

/**
 * Routes that render no item, container or goal.
 *
 * Each entry matches the path exactly or as a path PREFIX (`/settings` covers
 * `/settings/look` and `/settings/extensions/beemindr`). Prefix matching is on
 * segment boundaries, so a future `/settings-import` route would not be
 * silently swept in by the `/settings` entry.
 */
export const LEAN_ROUTES = [
  // Reads `userId` for the hydration gate and nothing else on planner-store.
  '/settings',
  // Reads `userId` to scope its own stake_events query; owns no planner data.
  '/ledger',
  // Device-pairing flow — talks to /api/agent/connect, not to the store.
  '/connect',
  '/docs',
  '/login',
  '/auth',
] as const;

export function routeNeedsItems(pathname: string | null | undefined): boolean {
  // A null pathname is "we do not know yet", and the fail-safe answer to that
  // is the one every route gave before this function existed.
  if (!pathname) return true;
  return !LEAN_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`)
  );
}
