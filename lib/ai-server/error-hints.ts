/**
 * The few things a provider's error BODY can tell that its status cannot, read
 * as our own words.
 *
 * Server-only (imported from lib/ai-server/** alone). Google answers a used-up
 * daily quota and a minute's rate limit with the same 429, and a region it
 * won't serve with a 400 like any bad request; only the body says which.
 * OpenRouter's free models do the same with their daily cap. So for those two
 * providers, an error response's body is read here before the SDK sees it.
 *
 * What makes that safe (errors.ts's rule, amended for exactly this):
 * - Only fixed structural fields are read (`error.status`, a detail's `@type`,
 *   `reason`, `quotaId` and `quotaValue`, a rate-limit reset time), and each is
 *   only COMPARED with fixed values or parsed as a number. No string a provider wrote is
 *   returned, thrown, stored or logged: the result is one of four kinds of our
 *   own, plus a reset time this module computes and bounds itself.
 * - Only an error status's body is read, capped at HINT_MAX_BYTES; anything
 *   larger, or not JSON, or shaped otherwise, reads as no hint, and the response
 *   goes on to the SDK with the same status, headers and body, to be classified
 *   by status as before.
 */

import { ProviderError } from './errors';

export type HintKind = 'auth' | 'daily_limit' | 'region' | 'quota';
export interface ErrorHint {
  kind: HintKind;
  /** daily_limit only: when it lifts, as an ISO time this module computed. */
  resetAt?: string;
}

/** Error bodies are a few hundred bytes; a cap keeps a hostile one from costing memory. */
export const HINT_MAX_BYTES = 16_384;
/** A rate limit that lifts sooner than this is a minute's, not the day's. */
const DAILY_MIN_MS = 15 * 60_000;
/** A reset further out than this is not believed. */
const RESET_MAX_MS = 48 * 60 * 60_000;
/** Google resets the free tier's requests-per-day quota at midnight Pacific. */
const GOOGLE_QUOTA_ZONE = 'America/Los_Angeles';

const HINT_STATUSES = new Set([400, 403, 429]);

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Google's compat layer sometimes wraps the error object in a one-item array. */
function googleError(body: unknown): Record<string, unknown> | null {
  const root = Array.isArray(body) ? (body.length === 1 ? body[0] : null) : body;
  return obj(obj(root)?.error);
}

function details(err: Record<string, unknown>): Record<string, unknown>[] {
  const d = err.details;
  if (!Array.isArray(d)) return [];
  return d.slice(0, 20).map(obj).filter((x): x is Record<string, unknown> => x !== null);
}

function typeEndsWith(detail: Record<string, unknown>, suffix: string): boolean {
  const t = detail['@type'];
  return typeof t === 'string' && t.endsWith(suffix);
}

function googleHint(status: number, body: unknown, now: number): ErrorHint | null {
  const err = googleError(body);
  if (!err) return null;
  const code = err.status;
  const ds = details(err);

  if (status === 400 && code === 'INVALID_ARGUMENT') {
    const invalidKey = ds.some((d) => typeEndsWith(d, 'ErrorInfo') && d.reason === 'API_KEY_INVALID');
    if (invalidKey) return { kind: 'auth' };
  }
  // "User location is not supported for the API use."
  if (status === 400 && code === 'FAILED_PRECONDITION') return { kind: 'region' };

  if (status === 429 && code === 'RESOURCE_EXHAUSTED') {
    const violations = ds
      .filter((d) => typeEndsWith(d, 'QuotaFailure') && Array.isArray(d.violations))
      .flatMap((d) => (d.violations as unknown[]).slice(0, 20))
      .map(obj)
      .filter((v): v is Record<string, unknown> => v !== null);
    // A quota of zero never lifts: this model has no free use on the key at
    // all, whatever the window. That is no credit, not a wait until midnight.
    if (violations.some((v) => v.quotaValue === '0' || v.quotaValue === 0)) return { kind: 'quota' };
    const perDay = violations.some((v) => typeof v.quotaId === 'string' && v.quotaId.includes('PerDay'));
    if (perDay) return { kind: 'daily_limit', resetAt: nextMidnightIn(GOOGLE_QUOTA_ZONE, now) };
  }
  return null;
}

/** A free model's daily cap: a 429 whose reset is hours away, not seconds. */
function openRouterHint(status: number, body: unknown, now: number): ErrorHint | null {
  if (status !== 429) return null;
  const headers = obj(obj(obj(obj(body)?.error)?.metadata)?.headers);
  if (!headers) return null;
  const raw = headers['X-RateLimit-Reset'] ?? headers['x-ratelimit-reset'];
  const at = typeof raw === 'string' && /^\d{10,16}$/.test(raw) ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isSafeInteger(at)) return null;
  const ms = at < 1e12 ? at * 1000 : at;
  const wait = ms - now;
  if (wait < DAILY_MIN_MS || wait > RESET_MAX_MS) return null;
  return { kind: 'daily_limit', resetAt: new Date(ms).toISOString() };
}

/**
 * The hint in an error body, or null. Pure: `body` is already parsed, and
 * nothing it holds comes back out except as one of our kinds.
 */
export function readErrorHint(
  provider: 'gemini' | 'openrouter',
  status: number,
  body: unknown,
  now: number = Date.now()
): ErrorHint | null {
  try {
    if (!HINT_STATUSES.has(status)) return null;
    return provider === 'gemini' ? googleHint(status, body, now) : openRouterHint(status, body, now);
  } catch {
    return null;
  }
}

/** `zone`'s wall clock minus UTC at `at`, in ms (Los Angeles: -7 h or -8 h). */
function zoneOffsetMs(at: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const n = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === t)?.value ?? NaN);
  const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return wall - Math.floor(at / 1000) * 1000;
}

/** The next midnight in `zone` after `now`, as an ISO time. Daylight saving included. */
export function nextMidnightIn(zone: string, now: number): string {
  const offset = zoneOffsetMs(now, zone);
  const wall = new Date(now + offset);
  const target = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + 1);
  // Midnight's own offset may differ from now's (the night the clocks change).
  let at = target - offset;
  at = target - zoneOffsetMs(at, zone);
  return new Date(at).toISOString();
}

/** The same status and headers, around a body read here. */
function sameShape(res: Response, body: BodyInit | null): Response {
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** `head`, then whatever `reader` has left. */
function replay(head: Uint8Array, reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      if (head.byteLength > 0) c.enqueue(head);
    },
    async pull(c) {
      try {
        const { done, value } = await reader.read();
        if (done) c.close();
        else c.enqueue(value);
      } catch (err) {
        c.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * At most `max` bytes of `res`'s body as JSON (null when it is bigger than
 * that, not JSON, or unreadable), with the response to hand on in its place.
 *
 * `res.clone()` cannot do this: the two branches share one source, and the
 * branch nobody reads fills its queue and stalls the branch we do read, so a
 * body past the stream's high-water mark never finishes. The body is read here
 * instead and handed on as a new response with the same status and headers,
 * which is all the SDK sees, since a body is read once.
 */
async function peekJson(res: Response, max: number): Promise<{ json: unknown; pass: Response }> {
  const declared = Number(res.headers.get('content-length'));
  if (!res.body || (Number.isFinite(declared) && declared > max)) return { json: null, pass: res };

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let over = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total > max) {
        over = true;
        break;
      }
    }
  } catch {
    // The body failed mid-read, so there is nothing left to hand on either.
    return { json: null, pass: sameShape(res, null) };
  }

  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  // Past the cap: the rest of the stream is still the next reader's.
  if (over) return { json: null, pass: sameShape(res, replay(bytes, reader)) };
  const pass = sameShape(res, bytes);
  try {
    return { json: JSON.parse(new TextDecoder().decode(bytes)), pass };
  } catch {
    return { json: null, pass };
  }
}

/**
 * `inner`, with an error response's hint thrown as a ProviderError before the
 * SDK reads the response. Both SDKs wrap what their `fetch` throws and keep it
 * as the cause, which `toProviderError` already reads first (errors.ts), so
 * the kind and the reset time survive to the route.
 *
 * `throwAll` is for clients that never retry (verify, list, the check's test
 * question): every hint is thrown. A client that retries (chat, propose) gets
 * only the 429 daily-limit hint, which carries a reset time nothing else can
 * give, and which its SDK would retry anyway. The SDK retries ANY rejected
 * fetch while it has retries left, so a thrown 400 or 403 hint would be sent
 * twice where the status alone is never retried; those are left to status
 * classification there.
 *
 * A response with no hint goes on with its status, headers and body intact.
 */
export function hintingFetch(
  inner: typeof fetch,
  provider: 'gemini' | 'openrouter',
  opts: { throwAll: boolean }
): typeof fetch {
  const hinting = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await inner(input, init);
    if (res.ok || !HINT_STATUSES.has(res.status)) return res;
    if (!opts.throwAll && res.status !== 429) return res;
    let hint: ErrorHint | null = null;
    let pass = res;
    try {
      const peeked = await peekJson(res, HINT_MAX_BYTES);
      pass = peeked.pass;
      hint = readErrorHint(provider, res.status, peeked.json);
    } catch {
      hint = null;
    }
    if (!hint || (!opts.throwAll && hint.kind !== 'daily_limit')) return pass;
    await pass.body?.cancel().catch(() => {});
    throw new ProviderError(hint.kind, res.status, hint.resetAt);
  };
  return hinting as typeof fetch;
}
