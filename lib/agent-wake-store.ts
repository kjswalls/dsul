import type { SupabaseClient } from '@supabase/supabase-js';
import { readWake, wakeKey, wakesSet, type AgentWake } from './agent-wake';

/**
 * Where the wakes live: `user_secrets.agent_wakes` (migration 075), reached
 * only with the service client, as every credential in user_secrets is. Each
 * function takes that client from its route and the user id from the verified
 * session, never from a body.
 *
 * A database without 075 reads as "no wakes" and refuses to save one
 * (`'unavailable'`), so a build that lands ahead of the migration still hands
 * work off; the apps just are not woken.
 */

type Db = SupabaseClient;

async function readBag(db: Db, userId: string): Promise<Record<string, unknown> | 'unavailable'> {
  const { data, error } = await db.from('user_secrets').select('agent_wakes').eq('user_id', userId).maybeSingle();
  if (error) return 'unavailable';
  const bag = (data as { agent_wakes?: unknown } | null)?.agent_wakes;
  return bag && typeof bag === 'object' ? (bag as Record<string, unknown>) : {};
}

/** The folded names that have a wake. Empty when 075 is missing or the read fails. */
export async function listWakes(db: Db, userId: string): Promise<string[]> {
  try {
    const bag = await readBag(db, userId);
    return bag === 'unavailable' ? [] : wakesSet(bag);
  } catch {
    return [];
  }
}

/** One app's wake, or null. */
export async function getWake(db: Db, userId: string, assignee: string): Promise<AgentWake | null> {
  try {
    const bag = await readBag(db, userId);
    return bag === 'unavailable' ? null : readWake(bag[wakeKey(assignee)]);
  } catch {
    return null;
  }
}

/** Save (or with `null`, remove) one app's wake. */
export async function putWake(
  db: Db,
  userId: string,
  assignee: string,
  wake: AgentWake | null
): Promise<'ok' | 'unavailable'> {
  try {
    const bag = await readBag(db, userId);
    if (bag === 'unavailable') return 'unavailable';
    // Only well-formed entries are carried over, so the bag never grows junk.
    const next: Record<string, AgentWake> = {};
    for (const [k, v] of Object.entries(bag)) {
      const w = readWake(v);
      if (w) next[k] = w;
    }
    if (wake) next[wakeKey(assignee)] = wake;
    else delete next[wakeKey(assignee)];
    const { error } = await db
      .from('user_secrets')
      .upsert({ user_id: userId, agent_wakes: next }, { onConflict: 'user_id' });
    return error ? 'unavailable' : 'ok';
  } catch {
    return 'unavailable';
  }
}
