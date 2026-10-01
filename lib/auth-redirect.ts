import { safeNext } from './safe-next';

const CALLBACK = '/auth/callback';
const DESKTOP = '/auth/desktop';

/**
 * The path a sign-in started on /login comes back to — the `redirectTo` /
 * `emailRedirectTo` handed to Supabase, minus the origin.
 *
 * Every login lands on /auth/callback, which exchanges the code on the server
 * and then moves on to `next`. Before, a page's own `?redirect=/goal/x` was
 * used as the target as is: the code then arrived on a signed-out page, the
 * proxy bounced it to /login with the query kept, the browser client exchanged
 * it there — and nothing navigated away, so a signed-in user sat looking at the
 * sign-in form.
 *
 * A `redirect` that is already a callback URL passes through unchanged. That is
 * what /connect sends (app/connect/page.tsx), and wrapping it a second time
 * would make the inner callback run with no code and land on /login?error=auth.
 * Its own `next` is still checked, by the callback route.
 *
 * The desktop app is the exception. Its sign-in finishes in the system browser,
 * which does not hold the app's PKCE verifier, so the code lands on
 * /auth/desktop and is handed back to the app, whose own window runs the
 * callback (app/auth/desktop/route.ts). `redirect` is dropped there: a desktop
 * sign-in always lands on `/`.
 */
export function loginRedirectTarget(
  redirect: string | null | undefined,
  origin: string,
  { desktop = false }: { desktop?: boolean } = {},
): string {
  if (desktop) return DESKTOP;
  if (!redirect) return CALLBACK;
  if (redirect === CALLBACK || redirect.startsWith(`${CALLBACK}?`)) return redirect;
  return `${CALLBACK}?next=${encodeURIComponent(safeNext(redirect, origin))}`;
}

/**
 * What /login says about a sign-in that came back as `?error=`, or null.
 *
 * Only these three values are read. /auth/callback writes `expired` for a code
 * whose flow state lapsed and `auth` for any other failed exchange, and the
 * desktop app maps the provider's error codes onto all three, so no text from
 * the server or the URL ever reaches the page. The page shows it in the
 * desktop app only; a browser keeps its bare form.
 */
export function loginErrorMessage(param: string | null | undefined): string | null {
  switch (param) {
    case 'expired':
      return 'That sign-in took too long and expired. Try again.';
    case 'cancelled':
      return 'Sign-in was cancelled. Try again whenever you’re ready.';
    case 'auth':
      return 'That sign-in didn’t go through. Try again.';
    default:
      return null;
  }
}
