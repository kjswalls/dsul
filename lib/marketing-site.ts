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
 * dsul.app row (lib/settings/manifest.ts).
 *
 * The page is the same for everyone and never sends an account holder on to the
 * app by itself: the session cookies are do.dsul.app's alone, so the apex cannot
 * tell who is signed in. What it has instead is SIGNED_IN_HINT, a bare flag the
 * app's proxy writes for the whole dsul.app domain while a session is live, so
 * the page's "log in" can read "open your planner". See signedInHintOptions.
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

/**
 * The signed-in hint: `dsul_in=1`, a cookie the page reads to say "open your
 * planner" instead of "log in". Kirby's pick, 2026-11-05.
 *
 * A HINT, NEVER AUTH. It holds no user id, no email and no token, only "1", and
 * nothing on a server may branch on it: any page on a dsul.app host can read or
 * write it, and it goes stale (an account deleted from the iPhone app, a session
 * revoked on another device) until the browser's next request to the app. The
 * worst a wrong one does is the label, because the link goes to do.dsul.app
 * either way and that host routes by the real session.
 *
 * Who writes it:
 *   - proxy.ts sets it after getUser() finds a user on a page request that does
 *     not carry it yet, so everyone signed in today gets it on their next page
 *     load and every sign-in path is covered;
 *   - proxy.ts clears it when getUser() finds the session gone (never on a
 *     network failure, which proves nothing), on the way to /login;
 *   - SupabaseProvider clears it in the browser on SIGNED_OUT (clearSignedInHint),
 *     which covers every Sign out button, Delete account and another tab's sign-out.
 * API routes never touch it.
 *
 * Not HttpOnly, because the page reads it with document.cookie.
 */
export const SIGNED_IN_HINT = 'dsul_in';

/** As long as the session cookie it mirrors (@supabase/ssr's default maxAge, 400 days). */
const SIGNED_IN_HINT_MAX_AGE = 400 * 24 * 60 * 60;

/**
 * The Domain the hint is written with from `hostname`: dsul.app on dsul.app and
 * its subdomains, so the apex can read what do.dsul.app wrote. Anywhere else (a
 * *.vercel.app preview, localhost) a browser refuses Domain=dsul.app, so the
 * hint is host-only there, which still lets /welcome on a preview show it.
 */
export function signedInHintDomain(hostname: string): string | undefined {
  return hostname === MARKETING_HOST || hostname.endsWith(`.${MARKETING_HOST}`) ? MARKETING_HOST : undefined;
}

/** The attributes the hint is set with, and cleared with (a clear must match Domain and Path). */
export function signedInHintOptions(url: URL): {
  domain?: string;
  path: string;
  secure: boolean;
  sameSite: 'lax';
  httpOnly: false;
  maxAge: number;
} {
  const domain = signedInHintDomain(url.hostname);
  return {
    ...(domain ? { domain } : {}),
    path: '/',
    secure: url.protocol === 'https:',
    sameSite: 'lax',
    httpOnly: false,
    maxAge: SIGNED_IN_HINT_MAX_AGE,
  };
}

/** The document.cookie assignments that drop the hint on this host, in each scope it can have been written in. */
export function signedInHintClears(url: URL): string[] {
  const { domain, secure } = signedInHintOptions(url);
  const base = `${SIGNED_IN_HINT}=; Path=/; Max-Age=0; SameSite=Lax${secure ? '; Secure' : ''}`;
  return domain ? [`${base}; Domain=${domain}`, base] : [base];
}

/** Drops the hint from the browser. Call it once the session is gone (SupabaseProvider's SIGNED_OUT). */
export function clearSignedInHint(): void {
  if (typeof document === 'undefined') return;
  try {
    for (const c of signedInHintClears(new URL(window.location.href))) document.cookie = c;
  } catch {
    // A cookie write refused by the browser costs only the label.
  }
}
