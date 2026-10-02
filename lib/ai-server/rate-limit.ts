/**
 * In-memory, per-instance, per-user buckets for the calls that reach a
 * provider on the user's behalf outside chat.
 *
 * Server-only. A speed bump, not a guarantee: each serverless instance keeps
 * its own map (design R6). What it slows down is using dsul as a key oracle
 * (connect after connect with guessed keys) or as a forwarder to a custom
 * host; a durable limit is a follow-up.
 *
 * A sliding window: each user's timestamps are pruned on access, and the map
 * is capped at MAX_KEYS entries by evicting the least recently used.
 */

/** connect: PUT + OAuth callback, 20/h; check: recheck, models, anthropic describe, 60/h. */
export type Bucket = 'connect' | 'check';

const LIMITS: Record<Bucket, number> = { connect: 20, check: 60 };
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

export function takeToken(userId: string, bucket: Bucket, now: number = Date.now()): boolean {
  const key = `${bucket}:${userId}`;
  const list = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= LIMITS[bucket]) {
    touch(key, list);
    return false;
  }
  list.push(now);
  touch(key, list);
  return true;
}

/** Tests only. */
export function __resetRateLimits(): void {
  hits.clear();
}
