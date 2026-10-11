/**
 * Files kept on an item (migration 073): the browser's half. Rows in
 * `item_files` and bytes in the private `item-files` bucket, both through the
 * session client and RLS, never the service role; the server's only part is
 * the sweep (lib/item-files-sweep.ts) that removes bytes whose row is gone.
 *
 * THE ORDER IS ROW, THEN BYTES. Storage refuses an object no row of yours names
 * (073's policies), so an upload writes the row first (not ready), then the
 * bytes, then marks the row ready; a failed upload deletes its row. A delete
 * removes the bytes first, while the row still grants it, then the row (whose
 * trigger queues the path for the sweep anyway, so a failed byte delete is
 * only late, never kept).
 *
 * Nothing here is shown to a model or an agent: files are not in the chat
 * context, /api/agent/context or MCP.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase';

export const ITEM_FILES_BUCKET = 'item-files';

/** The caps 073 enforces, mirrored so the browser can say no before uploading. */
export const ITEM_FILE_LIMITS = {
  bytes: 10 * 1024 * 1024,
  perItem: 20,
} as const;

export interface ItemFile {
  id: string;
  itemId: string;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
}

/** Why an upload did not happen, in words the panel can say as they are. */
export type UploadRefusal = 'too_big' | 'empty' | 'item_full' | 'account_full' | 'unavailable' | 'failed';

export const REFUSAL_COPY: Record<UploadRefusal, (name: string) => string> = {
  too_big: (n) => `${n} is over 10 MB, the most one file can be.`,
  empty: (n) => `${n} is empty.`,
  item_full: () => 'This item has 20 files, the most it can hold.',
  account_full: () => 'Your files are full (200 files or 500 MB). Delete some to add more.',
  unavailable: () => 'Files aren’t available yet.',
  failed: (n) => `Couldn’t add ${n}. Try again.`,
};

type Db = SupabaseClient;

const isMissingTable = (error: { code?: string } | null): boolean =>
  error?.code === '42P01' || error?.code === 'PGRST205';

/** A name as stored: no path, no control characters, at most 200 characters. */
export function cleanFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const name = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name) return 'File';
  if (name.length <= 200) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
  return name.slice(0, 200 - ext.length) + ext;
}

/** A size in the words a row shows: "820 KB", "3.4 MB". */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}

/** Opened in the browser (pictures, PDFs, plain text); anything else downloads under its name. */
export function opensInline(mime: string): boolean {
  return /^image\/(png|jpe?g|gif|webp|avif)$/.test(mime) || mime === 'application/pdf' || mime === 'text/plain';
}

function rowToFile(row: Record<string, unknown>): ItemFile {
  return {
    id: row.id as string,
    itemId: row.item_id as string,
    name: row.name as string,
    mime: row.mime as string,
    size: Number(row.size),
    createdAt: row.created_at as string,
  };
}

/** An item's files, oldest first; 'unavailable' while 073 is not applied. */
export async function listItemFiles(itemId: string, db?: Db): Promise<ItemFile[] | 'unavailable' | 'failed'> {
  try {
    const { data, error } = await (db ?? createClient())
      .from('item_files')
      .select('id, item_id, name, mime, size, created_at')
      .eq('item_id', itemId)
      .eq('ready', true)
      .order('created_at', { ascending: true });
    if (error) return isMissingTable(error) ? 'unavailable' : 'failed';
    return (data ?? []).map(rowToFile);
  } catch {
    return 'failed';
  }
}

function refusalOf(error: { code?: string; message?: string } | null): UploadRefusal {
  if (isMissingTable(error)) return 'unavailable';
  const m = error?.message ?? '';
  if (m.includes('item_files_limit_item')) return 'item_full';
  if (m.includes('item_files_limit_files') || m.includes('item_files_limit_bytes')) return 'account_full';
  return 'failed';
}

/** Upload one file onto an item. Never throws. */
export async function uploadItemFile(
  input: { itemId: string; userId: string; file: File },
  db: Db = createClient()
): Promise<{ ok: true; file: ItemFile } | { ok: false; refusal: UploadRefusal }> {
  const { itemId, userId, file } = input;
  if (file.size <= 0) return { ok: false, refusal: 'empty' };
  if (file.size > ITEM_FILE_LIMITS.bytes) return { ok: false, refusal: 'too_big' };
  const id = crypto.randomUUID();
  const path = `${userId}/${id}`;
  const mime = (file.type || 'application/octet-stream').slice(0, 200);
  try {
    const inserted = await db
      .from('item_files')
      .insert({ id, item_id: itemId, name: cleanFileName(file.name), mime, size: file.size, path })
      .select('id, item_id, name, mime, size, created_at')
      .single();
    if (inserted.error || !inserted.data) return { ok: false, refusal: refusalOf(inserted.error) };

    const up = await db.storage.from(ITEM_FILES_BUCKET).upload(path, file, { contentType: mime, upsert: false });
    if (up.error) {
      await db.from('item_files').delete().eq('id', id);
      return { ok: false, refusal: 'failed' };
    }
    const done = await db.from('item_files').update({ ready: true }).eq('id', id);
    if (done.error) {
      await db.storage.from(ITEM_FILES_BUCKET).remove([path]);
      await db.from('item_files').delete().eq('id', id);
      return { ok: false, refusal: 'failed' };
    }
    return { ok: true, file: rowToFile(inserted.data) };
  } catch {
    return { ok: false, refusal: 'failed' };
  }
}

/** Delete a file: bytes first, while its row still grants them, then the row. */
export async function deleteItemFile(file: Pick<ItemFile, 'id'>, userId: string, db: Db = createClient()): Promise<boolean> {
  try {
    await db.storage.from(ITEM_FILES_BUCKET).remove([`${userId}/${file.id}`]);
    const { error } = await db.from('item_files').delete().eq('id', file.id);
    return !error;
  } catch {
    return false;
  }
}

/** A link to the file for one minute: inline for what a browser shows, a download under its own name otherwise. */
export async function fileLink(
  file: Pick<ItemFile, 'id' | 'name' | 'mime'>,
  userId: string,
  db: Db = createClient()
): Promise<string | null> {
  const { data, error } = await db.storage
    .from(ITEM_FILES_BUCKET)
    .createSignedUrl(`${userId}/${file.id}`, 60, opensInline(file.mime) ? undefined : { download: file.name });
  return error || !data?.signedUrl ? null : data.signedUrl;
}
