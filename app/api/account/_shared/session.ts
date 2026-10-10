import { isAuthApiError, isAuthSessionMissingError } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase-server';
import { precheckToken } from '@/lib/app-auth';
import { accountError } from '@/lib/account-server/http';

/**
 * Who is calling the web's account routes: the cookie session, checked with
 * the auth server, the way requireSession does (app/api/ai/_shared/guard.ts).
 * Lives under app/api because `.auth.getUser(` is banned in lib/
 * (tests/unit/no-mount-getuser.test.ts); a `_` folder is not routed.
 *
 * Its twin is lib/app-auth.ts's authenticateAppCaller, for the phone's bearer,
 * and it answers the same three ways: the user, "gone", or the response to
 * send. GONE is GoTrue's `user_not_found`, which it sends only after the
 * session's access token checked out, so the deleted account is that token's
 * own `sub`: a delete retried after its answer was lost is 200, and a dialog
 * reopened afterwards reads 410 and says the account is deleted
 * (memory/plans/account-deletion.md).
 *
 * A signed-out session or a token GoTrue refuses is 401; anything else (no
 * answer, a 5xx, a throw) is Auth being unreachable, 503, never 401.
 */
export async function accountSession(): Promise<{ userId: string } | { gone: true; userId: string } | Response> {
  try {
    const db = await createClient();
    const { data, error } = await db.auth.getUser();
    const user = data?.user ?? null;
    if (user && !error) return { userId: user.id };

    if (isAuthApiError(error) && error.code === 'user_not_found') {
      // The token GoTrue just checked is the session's; its subject is the
      // account that no longer exists.
      const { data: current } = await db.auth.getSession();
      const token = current?.session?.access_token;
      const claims = token ? precheckToken(token, Date.now() / 1000) : null;
      return claims ? { gone: true, userId: claims.sub } : accountError(401, 'unauthorized');
    }
    if (isAuthSessionMissingError(error)) return accountError(401, 'unauthorized');
    if (isAuthApiError(error) && [400, 401, 403].includes(error.status)) {
      return accountError(401, 'unauthorized');
    }
    if (!error) return accountError(401, 'unauthorized');
    console.warn('[account] getUser failed', error.name, error.status ?? '');
    return accountError(503, 'unavailable');
  } catch (err) {
    console.warn('[account] getUser threw', err instanceof Error ? err.name : typeof err);
    return accountError(503, 'unavailable');
  }
}
