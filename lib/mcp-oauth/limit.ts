/**
 * A best-effort limit on anonymous OAuth endpoints, per caller address, held in
 * this instance's memory (a serverless instance is short-lived, so it bounds a
 * burst, not a day). Registration is anonymous by the spec's design, and this
 * keeps one caller from filling mcp_oauth_clients in a loop.
 */

const WINDOW_MS = 60 * 60 * 1000;
const hits = new Map<string, number[]>();

export function callerAddress(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';
}

export function takeAnonymous(key: string, limit: number, now = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000) hits.clear();
  return true;
}
