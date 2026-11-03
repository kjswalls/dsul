/**
 * dsul.app's front door: the marketing page, served by the same deployment as
 * the app at do.dsul.app.
 *
 * The page is ONE static file, public/site/index.html, with its fonts beside it
 * under public/site/. It is deliberately not a route under app/: everything
 * there renders inside the app's root layout, whose SupabaseProvider sends a
 * browser with no session to /login (lib/signed-out-redirect.ts), and whose
 * theme, service worker, manifest and fonts are the app's. A visitor to the
 * apex should load none of that.
 *
 * Three places agree on it, and tests/unit/marketing-site.test.ts holds them
 * together:
 *   - proxy.ts rewrites to MARKETING_PAGE before the sign-in gate, and its
 *     matcher leaves /site/ out, so the page's fonts never meet the gate;
 *   - next.config.mjs keeps the apex's redirect to do.dsul.app for every other
 *     path, and lets through the page, what it fetches, and /api/waitlist;
 *   - the page posts its form to /api/waitlist (app/api/waitlist/route.ts).
 *
 * The URL never changes on a rewrite, so the page links its own files by
 * absolute path (/site/fonts/…).
 *
 * The app links back to it in two places, both by MARKETING_URL: the help
 * menu's "What's new" (components/shell/help-menu.tsx) and Settings › dsul's
 * dsul.app row (lib/settings/manifest.ts). Nothing on the apex can tell who is
 * signed in (the session cookies are do.dsul.app's alone), so it shows the page
 * to everyone and never sends an account holder on to the app by itself; its
 * "log in" opens the planner in one click for someone already in.
 */

/** The apex. Only the root is the page; every other path on it still goes to the app (next.config.mjs). */
export const MARKETING_HOST = 'dsul.app';

/** Where the page lives on disk under public/, and the path it is rewritten to. */
export const MARKETING_PAGE = '/site/index.html';

/**
 * The page on ANY host, so a pull request's preview deployment (a *.vercel.app
 * address that is not the apex) can show it before it goes live. It is the
 * same public page on do.dsul.app, which holds nothing of anyone's.
 */
export const MARKETING_PREVIEW_PATH = '/welcome';

/**
 * The page's address, for a link to it from inside the app. Always this
 * absolute URL, never MARKETING_PREVIEW_PATH: in the desktop shell a link on
 * the app's own host loads inside the window and takes the planner's place,
 * and a new-window one does nothing, while dsul.app opens in the browser
 * (electron/lib/policy.cjs isAppUrl, main.cjs setWindowOpenHandler). From a
 * preview deployment it opens production's page, which is the one people see.
 */
export const MARKETING_URL = `https://${MARKETING_HOST}`;

/** The page's dated changelog, which the help menu's "What's new" opens. */
export const MARKETING_CHANGELOG_URL = `${MARKETING_URL}/#changelog`;

/** The path to serve in place of this request's, or null to leave it alone. */
export function marketingRewrite(url: URL): string | null {
  if (url.pathname === '/' && url.hostname === MARKETING_HOST) return MARKETING_PAGE;
  if (url.pathname === MARKETING_PREVIEW_PATH) return MARKETING_PAGE;
  return null;
}
