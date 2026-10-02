// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  appendTurn,
  conversationForItem,
  decodeCursor,
  deleteConversation,
  encodeCursor,
  getThread,
  listConversations,
  parsePatch,
  parseSearch,
  parseTurn,
  patchConversation,
  searchConversations,
  toMessage,
  toSummary,
  type ConvResult,
} from '@/lib/ai-server/conversations';
import type { ConversationPatch } from '@/lib/conversation-types';
import { isMissingSchema } from '@/lib/ai-server/schema-codes';
import { CHAT_LIMITS } from '@/lib/conversation-types';

/**
 * lib/ai-server/conversations.ts over a recording stand-in for the Supabase
 * query builder: the queries it builds, the shapes it returns, how every
 * database answer maps to a reason, and that an error's text (which can quote
 * the row, here what the user typed) never reaches a result or a log line.
 */

type Op = [string, unknown[]];
interface Call {
  table: string | null;
  rpc: string | null;
  args: unknown;
  ops: Op[];
}
type Answer = { data: unknown; error: unknown };

let calls: Call[] = [];
let respond: (call: Call) => Answer = () => ({ data: null, error: null });

function chain(call: Call): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve()
              .then(() => respond(call))
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

const db = {
  from: (table: string) => {
    const call: Call = { table, rpc: null, args: undefined, ops: [] };
    calls.push(call);
    return chain(call);
  },
  rpc: (name: string, args: unknown) => {
    const call: Call = { table: null, rpc: name, args, ops: [] };
    calls.push(call);
    return chain(call);
  },
} as unknown as SupabaseClient;

const USER = 'aaaaaaaa-0000-4000-8000-00000000000a';
const CID = 'c0000000-0000-4000-8000-0000000000a1';
const OTHER = 'c0000000-0000-4000-8000-0000000000a2';
const ITEM = '11111111-0000-4000-8000-0000000000a1';
const U1 = 'd0000000-0000-4000-8000-000000000001';
const R1 = 'd0000000-0000-4000-8000-000000000002';
const TS = '2026-10-02T09:15:42.123456+00:00';
const SENTINEL = 'SENTINEL-what-the-user-typed';

function convRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CID,
    item_id: null,
    title: 'Plan my day',
    renamed: false,
    starred: false,
    answerer: 'model',
    openclaw_seen: false,
    added_count: 1,
    steps_count: 2,
    moved_count: 3,
    changed_count: 4,
    message_count: 2,
    last_message_at: TS,
    created_at: '2026-10-02T09:00:00+00:00',
    ...over,
  };
}

function msgRow(pos: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `d0000000-0000-4000-8000-${String(pos).padStart(12, '0')}`,
    pos,
    role: pos % 2 === 1 ? 'user' : 'assistant',
    content: `message ${pos}`,
    status: 'complete',
    error_code: null,
    reply_to: pos % 2 === 1 ? null : `d0000000-0000-4000-8000-${String(pos - 1).padStart(12, '0')}`,
    answerer: pos % 2 === 1 ? null : 'model',
    model: pos % 2 === 1 ? null : 'gpt-4o-mini',
    created_at: TS,
    ...over,
  };
}

/** A PostgREST error whose text quotes what the user typed, as a CHECK failure's does. */
const pgError = (code: string) => ({
  code,
  message: `new row violates check constraint (${SENTINEL})`,
  details: `Failing row contains (${SENTINEL}).`,
  hint: SENTINEL,
});

const opNames = (call: Call) => call.ops.map(([n]) => n);
const opArgs = (call: Call, name: string) => call.ops.filter(([n]) => n === name).map(([, a]) => a);

let logs: unknown[][];

beforeEach(() => {
  calls = [];
  respond = () => ({ data: null, error: null });
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

function expectNoSentinel(result: unknown) {
  expect(JSON.stringify(result)).not.toContain('SENTINEL');
  expect(JSON.stringify(logs)).not.toContain('SENTINEL');
}

describe('isMissingSchema', () => {
  it('is exactly the six "not there yet" codes', () => {
    for (const code of ['42P01', 'PGRST205', 'PGRST202', '42883', '42703', 'PGRST204']) {
      expect(isMissingSchema(code), code).toBe(true);
    }
    for (const code of ['23514', 'PGRST301', '42501', '', undefined, null, 42]) {
      expect(isMissingSchema(code), String(code)).toBe(false);
    }
  });
});

describe('database errors become a reason and a code, never text', () => {
  /** Every function, failing on its first call. */
  const RUNS: Array<[string, () => Promise<ConvResult<unknown>>]> = [
    ['list', () => listConversations(db, USER, { limit: 30, cursor: null })],
    ['item', () => conversationForItem(db, USER, ITEM)],
    ['search', () => searchConversations(db, USER, 'plan')],
    ['thread', () => getThread(db, USER, CID, { before: null })],
    [
      'append',
      () => appendTurn(db, USER, CID, { create: null, messages: [{ id: U1, role: 'user', content: 'hi' }] }),
    ],
    ['patch', () => patchConversation(db, USER, CID, { title: 'x' })],
    ['tally', () => patchConversation(db, USER, CID, { addChanges: { added: 1 } })],
    ['delete', () => deleteConversation(db, USER, CID)],
  ];

  it.each(RUNS)('%s: each missing-schema code is missing_schema, and not logged', async (_op, run) => {
    for (const code of ['42P01', 'PGRST205', 'PGRST202', '42883', '42703', 'PGRST204']) {
      respond = () => ({ data: null, error: pgError(code) });
      expect(await run()).toEqual({ ok: false, reason: 'missing_schema' });
    }
    expect(logs).toEqual([]);
  });

  it.each(RUNS)('%s: a value the database refused is invalid', async (_op, run) => {
    for (const code of ['22P02', '22P05', '22007', '22008', '22009', '22023', '23514', '23503', '23502']) {
      respond = () => ({ data: null, error: pgError(code) });
      const result = await run();
      expect(result).toEqual({ ok: false, reason: 'invalid' });
      expectNoSentinel(result);
    }
  });

  it.each(RUNS)('%s: P0002 is not_found', async (_op, run) => {
    respond = () => ({ data: null, error: pgError('P0002') });
    expect(await run()).toEqual({ ok: false, reason: 'not_found' });
    expect(logs).toEqual([]);
  });

  // 42501 is every privilege and RLS refusal: a grant regression must be a logged 500,
  // never a quiet "deleted elsewhere". 28000 is chat_append's "not signed in".
  it.each(RUNS)('%s: 42501 and 28000 are db, and logged', async (op, run) => {
    for (const code of ['42501', '28000']) {
      logs = [];
      respond = () => ({ data: null, error: pgError(code) });
      const result = await run();
      expect(result).toEqual({ ok: false, reason: 'db', code });
      expect(logs).toEqual([['[ai] conv', op, 'failed', code]]);
      expectNoSentinel(result);
    }
  });

  it.each(RUNS)('%s: anything else is db, logged as one line with the code only', async (op, run) => {
    respond = () => ({ data: null, error: pgError('XX000') });
    const result = await run();
    expect(result).toEqual({ ok: false, reason: 'db', code: 'XX000' });
    expect(logs).toEqual([['[ai] conv', op, 'failed', 'XX000']]);
    expectNoSentinel(result);
  });

  it('an error with no code is db "unknown"', async () => {
    respond = () => ({ data: null, error: { message: SENTINEL } });
    const result = await deleteConversation(db, USER, CID);
    expect(result).toEqual({ ok: false, reason: 'db', code: 'unknown' });
    expect(logs).toEqual([['[ai] conv', 'delete', 'failed', 'unknown']]);
  });
});

describe('rows to shapes', () => {
  it('toSummary narrows a row, openclawSeen and the four counters included', () => {
    expect(toSummary(convRow({ openclaw_seen: true, item_id: ITEM, answerer: 'openclaw' }))).toEqual({
      id: CID,
      itemId: ITEM,
      title: 'Plan my day',
      renamed: false,
      starred: false,
      answerer: 'openclaw',
      openclawSeen: true,
      changes: { added: 1, steps: 2, moved: 3, changed: 4 },
      messageCount: 2,
      lastMessageAt: TS,
      createdAt: '2026-10-02T09:00:00+00:00',
    });
  });

  it('keeps last_message_at verbatim, microseconds and all (the cursor compares on it)', () => {
    expect(toSummary(convRow())!.lastMessageAt).toBe(TS);
  });

  it('reads an off-shape field as absent, and a row missing its id or times as no row', () => {
    const s = toSummary(convRow({ answerer: 'gpt', openclaw_seen: 'yes', added_count: -1, message_count: 1.5 }))!;
    expect(s.answerer).toBeNull();
    expect(s.openclawSeen).toBe(false);
    expect(s.changes.added).toBe(0);
    expect(s.messageCount).toBe(0);
    for (const broken of [convRow({ id: null }), convRow({ title: 3 }), convRow({ last_message_at: null }), null, [], 'x']) {
      expect(toSummary(broken)).toBeNull();
    }
  });

  it('toMessage narrows a message and refuses an unknown role or status', () => {
    expect(toMessage(msgRow(2))).toEqual({
      id: 'd0000000-0000-4000-8000-000000000002',
      pos: 2,
      role: 'assistant',
      content: 'message 2',
      status: 'complete',
      errorCode: null,
      replyTo: 'd0000000-0000-4000-8000-000000000001',
      answerer: 'model',
      model: 'gpt-4o-mini',
      createdAt: TS,
    });
    expect(toMessage(msgRow(1, { role: 'system' }))).toBeNull();
    expect(toMessage(msgRow(1, { status: 'streaming' }))).toBeNull();
    expect(toMessage(msgRow(1, { pos: 0 }))).toBeNull();
  });
});

describe('the History cursor', () => {
  it('round-trips the exact timestamp and id, opaquely', () => {
    const raw = encodeCursor({ lastMessageAt: TS, id: CID });
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(raw).not.toContain(CID);
    expect(decodeCursor(raw)).toEqual({ lastMessageAt: TS, id: CID });
    expect(decodeCursor(encodeCursor({ lastMessageAt: '2026-10-02T09:15:42Z', id: CID }))).not.toBeNull();
  });

  it('refuses anything it did not make, before it can reach a filter', () => {
    const enc = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
    const bad = [
      undefined,
      null,
      '',
      'not base64!',
      'a'.repeat(201),
      enc(`${TS}`),
      enc(`${TS}|${CID}|x`),
      enc(`yesterday|${CID}`),
      enc(`${TS}|not-a-uuid`),
      enc(`${TS},id.gt.0|${CID}`),
      enc(`${TS}|${CID}),or(id.gt.0`),
      enc(`2026-13-45T99:99:99Z|${CID}`),
      enc(`${TS}"|${CID}`),
      // Shapes Date.parse takes and Postgres refuses (22008, 22009): never a 500.
      enc(`2026-02-30T12:00:00.000000+00:00|${CID}`),
      enc(`2026-04-31T00:00:00Z|${CID}`),
      enc(`2026-02-29T00:00:00Z|${CID}`),
      enc(`1900-02-29T00:00:00Z|${CID}`),
      enc(`0000-01-01T00:00:00Z|${CID}`),
      enc(`2026-01-01T00:00:00+16:00|${CID}`),
      enc(`2026-01-01T00:00:00-23:59|${CID}`),
      enc(`2026-01-01T00:00:00+05:60|${CID}`),
      enc(`2026-01-01T23:60:00Z|${CID}`),
      // Postgres takes these two, but PostgREST never renders them, so no cursor of ours holds one.
      enc(`2026-01-01T24:00:00Z|${CID}`),
      enc(`2026-01-01T23:59:60Z|${CID}`),
    ];
    for (const raw of bad) expect(decodeCursor(raw), String(raw)).toBeNull();
  });

  it('takes every real day and offset Postgres takes', () => {
    for (const t of [
      '2024-02-29T00:00:00Z',
      '2000-02-29T23:59:59.999999+00:00',
      '0001-01-01T00:00:00Z',
      '9999-12-31T23:59:59Z',
      '2026-01-31T00:00:00+15:59',
      '2026-01-31T00:00:00-15:59',
      '2026-04-30T12:00:00+0530',
      '2026-04-30T12:00:00-08',
    ]) {
      expect(decodeCursor(encodeCursor({ lastMessageAt: t, id: CID })), t).toEqual({ lastMessageAt: t, id: CID });
    }
  });
});

describe('listConversations', () => {
  it('pages non-starred rows newest first on the recency index, and adds every starred row to the first page', async () => {
    const starred = Array.from({ length: 51 }, (_, i) =>
      convRow({ id: `c0000000-0000-4000-8000-${String(i).padStart(12, '0')}`, starred: true })
    );
    respond = (call) =>
      opArgs(call, 'eq').some(([k, v]) => k === 'starred' && v === true)
        ? { data: starred, error: null }
        : { data: [convRow()], error: null };

    const result = await listConversations(db, USER, { limit: 30, cursor: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.conversations).toHaveLength(1);
    expect(result.value.starred).toHaveLength(51);
    expect(result.value.nextCursor).toBeNull();

    const [page, stars] = calls;
    expect(page.table).toBe('chat_conversations');
    expect(opArgs(page, 'eq')).toEqual([
      ['user_id', USER],
      ['starred', false],
    ]);
    expect(opArgs(page, 'order')).toEqual([
      ['last_message_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
    expect(opArgs(page, 'limit')).toEqual([[31]]);
    expect(opNames(page)).not.toContain('or');
    // Uncapped: no limit on the starred query.
    expect(opArgs(stars, 'eq')).toEqual([
      ['user_id', USER],
      ['starred', true],
    ]);
    expect(opNames(stars)).not.toContain('limit');
    // The select never asks for anything a summary does not show.
    const [columns] = opArgs(page, 'select')[0] as [string];
    expect(columns).toContain('openclaw_seen');
    expect(columns).not.toContain('user_id');
    expect(columns).not.toContain('content');
  });

  it('answers a cursor for the next page from the last row shown, and takes it back exactly', async () => {
    const rows = Array.from({ length: 4 }, (_, i) =>
      convRow({ id: `c0000000-0000-4000-8000-00000000000${i}`, last_message_at: `2026-10-02T09:15:4${9 - i}.123456+00:00` })
    );
    respond = () => ({ data: rows, error: null });
    const first = await listConversations(db, USER, { limit: 3, cursor: null });
    expect(first.ok && first.value.conversations.map((c) => c.id)).toEqual(rows.slice(0, 3).map((r) => r.id));
    const cursor = first.ok ? first.value.nextCursor : null;
    expect(decodeCursor(cursor)).toEqual({ lastMessageAt: rows[2].last_message_at, id: rows[2].id });

    calls = [];
    respond = () => ({ data: [rows[3]], error: null });
    const second = await listConversations(db, USER, { limit: 3, cursor: decodeCursor(cursor) });
    expect(second).toEqual({ ok: true, value: { conversations: [toSummary(rows[3])], nextCursor: null } });
    // A later page carries no starred list, and asks for exactly one query.
    expect(calls).toHaveLength(1);
    const t = rows[2].last_message_at as string;
    expect(opArgs(calls[0], 'or')).toEqual([
      [`last_message_at.lt."${t}",and(last_message_at.eq."${t}",id.lt.${rows[2].id})`],
    ]);
  });

  it('clamps the page size to 1..50', async () => {
    respond = () => ({ data: [], error: null });
    await listConversations(db, USER, { limit: 500, cursor: null });
    await listConversations(db, USER, { limit: 0, cursor: null });
    await listConversations(db, USER, { limit: Number.NaN, cursor: null });
    const limits = calls.filter((c) => opNames(c).includes('limit')).map((c) => opArgs(c, 'limit')[0][0]);
    expect(limits).toEqual([51, 2, 31]);
  });

  it('fails the whole page on a row that is not one', async () => {
    respond = () => ({ data: [convRow(), { id: 7 }], error: null });
    expect(await listConversations(db, USER, { limit: 30, cursor: null })).toEqual({
      ok: false,
      reason: 'db',
      code: 'bad_row',
    });
  });
});

describe('conversationForItem', () => {
  it("answers the item's one conversation, or null", async () => {
    respond = () => ({ data: convRow({ item_id: ITEM }), error: null });
    const found = await conversationForItem(db, USER, ITEM);
    expect(found.ok && found.value?.itemId).toBe(ITEM);
    expect(opArgs(calls[0], 'eq')).toEqual([
      ['user_id', USER],
      ['item_id', ITEM],
    ]);
    expect(opNames(calls[0])).toContain('maybeSingle');

    respond = () => ({ data: null, error: null });
    expect(await conversationForItem(db, USER, ITEM)).toEqual({ ok: true, value: null });
  });
});

describe('searchConversations', () => {
  it('calls chat_search for at most 50, and maps each hit', async () => {
    respond = () => ({
      data: [
        { ...convRow({ openclaw_seen: true }), matched: 'message', snippet: '…with a zebra.', item_title: null },
        { ...convRow({ id: OTHER, item_id: ITEM }), matched: 'title', snippet: null, item_title: 'Dentist' },
      ],
      error: null,
    });
    const result = await searchConversations(db, USER, 'zebra');
    expect(calls[0]).toMatchObject({ rpc: 'chat_search', args: { p_query: 'zebra', p_limit: 50 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((h) => [h.matched, h.snippet, h.itemTitle, h.openclawSeen])).toEqual([
      ['message', '…with a zebra.', null, true],
      ['title', null, 'Dentist', false],
    ]);
  });

  it('answers an empty list for no hits, and db for a hit that is not one', async () => {
    respond = () => ({ data: [], error: null });
    expect(await searchConversations(db, USER, 'nothing')).toEqual({ ok: true, value: [] });
    respond = () => ({ data: [{ ...convRow(), matched: 'body' }], error: null });
    expect(await searchConversations(db, USER, 'x')).toMatchObject({ ok: false, reason: 'db' });
  });
});

describe('getThread', () => {
  it('answers the newest 100 ascending, and hasEarlier when the first is past pos 1', async () => {
    const newestFirst = Array.from({ length: 100 }, (_, i) => msgRow(120 - i));
    respond = (call) =>
      call.table === 'chat_conversations' ? { data: convRow(), error: null } : { data: newestFirst, error: null };
    const result = await getThread(db, USER, CID, { before: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.messages.map((m) => m.pos)).toEqual(Array.from({ length: 100 }, (_, i) => 21 + i));
    expect(result.value.hasEarlier).toBe(true);
    expect(result.value.conversation.id).toBe(CID);

    const messages = calls.find((c) => c.table === 'chat_messages')!;
    expect(opArgs(messages, 'eq')).toEqual([
      ['user_id', USER],
      ['conversation_id', CID],
    ]);
    expect(opArgs(messages, 'order')).toEqual([['pos', { ascending: false }]]);
    expect(opArgs(messages, 'limit')).toEqual([[CHAT_LIMITS.threadPage]]);
    expect(opNames(messages)).not.toContain('lt');
  });

  it('pages back with ?before, and stops at pos 1', async () => {
    respond = (call) =>
      call.table === 'chat_conversations'
        ? { data: convRow(), error: null }
        : { data: [msgRow(2), msgRow(1)], error: null };
    const result = await getThread(db, USER, CID, { before: 3 });
    expect(result.ok && result.value.messages.map((m) => m.pos)).toEqual([1, 2]);
    expect(result.ok && result.value.hasEarlier).toBe(false);
    expect(opArgs(calls.find((c) => c.table === 'chat_messages')!, 'lt')).toEqual([['pos', 3]]);
  });

  it('is not_found when the conversation is not this user’s', async () => {
    respond = (call) => (call.table === 'chat_conversations' ? { data: null, error: null } : { data: [], error: null });
    expect(await getThread(db, USER, CID, { before: null })).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('appendTurn', () => {
  const turn = {
    create: { itemId: null, title: '  Plan\nmy day ' },
    messages: [
      { id: U1, role: 'user' as const, content: 'plan my day' },
      {
        id: R1,
        role: 'assistant' as const,
        content: 'Here is a plan.',
        status: 'complete' as const,
        replyTo: U1,
        answerer: 'model' as const,
        model: 'gpt-4o-mini',
      },
    ],
  };

  it('saves through chat_append, then answers the summary and the count inserted', async () => {
    respond = (call) =>
      call.rpc === 'chat_append'
        ? { data: { status: 'ok', inserted: 2, messageCount: 2 }, error: null }
        : { data: convRow(), error: null };
    const result = await appendTurn(db, USER, CID, turn);
    expect(result).toEqual({ ok: true, value: { conversation: toSummary(convRow()), inserted: 2 } });
    expect(calls[0]).toMatchObject({
      rpc: 'chat_append',
      args: {
        p_conversation: CID,
        p_create: { itemId: null, title: 'Plan my day' },
        p_messages: [
          {
            id: U1,
            role: 'user',
            content: 'plan my day',
            status: 'complete',
            errorCode: null,
            replyTo: null,
            answerer: null,
            model: null,
          },
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
      },
    });
    expect(opArgs(calls[1], 'eq')).toEqual([
      ['user_id', USER],
      ['id', CID],
    ]);
  });

  it('sends p_create null when appending, and a blank title as "New chat" when creating', async () => {
    respond = (call) =>
      call.rpc ? { data: { status: 'ok', inserted: 0, messageCount: 2 }, error: null } : { data: convRow(), error: null };
    await appendTurn(db, USER, CID, { create: null, messages: turn.messages });
    expect((calls[0].args as { p_create: unknown }).p_create).toBeNull();
    calls = [];
    await appendTurn(db, USER, CID, { create: { itemId: ITEM, title: ' \n ' }, messages: turn.messages });
    expect((calls[0].args as { p_create: unknown }).p_create).toEqual({ itemId: ITEM, title: 'New chat' });
  });

  it('clips content to the caps on its own, whoever parsed it', async () => {
    respond = (call) =>
      call.rpc ? { data: { status: 'ok', inserted: 2, messageCount: 2 }, error: null } : { data: convRow(), error: null };
    await appendTurn(db, USER, CID, {
      create: null,
      messages: [
        { id: U1, role: 'user', content: 'u'.repeat(9_000) },
        { id: R1, role: 'assistant', content: 'a'.repeat(50_000), replyTo: U1, answerer: 'openclaw' },
      ],
    });
    const sent = (calls[0].args as { p_messages: Array<{ content: string; model: unknown }> }).p_messages;
    expect(sent.map((m) => m.content.length)).toEqual([8_000, 40_000]);
    expect(sent[1].model).toBeNull();
  });

  it("answers gone as not_found and conflict with the item's conversation, reading nothing after", async () => {
    respond = () => ({ data: { status: 'gone' }, error: null });
    expect(await appendTurn(db, USER, CID, turn)).toEqual({ ok: false, reason: 'not_found' });
    expect(calls).toHaveLength(1);

    calls = [];
    respond = () => ({ data: { status: 'conflict', conversationId: OTHER }, error: null });
    expect(await appendTurn(db, USER, CID, turn)).toEqual({ ok: false, reason: 'conflict', conversationId: OTHER });
    expect(calls).toHaveLength(1);
  });

  it('treats an answer it does not understand as db, never as success', async () => {
    for (const data of [null, 'ok', { status: 'conflict', conversationId: null }, { status: 'full' }]) {
      respond = () => ({ data, error: null });
      expect(await appendTurn(db, USER, CID, turn)).toMatchObject({ ok: false, reason: 'db' });
    }
  });

  it('is not_found when the row is gone by the time it is read back', async () => {
    respond = (call) =>
      call.rpc ? { data: { status: 'ok', inserted: 2, messageCount: 2 }, error: null } : { data: null, error: null };
    expect(await appendTurn(db, USER, CID, turn)).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('patchConversation', () => {
  it('a rename sets renamed and answers the updated row', async () => {
    respond = () => ({ data: convRow({ title: 'Week plan', renamed: true }), error: null });
    const result = await patchConversation(db, USER, CID, { title: 'Week plan' });
    expect(result.ok && result.value.renamed).toBe(true);
    expect(opArgs(calls[0], 'update')).toEqual([[{ title: 'Week plan', renamed: true }]]);
    expect(opArgs(calls[0], 'eq')).toEqual([
      ['user_id', USER],
      ['id', CID],
    ]);
  });

  it('star alone does not mark it renamed', async () => {
    respond = () => ({ data: convRow({ starred: true }), error: null });
    await patchConversation(db, USER, CID, { starred: true });
    expect(opArgs(calls[0], 'update')).toEqual([[{ starred: true }]]);
  });

  it('a tally is one request: chat_note_changes commits it and answers the row as it now is', async () => {
    respond = () => ({ data: [convRow({ added_count: 3, moved_count: 1 })], error: null });
    const result = await patchConversation(db, USER, CID, { addChanges: { added: 3, moved: 1 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      rpc: 'chat_note_changes',
      args: { p_conversation: CID, p_added: 3, p_steps: 0, p_moved: 1, p_changed: 0 },
    });
    expect(result).toEqual({ ok: true, value: toSummary(convRow({ added_count: 3, moved_count: 1 })) });
  });

  it('a tally on no row is not_found, from that one request', async () => {
    respond = () => ({ data: [], error: null });
    expect(await patchConversation(db, USER, CID, { addChanges: { added: 1 } })).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(calls).toHaveLength(1);
  });

  it('a tally answer that is not one row of a conversation is db, never success', async () => {
    for (const data of [null, true, [{ id: 7 }], [convRow(), convRow({ id: OTHER })]]) {
      respond = () => ({ data, error: null });
      expect(await patchConversation(db, USER, CID, { addChanges: { added: 1 } })).toEqual({
        ok: false,
        reason: 'db',
        code: 'bad_row',
      });
    }
  });

  it('refuses a tally with a rename or a star before writing anything', async () => {
    for (const patch of [
      { addChanges: { added: 1 }, title: 'x' },
      { addChanges: { added: 1 }, starred: true },
    ]) {
      // Past the type on purpose: the guard is for a caller that did not use parsePatch.
      expect(await patchConversation(db, USER, CID, patch as unknown as ConversationPatch)).toEqual({
        ok: false,
        reason: 'invalid',
      });
    }
    expect(calls).toEqual([]);
  });

  it('an update that matched nothing is not_found', async () => {
    respond = () => ({ data: null, error: null });
    expect(await patchConversation(db, USER, CID, { starred: false })).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('deleteConversation', () => {
  it('answers ok when a row went, not_found when none did', async () => {
    respond = () => ({ data: [{ id: CID }], error: null });
    expect(await deleteConversation(db, USER, CID)).toEqual({ ok: true, value: true });
    expect(opNames(calls[0])).toEqual(['delete', 'eq', 'eq', 'select']);
    respond = () => ({ data: [], error: null });
    expect(await deleteConversation(db, USER, CID)).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('parseTurn', () => {
  const user = { id: U1, role: 'user', content: 'hi' };
  const reply = { id: R1, role: 'assistant', content: 'hello', replyTo: U1, answerer: 'model', model: 'gpt-4o-mini' };
  const body = (o: Record<string, unknown> = {}) => ({ ownerId: USER, messages: [user, reply], ...o });

  it('takes [user, reply], [user] and a reply alone, and fills the defaults', () => {
    expect(parseTurn(body())).toEqual({
      ownerId: USER,
      create: null,
      messages: [
        { id: U1, role: 'user', content: 'hi', status: 'complete', errorCode: null, replyTo: null, answerer: null, model: null },
        {
          id: R1,
          role: 'assistant',
          content: 'hello',
          status: 'complete',
          errorCode: null,
          replyTo: U1,
          answerer: 'model',
          model: 'gpt-4o-mini',
        },
      ],
    });
    expect(parseTurn(body({ messages: [user] }))?.messages).toHaveLength(1);
    expect(parseTurn(body({ messages: [reply] }))?.messages).toHaveLength(1);
    expect(parseTurn(body({ create: { itemId: ITEM, title: 'x' } }))?.create).toEqual({ itemId: ITEM, title: 'x' });
    expect(parseTurn(body({ create: { title: 'x' } }))?.create).toEqual({ itemId: null, title: 'x' });
  });

  it('takes a stopped reply with text and an error reply with none', () => {
    expect(parseTurn(body({ messages: [user, { ...reply, status: 'stopped' }] }))).not.toBeNull();
    expect(
      parseTurn(body({ messages: [user, { ...reply, content: '', status: 'error', errorCode: 'upstream', model: null }] }))
    ).not.toBeNull();
  });

  it.each([
    ['no ownerId', { messages: [user] }],
    ['an empty ownerId', body({ ownerId: '' })],
    ['an unknown top-level key', body({ extra: 1 })],
    ['zero messages', body({ messages: [] })],
    ['three messages', body({ messages: [user, reply, user] })],
    ['a reply before its question', body({ messages: [reply, user] })],
    ['two user messages', body({ messages: [user, { ...user, id: R1 }] })],
    ['a pair whose reply answers another message', body({ messages: [user, { ...reply, replyTo: OTHER }] })],
    ['a reply alone with create', body({ messages: [reply], create: { itemId: null, title: 'x' } })],
    ['a message id that is not a uuid', body({ messages: [{ ...user, id: 'u1' }] })],
    ['a system message', body({ messages: [{ ...user, role: 'system' }] })],
    ['content that is not a string', body({ messages: [{ ...user, content: 5 }] })],
    ['a user message with replyTo', body({ messages: [{ ...user, replyTo: U1 }] })],
    ['a user message with an answerer', body({ messages: [{ ...user, answerer: 'model' }] })],
    ['a user message with a model', body({ messages: [{ ...user, model: 'gpt-4o-mini' }] })],
    ['a user message that is not complete', body({ messages: [{ ...user, status: 'stopped' }] })],
    ['a blank user message', body({ messages: [{ ...user, content: ' \t\r\n' }] })],
    ['a user message of only U+0000', body({ messages: [{ ...user, content: String.fromCharCode(0) }] })],
    ['a reply with no replyTo', body({ messages: [user, { ...reply, replyTo: undefined }] })],
    ['a reply with no answerer', body({ messages: [user, { ...reply, answerer: undefined }] })],
    ['a reply with an unknown answerer', body({ messages: [user, { ...reply, answerer: 'gpt' }] })],
    ['a complete reply with no text', body({ messages: [user, { ...reply, content: '' }] })],
    ['an errorCode without status error', body({ messages: [user, { ...reply, errorCode: 'upstream' }] })],
    ['status error without an errorCode', body({ messages: [user, { ...reply, status: 'error' }] })],
    ['an errorCode off the CHECK', body({ messages: [user, { ...reply, status: 'error', errorCode: 'Bad Code' }] })],
    ['an unknown status', body({ messages: [user, { ...reply, status: 'streaming' }] })],
    ['"OpenClaw · kirby-1" as a model', body({ messages: [user, { ...reply, model: 'OpenClaw · kirby-1' }] })],
    ['meta (never accepted in 2a)', body({ messages: [{ ...user, meta: {} }] })],
    ['create that is not an object', body({ create: 'x' })],
    ['create with a non-uuid itemId', body({ create: { itemId: 'item-1', title: 'x' } })],
    ['create with no title', body({ create: { itemId: null } })],
    ['create with an unknown key', body({ create: { itemId: null, title: 'x', starred: true } })],
    ['not an object', [user]],
  ])('refuses %s', (_label, raw) => {
    expect(parseTurn(raw)).toBeNull();
  });

  it('clips lengths rather than refusing them, and cleans what Postgres would refuse', () => {
    const NUL = String.fromCharCode(0);
    const HIGH = String.fromCharCode(0xd83d);
    const parsed = parseTurn(
      body({
        messages: [
          { ...user, content: `a${NUL}b${HIGH}c${'u'.repeat(9_000)}` },
          { ...reply, content: 'r'.repeat(50_000) },
        ],
        create: { itemId: null, title: `${'t'.repeat(300)}\nsecond line` },
      })
    )!;
    expect(parsed.messages[0].content.startsWith(`ab${String.fromCharCode(0xfffd)}c`)).toBe(true);
    expect(parsed.messages[0].content).toHaveLength(8_000);
    expect(parsed.messages[1].content).toHaveLength(40_000);
    expect(parsed.create?.title).toBe('t'.repeat(200));
  });
});

describe('parsePatch', () => {
  it('takes a title and/or a star, or a tally alone', () => {
    expect(parsePatch({ title: '  Week\nplan ' })).toEqual({ title: 'Week plan' });
    expect(parsePatch({ starred: false })).toEqual({ starred: false });
    expect(parsePatch({ addChanges: { added: 20, changed: 0 } })).toEqual({ addChanges: { added: 20, changed: 0 } });
    expect(parsePatch({ title: 't'.repeat(250), starred: true })).toEqual({ title: 't'.repeat(200), starred: true });
  });

  it('caps each counter at CHAT_LIMITS.changesPerCall, refusing (never clamping) past it', () => {
    const max = CHAT_LIMITS.changesPerCall;
    expect(max).toBe(20);
    expect(parsePatch({ addChanges: { added: max, steps: max, moved: max, changed: max } })).not.toBeNull();
    expect(parsePatch({ addChanges: { steps: max + 1 } })).toBeNull();
  });

  it.each([
    ['an empty body', {}],
    ['an unknown key', { pinned: true }],
    ['a blank title', { title: ' \n ' }],
    ['a title that is not a string', { title: 5 }],
    ['starred that is not a boolean', { starred: 'yes' }],
    ['a count over 20', { addChanges: { added: 21 } }],
    ['a tally with a rename', { addChanges: { added: 1 }, title: 'x' }],
    ['a tally with a star', { addChanges: { added: 1 }, starred: true }],
    ['a tally with a rename and a star', { addChanges: {}, title: 'x', starred: false }],
    ['a negative count', { addChanges: { moved: -1 } }],
    ['a fractional count', { addChanges: { steps: 1.5 } }],
    ['an unknown counter', { addChanges: { deleted: 1 } }],
    ['addChanges that is not an object', { addChanges: [1] }],
    ['not an object', 'title'],
  ])('refuses %s', (_label, raw) => {
    expect(parsePatch(raw)).toBeNull();
  });
});

describe('parseSearch', () => {
  it('trims, and takes 2..100 characters', () => {
    expect(parseSearch({ q: '  plan  ' })).toBe('plan');
    expect(parseSearch({ q: 'ab' })).toBe('ab');
    expect(parseSearch({ q: 'x'.repeat(100) })).toBe('x'.repeat(100));
    for (const raw of [{ q: 'a' }, { q: '   ' }, { q: 'x'.repeat(101) }, { q: 5 }, { q: 'ok', limit: 3 }, {}, null]) {
      expect(parseSearch(raw), JSON.stringify(raw)).toBeNull();
    }
    expect(parseSearch({ q: `a${String.fromCharCode(0)}b` })).toBe('ab');
  });

  it('counts code points, as chat_search\'s char_length does, never UTF-16 units', () => {
    const PIZZA = '\u{1F355}';
    const PLANE2 = '\u{20000}'; // a CJK ideograph outside the BMP
    // One emoji is one character: too short, though its .length is 2.
    expect(parseSearch({ q: PIZZA })).toBeNull();
    expect(parseSearch({ q: PLANE2 })).toBeNull();
    expect(parseSearch({ q: ` ${PIZZA} ` })).toBeNull();
    expect(parseSearch({ q: PIZZA.repeat(2) })).toBe(PIZZA.repeat(2));
    expect(parseSearch({ q: `${PIZZA}a` })).toBe(`${PIZZA}a`);
    // 51..100 emoji are 102..200 units but at most 100 characters: taken.
    expect(parseSearch({ q: PIZZA.repeat(60) })).toBe(PIZZA.repeat(60));
    expect(parseSearch({ q: PIZZA.repeat(100) })).toBe(PIZZA.repeat(100));
    expect(parseSearch({ q: PIZZA.repeat(101) })).toBeNull();
    expect(parseSearch({ q: `${'x'.repeat(99)}${PIZZA}` })).toBe(`${'x'.repeat(99)}${PIZZA}`);
    expect(parseSearch({ q: `${'x'.repeat(100)}${PIZZA}` })).toBeNull();
    // A lone surrogate is one character after cleaning (U+FFFD), as Postgres would count it.
    expect(parseSearch({ q: `a${String.fromCharCode(0xd83d)}` })).toBe('a\uFFFD');
  });
});
