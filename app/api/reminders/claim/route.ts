import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { ClaimBodySchema } from '@/lib/reminders/claim-wire';
import { claimForPage, PageClaimError } from '@/lib/reminders/page-claim';

/**
 * POST /api/reminders/claim — an open page takes a cue before the scan does
 * (memory/plans/reminders-platforms.md §5.2, PR-1b).
 *
 * Cookie session only, and the SESSION client throughout: RLS limits every
 * read and every compare-and-swap to the signed-in user's rows, so a foreign
 * itemId changes nothing. The page's word is not taken for what is due; each
 * cue and snooze is re-asked of dueReminders against the database and the
 * server's clock (lib/reminders/page-claim.ts).
 *
 * Body (lib/reminders/claim-wire.ts, strict):
 *   { candidates: [{ kind:'cue', itemId, dateStr, at }
 *                | { kind:'snooze', itemId, dateStr, held }
 *                | { kind:'release', itemId, dateStr, at }] }
 * Answer: { won, lost, later }.
 */
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
  const parsed = ClaimBodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: 'invalid claim' }, { status: 400 });

  try {
    return NextResponse.json(await claimForPage(supabase, user.id, parsed.data.candidates));
  } catch (err) {
    // A read before any claim, or a throw nothing expected. Nothing the page
    // asked for is decided; it asks again at its next tick.
    const detail = err instanceof PageClaimError || err instanceof Error ? err.message : String(err);
    console.error('[reminders/claim] failed:', detail);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
