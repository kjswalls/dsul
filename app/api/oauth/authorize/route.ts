import { NextResponse, type NextRequest } from 'next/server';
import { NO_STORE, isSameOrigin, readJson, requireSession } from '@/app/api/ai/_shared/guard';
import { redirectUriMatches, redirectWith } from '@/lib/mcp-oauth/core';
import { isScope } from '@/lib/mcp-oauth/scopes';
import { getClient, issueCode } from '@/lib/mcp-oauth/store';
import { createServiceClient } from '@/lib/supabase-service';

/**
 * The consent page's two calls (app/oauth/authorize/page.tsx), both behind the
 * signed-in session. memory/plans/mcp-oauth.md.
 *
 * GET  ?client_id&redirect_uri — who is asking, and where the answer goes, so
 *      the page can say "Claude wants to…". A redirect URI the app never
 *      registered is answered here, and the page shows it instead of sending
 *      the browser anywhere: an open redirect is the first thing an attacker
 *      tries on an authorize endpoint.
 * POST { …the request, approve, scope } — yes or no. Yes mints a one-time
 *      code; either way the answer is the URL to send the browser to.
 */
export async function GET(req: NextRequest) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  const p = req.nextUrl.searchParams;
  const client = await getClient(createServiceClient(), p.get('client_id') ?? '');
  if (!client) return NextResponse.json({ error: 'unknown_client' }, { status: 404, headers: NO_STORE });
  if (!redirectUriMatches(p.get('redirect_uri') ?? '', client.redirectUris)) {
    return NextResponse.json({ error: 'bad_redirect' }, { status: 400, headers: NO_STORE });
  }
  return NextResponse.json(
    { name: client.clientName, returnsTo: new URL(p.get('redirect_uri')!).host || new URL(p.get('redirect_uri')!).protocol },
    { headers: NO_STORE }
  );
}

interface Decision {
  client_id?: unknown;
  redirect_uri?: unknown;
  code_challenge?: unknown;
  code_challenge_method?: unknown;
  scope?: unknown;
  state?: unknown;
  resource?: unknown;
  approve?: unknown;
}

const str = (v: unknown, max = 2000) => (typeof v === 'string' && v.length <= max ? v : undefined);

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE });
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  const read = await readJson<Decision>(req, 16_000);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: read.status, headers: NO_STORE });
  const b = read.body ?? {};

  const db = createServiceClient();
  const client = await getClient(db, str(b.client_id, 200) ?? '');
  const redirectUri = str(b.redirect_uri);
  if (!client || !redirectUri || !redirectUriMatches(redirectUri, client.redirectUris)) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400, headers: NO_STORE });
  }
  const state = str(b.state, 1000);

  // From here every answer goes back to the app, as the spec says it must.
  if (b.approve !== true) {
    return NextResponse.json({ redirect: redirectWith(redirectUri, { error: 'access_denied', state }) }, { headers: NO_STORE });
  }
  const challenge = str(b.code_challenge, 200);
  if (!challenge || b.code_challenge_method !== 'S256' || !/^[A-Za-z0-9\-_]{43}$/.test(challenge)) {
    return NextResponse.json(
      { redirect: redirectWith(redirectUri, { error: 'invalid_request', error_description: 'PKCE S256 is required', state }) },
      { headers: NO_STORE }
    );
  }
  const scope = isScope(b.scope) ? b.scope : 'planner';
  const code = await issueCode(db, {
    userId: session.user.id,
    clientId: client.clientId,
    redirectUri,
    codeChallenge: challenge,
    scope,
    resource: str(b.resource),
  });
  if (!code) return NextResponse.json({ error: 'unavailable' }, { status: 503, headers: NO_STORE });
  return NextResponse.json({ redirect: redirectWith(redirectUri, { code, state }) }, { headers: NO_STORE });
}
