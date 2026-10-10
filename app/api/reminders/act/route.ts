import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { parseActRequest, runReminderAction } from '@/lib/reminders/act';

/**
 * POST /api/reminders/act
 *
 * The notification's own buttons. Called by the service worker's
 * notificationclick handler (app/sw.ts, lib/sw/handlers.ts) so a habit can be
 * marked done from the lock screen WITHOUT opening the app — the gap between
 * seeing a reminder and acting on it is where most of them are lost.
 *
 * Auth is the ordinary cookie session, deliberately, and not the service key.
 * The service worker is same-origin and sends credentials, so RLS scopes every
 * statement to the signed-in user — an itemId belonging to someone else finds
 * nothing rather than being trusted because the caller knew the id.
 *
 * Body: { action: 'done' | 'snooze' | 'skip', itemId: string, dateStr: 'yyyy-MM-dd' }
 *
 * The writes are lib/reminders/act.ts's; this is auth and parsing.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = parseActRequest(raw);
  if (typeof parsed === 'string') return NextResponse.json({ error: parsed }, { status: 400 });

  const answer = await runReminderAction(supabase, user.id, parsed);
  return NextResponse.json(answer.body, { status: answer.status });
}
