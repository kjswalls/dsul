import { itemTypeName } from '@/lib/item-registry';
import { sameContainerName } from '@/lib/container-registry';
import { parseDay } from '@/lib/collections';
import { wantsDoingOn } from '@/lib/reminders/due';
import type { ModEvent } from '@/lib/mod-events';
import type { RecipeManifest, RecipeTrigger } from '@/lib/mods/schema';
import type { Item, Routine, Season } from '@/lib/planner-types';

/**
 * Which fires start which recipe, and whether an item passes its filters. Pure.
 */

export type ClockBucket = 'morning' | 'afternoon' | 'evening';

/** Everything that can start a recipe in the browser. */
export type RecipeFire =
  | ModEvent
  | { kind: 'command' }
  | { kind: 'day.opened' }
  | { kind: 'bucket.changed'; bucket: ClockBucket };

export function matchesTrigger(t: RecipeTrigger, e: RecipeFire): boolean {
  if (t.on === 'time') return false; // the server runner's (build order 6)
  if (t.on !== e.kind) return false;
  if (t.on === 'bucket.changed' && e.kind === 'bucket.changed') return !t.bucket || t.bucket === e.bucket;
  return true;
}

export interface FilterEnv {
  /** The day the fire is about: the event's date when it has one, else today. */
  dateStr: string;
  todayStr: string;
  tz: string;
  routines: Routine[];
  seasons: Season[];
}

/**
 * All filters, AND-ed. An item filter with no item fails (validateRecipe keeps
 * them off non-item triggers; this is the run-time half).
 */
export function passesFilters(
  f: RecipeManifest['filters'] | undefined,
  item: Item | undefined,
  env: FilterEnv
): boolean {
  if (!f) return true;
  const needsItem = !!(f.types || f.projects || f.title || f.openToday);
  if (needsItem && !item) return false;

  if (f.weekdays) {
    const day = parseDay(env.dateStr);
    if (!day || !f.weekdays.includes(day.getDay())) return false;
  }
  if (!item) return true;

  // The registry's name for the item ('task', 'habit' or a custom slug).
  if (f.types && !f.types.includes(itemTypeName(item))) return false;
  if (f.projects) {
    const project = item.project;
    // The kind folds case, so `Work` and `work` are one project.
    if (!project || !f.projects.some((p) => sameContainerName('project', project, p))) return false;
  }
  if (f.title && !item.title.toLowerCase().includes(f.title.contains.toLowerCase())) return false;
  if (f.openToday) {
    // Occurs today, still an open loop, and not paused or gated off: the same
    // composition lib/stakes/day.ts settles on (isOpenLoopOn + isItemActiveOn),
    // asked through the one helper that already joins them.
    const ctx = { userTimezone: env.tz, routines: env.routines, seasons: env.seasons };
    if (!wantsDoingOn(item, env.todayStr, ctx)) return false;
  }
  return true;
}
