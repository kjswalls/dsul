import { NextRequest, NextResponse } from 'next/server';
import { readJson } from '@/app/api/ai/_shared/guard';
import { NO_QUEUE, resolveAgentCaller, type AgentCaller } from '@/lib/agent-caller';
import { takeToken } from '@/lib/ai-server/rate-limit';
import { AGENT_FILE_MAX_BYTES, UNNAMED_AGENT, cleanFileName, type UploadRefusal } from '@/lib/item-files';
import { saveAgentItemFile, settleAgentMime } from '@/lib/item-files-server';
import { createServiceClient } from '@/lib/supabase-service';

/**
 * POST /api/agent/items/:id/files — an agent attaches a file to one of the
 * user's items (MCP `dsul_attach_file`). The one service-role writer of
 * item_files (lib/item-files-server.ts, migration 081).
 *
 * Body `{ name, data, mime? }`: `data` is the file as base64 (line breaks
 * allowed), at most AGENT_FILE_MAX_BYTES of file. Every other key is ignored:
 * the user, `added_by` and the path are never read from the body.
 *
 *   200 { itemId, fileId, mime, size }   the file just written, and nothing else
 *
 * Only a full `planner` token reaches it, the same bar as every agent write. No
 * assignment is needed: any key that may edit the item's notes may attach to
 * it. No item_events row is written, and nothing here reads a file back.
 *
 * The 60/h bucket is per instance (lib/ai-server/rate-limit.ts), a speed bump
 * for a looping agent; 073's caps are the real bound. It is taken before the
 * body is read, so a malformed or oversized body spends a token too.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The JSON body, at most: 3 MB of file as base64 is 4,194,304 characters, plus the name and the envelope. */
export const AGENT_FILE_BODY_MAX = 4_400_000;

const TOO_BIG = 'Files from an agent can be at most 3 MB. Report a link with dsul_report_progress instead.';
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const REFUSALS: Record<UploadRefusal, { status: number; error: string }> = {
  item_full: { status: 409, error: 'This item has 20 files already, the most it can hold.' },
  account_full: {
    status: 409,
    error: 'The user’s files are full (200 files or 500 MB). Tell them instead of trying again.',
  },
  unavailable: { status: 503, error: 'Files are not set up on this account yet' },
  failed: { status: 500, error: 'The file could not be saved. Try again later.' },
  empty: { status: 400, error: 'That file is empty.' },
  too_big: { status: 413, error: TOO_BIG },
};

const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return fail(401, 'Unauthorized');

  let caller: AgentCaller | null;
  try {
    caller = await resolveAgentCaller(auth.slice(7));
  } catch {
    return fail(503, 'Auth unavailable');
  }
  if (!caller || caller.scope !== 'planner') return fail(401, 'Unauthorized');
  const { userId } = caller;

  if (!takeToken(userId, 'agent_file')) return fail(429, 'Too many files in the last hour. Try again later.');

  const parsed = await readJson<Record<string, unknown>>(req, AGENT_FILE_BODY_MAX);
  if (!parsed.ok) {
    if (parsed.status === 413) return fail(413, TOO_BIG);
    if (parsed.status === 415) return fail(415, 'Send the body as application/json');
    return fail(400, 'Invalid JSON body');
  }
  const body = parsed.body && typeof parsed.body === 'object' && !Array.isArray(parsed.body) ? parsed.body : {};
  const { name, data, mime } = body as { name?: unknown; data?: unknown; mime?: unknown };
  if (typeof name !== 'string' || !name.trim()) return fail(400, 'name is required and must be a non-empty string');
  if (typeof data !== 'string') return fail(400, 'data is required: the file as base64');
  if (mime !== undefined && typeof mime !== 'string') return fail(400, 'mime must be a string');

  // Line-wrapped base64 (76-column MIME style) is fine; anything else is not base64.
  const b64 = data.replace(/[\r\n]/g, '');
  if (b64.length % 4 !== 0 || !BASE64.test(b64)) return fail(400, 'data must be the file as base64');
  const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
  if (bytes.byteLength === 0) return fail(400, 'That file is empty.');
  if (bytes.byteLength > AGENT_FILE_MAX_BYTES) return fail(413, TOO_BIG);

  const { id } = await params;
  // Not a uuid is not an item: answer 404, never the 503 Postgres's cast error would read as.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return fail(404, 'Not found');
  const db = createServiceClient();
  try {
    // The service client skips RLS, so ownership is all that stands between this
    // and another account's item. Id-only, as the sibling routes do.
    const { data: owner, error } = await db
      .from('items')
      .select('user_id, type')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) return fail(503, 'Unavailable');
    if (!owner || owner.user_id !== userId) return fail(404, 'Not found');
  } catch {
    return fail(503, 'Unavailable');
  }

  let addedBy: string;
  try {
    const who = await caller.who();
    addedBy = who === NO_QUEUE ? UNNAMED_AGENT : who;
  } catch {
    addedBy = UNNAMED_AGENT;
  }

  const res = await saveAgentItemFile(db, {
    userId,
    itemId: id,
    addedBy,
    name: cleanFileName(name),
    mime: settleAgentMime(mime, bytes),
    bytes,
  });
  if (!res.ok) {
    const r = REFUSALS[res.refusal];
    return fail(r.status, r.error);
  }
  return NextResponse.json({ itemId: id, fileId: res.file.id, mime: res.file.mime, size: res.file.size });
}
