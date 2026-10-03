import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthUnknownError,
} from '@supabase/supabase-js';

/**
 * lib/app-auth.ts — the iPhone app's credential check, which every /api/app
 * route goes through.
 *
 * The two failure modes this guards are opposite, and both are expensive:
 *   - letting the wrong thing in: a cookie (CSRF), a `dsul_` agent key
 *     (service-role power, never expires), an expired or non-user token;
 *   - shutting the right thing out: an Auth outage answered as 401 sends every
 *     signed-in phone into refresh-and-retry against prod Auth at once.
 */

const USER = '6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';

const h = vi.hoisted(() => ({
  createClient: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock('@supabase/supabase-js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
  createClient: h.createClient,
}));
// The routes below import lib/db, which reaches the webhook registry; nothing
// in this file should ever get that far.
vi.mock('@/lib/openclaw-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/openclaw-registry')>()),
  notifyPlugins: vi.fn(),
}));

import { authenticateAppRequest, dbErrorResponse, precheckToken } from '@/lib/app-auth';
import { GET as getPlanner } from '@/app/api/app/planner/route';
import { POST as postCapture } from '@/app/api/app/items/route';
import { POST as postItem } from '@/app/api/app/items/[id]/route';
import { ITEM_WRITES } from '@/lib/app-api';

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
const token = (claims: Record<string, unknown> = {}) =>
  [
    b64({ alg: 'HS256', typ: 'JWT' }),
    b64({ sub: USER, role: 'authenticated', exp: now() + 3600, ...claims }),
    'c2lnbmF0dXJl',
  ].join('.');

const request = (headers: Record<string, string> = {}) =>
  new Request('https://do.dsul.app/api/app/planner', { headers });
const bearer = (jwt: string) => request({ authorization: `Bearer ${jwt}` });

// Stands in for a supabase-js client: only the auth half is reached here.
const fakeClient = { auth: { getUser: h.getUser } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://ref.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
  h.createClient.mockReturnValue(fakeClient);
  h.getUser.mockResolvedValue({ data: { user: { id: USER, email: 'kirby@example.com' } }, error: null });
});

describe('the cheap pre-check', () => {
  it('lets a live user token through to Auth', () => {
    expect(precheckToken(token(), now())).toEqual({ sub: USER });
  });

  it.each([
    ['empty', ''],
    ['a dsul_ agent key', `dsul_${'ab'.repeat(32)}`],
    ['two segments', token().split('.').slice(0, 2).join('.')],
    ['four segments', `${token()}.x`],
    ['padding in a segment', token().replace('.', '=.')],
    ['a payload that is not JSON', `${b64({})}.${Buffer.from('not json').toString('base64url')}.sig`],
    ['a payload that is not an object', `${b64({})}.${b64([1, 2])}.sig`],
    ['role anon', token({ role: 'anon' })],
    ['role service_role', token({ role: 'service_role' })],
    ['no role', token({ role: undefined })],
    ['expired', token({ exp: now() - 1 })],
    ['expiring this second', token({ exp: now() })],
    ['exp as a string', token({ exp: String(now() + 3600) })],
    ['no exp', token({ exp: undefined })],
    ['a sub that is not a uuid', token({ sub: 'kirby' })],
    ['no sub', token({ sub: undefined })],
    ['over 4096 characters', token({ pad: 'x'.repeat(4096) })],
  ])('refuses %s', (_, jwt) => {
    expect(precheckToken(jwt, now())).toBeNull();
  });
});

describe('authenticateAppRequest', () => {
  it('answers with the user and a client that runs as them', async () => {
    const jwt = token();
    const auth = await authenticateAppRequest(bearer(jwt));
    expect(auth).toEqual({ userId: USER, client: fakeClient });
    // The anon key plus the caller's JWT, so RLS scopes every statement, and
    // a client that never keeps, refreshes or hunts for a session of its own.
    expect(h.createClient).toHaveBeenCalledExactlyOnceWith('https://ref.supabase.co', 'anon-key', {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    // Asked about THIS token, which is the revocation check.
    expect(h.getUser).toHaveBeenCalledExactlyOnceWith(jwt);
  });

  it.each([
    ['no header', {}],
    ['a lowercase scheme', { authorization: `bearer ${token()}` }],
    ['Basic', { authorization: `Basic ${token()}` }],
    ['a bare token', { authorization: token() }],
    ['a dsul_ agent key', { authorization: `Bearer dsul_${'ab'.repeat(32)}` }],
    ['an expired token', { authorization: `Bearer ${token({ exp: now() - 60 })}` }],
    ['role anon', { authorization: `Bearer ${token({ role: 'anon' })}` }],
    // A signed-in browser's cookie, with a perfectly good JWT inside it. Read
    // as a credential, it would make every POST here forgeable cross-site.
    ['a cookie only', { cookie: `sb-ref-auth-token=${encodeURIComponent(JSON.stringify([token()]))}` }],
  ])('401s %s without asking Auth', async (_, headers) => {
    const res = (await authenticateAppRequest(request(headers))) as Response;
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(h.getUser).not.toHaveBeenCalled();
  });

  it('401s a session Auth says is gone', async () => {
    // session_not_found: signed out on the web (a global sign-out) since the
    // token was minted. auth-js turns it into AuthSessionMissingError.
    h.getUser.mockResolvedValue({ data: { user: null }, error: new AuthSessionMissingError() });
    expect(((await authenticateAppRequest(bearer(token()))) as Response).status).toBe(401);
  });

  it.each([401, 403])('401s a token Auth refuses with %i', async (status) => {
    h.getUser.mockResolvedValue({ data: { user: null }, error: new AuthApiError('bad jwt', status, 'bad_jwt') });
    expect(((await authenticateAppRequest(bearer(token()))) as Response).status).toBe(401);
  });

  it('401s a user who is not the token’s subject', async () => {
    h.getUser.mockResolvedValue({
      data: { user: { id: '00000000-0000-4000-8000-000000000000' } },
      error: null,
    });
    expect(((await authenticateAppRequest(bearer(token()))) as Response).status).toBe(401);
  });

  it.each([
    ['a network error', new AuthRetryableFetchError('fetch failed', 0)],
    ['a 503 from Auth', new AuthRetryableFetchError('unavailable', 503)],
    ['a 500 from Auth', new AuthApiError('boom', 500, 'unexpected_failure')],
    ['a 429 from Auth', new AuthApiError('slow down', 429, 'over_request_rate_limit')],
    ['an unreadable answer', new AuthUnknownError('bad json', null)],
  ])('503s %s, never 401', async (_, error) => {
    h.getUser.mockResolvedValue({ data: { user: null }, error });
    const res = (await authenticateAppRequest(bearer(token()))) as Response;
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await res.json()).toEqual({ error: 'unavailable' });
  });

  it('503s when getUser throws', async () => {
    h.getUser.mockRejectedValue(new Error('socket hang up'));
    expect(((await authenticateAppRequest(bearer(token()))) as Response).status).toBe(503);
  });

  it('503s when the deployment has no Supabase config', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
    expect(((await authenticateAppRequest(bearer(token()))) as Response).status).toBe(503);
    expect(h.createClient).not.toHaveBeenCalled();
  });
});

describe('dbErrorResponse', () => {
  it.each(['PGRST301', 'PGRST303'])('maps %s, the token’s fault, to 401', async (code) => {
    const res = dbErrorResponse({ code, message: 'JWT expired' }, 'test');
    expect(res.status).toBe(401);
  });

  it('answers anything else with a bare 500 that leaks no database text', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = dbErrorResponse(
      { code: '23505', message: 'duplicate key value violates unique constraint "items_pkey"', details: 'Key (id)=(…) already exists.' },
      'test',
    );
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'failed' });
    expect(text).not.toMatch(/duplicate|Key \(id\)/);
    spy.mockRestore();
  });
});

describe('every /api/app route is behind it', () => {
  const ITEM = '11111111-1111-4111-8111-111111111111';
  /** One intent on POST /api/app/items/:id: each is listed, so a new one is too. */
  const itemWrite =
    (body: Record<string, unknown>) =>
    (headers: Record<string, string>) =>
      postItem(
        new Request(`https://do.dsul.app/api/app/items/${ITEM}`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: ITEM }) },
      );
  const calls: [string, (headers: Record<string, string>) => Promise<Response>][] = [
    ['GET /api/app/planner', (headers) => getPlanner(new Request('https://do.dsul.app/api/app/planner', { headers }))],
    [
      'POST /api/app/items',
      (headers) =>
        postCapture(
          new Request('https://do.dsul.app/api/app/items', {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ id: ITEM, title: 'Buy stamps' }),
          }),
        ),
    ],
    ['POST /api/app/items/:id complete', itemWrite({ action: 'complete', date: '2026-10-02', done: true })],
    ['POST /api/app/items/:id schedule', itemWrite({ action: 'schedule', date: '2026-10-02', startTime: '09:15' })],
    ['POST /api/app/items/:id skip', itemWrite({ action: 'skip', date: '2026-10-02', skipped: true })],
    ['POST /api/app/items/:id move', itemWrite({ action: 'move', date: '2026-10-03' })],
    ['POST /api/app/items/:id pause', itemWrite({ action: 'pause', paused: true, timeZone: 'Europe/Paris' })],
  ];

  it('lists every intent the item route takes', () => {
    const listed = calls.map(([name]) => name).filter((name) => name.startsWith('POST /api/app/items/:id '));
    expect(listed.map((name) => name.split(' ').at(-1))).toEqual(ITEM_WRITES);
  });

  for (const [name, call] of calls) {
    it(`${name} refuses a missing token, a dsul_ key, a cookie, an expired token and role anon`, async () => {
      const refused: Record<string, string>[] = [
        {},
        { authorization: `Bearer dsul_${'ab'.repeat(32)}` },
        { cookie: `sb-ref-auth-token=${token()}` },
        { authorization: `Bearer ${token({ exp: now() - 60 })}` },
        { authorization: `Bearer ${token({ role: 'anon' })}` },
      ];
      for (const headers of refused) {
        const res = await call(headers);
        expect(res.status, JSON.stringify(headers)).toBe(401);
      }
      expect(h.createClient).not.toHaveBeenCalled();
    });

    it(`${name} answers an Auth outage with 503`, async () => {
      h.getUser.mockResolvedValue({ data: { user: null }, error: new AuthRetryableFetchError('down', 502) });
      const res = await call({ authorization: `Bearer ${token()}` });
      expect(res.status).toBe(503);
    });
  }
});
