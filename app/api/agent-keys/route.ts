import { NextResponse, type NextRequest } from 'next/server';
import { NO_STORE, isSameOrigin, requireSession } from '@/app/api/ai/_shared/guard';
import { cleanKeyName, createAgentKey, listAgentKeys } from '@/lib/agent-keys';
import { isScope } from '@/lib/mcp-oauth/scopes';
import { createServiceClient } from '@/lib/supabase-service';

/**
 * GET /api/agent-keys — this account's named agent keys, for Settings
 * (components/settings/agent-keys.tsx): names, scope and dates, never a key or
 * its hash. 503 while migration 072 is not applied.
 */
export async function GET() {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  const keys = await listAgentKeys(createServiceClient(), session.user.id);
  if (!keys) return NextResponse.json({ error: 'unavailable' }, { status: 503, headers: NO_STORE });
  return NextResponse.json({ keys }, { headers: NO_STORE });
}

/**
 * POST /api/agent-keys { name, scope } — make a key. The response is the only
 * place the key itself ever appears; Settings shows it once and forgets it.
 */
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE });
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid' }, { status: 400, headers: NO_STORE });
  }
  const { name: rawName, scope } = (body ?? {}) as { name?: unknown; scope?: unknown };
  const name = cleanKeyName(rawName);
  if (!name || !isScope(scope)) return NextResponse.json({ error: 'invalid' }, { status: 400, headers: NO_STORE });
  const made = await createAgentKey(createServiceClient(), session.user.id, name, scope);
  if (!made.ok) {
    return made.error === 'limit'
      ? NextResponse.json({ error: 'limit' }, { status: 409, headers: NO_STORE })
      : NextResponse.json({ error: 'unavailable' }, { status: 503, headers: NO_STORE });
  }
  return NextResponse.json({ key: made.key, agentKey: made.agentKey }, { status: 201, headers: NO_STORE });
}
