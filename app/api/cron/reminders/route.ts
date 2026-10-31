import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { ReminderScanError, runReminderScan, type ScanSummary } from '@/lib/reminders/scan';
import { checkCronAuth } from '@/lib/cron-auth';
import { runRecipeTick, type RecipeTickSummary } from '@/lib/recipes/server';
import { sweepItemFiles, type SweepSummary } from '@/lib/item-files-sweep';
import { sendWakes, type WakeSummary } from '@/lib/devices/wake';

/**
 * GET /api/cron/reminders
 *
 * The reminder tick, and the only cron route there is. Runs every 5 minutes;
 * works out whose per-item cue is due in their own local minute, whose
 * streak-at-risk last call is owed, and whose stakes day is ready to settle.
 * The end of day review's invitation had a route of its own,
 * /api/cron/eod-notify, then a tier in the scan, and was retired with the
 * review (ghost rows phase 2).
 *
 * Everything real lives in lib/reminders/scan.ts — this route is auth, a clock,
 * one log line and a JSON summary, so the scan stays testable without a
 * request.
 *
 * After the scan, the timed-recipe tier (lib/recipes/server/tick.ts,
 * memory/plans/mods.md build order 6), in its own try with its own log line:
 * it runs whether the scan succeeded or not, and it never decides the status,
 * so a failing recipe never costs a reminder its monitor. Then the files tier
 * (lib/item-files-sweep.ts), the same way, and last the iPhone wakes
 * (lib/devices/wake.ts, migration 076).
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
    `unreached=${summary.unreached} retried=${summary.retried} ` +
    `daysSettled=${summary.daysSettled} ` +
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

/**
 * The files tier (lib/item-files-sweep.ts, migration 073): bytes whose row is
 * gone are removed through the Storage API. Last, isolated like the recipes,
 * and quiet in the log unless it did something.
 */
async function filesTier(now: Date): Promise<SweepSummary> {
  try {
    const files = await sweepItemFiles(createServiceClient(), now);
    if (files.removed || files.stale || files.notes.length) {
      console.log(`[cron/files] removed=${files.removed} stale=${files.stale} notes=${files.notes.length}`);
    }
    return files;
  } catch (err) {
    console.error('[cron/files] tier failed:', err);
    return { removed: 0, stale: 0, notes: ['files tier failed'] };
  }
}

/**
 * The wake tier (lib/devices/wake.ts, migration 076): a silent push to each
 * iPhone whose items changed elsewhere, so it re-plans its own cues. Isolated
 * like the others, and quiet in the log unless it did something.
 */
async function wakeTier(now: Date): Promise<WakeSummary> {
  try {
    const wakes = await sendWakes(createServiceClient(), { nowMs: now.getTime() });
    if (wakes.sent || wakes.failed || wakes.pruned || wakes.notes.length) {
      console.log(
        `[cron/wakes] sent=${wakes.sent} waiting=${wakes.waiting} failed=${wakes.failed} ` +
          `pruned=${wakes.pruned} notes=${wakes.notes.length}`,
      );
    }
    return wakes;
  } catch (err) {
    console.error('[cron/wakes] tier failed:', err);
    return { asked: 0, sent: 0, waiting: 0, failed: 0, pruned: 0, notes: ['wake tier failed'] };
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
    const files = await filesTier(now);
    const wakes = await wakeTier(now);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : 'Scan failed',
        notes: err instanceof ReminderScanError ? err.notes : [],
        recipes,
        files,
        wakes,
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
  const files = await filesTier(now);
  const wakes = await wakeTier(now);
  return NextResponse.json({ ok: true, ...summary, recipes, files, wakes });
}
