import { after } from 'next/server';
import { isSameOrigin, jsonError, jsonOk, readJson, requireSession } from '@/app/api/ai/_shared/guard';
import { claimWake, fireRoutine, fireText, MAX_FIRE_ITEMS, wakeKey } from '@/lib/agent-wake';
import { getWake } from '@/lib/agent-wake-store';
import { createServiceClient } from '@/lib/supabase-service';

/**
 * POST /api/agent/app-wake — wake the connected apps that work was just handed
 * to (lib/agent-wake.ts). OpenClaw hears its own work on /api/agent/events.
 *
 * Body `{ itemIds }`, up to 50: the browser gathers a burst of hand-offs (make
 * it so hands a whole lane over at once) into one call, so one hand-off is one
 * run, not one run per item (lib/handoff-wake.ts). The items are read through
 * the SESSION client, so RLS is the tenant guard; only those still handed to
 * an app and queued count, grouped by the app.
 *
 *   200 { woken: string[] }   the apps a wake is on its way to (after the response)
 *
 * An app with no wake, or one woken under a minute ago, is left out quietly:
 * the wake is a nudge, never the hand-off, and the app still finds its items
 * the next time it reads its queue. Nothing here answers 500.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Values no app answers to (lib/agent-assignees.ts RESERVED); OpenClaw has its own wake. */
const NOT_AN_APP = new Set(['openclaw', 'beacon', 'ai', 'you', 'me']);
const QUEUED = new Set<string | null>([null, 'queued']);
const FINISHED = new Set(['completed', 'cancelled']);

export async function POST(req: Request): Promise<Response> {
  if (!isSameOrigin(req)) return jsonError(403, 'forbidden');
  const session = await requireSession();
  if (!session) return jsonError(401, 'unauthorized');

  const parsed = await readJson<{ itemIds?: unknown }>(req, 8192);
  if (!parsed.ok) return jsonError(parsed.status, parsed.error);
  const raw = parsed.body?.itemIds;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_FIRE_ITEMS) return jsonError(400, 'invalid');
  if (!raw.every((id) => typeof id === 'string' && UUID.test(id))) return jsonError(400, 'invalid');
  const itemIds = [...new Set(raw as string[])];

  const { user, db } = session;
  let rows: Record<string, unknown>[];
  try {
    const { data, error } = await db
      .from('items')
      .select('id, status, assignee, ai_status')
      .in('id', itemIds)
      .eq('user_id', user.id)
      .is('deleted_at', null);
    if (error) return jsonError(503, 'server');
    rows = (data ?? []) as Record<string, unknown>[];
  } catch {
    return jsonError(503, 'server');
  }

  // The items still handed to an app and waiting, by app.
  const byApp = new Map<string, { assignee: string; ids: string[] }>();
  for (const row of rows) {
    const assignee = row.assignee;
    if (typeof assignee !== 'string' || assignee === '' || NOT_AN_APP.has(assignee.toLowerCase())) continue;
    const aiStatus = (row.ai_status as string | null | undefined) ?? null;
    const status = (row.status as string | null | undefined) ?? null;
    if (!QUEUED.has(aiStatus) || (status !== null && FINISHED.has(status))) continue;
    const key = wakeKey(assignee);
    const group = byApp.get(key) ?? { assignee, ids: [] };
    group.ids.push(String(row.id));
    byApp.set(key, group);
  }

  const service = createServiceClient();
  const woken: string[] = [];
  const now = Date.now();
  for (const [key, group] of byApp) {
    const wake = await getWake(service, user.id, group.assignee);
    if (!wake || !claimWake(`${user.id}:${key}`, now)) continue;
    woken.push(group.assignee);
    // After the response: the browser is not waiting on Anthropic's answer.
    after(() => fireRoutine(wake, fireText(group.ids)));
  }
  return jsonOk({ woken });
}
