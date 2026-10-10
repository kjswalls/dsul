import { NextRequest, NextResponse } from 'next/server';
import { rotateWebPushToken } from '@/lib/devices/registry';
import { RotateBodySchema, answer, badRequest, isWebPushEndpoint, readJson } from '@/lib/devices/routes';
import { createClient } from '@/lib/supabase-server';
import { createServiceClient } from '@/lib/supabase-service';

/**
 * POST /api/devices/rotate — the browser replaced this device's push endpoint.
 *
 * Posted by the service worker's `pushsubscriptionchange` (app/sw.ts), with the
 * session cookie. The row holding `oldToken` for this user takes the new
 * endpoint and keeps its device id, label and switches. No old token, or no row
 * holding it ⇒ 404, and the app's next boot registers the new endpoint the
 * ordinary way: the worker has no device id of its own to register with.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const json = await readJson(req);
  if (!json.ok) return badRequest('invalid JSON');
  const parsed = RotateBodySchema.safeParse(json.body);
  if (!parsed.success || !isWebPushEndpoint(parsed.data.token)) return badRequest('invalid rotation');
  if (parsed.data.oldToken === null) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  return answer(
    await rotateWebPushToken(createServiceClient(), user.id, parsed.data.oldToken, {
      token: parsed.data.token,
      keys: parsed.data.keys,
    }),
    'devices/rotate'
  );
}
