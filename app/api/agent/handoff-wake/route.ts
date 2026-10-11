import { after } from 'next/server';
import { isSameOrigin, jsonError, jsonOk, readJson, requireSession } from '@/app/api/ai/_shared/guard';
import { notifyPlugins } from '@/lib/openclaw-registry';

/**
 * POST /api/agent/handoff-wake — wake the user's OpenClaw agent the moment an
 * item is handed to it (ai-vision-decisions.md, decisions 2 and 4, 2026-10-11).
 *
 * A hand-off is a browser write (lib/agent-handoff.ts), and the browser cannot
 * reach the plugin: `notifyPlugins` needs the service key, so there it is a
 * no-op. The planner store calls this once the assignment has landed
 * (lib/handoff-wake.ts), and the plugin's webhook route starts a run that reads
 * `dsul_my_work`. The wake is a nudge, never the hand-off: an agent that misses
 * it still finds the item on its next poll, so nothing here ever answers 500.
 *
 * Body `{ itemId }`. The item is read through the SESSION client, so RLS is the
 * tenant guard, and the event names only `{ itemId, title, type }`.
 *
 *   200 { woken: true }   the event is on its way (after the response)
 *   200 { woken: false }  this item was woken under a minute ago
 *   404 not_found         no such item of yours (or it is in the trash)
 *   409 conflict          it is not assigned to the agent, or no longer queued
 *
 * Only a registration that listed `items.handedOff` (or `*`) receives it:
 * `notifyPlugins` drops the rest, so a plugin from before the wake hears nothing.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One wake per item per minute. Hand off, take back, hand off again is three
 * clicks, and each wake can start a model run on the user's gateway, so the
 * repeat is dropped here rather than spent there. In memory, so per instance:
 * a bound on a flood, not a guarantee, which is all a nudge needs.
 */
const WAKE_COOLDOWN_MS = 60_000;
const lastWake = new Map<string, number>();

function claimWake(key: string, now: number): boolean {
  const at = lastWake.get(key);
  if (at !== undefined && now - at < WAKE_COOLDOWN_MS) return false;
  lastWake.set(key, now);
  if (lastWake.size > 256) {
    for (const [k, t] of lastWake) if (now - t >= WAKE_COOLDOWN_MS) lastWake.delete(k);
  }
  return true;
}

/**
 * lib/agent-handoff.ts `DELEGATE_ASSIGNEE`, spelled out: that module pulls in
 * the planner store, which has no business in a route.
 */
const DELEGATE = 'openclaw';
/** The statuses a queued item can still be in: none yet (an assignment alone) or 'queued'. */
const QUEUED = new Set<string | null>([null, 'queued']);
/** One-off statuses that end the item; a wake for one of these would find nothing to do. */
const FINISHED = new Set(['completed', 'cancelled']);

export async function POST(req: Request): Promise<Response> {
  if (!isSameOrigin(req)) return jsonError(403, 'forbidden');
  const session = await requireSession();
  if (!session) return jsonError(401, 'unauthorized');

  const parsed = await readJson<{ itemId?: unknown }>(req, 1024);
  if (!parsed.ok) return jsonError(parsed.status, parsed.error);
  const itemId = parsed.body?.itemId;
  if (typeof itemId !== 'string' || !UUID.test(itemId)) return jsonError(400, 'invalid');

  const { user, db } = session;
  let row: Record<string, unknown> | null;
  try {
    const { data, error } = await db
      .from('items')
      .select('id, title, type, status, assignee, ai_status')
      .eq('id', itemId)
      .eq('user_id', user.id)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) return jsonError(503, 'server');
    row = data as Record<string, unknown> | null;
  } catch {
    return jsonError(503, 'server');
  }
  if (!row) return jsonError(404, 'not_found');

  const aiStatus = (row.ai_status as string | null | undefined) ?? null;
  const status = (row.status as string | null | undefined) ?? null;
  if (row.assignee !== DELEGATE || !QUEUED.has(aiStatus) || (status !== null && FINISHED.has(status))) {
    return jsonError(409, 'conflict');
  }

  if (!claimWake(`${user.id}:${itemId}`, Date.now())) return jsonOk({ woken: false });

  const data = { itemId, title: String(row.title ?? ''), type: String(row.type ?? '') };
  // After the response, as lib/app-api.ts sends its agent webhook: the gateway
  // may be slow, and the browser is not waiting on it.
  after(() => notifyPlugins(user.id, 'items.handedOff', data));
  return jsonOk({ woken: true });
}
