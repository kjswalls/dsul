import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * POST /api/agent/items/:id/files (MCP dsul_attach_file): who may call it,
 * whose item it writes to, what it takes from the body and what it ignores,
 * the refusals in words a model can act on, and the one answer it gives.
 */

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  caller: null as null | { userId: string; scope: string; who: () => Promise<string> },
  throws: false,
  items: {} as Record<string, { user_id: string; type: string; deleted_at: string | null }>,
  insertError: null as null | { code?: string; message?: string },
  tables: [] as string[],
  inserted: [] as Row[],
  uploads: [] as { path: string; contentType: string }[],
}));

vi.mock('@/lib/agent-caller', () => ({
  NO_QUEUE: '\u0000',
  resolveAgentCaller: vi.fn(async () => {
    if (state.throws) throw new Error('db down');
    return state.caller;
  }),
}));

vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: () => {
    function from(table: string) {
      state.tables.push(table);
      let op = 'select';
      let id: unknown;
      let deletedNull = false;
      let row: Row | null = null;
      const b = {
        select: () => b,
        eq: (_k: string, v: unknown) => ((id = v), b),
        is: () => ((deletedNull = true), b),
        insert: (r: Row) => (
          (op = 'insert'),
          (row = { ...r, created_at: '2026-10-23T00:00:00Z' }),
          state.inserted.push(r),
          b
        ),
        update: () => ((op = 'update'), b),
        delete: () => ((op = 'delete'), b),
        async maybeSingle() {
          const it = state.items[id as string];
          if (!it || (deletedNull && it.deleted_at)) return { data: null, error: null };
          return { data: { user_id: it.user_id, type: it.type }, error: null };
        },
        async single() {
          if (state.insertError) return { data: null, error: state.insertError };
          return { data: row, error: null };
        },
        then(resolve: (v: unknown) => unknown) {
          if (op === 'update') return Promise.resolve({ data: [{ id }], error: null }).then(resolve);
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return b;
    }
    return {
      from,
      storage: {
        from: () => ({
          upload: async (path: string, _b: unknown, o: { contentType: string }) => (
            state.uploads.push({ path, contentType: o.contentType }),
            { error: null }
          ),
          remove: async () => ({ error: null }),
        }),
      },
    };
  },
}));

import { POST } from '@/app/api/agent/items/[id]/files/route';

const ITEM = 'a0000000-0000-4000-8000-000000000001';
let user = 0;

function post(body: unknown, opts: { auth?: string | null; raw?: string } = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (opts.auth !== null) headers.set('authorization', opts.auth ?? 'Bearer dsul_at_full');
  return POST(
    new NextRequest(`https://dsul.test/api/agent/items/${ITEM}/files`, {
      method: 'POST',
      headers,
      body: opts.raw ?? JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: ITEM }) }
  );
}

const b64 = (s: string) => Buffer.from(s).toString('base64');

beforeEach(() => {
  // A fresh user each test, so the in-memory bucket starts full.
  user += 1;
  const userId = `user-${user}`;
  state.caller = { userId, scope: 'planner', who: async () => 'openclaw' };
  state.throws = false;
  state.items = { [ITEM]: { user_id: userId, type: 'task', deleted_at: null } };
  state.insertError = null;
  state.tables = [];
  state.inserted = [];
  state.uploads = [];
});

describe('who may attach', () => {
  it('is 401 with no bearer, and for a read-only caller', async () => {
    expect((await post({ name: 'a.txt', data: b64('hi') }, { auth: null })).status).toBe(401);
    state.caller = { userId: 'u', scope: 'planner:read', who: async () => 'x' };
    expect((await post({ name: 'a.txt', data: b64('hi') })).status).toBe(401);
    state.caller = null;
    expect((await post({ name: 'a.txt', data: b64('hi') })).status).toBe(401);
  });

  it('is 503 when the key cannot be checked', async () => {
    state.throws = true;
    expect((await post({ name: 'a.txt', data: b64('hi') })).status).toBe(503);
  });

  it('is 404 for another user’s item, and for a deleted one', async () => {
    state.items[ITEM].user_id = 'someone-else';
    expect((await post({ name: 'a.txt', data: b64('hi') })).status).toBe(404);
    state.items[ITEM] = { user_id: state.caller!.userId, type: 'task', deleted_at: '2026-10-01' };
    expect((await post({ name: 'a.txt', data: b64('hi') })).status).toBe(404);
    expect(state.inserted).toEqual([]);
  });

  it('is 429 after 60 files in an hour', async () => {
    for (let i = 0; i < 60; i++) expect((await post({ name: 'a.txt', data: b64('hi') })).status).toBe(200);
    const res = await post({ name: 'a.txt', data: b64('hi') });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe('Too many files in the last hour. Try again later.');
  });
});

describe('the body', () => {
  it('is 400 for bad base64 and for an empty file', async () => {
    expect((await post({ name: 'a.txt', data: 'not base64!' })).status).toBe(400);
    expect((await post({ name: 'a.txt', data: 'abc' })).status).toBe(400);
    const empty = await post({ name: 'a.txt', data: '' });
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toBe('That file is empty.');
    expect((await post({ data: b64('hi') })).status).toBe(400);
  });

  it('takes line-wrapped base64', async () => {
    const data = b64('x'.repeat(120)).replace(/(.{76})/g, '$1\r\n');
    expect((await post({ name: 'a.txt', data, mime: 'text/plain' })).status).toBe(200);
    expect(state.inserted[0].size).toBe(120);
  });

  it('is 413 over 3 MB of file, and for a body over the cap', async () => {
    const over = Buffer.alloc(3 * 1024 * 1024 + 1).toString('base64');
    const res = await post({ name: 'big.bin', data: over });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe(
      'Files from an agent can be at most 3 MB. Report a link with dsul_report_progress instead.'
    );
    const huge = await post(null, { raw: JSON.stringify({ name: 'a', data: 'A'.repeat(4_500_000) }) });
    expect(huge.status).toBe(413);
    expect(state.inserted).toEqual([]);
  });

  it('never reads the user, the agent or the path from the body', async () => {
    const res = await post({
      name: 'a.txt',
      data: b64('hi'),
      mime: 'text/plain',
      user_id: 'victim',
      added_by: 'You',
      path: 'victim/x',
    });
    expect(res.status).toBe(200);
    const row = state.inserted[0];
    expect(row.user_id).toBe(state.caller!.userId);
    expect(row.added_by).toBe('openclaw');
    expect(row.path).toBe(`${state.caller!.userId}/${row.id}`);
    expect(row.size).toBe(2);
  });

  it('stores an agent with no name as the unnamed sentinel', async () => {
    state.caller!.who = async () => '\u0000';
    await post({ name: 'a.txt', data: b64('hi') });
    expect(state.inserted[0].added_by).toBe(' ');
  });

  it('settles the type from the bytes', async () => {
    await post({ name: 'x.svg', data: b64('<svg/>'), mime: 'image/svg+xml' });
    expect(state.inserted[0].mime).toBe('application/octet-stream');
    expect(state.uploads[0].contentType).toBe('application/octet-stream');
  });
});

describe('the answer', () => {
  it('is exactly the file just written, and writes no item_events row', async () => {
    const res = await post({ name: 'notes.txt', data: b64('hello'), mime: 'text/plain' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['fileId', 'itemId', 'mime', 'size']);
    expect(body).toMatchObject({ itemId: ITEM, mime: 'text/plain', size: 5 });
    expect(state.tables).not.toContain('item_events');
  });

  it.each([
    ['item_files_limit_item', 409, 'This item has 20 files already, the most it can hold.'],
    [
      'item_files_limit_files',
      409,
      'The user’s files are full (200 files or 500 MB). Tell them instead of trying again.',
    ],
    [
      'item_files_limit_bytes',
      409,
      'The user’s files are full (200 files or 500 MB). Tell them instead of trying again.',
    ],
  ])('maps %s to %i', async (message, status, error) => {
    state.insertError = { code: 'P0001', message };
    const res = await post({ name: 'a.txt', data: b64('hi') });
    expect(res.status).toBe(status);
    expect((await res.json()).error).toBe(error);
  });

  it('is 503 while 073 or 081 is missing, so an agent’s file is never stored reading as yours', async () => {
    for (const code of ['42P01', 'PGRST205', '42703', 'PGRST204']) {
      state.insertError = { code, message: 'missing' };
      const res = await post({ name: 'a.txt', data: b64('hi') });
      expect(res.status, code).toBe(503);
      expect((await res.json()).error).toBe('Files are not set up on this account yet');
    }
  });
});
