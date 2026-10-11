import { NextResponse } from 'next/server';
import { DeviceRegistrationSchema } from '@dsul/types';
import { authenticateAppRequest } from '@/lib/app-auth';
import { registerDevice } from '@/lib/devices/registry';
import { APNS_TOKEN } from '@/lib/devices/transports/apns';
import { answer, readJson } from '@/lib/devices/routes';
import { createServiceClient } from '@/lib/supabase-service';

/**
 * POST /api/app/devices — register (or touch) the iPhone app for the bearer's
 * user: the native twin of the web's POST /api/devices (reminders Phase 2d).
 *
 * Bearer Supabase access token only (lib/app-auth.ts). The body is
 * DeviceRegistrationSchema (@dsul/types), strict, and one of two shapes:
 * `platform 'ios'` with `delivery 'local'`, and `transport 'none'` or
 * `transport 'apns'` with a hex device token and its environment (Phase 3).
 * The delivery stays local either way: the phone arms its own cues, and APNs
 * brings it only what it cannot work out alone (the last call, a pledge).
 *
 * The write is the service role's register_device() (migration 065), only
 * after the bearer has said who is asking. The phone posts once a launch;
 * registerDevice writes nothing for an unchanged registration seen in the last
 * 12 hours. Answers are bare words, as every /api/app route's are.
 */
export const dynamic = 'force-dynamic';

const invalid = () => NextResponse.json({ error: 'invalid' }, { status: 400 });

export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateAppRequest(req);
  if (auth instanceof Response) return auth;

  const json = await readJson(req);
  if (!json.ok) return invalid();
  const parsed = DeviceRegistrationSchema.safeParse(json.body);
  if (!parsed.success) return invalid();
  const reg = parsed.data;
  if (reg.platform !== 'ios' || reg.delivery !== 'local') return invalid();
  const tokenOk = reg.transport === 'none' || (reg.transport === 'apns' && APNS_TOKEN.test(reg.token ?? ''));
  if (!tokenOk) return invalid();

  return answer(await registerDevice(createServiceClient(), auth.userId, reg), 'app/devices');
}
