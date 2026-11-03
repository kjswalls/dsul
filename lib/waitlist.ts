/**
 * The pre-launch waitlist on dsul.app: what a signup may carry, checked the
 * same way by the route (app/api/waitlist/route.ts) and, as CHECKs, by the
 * table (migration 088). The page that posts here is public/site/index.html;
 * lib/marketing-site.ts says how it is served.
 *
 * Server-side only in practice, though nothing here is secret: the page is a
 * static file and keeps its own copy of the planner keys and the length caps.
 * tests/unit/waitlist.test.ts reads the page and fails if the two drift.
 */

/** The longest address the table takes (RFC 5321's path limit). */
export const EMAIL_MAX = 254;

/** "why? one line. spill." One line, so a short cap. */
export const WHY_MAX = 280;

/**
 * The chips under "which planner did you quit last, and why?". The keys are
 * stored; the labels and the reply lines live only on the page.
 */
export const PLANNERS = ['todoist', 'notion', 'reminders', 'paper', 'brain', 'all'] as const;
export type Planner = (typeof PLANNERS)[number];

/** Which of the page's two forms a signup came from: the hero, or the closer at the bottom. */
export const SOURCES = ['hero', 'closer'] as const;
export type Source = (typeof SOURCES)[number];

/**
 * Deliberately loose. The only real test of an address is the launch email
 * reaching it; this refuses what cannot be one (no @, spaces, no dot after the
 * @) and leaves the rest to the mail server.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trimmed and lowercased, or null when it cannot be an address. The table stores it this way (088's CHECK). */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > EMAIL_MAX) return null;
  return EMAIL_SHAPE.test(email) ? email : null;
}

export function isPlanner(raw: unknown): raw is Planner {
  return typeof raw === 'string' && (PLANNERS as readonly string[]).includes(raw);
}

export function sourceOf(raw: unknown): Source {
  return typeof raw === 'string' && (SOURCES as readonly string[]).includes(raw) ? (raw as Source) : 'hero';
}

/**
 * One line, at most WHY_MAX characters, or null for nothing worth keeping.
 * Line breaks and runs of whitespace fold to one space; the cap counts code
 * points, so an emoji is never cut in half.
 */
export function clipWhy(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const line = raw.replace(/\s+/g, ' ').trim();
  if (!line) return null;
  return Array.from(line).slice(0, WHY_MAX).join('').trim();
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The handle a signup answer is sent with. Any well-formed UUID; whether it names a row is the database's business. */
export function isTicket(raw: unknown): raw is string {
  return typeof raw === 'string' && UUID_SHAPE.test(raw);
}

/**
 * A per-instance speed bump on the anonymous route, keyed by the caller's
 * address, which is never stored. Each serverless instance keeps its own
 * counts, so this slows a script down without promising a hard ceiling (the
 * AI routes' limiter says the same of itself, lib/ai-server/rate-limit.ts).
 */
export const WAITLIST_LIMITS = { join: 10, answer: 30 } as const;
const WINDOW_MS = 60 * 60 * 1000;
const MAX_KEYS = 5_000;
const hits = new Map<string, number[]>();

export function takeWaitlistToken(
  caller: string,
  bucket: keyof typeof WAITLIST_LIMITS,
  now: number = Date.now()
): boolean {
  const key = `${bucket}:${caller}`;
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  const allowed = recent.length < WAITLIST_LIMITS[bucket];
  if (allowed) recent.push(now);
  // Re-inserting keeps the map in least-recently-used order, so the cap drops the stalest caller.
  hits.delete(key);
  hits.set(key, recent);
  while (hits.size > MAX_KEYS) {
    const oldest = hits.keys().next();
    if (oldest.done) break;
    hits.delete(oldest.value);
  }
  return allowed;
}

/** Tests only. */
export function __resetWaitlistLimits(): void {
  hits.clear();
}

/**
 * Who is asking, for the limiter only. Vercel sets x-real-ip and puts the
 * client first in x-forwarded-for; a request with neither (a local dev server)
 * shares one bucket.
 */
export function callerOf(headers: Headers): string {
  const real = headers.get('x-real-ip')?.trim();
  if (real) return real;
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || 'unknown';
}
