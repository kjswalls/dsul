import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/app/items — capture from the iPhone into the braindump.
 *
 * Three things matter beyond "a row lands":
 *   - it is the web's own capture (addTask with no bucket): same fields, same
 *     `order` rule, same `create` event, and the same silence toward the
 *     OpenClaw webhook, which the browser never reaches;
 *   - it is idempotent by the phone's id, so a retry after a lost response is
 *     a 200 and not a 500 on the primary key;
 *   - a collision with a row that is not this user's live task says nothing
 *     about that row.
 */

const USER = '6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';
const ITEM = '0b7e4a52-9c1d-4f3e-8a2b-5d6c7e8f9a0b';

type Result = { data?: unknown; error?: unknown; count?: number | null };
interface Query {
  table: string;
  calls: [string, unknown[]][];
}

const h = vi.hoisted(() => ({
  createClient: vi.fn(),
  notifyPlugins: vi.fn(),
}));

vi.mock('@supabase/supabase-js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
  createClient: h.createClient,
}));
vi.mock('@/lib/openclaw-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/openclaw-registry')>()),
  notifyPlugins: h.notifyPlugins,
}));

let queries: Query[] = [];
let respond: (q: Query) => Result;

/** A query builder: every method chains, and awaiting it asks `respond`. */
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
              .then(() => respond(q))
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

const called = (q: Query, method: string) => q.calls.filter(([m]) => m === method).map(([, args]) => args);
const op = (q: Query) => (['insert', 'update', 'select'] as const).find((m) => called(q, m).length > 0);
const inserts = (table: string) =>
  queries.filter((q) => q.table === table && op(q) === 'insert').map((q) => called(q, 'insert')[0][0] as Record<string, unknown>);

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = () =>
  [b64({ alg: 'HS256' }), b64({ sub: USER, role: 'authenticated', exp: Date.now() / 1000 + 3600 }), 'sig'].join('.');

import { POST } from '@/app/api/app/items/route';

const capture = (body: unknown) =>
  POST(
    new Request('https://do.dsul.app/api/app/items', {
      method: 'POST',
      headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

/** Wait out the fire-and-forget event insert. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let taskCount: number;
let insertResult: Result;
let existing: Record<string, unknown> | null;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://ref.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
  queries = [];
  taskCount = 5;
  insertResult = { data: null, error: null };
  existing = null;
  respond = (q) => {
    if (q.table === 'item_events') return { data: null, error: null };
    if (q.table !== 'items') return { data: null, error: { code: 'XX000', message: `unexpected ${q.table}` } };
    if (op(q) === 'insert') return insertResult;
    const select = called(q, 'select')[0];
    const head = (select?.[1] as { head?: boolean } | undefined)?.head;
    if (head) return { data: null, error: null, count: taskCount };
    return { data: existing, error: null };
  };
  h.createClient.mockImplementation(() => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: USER } }, error: null })) },
    from,
  }));
});

describe('POST /api/app/items', () => {
  it('creates the web’s braindump task, appended after every other task', async () => {
    const res = await capture({ id: ITEM, title: '  Buy stamps  ' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, id: ITEM });

    const [row] = inserts('items');
    expect(row).toMatchObject({
      id: ITEM,
      user_id: USER,
      type: 'task',
      title: 'Buy stamps',
      status: 'pending',
      is_scheduled: false,
      time_bucket: null,
      start_date: null,
      start_time: null,
      parent_item_id: null,
      order: 5,
      completed_dates: [],
      skipped_dates: [],
    });
  });

  it('counts `order` the way the store’s tasks.length does', async () => {
    await capture({ id: ITEM, title: 'Buy stamps' });
    const count = queries.find((q) => q.table === 'items' && op(q) === 'select')!;
    expect(called(count, 'select')).toEqual([['id', { count: 'exact', head: true }]]);
    // Every live task-like row that is not a subtask.
    expect(count.calls).toEqual(
      expect.arrayContaining([
        ['eq', ['user_id', USER]],
        ['neq', ['type', 'habit']],
        ['is', ['parent_item_id', null]],
        ['is', ['deleted_at', null]],
      ]),
    );
  });

  it('writes the create event, and fires no webhook', async () => {
    await capture({ id: ITEM, title: 'Buy stamps' });
    await settle();
    expect(inserts('item_events')).toEqual([
      { user_id: USER, item_id: ITEM, item_type: 'task', action: 'create', payload: { title: 'Buy stamps' } },
    ]);
    expect(h.notifyPlugins).not.toHaveBeenCalled();
  });

  it('stores the phone’s uppercase uuid in Postgres’s lowercase', async () => {
    const res = await capture({ id: ITEM.toUpperCase(), title: 'Buy stamps' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, id: ITEM });
    expect(inserts('items')[0].id).toBe(ITEM);
  });

  describe('a retry', () => {
    const duplicate = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "items_pkey"' } };

    it('of a capture that landed answers 200 with the same body', async () => {
      insertResult = duplicate;
      existing = { id: ITEM, type: 'task', deleted_at: null };
      const res = await capture({ id: ITEM, title: 'Buy stamps' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, id: ITEM });
      // Re-read by id under the user's client, which is what makes "visible"
      // mean "theirs".
      const reread = queries.filter((q) => q.table === 'items' && op(q) === 'select').at(-1)!;
      expect(reread.calls).toContainEqual(['eq', ['id', ITEM]]);
      expect(h.notifyPlugins).not.toHaveBeenCalled();
    });

    it('also lands after the title was edited in between', async () => {
      // Matched on owner, type and liveness, never on title: an edit made on
      // the web before the retry is not a different capture.
      insertResult = duplicate;
      existing = { id: ITEM, type: 'task', deleted_at: null, title: 'Buy stamps (2nd class)' };
      expect((await capture({ id: ITEM, title: 'Buy stamps' })).status).toBe(200);
    });

    it.each([
      ['someone else’s row, invisible under RLS', null],
      ['a trashed row', { id: ITEM, type: 'task', deleted_at: '2026-10-01T10:00:00+00:00' }],
      ['a row of another type', { id: ITEM, type: 'habit', deleted_at: null }],
    ])('against %s is a 409 that says nothing about it', async (_, row) => {
      insertResult = duplicate;
      existing = row;
      const res = await capture({ id: ITEM, title: 'Buy stamps' });
      expect(res.status).toBe(409);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: 'conflict' });
      expect(text).not.toMatch(/duplicate|items_pkey|habit|deleted/);
    });
  });

  it('500s a count that fails, before anything is inserted', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const base = respond;
    respond = (q) =>
      q.table === 'items' && op(q) === 'select' && (called(q, 'select')[0]?.[1] as { head?: boolean } | undefined)?.head
        ? { data: null, error: { code: 'XX000', message: 'internal error' }, count: null }
        : base(q);
    const res = await capture({ id: ITEM, title: 'Buy stamps' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'failed' });
    expect(inserts('items')).toEqual([]);
    spy.mockRestore();
  });

  it('500s any other insert failure without the database’s words', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    insertResult = { data: null, error: { code: '23514', message: 'new row violates check constraint "items_status_check"' } };
    const res = await capture({ id: ITEM, title: 'Buy stamps' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'failed' });
    spy.mockRestore();
  });

  it.each([
    ['invalid JSON', '{'],
    ['no id', { title: 'Buy stamps' }],
    ['an id that is not a uuid', { id: 'abc', title: 'Buy stamps' }],
    ['no title', { id: ITEM }],
    ['a blank title', { id: ITEM, title: '   ' }],
    ['a title over 500 characters', { id: ITEM, title: 'x'.repeat(501) }],
    ['a title that is not a string', { id: ITEM, title: 42 }],
  ])('400s %s and writes nothing', async (_, body) => {
    const res = await capture(body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid');
    expect(inserts('items')).toEqual([]);
  });

  it('takes a 500-character title', async () => {
    expect((await capture({ id: ITEM, title: 'x'.repeat(500) })).status).toBe(201);
  });
});
