import { NextRequest, NextResponse } from 'next/server';
import { releaseWebPushToken } from '@/lib/devices/registry';
import { answer, badRequest, isWebPushEndpoint, readJson } from '@/lib/devices/routes';
import { createClient } from '@/lib/supabase-server';
import { createServiceClient } from '@/lib/supabase-service';

/**
 * POST /api/push/unsubscribe — the pre-registry way out, kept for ONE release.
 *
 * Body: { endpoint }. The same release as /api/devices/release's token form,
 * for a page loaded from a build before the registry. Still asks for a session,
 * as it always did.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const json = await readJson(req);
  if (!json.ok) return badRequest('invalid JSON');
  const { endpoint } = (json.body ?? {}) as Record<string, unknown>;
  if (!isWebPushEndpoint(endpoint)) return badRequest('endpoint is required');

  return answer(await releaseWebPushToken(createServiceClient(), endpoint), 'push/unsubscribe');
}
