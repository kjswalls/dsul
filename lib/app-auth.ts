import { NextResponse } from 'next/server';
import {
  createClient,
  isAuthApiError,
  isAuthSessionMissingError,
  type SupabaseClient,
} from '@supabase/supabase-js';

/**
 * Who is calling /api/app/*: the iPhone app, signed in with its own Supabase
 * session (memory/plans/ios-app.md).
 *
 * THE CREDENTIAL IS A SUPABASE ACCESS TOKEN, AS A BEARER, AND NOTHING ELSE.
 * - Cookies are never read. A cookie fallback (the one /api/agent/context has)
 *   would make every POST here forgeable from any page a signed-in browser
 *   visits, and nothing here sends CORS headers either.
 * - A `dsul_` agent key is refused. It is one plaintext key shared with the
 *   OpenClaw plugin, it never expires, and the agent routes it opens run as the
 *   service role. It fails the shape check below by itself: it has no dots.
 *
 * EVERY STATEMENT RUNS AS THE USER. The client this returns is the anon key
 * plus the caller's JWT, so RLS is the tenant guard on every read and write a
 * route makes with it, the same model /api/reminders/act uses with its cookie
 * client. The service role appears in two places only: where a route reports a
 * completion to a stake (reportLiveCompletion), which scopes by user_id itself,
 * and in the account routes (lib/account-server), which build the service
 * client only after the caller and the body are verified and act only on the
 * verified caller's own id (memory/plans/account-deletion.md).
 *
 * TWO CHECKS, CHEAP FIRST. The token is decoded locally and refused if it is
 * not a live `authenticated` token for a uuid subject, so junk and expired
 * tokens never cost a round trip to Auth. That also guarantees the client
 * below can never run as `service_role`. Then `getUser(jwt)` asks Auth itself,
 * which is the check that catches a session signed out since the token was
 * minted (the local decode cannot; neither can getClaims).
 *
 * AN AUTH OUTAGE IS A 503, NEVER A 401. auth-js turns a network error or a
 * 502-504 into `{ user: null }` just as it does a bad token, and the phone
 * answers a 401 by refreshing and retrying. Mapping a GoTrue blip to 401 would
 * turn it into a refresh storm against prod Auth from every signed-in phone.
 *
 * A DELETED ACCOUNT IS "GONE", AND ONLY THE ACCOUNT ROUTES SAY SO. A deleted
 * user's access token stays well formed until it expires, and GoTrue answers it
 * with `user_not_found` only after the signature checks out, so that answer
 * proves the token's own `sub` was an account that no longer exists.
 * `authenticateAppCaller` hands it back as `{ gone: true, userId }`, and the
 * account routes use it: a delete retried after its answer was lost is 200
 * (nothing left to delete), and a facts read is 410, so the phone can say the
 * account is deleted rather than that it was signed out
 * (memory/plans/account-deletion.md). Every other route goes through
 * `authenticateAppRequest`, where gone is a 401 like any refused token.
 */

export interface AppAuth {
  userId: string;
  client: SupabaseClient;
}

/** `userId` on gone is the token's `sub` (precheckToken's), from the token GoTrue just checked. */
export type AppCaller = AppAuth | { gone: true; userId: string };

/** A body never carries server text: `error` is one of a few fixed words. */
export const unauthorized = () => NextResponse.json({ error: 'unauthorized' }, { status: 401 });

export const unavailable = () =>
  NextResponse.json({ error: 'unavailable' }, { status: 503, headers: { 'Retry-After': '5' } });

/** Longer than any token GoTrue mints; a cap so the decode below stays cheap. */
const MAX_TOKEN_LENGTH = 4096;
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The claims a token must carry to be worth asking Auth about, or null.
 * Decoded, not verified: the signature is GoTrue's to check, in getUser.
 */
export function precheckToken(token: string, nowSeconds: number): { sub: string } | null {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const segments = token.split('.');
  if (segments.length !== 3 || !segments.every((s) => BASE64URL_SEGMENT.test(s))) return null;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) return null;
  const { role, exp, sub } = claims as { role?: unknown; exp?: unknown; sub?: unknown };
  if (role !== 'authenticated') return null;
  if (typeof exp !== 'number' || !(exp > nowSeconds)) return null;
  if (typeof sub !== 'string' || !UUID.test(sub)) return null;
  return { sub };
}

/** The bearer token, or null when the header is anything but `Bearer <token>`. */
function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match ? match[1] : null;
}

/**
 * The caller's user id and a client that runs as them, or the Response to
 * send instead (401, or 503 when Auth could not be asked).
 */
export async function authenticateAppRequest(req: Request): Promise<AppAuth | Response> {
  const caller = await authenticateAppCaller(req);
  if (caller instanceof Response) return caller;
  return 'gone' in caller ? unauthorized() : caller;
}

/** authenticateAppRequest's checks, with GoTrue's user_not_found (after a good signature) as gone. */
export async function authenticateAppCaller(req: Request): Promise<AppCaller | Response> {
  const jwt = bearerToken(req);
  if (!jwt) return unauthorized();
  const claims = precheckToken(jwt, Date.now() / 1000);
  if (!claims) return unauthorized();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    console.error('[app-auth] NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is not set');
    return unavailable();
  }

  const client = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  try {
    const { data, error } = await client.auth.getUser(jwt);
    const user = data?.user ?? null;
    if (user && !error) {
      // Auth vouches for the token's own subject or for nobody: a mismatch is
      // a token this route does not understand, not a different caller.
      return user.id === claims.sub ? { userId: user.id, client } : unauthorized();
    }
    // GoTrue loads the user only once the signature checks out, so this is
    // the token's own subject, deleted (the header's "gone").
    if (isAuthApiError(error) && error.code === 'user_not_found') return { gone: true, userId: claims.sub };
    // A session signed out since the token was minted (session_not_found
    // arrives as AuthSessionMissingError), or GoTrue refusing the token
    // outright. Everything else (no response, a 5xx, a 429) is Auth being
    // unreachable, which says nothing about the token.
    if (isAuthSessionMissingError(error)) return unauthorized();
    if (isAuthApiError(error) && (error.status === 401 || error.status === 403)) return unauthorized();
    if (error) console.warn('[app-auth] getUser failed:', error.name, error.status ?? '');
    return unavailable();
  } catch (err) {
    console.warn('[app-auth] getUser threw:', err instanceof Error ? err.name : typeof err);
    return unavailable();
  }
}

/**
 * The Response for a failed database call made with the user's client.
 *
 * PGRST301 (a JWT PostgREST rejects) and PGRST303 (one that expired between
 * the check above and the statement) are the token's fault and answer 401, so
 * the phone refreshes. Anything else is logged and answers a bare 500: a
 * Postgres message can carry row data (`Key (id)=…`), so it never reaches the
 * body.
 */
export function dbErrorResponse(err: unknown, where: string): Response {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code)
      : undefined;
  if (code === 'PGRST301' || code === 'PGRST303') return unauthorized();
  console.error(`[${where}] database call failed:`, code ?? '', err instanceof Error ? err.message : err);
  return NextResponse.json({ error: 'failed' }, { status: 500 });
}
