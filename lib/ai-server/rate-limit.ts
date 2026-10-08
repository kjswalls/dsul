/**
 * In-memory, per-instance, per-user buckets for the calls that reach a
 * provider on the user's behalf outside chat, and for the saved-conversation
 * routes.
 *
 * Server-only. A speed bump, not a guarantee: each serverless instance keeps
 * its own map (design R6). What it slows down is using dsul as a key oracle
 * (connect after connect with guessed keys) or as a forwarder to a custom
 * host; a durable limit is a follow-up.
 *
 * A sliding window: each user's timestamps are pruned on access, and the map
 * is capped at MAX_KEYS entries by evicting the least recently used.
 */

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

/** Tests only. */
export function __resetRateLimits(): void {
  hits.clear();
}
