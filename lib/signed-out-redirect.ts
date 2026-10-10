import { safeNext } from './safe-next';

/**
 * Where a client-side SIGNED_OUT goes when nothing else navigates.
 *
 * The sign-out buttons push /login themselves, but a session can also end
 * underneath the page: a revoked refresh token ("sign out everywhere" on
 * another device, a password change) makes supabase-js emit SIGNED_OUT on
 * whatever route is open. proxy.ts only redirects on a SERVER request, so the
 * page stayed put with `userId: null` — and since lib/planner-ready.ts counts
 * "no account" as pending, the canvas and braindump sat on PlannerSkeleton's
 * "Loading your day…" for good, with nothing saying the user was signed out.
 *
 * A HARD replace, not router.push: it also drops every module-singleton store
 * the provider does not reset by name. On /login and /auth/* it does nothing —
 * those are where a signed-out browser belongs (the same exemptions proxy.ts
 * makes; proxy.ts reads this predicate, so the two cannot drift).
 */
export function isSignedOutPath(pathname: string): boolean {
  // /.well-known/ holds the OAuth metadata an MCP client reads before it has
  // any session (lib/mcp-oauth/core.ts); a redirect to /login there ends its sign-in.
  return pathname === '/login' || pathname.startsWith('/auth') || pathname.startsWith('/.well-known/');
}

/**
 * /login, carrying where the visitor was going as `?redirect=`.
 *
 * The login page hands that to lib/auth-redirect.ts, which sends the sign-in
 * back through /auth/callback and on to it, so a signed-out /connect?code=…
 * (the OpenClaw pairing link) or a bookmarked /goal/<id> ends up where it was
 * going instead of on '/'. Both bounces build it here: proxy.ts for a server
 * request, and leaveForLoginIfNoSession below for a page the server let through.
 *
 * The root is not worth carrying, and nor is anything safeNext will not vouch
 * for: both are bare /login. `_rsc` is Next's cache-buster on a client
 * navigation's fetch, never part of a page's address (Next's adapter normally
 * strips it before proxy.ts sees the request; this does not rely on that).
 *
 * The HASH is never carried. A Supabase implicit-flow link (an invite or a
 * recovery email sent from the dashboard) can leave `#access_token=…&
 * refresh_token=…` on a page whose PKCE client refuses to read it, and copying
 * that into a query string would hand live tokens to every log the URL passes
 * through. Losing an anchor like /settings#keys is the price.
 *
 * The destination travels encoded inside ONE parameter, so a carried `code`
 * never surfaces as a top-level one, which the desktop shell's navigation guard
 * would read as an auth code and drop (electron/lib/policy.cjs carriesAuthCode).
 */
export function loginPathFor(pathAndQuery: string, origin: string): string {
  let url: URL;
  try {
    url = new URL(pathAndQuery, origin);
  } catch {
    return '/login';
  }
  if (url.origin !== origin) return '/login';
  // Only when present: deleting re-serialises the whole query.
  if (url.searchParams.has('_rsc')) url.searchParams.delete('_rsc');
  const back = safeNext(`${url.pathname}${url.search}`, origin);
  return back === '/' ? '/login' : `/login?redirect=${encodeURIComponent(back)}`;
}

/** Indirected through an object so a test can spy on it (jsdom's location cannot be). */
export const signedOutNav = {
  replace: (url: string) => window.location.replace(url),
};

export function leaveForLoginIfSignedOutPage(): void {
  if (typeof window === 'undefined') return;
  if (isSignedOutPath(window.location.pathname)) return;
  signedOutNav.replace('/login');
}

/** Exported for the tests, which play the previous page load by writing it. */
export const NO_SESSION_BOUNCE_KEY = 'dsul-no-session-bounce';
const NO_SESSION_BOUNCE_WINDOW_MS = 15_000;

/**
 * This page load's own mark in that stamp. React's dev double mount resolves
 * the provider's getSession twice in one document, and a stamp THIS document
 * wrote is that, not a loop: the first call's replace is already under way, so
 * the second does nothing and says nothing.
 */
const THIS_PAGE_LOAD = Math.random().toString(36).slice(2);

type Bounce = { at: number; page: string };

function forgetBounce(): void {
  try {
    window.sessionStorage.removeItem(NO_SESSION_BOUNCE_KEY);
  } catch {
    // Nothing to forget in storage that refuses.
  }
}

/**
 * Whether this document came in through a server redirect. The loop's page
 * always does: proxy.ts 307s /login straight back to '/', and the browser
 * counts that same-origin hop. A typed URL, a bookmark, a notification click
 * or the desktop shell's offline retry arrives with none, and is a fresh visit
 * however recent the stamp. A browser with no navigation entry to ask counts
 * as a redirect, so the guard holds where it cannot tell.
 */
function arrivedByRedirect(): boolean {
  try {
    const nav = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    return nav ? nav.redirectCount > 0 : true;
  } catch {
    return true;
  }
}

function lastBounce(): Bounce | null {
  try {
    const raw = window.sessionStorage.getItem(NO_SESSION_BOUNCE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Bounce> | null;
    return typeof parsed?.at === 'number' && typeof parsed.page === 'string'
      ? { at: parsed.at, page: parsed.page }
      : null;
  } catch {
    return null;
  }
}

/**
 * The boot-time twin of the above, for a page that never had a session.
 *
 * supabase-js says SIGNED_OUT only when a session it held ends. With nothing
 * stored at all (the desktop app's first launch, a cleared cookie jar) it says
 * INITIAL_SESSION with no session and nothing after it, so the SIGNED_OUT path
 * above never runs, and '/' sat on "Loading your day…" for good. proxy.ts
 * should have sent that request to /login before the page existed. This is for
 * whenever it did not: its gate switched off, or its fail-open catch.
 *
 * It reads no env flag of its own, and that is deliberate. Next inlines
 * NEXT_PUBLIC_* into the browser bundle, so a NEXT_PUBLIC_DISABLE_AUTH that
 * switched the server gate off would switch this off with it, in exactly the
 * case it exists for.
 *
 * Unlike a sign-out it keeps the place (loginPathFor): this visitor was going
 * somewhere.
 *
 * THE LOOP GUARD. If the server sees a user the browser client cannot (a
 * cookie page JS cannot read), proxy.ts sends /login straight back to '/', this
 * sends '/' back to /login, and the tab reloads forever. So a bounce stamps
 * sessionStorage, and a page load that finds a fresh stamp (under ~15s) from
 * another page load AND came in through a server redirect stays put and says
 * why in the console. The stamp alone cannot tell the loop from a bounce that
 * worked and an ordinary load after it: the desktop shell's offline page
 * retrying '/' after a failed /login load, or a visitor opening a bookmark
 * right after landing on /login, would sit on the skeleton for 15s, with no
 * Reload in a packaged app. The redirect is what tells them apart. And /login
 * rendering at all proves the bounce landed (in the loop it never does), so it
 * clears the stamp.
 *
 * Storage that refuses still gets the bounce, unguarded: a visitor who never
 * had a session leaving for /login is the fix, and the loop needs a cookie
 * nothing in this app sets.
 */
export function leaveForLoginIfNoSession(): void {
  if (typeof window === 'undefined') return;
  const { pathname, search, origin } = window.location;
  if (isSignedOutPath(pathname)) {
    forgetBounce();
    return;
  }

  const now = Date.now();
  const last = lastBounce();
  if (last && now >= last.at && now - last.at < NO_SESSION_BOUNCE_WINDOW_MS) {
    if (last.page === THIS_PAGE_LOAD) return;
    if (arrivedByRedirect()) {
      console.warn(
        '[auth] No session on this page, but this tab was sent to /login moments ago and came ' +
          'straight back. Staying put rather than reloading in a loop: the server and the ' +
          'browser disagree about whether anyone is signed in.'
      );
      return;
    }
  }

  try {
    window.sessionStorage.setItem(
      NO_SESSION_BOUNCE_KEY,
      JSON.stringify({ at: now, page: THIS_PAGE_LOAD } satisfies Bounce)
    );
  } catch {
    // Private mode or blocked site data: leave anyway, unguarded (see above).
  }
  signedOutNav.replace(loginPathFor(`${pathname}${search}`, origin));
}
