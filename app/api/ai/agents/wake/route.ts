import { isSameOrigin, jsonError, jsonOk, readJson, requireSession } from '@/app/api/ai/_shared/guard';
import { listGrants } from '@/lib/mcp-oauth/store';
import { sameAssignee } from '@/lib/agent-assignees';
import { fireRoutine, routineFireUrl, routineToken } from '@/lib/agent-wake';
import { putWake } from '@/lib/agent-wake-store';
import { createServiceClient } from '@/lib/supabase-service';

/**
 * PUT    /api/ai/agents/wake  { assignee, url, token }  save a connected app's wake
 * DELETE /api/ai/agents/wake  { assignee }              remove it
 *
 * The wake is a Claude Code routine's /fire URL and its token (lib/agent-wake.ts),
 * written to user_secrets and never read back: /api/ai/agents says which apps
 * have one, nothing more.
 *
 * Saving fires the routine once first, with a note that nothing was handed
 * over, so a wrong URL or token is refused on the spot rather than discovered
 * the first time work goes unanswered. That costs one short run on the
 * person's Claude account, which is the price of knowing it works.
 *
 *   200 { ok: true }
 *   400 invalid           not a routine URL, a token that cannot be one, or no such app
 *   400 key_rejected      the routine refused the test fire (wrong token, deleted routine, limit)
 *   503 unavailable       migration 075 is not applied, or the write failed
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TEST_TEXT =
  'dsul is checking that this routine can be woken. Nothing was handed to you; read your queue with dsul_my_work and stop if it is empty.';

/** Only an app this account has connected with leave to change the planner may have a wake. */
async function isPlannerApp(userId: string, assignee: string): Promise<boolean> {
  const apps = await listGrants(createServiceClient(), userId).catch(() => null);
  return (apps ?? []).some((a) => a.scope === 'planner' && sameAssignee(a.name, assignee));
}

export async function PUT(req: Request): Promise<Response> {
  if (!isSameOrigin(req)) return jsonError(403, 'forbidden');
  const session = await requireSession();
  if (!session) return jsonError(401, 'unauthorized');
  const parsed = await readJson<{
    assignee?: unknown;
    url?: unknown;
    token?: unknown;
  }>(req, 4096);
  if (!parsed.ok) return jsonError(parsed.status, parsed.error);
  const { assignee } = parsed.body ?? {};
  const url = routineFireUrl(parsed.body?.url);
  const token = routineToken(parsed.body?.token);
  if (typeof assignee !== 'string' || !url || !token) return jsonError(400, 'invalid');
  if (!(await isPlannerApp(session.user.id, assignee))) return jsonError(400, 'invalid');

  if (!(await fireRoutine({ url, token }, TEST_TEXT))) return jsonError(400, 'key_rejected');
  const saved = await putWake(createServiceClient(), session.user.id, assignee, { url, token });
  if (saved !== 'ok') return jsonError(503, 'unavailable');
  return jsonOk({ ok: true });
}

export async function DELETE(req: Request): Promise<Response> {
  if (!isSameOrigin(req)) return jsonError(403, 'forbidden');
  const session = await requireSession();
  if (!session) return jsonError(401, 'unauthorized');
  const parsed = await readJson<{ assignee?: unknown }>(req, 1024);
  if (!parsed.ok) return jsonError(parsed.status, parsed.error);
  const assignee = parsed.body?.assignee;
  if (typeof assignee !== 'string' || assignee.trim() === '') return jsonError(400, 'invalid');
  // Removing needs no grant check: a disconnected app's wake should still be removable.
  const saved = await putWake(createServiceClient(), session.user.id, assignee, null);
  if (saved !== 'ok') return jsonError(503, 'unavailable');
  return jsonOk({ ok: true });
}
