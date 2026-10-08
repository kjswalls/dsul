import type { SupabaseClient } from '@supabase/supabase-js';
import { localClock } from '@/lib/reminders/scan';
import type { RecipeManifest } from '@/lib/mods/schema';
import { passesFilters } from '../filters';
import { filterEnvOf, loadUserContext, type UserContext } from './context';
import { runRecipeOnServer } from './run';
import { missingTable, RECIPE_ROW_COLUMNS, recipeShape, runnable, type RecipeRow } from './rows';
import { timeClaimKey, timedRunDay } from './window';

/**
 * The timed-recipe tier of the one cron tick (/api/cron/reminders, after the
 * reminder scan, memory/plans/mods.md "Timed triggers ride the tick").
 * migration 062 widened dsul_tick's cheap question so the tick wakes for a
 * user with only a timed recipe on.
 *
 * Isolated the way the scan isolates users: it never throws, one user's
 * failure is a note and the next user still runs, and one recipe's failure
 * costs only that recipe. The route calls it apart from the scan, so a
 * failing recipe never costs a reminder, and a failing scan never costs a
 * recipe.
 *
 * A run left unclaimed (the deadline, a claim that errored) is tried again at
 * the next tick inside the window; a claim won and then lost to a crash is
 * lost for that day, as a cue is.
 */

export interface RecipeTickSummary {
  /** Users with a timed recipe on and a time zone. */
  users: number;
  /** Runs claimed and done. */
  runs: number;
  notes: string[];
}

export interface RecipeTickOptions {
  now: Date;
  /** No new run starts after this instant (ms since the epoch). */
  deadlineMs?: number;
}

interface Due {
  row: RecipeRow;
  m: RecipeManifest & { trigger: { on: 'time'; at: string } };
  day: string;
}

export async function runRecipeTick(service: SupabaseClient, options: RecipeTickOptions): Promise<RecipeTickSummary> {
  const summary: RecipeTickSummary = { users: 0, runs: 0, notes: [] };
  const { now } = options;
  const deadline = options.deadlineMs ?? Number.POSITIVE_INFINITY;
  try {
    // The three filters 062's partial index is built on.
    const { data, error } = await service
      .from('user_mods')
      .select(RECIPE_ROW_COLUMNS)
      .eq('kind', 'recipe')
      .eq('enabled', true)
      .eq('manifest->trigger->>on', 'time');
    if (error) {
      if (!missingTable(error)) summary.notes.push(`recipes: read failed — ${error.message}`);
      return summary;
    }
    const rows = (data ?? []) as RecipeRow[];
    if (rows.length === 0) return summary;

    const byUser = new Map<string, RecipeRow[]>();
    for (const row of rows) byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row]);

    const { data: settings, error: settingsError } = await service
      .from('user_settings')
      .select('user_id,timezone')
      .in('user_id', [...byUser.keys()])
      .not('timezone', 'is', null);
    if (settingsError) {
      summary.notes.push(`recipes: settings read failed — ${settingsError.message}`);
      return summary;
    }

    for (const { user_id: userId, timezone } of (settings ?? []) as { user_id: string; timezone: string }[]) {
      const recipes = byUser.get(userId);
      if (!recipes) continue;
      summary.users++;
      if (Date.now() > deadline) {
        summary.notes.push(`${userId}: recipes deferred — tick deadline`);
        continue;
      }
      // ONE user's failure must not cost the others their recipes.
      try {
        await runUser(service, userId, timezone, recipes, now, deadline, summary);
      } catch (err) {
        summary.notes.push(`${userId}: recipes failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    summary.notes.push(`recipes: tier failed — ${err instanceof Error ? err.message : String(err)}`);
  }
  return summary;
}

async function runUser(
  service: SupabaseClient,
  userId: string,
  tz: string,
  rows: RecipeRow[],
  now: Date,
  deadline: number,
  summary: RecipeTickSummary
): Promise<void> {
  let today: string;
  try {
    today = localClock(now, tz).dateStr;
  } catch {
    summary.notes.push(`${userId}: unusable timezone ${tz}`);
    return;
  }

  const due: Due[] = [];
  for (const row of rows) {
    const m = recipeShape(row);
    if (!m || m.trigger.on !== 'time') continue;
    const day = timedRunDay(m.trigger.at, now, tz);
    if (!day) continue;
    due.push({ row, m: m as Due['m'], day });
  }
  if (due.length === 0) return;

  let ctx: UserContext | undefined;
  for (const { row, m, day } of due) {
    if (Date.now() > deadline) {
      summary.notes.push(`${userId}: recipe ${row.id} deferred — tick deadline`);
      return;
    }
    try {
      ctx ??= await loadUserContext(service, userId, tz, now, today);
      if (!runnable(m, ctx.customTypeNames)) continue;
      // Weekdays are the recipe's filters, asked of the fire's own day.
      if (!passesFilters(m.filters, undefined, filterEnvOf(ctx, day))) continue;
      const out = await runRecipeOnServer(ctx, row, m, { on: 'time' }, timeClaimKey(day, m.trigger.at), summary.notes, {
        deadlineMs: deadline,
      });
      if (out.ran) summary.runs++;
    } catch (err) {
      summary.notes.push(`${userId}: recipe ${row.id} failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
