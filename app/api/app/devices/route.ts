import { NextResponse } from 'next/server';
import { DeviceRegistrationSchema } from '@dsul/types';
import { authenticateAppRequest } from '@/lib/app-auth';
import { registerDevice } from '@/lib/devices/registry';
import { answer, readJson } from '@/lib/devices/routes';
import { createServiceClient } from '@/lib/supabase-service';

/**
 * POST /api/app/devices — register (or touch) the iPhone app for the bearer's
 * user: the native twin of the web's POST /api/devices (reminders Phase 2d).
 *
 * Bearer Supabase access token only (lib/app-auth.ts). The body is
 * DeviceRegistrationSchema (@dsul/types), strict, and for now exactly one
 * shape: `platform 'ios'`, `transport 'none'`, `delivery 'local'`. The phone
 * arms its own cues, so the server never pushes one to it, and it has no
 * token to push to until APNs (Phase 3), when `apns` joins with its
 * environment and the delivery stays local.
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
  if (reg.platform !== 'ios' || reg.transport !== 'none' || reg.delivery !== 'local') return invalid();

  return answer(await registerDevice(createServiceClient(), auth.userId, reg), 'app/devices');
}
