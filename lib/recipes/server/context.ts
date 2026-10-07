import type { SupabaseClient } from '@supabase/supabase-js';
import {
  fetchItemTypes,
  fetchProjects,
  fetchRoutines,
  fetchSeasons,
  fetchUserExtensionConfigs,
  fetchUserExtensions,
} from '@/lib/db';
import { EXT_BEEMINDER } from '@/lib/extension-registry';
import type { Project, Routine, Season } from '@/lib/planner-types';
import { stakeLockFrom, type StakeFacts } from '../stake-rule';
import type { FilterEnv } from '../filters';

/**
 * What a server run needs to know about one user, read once per user per tick
 * (lazily: only when one of their recipes is actually due), with the SERVICE
 * client and every read scoped by `user_id` (the lib/db.ts fetchers filter on
 * it themselves).
 *
 * The item-type registry is NOT hydrated here: it is a module singleton, and
 * on the server one process serves every user. Nothing needs it: every custom
 * type gets the same built capabilities whether hydrated or not
 * (getItemTypeConfig's fallback), and canCreateType takes the custom names
 * from `customTypeNames`.
 */

export interface UserContext {
  service: SupabaseClient;
  userId: string;
  tz: string;
  now: Date;
  /** The user's own today, yyyy-MM-dd. */
  today: string;
  projects: Project[];
  routines: Routine[];
  seasons: Season[];
  customTypeNames: string[];
  stake: StakeFacts;
}

/**
 * The stake lock from the user's own rows: no table is the lock off (every
 * extension at its default, off); a read that failed is the lock on, since
 * the answer is unknown (the browser's "not loaded yet").
 */
async function stakeFacts(service: SupabaseClient, userId: string): Promise<StakeFacts> {
  try {
    const [enabled, configs] = await Promise.all([
      fetchUserExtensions(userId, service),
      fetchUserExtensionConfigs(userId, service),
    ]);
    return {
      lockOn: stakeLockFrom(enabled),
      configsKnown: true,
      beeminder: configs?.[EXT_BEEMINDER] ?? {},
    };
  } catch (err) {
    console.warn('[recipes/server] extensions read failed:', err instanceof Error ? err.message : err);
    return { lockOn: true, configsKnown: false, beeminder: {} };
  }
}

export async function loadUserContext(
  service: SupabaseClient,
  userId: string,
  tz: string,
  now: Date,
  today: string
): Promise<UserContext> {
  const [projects, routines, seasons, types, stake] = await Promise.all([
    fetchProjects(userId, service),
    fetchRoutines(userId, service),
    fetchSeasons(userId, service),
    fetchItemTypes(userId, service),
    stakeFacts(service, userId),
  ]);
  return {
    service,
    userId,
    tz,
    now,
    today,
    projects,
    routines: routines ?? [],
    seasons: seasons ?? [],
    customTypeNames: (types ?? []).map((t) => t.name),
    stake,
  };
}

/** The filter environment for a fire about `dateStr`. */
export function filterEnvOf(ctx: UserContext, dateStr: string): FilterEnv {
  return { dateStr, todayStr: ctx.today, tz: ctx.tz, routines: ctx.routines, seasons: ctx.seasons };
}
