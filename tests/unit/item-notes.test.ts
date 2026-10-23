import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  NOTE_COPY,
  cleanNoteBody,
  deleteItemNote,
  insertItemNote,
  listItemNotes,
  noteLength,
  noteRefusal,
  pinItemNote,
  unpinItemNote,
  updateItemNoteBody,
} from '@/lib/item-notes';

/**
 * lib/item-notes.ts over a fake session client: what each call sends, and how
 * each answer (082's trigger messages, RLS's 42501, a lost insert's 23505, an
 * edit that found nothing) maps to a refusal.
 */

type Answer = { data?: unknown; error?: { code?: string; message?: string; details?: string } | null };

function fakeDb(answers: Answer[]) {
  const calls: { table: string; ops: [string, ...unknown[]][] }[] = [];
  const next = () => Promise.resolve({ data: null, error: null, ...(answers.shift() ?? {}) });
  const db = {
    from(table: string) {
      const rec = { table, ops: [] as [string, ...unknown[]][] };
      calls.push(rec);
      const b: Record<string, unknown> = new Proxy(
        {},
        {
          get(_, prop: string) {
            if (prop === 'then')
              return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => next().then(res, rej);
            return (...args: unknown[]) => {
              rec.ops.push([prop, ...args]);
              return b;
            };
          },
        }
      );
      return b;
    },
    rpc: vi.fn(() => next()),
  };
  return { db: db as unknown as SupabaseClient, calls, rpc: db.rpc };
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 'n1',
  item_id: 'i1',
  body: 'hello',
  pinned_at: null,
  edited_at: null,
  created_at: '2026-10-23T09:00:00Z',
  ...over,
});

describe('list', () => {
  it('maps rows, scoped to the item and oldest first', async () => {
    const { db, calls } = fakeDb([{ data: [row({ pinned_at: '2026-10-23T10:00:00Z' })] }]);
    expect(await listItemNotes('i1', db)).toEqual([
      {
        id: 'n1',
        itemId: 'i1',
        body: 'hello',
        createdAt: '2026-10-23T09:00:00Z',
        editedAt: null,
        pinnedAt: '2026-10-23T10:00:00Z',
      },
    ]);
    expect(calls[0].table).toBe('item_notes');
    expect(calls[0].ops).toContainEqual(['eq', 'item_id', 'i1']);
    expect(calls[0].ops.find((o) => o[0] === 'order')?.[1]).toBe('created_at');
  });

  it.each(['42P01', 'PGRST205'])('is unavailable on %s', async (code) => {
    const { db } = fakeDb([{ error: { code } }]);
    expect(await listItemNotes('i1', db)).toBe('unavailable');
  });
});

describe('insert', () => {
  it('sends exactly id, item_id and body', async () => {
    const { db, calls } = fakeDb([{ data: row() }]);
    const res = await insertItemNote({ id: 'n1', itemId: 'i1', body: 'hello' }, db);
    expect(res).toMatchObject({ ok: true, note: { id: 'n1', body: 'hello' } });
    const insert = calls[0].ops.find((o) => o[0] === 'insert');
    expect(insert?.[1]).toEqual({ id: 'n1', item_id: 'i1', body: 'hello' });
  });

  it.each([
    [{ message: 'item_notes_item_limit', code: 'P0001' }, 'item_full'],
    [{ message: 'item_notes_account_limit', code: 'P0001' }, 'account_full'],
    [{ code: '42501', message: 'new row violates row-level security policy' }, 'gone'],
    [{ code: '42501', message: 'permission denied for table item_notes' }, 'failed'],
    [{ code: '23503', message: 'violates foreign key constraint' }, 'gone'],
    [{ code: '42P01' }, 'unavailable'],
    [{ code: '57014' }, 'failed'],
  ])('maps %o to %s', async (error, refusal) => {
    const { db } = fakeDb([{ error }]);
    expect(await insertItemNote({ id: 'n1', itemId: 'i1', body: 'hello' }, db)).toEqual({ ok: false, refusal });
  });

  it('reads a 23505 on the primary key back: the same body is saved, another is not', async () => {
    const dup = { code: '23505', message: 'duplicate key value violates unique constraint "item_notes_pkey"' };
    const same = fakeDb([{ error: dup }, { data: row() }]);
    expect(await insertItemNote({ id: 'n1', itemId: 'i1', body: 'hello' }, same.db)).toMatchObject({ ok: true });
    expect(same.calls[1].ops).toContainEqual(['eq', 'id', 'n1']);
    const other = fakeDb([{ error: dup }, { data: row({ body: 'something else' }) }]);
    expect(await insertItemNote({ id: 'n1', itemId: 'i1', body: 'hello' }, other.db)).toEqual({
      ok: false,
      refusal: 'failed',
    });
  });
});

describe('before any call', () => {
  it('refuses a blank body and one over 10,000 characters, and never clips', () => {
    expect(noteRefusal('')).toBe('empty');
    expect(noteRefusal(' \n\t ')).toBe('empty');
    expect(noteRefusal('x'.repeat(10_001))).toBe('too_long');
    expect(noteRefusal('x'.repeat(10_000))).toBeNull();
    expect(NOTE_COPY.refusal.too_long(12_345)).toBe('Notes can be up to 10,000 characters. This one has 12,345.');
  });

  it('counts code points, as the database does: 10,000 emoji are allowed', () => {
    const emoji = '😀'.repeat(10_000);
    expect(emoji.length).toBe(20_000);
    expect(noteLength(emoji)).toBe(10_000);
    expect(noteRefusal(emoji)).toBeNull();
    expect(noteRefusal(emoji + '😀')).toBe('too_long');
  });

  it('trims the ends and keeps inner newlines', () => {
    expect(cleanNoteBody('  \nfirst\n\nsecond  \n')).toBe('first\n\nsecond');
  });
});

describe('pin and unpin', () => {
  it('pins through the RPC', async () => {
    const { db, rpc } = fakeDb([{ data: '2026-10-23T10:00:00Z' }]);
    expect(await pinItemNote('n1', db)).toEqual({ ok: true, pinnedAt: '2026-10-23T10:00:00Z' });
    expect(rpc).toHaveBeenCalledWith('item_note_pin', { p_note: 'n1' });
  });

  it('is gone on a null answer, and failed on a 23505 with no retry', async () => {
    expect(await pinItemNote('n1', fakeDb([{ data: null }]).db)).toEqual({ ok: false, refusal: 'gone' });
    const dup = fakeDb([{ error: { code: '23505' } }]);
    expect(await pinItemNote('n1', dup.db)).toEqual({ ok: false, refusal: 'failed' });
    expect(dup.rpc).toHaveBeenCalledTimes(1);
  });

  it('unpins with a plain update, gone when no row answers', async () => {
    const ok = fakeDb([{ data: { id: 'n1' } }]);
    expect(await unpinItemNote('n1', ok.db)).toEqual({ ok: true });
    expect(ok.calls[0].ops.find((o) => o[0] === 'update')?.[1]).toEqual({ pinned_at: null });
    expect(await unpinItemNote('n1', fakeDb([{ data: null }]).db)).toEqual({ ok: false, refusal: 'gone' });
  });
});

describe('edit', () => {
  it('sends the edited_at version: eq for a set one, is null for none', async () => {
    const set = fakeDb([{ data: { edited_at: '2026-10-23T11:00:00Z' } }]);
    expect(await updateItemNoteBody('n1', 'new', '2026-10-23T10:00:00Z', set.db)).toEqual({
      ok: true,
      editedAt: '2026-10-23T11:00:00Z',
    });
    expect(set.calls[0].ops).toContainEqual(['update', { body: 'new' }]);
    expect(set.calls[0].ops).toContainEqual(['eq', 'edited_at', '2026-10-23T10:00:00Z']);
    const none = fakeDb([{ data: { edited_at: '2026-10-23T11:00:00Z' } }]);
    await updateItemNoteBody('n1', 'new', null, none.db);
    expect(none.calls[0].ops).toContainEqual(['is', 'edited_at', null]);
  });

  it('is gone when nothing matched and no row is there, conflict when one is', async () => {
    expect(await updateItemNoteBody('n1', 'new', null, fakeDb([{ data: null }, { data: null }]).db)).toEqual({
      ok: false,
      refusal: 'gone',
    });
    expect(await updateItemNoteBody('n1', 'new', null, fakeDb([{ data: null }, { data: { id: 'n1' } }]).db)).toEqual({
      ok: false,
      refusal: 'conflict',
    });
  });
});

describe('delete', () => {
  it('counts zero rows as done, and an error as not', async () => {
    expect(await deleteItemNote('n1', fakeDb([{ data: null }]).db)).toBe(true);
    expect(await deleteItemNote('n1', fakeDb([{ error: { code: '57014' } }]).db)).toBe(false);
  });
});
