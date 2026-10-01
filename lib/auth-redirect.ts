import { safeNext } from './safe-next';

const CALLBACK = '/auth/callback';

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
 */
export function loginRedirectTarget(redirect: string | null | undefined, origin: string): string {
  if (!redirect) return CALLBACK;
  if (redirect === CALLBACK || redirect.startsWith(`${CALLBACK}?`)) return redirect;
  return `${CALLBACK}?next=${encodeURIComponent(safeNext(redirect, origin))}`;
}
