import { NextRequest, NextResponse } from 'next/server';
import { DeviceRegistrationSchema } from '@dsul/types';
import { registerDevice } from '@/lib/devices/registry';
import { answer, badRequest, readJson } from '@/lib/devices/routes';
import { createClient } from '@/lib/supabase-server';
import { createServiceClient } from '@/lib/supabase-service';

/**
 * POST /api/devices — register (or touch) this device for the signed-in user.
 *
 * Cookie session only. The body is DeviceRegistrationSchema (@dsul/types),
 * strict. The write is the service role's register_device() (migration 064),
 * which retires any row holding the same token under another account: the
 * token decides ownership (#254). That is a cross-tenant write, so it happens
 * only after the session has said who is asking.
 *
 * Web push and tokenless (`none`) devices only. An APNs or FCM token comes
 * from a native app, which signs in with a bearer, not a cookie, and registers
 * through /api/app/devices (reminders Phase 2d).
 *
 * The browser posts on every boot; registerDevice writes nothing for an
 * unchanged registration seen in the last 12 hours.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const json = await readJson(req);
  if (!json.ok) return badRequest('invalid JSON');
  const parsed = DeviceRegistrationSchema.safeParse(json.body);
  if (!parsed.success) return badRequest('invalid device');
  if (parsed.data.transport === 'apns' || parsed.data.transport === 'fcm') {
    return badRequest('a native app registers through /api/app/devices');
  }

  return answer(await registerDevice(createServiceClient(), user.id, parsed.data), 'devices');
}
