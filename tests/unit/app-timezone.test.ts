import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/app/timezone — the iPhone's zone, stored as the account's, by the
 * web's own write (lib/user-timezone.ts): validated as an IANA name, skipped
 * when it is already what is stored, upserted otherwise.
 */

const USER = '6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';

type Result = { data?: unknown; error?: unknown };
interface Query {
  table: string;
  calls: [string, unknown[]][];
}

const h = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock('@supabase/supabase-js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
  createClient: h.createClient,
}));

let queries: Query[] = [];
let readResult: Result;
let upsertResult: Result;

function from(table: string) {
  const q: Query = { table, calls: [] };
  queries.push(q);
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve()
              .then(() => (q.calls.some(([m]) => m === 'upsert') ? upsertResult : readResult))
              .then(resolve, reject);
        }
        return (...args: unknown[]) => {
          q.calls.push([String(prop), args]);
          return builder;
        };
      },
    },
  );
  return builder;
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = () =>
  [b64({ alg: 'HS256' }), b64({ sub: USER, role: 'authenticated', exp: Date.now() / 1000 + 3600 }), 'sig'].join('.');

import { POST } from '@/app/api/app/timezone/route';

const post = (body: unknown) =>
  POST(
    new Request('https://do.dsul.app/api/app/timezone', {
      method: 'POST',
      headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

const upserts = () => queries.filter((q) => q.calls.some(([m]) => m === 'upsert'));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://ref.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
  queries = [];
  readResult = { data: { timezone: 'America/Los_Angeles' }, error: null };
  upsertResult = { data: null, error: null };
  h.createClient.mockImplementation(() => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: USER } }, error: null })) },
    from,
  }));
});

describe('POST /api/app/timezone', () => {
  it('stores a zone that differs, as the user, on their own row', async () => {
    const res = await post({ timezone: 'Europe/Paris' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(queries[0].calls).toEqual([
      ['select', ['timezone']],
      ['eq', ['user_id', USER]],
      ['maybeSingle', []],
    ]);
    expect(upserts().map((q) => q.calls)).toEqual([
      [['upsert', [{ user_id: USER, timezone: 'Europe/Paris' }, { onConflict: 'user_id' }]]],
    ]);
  });

  it('writes nothing when the zone is already stored', async () => {
    const res = await post({ timezone: 'America/Los_Angeles' });
    expect(await res.json()).toEqual({ ok: true, unchanged: true });
    expect(upserts()).toEqual([]);
  });

  it('creates the row for an account that has none', async () => {
    readResult = { data: null, error: null };
    expect(await (await post({ timezone: 'Asia/Kolkata' })).json()).toEqual({ ok: true });
    expect(upserts()).toHaveLength(1);
  });

  it('400s a zone the runtime does not know, a missing one, an overlong one and bad JSON', async () => {
    for (const body of [{ timezone: 'Mars/Olympus_Mons' }, {}, { timezone: 42 }, { timezone: 'A'.repeat(101) }, 'not json', 'null']) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error).toBe('invalid');
    }
    expect(queries).toEqual([]);
  });

  it('500s a failed write without the database’s words', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    upsertResult = { data: null, error: { code: 'XX000', message: 'disk full on node 7' } };
    const res = await post({ timezone: 'Europe/Paris' });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('disk full');
    spy.mockRestore();
  });

  it('401s a token PostgREST rejects, so the phone refreshes', async () => {
    readResult = { data: null, error: { code: 'PGRST301', message: 'JWT expired' } };
    expect((await post({ timezone: 'Europe/Paris' })).status).toBe(401);
  });
});
