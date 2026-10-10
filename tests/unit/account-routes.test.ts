// @vitest-environment node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthUnknownError,
} from '@supabase/supabase-js';

/**
 * The four account routes (memory/plans/account-deletion.md):
 *
 *   GET  /api/app/account          the phone's facts, bearer token
 *   POST /api/app/account/delete   the phone's delete, bearer token
 *   GET  /api/account              the web's facts, cookie session
 *   POST /api/account/delete       the web's delete, cookie session, same origin
 *
 * What this file holds them to, in the order a failure would hurt:
 *   - nothing is deleted, read or even built without the owner's proof: the
 *     service client is built with the secret key only after the caller and
 *     the body pass, and the account deleted is always the verified caller's,
 *     and only while it is the account the confirmation was opened for;
 *   - a delete is safe to send twice, and GoTrue's answers are read the way
 *     the plan's table says (a failed delete is asked about, not trusted);
 *   - Apple is exchanged, then the account deleted, then the tokens revoked,
 *     and no Apple failure keeps an account;
 *   - no response or log line carries an id, an email, Apple's code, a token,
 *     a secret or a row's value.
 *
 * TWO SUPABASE CLIENTS, TOLD APART. The phone's user client (lib/app-auth.ts)
 * and the service client (lib/supabase-service.ts) are both supabase-js's
 * createClient, so the mock answers by key: the anon key gets `userFake`, the
 * secret key `serviceFake`. `serviceBuilt()` is the proof the service client
 * was never built. The web's cookie client (lib/supabase-server) is `cookieFake`.
 *
 * Writes the two 200 fixtures DsulCore reads with UPDATE_FIXTURES=1:
 *
 *   UPDATE_FIXTURES=1 pnpm test tests/unit/account-routes.test.ts
 *
 * and otherwise compares them. Never hand-edit them.
 */

const USER = '6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';
const OTHER = '00000000-0000-4000-8000-000000000000';
const SECRET = 'sb_secret_SENTINEL-service-key';
const APPLE_ID = '001234.dsul.0001';
const CODE = 'c0de.SENTINEL-apple-code';
const EMAIL = 'kirby@example.com';
const NOW = Math.floor(Date.now() / 1000);

const h = vi.hoisted(() => ({
  createClient: vi.fn(),
  getUser: vi.fn(),
  cookieGetUser: vi.fn(),
  getSession: vi.fn(),
  getUserById: vi.fn(),
  deleteUser: vi.fn(),
  from: vi.fn(),
  fetch: vi.fn(),
  queries: [] as { table: string; columns: string; filters: [string, unknown][]; limit?: number }[],
  rows: {} as Record<string, unknown>,
}));

vi.mock('@supabase/supabase-js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
  createClient: h.createClient,
}));
vi.mock('@/lib/supabase-server', () => ({
  createClient: async () => ({ auth: { getUser: h.cookieGetUser, getSession: h.getSession } }),
}));

import { GET as getAppFacts } from '@/app/api/app/account/route';
import { POST as postAppDelete } from '@/app/api/app/account/delete/route';
import { GET as getWebFacts } from '@/app/api/account/route';
import { POST as postWebDelete } from '@/app/api/account/delete/route';

// ── tokens and requests ─────────────────────────────────────────────────────

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = (claims: Record<string, unknown> = {}) =>
  [
    b64({ alg: 'HS256', typ: 'JWT' }),
    b64({ sub: USER, role: 'authenticated', exp: NOW + 3600, ...claims }),
    'c2lnbmF0dXJl',
  ].join('.');
const BEARER = { authorization: `Bearer ${token()}` };

const appFacts = (headers: Record<string, string> = BEARER) =>
  getAppFacts(new Request('https://do.dsul.app/api/app/account', { headers }));
const appDelete = (body: unknown, headers: Record<string, string> = BEARER) =>
  postAppDelete(
    new Request('https://do.dsul.app/api/app/account/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
const SAME_ORIGIN = { origin: 'https://do.dsul.app', 'sec-fetch-site': 'same-origin' };
const webDelete = (body: unknown, headers: Record<string, string> = {}) =>
  postWebDelete(
    new Request('https://do.dsul.app/api/account/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...SAME_ORIGIN, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

const VALID = { account: USER, confirm: 'DELETE' };
const WITH_CODE = { ...VALID, appleCode: CODE };

// ── the service client's answers ────────────────────────────────────────────

const identities = (list: { provider: string; id: string }[]) =>
  list.map((i, n) => ({ ...i, identity_id: `ident-${n}`, user_id: USER }));
const theUser = (over: Record<string, unknown> = {}) => ({
  id: USER,
  email: EMAIL,
  identities: identities([
    { provider: 'apple', id: APPLE_ID },
    { provider: 'email', id: USER },
  ]),
  ...over,
});
const found = (u: unknown = theUser()) => ({ data: { user: u }, error: null });
const notFound = () => ({ data: { user: null }, error: new AuthApiError('User not found', 404, 'user_not_found') });
const ok = (data: unknown) => ({ data, error: null });
const dbError = (code: string) => ({ data: null, error: { code, message: 'SENTINEL-db-message', details: 'SENTINEL-row' } });

/** The rows behind the facts example of the plan (and the committed fixture). */
const exampleRows = (): Record<string, unknown> => ({
  user_extensions: ok({ slug: 'beeminder' }),
  stake_events: ok({ user_id: USER }),
  user_secrets: ok({
    reminder_secrets: {
      beeminder: { authToken: 'SENTINEL-beeminder-token' },
      'sms-nudge': { accountSid: 'SENTINEL-twilio-sid', authToken: 'SENTINEL-twilio-token' },
    },
    openclaw_gateway_token: null,
    openclaw_hooks_token: null,
    openclaw_api_key: null,
  }),
  user_settings: ok({ openclaw_api_key: null }),
  model_connections: ok({ provider: 'openai', base_url: null }),
});

function chain(table: string) {
  const call = { table, columns: '', filters: [] as [string, unknown][], limit: undefined as number | undefined };
  h.queries.push(call);
  const q = {
    select(columns: string) {
      call.columns = columns;
      return q;
    },
    eq(column: string, value: unknown) {
      call.filters.push([column, value]);
      return q;
    },
    limit(n: number) {
      call.limit = n;
      return q;
    },
    async maybeSingle() {
      const answer = h.rows[table];
      if (typeof answer === 'function') return (answer as (c: typeof call) => unknown)(call);
      return answer ?? ok(null);
    },
  };
  return q;
}

const serviceFake = { auth: { admin: { getUserById: h.getUserById, deleteUser: h.deleteUser } }, from: h.from };
const userFake = { auth: { getUser: h.getUser } };
const serviceBuilt = () => h.createClient.mock.calls.some((c) => c[1] === SECRET);

// ── Apple ───────────────────────────────────────────────────────────────────

const P8 = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const APPLE_ENV = {
  APPLE_TEAM_ID: 'TEAM123456',
  APPLE_KEY_ID: 'KEY1234567',
  APPLE_PRIVATE_KEY: P8,
  APPLE_IOS_CLIENT_ID: 'app.dsul.ios',
};
const idToken = (sub = APPLE_ID) =>
  [b64({ alg: 'RS256' }), b64({ iss: 'https://appleid.apple.com', aud: 'app.dsul.ios', sub }), 'c2ln'].join('.');
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const appleTokens = (sub = APPLE_ID) => ({
  access_token: 'AT-SENTINEL',
  expires_in: 3600,
  id_token: idToken(sub),
  refresh_token: 'RT-SENTINEL',
  token_type: 'Bearer',
});

let order: string[];
function apple(answers: { token?: () => Promise<Response>; revoke?: () => Promise<Response> } = {}) {
  h.fetch.mockImplementation(async (input: unknown) => {
    const url = String(input);
    if (url === 'https://appleid.apple.com/auth/token') {
      order.push('exchange');
      return (answers.token ?? (async () => json(appleTokens())))();
    }
    if (url === 'https://appleid.apple.com/auth/revoke') {
      order.push('revoke');
      return (answers.revoke ?? (async () => new Response(null)))();
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}
const formOf = (n: number) => new URLSearchParams(String((h.fetch.mock.calls[n][1] as RequestInit).body));

// ── setup ───────────────────────────────────────────────────────────────────

let logs: MockInstance<(...args: unknown[]) => void>[];
const logged = () => logs.flatMap((spy) => spy.mock.calls.map((c) => c.map(String).join(' '))).join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  h.queries.length = 0;
  h.rows = exampleRows();
  order = [];
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://ref.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
  vi.stubEnv('SUPABASE_SECRET_KEY', SECRET);
  for (const [k, v] of Object.entries(APPLE_ENV)) vi.stubEnv(k, v);
  vi.stubGlobal('fetch', h.fetch);
  h.createClient.mockImplementation((_url: string, key: string) => {
    if (key === SECRET) return serviceFake;
    if (key === 'anon-key') return userFake;
    throw new Error(`createClient with an unexpected key`);
  });
  h.from.mockImplementation((table: string) => chain(table));
  h.getUser.mockResolvedValue(found({ id: USER, email: EMAIL }));
  h.cookieGetUser.mockResolvedValue(found({ id: USER, email: EMAIL }));
  h.getSession.mockResolvedValue({ data: { session: { access_token: token() } }, error: null });
  h.getUserById.mockImplementation(async () => {
    order.push('getUserById');
    return found();
  });
  h.deleteUser.mockImplementation(async () => {
    order.push('deleteUser');
    return { data: { user: null }, error: null };
  });
  apple();
  logs = [
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'info').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
    vi.spyOn(console, 'log').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function expectAnswer(res: Response, status: number, body: unknown) {
  expect(res.status).toBe(status);
  expect(res.headers.get('cache-control')).toBe('no-store');
  if (status === 503) expect(res.headers.get('retry-after')).toBe('5');
  expect(await res.json()).toEqual(body);
}
function expectUntouched() {
  expect(serviceBuilt()).toBe(false);
  expect(h.getUserById).not.toHaveBeenCalled();
  expect(h.deleteUser).not.toHaveBeenCalled();
  expect(h.fetch).not.toHaveBeenCalled();
}

// ── never without the owner's proof ─────────────────────────────────────────

describe('never without the owner’s proof', () => {
  const refusedHeaders: [string, Record<string, string>][] = [
    ['no header', {}],
    ['a dsul_ agent key', { authorization: `Bearer dsul_${'ab'.repeat(32)}` }],
    ['a cookie only', { cookie: `sb-ref-auth-token=${encodeURIComponent(JSON.stringify([token()]))}` }],
    ['an expired token', { authorization: `Bearer ${token({ exp: NOW - 60 })}` }],
    ['role anon', { authorization: `Bearer ${token({ role: 'anon' })}` }],
    ['role service_role', { authorization: `Bearer ${token({ role: 'service_role' })}` }],
  ];

  for (const [name, call] of [
    ['GET /api/app/account', (headers: Record<string, string>) => appFacts(headers)],
    ['POST /api/app/account/delete', (headers: Record<string, string>) => appDelete(VALID, headers)],
  ] as const) {
    it.each(refusedHeaders)(`${name} refuses %s with 401`, async (_, headers) => {
      await expectAnswer(await call(headers), 401, { error: 'unauthorized' });
      expect(h.getUser).not.toHaveBeenCalled();
      expectUntouched();
    });

    it(`${name} refuses a token whose sub is not the user GoTrue returns`, async () => {
      h.getUser.mockResolvedValue(found({ id: OTHER }));
      await expectAnswer(await call(BEARER), 401, { error: 'unauthorized' });
      expectUntouched();
    });

    it.each([
      ['a session signed out', new AuthSessionMissingError()],
      ['a token GoTrue refuses', new AuthApiError('bad jwt', 403, 'bad_jwt')],
    ])(`${name} refuses %s with 401`, async (_, error) => {
      h.getUser.mockResolvedValue({ data: { user: null }, error });
      await expectAnswer(await call(BEARER), 401, { error: 'unauthorized' });
      expectUntouched();
    });

    it(`${name} answers an Auth outage with 503, never 401`, async () => {
      h.getUser.mockResolvedValue({ data: { user: null }, error: new AuthRetryableFetchError('down', 502) });
      await expectAnswer(await call(BEARER), 503, { error: 'unavailable' });
      expectUntouched();
    });
  }

  for (const [name, call] of [
    ['GET /api/account', () => getWebFacts()],
    ['POST /api/account/delete', () => webDelete(VALID)],
  ] as const) {
    it(`${name} refuses a browser with no session with 401`, async () => {
      h.cookieGetUser.mockResolvedValue({ data: { user: null }, error: new AuthSessionMissingError() });
      await expectAnswer(await call(), 401, { error: 'unauthorized' });
      expectUntouched();
    });

    it.each([400, 401, 403])(`${name} refuses a session GoTrue answers %i with 401`, async (status) => {
      h.cookieGetUser.mockResolvedValue({ data: { user: null }, error: new AuthApiError('no', status, 'bad_jwt') });
      await expectAnswer(await call(), 401, { error: 'unauthorized' });
      expectUntouched();
    });

    it.each([
      ['a network error', new AuthRetryableFetchError('fetch failed', 0)],
      ['a 500', new AuthApiError('boom', 500, 'unexpected_failure')],
      ['an unreadable answer', new AuthUnknownError('bad json', null)],
    ])(`${name} answers %s from Auth with 503`, async (_, error) => {
      h.cookieGetUser.mockResolvedValue({ data: { user: null }, error });
      await expectAnswer(await call(), 503, { error: 'unavailable' });
      expectUntouched();
    });

    it(`${name} answers a getUser that throws with 503`, async () => {
      h.cookieGetUser.mockRejectedValue(new Error('socket hang up'));
      await expectAnswer(await call(), 503, { error: 'unavailable' });
      expectUntouched();
    });
  }

  it.each([
    ['a cross-site Origin', { origin: 'https://evil.example' }],
    ['a null Origin', { origin: 'null' }],
    ['Sec-Fetch-Site cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['Sec-Fetch-Site same-site', { 'sec-fetch-site': 'same-site' }],
  ])('POST /api/account/delete refuses %s with 403 before reading the session', async (_, headers) => {
    await expectAnswer(await webDelete(VALID, headers), 403, { error: 'forbidden' });
    expect(h.cookieGetUser).not.toHaveBeenCalled();
    expectUntouched();
  });

  it('no route answers to a bearer token on the web, or a cookie on the phone', async () => {
    // The web routes never read a bearer: with no cookie session, a perfectly
    // good token in the header is nobody.
    h.cookieGetUser.mockResolvedValue({ data: { user: null }, error: new AuthSessionMissingError() });
    expect((await webDelete(VALID, BEARER)).status).toBe(401);
    expectUntouched();
  });
});

// ── never for the wrong user ────────────────────────────────────────────────

describe('never for the wrong user', () => {
  it('a body naming another user is 400: the caller was verified first, nothing else was built', async () => {
    await expectAnswer(await appDelete({ ...VALID, userId: OTHER }), 400, { error: 'invalid' });
    expect(h.getUser).toHaveBeenCalledOnce();
    expectUntouched();
    await expectAnswer(await webDelete({ ...VALID, userId: OTHER }), 400, { error: 'invalid' });
    expect(h.cookieGetUser).toHaveBeenCalledOnce();
    expectUntouched();
  });

  it('an account that is not the caller’s is 409 changed, and nothing is deleted', async () => {
    await expectAnswer(await appDelete({ ...VALID, account: OTHER }), 409, { error: 'changed' });
    expect(h.getUser).toHaveBeenCalledOnce();
    expectUntouched();
    await expectAnswer(await webDelete({ ...VALID, account: OTHER }), 409, { error: 'changed' });
    expectUntouched();
  });

  it('the web: a browser that switched accounts under the dialog deletes nothing', async () => {
    // The dialog opened for USER; the cookie session is OTHER's by now.
    h.cookieGetUser.mockResolvedValue(found({ id: OTHER }));
    await expectAnswer(await webDelete(VALID), 409, { error: 'changed' });
    expectUntouched();
  });

  it('a valid call deletes the caller, exactly once, with the caller’s id', async () => {
    await expectAnswer(await appDelete(VALID), 200, { deleted: true, apple: 'not_revoked' });
    expect(h.deleteUser).toHaveBeenCalledExactlyOnceWith(USER);
    for (const call of h.getUserById.mock.calls) expect(call).toEqual([USER]);

    vi.clearAllMocks();
    await expectAnswer(await webDelete(VALID), 200, { deleted: true, apple: 'not_revoked' });
    expect(h.deleteUser).toHaveBeenCalledExactlyOnceWith(USER);
    for (const call of h.getUserById.mock.calls) expect(call).toEqual([USER]);
  });

  it('an account in upper case is the same account', async () => {
    await expectAnswer(await appDelete({ ...VALID, account: USER.toUpperCase() }), 200, {
      deleted: true,
      apple: 'not_revoked',
    });
    expect(h.deleteUser).toHaveBeenCalledExactlyOnceWith(USER);
  });

  it('every read in the facts routes is the caller’s', async () => {
    for (const read of [() => appFacts(), () => getWebFacts()]) {
      h.queries.length = 0;
      h.getUserById.mockClear();
      expect((await read()).status).toBe(200);
      expect(h.getUserById.mock.calls).toEqual([[USER]]);
      const tables = h.queries.map((q) => q.table).sort();
      // user_secrets twice: the key services, then the agent key through readAgentKey.
      expect(tables).toEqual(['model_connections', 'stake_events', 'user_extensions', 'user_secrets', 'user_secrets']);
      for (const q of h.queries) {
        const byUser = q.filters.filter(([column]) => column === 'user_id');
        expect(byUser, q.table).toEqual([['user_id', USER]]);
      }
    }
  });
});

// ── the body ────────────────────────────────────────────────────────────────

describe('the body', () => {
  const bad: [string, unknown][] = [
    ['no confirm', { account: USER }],
    ['no account', { confirm: 'DELETE' }],
    ['confirm in lower case', { ...VALID, confirm: 'delete' }],
    ['confirm with a space', { ...VALID, confirm: 'DELETE ' }],
    ['confirm true', { ...VALID, confirm: true }],
    ['an account that is not a UUID', { ...VALID, account: 'kirby' }],
    ['an account that is a number', { ...VALID, account: 42 }],
    ['an extra key', { ...VALID, force: true }],
    ['a list', [VALID]],
    ['null', null],
    ['a string', 'DELETE'],
    ['not JSON', '{"account":'],
  ];

  it.each(bad)('the phone refuses %s with 400', async (_, body) => {
    await expectAnswer(await appDelete(body), 400, { error: 'invalid' });
    expectUntouched();
  });

  it.each(bad)('the web refuses %s with 400', async (_, body) => {
    await expectAnswer(await webDelete(body), 400, { error: 'invalid' });
    expectUntouched();
  });

  it.each([
    ['empty', ''],
    ['1025 characters', 'a'.repeat(1025)],
    ['non-ASCII', 'cödé'],
    ['a space inside', 'a b'],
    ['null', null],
    ['a number', 1],
  ])('the phone refuses an appleCode that is %s', async (_, appleCode) => {
    await expectAnswer(await appDelete({ ...VALID, appleCode }), 400, { error: 'invalid' });
    expectUntouched();
  });

  it('the phone takes an appleCode of 1024 visible characters', async () => {
    expect((await appDelete({ ...VALID, appleCode: 'a'.repeat(1024) })).status).toBe(200);
  });

  it('the phone answers every body failure 400, its content type and size included', async () => {
    const res = await postAppDelete(
      new Request('https://do.dsul.app/api/app/account/delete', {
        method: 'POST',
        headers: { ...BEARER, 'content-type': 'text/plain' },
        body: JSON.stringify(VALID),
      }),
    );
    await expectAnswer(res, 400, { error: 'invalid' });
    await expectAnswer(await appDelete({ ...VALID, appleCode: 'a'.repeat(2048) }), 400, { error: 'invalid' });
    expectUntouched();
  });

  it('the web takes no appleCode', async () => {
    await expectAnswer(await webDelete(WITH_CODE), 400, { error: 'invalid' });
    expectUntouched();
  });

  it('the web refuses a body that is not JSON by its type with 415', async () => {
    await expectAnswer(await webDelete(VALID, { 'content-type': 'text/plain' }), 415, { error: 'unsupported_media' });
    await expectAnswer(await webDelete(VALID, { 'content-type': 'application/x-www-form-urlencoded' }), 415, {
      error: 'unsupported_media',
    });
    expectUntouched();
  });

  it('the web refuses 1025 bytes with 413', async () => {
    const body = JSON.stringify({ ...VALID, pad: '' });
    const padded = body.replace('"pad":""', `"pad":"${'x'.repeat(1025 - body.length)}"`);
    expect(Buffer.byteLength(padded)).toBe(1025);
    await expectAnswer(await webDelete(padded), 413, { error: 'too_large' });
    expectUntouched();
  });
});

// ── gone ────────────────────────────────────────────────────────────────────

describe('gone: the account was deleted by an earlier call whose answer was lost', () => {
  const userNotFound = () => ({
    data: { user: null },
    error: new AuthApiError('User from sub claim in JWT does not exist', 403, 'user_not_found'),
  });

  it('the phone’s retried delete is 200 unknown, and nothing is built', async () => {
    h.getUser.mockResolvedValue(userNotFound());
    await expectAnswer(await appDelete(VALID), 200, { deleted: true, apple: 'unknown' });
    expectUntouched();
  });

  it('the phone’s retried delete for an account that isn’t the token’s is 409', async () => {
    h.getUser.mockResolvedValue(userNotFound());
    await expectAnswer(await appDelete({ ...VALID, account: OTHER }), 409, { error: 'changed' });
    expectUntouched();
  });

  it('a bad body is still 400', async () => {
    h.getUser.mockResolvedValue(userNotFound());
    await expectAnswer(await appDelete({ ...VALID, confirm: 'nope' }), 400, { error: 'invalid' });
    expectUntouched();
  });

  it('the phone’s facts are 410 gone', async () => {
    h.getUser.mockResolvedValue(userNotFound());
    await expectAnswer(await appFacts(), 410, { error: 'gone' });
    expectUntouched();
  });

  it('the web’s, the same through the cookie session', async () => {
    h.cookieGetUser.mockResolvedValue(userNotFound());
    await expectAnswer(await webDelete(VALID), 200, { deleted: true, apple: 'unknown' });
    await expectAnswer(await webDelete({ ...VALID, account: OTHER }), 409, { error: 'changed' });
    await expectAnswer(await webDelete({ ...VALID, extra: 1 }), 400, { error: 'invalid' });
    await expectAnswer(await getWebFacts(), 410, { error: 'gone' });
    expectUntouched();
  });

  it('the web: gone with no readable session token is 401', async () => {
    h.cookieGetUser.mockResolvedValue(userNotFound());
    h.getSession.mockResolvedValue({ data: { session: null }, error: null });
    await expectAnswer(await webDelete(VALID), 401, { error: 'unauthorized' });
    h.getSession.mockResolvedValue({ data: { session: { access_token: 'junk' } }, error: null });
    await expectAnswer(await webDelete(VALID), 401, { error: 'unauthorized' });
    expectUntouched();
  });

  it('a facts read that finds the user gone is 410', async () => {
    h.getUserById.mockResolvedValue(notFound());
    await expectAnswer(await appFacts(), 410, { error: 'gone' });
    await expectAnswer(await getWebFacts(), 410, { error: 'gone' });
  });
});

// ── GoTrue's answers ────────────────────────────────────────────────────────

describe('GoTrue’s answers', () => {
  const deleteAnswers = (answer: unknown) =>
    h.deleteUser.mockImplementation(async () => {
      order.push('deleteUser');
      return answer;
    });
  const reads = (...answers: unknown[]) => {
    const queue = [...answers];
    h.getUserById.mockImplementation(async () => {
      order.push('getUserById');
      return queue.shift() ?? found();
    });
  };

  for (const [name, call] of [
    ['phone', (body: unknown) => appDelete(body)],
    ['web', (body: unknown) => webDelete(body)],
  ] as const) {
    it(`${name}: deleteUser answering 404 is 200`, async () => {
      deleteAnswers(notFound());
      await expectAnswer(await call(VALID), 200, { deleted: true, apple: 'not_revoked' });
    });

    it(`${name}: deleteUser 500 and the user still there is 500 failed`, async () => {
      deleteAnswers({ data: { user: null }, error: new AuthApiError('Database error deleting user', 500, 'unexpected_failure') });
      await expectAnswer(await call(VALID), 500, { error: 'failed' });
      expect(order).toEqual(['getUserById', 'deleteUser', 'getUserById']);
    });

    it(`${name}: deleteUser 500 and the second read finding no user is 200`, async () => {
      deleteAnswers({ data: { user: null }, error: new AuthApiError('gateway', 500, 'unexpected_failure') });
      reads(found(), notFound());
      await expectAnswer(await call(VALID), 200, { deleted: true, apple: 'not_revoked' });
    });

    it(`${name}: a retryable error and a second read failing too is 503`, async () => {
      deleteAnswers({ data: { user: null }, error: new AuthRetryableFetchError('down', 503) });
      reads(found(), { data: { user: null }, error: new AuthRetryableFetchError('down', 503) });
      await expectAnswer(await call(VALID), 503, { error: 'unavailable' });
    });

    it(`${name}: the first read failing is 503, and nothing is deleted`, async () => {
      reads({ data: { user: null }, error: new AuthRetryableFetchError('down', 0) });
      await expectAnswer(await call(VALID), 503, { error: 'unavailable' });
      expect(h.deleteUser).not.toHaveBeenCalled();
    });

    it(`${name}: no SUPABASE_SECRET_KEY is 503`, async () => {
      vi.stubEnv('SUPABASE_SECRET_KEY', '');
      await expectAnswer(await call(VALID), 503, { error: 'unavailable' });
      expect(h.deleteUser).not.toHaveBeenCalled();
    });
  }

  it('the facts routes: the user read failing is 503; no SUPABASE_SECRET_KEY is 503', async () => {
    h.getUserById.mockResolvedValue({ data: { user: null }, error: new AuthApiError('boom', 500, 'unexpected_failure') });
    await expectAnswer(await appFacts(), 503, { error: 'unavailable' });
    await expectAnswer(await getWebFacts(), 503, { error: 'unavailable' });
    h.getUserById.mockRejectedValue(new Error('socket hang up'));
    await expectAnswer(await appFacts(), 503, { error: 'unavailable' });
    vi.stubEnv('SUPABASE_SECRET_KEY', '');
    await expectAnswer(await appFacts(), 503, { error: 'unavailable' });
    await expectAnswer(await getWebFacts(), 503, { error: 'unavailable' });
  });

  it('a delete that failed and then found no user still revokes Apple’s tokens', async () => {
    deleteAnswers({ data: { user: null }, error: new AuthApiError('gateway', 500, 'unexpected_failure') });
    reads(found(), notFound());
    await expectAnswer(await appDelete(WITH_CODE), 200, { deleted: true, apple: 'revoked' });
    expect(order).toEqual(['getUserById', 'exchange', 'deleteUser', 'getUserById', 'revoke']);
  });
});

// ── Apple ───────────────────────────────────────────────────────────────────

describe('Sign in with Apple, from the phone', () => {
  it('exchanges the code, deletes, then revokes: revoked', async () => {
    await expectAnswer(await appDelete(WITH_CODE), 200, { deleted: true, apple: 'revoked' });
    expect(order).toEqual(['getUserById', 'exchange', 'deleteUser', 'revoke']);
    const exchange = formOf(0);
    expect([...exchange.keys()].sort()).toEqual(['client_id', 'client_secret', 'code', 'grant_type']);
    expect(exchange.get('client_id')).toBe('app.dsul.ios');
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('code')).toBe(CODE);
    expect(exchange.get('client_secret')?.split('.')).toHaveLength(3);
    expect(exchange.has('redirect_uri')).toBe(false);
    const revoke = formOf(1);
    expect(revoke.get('token')).toBe('RT-SENTINEL');
    expect(revoke.get('token_type_hint')).toBe('refresh_token');
    expect(revoke.get('client_id')).toBe('app.dsul.ios');
  });

  it('tokens for a different Apple ID are never revoked: not_revoked', async () => {
    apple({ token: async () => json(appleTokens('someone.else')) });
    await expectAnswer(await appDelete(WITH_CODE), 200, { deleted: true, apple: 'not_revoked' });
    expect(order).toEqual(['getUserById', 'exchange', 'deleteUser']);
  });

  it.each([
    ['the exchange answers 400 invalid_grant', { token: async () => json({ error: 'invalid_grant' }, 400) }],
    ['the revoke answers 400', { revoke: async () => json({ error: 'invalid_request' }, 400) }],
    ['the revoke’s fetch throws a TypeError', { revoke: async () => Promise.reject(new TypeError('terminated')) }],
  ])('deleted when %s: 200, not_revoked', async (_, answers) => {
    apple(answers);
    await expectAnswer(await appDelete(WITH_CODE), 200, { deleted: true, apple: 'not_revoked' });
    expect(h.deleteUser).toHaveBeenCalledExactlyOnceWith(USER);
  });

  it('deleted when the exchange times out: 200, not_revoked', async () => {
    vi.useFakeTimers();
    apple({ token: () => new Promise<Response>(() => {}) });
    const pending = appDelete(WITH_CODE);
    await vi.advanceTimersByTimeAsync(5000);
    await expectAnswer(await pending, 200, { deleted: true, apple: 'not_revoked' });
    expect(order).toEqual(['getUserById', 'exchange', 'deleteUser']);
  });

  it('a delete that fails with the user still there revokes nothing', async () => {
    h.deleteUser.mockResolvedValue({ data: { user: null }, error: new AuthApiError('boom', 500, 'unexpected_failure') });
    await expectAnswer(await appDelete(WITH_CODE), 500, { error: 'failed' });
    expect(order).toEqual(['getUserById', 'exchange', 'getUserById']);
    expect(h.fetch).toHaveBeenCalledOnce();
  });

  it('no Apple configuration: no Apple call, not_revoked for an Apple account', async () => {
    vi.stubEnv('APPLE_PRIVATE_KEY', '');
    await expectAnswer(await appDelete(WITH_CODE), 200, { deleted: true, apple: 'not_revoked' });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.deleteUser).toHaveBeenCalledOnce();
  });

  it('no Apple identity: no Apple call even with a code, none', async () => {
    h.getUserById.mockResolvedValue(found(theUser({ identities: identities([{ provider: 'google', id: '1234' }]) })));
    await expectAnswer(await appDelete(WITH_CODE), 200, { deleted: true, apple: 'none' });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('the web never calls Apple', async () => {
    await expectAnswer(await webDelete(VALID), 200, { deleted: true, apple: 'not_revoked' });
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

// ── logs ────────────────────────────────────────────────────────────────────

describe('logs', () => {
  it('carry no id, email, code, token, secret or row value on any path', async () => {
    await appFacts();
    await getWebFacts();
    await appDelete(WITH_CODE);
    apple({ revoke: async () => json({ error: 'invalid_client' }, 400) });
    await appDelete(WITH_CODE);
    apple({ token: async () => json(appleTokens('someone.else')) });
    await appDelete(WITH_CODE);
    h.deleteUser.mockResolvedValue({ data: { user: null }, error: new AuthApiError(`no ${USER} ${EMAIL}`, 500, 'unexpected_failure') });
    await appDelete(WITH_CODE);
    h.rows.model_connections = dbError('XX000');
    h.rows.user_extensions = dbError('57014');
    h.rows.user_secrets = dbError('XX000');
    await appFacts();

    const text = logged();
    expect(text).toContain('[account]');
    for (const secret of [
      USER,
      EMAIL,
      CODE,
      APPLE_ID,
      SECRET,
      'RT-SENTINEL',
      'AT-SENTINEL',
      'SENTINEL',
      'TEAM123456',
      'KEY1234567',
      'BEGIN',
      token(),
    ]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it('say what happened, in codes', async () => {
    await appDelete(WITH_CODE);
    apple({ revoke: async () => json({ error: 'invalid_client' }, 400) });
    await appDelete(WITH_CODE);
    const text = logged();
    expect(text).toContain('[account] deleted revoked');
    expect(text).toContain('[account] apple revoke invalid_client');
    expect(text).toContain('[account] deleted not_revoked');
  });
});

// ── facts ───────────────────────────────────────────────────────────────────

const FACTS_EXAMPLE = {
  userId: USER,
  email: EMAIL,
  appleIds: [APPLE_ID],
  appleRevocable: true,
  beeminder: true,
  ledger: true,
  openclaw: false,
  keyServices: ['Beeminder', 'Twilio'],
  modelProviderName: 'OpenAI',
};

describe('the facts', () => {
  const facts = async () => {
    const res = await appFacts();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    return res.json();
  };

  it('are the plan’s example from its rows, the same on both routes', async () => {
    expect(await facts()).toEqual(FACTS_EXAMPLE);
    expect(await (await getWebFacts()).json()).toEqual(FACTS_EXAMPLE);
    expect(Object.keys(await facts())).toEqual(Object.keys(FACTS_EXAMPLE));
  });

  it('a null email, no Apple identity, and nothing else connected', async () => {
    h.getUserById.mockResolvedValue(found(theUser({ email: '', identities: identities([{ provider: 'google', id: '1' }]) })));
    h.rows = {};
    expect(await facts()).toEqual({
      userId: USER,
      email: null,
      appleIds: [],
      appleRevocable: true,
      beeminder: false,
      ledger: false,
      openclaw: false,
      keyServices: [],
      modelProviderName: null,
    });
  });

  it('appleRevocable follows the configuration', async () => {
    vi.stubEnv('APPLE_IOS_CLIENT_ID', '');
    expect((await facts()).appleRevocable).toBe(false);
    vi.stubEnv('APPLE_IOS_CLIENT_ID', 'app.dsul.ios');
    vi.stubEnv('APPLE_PRIVATE_KEY', 'not a key');
    expect((await facts()).appleRevocable).toBe(false);
    vi.stubEnv('APPLE_PRIVATE_KEY', P8);
    expect((await facts()).appleRevocable).toBe(true);
  });

  it('a custom connection is named by its host', async () => {
    h.rows.model_connections = ok({ provider: 'custom', base_url: 'https://llm.example.net:8443/v1' });
    expect((await facts()).modelProviderName).toBe('llm.example.net');
    h.rows.model_connections = ok({ provider: 'anthropic', base_url: null });
    expect((await facts()).modelProviderName).toBe('Anthropic');
    h.rows.model_connections = ok(null);
    expect((await facts()).modelProviderName).toBeNull();
  });

  it('keyServices names every service whose key dsul held, in order, and never a value', async () => {
    h.rows.user_secrets = ok({
      reminder_secrets: {
        'voice-announcements': { token: 'SENTINEL-ha-token' },
        'phone-call': { authToken: 'SENTINEL-call-token' },
        'sms-nudge': { accountSid: 'SENTINEL-sms-sid' },
        beeminder: { authToken: 'SENTINEL-bee' },
      },
      openclaw_gateway_token: 'SENTINEL-gateway',
      openclaw_hooks_token: null,
      openclaw_api_key: null,
    });
    const res = await appFacts();
    const text = await res.text();
    expect(JSON.parse(text).keyServices).toEqual(['Beeminder', 'Twilio', 'Home Assistant', 'OpenClaw']);
    expect(JSON.parse(text).openclaw).toBe(true);
    expect(text).not.toContain('SENTINEL');
  });

  it('a hooks token alone names OpenClaw in the keys, not as connected', async () => {
    h.rows.user_secrets = ok({ reminder_secrets: null, openclaw_hooks_token: 'SENTINEL-hooks' });
    const body = await facts();
    expect(body.keyServices).toEqual(['OpenClaw']);
    expect(body.openclaw).toBe(false);
  });

  it.each([
    ['an unknown slug', { 'carrier-pigeon': { token: 'SENTINEL' } }],
    ['an unknown key', { beeminder: { password: 'SENTINEL' } }],
    ['an empty value', { beeminder: { authToken: '' } }],
    ['a value that is not a string', { 'sms-nudge': { authToken: 42 } }],
    ['a slug that is not an object', { beeminder: 'SENTINEL' }],
    ['config, not a secret', { 'sms-nudge': { to: '+15551234567' } }],
  ])('%s adds nothing', async (_, reminder_secrets) => {
    h.rows.user_secrets = ok({ reminder_secrets, openclaw_gateway_token: '', openclaw_hooks_token: '  ' });
    expect((await facts()).keyServices).toEqual([]);
  });

  it('ledger follows a stake_events row, asked for one at most', async () => {
    h.rows.stake_events = ok(null);
    expect((await facts()).ledger).toBe(false);
    const ledgerRead = h.queries.find((q) => q.table === 'stake_events');
    expect(ledgerRead?.limit).toBe(1);
    expect(ledgerRead?.columns).toBe('user_id');
  });

  it('beeminder asks for the enabled beeminder row only', async () => {
    h.rows.user_extensions = ok(null);
    expect((await facts()).beeminder).toBe(false);
    const read = h.queries.find((q) => q.table === 'user_extensions');
    expect(read?.filters).toEqual([
      ['user_id', USER],
      ['slug', 'beeminder'],
      ['enabled', true],
    ]);
  });

  it('a failing advisory read drops its line, logs its table and code, and still answers 200', async () => {
    h.rows.model_connections = dbError('XX000');
    const body = await facts();
    expect(body.modelProviderName).toBeNull();
    expect(body.beeminder).toBe(true);
    const facts_ = logs[0].mock.calls.filter((c) => c[0] === '[account] facts');
    expect(facts_).toEqual([['[account] facts', 'model_connections', 'XX000']]);
  });

  it('a read that throws is a failed read too', async () => {
    h.rows.stake_events = () => Promise.reject(new Error('socket hang up'));
    expect((await facts()).ledger).toBe(false);
    expect(logs[0].mock.calls).toContainEqual(['[account] facts', 'stake_events', 'threw']);
  });

  it('before 059: the agent key is found in user_settings, and the key lines still read', async () => {
    // user_secrets has no openclaw_api_key yet: readAgentKey asks the old column.
    h.rows.user_secrets = (call: { columns: string }) =>
      call.columns.includes('openclaw_api_key')
        ? dbError('42703')
        : ok({ reminder_secrets: { beeminder: { authToken: 'SENTINEL' } }, openclaw_gateway_token: null });
    h.rows.user_settings = ok({ openclaw_api_key: 'dsul_SENTINEL' });
    const res = await appFacts();
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ openclaw: true, keyServices: ['Beeminder'] });
    expect(text).not.toContain('SENTINEL');
    expect(h.queries.filter((q) => q.table === 'user_secrets').map((q) => q.columns)).toEqual([
      'reminder_secrets, openclaw_gateway_token, openclaw_hooks_token',
      'openclaw_api_key',
    ]);
    expect(h.queries.filter((q) => q.table === 'user_settings').map((q) => q.columns)).toEqual(['openclaw_api_key']);
    expect(logs[0].mock.calls.filter((c) => c[0] === '[account] facts')).toEqual([]);
  });

  it('after 059 the old column is never asked: the key lives in user_secrets', async () => {
    h.rows.user_settings = ok({ openclaw_api_key: 'dsul_SENTINEL' });
    expect((await facts()).openclaw).toBe(false);
    expect(h.queries.some((q) => q.table === 'user_settings')).toBe(false);
  });

  it('an agent key in user_secrets makes openclaw true', async () => {
    h.rows.user_secrets = ok({ openclaw_api_key: 'dsul_SENTINEL' });
    expect((await facts()).openclaw).toBe(true);
  });

  it('an agent key read that fails is "no", one line, and no database text', async () => {
    h.rows.user_secrets = (call: { columns: string }) =>
      call.columns === 'openclaw_api_key' ? dbError('XX000') : ok({ openclaw_gateway_token: null });
    const body = await facts();
    expect(body.openclaw).toBe(false);
    expect(logs[0].mock.calls.filter((c) => c[0] === '[account] facts')).toEqual([
      ['[account] facts', 'user_secrets', 'agent_key'],
    ]);
    expect(logged()).not.toContain('SENTINEL');
  });

  it.each(['42P01', 'PGRST205', '42703', 'PGRST204'])(
    'a missing schema (%s) is "no", silently',
    async (code) => {
      h.rows.model_connections = dbError(code);
      h.rows.user_extensions = dbError(code);
      const body = await facts();
      expect(body.modelProviderName).toBeNull();
      expect(body.beeminder).toBe(false);
      expect(logs[0].mock.calls.filter((c) => c[0] === '[account] facts')).toEqual([]);
    },
  );

  it('never contains a secret column’s value', async () => {
    h.rows.user_secrets = ok({
      reminder_secrets: {
        beeminder: { authToken: 'SENTINEL-1' },
        'sms-nudge': { accountSid: 'SENTINEL-2', authToken: 'SENTINEL-3' },
        'voice-announcements': { token: 'SENTINEL-4' },
      },
      openclaw_gateway_token: 'SENTINEL-5',
      openclaw_hooks_token: 'SENTINEL-6',
      openclaw_api_key: 'SENTINEL-7',
    });
    h.rows.user_settings = ok({ openclaw_api_key: 'SENTINEL-8' });
    h.rows.model_connections = ok({ provider: 'openai', base_url: null, key_ciphertext: 'SENTINEL-9' });
    for (const res of [await appFacts(), await getWebFacts()]) {
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain('SENTINEL');
    }
  });
});

// ── fixtures ────────────────────────────────────────────────────────────────

describe('the fixtures DsulCore reads', () => {
  const DIR = path.resolve(__dirname, '../fixtures/app');
  const FACTS = path.join(DIR, 'account-facts.json');
  const DELETED = path.join(DIR, 'account-deleted.json');
  const serialize = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

  it('are what the routes answer today', async () => {
    const facts = await (await appFacts()).json();
    const deleted = await (await appDelete(WITH_CODE)).json();
    expect(facts).toEqual(FACTS_EXAMPLE);
    expect(deleted).toEqual({ deleted: true, apple: 'revoked' });

    if (process.env.UPDATE_FIXTURES) {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(FACTS, serialize(facts));
      writeFileSync(DELETED, serialize(deleted));
    }
    // On drift: if the change is intended, regenerate with UPDATE_FIXTURES=1
    // and make the same change in ios/DsulCore (Account.swift).
    expect(existsSync(FACTS), `missing ${FACTS}; run with UPDATE_FIXTURES=1`).toBe(true);
    expect(existsSync(DELETED), `missing ${DELETED}; run with UPDATE_FIXTURES=1`).toBe(true);
    expect(readFileSync(FACTS, 'utf8')).toBe(serialize(facts));
    expect(readFileSync(DELETED, 'utf8')).toBe(serialize(deleted));
  });
});
