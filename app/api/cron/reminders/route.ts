import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { ReminderScanError, runReminderScan, type ScanSummary } from '@/lib/reminders/scan';
import { checkCronAuth } from '@/lib/cron-auth';
import { runRecipeTick, type RecipeTickSummary } from '@/lib/recipes/server';

/**
 * GET /api/cron/reminders
 *
 * The reminder tick, and the only cron route there is. Runs every 5 minutes;
 * works out whose end-of-day review is owed, whose per-item cue is due in
 * their own local minute, whose streak-at-risk last call is owed, and whose
 * stakes day is ready to settle. The review had a route of its own,
 * /api/cron/eod-notify, until it was folded into the scan as a tier.
 *
 * Everything real lives in lib/reminders/scan.ts — this route is auth, a clock,
 * one log line and a JSON summary, so the scan stays testable without a
 * request.
 *
 * After the scan, the timed-recipe tier (lib/recipes/server/tick.ts,
 * memory/plans/mods.md build order 6), in its own try with its own log line:
 * it runs whether the scan succeeded or not, and it never decides the status,
 * so a failing recipe never costs a reminder its monitor.
 *
 * Auth: Authorization: Bearer <CRON_SECRET>. The caller is Postgres: pg_cron
 * runs public.dsul_tick, which sends the header through pg_net with the secret
 * it reads from Vault (migrations 035 and 044). See lib/cron-auth.ts.
 */
/**
 * The tick fans out to every user, and each delivery channel is allowed up to
 * eight seconds. Next's default serverless budget is short enough that one
 * unreachable host — a Home Assistant behind a dead tunnel — can end the
 * invocation partway through, and a cue that was CLAIMED but not delivered is
 * lost for the day.
 */
export const maxDuration = 60;

/** The tick in one line, for the function log: what it did, and how many notes it left. */
function tickLine(summary: ScanSummary): string {
  return (
    `[cron/reminders] users=${summary.users} cues=${summary.cues} lastCalls=${summary.lastCalls} ` +
    `eod=${summary.eod} unreached=${summary.unreached} daysSettled=${summary.daysSettled} ` +
    `notes=${summary.notes.length}`
  );
}

/** The recipe tier in one line, beside the tick's. */
function recipeLine(recipes: RecipeTickSummary): string {
  return `[cron/recipes] users=${recipes.users} runs=${recipes.runs} notes=${recipes.notes.length}`;
}

/** No new recipe run starts this long after the tick began, inside maxDuration. */
const RECIPE_DEADLINE_MS = 45_000;

/** The recipe tier, isolated: whatever it does, it answers a summary. */
async function recipeTier(now: Date, startMs: number): Promise<RecipeTickSummary> {
  try {
    return await runRecipeTick(createServiceClient(), { now, deadlineMs: startMs + RECIPE_DEADLINE_MS });
  } catch (err) {
    console.error('[cron/recipes] tier failed:', err);
    return { users: 0, runs: 0, notes: ['recipe tier failed'] };
  }
}

export async function GET(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied.response;

  const startMs = Date.now();
  const now = new Date(startMs);
  let summary: ScanSummary;
  try {
    summary = await runReminderScan(createServiceClient(), { now });
  } catch (err) {
    // A 500 only when the scan never started: one of the two reads every claim
    // depends on failed, so nothing was claimed or sent and the next tick
    // inside the window retries cleanly. pg_net never retries a request and
    // keeps each response for six hours, so a 5xx in net._http_response is
    // pure signal, the cheapest monitor there is; `notes` says what the scan
    // had already found (memory/plans/reminders-platforms.md §7, decision 7).
    // Flip it to 200 the day a scheduler that RETRIES non-2xx is pointed here.
    console.error('[cron/reminders] scan failed:', err);
    // The recipes still run: they do not depend on the scan's reads.
    const recipes = await recipeTier(now, startMs);
    console.log(recipeLine(recipes));
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : 'Scan failed',
        notes: err instanceof ReminderScanError ? err.notes : [],
        recipes,
      },
      { status: 500 },
    );
  }

  // 200 for a partial tick: `notes` carries the per-user failures, and one
  // user's broken token answering 500 would read as the whole tick down,
  // burying the users it did reach under an error it did not have.
  console.log(tickLine(summary));
  const recipes = await recipeTier(now, startMs);
  console.log(recipeLine(recipes));
  return NextResponse.json({ ok: true, ...summary, recipes });
}
