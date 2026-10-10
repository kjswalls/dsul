// @vitest-environment node
import crypto, { generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { AuthApiError, AuthRetryableFetchError, AuthUnknownError } from '@supabase/supabase-js';
import { appleClientSecret } from '../../scripts/apple-client-secret.mjs';
import {
  APPLE_SECRET_LIFETIME_S,
  APPLE_TIMEOUT_MS,
  AppleCallError,
  appleIdTokenSubject,
  exchangeAppleCode,
  mintAppleClientSecret,
  revokeAppleToken,
  type AppleRevocationConfig,
} from '@/lib/account-server/apple';
import { deleteAccount } from '@/lib/account-server/delete';
import type { ServiceClient } from '@/lib/account-server/http';

/**
 * lib/account-server: Sign in with Apple's REST calls and the delete itself
 * (memory/plans/account-deletion.md). The routes around them are in
 * account-routes.test.ts; this file holds the pieces to their contracts:
 *
 *   - the Apple configuration refuses every key but an EC P-256 one, and says
 *     why once;
 *   - the client secret is the script's (scripts/apple-client-secret.mjs) but
 *     for a five-minute life;
 *   - every Apple failure is one AppleCallError with a short code, a hung call
 *     ends at 5 s, and the timer never outlives a call;
 *   - deleteAccount exchanges, deletes, then revokes, never throws, and nothing
 *     Apple does changes whether an account is deleted.
 */

const USER = '6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';
const APPLE_ID = '001234.dsul.0001';
const CODE = 'c0de.SENTINEL-apple-code';
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const P8 = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const pem = (key: crypto.KeyObject) => key.export({ type: 'pkcs8', format: 'pem' }).toString();
const RSA = pem(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey);
const ED25519 = pem(generateKeyPairSync('ed25519').privateKey);
const P384 = pem(generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey);

const ENV = {
  APPLE_TEAM_ID: 'TEAM123456',
  APPLE_KEY_ID: 'KEY1234567',
  APPLE_PRIVATE_KEY: P8,
  APPLE_IOS_CLIENT_ID: 'app.dsul.ios',
};
const CONFIG: AppleRevocationConfig = {
  teamId: ENV.APPLE_TEAM_ID,
  keyId: ENV.APPLE_KEY_ID,
  privateKey: P8,
  clientId: ENV.APPLE_IOS_CLIENT_ID,
};

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const idToken = (claims: Record<string, unknown> = {}) =>
  [
    b64({ alg: 'RS256', kid: 'apple' }),
    b64({ iss: 'https://appleid.apple.com', aud: 'app.dsul.ios', sub: APPLE_ID, ...claims }),
    'c2ln',
  ].join('.');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const TOKENS = {
  access_token: 'AT-SENTINEL',
  expires_in: 3600,
  id_token: idToken(),
  refresh_token: 'RT-SENTINEL',
  token_type: 'Bearer',
};

/** A fetch spy that answers each Apple endpoint from a queue of answers. */
function appleFetch(answers: { token?: () => Promise<Response>; revoke?: () => Promise<Response> } = {}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const url = String(input);
    if (url === 'https://appleid.apple.com/auth/token') return (answers.token ?? (async () => json(TOKENS)))();
    if (url === 'https://appleid.apple.com/auth/revoke') return (answers.revoke ?? (async () => new Response(null)))();
    throw new Error(`unexpected fetch ${url}`);
  });
}
const formOf = (call: unknown[]) => new URLSearchParams(String((call[1] as RequestInit).body));

let warn: MockInstance<(...args: unknown[]) => void>;
let info: MockInstance<(...args: unknown[]) => void>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const logged = () => [...warn.mock.calls, ...info.mock.calls].map((c) => c.map(String).join(' '));

describe('appleRevocationConfig', () => {
  // A fresh module per test: the configuration is read once per instance, and
  // each case here is a new instance.
  const fresh = async () => {
    vi.resetModules();
    return (await import('@/lib/account-server/apple')).appleRevocationConfig;
  };

  it('reads the four variables and a P-256 key', async () => {
    expect((await fresh())(ENV)).toEqual(CONFIG);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads a PEM pasted as one line, its breaks a literal \\n', async () => {
    const oneLine = P8.split('\n').join('\\n');
    expect(oneLine).not.toContain('\n');
    const config = (await fresh())({ ...ENV, APPLE_PRIVATE_KEY: oneLine });
    expect(config?.privateKey).toBe(P8);
    expect(() => mintAppleClientSecret(config!)).not.toThrow();
  });

  it.each(['APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY', 'APPLE_IOS_CLIENT_ID'])(
    'is null without %s, with one apple_not_configured line',
    async (name) => {
      expect((await fresh())({ ...ENV, [name]: undefined })).toBeNull();
      expect(warn.mock.calls).toEqual([['[account]', 'apple_not_configured']]);
      warn.mockClear();
      expect((await fresh())({ ...ENV, [name]: '  ' })).toBeNull();
      expect(warn.mock.calls).toEqual([['[account]', 'apple_not_configured']]);
    },
  );

  it.each([
    ['junk', 'not a key'],
    ['an RSA key', RSA],
    ['an Ed25519 key', ED25519],
    ['a P-384 EC key', P384],
  ])('is null for %s, with one apple_key_unreadable line', async (_, key) => {
    expect((await fresh())({ ...ENV, APPLE_PRIVATE_KEY: key })).toBeNull();
    expect(warn.mock.calls).toEqual([['[account]', 'apple_key_unreadable']]);
  });

  it('logs a problem once per instance, not per request', async () => {
    const read = await fresh();
    for (let i = 0; i < 3; i++) expect(read({ ...ENV, APPLE_KEY_ID: '' })).toBeNull();
    for (let i = 0; i < 3; i++) expect(read({ ...ENV, APPLE_KEY_ID: '' })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reads a changed configuration afresh', async () => {
    const read = await fresh();
    expect(read({ ...ENV, APPLE_KEY_ID: '' })).toBeNull();
    expect(read(ENV)).toEqual(CONFIG);
    expect(read({ ...ENV, APPLE_PRIVATE_KEY: RSA })).toBeNull();
    expect(warn.mock.calls).toEqual([['[account]', 'apple_not_configured'], ['[account]', 'apple_key_unreadable']]);
  });

  it('never logs a variable’s value', async () => {
    (await fresh())({ ...ENV, APPLE_PRIVATE_KEY: 'SENTINEL-not-a-key' });
    expect(logged().join('\n')).not.toMatch(/SENTINEL|TEAM123456|KEY1234567/);
  });
});

describe('mintAppleClientSecret', () => {
  const secret = mintAppleClientSecret(CONFIG, NOW);
  const script = appleClientSecret({
    teamId: CONFIG.teamId,
    keyId: CONFIG.keyId,
    clientId: CONFIG.clientId,
    privateKey: P8,
    now: NOW,
  }).secret;
  const [header, payload, signature] = secret.split('.');

  it('has the script’s header', () => {
    expect(decode(header)).toEqual(decode(script.split('.')[0]));
    expect(decode(header)).toEqual({ alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' });
  });

  it('has the script’s claims but exp, which is five minutes on', () => {
    const mine = decode(payload);
    const theirs = decode(script.split('.')[1]);
    expect({ ...mine, exp: 0 }).toEqual({ ...theirs, exp: 0 });
    expect(mine).toEqual({
      iss: 'TEAM123456',
      iat: NOW / 1000,
      exp: NOW / 1000 + 300,
      aud: 'https://appleid.apple.com',
      sub: 'app.dsul.ios',
    });
    expect(mine.exp - mine.iat).toBe(APPLE_SECRET_LIFETIME_S);
    expect(APPLE_SECRET_LIFETIME_S).toBe(300);
  });

  it('is signed by the key, in JWT form (r||s)', () => {
    const sig = Buffer.from(signature, 'base64url');
    expect(sig).toHaveLength(64);
    expect(
      verify('sha256', Buffer.from(`${header}.${payload}`), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, sig),
    ).toBe(true);
  });
});

describe('appleIdTokenSubject', () => {
  it('gives the subject of Apple’s token for this app', () => {
    expect(appleIdTokenSubject(idToken(), 'app.dsul.ios')).toBe(APPLE_ID);
  });

  it('accepts aud as a list holding the app', () => {
    expect(appleIdTokenSubject(idToken({ aud: ['other', 'app.dsul.ios'] }), 'app.dsul.ios')).toBe(APPLE_ID);
  });

  it.each([
    ['a wrong issuer', idToken({ iss: 'https://evil.example' })],
    ['a wrong audience', idToken({ aud: 'app.dsul.web' })],
    ['a list without the app', idToken({ aud: ['app.dsul.web'] })],
    ['no sub', idToken({ sub: undefined })],
    ['an empty sub', idToken({ sub: '' })],
    ['a sub that is not a string', idToken({ sub: 42 })],
    ['not a JWT', 'nope'],
    ['a payload that is not JSON', `a.${Buffer.from('{').toString('base64url')}.c`],
    ['a payload that is a list', `a.${b64([1])}.c`],
    ['empty', ''],
  ])('is null for %s', (_, token) => {
    expect(appleIdTokenSubject(token, 'app.dsul.ios')).toBeNull();
  });
});

describe('exchangeAppleCode and revokeAppleToken', () => {
  it('exchanges with the form Apple documents, and no redirect_uri', async () => {
    const fetch = appleFetch();
    const tokens = await exchangeAppleCode(CONFIG, CODE, { fetch, now: () => NOW });
    expect(tokens).toEqual({ idToken: TOKENS.id_token, refreshToken: 'RT-SENTINEL', accessToken: 'AT-SENTINEL' });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://appleid.apple.com/auth/token');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
    const form = formOf(fetch.mock.calls[0]);
    expect([...form.keys()].sort()).toEqual(['client_id', 'client_secret', 'code', 'grant_type']);
    expect(form.get('client_id')).toBe('app.dsul.ios');
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe(CODE);
    // ECDSA signatures differ per signing; the header and claims are the mint's at `now`.
    const [header, claims] = form.get('client_secret')!.split('.');
    expect(`${header}.${claims}`).toBe(mintAppleClientSecret(CONFIG, NOW).split('.').slice(0, 2).join('.'));
  });

  it('gives null for a token Apple left out', async () => {
    const fetch = appleFetch({ token: async () => json({ id_token: TOKENS.id_token }) });
    expect(await exchangeAppleCode(CONFIG, CODE, { fetch })).toEqual({
      idToken: TOKENS.id_token,
      refreshToken: null,
      accessToken: null,
    });
  });

  it('revokes with the token and its hint', async () => {
    const fetch = appleFetch();
    await expect(revokeAppleToken(CONFIG, 'RT-SENTINEL', 'refresh_token', { fetch })).resolves.toBeUndefined();
    const form = formOf(fetch.mock.calls[0]);
    expect(fetch.mock.calls[0][0]).toBe('https://appleid.apple.com/auth/revoke');
    expect([...form.keys()].sort()).toEqual(['client_id', 'client_secret', 'token', 'token_type_hint']);
    expect(form.get('token')).toBe('RT-SENTINEL');
    expect(form.get('token_type_hint')).toBe('refresh_token');
  });

  const calls = [
    ['exchangeAppleCode', (fetch: typeof globalThis.fetch) => exchangeAppleCode(CONFIG, CODE, { fetch })],
    ['revokeAppleToken', (fetch: typeof globalThis.fetch) => revokeAppleToken(CONFIG, 'RT', 'refresh_token', { fetch })],
  ] as const;
  const answer = (res: () => Promise<Response>) => vi.fn(res) as unknown as typeof globalThis.fetch;
  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'resolved';
    } catch (err) {
      expect(err).toBeInstanceOf(AppleCallError);
      return (err as AppleCallError).code;
    }
  };

  for (const [name, call] of calls) {
    it.each([
      'invalid_request',
      'invalid_client',
      'invalid_grant',
      'unauthorized_client',
      'unsupported_grant_type',
      'invalid_scope',
    ])(`${name} throws Apple's word %s`, async (word) => {
      expect(await codeOf(call(answer(async () => json({ error: word }, 400))))).toBe(word);
    });

    it(`${name}: an error that is not JSON is malformed`, async () => {
      expect(await codeOf(call(answer(async () => new Response('<html>oops</html>', { status: 502 }))))).toBe(
        'malformed',
      );
    });

    it(`${name}: an error word Apple doesn't document is the status`, async () => {
      expect(await codeOf(call(answer(async () => json({ error: 'teapot' }, 418))))).toBe('status_418');
      expect(await codeOf(call(answer(async () => new Response('', { status: 500 }))))).toBe('malformed');
    });

    it(`${name}: a fetch that rejects is network`, async () => {
      expect(await codeOf(call(answer(async () => Promise.reject(new TypeError('fetch failed')))))).toBe('network');
    });

    it(`${name}: a hung call ends at the 5 s timeout, and its timer is cleared`, async () => {
      vi.useFakeTimers();
      const hung = answer(() => new Promise<Response>(() => {}));
      const settled = codeOf(call(hung));
      await vi.advanceTimersByTimeAsync(APPLE_TIMEOUT_MS - 1);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await settled).toBe('timeout');
      expect(vi.getTimerCount()).toBe(0);
    });

    it(`${name}: the timer is cleared on every other path`, async () => {
      vi.useFakeTimers();
      await codeOf(call(answer(async () => json(TOKENS))));
      expect(vi.getTimerCount()).toBe(0);
      await codeOf(call(answer(async () => json({ error: 'invalid_grant' }, 400))));
      expect(vi.getTimerCount()).toBe(0);
      await codeOf(call(answer(async () => Promise.reject(new TypeError('x')))));
      expect(vi.getTimerCount()).toBe(0);
    });

    it(`${name}: a mint that throws is secret, and nothing is sent`, async () => {
      vi.spyOn(crypto, 'sign').mockImplementation(() => {
        throw new Error('SENTINEL-key-material');
      });
      const fetch = appleFetch();
      expect(await codeOf(call(fetch))).toBe('secret');
      expect(fetch).not.toHaveBeenCalled();
    });

    it(`${name}: a key that won't parse is secret too`, async () => {
      const fetch = appleFetch();
      const bad = { ...CONFIG, privateKey: 'not a key' };
      const p =
        name === 'exchangeAppleCode'
          ? exchangeAppleCode(bad, CODE, { fetch })
          : revokeAppleToken(bad, 'RT', 'refresh_token', { fetch });
      expect(await codeOf(p)).toBe('secret');
    });
  }

  it('an exchange answer without an ID token is malformed', async () => {
    const fetch = answer(async () => json({ access_token: 'AT' }));
    expect(await codeOf(exchangeAppleCode(CONFIG, CODE, { fetch }))).toBe('malformed');
    const notJson = answer(async () => new Response('ok'));
    expect(await codeOf(exchangeAppleCode(CONFIG, CODE, { fetch: notJson }))).toBe('malformed');
  });

  it('a revoke answered 200 with any body is a revoke', async () => {
    await expect(revokeAppleToken(CONFIG, 'RT', 'refresh_token', { fetch: answer(async () => new Response('')) })).resolves.toBeUndefined();
    await expect(revokeAppleToken(CONFIG, 'RT', 'access_token', { fetch: answer(async () => new Response('ok')) })).resolves.toBeUndefined();
  });

  it('an AppleCallError carries only its code', () => {
    const err = new AppleCallError('invalid_grant');
    expect(err.message).toBe('invalid_grant');
    expect(err.name).toBe('AppleCallError');
  });
});

// ── deleteAccount ───────────────────────────────────────────────────────────

type AuthAnswer = { data: { user: unknown }; error: unknown };
const user = (identities: { provider: string; id: string }[] = [{ provider: 'apple', id: APPLE_ID }]) => ({
  id: USER,
  email: 'kirby@example.com',
  identities: identities.map((i) => ({ ...i, identity_id: crypto.randomUUID(), user_id: USER })),
});
const found = (u: unknown = user()): AuthAnswer => ({ data: { user: u }, error: null });
const missing = (): AuthAnswer => ({
  data: { user: null },
  error: new AuthApiError('User not found', 404, 'user_not_found'),
});

function service(opts: {
  reads?: (AuthAnswer | (() => Promise<AuthAnswer>))[];
  deleted?: AuthAnswer | (() => Promise<AuthAnswer>);
}) {
  const reads = [...(opts.reads ?? [found()])];
  const order: string[] = [];
  const getUserById = vi.fn(async (id: string) => {
    order.push(`getUserById ${id === USER ? 'A' : id}`);
    const next = reads.shift() ?? found();
    return typeof next === 'function' ? next() : next;
  });
  const deleteUser = vi.fn(async (id: string, soft?: boolean) => {
    order.push(`deleteUser ${id === USER ? 'A' : id}${soft ? ' soft' : ''}`);
    const d = opts.deleted ?? { data: { user: null }, error: null };
    return typeof d === 'function' ? d() : d;
  });
  const svc = { auth: { admin: { getUserById, deleteUser } } } as unknown as ServiceClient;
  return { svc, getUserById, deleteUser, order };
}

function trackedFetch(order: string[], answers: Parameters<typeof appleFetch>[0] = {}) {
  const inner = appleFetch(answers);
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    order.push(String(input).endsWith('/token') ? 'exchange' : 'revoke');
    return inner(input, init);
  });
}

describe('deleteAccount', () => {
  it('exchanges, deletes, then revokes Apple’s refresh token', async () => {
    const s = service({});
    const fetch = trackedFetch(s.order);
    const result = await deleteAccount(s.svc, { userId: USER, appleCode: CODE }, { fetch, env: ENV, now: () => NOW });
    expect(result).toEqual({ ok: true, apple: 'revoked' });
    expect(s.order).toEqual(['getUserById A', 'exchange', 'deleteUser A', 'revoke']);
    // Never soft: GoTrue's soft delete keeps the row.
    expect(s.deleteUser).toHaveBeenCalledExactlyOnceWith(USER);
    const revoke = formOf(fetch.mock.calls[1]);
    expect(revoke.get('token')).toBe('RT-SENTINEL');
    expect(revoke.get('token_type_hint')).toBe('refresh_token');
    expect(info.mock.calls).toEqual([['[account] deleted', 'revoked']]);
  });

  it('revokes the access token when Apple gave no refresh token', async () => {
    const s = service({});
    const fetch = trackedFetch(s.order, { token: async () => json({ id_token: idToken(), access_token: 'AT-SENTINEL' }) });
    expect(await deleteAccount(s.svc, { userId: USER, appleCode: CODE }, { fetch, env: ENV })).toEqual({
      ok: true,
      apple: 'revoked',
    });
    const revoke = formOf(fetch.mock.calls[1]);
    expect(revoke.get('token')).toBe('AT-SENTINEL');
    expect(revoke.get('token_type_hint')).toBe('access_token');
  });

  it('is none for an account with no Apple identity, with no Apple call even with a code', async () => {
    const s = service({ reads: [found(user([{ provider: 'google', id: '1234' }]))] });
    const fetch = appleFetch();
    expect(await deleteAccount(s.svc, { userId: USER, appleCode: CODE }, { fetch, env: ENV })).toEqual({
      ok: true,
      apple: 'none',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(s.deleteUser).toHaveBeenCalledOnce();
  });

  it('is not_revoked for an Apple account with no code (the web, or no Apple step)', async () => {
    const s = service({});
    const fetch = appleFetch();
    expect(await deleteAccount(s.svc, { userId: USER }, { fetch, env: ENV })).toEqual({ ok: true, apple: 'not_revoked' });
    expect(fetch).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores a code when Apple isn’t configured: deleted, not_revoked, one config line', async () => {
    const s = service({});
    const fetch = appleFetch();
    expect(
      await deleteAccount(s.svc, { userId: USER, appleCode: CODE }, { fetch, env: { ...ENV, APPLE_KEY_ID: '' } }),
    ).toEqual({ ok: true, apple: 'not_revoked' });
    expect(fetch).not.toHaveBeenCalled();
    expect(s.deleteUser).toHaveBeenCalledOnce();
    expect(warn.mock.calls).toContainEqual(['[account] apple', 'config', 'apple_not_configured']);
  });

  it('never revokes tokens for a different Apple ID', async () => {
    const s = service({});
    const fetch = trackedFetch(s.order, { token: async () => json({ ...TOKENS, id_token: idToken({ sub: 'someone.else' }) }) });
    expect(await deleteAccount(s.svc, { userId: USER, appleCode: CODE }, { fetch, env: ENV })).toEqual({
      ok: true,
      apple: 'not_revoked',
    });
    expect(s.order).toEqual(['getUserById A', 'exchange', 'deleteUser A']);
    expect(warn.mock.calls).toContainEqual(['[account] apple', 'subject', 'mismatch']);
  });

  it.each([
    ['invalid_grant', async () => json({ error: 'invalid_grant' }, 400), 'invalid_grant'],
    ['a network failure', async () => Promise.reject(new TypeError('fetch failed')), 'network'],
  ])('deletes when the exchange fails (%s): not_revoked, one line', async (_, token, code) => {
    const s = service({});
    const fetch = trackedFetch(s.order, { token });
    expect(await deleteAccount(s.svc, { userId: USER, appleCode: CODE }, { fetch, env: ENV })).toEqual({
      ok: true,
      apple: 'not_revoked',
    });
    expect(s.order).toEqual(['getUserById A', 'exchange', 'deleteUser A']);
    expect(warn.mock.calls).toEqual([['[account] apple', 'exchange', code]]);
  });

  it('deletes when the exchange times out', async () => {
    vi.useFakeTimers();
    const s = service({});
    const fetch = trackedFetch(s.order, { token: () => new Promise<Response>(() => {}) });
    const pending = deleteAccount(s.svc, { userId: USER, appleCode: CODE }, { fetch, env: ENV });
    await vi.advanceTimersByTimeAsync(APPLE_TIMEOUT_MS);
    expect(await pending).toEqual({ ok: true, apple: 'not_revoked' });
    expect(s.deleteUser).toHaveBeenCalledOnce();
    expect(warn.mock.calls).toEqual([['[account] apple', 'exchange', 'timeout']]);
  });

  it('deletes when the mint throws: not_revoked', async () => {
    vi.spyOn(crypto, 'sign').mockImplementation(() => {
      throw new Error('boom');
    });
    const s = service({});
    const fetch = appleFetch();
    expect(await deleteAccount(s.svc, { userId: USER, appleCode: CODE }, { fetch, env: ENV })).toEqual({
      ok: true,
      apple: 'not_revoked',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(s.deleteUser).toHaveBeenCalledOnce();
    expect(warn.mock.calls).toEqual([['[account] apple', 'exchange', 'secret']]);
  });

  it.each([
    ['answers 400', async () => json({ error: 'invalid_request' }, 400), 'invalid_request'],
    ['throws a TypeError', async () => Promise.reject(new TypeError('terminated')), 'network'],
  ])('is still deleted when the revoke %s: not_revoked', async (_, revoke, code) => {
    const s = service({});
    const fetch = trackedFetch(s.order, { revoke });
    expect(await deleteAccount(s.svc, { userId: USER, appleCode: CODE }, { fetch, env: ENV })).toEqual({
      ok: true,
      apple: 'not_revoked',
    });
    expect(s.order).toEqual(['getUserById A', 'exchange', 'deleteUser A', 'revoke']);
    expect(warn.mock.calls).toEqual([['[account] apple', 'revoke', code]]);
  });

  it('a retry finds no user: deleted already, unknown, nothing else asked', async () => {
    const s = service({ reads: [missing()] });
    const fetch = appleFetch();
    expect(await deleteAccount(s.svc, { userId: USER, appleCode: CODE }, { fetch, env: ENV })).toEqual({
      ok: true,
      apple: 'unknown',
    });
    expect(s.deleteUser).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['an AuthApiError 500', { data: { user: null }, error: new AuthApiError('boom', 500, 'unexpected_failure') }],
    ['a retryable fetch error', { data: { user: null }, error: new AuthRetryableFetchError('down', 503) }],
  ])('the first read failing (%s) is unavailable, and nothing is deleted', async (_, answer) => {
    const s = service({ reads: [answer] });
    expect(await deleteAccount(s.svc, { userId: USER }, { env: ENV })).toEqual({ ok: false, error: 'unavailable' });
    expect(s.deleteUser).not.toHaveBeenCalled();
  });

  it('the first read throwing is unavailable', async () => {
    const s = service({ reads: [() => Promise.reject(new Error('socket hang up'))] });
    expect(await deleteAccount(s.svc, { userId: USER }, { env: ENV })).toEqual({ ok: false, error: 'unavailable' });
    expect(s.deleteUser).not.toHaveBeenCalled();
  });

  it('deleteUser answering 404 is deleted (two at once)', async () => {
    const s = service({ deleted: missing() });
    expect(await deleteAccount(s.svc, { userId: USER }, { env: ENV })).toEqual({ ok: true, apple: 'not_revoked' });
    expect(s.getUserById).toHaveBeenCalledOnce();
  });

  const failures: [string, AuthAnswer | (() => Promise<AuthAnswer>)][] = [
    ['an AuthApiError 500', { data: { user: null }, error: new AuthApiError('Database error deleting user', 500, 'unexpected_failure') }],
    ['a retryable fetch error', { data: { user: null }, error: new AuthRetryableFetchError('gateway', 502) }],
    ['an unreadable answer', { data: { user: null }, error: new AuthUnknownError('bad json', null) }],
    ['a throw', () => Promise.reject(new Error('socket hang up'))],
  ];

  it.each(failures)('deleteUser %s, and the user still there: failed, no revoke', async (_, answer) => {
    const s = service({ reads: [found(), found()], deleted: answer });
    const fetch = trackedFetch(s.order);
    expect(await deleteAccount(s.svc, { userId: USER, appleCode: CODE }, { fetch, env: ENV })).toEqual({
      ok: false,
      error: 'failed',
    });
    expect(s.order).toEqual(['getUserById A', 'exchange', 'deleteUser A', 'getUserById A']);
    expect(info).not.toHaveBeenCalled();
  });

  it.each(failures)('deleteUser %s, and the user gone: deleted, and the revoke runs', async (_, answer) => {
    const s = service({ reads: [found(), missing()], deleted: answer });
    const fetch = trackedFetch(s.order);
    expect(await deleteAccount(s.svc, { userId: USER, appleCode: CODE }, { fetch, env: ENV })).toEqual({
      ok: true,
      apple: 'revoked',
    });
    expect(s.order).toEqual(['getUserById A', 'exchange', 'deleteUser A', 'getUserById A', 'revoke']);
  });

  it.each(failures)('deleteUser %s, and the second read failing: unavailable', async (_, answer) => {
    const s = service({
      reads: [found(), { data: { user: null }, error: new AuthRetryableFetchError('down', 0) }],
      deleted: answer,
    });
    expect(await deleteAccount(s.svc, { userId: USER }, { env: ENV })).toEqual({ ok: false, error: 'unavailable' });
  });

  it('the second read throwing is unavailable', async () => {
    const s = service({
      reads: [found(), () => Promise.reject(new Error('x'))],
      deleted: { data: { user: null }, error: new AuthApiError('boom', 500, 'unexpected_failure') },
    });
    expect(await deleteAccount(s.svc, { userId: USER }, { env: ENV })).toEqual({ ok: false, error: 'unavailable' });
  });

  it('nothing it is given makes it throw', async () => {
    const broken = [
      {},
      { auth: {} },
      { auth: { admin: {} } },
      { auth: { admin: { getUserById: () => found(), deleteUser: () => null } } },
      { auth: { admin: { getUserById: () => ({}), deleteUser: () => ({}) } } },
      null,
    ] as unknown as ServiceClient[];
    for (const svc of broken) {
      await expect(deleteAccount(svc, { userId: USER, appleCode: CODE }, { env: ENV })).resolves.toMatchObject({
        ok: expect.any(Boolean),
      });
    }
  });

  it('logs no id, email, code, token or secret on any path', async () => {
    const paths: (() => Promise<unknown>)[] = [
      () => deleteAccount(service({}).svc, { userId: USER, appleCode: CODE }, { fetch: appleFetch(), env: ENV }),
      () =>
        deleteAccount(service({}).svc, { userId: USER, appleCode: CODE }, {
          fetch: appleFetch({ revoke: async () => json({ error: 'invalid_client' }, 400) }),
          env: ENV,
        }),
      () =>
        deleteAccount(
          service({ reads: [found(), found()], deleted: { data: { user: null }, error: new AuthApiError(`no ${USER}`, 500, 'unexpected_failure') } }).svc,
          { userId: USER, appleCode: CODE },
          { fetch: appleFetch(), env: ENV },
        ),
    ];
    for (const run of paths) await run();
    const text = logged().join('\n');
    expect(text).toContain('[account]');
    for (const secret of [USER, 'kirby@example.com', CODE, 'RT-SENTINEL', 'AT-SENTINEL', APPLE_ID, 'TEAM123456', 'KEY1234567', 'BEGIN']) {
      expect(text).not.toContain(secret);
    }
  });
});
