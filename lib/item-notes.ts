/**
 * Notes on an item's timeline (migration 082): the browser's half. Rows in
 * `item_notes`, read and written through the SESSION client and RLS
 * (`createClient()` from lib/supabase), never the service role, and no server
 * route at all: no agent route, MCP tool, chat context or model call reads
 * this table (tests/unit/item-notes-boundary.test.ts).
 *
 * A note is the user's own writing: saved to the item, never sent to a model,
 * and not the description under the title (`items.notes`, which you and the
 * agents share). 082's pin (`pinned_at`, `item_note_pin`) is no longer
 * offered: the item panel tidy, round 3 made the description the one place
 * for what is true about an item, and a stored pin is simply not drawn.
 *
 * Over NOTE_MAX_CHARS a body is REFUSED, never clipped, so the text stays in
 * the box or the editor: a silent cut would lose what was written. Counted in
 * code points (`noteLength`), as 082's `char_length` counts.
 *
 * No `item_events` row is written for a note, its edit or its delete.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase';

export const NOTE_MAX_CHARS = 10_000;
export const NOTE_LIMITS = { perItem: 200, perAccount: 5_000 } as const;

export interface ItemNote {
  id: string;
  itemId: string;
  body: string;
  /** The server's created_at (ISO). */
  createdAt: string;
  /** Set by 082's trigger when the body changes; also the edit's version check. */
  editedAt: string | null;
  /** Non-null on the item's one pinned note. */
  pinnedAt: string | null;
}

export type NoteRefusal =
  | 'empty'
  | 'too_long'
  | 'item_full'
  | 'account_full'
  | 'gone'
  | 'conflict'
  | 'unavailable'
  | 'failed';

const count = (n: number) => n.toLocaleString('en-US');

export const NOTE_COPY = {
  refusal: {
    empty: () => '',
    too_long: (n?: number) =>
      `Notes can be up to ${count(NOTE_MAX_CHARS)} characters. This one has ${count(n ?? NOTE_MAX_CHARS + 1)}.`,
    item_full: () => `This item has ${count(NOTE_LIMITS.perItem)} notes, the most it can hold.`,
    account_full: () =>
      `You have ${count(NOTE_LIMITS.perAccount)} notes, the most an account can hold. Delete some to add more.`,
    gone: () => 'This item was deleted.',
    conflict: () => 'This note was changed somewhere else. Your text is still here.',
    unavailable: () => 'Notes can’t be saved right now.',
    failed: () => 'Couldn’t save your note. It’s back in the box.',
  } satisfies Record<NoteRefusal, (n?: number) => string>,
  noteGone: 'That note was deleted somewhere else.',
  editFailed: 'Couldn’t save your changes. Try again.',
  deleteFailed: 'Couldn’t delete that note. Try again.',
  copyNote: 'Copy note',
} as const;

type Db = SupabaseClient;

const COLUMNS = 'id, item_id, body, pinned_at, edited_at, created_at';

const isMissingTable = (error: { code?: string } | null): boolean =>
  error?.code === '42P01' || error?.code === 'PGRST205';

/** The body as stored: both ends trimmed, inner newlines kept. */
export function cleanNoteBody(raw: string): string {
  return raw.trim();
}

/** Characters as the database counts them (code points, `[...s].length`), not UTF-16 units. */
export function noteLength(body: string): number {
  return [...body].length;
}

/** Why a body cannot be saved as it is, before any call; null when it can. Never clips. */
export function noteRefusal(body: string): 'empty' | 'too_long' | null {
  if (!/\S/.test(body)) return 'empty';
  if (noteLength(body) > NOTE_MAX_CHARS) return 'too_long';
  return null;
}

function rowToNote(row: Record<string, unknown>): ItemNote {
  return {
    id: row.id as string,
    itemId: row.item_id as string,
    body: row.body as string,
    createdAt: row.created_at as string,
    editedAt: typeof row.edited_at === 'string' ? row.edited_at : null,
    pinnedAt: typeof row.pinned_at === 'string' ? row.pinned_at : null,
  };
}

/** An item's notes, oldest first; 'unavailable' while 082 is not applied. */
export async function listItemNotes(itemId: string, db?: Db): Promise<ItemNote[] | 'unavailable' | 'failed'> {
  try {
    const { data, error } = await (db ?? createClient())
      .from('item_notes')
      .select(COLUMNS)
      .eq('item_id', itemId)
      .order('created_at', { ascending: true });
    if (error) return isMissingTable(error) ? 'unavailable' : 'failed';
    return ((data ?? []) as unknown as Record<string, unknown>[]).map(rowToNote);
  } catch {
    return 'failed';
  }
}

/** One note by id (RLS: only yours), null when there is none, 'failed' when the read did not answer. */
export async function getItemNote(id: string, db?: Db): Promise<ItemNote | null | 'failed'> {
  try {
    const { data, error } = await (db ?? createClient()).from('item_notes').select(COLUMNS).eq('id', id).maybeSingle();
    if (error) return 'failed';
    return data ? rowToNote(data as Record<string, unknown>) : null;
  } catch {
    return 'failed';
  }
}

function insertRefusal(error: { code?: string; message?: string } | null): NoteRefusal {
  if (isMissingTable(error)) return 'unavailable';
  const m = error?.message ?? '';
  if (m.includes('item_notes_item_limit')) return 'item_full';
  if (m.includes('item_notes_account_limit')) return 'account_full';
  // The policy's WITH CHECK runs before the FK, so a purged item answers 42501;
  // 23503 is a purge that committed between the two. A 42501 that is not the
  // policy (a bare "permission denied": the request went out as anon, say) is
  // not a deleted item.
  if (error?.code === '42501' && m.includes('row-level security')) return 'gone';
  if (error?.code === '23503') return 'gone';
  return 'failed';
}

/**
 * Insert one note: exactly `{ id, item_id, body }`, never `user_id`,
 * `pinned_at` or `created_at` (082 grants no more). A 23505 on the primary key
 * is a re-save that reuses the id of an insert whose answer was lost: the row
 * is read back, and the same body counts as saved.
 */
export async function insertItemNote(
  row: { id: string; itemId: string; body: string },
  db?: Db
): Promise<{ ok: true; note: ItemNote } | { ok: false; refusal: NoteRefusal }> {
  const client = db ?? createClient();
  try {
    const { data, error } = await client
      .from('item_notes')
      .insert({ id: row.id, item_id: row.itemId, body: row.body })
      .select(COLUMNS)
      .single();
    if (!error && data) return { ok: true, note: rowToNote(data as Record<string, unknown>) };
    if (error?.code === '23505' && `${error.message ?? ''} ${error.details ?? ''}`.includes('item_notes_pkey')) {
      const back = await getItemNote(row.id, client);
      if (back && back !== 'failed' && back.body === row.body) return { ok: true, note: back };
      return { ok: false, refusal: 'failed' };
    }
    return { ok: false, refusal: insertRefusal(error) };
  } catch {
    return { ok: false, refusal: 'failed' };
  }
}

/**
 * A new body, against the version the editor started from (`edited_at`, which
 * moves only when the body does, so a pin elsewhere is never a clash). Zero
 * rows: gone when the note is, conflict when another device changed it first.
 */
export async function updateItemNoteBody(
  id: string,
  body: string,
  expectedEditedAt: string | null,
  db?: Db
): Promise<{ ok: true; editedAt: string | null } | { ok: false; refusal: NoteRefusal }> {
  const client = db ?? createClient();
  try {
    const base = client.from('item_notes').update({ body }).eq('id', id);
    const versioned = expectedEditedAt === null ? base.is('edited_at', null) : base.eq('edited_at', expectedEditedAt);
    const { data, error } = await versioned.select('edited_at').maybeSingle();
    if (error) return { ok: false, refusal: isMissingTable(error) ? 'unavailable' : 'failed' };
    if (data) {
      const at = (data as Record<string, unknown>).edited_at;
      return { ok: true, editedAt: typeof at === 'string' ? at : null };
    }
    const probe = await client.from('item_notes').select('id').eq('id', id).maybeSingle();
    if (probe.error) return { ok: false, refusal: 'failed' };
    return { ok: false, refusal: probe.data ? 'conflict' : 'gone' };
  } catch {
    return { ok: false, refusal: 'failed' };
  }
}

/** Zero rows still counts as done: the note is gone either way. */
export async function deleteItemNote(id: string, db?: Db): Promise<boolean> {
  try {
    const { error } = await (db ?? createClient()).from('item_notes').delete().eq('id', id);
    return !error;
  } catch {
    return false;
  }
}
