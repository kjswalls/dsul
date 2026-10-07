import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createServiceClient } from '@/lib/supabase-service';
import { setItemCompletion, updateItem } from '@/lib/db';
import { reportLiveCompletion } from '@/lib/stakes/live';
import { getItemTypeConfig } from '@/lib/item-registry';
import { ACTION_DONE, ACTION_SNOOZE, SNOOZE_MINUTES } from '@/lib/reminders/channels/push';
import { afterItemWrite } from '@/lib/recipes/server';

/**
 * POST /api/reminders/act
 *
 * The notification's own buttons. Called by the service worker's
 * notificationclick handler (app/sw.ts) so a habit can be marked done from the
 * lock screen WITHOUT opening the app — which is the single biggest friction
 * cut this feature has: the gap between seeing a reminder and acting on it is
 * where most of them are lost.
 *
 * Auth is the ordinary cookie session, deliberately, and not the service key.
 * The service worker is same-origin and sends credentials, so RLS scopes every
 * statement below to the signed-in user — an itemId belonging to someone else
 * finds nothing rather than being trusted because the caller knew the id.
 *
 * Body: { action: 'done' | 'snooze', itemId: string, dateStr: 'yyyy-MM-dd' }
 *
 * A Done that ticked an item not already done starts the user's "I tick an
 * item" recipes on the server once the response is out (lib/recipes/server/),
 * isolated: a recipe never fails the tick. A Done on a day already done raises
 * nothing, as the web raises only on a real transition.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { action?: string; itemId?: string; dateStr?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { action, itemId, dateStr } = body;
  if (!itemId || (action !== ACTION_DONE && action !== ACTION_SNOOZE)) {
    return NextResponse.json({ error: 'action and itemId are required' }, { status: 400 });
  }
  // Required for BOTH actions. The date comes off a notification that may have
  // sat on a lock screen overnight, so it is data, not a formality: completing
  // "today" server-side would credit the wrong day for exactly the user who
  // most needs the credit, and a snooze without its day cannot be expired.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr ?? '')) {
    return NextResponse.json({ error: 'dateStr must be yyyy-MM-dd' }, { status: 400 });
  }

  const { data: row, error } = await supabase
    .from('items')
    .select('id, type, repeat_frequency, status, start_date')
    .eq('id', itemId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const type = row.type as string;

  if (action === ACTION_SNOOZE) {
    const until = new Date(Date.now() + SNOOZE_MINUTES * 60_000).toISOString();
    const { error: snoozeError } = await supabase
      .from('items')
      .update({
        reminder_snooze_until: until,
        // The day the snooze BELONGS to — the day the notification was about,
        // not the day it happens to mature on. A snooze tapped at 23:55 matures
        // tomorrow, and without this the scan would deliver it against tomorrow
        // and its Done button would tick tomorrow's box for yesterday's habit.
        // The scan refuses a snooze whose day is not today, so this also makes
        // a cross-midnight snooze expire rather than misfire — "in 15 minutes"
        // at 23:55 is, in practice, "not tonight".
        reminder_snooze_date: dateStr ?? null,
      })
      .eq('id', itemId);
    if (snoozeError) {
      return NextResponse.json({ error: snoozeError.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, snoozedUntil: until });
  }

  // Resolved through the REGISTRY, not read raw. items.repeat_frequency has no
  // column default and the agent create schemas make it optional, so a habit
  // can legitimately be stored with NULL — and a raw read would send it down
  // the one-shot branch and mark it done via scalar `status`, which is exactly
  // the write CLAUDE.md forbids for a recurring item (completion is per-date,
  // in completedDates, always). itemFromRow applies the same fallback.
  const frequency = (row.repeat_frequency as string | null) ?? getItemTypeConfig(type).defaultFrequency;
  const recurring = Boolean(frequency) && frequency !== 'none';

  // Whether the day was already done, read before the write, so only a real
  // transition starts a recipe. A failed read is "done": no recipe, the tick
  // itself goes ahead.
  let wasDone = true;
  if (recurring) {
    const { data: done, error: doneError } = await supabase
      .from('items')
      .select('id')
      .eq('id', itemId)
      .eq('user_id', user.id)
      .contains('completed_dates', [dateStr])
      .maybeSingle();
    wasDone = !!doneError || !!done;
  } else {
    wasDone = row.status === getItemTypeConfig(type).doneStatus;
  }

  try {
    if (recurring) {
      // Per-date completion, never scalar status — the rule in CLAUDE.md, and
      // the RPC owns the streak transition so this cannot desync it.
      await setItemCompletion(itemId, type, dateStr as string, true, true, supabase);
    } else {
      await updateItem(
        itemId,
        type,
        { status: getItemTypeConfig(type).doneStatus } as never,
        user.id,
        supabase,
      );
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Update failed' },
      { status: 500 },
    );
  }

  // A completed item must not be re-asked by a snooze that was armed before it.
  await supabase
    .from('items')
    .update({ reminder_snooze_until: null, reminder_snooze_date: null })
    .eq('id', itemId);

  // The lock-screen Done is the most valuable completion this feature has — it
  // is the one that happens without the app being opened — so it gets the live
  // stake report too, rather than waiting for the settlement to notice it
  // hours later. Called directly with a service client: the browser's route
  // exists because a browser cannot hold one, and this process already can.
  // Awaited but never fatal — the completion above is already written.
  const stake = await reportLiveCompletion(createServiceClient(), {
    userId: user.id,
    itemId,
    dateStr: dateStr as string,
    completed: true,
  });
  if (!stake.ok) console.error('[reminders/act] stake report failed:', stake.detail);

  if (!wasDone) {
    afterItemWrite({
      kind: 'item.completed',
      userId: user.id,
      itemId,
      type,
      // A one-off has one occurrence: its start date, or the day acted on.
      date: recurring ? (dateStr as string) : ((row.start_date as string | null) ?? (dateStr as string)),
    });
  }

  return NextResponse.json({ ok: true });
}
