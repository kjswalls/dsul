/**
 * In-memory, per-instance, per-user buckets for the calls that reach a
 * provider on the user's behalf outside chat, and for the saved-conversation
 * routes.
 *
 * Server-only. A speed bump, not a guarantee: each serverless instance keeps
 * its own map (design R6). What it slows down is using dsul as a key oracle
 * (connect after connect with guessed keys) or as a forwarder to a custom
 * host. Those two buckets, connect and check, also take a token from a count
 * every instance shares (migration 064, `takeSharedToken`).
 *
 * A sliding window: each user's timestamps are pruned on access, and the map
 * is capped at MAX_KEYS entries by evicting the least recently used.
 */

import { createServiceClient } from '@/lib/supabase-service';
import { isMissingSchema } from './schema-codes';

/**
 * connect: PUT + OAuth callback, 20/h; check: recheck, models, anthropic describe, 60/h.
 * The saved conversations (/api/ai/conversations/**), which reach no provider and
 * only bound how hard one account can lean on the database through these routes
 * (an owner's direct PostgREST calls to its own rows are outside them; migration
 * 057's ACCESS note):
 * conv_write: a turn save, rename, star, tally or delete, 600/h;
 * conv_read: History pages, an item's lookup, a thread, 1,200/h;
 * conv_search: 300/h.
 * make: "Write with AI" in Settings → Make (/api/ai/make), 30/h. One press is
 * one call on the person's own key; this bounds a runaway client, not them.
 * A mod's call costs 2 (MAKE_CAPS in lib/ai-limits.ts), since it may write
 * twice the tokens.
 */
export type Bucket = 'connect' | 'check' | 'conv_write' | 'conv_read' | 'conv_search' | 'make';

const LIMITS: Record<Bucket, number> = {
  connect: 20,
  check: 60,
  conv_write: 600,
  conv_read: 1_200,
  conv_search: 300,
  make: 30,
};
const WINDOW_MS = 60 * 60 * 1000;
const MAX_KEYS = 5_000;

const hits = new Map<string, number[]>();

/** Re-inserting moves a key to the end, so the first key is always the least recently used. */
function touch(key: string, list: number[]): void {
  hits.delete(key);
  hits.set(key, list);
  while (hits.size > MAX_KEYS) {
    const oldest = hits.keys().next();
    if (oldest.done) break;
    hits.delete(oldest.value);
  }
}

/**
 * Takes `cost` tokens at once, or none: a call with fewer left than it costs
 * is refused and records nothing.
 */
export function takeToken(userId: string, bucket: Bucket, now: number = Date.now(), cost = 1): boolean {
  const key = `${bucket}:${userId}`;
  const list = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length + cost > LIMITS[bucket]) {
    touch(key, list);
    return false;
  }
  for (let i = 0; i < cost; i++) list.push(now);
  touch(key, list);
  return true;
}

/**
 * The buckets that also count in the database: the two that reach a provider
 * with a key the caller typed or stored. The rest bound load, which a
 * per-instance count already does.
 */
export type SharedBucket = Extract<Bucket, 'connect' | 'check'>;

let warned = false;

/**
 * `takeToken`, then the same token from the count every instance shares
 * (064's `take_ai_token`, a fixed hour at the same limit).
 *
 * The memory bucket answers first, so a refused caller costs no query. The
 * shared count fails OPEN: a database that has no 064 yet, or that errors,
 * leaves the memory answer standing, because a limit on guessing must never be
 * the reason a real person can't connect. Logged once per instance, the code
 * only, never a message.
 */
export async function takeSharedToken(userId: string, bucket: SharedBucket): Promise<boolean> {
  if (!takeToken(userId, bucket)) return false;
  try {
    const { data, error } = await createServiceClient().rpc('take_ai_token', {
      p_user: userId,
      p_bucket: bucket,
      p_limit: LIMITS[bucket],
      p_cost: 1,
    });
    if (error) {
      warnOnce(isMissingSchema(error.code) ? 'missing' : (error.code ?? 'error'));
      return true;
    }
    return data !== false;
  } catch {
    warnOnce('threw');
    return true;
  }
}

function warnOnce(code: string): void {
  if (warned) return;
  warned = true;
  console.warn('[ai]', 'rate-limit', 'shared count unavailable', code);
}

/** Tests only. */
export function __resetRateLimits(): void {
  hits.clear();
  warned = false;
}
