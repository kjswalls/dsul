import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { sendPushToUser } from '@/lib/push-send';
import { checkCronAuth } from '@/lib/cron-auth';

/**
 * GET /api/cron/eod-notify
 *
 * Vercel cron endpoint — runs every 5 minutes.
 * Finds users whose local time is within the 5-minute window of their EOD review
 * time and who haven't been notified today, then sends them a push notification.
 *
 * Auth: Authorization: Bearer <CRON_SECRET> (Vercel sets this automatically).
 * If CRON_SECRET is not set: returns 500 in production, bypasses auth in development.
 */
export async function GET(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied.response;

  const service = createServiceClient();

  // Fetch all users with EOD notifications enabled and a known timezone
  const { data: users, error } = await service
    .from('user_settings')
    .select('user_id, eod_review_time, timezone, last_eod_notified_date')
    .eq('eod_review_enabled', true)
    .not('timezone', 'is', null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!users?.length) {
    return NextResponse.json({ ok: true, notified: 0 });
  }

  const now = new Date();
  let notified = 0;

  for (const user of users) {
    const { user_id: userId, eod_review_time: eodReviewTime, timezone, last_eod_notified_date: lastNotifiedDate } = user;

    if (!eodReviewTime || !timezone) continue;

    // Get the user's current local time and date
    const userNow = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);

    const userToday = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
    }).format(now);

    // Skip if already notified today
    if (lastNotifiedDate === userToday) continue;

    // Fire if local time is within [eodReviewTime, eodReviewTime + 5min)
    const toMinutes = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
    const eodMinutes = toMinutes(eodReviewTime);
    const nowMinutes = toMinutes(userNow);
    const windowEndMinutes = eodMinutes + 5;
    // Handle midnight rollover
    const inWindow = windowEndMinutes >= 1440
      ? nowMinutes >= eodMinutes || nowMinutes < (windowEndMinutes - 1440)
      : nowMinutes >= eodMinutes && nowMinutes < windowEndMinutes;
    if (!inWindow) continue;

    // Send push notification. This used to POST to /api/push/send — i.e. this
    // deployment calling itself over HTTP, reconstructing its own origin from a
    // Host header and authenticating to itself with the service key. The
    // delivery moved to lib/push-send.ts when the reminder scan became a second
    // caller; there is no isolation to lose, since both ends were always the
    // same process.
    try {
      const pushed = await sendPushToUser(service, userId, {
        title: 'End of day 🌙',
        body: "How'd today go?",
        url: '/?eod=1',
        tag: `dsul-eod-${userToday}`,
      });
      // A failed subscription read is answered now rather than thrown, and it
      // still skips the stamp below, so the next tick inside the window tries
      // again exactly as it did when the read threw.
      if (pushed.detail) throw new Error(pushed.detail);
    } catch (err) {
      console.error('[eod-notify] Push failed for', userId, err);
      continue;
    }

    // Record that we've notified this user today
    const { error: updateError } = await service
      .from('user_settings')
      .update({ last_eod_notified_date: userToday })
      .eq('user_id', userId);

    if (!updateError) {
      notified++;
    } else {
      console.error('[eod-notify] Failed to update notified date for', userId, updateError.message);
    }
  }

  return NextResponse.json({ ok: true, notified });
}
