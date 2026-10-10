/**
 * The writes behind signing in to /api/mcp with OAuth (memory/plans/mcp-oauth.md):
 * registered apps, one-time codes, grants and tokens, in migration 069's
 * service-role-only tables. Server-only; imported from app/api/** and
 * lib/supabase-service.ts.
 *
 * Claim, then act, as everywhere else that a request may arrive twice: a code
 * and a refresh token are each spent with a conditional update that only
 * succeeds once, so two racing redemptions never both get tokens.
 *
 * A missing table (069 not applied yet) reads as "no such token" and "could not
 * save", never a throw: /api/mcp keeps answering the OpenClaw key either way.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ACCESS_PREFIX,
  ACCESS_TTL_S,
  CLIENT_PREFIX,
  CODE_TTL_S,
  REFRESH_PREFIX,
  REFRESH_TTL_S,
  hashSecret,
  mint,
  pkceMatches,
  type ClientRegistration,
} from './core';
import { isScope, type Scope } from './scopes';

type Db = SupabaseClient;

const inSeconds = (s: number, now: Date) => new Date(now.getTime() + s * 1000).toISOString();

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

export async function registerClient(db: Db, reg: ClientRegistration): Promise<OAuthClient | null> {
  const clientId = mint(CLIENT_PREFIX);
  const { error } = await db
    .from('mcp_oauth_clients')
    .insert({ client_id: clientId, client_name: reg.client_name, redirect_uris: reg.redirect_uris });
  if (error) return null;
  return { clientId, clientName: reg.client_name, redirectUris: reg.redirect_uris };
}

export async function getClient(db: Db, clientId: string): Promise<OAuthClient | null> {
  if (!clientId.startsWith(CLIENT_PREFIX) || clientId.length > 200) return null;
  const { data, error } = await db
    .from('mcp_oauth_clients')
    .select('client_id, client_name, redirect_uris')
    .eq('client_id', clientId)
    .maybeSingle();
  if (error || !data) return null;
  return { clientId: data.client_id, clientName: data.client_name, redirectUris: data.redirect_uris ?? [] };
}

export interface CodeRequest {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: Scope;
  resource?: string;
}

/**
 * The user said yes: one live grant per (user, app), its scope set to what they
 * chose this time, and a ten-minute code for the app to trade.
 */
export async function issueCode(db: Db, req: CodeRequest, now = new Date()): Promise<string | null> {
  const live = await db
    .from('mcp_oauth_grants')
    .select('id')
    .eq('user_id', req.userId)
    .eq('client_id', req.clientId)
    .is('revoked_at', null)
    .maybeSingle();
  if (live.error) return null;
  let grantId = live.data?.id as string | undefined;
  if (grantId) {
    const { error } = await db.from('mcp_oauth_grants').update({ scope: req.scope }).eq('id', grantId);
    if (error) return null;
  } else {
    const { data, error } = await db
      .from('mcp_oauth_grants')
      .insert({ user_id: req.userId, client_id: req.clientId, scope: req.scope })
      .select('id')
      .single();
    if (error || !data) return null;
    grantId = data.id as string;
  }

  const code = mint('dsul_code_');
  const { error } = await db.from('mcp_oauth_codes').insert({
    code_hash: await hashSecret(code),
    user_id: req.userId,
    client_id: req.clientId,
    grant_id: grantId,
    redirect_uri: req.redirectUri,
    code_challenge: req.codeChallenge,
    scope: req.scope,
    resource: req.resource ?? null,
    expires_at: inSeconds(CODE_TTL_S, now),
  });
  return error ? null : code;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: Scope;
}

/** RFC 6749 §5.2's error codes, which is what the token route answers with. */
export type TokenError = 'invalid_grant' | 'invalid_client' | 'invalid_request' | 'server_error';

async function issueTokens(
  db: Db,
  grant: { id: string; userId: string; scope: Scope },
  now: Date
): Promise<TokenPair | null> {
  const access = mint(ACCESS_PREFIX);
  const refresh = mint(REFRESH_PREFIX);
  const { error } = await db.from('mcp_oauth_tokens').insert([
    {
      token_hash: await hashSecret(access),
      user_id: grant.userId,
      grant_id: grant.id,
      kind: 'access',
      scope: grant.scope,
      expires_at: inSeconds(ACCESS_TTL_S, now),
    },
    {
      token_hash: await hashSecret(refresh),
      user_id: grant.userId,
      grant_id: grant.id,
      kind: 'refresh',
      scope: grant.scope,
      expires_at: inSeconds(REFRESH_TTL_S, now),
    },
  ]);
  if (error) return null;
  return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: ACCESS_TTL_S, scope: grant.scope };
}

async function liveGrant(db: Db, grantId: string, clientId: string) {
  const { data } = await db
    .from('mcp_oauth_grants')
    .select('id, user_id, client_id, scope, revoked_at')
    .eq('id', grantId)
    .maybeSingle();
  if (!data || data.revoked_at || data.client_id !== clientId || !isScope(data.scope)) return null;
  return { id: data.id as string, userId: data.user_id as string, scope: data.scope as Scope };
}

export async function redeemCode(
  db: Db,
  args: { code: string; clientId: string; redirectUri: string; verifier: string },
  now = new Date()
): Promise<TokenPair | TokenError> {
  // Spent first, checked after: a second redemption of the same code, honest or
  // not, finds it used and gets nothing.
  const { data, error } = await db
    .from('mcp_oauth_codes')
    .update({ used_at: now.toISOString() })
    .eq('code_hash', await hashSecret(args.code))
    .is('used_at', null)
    .gt('expires_at', now.toISOString())
    .select('user_id, client_id, grant_id, redirect_uri, code_challenge')
    .maybeSingle();
  if (error) return 'server_error';
  if (!data) {
    // A code that exists but was already spent is a replay (RFC 6749 §4.1.2):
    // whoever has it, the tokens it bought are no longer to be trusted.
    const spent = await db
      .from('mcp_oauth_codes')
      .select('grant_id, used_at')
      .eq('code_hash', await hashSecret(args.code))
      .maybeSingle();
    if (spent.data?.used_at) await revokeGrantById(db, spent.data.grant_id, now);
    return 'invalid_grant';
  }
  if (data.client_id !== args.clientId) return 'invalid_grant';
  // Exact, as RFC 6749 §4.1.3 asks: the loopback port leeway is for authorize.
  if (args.redirectUri !== data.redirect_uri) return 'invalid_grant';
  if (!(await pkceMatches(args.verifier, data.code_challenge))) return 'invalid_grant';

  const grant = await liveGrant(db, data.grant_id, args.clientId);
  if (!grant) return 'invalid_grant';
  return (await issueTokens(db, grant, now)) ?? 'server_error';
}

/** Rotates: the refresh token is spent, and a new pair replaces it. */
export async function refresh(
  db: Db,
  args: { refreshToken: string; clientId: string },
  now = new Date()
): Promise<TokenPair | TokenError> {
  if (!args.refreshToken.startsWith(REFRESH_PREFIX)) return 'invalid_grant';
  const { data, error } = await db
    .from('mcp_oauth_tokens')
    .update({ revoked_at: now.toISOString() })
    .eq('token_hash', await hashSecret(args.refreshToken))
    .eq('kind', 'refresh')
    .is('revoked_at', null)
    .gt('expires_at', now.toISOString())
    .select('grant_id')
    .maybeSingle();
  if (error) return 'server_error';
  if (!data) {
    // A refresh token that was already rotated away coming back means two
    // holders: the app and someone who copied it. Disconnect the grant, so
    // neither chain goes on (OAuth 2.1 §4.3.1 reuse detection).
    const spent = await db
      .from('mcp_oauth_tokens')
      .select('grant_id, revoked_at')
      .eq('token_hash', await hashSecret(args.refreshToken))
      .eq('kind', 'refresh')
      .maybeSingle();
    if (spent.data?.revoked_at) await revokeGrantById(db, spent.data.grant_id, now);
    return 'invalid_grant';
  }
  const grant = await liveGrant(db, data.grant_id, args.clientId);
  if (!grant) return 'invalid_grant';
  return (await issueTokens(db, grant, now)) ?? 'server_error';
}

export interface Caller {
  userId: string;
  scope: Scope;
  grantId: string;
}

/** Who an access token speaks for, or null: unknown, expired, revoked, or its app disconnected. */
export async function resolveAccessToken(db: Db, token: string, now = new Date()): Promise<Caller | null> {
  if (!token.startsWith(ACCESS_PREFIX)) return null;
  const { data, error } = await db
    .from('mcp_oauth_tokens')
    .select('user_id, grant_id, scope, expires_at, revoked_at, mcp_oauth_grants!inner(revoked_at, last_used_at)')
    .eq('token_hash', await hashSecret(token))
    .eq('kind', 'access')
    .maybeSingle();
  if (error || !data || data.revoked_at || !isScope(data.scope)) return null;
  if (new Date(data.expires_at).getTime() <= now.getTime()) return null;
  const grant = (Array.isArray(data.mcp_oauth_grants) ? data.mcp_oauth_grants[0] : data.mcp_oauth_grants) as
    | { revoked_at: string | null; last_used_at: string | null }
    | undefined;
  if (!grant || grant.revoked_at) return null;

  // "Last used" for Settings, written at most every ten minutes.
  const last = grant.last_used_at ? new Date(grant.last_used_at).getTime() : 0;
  if (now.getTime() - last > 10 * 60 * 1000) {
    void db.from('mcp_oauth_grants').update({ last_used_at: now.toISOString() }).eq('id', data.grant_id).then(
      () => {},
      () => {}
    );
  }
  return { userId: data.user_id, scope: data.scope, grantId: data.grant_id };
}

/**
 * RFC 7009. Revoking either token disconnects the app's whole grant: the
 * client is saying it is done, and a refresh token left behind would undo that.
 * Unknown tokens are not an error (the spec answers 200 either way).
 */
export async function revokeToken(db: Db, token: string, now = new Date()): Promise<void> {
  const { data } = await db
    .from('mcp_oauth_tokens')
    .select('grant_id')
    .eq('token_hash', await hashSecret(token))
    .maybeSingle();
  if (!data) return;
  await revokeGrantById(db, data.grant_id, now);
}

async function revokeGrantById(db: Db, grantId: string, now: Date): Promise<boolean> {
  const at = now.toISOString();
  const g = await db.from('mcp_oauth_grants').update({ revoked_at: at }).eq('id', grantId).is('revoked_at', null);
  const t = await db.from('mcp_oauth_tokens').update({ revoked_at: at }).eq('grant_id', grantId).is('revoked_at', null);
  return !g.error && !t.error;
}

export interface ConnectedApp {
  id: string;
  name: string;
  scope: Scope;
  connectedAt: string;
  lastUsedAt: string | null;
}

/** Settings' list: the user's live grants, newest first. */
export async function listGrants(db: Db, userId: string): Promise<ConnectedApp[] | null> {
  const { data, error } = await db
    .from('mcp_oauth_grants')
    .select('id, scope, created_at, last_used_at, mcp_oauth_clients!inner(client_name)')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false });
  if (error) return null;
  return (data ?? []).flatMap((row) => {
    if (!isScope(row.scope)) return [];
    const client = (Array.isArray(row.mcp_oauth_clients) ? row.mcp_oauth_clients[0] : row.mcp_oauth_clients) as
      | { client_name: string }
      | undefined;
    return [
      {
        id: row.id as string,
        name: client?.client_name ?? 'An app',
        scope: row.scope,
        connectedAt: row.created_at as string,
        lastUsedAt: (row.last_used_at as string | null) ?? null,
      },
    ];
  });
}

/** Settings' Disconnect. Only the owner's own grant: the user id is in the filter. */
export async function revokeGrant(db: Db, userId: string, grantId: string, now = new Date()): Promise<boolean> {
  const { data } = await db
    .from('mcp_oauth_grants')
    .select('id')
    .eq('id', grantId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!data) return false;
  return revokeGrantById(db, grantId, now);
}
