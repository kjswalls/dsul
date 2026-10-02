/**
 * "Sign in with OpenRouter": the PKCE pair, the sealed short-lived cookie that
 * carries the verifier and the flow's `state`, and the server-side code
 * exchange.
 *
 * Server-only. The cookie is sealed with the user-bound AAD (secret-box), so a
 * cookie planted from a sibling subdomain fails to open; the `state` rides in
 * the callback PATH and is compared before any exchange, which binds the
 * callback to the browser that started the flow (design 1.10, D33).
 *
 * The issued key goes straight from the exchange into `saveModelConnection`;
 * it is never returned to a browser.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ProviderError, classifyStatus, toProviderErrorFor } from './errors';
import { openSecret, sealSecret } from './secret-box';
import { readCappedJson } from './stream';
import { guardedFetch } from './url-policy';

export const PKCE_COOKIE = 'dsul_or_pkce';
export const PKCE_COOKIE_PATH = '/api/ai/openrouter';
export const PKCE_MAX_AGE_S = 600;
/** 16 bytes, base64url, no padding. */
export const PKCE_STATE_RE: RegExp = /^[A-Za-z0-9_-]{22}$/;

/** 32 bytes, base64url, no padding. */
const VERIFIER_RE = /^[A-Za-z0-9_-]{43}$/;
/** A cookie written by `sealPkceCookie` is well under this. */
const MAX_COOKIE_LENGTH = 1024;
/** Clock skew tolerated between the instance that set the cookie and the one reading it. */
const MAX_SKEW_MS = 60_000;

const OPENROUTER_ORIGIN = 'https://openrouter.ai';
const EXCHANGE_URL = `${OPENROUTER_ORIGIN}/api/v1/auth/keys`;
const EXCHANGE_MAX_BYTES = 64_000;
const ISSUED_KEY_RE = /^[\x21-\x7e]{8,512}$/;

export interface PkceFlow {
  verifier: string;
  challenge: string;
  state: string;
}

/** verifier: 32 random bytes base64url; challenge: S256; state: 16 random bytes base64url. */
export function createPkcePair(): PkceFlow {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');
  return { verifier, challenge, state };
}

/** sealSecret(JSON{v, s, iat}, {userId, purpose:'pkce'}) */
export function sealPkceCookie(
  flow: { verifier: string; state: string },
  userId: string,
  key: Buffer,
  now: number = Date.now()
): string {
  return sealSecret(
    JSON.stringify({ v: flow.verifier, s: flow.state, iat: now }),
    { userId, purpose: 'pkce' },
    key
  );
}

/** null: absent/other user/tampered/expired/malformed (v not 43 chars, s failing PKCE_STATE_RE). */
export function openPkceCookie(
  raw: string | undefined,
  userId: string,
  key: Buffer,
  now: number = Date.now()
): { verifier: string; state: string } | null {
  try {
    if (typeof raw !== 'string' || raw === '' || raw.length > MAX_COOKIE_LENGTH) return null;
    const plain = openSecret(raw, { userId, purpose: 'pkce' }, key);
    if (plain === null) return null;

    const parsed: unknown = JSON.parse(plain);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { v, s, iat } = parsed as Record<string, unknown>;
    if (typeof v !== 'string' || !VERIFIER_RE.test(v)) return null;
    if (typeof s !== 'string' || !PKCE_STATE_RE.test(s)) return null;
    if (typeof iat !== 'number' || !Number.isFinite(iat)) return null;

    const age = now - iat;
    if (age > PKCE_MAX_AGE_S * 1000 || age < -MAX_SKEW_MS) return null;
    return { verifier: v, state: s };
  } catch {
    return null;
  }
}

/** PKCE_STATE_RE on `got`, then crypto.timingSafeEqual on equal-length buffers. Never throws. */
export function pkceStateMatches(expected: string, got: unknown): boolean {
  try {
    if (typeof got !== 'string' || !PKCE_STATE_RE.test(got)) return false;
    if (typeof expected !== 'string' || !PKCE_STATE_RE.test(expected)) return false;
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(got, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** `${origin}/api/ai/openrouter/callback/${state}` */
export function openRouterCallbackUrl(origin: string, state: string): string {
  return `${origin.replace(/\/+$/, '')}/api/ai/openrouter/callback/${encodeURIComponent(state)}`;
}

/** https://openrouter.ai/auth?callback_url=<enc>&code_challenge=<c>&code_challenge_method=S256 */
export function openRouterAuthUrl(callbackUrl: string, challenge: string): string {
  const url = new URL('/auth', OPENROUTER_ORIGIN);
  url.searchParams.set('callback_url', callbackUrl);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/**
 * POST https://openrouter.ai/api/v1/auth/keys {code, code_verifier, code_challenge_method:'S256'};
 * guardedFetch(origin 'https://openrouter.ai'); readCappedJson 64 KB; reads ONLY `key`; throws ProviderError.
 */
export async function exchangeOpenRouterCode(
  code: string,
  verifier: string,
  signal: AbortSignal
): Promise<string> {
  const fetchGuarded = guardedFetch({ origin: OPENROUTER_ORIGIN, checkDns: false });
  try {
    const res = await fetchGuarded(EXCHANGE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
      signal,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new ProviderError(classifyStatus(res.status, 'openrouter', 'verify'), res.status);
    }
    const body = await readCappedJson(res, EXCHANGE_MAX_BYTES);
    const issued =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>).key : undefined;
    if (typeof issued !== 'string' || !ISSUED_KEY_RE.test(issued)) throw new ProviderError('upstream');
    return issued;
  } catch (err) {
    throw toProviderErrorFor(err, 'openrouter', 'verify', signal);
  }
}
