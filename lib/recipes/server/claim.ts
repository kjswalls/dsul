import type { SupabaseClient } from '@supabase/supabase-js';
import { RATE_PER_DAY, RATE_PER_MINUTE } from '../limits';
import type { RunSummary } from '../runs';

/**
 * mod_runs and user_mods for the server runner, through the SERVICE client.
 * The service role bypasses RLS, so every statement here names `user_id`
 * itself (and 061's composite FK holds a run to a mod of the same user).
 * Claim, then act, as the browser's lib/recipes/runs.ts and as stake_events:
 * a claim row `<key>` before any step, its result `<key>:done` after, because
 * 061 grants no UPDATE (and the server keeps to the owner's grants).
 */

type Service = SupabaseClient;

const missingTable = (error: { code?: string } | null | undefined) =>
  error?.code === '42P01' || error?.code === 'PGRST205';

export type ClaimResult = 'won' | 'lost' | 'error';

/**
 * `won` only when THIS call inserted the row (ON CONFLICT DO NOTHING returns
 * no row to the loser). A missing table is `lost`. Anything else is `error`,
 * and a claim that cannot be proved runs nothing.
 */
export async function claimServerRun(service: Service, userId: string, modId: string, key: string): Promise<ClaimResult> {
  try {
    const { data, error } = await service
      .from('mod_runs')
      .upsert(
        { user_id: userId, mod_id: modId, claim_key: key, summary: { kind: 'claim' } },
        { onConflict: 'mod_id,claim_key', ignoreDuplicates: true }
      )
      .select('id');
    if (error) {
      if (missingTable(error)) return 'lost';
      console.warn('[recipes/server] claim failed:', error.message);
      return 'error';
    }
    return Array.isArray(data) && data.length === 1 ? 'won' : 'lost';
  } catch (err) {
    console.warn('[recipes/server] claim failed:', err instanceof Error ? err.message : err);
    return 'error';
  }
}

/** One result row. A lost log line never undoes a run, so it never throws. */
export async function logServerRun(
  service: Service,
  userId: string,
  modId: string,
  key: string,
  summary: RunSummary
): Promise<void> {
  try {
    const { error } = await service
      .from('mod_runs')
      .insert({ user_id: userId, mod_id: modId, claim_key: key, summary });
    if (error && !missingTable(error)) console.warn('[recipes/server] run log failed:', error.message);
  } catch (err) {
    console.warn('[recipes/server] run log failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Which limit one more run would break, counted from the run log across every
 * device and the server (the browser counts per tab; this is the account's).
 * Results only (`summary.kind = 'run'`), never claims. The day is the user's
 * own (`summary.day`), bounded to the last 26 hours so the scan stays small.
 * A failed count is no breach: the claim still holds the run to once.
 */
export async function rateBreach(
  service: Service,
  userId: string,
  modId: string,
  today: string,
  now: Date
): Promise<'minute' | 'day' | null> {
  const count = async (since: number, day?: string): Promise<number> => {
    let q = service
      .from('mod_runs')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('mod_id', modId)
      .eq('summary->>kind', 'run')
      .gte('at', new Date(now.getTime() - since).toISOString());
    if (day) q = q.eq('summary->>day', day);
    const { count: n, error } = await q;
    if (error) {
      if (!missingTable(error)) console.warn('[recipes/server] rate count failed:', error.message);
      return 0;
    }
    return n ?? 0;
  };
  try {
    if ((await count(60_000)) >= RATE_PER_MINUTE) return 'minute';
    if ((await count(26 * 3_600_000, today)) >= RATE_PER_DAY) return 'day';
  } catch (err) {
    console.warn('[recipes/server] rate count failed:', err instanceof Error ? err.message : err);
  }
  return null;
}

/** Switches one recipe off and says why, as the browser's mods-store disable() does. */
export async function switchOffServer(service: Service, userId: string, modId: string, why: string): Promise<void> {
  try {
    const { error } = await service
      .from('user_mods')
      .update({ enabled: false, disabled_reason: why })
      .eq('id', modId)
      .eq('user_id', userId);
    if (error) console.warn('[recipes/server] switch off failed:', error.message);
  } catch (err) {
    console.warn('[recipes/server] switch off failed:', err instanceof Error ? err.message : err);
  }
}
