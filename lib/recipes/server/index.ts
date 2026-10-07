import { after } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { runItemEventRecipes, type ServerItemEvent } from './item-events';

/**
 * The recipe server runner (memory/plans/mods.md, build order 6), and its one
 * door: the cron route, /api/app/** and /api/reminders/act import only this
 * file (tests/unit/mods-boundary.test.ts). Server only: nothing reachable from
 * here may be a client module (tests/unit/recipes-server-boundary.test.ts).
 */

export { runRecipeTick, type RecipeTickSummary } from './tick';
export { runItemEventRecipes, type ServerItemEvent, type ItemEventResult } from './item-events';

/**
 * Runs the user's matching item-trigger recipes once the response is sent.
 * Isolated: it never throws into the write, and a failure is one log line.
 */
export function afterItemWrite(e: ServerItemEvent & { userId: string }): void {
  const { userId, ...event } = e;
  try {
    after(async () => {
      try {
        const out = await runItemEventRecipes(createServiceClient(), userId, event);
        if (out.notes.length > 0) console.warn('[recipes/server]', out.notes.join('; '));
      } catch (err) {
        console.error('[recipes/server] item recipes failed:', err instanceof Error ? err.message : err);
      }
    });
  } catch (err) {
    console.error('[recipes/server] item recipes not scheduled:', err instanceof Error ? err.message : err);
  }
}
