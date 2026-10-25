import { isSameOrigin, jsonError, jsonOk, readJson, requireSession } from '@/app/api/ai/_shared/guard';
import { readAgentsMayComplete, writeAgentsMayComplete } from '@/lib/agent-finish';
import { createServiceClient } from '@/lib/supabase-service';

/**
 * GET   /api/ai/agents/finish                    { mayComplete: boolean | null }
 * PATCH /api/ai/agents/finish  { mayComplete }  { ok: true }
 *
 * Whether agents may tick off items handed to them (lib/agent-finish.ts,
 * user_settings.agents_may_complete, migration 085). Off, an agent's "done" is
 * a report the user checks and ticks. `null` and 503 unavailable mean 085 is
 * not applied yet, and agents are refused meanwhile.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const session = await requireSession();
  if (!session) return jsonError(401, 'unauthorized');
  try {
    return jsonOk({ mayComplete: await readAgentsMayComplete(createServiceClient(), session.user.id) });
  } catch {
    return jsonError(503, 'unavailable');
  }
}

export async function PATCH(req: Request): Promise<Response> {
  if (!isSameOrigin(req)) return jsonError(403, 'forbidden');
  const session = await requireSession();
  if (!session) return jsonError(401, 'unauthorized');
  const parsed = await readJson<{ mayComplete?: unknown }>(req, 1024);
  if (!parsed.ok) return jsonError(parsed.status, parsed.error);
  const value = parsed.body?.mayComplete;
  if (typeof value !== 'boolean') return jsonError(400, 'invalid');
  try {
    if (!(await writeAgentsMayComplete(createServiceClient(), session.user.id, value))) {
      return jsonError(503, 'unavailable');
    }
  } catch {
    return jsonError(503, 'unavailable');
  }
  return jsonOk({ ok: true });
}
