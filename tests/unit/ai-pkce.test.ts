// @vitest-environment node
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PKCE_COOKIE,
  PKCE_COOKIE_PATH,
  PKCE_MAX_AGE_S,
  PKCE_STATE_RE,
  createPkcePair,
  exchangeOpenRouterCode,
  openPkceCookie,
  openRouterAuthUrl,
  openRouterCallbackUrl,
  pkceStateMatches,
  sealPkceCookie,
} from '@/lib/ai-server/pkce';
import { ProviderError } from '@/lib/ai-server/errors';
import { sealSecret } from '@/lib/ai-server/secret-box';

/**
 * "Sign in with OpenRouter" (design 1.10, D33). The cookie is sealed to the
 * user, so a planted one fails to open; the state rides in the callback path
 * and binds the callback to the browser that started the flow.
 */

const KEY = randomBytes(32);
const NOW = 1_800_000_000_000;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createPkcePair', () => {
  it('makes a 43-char verifier, an S256 challenge, and a 22-char state', () => {
    const flow = createPkcePair();
    expect(flow.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flow.challenge).toBe(createHash('sha256').update(flow.verifier).digest('base64url'));
    expect(flow.state).toMatch(PKCE_STATE_RE);
  });

  it('differs between calls', () => {
    const a = createPkcePair();
    const b = createPkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
  });

  it('keeps the cookie constants the routes rely on', () => {
    expect(PKCE_COOKIE).toBe('dsul_or_pkce');
    expect(PKCE_COOKIE_PATH).toBe('/api/ai/openrouter');
    expect(PKCE_MAX_AGE_S).toBe(600);
  });
});

describe('the sealed cookie', () => {
  const flow = createPkcePair();

  it('round-trips {verifier, state} for the same user', () => {
    const cookie = sealPkceCookie(flow, 'user-1', KEY, NOW);
    expect(cookie).not.toContain(flow.verifier);
    expect(cookie).not.toContain(flow.state);
    expect(openPkceCookie(cookie, 'user-1', KEY, NOW + 1000)).toEqual({
      verifier: flow.verifier,
      state: flow.state,
    });
  });

  it('does not open for another user', () => {
    const cookie = sealPkceCookie(flow, 'user-1', KEY, NOW);
    expect(openPkceCookie(cookie, 'user-2', KEY, NOW)).toBeNull();
  });

  it('expires after 600 s', () => {
    const cookie = sealPkceCookie(flow, 'user-1', KEY, NOW);
    expect(openPkceCookie(cookie, 'user-1', KEY, NOW + 600_000)).not.toBeNull();
    expect(openPkceCookie(cookie, 'user-1', KEY, NOW + 600_001)).toBeNull();
  });

  it('refuses a cookie from the future', () => {
    const cookie = sealPkceCookie(flow, 'user-1', KEY, NOW + 10 * 60_000);
    expect(openPkceCookie(cookie, 'user-1', KEY, NOW)).toBeNull();
  });

  it('a tampered, absent or malformed cookie → null', () => {
    const cookie = sealPkceCookie(flow, 'user-1', KEY, NOW);
    const p = cookie.split(':');
    const ct = Buffer.from(p[3], 'base64');
    ct[0] ^= 1;
    p[3] = ct.toString('base64');
    expect(openPkceCookie(p.join(':'), 'user-1', KEY, NOW)).toBeNull();
    expect(openPkceCookie(undefined, 'user-1', KEY, NOW)).toBeNull();
    expect(openPkceCookie('', 'user-1', KEY, NOW)).toBeNull();
    expect(openPkceCookie('garbage', 'user-1', KEY, NOW)).toBeNull();
    expect(openPkceCookie(cookie, 'user-1', randomBytes(32), NOW)).toBeNull();
  });

  it('a model-key seal does not open as a PKCE cookie (purpose is in the AAD)', () => {
    const asKey = sealSecret(JSON.stringify({ v: flow.verifier, s: flow.state, iat: NOW }), {
      userId: 'user-1',
      purpose: 'model-key',
    }, KEY);
    expect(openPkceCookie(asKey, 'user-1', KEY, NOW)).toBeNull();
  });

  it.each([
    ['short verifier', { v: 'abc', s: createPkcePair().state, iat: NOW }],
    ['bad state', { v: createPkcePair().verifier, s: 'not a state', iat: NOW }],
    ['missing iat', { v: createPkcePair().verifier, s: createPkcePair().state }],
    ['not an object', 'just a string'],
  ])('a well-sealed but malformed payload (%s) → null', (_label, payload) => {
    const sealed = sealSecret(JSON.stringify(payload), { userId: 'user-1', purpose: 'pkce' }, KEY);
    expect(openPkceCookie(sealed, 'user-1', KEY, NOW)).toBeNull();
  });
});

describe('pkceStateMatches', () => {
  const state = createPkcePair().state;

  it('is true only for the identical string', () => {
    expect(pkceStateMatches(state, state)).toBe(true);
    expect(pkceStateMatches(state, `${state}`)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['empty', ''],
    ['21 chars', state.slice(0, 21)],
    ['23 chars', `${state}A`],
    ['an array', [state]],
    ['a number', 42],
    ['null', null],
    ['a different valid state', createPkcePair().state],
    ['a path-traversal string', '../../../../etc/passwd'],
  ])('is false (never a throw) for %s', (_label, got) => {
    expect(() => pkceStateMatches(state, got)).not.toThrow();
    expect(pkceStateMatches(state, got)).toBe(false);
  });

  it('is false when the expected side is malformed', () => {
    expect(pkceStateMatches('', '')).toBe(false);
    expect(pkceStateMatches(undefined as unknown as string, state)).toBe(false);
  });
});

describe('URLs', () => {
  it('puts the state in the callback PATH', () => {
    const state = createPkcePair().state;
    expect(openRouterCallbackUrl('https://do.dsul.app', state)).toBe(
      `https://do.dsul.app/api/ai/openrouter/callback/${state}`
    );
    expect(openRouterCallbackUrl('http://localhost:3000/', state)).toBe(
      `http://localhost:3000/api/ai/openrouter/callback/${state}`
    );
  });

  it('encodes callback_url in the auth URL, with an S256 challenge', () => {
    const flow = createPkcePair();
    const callback = openRouterCallbackUrl('https://do.dsul.app', flow.state);
    const auth = openRouterAuthUrl(callback, flow.challenge);
    const u = new URL(auth);
    expect(u.origin).toBe('https://openrouter.ai');
    expect(u.pathname).toBe('/auth');
    expect(u.searchParams.get('callback_url')).toBe(callback);
    expect(u.searchParams.get('code_challenge')).toBe(flow.challenge);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    // Encoded, not raw: the callback's own slashes and colon do not appear unescaped in the query.
    expect(auth).toContain('callback_url=https%3A%2F%2Fdo.dsul.app%2Fapi%2Fai%2Fopenrouter%2Fcallback%2F');
  });
});

describe('exchangeOpenRouterCode', () => {
  it('POSTs the code and verifier and reads ONLY `key`', async () => {
    const fetchSpy = vi.fn<(...args: unknown[]) => Promise<Response>>(async () =>
      Response.json({ key: 'sk-or-v1-issued', user_id: 'or-user', label: 'sk-or-v1-abc...xyz' })
    );
    vi.stubGlobal('fetch', fetchSpy);
    const key = await exchangeOpenRouterCode('the-code', 'the-verifier', new AbortController().signal);
    expect(key).toBe('sk-or-v1-issued');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/auth/keys');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(JSON.parse(init.body as string)).toEqual({
      code: 'the-code',
      code_verifier: 'the-verifier',
      code_challenge_method: 'S256',
    });
  });

  it('a non-2xx throws a ProviderError, never the body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"invalid code sk-SENTINEL"}', { status: 403 }))
    );
    const err = await exchangeOpenRouterCode('c', 'v', new AbortController().signal).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('auth');
    expect((err as Error).message).not.toContain('SENTINEL');
  });

  it('a body without a usable key → upstream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ nope: true })));
    await expect(exchangeOpenRouterCode('c', 'v', new AbortController().signal)).rejects.toMatchObject({
      kind: 'upstream',
    });
  });

  it('an oversized body → upstream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`{"key":"${'a'.repeat(70_000)}"}`)));
    await expect(exchangeOpenRouterCode('c', 'v', new AbortController().signal)).rejects.toMatchObject({
      kind: 'upstream',
    });
  });

  it('a network failure → network; a deadline → timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    await expect(exchangeOpenRouterCode('c', 'v', new AbortController().signal)).rejects.toMatchObject({
      kind: 'network',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: unknown, init: RequestInit) => {
        const signal = init.signal as AbortSignal;
        return Promise.reject(signal.reason);
      })
    );
    const deadline = new AbortController();
    deadline.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    await expect(exchangeOpenRouterCode('c', 'v', deadline.signal)).rejects.toMatchObject({ kind: 'timeout' });
  });
});
