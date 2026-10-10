import { NextResponse } from 'next/server';
import { authenticateAppRequest } from '@/lib/app-auth';
import { releaseOwnDevice } from '@/lib/devices/registry';
import { answer } from '@/lib/devices/routes';
import { createServiceClient } from '@/lib/supabase-service';

/**
 * DELETE /api/app/devices/:deviceId — the iPhone app's sign-out: its row goes
 * before the GoTrue logout ends the token that proves whose it is.
 *
 * Bearer only, and the delete is filtered by the bearer's own user id as well
 * as the device id, so it can only ever remove a row the caller owns. A device
 * with no row (never registered, already released, or a build ahead of 065)
 * is `{ ok: true }`: there is nothing left to release.
 */
export const dynamic = 'force-dynamic';

const DEVICE_ID = /^[A-Za-z0-9:._-]{8,128}$/;

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
): Promise<Response> {
  const auth = await authenticateAppRequest(req);
  if (auth instanceof Response) return auth;

  const { deviceId } = await params;
  if (!DEVICE_ID.test(deviceId)) return NextResponse.json({ error: 'invalid' }, { status: 400 });

  return answer(await releaseOwnDevice(createServiceClient(), auth.userId, deviceId), 'app/devices');
}
