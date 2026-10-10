import { NextResponse } from 'next/server';
import { NO_STORE, requireSession } from '@/app/api/ai/_shared/guard';
import { listGrants } from '@/lib/mcp-oauth/store';
import { createServiceClient } from '@/lib/supabase-service';

/**
 * GET /api/oauth/grants — the apps this account has connected to dsul over
 * OAuth, for Settings (components/settings/connected-apps.tsx). Names, scope and
 * dates only; no token ever leaves the server. 503 while migration 069 is not
 * applied, which Settings shows as "not available yet".
 */
export async function GET() {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  const apps = await listGrants(createServiceClient(), session.user.id);
  if (!apps) return NextResponse.json({ error: 'unavailable' }, { status: 503, headers: NO_STORE });
  return NextResponse.json({ apps }, { headers: NO_STORE });
}
