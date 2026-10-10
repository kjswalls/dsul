/**
 * The pure half of signing in to /api/mcp with OAuth 2.1 (memory/plans/mcp-oauth.md):
 * scopes, redirect URIs, PKCE, token shapes and the two metadata documents.
 * Nothing here reads a database or a clock it was not handed, so all of it is
 * unit-tested directly; lib/mcp-oauth/store.ts holds the writes.
 */

import { createHash, randomBytes } from 'node:crypto';
import { SCOPES, type Scope } from './scopes';

export { SCOPES, SCOPE_WORDS, type Scope } from './scopes';

/**
 * The scope a request asks for, as one we grant. An absent or unknown scope is
 * read as full access (what every MCP client asks for by leaving it out), and
 * the consent page is where the user narrows it.
 */
export function parseScope(raw: string | null | undefined): Scope {
  const asked = (raw ?? '').split(/\s+/).filter(Boolean);
  if (asked.length > 0 && asked.every((s) => s === 'planner:read')) return 'planner:read';
  return 'planner';
}

export const ACCESS_TTL_S = 60 * 60;
export const REFRESH_TTL_S = 90 * 24 * 60 * 60;
export const CODE_TTL_S = 10 * 60;

/** Prefixes, so a leaked token says what it is and the agent key never collides. */
export const ACCESS_PREFIX = 'dsul_at_';
export const REFRESH_PREFIX = 'dsul_rt_';
export const CLIENT_PREFIX = 'dsul_client_';

export function mint(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

/** What is stored in place of a token or code. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** RFC 7636 S256: base64url(sha256(verifier)) === challenge. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  return createHash('sha256').update(verifier).digest('base64url') === challenge;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * A redirect URI an app may register: https anywhere, or http on loopback only
 * (Claude Code and other local clients listen on a port of their own). No
 * fragments, per OAuth, and no credentials in the URL. Custom schemes
 * (cursor://, claude://) are allowed too, since desktop apps return through
 * them; javascript:, data: and file: never.
 */
export function isAllowedRedirectUri(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return LOOPBACK.has(url.hostname);
  if (['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:'].includes(url.protocol)) return false;
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
}

/**
 * Does the redirect URI on an authorize or token request match a registered
 * one? Exact match, except that a loopback URI may name any port: RFC 8252
 * §7.3, since a native client picks a free port each time.
 */
export function redirectUriMatches(asked: string, registered: readonly string[]): boolean {
  if (registered.includes(asked)) return true;
  let a: URL;
  try {
    a = new URL(asked);
  } catch {
    return false;
  }
  if (a.protocol !== 'http:' || !LOOPBACK.has(a.hostname)) return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return u.protocol === 'http:' && u.hostname === a.hostname && u.pathname === a.pathname && u.search === a.search;
    } catch {
      return false;
    }
  });
}

export interface ClientRegistration {
  client_name: string;
  redirect_uris: string[];
}

/** RFC 7591's request, read strictly; an error string is what the 400 says. */
export function readRegistration(body: unknown): ClientRegistration | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'invalid_client_metadata' };
  const b = body as Record<string, unknown>;
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10) return { error: 'invalid_redirect_uri' };
  if (!uris.every((u) => typeof u === 'string' && u.length <= 2000 && isAllowedRedirectUri(u))) {
    return { error: 'invalid_redirect_uri' };
  }
  // Public clients only: PKCE is the proof, and a secret in a desktop app is no
  // secret. A client asking for another token_endpoint_auth_method is not
  // refused (some ask for client_secret_post by habit); RFC 7591 §3.2.1 lets the
  // server answer with what it will do instead, and the route answers 'none'.
  const name = typeof b.client_name === 'string' ? b.client_name.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  return { client_name: name || 'An app', redirect_uris: uris as string[] };
}

/** The server's public origin. Vercel's preview hosts each answer for themselves. */
export function originOf(req: Request): string {
  return new URL(req.url).origin;
}

/** RFC 8414 — what /.well-known/oauth-authorization-server says. */
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    revocation_endpoint: `${origin}/api/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...SCOPES],
  };
}

/** RFC 9728 — what /.well-known/oauth-protected-resource says about /api/mcp. */
export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'dsul',
  };
}

/** The 401's header that starts discovery (MCP authorization spec). */
export function wwwAuthenticate(origin: string, error?: 'invalid_token'): string {
  const meta = `resource_metadata="${origin}/.well-known/oauth-protected-resource"`;
  return error ? `Bearer error="${error}", ${meta}` : `Bearer ${meta}`;
}

/** The URL the consent page sends the browser back to. */
export function redirectWith(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}

/** Headers the public endpoints answer with: no cookies are read, so any origin may call. */
export const PUBLIC_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version',
  'Cache-Control': 'no-store',
} as const;
