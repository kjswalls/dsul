/**
 * Files an agent attaches to an item (MCP `dsul_attach_file`, POST
 * /api/agent/items/:id/files): the ONE service-role writer of item_files rows
 * (migration 081's header says why it is allowed). Everything a browser can be
 * trusted not to choose, the server chooses here:
 *
 *   the user     the key's, never the body's; the route has checked the item
 *                is theirs and not deleted (the service role skips RLS)
 *   the path     `<user_id>/<server uuid>`, which 073's CHECK and unique index
 *                hold it to, so no write can name another account's bytes
 *   the size     the decoded bytes', never a declared one
 *   the type     settled from the bytes (`settleAgentMime`), so nothing an
 *                agent sends is ever served inline as HTML or SVG
 *   added_by     the agent's name, which only the service role may set (081)
 *
 * Row, then bytes, then ready, through the same `writeItemFile` the browser
 * uses, plus one check the browser does not need: the ready step must touch the
 * row, or the bytes are removed again (lib/item-files.ts says why). 073's caps
 * trigger fires for the service role too. Nothing here is read back to an
 * agent but the file it just wrote, and no item_events row is written.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { writeItemFile, type UploadRefusal } from '@/lib/item-files';

const startsWith = (bytes: Uint8Array, sig: readonly number[], at = 0): boolean =>
  bytes.length >= at + sig.length && sig.every((b, i) => bytes[at + i] === b);

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

/** Text types an agent may keep as text, when the bytes really are text. */
const TEXT_TYPES = new Set(['text/plain', 'text/csv', 'text/markdown', 'application/json']);

/**
 * The type a file is stored as. The bytes decide first, whatever was declared:
 * PNG, JPEG, GIF, WebP and PDF by their signatures. Otherwise a declared plain
 * text, CSV, Markdown or JSON type is kept when the bytes are UTF-8 with no
 * NUL. Anything else is `application/octet-stream`, which downloads under its
 * name (lib/item-files.ts `fileLink`).
 */
export function settleAgentMime(declared: string | undefined, bytes: Uint8Array): string {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  if (startsWith(bytes, ascii('%PDF-'))) return 'application/pdf';
  const type = (declared ?? '').split(';')[0].trim().toLowerCase();
  if (TEXT_TYPES.has(type) && !bytes.includes(0)) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return type;
    } catch {
      /* not text: a download */
    }
  }
  return 'application/octet-stream';
}

export interface AgentFileInput {
  userId: string;
  itemId: string;
  /** The agent's name as stored (`added_by`): a queue name, or UNNAMED_AGENT. */
  addedBy: string;
  /** Already cleaned (lib/item-files.ts `cleanFileName`). */
  name: string;
  /** Already settled (`settleAgentMime`). */
  mime: string;
  bytes: Uint8Array;
}

/** Writes one agent's file onto an item through the service client. Never throws. */
export async function saveAgentItemFile(
  db: SupabaseClient,
  input: AgentFileInput
): Promise<{ ok: true; file: { id: string; mime: string; size: number } } | { ok: false; refusal: UploadRefusal }> {
  const id = crypto.randomUUID();
  const size = input.bytes.byteLength;
  if (size <= 0) return { ok: false, refusal: 'empty' };
  const res = await writeItemFile(
    db,
    {
      id,
      item_id: input.itemId,
      name: input.name,
      mime: input.mime,
      size,
      path: `${input.userId}/${id}`,
      user_id: input.userId,
      added_by: input.addedBy,
    },
    input.bytes,
    input.mime
  );
  return res.ok ? { ok: true, file: { id, mime: input.mime, size } } : res;
}
