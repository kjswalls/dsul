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

/** The path to serve in place of this request's, or null to leave it alone. */
export function marketingRewrite(url: URL): string | null {
  if (url.pathname === '/' && url.hostname === MARKETING_HOST) return MARKETING_PAGE;
  if (url.pathname === MARKETING_PREVIEW_PATH) return MARKETING_PAGE;
  return null;
}
