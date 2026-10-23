/**
 * Files kept on an item (migration 073): the browser's half. Rows in
 * `item_files` and bytes in the private `item-files` bucket, both through the
 * session client and RLS, never the service role; the server's only part is
 * the sweep (lib/item-files-sweep.ts) that removes bytes whose row is gone,
 * except the agent route (lib/item-files-server.ts), the one service-role
 * writer: POST /api/agent/items/:id/files, with the user id taken from the
 * key, the path built from a server UUID, and the same row, bytes, ready order
 * (`writeItemFile`, shared). Its rows carry `added_by` (migration 081), which
 * only the service role can set; the browser's always read NULL, "You".
 *
 * THE ORDER IS ROW, THEN BYTES. Storage refuses an object no row of yours names
 * (073's policies), so an upload writes the row first (not ready), then the
 * bytes, then marks the row ready; a failed upload deletes its row. A delete
 * removes the bytes first, while the row still grants it, then the row (whose
 * trigger queues the path for the sweep anyway, so a failed byte delete is
 * only late, never kept).
 *
 * Nothing here is shown to a model or an agent: files are not in the chat
 * context, /api/agent/context or MCP. Agents may WRITE a file (MCP
 * `dsul_attach_file`) and never read one back.
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
  /** NULL: you. Otherwise the agent that added it (migration 081), UNNAMED_AGENT for one with no name. */
  addedBy: string | null;
}

/**
 * `added_by` for an agent that has no name (lib/agent-caller.ts NO_QUEUE). A
 * single space: every real name is trimmed and never blank
 * (lib/agent-assignees.ts), so none can collide with it, and 081's length
 * CHECK takes it. Rendered as "An agent".
 */
export const UNNAMED_AGENT = ' ';

/** The most of one file an agent may attach in one JSON body (base64 makes it about 4 MB). */
export const AGENT_FILE_MAX_BYTES = 3 * 1024 * 1024;

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

/** A column the build knows and the database does not yet (081 not applied). */
export const isMissingColumn = (error: { code?: string } | null): boolean =>
  error?.code === '42703' || error?.code === 'PGRST204';

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

/** The type a file card's tile says: its extension, up to 4 letters ("PDF", "DOCX"), else "FILE". */
export function fileBadge(name: string, mime: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  if (/^[a-z0-9]{1,4}$/i.test(ext)) return ext.toUpperCase();
  if (mime === 'application/pdf') return 'PDF';
  return 'FILE';
}

/** A picture the timeline may draw as itself: never an SVG, which is a document. */
export function isThumbable(mime: string): boolean {
  return /^image\/(png|jpe?g|gif|webp|avif)$/.test(mime);
}

function rowToFile(row: Record<string, unknown>): ItemFile {
  return {
    id: row.id as string,
    itemId: row.item_id as string,
    name: row.name as string,
    mime: row.mime as string,
    size: Number(row.size),
    createdAt: row.created_at as string,
    addedBy: typeof row.added_by === 'string' ? row.added_by : null,
  };
}

const LIST_COLUMNS = 'id, item_id, name, mime, size, created_at';

/**
 * An item's files, oldest first; 'unavailable' while 073 is not applied. A
 * build ahead of 081 (a fresh clone, a rolled-back 081) asks again without
 * `added_by`, and every file reads as yours.
 */
export async function listItemFiles(itemId: string, db?: Db): Promise<ItemFile[] | 'unavailable' | 'failed'> {
  const list = (columns: string) =>
    (db ?? createClient())
      .from('item_files')
      .select(columns)
      .eq('item_id', itemId)
      .eq('ready', true)
      .order('created_at', { ascending: true });
  try {
    let { data, error } = await list(`${LIST_COLUMNS}, added_by`);
    if (error && isMissingColumn(error)) ({ data, error } = await list(LIST_COLUMNS));
    if (error) return isMissingTable(error) ? 'unavailable' : 'failed';
    return ((data ?? []) as unknown as Record<string, unknown>[]).map(rowToFile);
  } catch {
    return 'failed';
  }
}

export function refusalOf(error: { code?: string; message?: string } | null): UploadRefusal {
  if (isMissingTable(error) || isMissingColumn(error)) return 'unavailable';
  const m = error?.message ?? '';
  if (m.includes('item_files_limit_item')) return 'item_full';
  if (m.includes('item_files_limit_files') || m.includes('item_files_limit_bytes')) return 'account_full';
  return 'failed';
}

/** One row as written: the browser's columns, plus the two only the service role sends. */
export interface ItemFileRow {
  id: string;
  item_id: string;
  name: string;
  mime: string;
  size: number;
  path: string;
  user_id?: string;
  added_by?: string;
}

/**
 * Row, then bytes, then ready, each step undone if a later one fails. Pure over
 * its client: the browser's session client (`uploadItemFile`) or the agent
 * route's service client (lib/item-files-server.ts). The row is read back with
 * the columns every build has, never `added_by`, so a browser upload still
 * works before 081 is applied.
 *
 * A row that carries `user_id` is the service role's, which Storage's policies
 * do not hold to "a file is reachable exactly while its row exists". So its
 * ready step must touch the row: if the row went in between (the account
 * deleted, the stale sweep), the bytes are removed again and the write fails,
 * rather than leaving bytes no row or sweep entry names.
 */
export async function writeItemFile(
  db: Db,
  row: ItemFileRow,
  body: Blob | Uint8Array,
  contentType: string
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; refusal: UploadRefusal }> {
  const serviceRole = row.user_id !== undefined;
  try {
    const inserted = await db.from('item_files').insert(row).select(LIST_COLUMNS).single();
    if (inserted.error || !inserted.data) return { ok: false, refusal: refusalOf(inserted.error) };

    const up = await db.storage.from(ITEM_FILES_BUCKET).upload(row.path, body, { contentType, upsert: false });
    if (up.error) {
      await db.from('item_files').delete().eq('id', row.id);
      return { ok: false, refusal: 'failed' };
    }
    const ready = db.from('item_files').update({ ready: true }).eq('id', row.id);
    const done = serviceRole ? await ready.select('id') : await ready;
    const gone = serviceRole && !done.error && (!Array.isArray(done.data) || done.data.length === 0);
    if (done.error || gone) {
      await db.storage.from(ITEM_FILES_BUCKET).remove([row.path]);
      await db.from('item_files').delete().eq('id', row.id);
      return { ok: false, refusal: 'failed' };
    }
    return { ok: true, data: inserted.data as Record<string, unknown> };
  } catch {
    return { ok: false, refusal: 'failed' };
  }
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
  const res = await writeItemFile(
    db,
    { id, item_id: itemId, name: cleanFileName(file.name), mime, size: file.size, path },
    file,
    mime
  );
  // The session client never sets added_by (081's trigger would null it anyway).
  return res.ok ? { ok: true, file: { ...rowToFile(res.data), addedBy: null } } : res;
}

/** Delete a file: bytes first, while its row still grants them, then the row. */
export async function deleteItemFile(
  file: Pick<ItemFile, 'id'>,
  userId: string,
  db: Db = createClient()
): Promise<boolean> {
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

/** How long a thumbnail's link lasts. Short, since a signed URL skips 073's policies; an expired one is signed again. */
export const THUMB_TTL_S = 600;

/**
 * Links for the pictures among `files`, by file id, signed in one call and
 * shown inline (no download option). Only thumbable ones are asked for.
 */
export async function thumbLinks(
  files: readonly Pick<ItemFile, 'id' | 'mime'>[],
  userId: string,
  db: Db = createClient()
): Promise<Record<string, string>> {
  const pictures = files.filter((f) => isThumbable(f.mime));
  if (pictures.length === 0) return {};
  try {
    const { data, error } = await db.storage.from(ITEM_FILES_BUCKET).createSignedUrls(
      pictures.map((f) => `${userId}/${f.id}`),
      THUMB_TTL_S
    );
    if (error || !data) return {};
    const out: Record<string, string> = {};
    data.forEach((d, i) => {
      // Matched by path where Storage names it, by position otherwise.
      const id = d?.path ? d.path.slice(d.path.indexOf('/') + 1) : pictures[i]?.id;
      if (id && d?.signedUrl && !d.error) out[id] = d.signedUrl;
    });
    return out;
  } catch {
    return {};
  }
}
