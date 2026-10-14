import { NextResponse } from 'next/server';
import { NO_STORE, requireSession } from '@/app/api/ai/_shared/guard';
import { listGrants } from '@/lib/mcp-oauth/store';
import { listAgentKeys } from '@/lib/agent-keys';
import { roster } from '@/lib/agent-assignees';
import { createServiceClient } from '@/lib/supabase-service';
import { listWakes } from '@/lib/agent-wake-store';
import { wakeKey } from '@/lib/agent-wake';

/**
 * GET /api/ai/agents — who besides OpenClaw the user can hand work to
 * (lib/agent-assignees.ts): every connected app and named agent key that may
 * change the planner, by name. Names only, never a token or an id. A read-only
 * app is left out, since it could take an item and never report on it.
 *
 * An app with a wake (lib/agent-wake.ts, Settings → Connected apps) says so,
 * so Do stuff can tell whether it starts at once or the next time it is opened.
 *
 * A table that is not there yet (069 or 072 unapplied) or a failed read leaves
 * its half out rather than failing the whole answer: the other half still
 * names agents that work.
 */
export async function GET() {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  const db = createServiceClient();
  const [apps, keys, wakes] = await Promise.all([
    listGrants(db, session.user.id).catch(() => null),
    listAgentKeys(db, session.user.id).catch(() => null),
    listWakes(db, session.user.id),
  ]);
  const woken = new Set(wakes);
  const agents = roster(false, [
    ...(apps ?? []).filter((a) => a.scope === 'planner').map((a) => ({ name: a.name, kind: 'app' as const })),
    ...(keys ?? []).filter((k) => k.scope === 'planner').map((k) => ({ name: k.name, kind: 'key' as const })),
  ]).map((a) => (woken.has(wakeKey(a.assignee)) ? { ...a, wake: true } : a));
  return NextResponse.json({ agents }, { headers: NO_STORE });
}
