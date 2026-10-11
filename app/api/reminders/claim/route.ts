import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { ClaimBodySchema } from '@/lib/reminders/claim-wire';
import { claimForPage, PageClaimError } from '@/lib/reminders/page-claim';
import { cueKey, snoozeKey } from '@/lib/reminders/cue-log';
import { forgetPageClaims, logPageClaims, type PageLogEntry } from '@/lib/reminders/cue-log-write';
import { createServiceClient } from '@/lib/supabase-service';
import type { ClaimAnswer } from '@/lib/reminders/claim-wire';

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
 *
 * What the page won goes in the ledger (cue_log, PR-1d) once the answer is
 * known: a won cue or snooze as delivered by the page, a won release as its
 * row taken back out. A service write, since `authenticated` only reads its
 * ledger, and best effort: the answer never waits on it failing.
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
    const answer = await claimForPage(supabase, user.id, parsed.data.candidates);
    await logWon(user.id, answer);
    return NextResponse.json(answer);
  } catch (err) {
    // A read before any claim, or a throw nothing expected. Nothing the page
    // asked for is decided; it asks again at its next tick.
    const detail = err instanceof PageClaimError || err instanceof Error ? err.message : String(err);
    console.error('[reminders/claim] failed:', detail);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}

/** The ledger's side of a page's claim. Never throws; a failure is a log line. */
async function logWon(userId: string, answer: ClaimAnswer): Promise<void> {
  const shown: PageLogEntry[] = [];
  const released: string[] = [];
  for (const c of answer.won) {
    if (c.kind === 'cue') shown.push({ key: cueKey(c.itemId, c.dateStr, c.at), kind: 'cue', itemId: c.itemId, dateStr: c.dateStr });
    else if (c.kind === 'release') released.push(cueKey(c.itemId, c.dateStr, c.at));
    else {
      const key = snoozeKey(c.itemId, c.held);
      if (key) shown.push({ key, kind: 'snooze', itemId: c.itemId, dateStr: c.dateStr });
    }
  }
  if (shown.length === 0 && released.length === 0) return;
  try {
    const service = createServiceClient();
    const errors = [
      await logPageClaims(service, userId, shown, Date.now()),
      await forgetPageClaims(service, userId, released),
    ].filter(Boolean);
    if (errors.length > 0) console.error('[reminders/claim] cue_log write failed:', errors.join('; '));
  } catch (err) {
    console.error('[reminders/claim] cue_log write failed:', err instanceof Error ? err.message : err);
  }
}
