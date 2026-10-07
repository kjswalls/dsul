import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchItemById } from '@/lib/db';
import { localClock } from '@/lib/reminders/scan';
import type { ModEvent } from '@/lib/mod-events';
import { matchesTrigger, passesFilters } from '../filters';
import { stillHolds } from '../validate-core';
import { filterEnvOf, loadUserContext } from './context';
import { runRecipeOnServer } from './run';
import { missingTable, RECIPE_ROW_COLUMNS, recipeShape, runnable, type RecipeRow } from './rows';
import { itemClaimKey } from './window';

/**
 * Item-trigger recipes for a write that never passed through a browser: a
 * tick, untick, skip or capture from the iPhone (/api/app/**) or a
 * notification's Done (/api/reminders/act). Called after the write committed,
 * from `after()`, so the user's answer is already on its way; it never
 * throws, and a recipe's failure never reaches the write that started it.
 *
 * Never twice:
 *  - a tick made in a browser never reaches these routes (the store writes
 *    through lib/db.ts with the session client), and the browser engine runs
 *    its recipes;
 *  - a server-made change reaching a browser by sync raises no event there
 *    (events are raised only from the store's own actions, never from a load
 *    or a merge, lib/mod-events.ts), so the browser does not run it again;
 *  - the phone's `complete` raises only on a real transition, read before the
 *    write (lib/app-api.ts), and the act route likewise;
 *  - two deliveries of the same event lose to the claim, one per
 *    (recipe, item, date, trigger).
 */

export interface ServerItemEvent {
  kind: 'item.completed' | 'item.uncompleted' | 'item.skipped' | 'item.created';
  itemId: string;
  type: string;
  date?: string;
}

export interface ItemEventResult {
  runs: number;
  notes: string[];
}

export async function runItemEventRecipes(
  service: SupabaseClient,
  userId: string,
  e: ServerItemEvent,
  now: Date = new Date()
): Promise<ItemEventResult> {
  const result: ItemEventResult = { runs: 0, notes: [] };
  try {
    const { data, error } = await service
      .from('user_mods')
      .select(RECIPE_ROW_COLUMNS)
      .eq('user_id', userId)
      .eq('kind', 'recipe')
      .eq('enabled', true)
      .order('created_at', { ascending: true });
    if (error) {
      if (!missingTable(error)) result.notes.push(`recipes: read failed — ${error.message}`);
      return result;
    }
    const fire = { ...e, date: e.date ?? '' } as ModEvent;
    const matching = ((data ?? []) as RecipeRow[])
      .filter((row) => row.user_id === userId)
      .map((row) => ({ row, m: recipeShape(row) }))
      .filter((r): r is { row: RecipeRow; m: NonNullable<typeof r.m> } => !!r.m && matchesTrigger(r.m.trigger, fire));
    if (matching.length === 0) return result;

    const { data: settings, error: settingsError } = await service
      .from('user_settings')
      .select('timezone')
      .eq('user_id', userId)
      .maybeSingle();
    if (settingsError) throw settingsError;
    // Only the web makes a recipe, and its time-zone sync fills this.
    const tz = (settings as { timezone?: string | null } | null)?.timezone;
    if (!tz) {
      result.notes.push(`${userId}: no time zone, recipes wait`);
      return result;
    }
    const today = localClock(now, tz).dateStr;
    const ctx = await loadUserContext(service, userId, tz, now, today);

    // The event, asked again of the item as it is now.
    const item = (await fetchItemById(userId, e.itemId, service)) ?? undefined;
    if (!stillHolds(e, item)) return result;

    for (const { row, m } of matching) {
      try {
        if (!runnable(m, ctx.customTypeNames)) continue;
        if (!passesFilters(m.filters, item, filterEnvOf(ctx, e.date ?? today))) continue;
        const out = await runRecipeOnServer(
          ctx,
          row,
          m,
          { on: e.kind, itemId: e.itemId },
          itemClaimKey(e.kind, e.itemId, e.date),
          result.notes
        );
        if (out.ran) result.runs++;
      } catch (err) {
        result.notes.push(`${userId}: recipe ${row.id} failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    result.notes.push(`${userId}: recipes failed — ${err instanceof Error ? err.message : String(err)}`);
  }
  return result;
}
