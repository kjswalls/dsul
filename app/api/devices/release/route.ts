import { NextRequest, NextResponse } from 'next/server';
import { releaseOwnDevice, releaseWebPushToken } from '@/lib/devices/registry';
import { ReleaseBodySchema, answer, badRequest, isWebPushEndpoint, readJson } from '@/lib/devices/routes';
import { createClient } from '@/lib/supabase-server';
import { createServiceClient } from '@/lib/supabase-service';

/**
 * POST /api/devices/release — this device stops being reachable.
 *
 * Two forms (memory/plans/reminders-platforms.md §3.2):
 *
 *   { transport: 'webpush', token }   NO SESSION NEEDED (#254). A browser has
 *       to let go of its subscription whenever the person at it changes, and
 *       most of those moments come with no session for the account that left
 *       (lib/local-state.ts lists them). The endpoint is an unguessable
 *       capability URL, and whoever holds it can already push to it, so
 *       releasing it grants nothing new. Matched on the exact endpoint and
 *       nothing else (never a user id: the row may be someone else's), a miss
 *       is a no-op, and the answer is `{ ok: true }` either way. Web push only:
 *       an APNs or FCM token cannot send by itself, and an open
 *       delete-by-token for one would be a free denial of service.
 *
 *   { deviceId }   COOKIE. Deletes the session user's own row with that id,
 *       the form a tokenless desktop row needs at sign-out.
 *
 * The browser calls the first form BEFORE `subscription.unsubscribe()`
 * (lib/push-release.ts): row first, so there is never a moment where the
 * endpoint is live and the row names the previous account.
 */
export async function POST(req: NextRequest) {
  const json = await readJson(req);
  if (!json.ok) return badRequest('invalid JSON');
  const parsed = ReleaseBodySchema.safeParse(json.body);
  if (!parsed.success) return badRequest('invalid release');

  if ('token' in parsed.data) {
    if (!isWebPushEndpoint(parsed.data.token)) return badRequest('token must be an https URL');
    return answer(await releaseWebPushToken(createServiceClient(), parsed.data.token), 'devices/release');
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return answer(
    await releaseOwnDevice(createServiceClient(), user.id, parsed.data.deviceId),
    'devices/release'
  );
}
