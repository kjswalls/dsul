import { NextResponse, type NextRequest } from 'next/server';
import { NO_STORE, isSameOrigin, requireSession } from '@/app/api/ai/_shared/guard';
import { revokeGrant } from '@/lib/mcp-oauth/store';
import { createServiceClient } from '@/lib/supabase-service';

/** DELETE /api/oauth/grants/:id — Settings' Disconnect: the app's tokens stop working at once. */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE });
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  const ok = await revokeGrant(createServiceClient(), session.user.id, id);
  return ok
    ? NextResponse.json({ ok: true }, { headers: NO_STORE })
    : NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
}
