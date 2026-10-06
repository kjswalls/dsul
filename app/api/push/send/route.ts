import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createServiceClient } from '@/lib/supabase-service';
import { isPushConfigured, sendPushToUser, type PushAction } from '@/lib/push-send';

/**
 * POST /api/push/send
 *
 * Sends a push notification to all of a user's subscribed devices.
 *
 * Auth: either
 *   - The requesting user is the same as `userId` (cookie session)
 *   - OR the request includes `x-service-key: <SUPABASE_SECRET_KEY>` header
 *
 * Body: { userId, title, body, url?, tag?, actions?, data? }
 *
 * The delivery itself lives in lib/push-send.ts — this route is the HTTP
 * surface and the auth gate, nothing more. In-process callers (the reminder
 * scan, eod-notify) call the library directly rather than POSTing here.
 */
export async function POST(req: NextRequest) {
  if (!isPushConfigured()) {
    return NextResponse.json({ error: 'VAPID keys not configured' }, { status: 500 });
  }

  const { userId, title, body, url, tag, actions, data } = await req.json();
  if (!userId || !title) {
    return NextResponse.json({ error: 'userId and title are required' }, { status: 400 });
  }

  // Auth: service key header OR same authenticated user
  const serviceKeyHeader = req.headers.get('x-service-key');
  const isServiceCall = serviceKeyHeader && serviceKeyHeader === process.env.SUPABASE_SECRET_KEY;

  if (!isServiceCall) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user || user.id !== userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const result = await sendPushToUser(createServiceClient(), userId, {
      title,
      body: body ?? '',
      url,
      tag,
      actions: actions as PushAction[] | undefined,
      data,
    });
    // sendPushToUser answers a failed subscription read instead of throwing it.
    // Still a 500 here, as it was when it threw: a 200 with `sent: 0` would
    // tell the caller "no devices" about a question nobody answered.
    if (result.detail) {
      return NextResponse.json({ error: result.detail }, { status: 500 });
    }
    return NextResponse.json({ ok: true, sent: result.sent });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Push failed' },
      { status: 500 },
    );
  }
}
