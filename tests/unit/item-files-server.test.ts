import { describe, expect, it } from 'vitest';
import { saveAgentItemFile, settleAgentMime } from '@/lib/item-files-server';

/**
 * The one service-role writer of item_files (migration 081): the row carries
 * the key's user and the agent's name, the path is the server's, the order is
 * row, then bytes, then ready, a failure takes its steps back, and the type is
 * settled from the bytes.
 */

type Row = Record<string, unknown>;

function fakeDb(opts: { uploadError?: boolean; readyError?: boolean; rowGone?: boolean; insertError?: Row } = {}) {
  const rows: Row[] = [];
  const calls: string[] = [];
  let inserted: Row | null = null;
  function from(table: string) {
    let op: 'insert' | 'update' | 'delete' | 'select' = 'select';
    let id: unknown;
    const b = {
      insert: (r: Row) => {
        op = 'insert';
        calls.push(`insert:${table}`);
        inserted = { ...r, ready: false, created_at: '2026-10-23T00:00:00Z' };
        if (!opts.insertError) rows.push(inserted);
        return b;
      },
      update: () => ((op = 'update'), calls.push(`update:${table}`), b),
      delete: () => ((op = 'delete'), calls.push(`delete:${table}`), b),
      select: () => b,
      eq: (_k: string, v: unknown) => ((id = v), b),
      async single() {
        if (opts.insertError) return { data: null, error: opts.insertError };
        return { data: inserted, error: null };
      },
      then(resolve: (v: unknown) => unknown) {
        if (op === 'update') {
          if (opts.readyError) return Promise.resolve({ data: null, error: { message: 'no' } }).then(resolve);
          const hit = opts.rowGone ? [] : rows.filter((r) => r.id === id);
          for (const r of hit) r.ready = true;
          return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null }).then(resolve);
        }
        if (op === 'delete') {
          const keep = rows.filter((r) => r.id !== id);
          rows.length = 0;
          rows.push(...keep);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    };
    return b;
  }
  const storage = {
    from: () => ({
      upload: async (path: string, _body: unknown, o: { contentType: string; upsert: boolean }) => (
        calls.push(`upload:${path}:${o.contentType}:${o.upsert}`),
        { error: opts.uploadError ? { message: 'no' } : null }
      ),
      remove: async (paths: string[]) => (calls.push(`remove:${paths.join(',')}`), { error: null }),
    }),
  };
  return { db: { from, storage } as never, rows, calls };
}

const input = {
  userId: 'u1',
  itemId: 'i1',
  addedBy: 'openclaw',
  name: 'Draft.pdf',
  mime: 'application/pdf',
  bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
};

describe('saveAgentItemFile', () => {
  it('writes the key’s user and the agent’s name, at <user>/<server id>, row then bytes then ready', async () => {
    const { db, rows, calls } = fakeDb();
    const res = await saveAgentItemFile(db, input);
    if (!res.ok) throw new Error(res.refusal);
    const row = rows[0];
    expect(row).toMatchObject({ user_id: 'u1', item_id: 'i1', added_by: 'openclaw', size: 5, ready: true });
    expect(row.id).toBe(res.file.id);
    expect(row.path).toBe(`u1/${res.file.id}`);
    expect(calls).toEqual(['insert:item_files', `upload:u1/${res.file.id}:application/pdf:false`, 'update:item_files']);
    expect(res.file).toEqual({ id: res.file.id, mime: 'application/pdf', size: 5 });
  });

  it('takes the row back when the bytes did not go up', async () => {
    const { db, rows, calls } = fakeDb({ uploadError: true });
    expect(await saveAgentItemFile(db, input)).toEqual({ ok: false, refusal: 'failed' });
    expect(rows).toEqual([]);
    expect(calls.at(-1)).toBe('delete:item_files');
  });

  it('takes the bytes and the row back when ready fails', async () => {
    const { db, rows, calls } = fakeDb({ readyError: true });
    expect(await saveAgentItemFile(db, input)).toEqual({ ok: false, refusal: 'failed' });
    expect(rows).toEqual([]);
    expect(calls.some((c) => c.startsWith('remove:u1/'))).toBe(true);
  });

  it('removes the bytes and fails when the row went before ready (no bytes left that nothing names)', async () => {
    const { db, calls } = fakeDb({ rowGone: true });
    expect(await saveAgentItemFile(db, input)).toEqual({ ok: false, refusal: 'failed' });
    expect(calls.some((c) => c.startsWith('remove:u1/'))).toBe(true);
  });

  it('names the cap the database refused on, and says unavailable while 081 is missing', async () => {
    const full = fakeDb({ insertError: { code: 'P0001', message: 'item_files_limit_item' } });
    expect(await saveAgentItemFile(full.db, input)).toEqual({ ok: false, refusal: 'item_full' });
    const missing = fakeDb({ insertError: { code: 'PGRST204', message: 'added_by' } });
    expect(await saveAgentItemFile(missing.db, input)).toEqual({ ok: false, refusal: 'unavailable' });
  });
});

describe('settleAgentMime', () => {
  const bytes = (...b: number[]) => new Uint8Array(b);
  const text = (s: string) => new TextEncoder().encode(s);
  it.each([
    ['png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0), undefined, 'image/png'],
    ['jpeg', bytes(0xff, 0xd8, 0xff, 0xe0), 'application/octet-stream', 'image/jpeg'],
    ['gif', text('GIF89a...'), undefined, 'image/gif'],
    ['webp', text('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '), undefined, 'image/webp'],
    ['pdf', text('%PDF-1.7'), 'text/plain', 'application/pdf'],
    ['png declared over text', text('hello'), 'image/png', 'application/octet-stream'],
    ['svg', text('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml', 'application/octet-stream'],
    ['html', text('<html><script>alert(1)</script></html>'), 'text/html', 'application/octet-stream'],
    ['plain text', text('notes, in UTF-8: café'), 'text/plain', 'text/plain'],
    ['csv with a charset', text('a,b\n1,2'), 'text/csv; charset=utf-8', 'text/csv'],
    ['text with a NUL', bytes(0x68, 0x00, 0x69), 'text/plain', 'application/octet-stream'],
    ['bad UTF-8', bytes(0xc3, 0x28), 'text/plain', 'application/octet-stream'],
    ['nothing declared', text('hello'), undefined, 'application/octet-stream'],
  ] as const)('%s', (_label, b, declared, want) => {
    expect(settleAgentMime(declared, b)).toBe(want);
  });
});
