// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /api/ai/conversations/** end to end, over the REAL lib/ai-server/conversations.ts
 * and a recording stand-in for the session's own Supabase client: each route's
 * order of checks (401, 403, 415/413/400, ids, owner, 429), what reaches the
 * database, and that no failure answers with, or logs, what the user typed.
 */

type Op = [string, unknown[]];
interface Call {
  table: string | null;
  rpc: string | null;
  args: unknown;
  ops: Op[];
}
type Answer = { data: unknown; error: unknown };

const h = vi.hoisted(() => {
  const state = {
    user: { id: 'aaaaaaaa-0000-4000-8000-00000000000a' } as { id: string } | null,
    calls: [] as Array<{ table: string | null; rpc: string | null; args: unknown; ops: Array<[string, unknown[]]> }>,
    respond: (() => ({ data: null, error: null })) as (call: {
      table: string | null;
      rpc: string | null;
      args: unknown;
      ops: Array<[string, unknown[]]>;
    }) => { data: unknown; error: unknown },
    throwOnQuery: null as Error | null,
  };
  function chain(call: (typeof state.calls)[number]): unknown {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
              Promise.resolve()
                .then(() => state.respond(call))
                .then(resolve, reject);
          }
          return (...args: unknown[]) => {
            call.ops.push([String(prop), args]);
            return proxy;
          };
        },
      }
    );
    return proxy;
  }
  const client = {
    auth: {
      getUser: async () => ({ data: { user: state.user }, error: state.user ? null : { message: 'no session' } }),
    },
    from: (table: string) => {
      if (state.throwOnQuery) throw state.throwOnQuery;
      const call = { table, rpc: null, args: undefined, ops: [] as Array<[string, unknown[]]> };
      state.calls.push(call);
      return chain(call);
    },
    rpc: (name: string, args: unknown) => {
      if (state.throwOnQuery) throw state.throwOnQuery;
      const call = { table: null, rpc: name, args, ops: [] as Array<[string, unknown[]]> };
      state.calls.push(call);
      return chain(call);
    },
  };
  return { state, client };
});

vi.mock('@/lib/supabase-server', () => ({ createClient: vi.fn(async () => h.client) }));
vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: vi.fn(() => {
    throw new Error('the service role must never be reached from a conversations route');
  }),
}));
vi.mock('@/lib/ai-server/rate-limit', () => ({ takeToken: vi.fn(() => true) }));

import * as listRoute from '@/app/api/ai/conversations/route';
import * as searchRoute from '@/app/api/ai/conversations/search/route';
import * as oneRoute from '@/app/api/ai/conversations/[id]/route';
import * as turnsRoute from '@/app/api/ai/conversations/[id]/turns/route';
import { decodeCursor, encodeCursor } from '@/lib/ai-server/conversations';
import { takeToken } from '@/lib/ai-server/rate-limit';
import { createServiceClient } from '@/lib/supabase-service';

const ORIGIN = 'https://do.dsul.app';
const USER = 'aaaaaaaa-0000-4000-8000-00000000000a';
const STRANGER = 'bbbbbbbb-0000-4000-8000-00000000000b';
const CID = 'c0000000-0000-4000-8000-0000000000a1';
const OTHER = 'c0000000-0000-4000-8000-0000000000a2';
const ITEM = '11111111-0000-4000-8000-0000000000a1';
const U1 = 'd0000000-0000-4000-8000-000000000001';
const R1 = 'd0000000-0000-4000-8000-000000000002';
const TS = '2026-10-02T09:15:42.123456+00:00';
const SENTINEL = 'SENTINEL-what-the-user-typed';
const MISSING = ['42P01', 'PGRST205', 'PGRST202', '42883', '42703', 'PGRST204'];

const NUL = String.fromCharCode(0);
const HIGH = String.fromCharCode(0xd83d);
const EMOJI = HIGH + String.fromCharCode(0xde00);
const CJK = String.fromCharCode(0x4e2d);

function convRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CID,
    item_id: null,
    title: 'Plan my day',
    renamed: false,
    starred: false,
    answerer: 'model',
    openclaw_seen: false,
    added_count: 0,
    steps_count: 0,
    moved_count: 0,
    changed_count: 0,
    message_count: 2,
    last_message_at: TS,
    created_at: TS,
    ...over,
  };
}

function msgRow(pos: number): Record<string, unknown> {
  const user = pos % 2 === 1;
  return {
    id: `d0000000-0000-4000-8000-${String(pos).padStart(12, '0')}`,
    pos,
    role: user ? 'user' : 'assistant',
    content: `message ${pos}`,
    status: 'complete',
    error_code: null,
    reply_to: user ? null : `d0000000-0000-4000-8000-${String(pos - 1).padStart(12, '0')}`,
    answerer: user ? null : 'openclaw',
    model: null,
    created_at: TS,
  };
}

function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

const user = (o: Record<string, unknown> = {}) => ({ id: U1, role: 'user', content: 'plan my day', ...o });
const reply = (o: Record<string, unknown> = {}) => ({
  id: R1,
  role: 'assistant',
  content: 'Here is a plan.',
  replyTo: U1,
  answerer: 'model',
  model: 'gpt-4o-mini',
  ...o,
});
const turnBody = (o: Record<string, unknown> = {}) => ({
  ownerId: USER,
  create: { itemId: null, title: 'Plan my day' },
  messages: [user(), reply()],
  ...o,
});

const list = (query = '', headers?: Record<string, string>) =>
  listRoute.GET(req('GET', `/api/ai/conversations${query}`, undefined, headers));
const search = (body: unknown, headers?: Record<string, string>) =>
  searchRoute.POST(req('POST', '/api/ai/conversations/search', body, headers));
const thread = (id = CID, query = '', headers?: Record<string, string>) =>
  oneRoute.GET(req('GET', `/api/ai/conversations/${id}${query}`, undefined, headers), idParams(id));
const patch = (body: unknown, id = CID, headers?: Record<string, string>) =>
  oneRoute.PATCH(req('PATCH', `/api/ai/conversations/${id}`, body, headers), idParams(id));
const del = (id = CID, headers?: Record<string, string>) =>
  oneRoute.DELETE(req('DELETE', `/api/ai/conversations/${id}`, undefined, headers), idParams(id));
const turns = (body: unknown, id = CID, headers?: Record<string, string>) =>
  turnsRoute.POST(req('POST', `/api/ai/conversations/${id}/turns`, body, headers), idParams(id));

/** Every handler: name, rate bucket, the op its log line names, and a thunk over extra headers. */
const ROUTES: Array<[string, string, string, (headers?: Record<string, string>) => Promise<Response>]> = [
  ['list GET', 'conv_read', 'list', (hd) => list('', hd)],
  ['item GET', 'conv_read', 'item', (hd) => list(`?itemId=${ITEM}`, hd)],
  ['search POST', 'conv_search', 'search', (hd) => search({ q: 'plan' }, hd)],
  ['thread GET', 'conv_read', 'thread', (hd) => thread(CID, '', hd)],
  ['PATCH', 'conv_write', 'patch', (hd) => patch({ starred: true }, CID, hd)],
  ['DELETE', 'conv_write', 'delete', (hd) => del(CID, hd)],
  ['turns POST', 'conv_write', 'append', (hd) => turns(turnBody(), CID, hd)],
];
const STATE_CHANGING = ROUTES.filter(([name]) => ['search POST', 'PATCH', 'DELETE', 'turns POST'].includes(name));
const WITH_BODY: Array<[string, number, (body: string, headers?: Record<string, string>) => Promise<Response>]> = [
  ['search POST', 1_024, (b, hd) => search(b, hd)],
  ['PATCH', 4_096, (b, hd) => patch(b, CID, hd)],
  ['turns POST', 200_000, (b, hd) => turns(b, CID, hd)],
];

let logs: unknown[][];

beforeEach(() => {
  h.state.user = { id: USER };
  h.state.calls = [];
  h.state.respond = () => ({ data: null, error: null });
  h.state.throwOnQuery = null;
  vi.mocked(takeToken).mockReset();
  vi.mocked(takeToken).mockReturnValue(true);
  vi.mocked(createServiceClient).mockClear();
  logs = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args);
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The JSON body, after checking the response is never cached and never carries the sentinel. */
async function json(res: Response): Promise<Record<string, unknown>> {
  expect(res.headers.get('cache-control')).toBe('no-store');
  const text = await res.text();
  expect(text).not.toContain('SENTINEL');
  return JSON.parse(text) as Record<string, unknown>;
}

/** A respond() that answers every query the way a working database would, for one conversation. */
function healthy(call: Call): Answer {
  if (call.rpc === 'chat_append') return { data: { status: 'ok', inserted: 2, messageCount: 2 }, error: null };
  if (call.rpc === 'chat_note_changes') return { data: [convRow()], error: null };
  if (call.rpc === 'chat_search') return { data: [], error: null };
  if (call.table === 'chat_messages') return { data: [msgRow(2), msgRow(1)], error: null };
  const names = call.ops.map(([n]) => n);
  if (names.includes('delete')) return { data: [{ id: CID }], error: null };
  if (names.includes('maybeSingle')) return { data: convRow(), error: null };
  return { data: [convRow()], error: null };
}

describe('every route', () => {
  it.each(ROUTES)('%s: no session is 401, before anything reaches the database', async (_name, _bucket, _op, run) => {
    h.state.user = null;
    const res = await run();
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ error: 'unauthorized' });
    expect(h.state.calls).toEqual([]);
    expect(takeToken).not.toHaveBeenCalled();
  });

  it.each(STATE_CHANGING)('%s: a cross-site request is 403', async (_name, _bucket, _op, run) => {
    const variants: Array<Record<string, string>> = [
      { origin: 'https://evil.example' },
      { 'sec-fetch-site': 'cross-site' },
      { origin: 'null' },
    ];
    for (const headers of variants) {
      const res = await run(headers);
      expect(res.status).toBe(403);
      expect(await json(res)).toEqual({ error: 'forbidden' });
    }
    expect(h.state.calls).toEqual([]);
  });

  it.each(ROUTES)('%s: an empty bucket is 429, after validation and before the database', async (_name, bucket, _op, run) => {
    vi.mocked(takeToken).mockReturnValue(false);
    const res = await run();
    expect(res.status).toBe(429);
    expect(await json(res)).toEqual({ error: 'busy' });
    expect(takeToken).toHaveBeenCalledWith(USER, bucket);
    expect(h.state.calls).toEqual([]);
  });

  it.each(ROUTES)('%s: 503 unavailable for each missing-schema code (057 not applied)', async (_name, _bucket, _op, run) => {
    for (const code of MISSING) {
      h.state.respond = () => ({ data: null, error: { code, message: SENTINEL } });
      const res = await run();
      expect(res.status, code).toBe(503);
      expect(await json(res)).toEqual({ error: 'unavailable' });
    }
    expect(logs).toEqual([]);
  });

  it.each(ROUTES)('%s: a database error is 500 server, and the log has its code only', async (_name, _bucket, op, run) => {
    h.state.respond = () => ({
      data: null,
      error: { code: 'XX000', message: SENTINEL, details: `Failing row contains (${SENTINEL})`, hint: SENTINEL },
    });
    const res = await run();
    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ error: 'server' });
    expect(logs).toEqual([['[ai] conv', op, 'failed', 'XX000']]);
  });

  it.each(ROUTES)('%s: a throw is 500 server, and the log has its name only', async (_name, _bucket, op, run) => {
    h.state.throwOnQuery = new TypeError(`boom ${SENTINEL}`);
    const res = await run();
    expect(res.status).toBe(500);
    expect(await json(res)).toEqual({ error: 'server' });
    expect(logs).toEqual([['[ai] conv', op, 'threw', 'TypeError']]);
  });

  it.each(ROUTES)('%s: answers 200 on a healthy database, through the session client only', async (_name, _bucket, _op, run) => {
    h.state.respond = healthy;
    const res = await run();
    expect(res.status).toBe(200);
    await json(res);
    expect(h.state.calls.length).toBeGreaterThan(0);
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });
});

describe('the routes with a body', () => {
  it.each(WITH_BODY)('%s: 415 for anything but JSON', async (_name, _max, run) => {
    const res = await run('{"q":"plan"}', { 'content-type': 'text/plain' });
    expect(res.status).toBe(415);
    expect(await json(res)).toEqual({ error: 'unsupported_media' });
    expect(h.state.calls).toEqual([]);
  });

  it.each(WITH_BODY)('%s: 413 past its byte cap', async (_name, max, run) => {
    const res = await run(JSON.stringify({ q: 'x'.repeat(max) }));
    expect(res.status).toBe(413);
    expect(await json(res)).toEqual({ error: 'too_large' });
    expect(h.state.calls).toEqual([]);
  });

  it.each(WITH_BODY)('%s: 400 for a body that is not JSON', async (_name, _max, run) => {
    const res = await run('{"q": ');
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'invalid' });
    expect(h.state.calls).toEqual([]);
  });
});

describe('GET /api/ai/conversations', () => {
  it('the first page: non-starred newest first, EVERY starred row (51 of them), openclawSeen on each', async () => {
    const starred = Array.from({ length: 51 }, (_, i) =>
      convRow({ id: `c0000000-0000-4000-8000-${String(i).padStart(12, '0')}`, starred: true, openclaw_seen: i % 2 === 0 })
    );
    h.state.respond = (call) =>
      call.ops.some(([n, a]) => n === 'eq' && a[0] === 'starred' && a[1] === true)
        ? { data: starred, error: null }
        : { data: [convRow({ openclaw_seen: true })], error: null };
    const res = await list();
    expect(res.status).toBe(200);
    const body = (await json(res)) as {
      conversations: Array<Record<string, unknown>>;
      starred: Array<Record<string, unknown>>;
      nextCursor: unknown;
    };
    expect(body.starred).toHaveLength(51);
    expect(body.conversations).toHaveLength(1);
    expect(body.nextCursor).toBeNull();
    for (const s of [...body.conversations, ...body.starred]) expect(typeof s.openclawSeen).toBe('boolean');
    expect(body.conversations[0]).toMatchObject({ id: CID, openclawSeen: true, lastMessageAt: TS });
    expect(body.conversations[0]).not.toHaveProperty('user_id');
  });

  it('a full page answers a cursor; the next page takes it back and carries no starred list', async () => {
    const rows = Array.from({ length: 31 }, (_, i) =>
      convRow({ id: `c0000000-0000-4000-8000-${String(i).padStart(12, '0')}` })
    );
    h.state.respond = (call) =>
      call.ops.some(([n, a]) => n === 'eq' && a[0] === 'starred' && a[1] === true)
        ? { data: [], error: null }
        : { data: rows, error: null };
    const first = (await json(await list())) as { conversations: unknown[]; nextCursor: string };
    expect(first.conversations).toHaveLength(30);
    expect(decodeCursor(first.nextCursor)).toEqual({ lastMessageAt: TS, id: rows[29].id });

    h.state.calls = [];
    h.state.respond = () => ({ data: [rows[30]], error: null });
    const second = await json(await list(`?cursor=${first.nextCursor}`));
    expect(second).toEqual({ conversations: [expect.objectContaining({ id: rows[30].id })], nextCursor: null });
    expect(h.state.calls).toHaveLength(1);
    expect(h.state.calls[0].ops.filter(([n]) => n === 'or')).toHaveLength(1);
  });

  it('?limit takes 1..50', async () => {
    h.state.respond = () => ({ data: [], error: null });
    expect((await list('?limit=50')).status).toBe(200);
    expect(h.state.calls[0].ops.find(([n]) => n === 'limit')?.[1]).toEqual([51]);
    for (const bad of ['0', '51', 'abc', '1.5', '-1', '', '007']) {
      h.state.calls = [];
      const res = await list(`?limit=${bad}`);
      expect(res.status, bad).toBe(bad === '007' ? 400 : 400);
      expect(h.state.calls).toEqual([]);
    }
  });

  it('a cursor it did not make is 400, before the database', async () => {
    const forged = Buffer.from(`${TS},id.gt.0|${CID}`, 'utf8').toString('base64url');
    for (const bad of ['garbage!', forged, encodeCursor({ lastMessageAt: 'yesterday', id: CID })]) {
      const res = await list(`?cursor=${encodeURIComponent(bad)}`);
      expect(res.status, bad).toBe(400);
      expect(await json(res)).toEqual({ error: 'invalid' });
    }
    expect(h.state.calls).toEqual([]);
  });

  it("?itemId answers the item's one conversation, or none", async () => {
    h.state.respond = () => ({ data: convRow({ item_id: ITEM }), error: null });
    expect(await json(await list(`?itemId=${ITEM}`))).toEqual({
      conversations: [expect.objectContaining({ id: CID, itemId: ITEM })],
    });
    h.state.respond = () => ({ data: null, error: null });
    expect(await json(await list(`?itemId=${ITEM}`))).toEqual({ conversations: [] });

    h.state.calls = [];
    const res = await list('?itemId=item-1');
    expect(res.status).toBe(400);
    expect(h.state.calls).toEqual([]);
  });
});

describe('POST /api/ai/conversations/search', () => {
  it('trims the query and asks chat_search for at most 50', async () => {
    h.state.respond = () => ({
      data: [{ ...convRow({ openclaw_seen: true }), matched: 'message', snippet: 'with a zebra', item_title: null }],
      error: null,
    });
    const body = await json(await search({ q: '  zebra ' }));
    expect(h.state.calls[0]).toMatchObject({ rpc: 'chat_search', args: { p_query: 'zebra', p_limit: 50 } });
    expect(body).toEqual({
      results: [expect.objectContaining({ id: CID, matched: 'message', snippet: 'with a zebra', itemTitle: null, openclawSeen: true })],
    });
  });

  it.each([
    ['one character', { q: 'a' }],
    ['one emoji (one character, though two UTF-16 units)', { q: '\u{1F355}' }],
    ['101 characters', { q: 'x'.repeat(101) }],
    ['101 emoji', { q: '\u{1F355}'.repeat(101) }],
    ['blank', { q: '   ' }],
    ['no q', {}],
    ['a q that is not text', { q: 5 }],
    ['an extra key', { q: 'plan', limit: 5 }],
  ])('400 for %s', async (_label, body) => {
    const res = await search(body);
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'invalid' });
    expect(h.state.calls).toEqual([]);
  });
});

describe('POST /api/ai/conversations/search, in characters', () => {
  it('takes 2..100 code points, as chat_search counts them', async () => {
    h.state.respond = () => ({ data: [], error: null });
    for (const q of ['\u{1F355}'.repeat(2), '\u{1F355}'.repeat(60), '\u{1F355}'.repeat(100)]) {
      h.state.calls = [];
      const res = await search({ q });
      expect(res.status).toBe(200);
      expect(h.state.calls[0]).toMatchObject({ rpc: 'chat_search', args: { p_query: q } });
    }
  });
});

describe('GET /api/ai/conversations/[id]', () => {
  it('answers the conversation and its messages, ascending, with hasEarlier', async () => {
    h.state.respond = healthy;
    const body = await json(await thread());
    expect(body).toEqual({
      conversation: expect.objectContaining({ id: CID, openclawSeen: false }),
      messages: [expect.objectContaining({ pos: 1, role: 'user' }), expect.objectContaining({ pos: 2, answerer: 'openclaw', model: null })],
      hasEarlier: false,
    });
  });

  it('pages back with ?before', async () => {
    h.state.respond = healthy;
    await json(await thread(CID, '?before=101'));
    const messages = h.state.calls.find((c) => c.table === 'chat_messages')!;
    expect(messages.ops.filter(([n]) => n === 'lt')).toEqual([['lt', ['pos', 101]]]);
  });

  it('404 not_found for a conversation that is not this user’s', async () => {
    h.state.respond = (call) => (call.table === 'chat_conversations' ? { data: null, error: null } : { data: [], error: null });
    const res = await thread();
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: 'not_found' });
  });

  it('400 for an id or a ?before that is not one, before the database', async () => {
    for (const res of [
      await thread('not-a-uuid'),
      await thread(CID, '?before=0'),
      await thread(CID, '?before=-1'),
      await thread(CID, '?before=x'),
      await thread(CID, '?before=1234567890'),
    ]) {
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ error: 'invalid' });
    }
    expect(h.state.calls).toEqual([]);
  });
});

describe('PATCH /api/ai/conversations/[id]', () => {
  it('a rename is one line, marks renamed, and answers the conversation', async () => {
    h.state.respond = () => ({ data: convRow({ title: 'Week plan', renamed: true }), error: null });
    const body = await json(await patch({ title: '  Week\nplan ' }));
    expect(body).toEqual({ conversation: expect.objectContaining({ title: 'Week plan', renamed: true }) });
    expect(h.state.calls[0].ops.find(([n]) => n === 'update')?.[1]).toEqual([{ title: 'Week plan', renamed: true }]);
  });

  it('addChanges is one chat_note_changes call, answered from its row; a tally on no row is 404', async () => {
    h.state.respond = (call) =>
      call.rpc === 'chat_note_changes'
        ? { data: [convRow({ added_count: 3, steps_count: 22 })], error: null }
        : { data: null, error: { code: 'XX000' } };
    const ok = await patch({ addChanges: { added: 2, steps: 20 } });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toEqual({
      conversation: expect.objectContaining({ id: CID, changes: { added: 3, steps: 22, moved: 0, changed: 0 } }),
    });
    expect(h.state.calls).toHaveLength(1);
    expect(h.state.calls[0]).toMatchObject({
      rpc: 'chat_note_changes',
      args: { p_conversation: CID, p_added: 2, p_steps: 20, p_moved: 0, p_changed: 0 },
    });
    h.state.respond = () => ({ data: [], error: null });
    const res = await patch({ addChanges: { added: 1 } });
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: 'not_found' });
  });

  it('404 when no row of this user’s matched', async () => {
    h.state.respond = () => ({ data: null, error: null });
    expect((await patch({ starred: true })).status).toBe(404);
  });

  it.each([
    ['an empty body', {}],
    ['an unknown key', { pinned: true }],
    ['a blank title', { title: '  ' }],
    ['starred that is not a boolean', { starred: 1 }],
    ['a tally over 20', { addChanges: { added: 21 } }],
    ['a tally with a rename', { addChanges: { added: 1 }, title: 'Week plan' }],
    ['a tally with a star', { addChanges: { added: 1 }, starred: true }],
  ])('400 for %s', async (_label, body) => {
    const res = await patch(body);
    expect(res.status).toBe(400);
    expect(h.state.calls).toEqual([]);
  });

  it('400 for an id that is not one', async () => {
    expect((await patch({ starred: true }, 'nope')).status).toBe(400);
    expect(h.state.calls).toEqual([]);
  });
});

describe('DELETE /api/ai/conversations/[id]', () => {
  it('answers ok when it went, 404 when there was nothing of this user’s', async () => {
    h.state.respond = () => ({ data: [{ id: CID }], error: null });
    expect(await json(await del())).toEqual({ ok: true });
    h.state.respond = () => ({ data: [], error: null });
    const res = await del();
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: 'not_found' });
  });

  it('400 for an id that is not one', async () => {
    expect((await del('nope')).status).toBe(400);
    expect(h.state.calls).toEqual([]);
  });
});

describe('POST /api/ai/conversations/[id]/turns', () => {
  const sent = () =>
    h.state.calls.find((c) => c.rpc === 'chat_append')!.args as {
      p_conversation: string;
      p_create: unknown;
      p_messages: Array<Record<string, unknown>>;
    };

  it('saves the turn once through chat_append and answers the conversation and the count', async () => {
    h.state.respond = healthy;
    const body = await json(await turns(turnBody()));
    expect(body).toEqual({ conversation: expect.objectContaining({ id: CID }), inserted: 2 });
    expect(h.state.calls.filter((c) => c.rpc === 'chat_append')).toHaveLength(1);
    expect(sent()).toEqual({
      p_conversation: CID,
      p_create: { itemId: null, title: 'Plan my day' },
      p_messages: [
        { id: U1, role: 'user', content: 'plan my day', status: 'complete', errorCode: null, replyTo: null, answerer: null, model: null },
        {
          id: R1,
          role: 'assistant',
          content: 'Here is a plan.',
          status: 'complete',
          errorCode: null,
          replyTo: U1,
          answerer: 'model',
          model: 'gpt-4o-mini',
        },
      ],
    });
  });

  it('403 when ownerId is not the session user, whatever else the body holds', async () => {
    for (const body of [turnBody({ ownerId: STRANGER }), { ownerId: STRANGER, messages: 'junk' }]) {
      const res = await turns(body);
      expect(res.status).toBe(403);
      expect(await json(res)).toEqual({ error: 'forbidden' });
    }
    expect(h.state.calls).toEqual([]);
    expect(takeToken).not.toHaveBeenCalled();
  });

  it.each([
    ['no ownerId', turnBody({ ownerId: undefined })],
    ['a message id that is not a uuid', turnBody({ messages: [user({ id: 'u-1' })] })],
    ['a user message with replyTo', turnBody({ messages: [user({ replyTo: R1 })] })],
    ['a reply with no replyTo', turnBody({ messages: [user(), reply({ replyTo: undefined })] })],
    ['a reply with no answerer', turnBody({ messages: [user(), reply({ answerer: undefined })] })],
    ['an errorCode without status error', turnBody({ messages: [user(), reply({ errorCode: 'upstream' })] })],
    ['status error without an errorCode', turnBody({ messages: [user(), reply({ status: 'error' })] })],
    ['a reply answering another message', turnBody({ messages: [user(), reply({ replyTo: OTHER })] })],
    ['"OpenClaw · kirby-1" as a model', turnBody({ messages: [user(), reply({ model: 'OpenClaw · kirby-1' })] })],
    ['meta', turnBody({ messages: [user({ meta: { x: 1 } })] })],
    ['three messages', turnBody({ messages: [user(), reply(), user()] })],
    ['a create itemId that is not a uuid', turnBody({ create: { itemId: 'item-1', title: 'x' } })],
  ])('400 for %s: shape, never length', async (_label, body) => {
    const res = await turns(body);
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'invalid' });
    expect(h.state.calls).toEqual([]);
  });

  it('400 for a conversation id that is not one', async () => {
    expect((await turns(turnBody(), 'nope')).status).toBe(400);
    expect(h.state.calls).toEqual([]);
  });

  it('clips over-long content instead of refusing it: 9,000 typed reach the RPC as 8,000, 50,000 replied as 40,000', async () => {
    h.state.respond = healthy;
    const res = await turns(
      turnBody({ messages: [user({ content: 'u'.repeat(9_000) }), reply({ content: 'a'.repeat(50_000), answerer: 'openclaw', model: null })] })
    );
    expect(res.status).toBe(200);
    expect(sent().p_messages.map((m) => (m.content as string).length)).toEqual([8_000, 40_000]);
  });

  it('strips U+0000 and replaces a lone surrogate, so Postgres never sees either', async () => {
    h.state.respond = healthy;
    const res = await turns(turnBody({ messages: [user({ content: `a${NUL}b${HIGH}c` })] }));
    expect(res.status).toBe(200);
    expect(sent().p_messages[0].content).toBe(`ab${String.fromCharCode(0xfffd)}c`);
  });

  it('a CJK-and-emoji paste cut at the cap leaves no lone surrogate', async () => {
    h.state.respond = healthy;
    // 1 + 2 units a repeat, so the 8,000-unit cut lands inside a pair.
    await turns(turnBody({ messages: [user({ content: `${CJK}${EMOJI}`.repeat(3_000) })] }));
    const content = sent().p_messages[0].content as string;
    expect(content.length).toBeLessThanOrEqual(8_000);
    const last = content.charCodeAt(content.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(JSON.stringify(content)).not.toMatch(/\\ud8[0-9a-f]{2}"?$/i);
  });

  it('cleans the create title to one line of at most 200, and a blank one to "New chat"', async () => {
    h.state.respond = healthy;
    await turns(turnBody({ create: { itemId: ITEM, title: `${'t'.repeat(300)}\nmore` } }));
    expect(sent().p_create).toEqual({ itemId: ITEM, title: 't'.repeat(200) });
    h.state.calls = [];
    await turns(turnBody({ create: { itemId: null, title: '\n\t' } }));
    expect(sent().p_create).toEqual({ itemId: null, title: 'New chat' });
  });

  it('a reply alone (its user row saved earlier), or a stop before any text, saves', async () => {
    h.state.respond = healthy;
    expect((await turns({ ownerId: USER, messages: [reply({ status: 'error', errorCode: 'upstream', content: '' })] })).status).toBe(200);
    expect((await turns({ ownerId: USER, messages: [user()] })).status).toBe(200);
  });

  it('404 not_found when there is no row and no create (deleted elsewhere)', async () => {
    h.state.respond = () => ({ data: { status: 'gone' }, error: null });
    const res = await turns(turnBody({ create: undefined }));
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: 'not_found' });
  });

  it("409 conflict with the item's existing conversation id", async () => {
    h.state.respond = () => ({ data: { status: 'conflict', conversationId: OTHER }, error: null });
    const res = await turns(turnBody({ create: { itemId: ITEM, title: 'Dentist' } }));
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: 'conflict', conversationId: OTHER });
  });

  it('400 when the database refuses a value anyway (a CHECK, a U+0000), never 500', async () => {
    for (const code of ['23514', '22P05', '22P02', '23503']) {
      h.state.respond = () => ({ data: null, error: { code, message: SENTINEL, details: SENTINEL } });
      const res = await turns(turnBody());
      expect(res.status, code).toBe(400);
      expect(await json(res)).toEqual({ error: 'invalid' });
    }
    expect(JSON.stringify(logs)).not.toContain('SENTINEL');
  });
});
