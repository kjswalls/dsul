import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase-server';
import { createServiceClient } from '@/lib/supabase-service';
import { CUE_LOG_KEY } from '@/lib/reminders/cue-log';

/**
 * POST /api/reminders/ack — a device says it SHOWED a cue (cue_log, migration
 * 067; memory/plans/reminders-platforms.md §5.2, PR-1b).
 *
 * Posted after `showNotification` resolves: by the service worker's `push`
 * handler for a pushed cue (lib/sw/handlers.ts), and by the page tick for one
 * it claimed (hooks/use-local-cue-tick.ts). `acked_at − claimed_at` is the
 * number decision 8(b) waits on.
 *
 * Cookie session, then a SERVICE-client write filtered by the session's
 * user_id: `authenticated` may only read its ledger (a ledger the subject can
 * edit is not a ledger), so the route writes for it once it knows who. Only
 * `acked_at` and `acked_device`, only on that user's row with that key, and
 * only the first ack: a second device showing the same cue does not move it.
 *
 * Body, strict: `{ key, deviceId }` from a page (lib/devices/web-client.ts's
 * id), or `{ key, endpoint }` from the worker, which has no localStorage and
 * so no device id; the endpoint is looked up among the user's own devices.
 * Answers `{ ok: true, logged }`; `logged` is false when no row has that key
 * (the scan's writer, PR-1d, is what makes them) or it was acked already.
 * 503 `unavailable` while 067 is not applied.
 */

const KEY = z.string().max(200).regex(CUE_LOG_KEY);
const DEVICE_ID = z.string().regex(/^[A-Za-z0-9:._-]{8,128}$/);
const ENDPOINT = z.string().min(16).max(2048).regex(/^https:\/\/[^\s\x00-\x1f\x7f]+$/);

const AckBodySchema = z.union([
  z.object({ key: KEY, deviceId: DEVICE_ID }).strict(),
  z.object({ key: KEY, endpoint: ENDPOINT }).strict(),
]);

/** 42P01 from Postgres, PGRST205 from PostgREST's schema cache: no cue_log yet. */
const missingTable = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === '42P01' || code === 'PGRST205';
};

const unavailable = () => NextResponse.json({ error: 'unavailable' }, { status: 503 });

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const parsed = AckBodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: 'invalid ack' }, { status: 400 });
  const body = parsed.data;

  const service = createServiceClient();
  try {
    let device: string | null = 'deviceId' in body ? body.deviceId : null;
    if ('endpoint' in body) {
      const { data, error } = await service
        .from('devices')
        .select('device_id')
        .eq('user_id', user.id)
        .eq('transport', 'webpush')
        .eq('token', body.endpoint)
        .maybeSingle();
      // A registry that is missing or unreadable costs the ack its device, not the ack.
      if (!error) device = (data as { device_id?: string } | null)?.device_id ?? null;
    }

    const { data, error } = await service
      .from('cue_log')
      .update({ acked_at: new Date().toISOString(), acked_device: device })
      .eq('user_id', user.id)
      .eq('key', body.key)
      .is('acked_at', null)
      .select('id');
    if (error) {
      if (missingTable(error)) return unavailable();
      console.error('[reminders/ack] write failed:', error.message);
      return NextResponse.json({ error: 'failed' }, { status: 500 });
    }
    return NextResponse.json({ ok: true, logged: Array.isArray(data) && data.length > 0 });
  } catch (err) {
    console.error('[reminders/ack] failed:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
