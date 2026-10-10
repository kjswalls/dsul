import { NextRequest, NextResponse } from 'next/server';
import { registerDevice } from '@/lib/devices/registry';
import { answer, badRequest, isWebPushEndpoint, placeholderDeviceId, readJson } from '@/lib/devices/routes';
import { createClient } from '@/lib/supabase-server';
import { createServiceClient } from '@/lib/supabase-service';

/**
 * POST /api/push/subscribe — the pre-registry way in, kept for ONE release.
 *
 * Body: { endpoint, p256dh, auth }. A page loaded from a build before the
 * device registry still posts here; it becomes a registration under the same
 * placeholder device id 064's backfill gives an endpoint, and the page's next
 * boot on the new build moves the row to its real id. New code posts to
 * /api/devices.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const json = await readJson(req);
  if (!json.ok) return badRequest('invalid JSON');
  const { endpoint, p256dh, auth } = (json.body ?? {}) as Record<string, unknown>;
  if (!isWebPushEndpoint(endpoint) || typeof p256dh !== 'string' || typeof auth !== 'string' || !p256dh || !auth) {
    return badRequest('endpoint, p256dh, and auth are required');
  }

  return answer(
    await registerDevice(createServiceClient(), user.id, {
      deviceId: placeholderDeviceId(endpoint),
      platform: 'web',
      transport: 'webpush',
      token: endpoint,
      keys: { p256dh: p256dh.slice(0, 200), auth: auth.slice(0, 100) },
    }),
    'push/subscribe'
  );
}
