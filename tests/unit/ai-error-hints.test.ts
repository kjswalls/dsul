// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  HINT_MAX_BYTES,
  hintingFetch,
  nextMidnightIn,
  readErrorHint,
  type ErrorHint,
} from '@/lib/ai-server/error-hints';
import { ProviderError } from '@/lib/ai-server/errors';

/**
 * The few things a provider's error BODY says that its status cannot: a daily
 * quota against a minute's rate limit, a region refusal against any other bad
 * request, a dead key against both (lib/ai-server/error-hints.ts).
 *
 * Two rules carry the weight. Nothing a provider WROTE may come back out: the
 * result is one of four kinds of ours plus a time this module computed, and
 * every case below plants a sentinel in the body and looks for it. And an
 * unreadable, hostile or unexpected body is no hint at all, so the response
 * goes on to the SDK and is classified by status as it always was.
 */

const SENTINEL = 'AIza-SENTINEL-9876';
const NOW = Date.parse('2026-06-15T19:00:00.000Z');

/** Google's shape: the parts read are `error.status` and the details' `@type`, `reason`, `quotaId`, `quotaValue`. */
function googleBody(
  status: string,
  details: unknown[] = [],
  message = `Something about ${SENTINEL}`
): Record<string, unknown> {
  return { error: { code: 429, status, message, details } };
}

const quotaFailure = (violations: unknown[]) => ({
  '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
  violations,
});

const perDay = (quotaValue = '50') => [
  quotaFailure([{ quotaMetric: `generativelanguage.googleapis.com/${SENTINEL}`, quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue }]),
];
const perMinute = [
  quotaFailure([{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '15' }]),
];

const openRouterBody = (reset: unknown) => ({
  error: { code: 429, message: `Rate limited: ${SENTINEL}`, metadata: { headers: { 'X-RateLimit-Reset': reset } } },
});

/** Everything a hint could ever carry, as one string. */
const asText = (hint: ErrorHint | null) => JSON.stringify(hint);

describe('readErrorHint: Google', () => {
  it('reads a per-day quota as a daily limit that lifts at the next Pacific midnight', () => {
    const hint = readErrorHint('gemini', 429, googleBody('RESOURCE_EXHAUSTED', perDay()), NOW);
    expect(hint).toEqual({ kind: 'daily_limit', resetAt: '2026-06-16T07:00:00.000Z' });
    expect(asText(hint)).not.toContain('SENTINEL');
  });

  it('reads the same body wrapped in a one-item array (the compat layer’s shape)', () => {
    const body = [googleBody('RESOURCE_EXHAUSTED', perDay())];
    expect(readErrorHint('gemini', 429, body, NOW)).toMatchObject({ kind: 'daily_limit' });
    // Only one item: anything else is a shape nobody promised.
    expect(readErrorHint('gemini', 429, [...body, ...body], NOW)).toBeNull();
    expect(readErrorHint('gemini', 429, [], NOW)).toBeNull();
  });

  it('leaves a per-minute quota to the status, which already reads it as a rate limit', () => {
    expect(readErrorHint('gemini', 429, googleBody('RESOURCE_EXHAUSTED', perMinute), NOW)).toBeNull();
    expect(readErrorHint('gemini', 429, googleBody('RESOURCE_EXHAUSTED'), NOW)).toBeNull();
  });

  it('a quota of zero is no credit, not a wait: it would never lift', () => {
    // A model with no free use on this key answers the same shape, with a
    // quota value of 0. "Back at midnight" would be a lie every day.
    expect(readErrorHint('gemini', 429, googleBody('RESOURCE_EXHAUSTED', perDay('0')), NOW)).toEqual({ kind: 'quota' });
    expect(readErrorHint('gemini', 429, googleBody('RESOURCE_EXHAUSTED', perDay()), NOW)).toMatchObject({
      kind: 'daily_limit',
    });
  });

  it('reads a refused region, and a dead key the status would call a bad request', () => {
    expect(readErrorHint('gemini', 400, googleBody('FAILED_PRECONDITION'), NOW)).toEqual({ kind: 'region' });
    const dead = googleBody('INVALID_ARGUMENT', [
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' },
    ]);
    expect(readErrorHint('gemini', 400, dead, NOW)).toEqual({ kind: 'auth' });
    // Another INVALID_ARGUMENT is an ordinary bad request.
    expect(readErrorHint('gemini', 400, googleBody('INVALID_ARGUMENT'), NOW)).toBeNull();
  });

  it('matches the status to the code: a hint only where both agree', () => {
    expect(readErrorHint('gemini', 429, googleBody('FAILED_PRECONDITION'), NOW)).toBeNull();
    expect(readErrorHint('gemini', 400, googleBody('RESOURCE_EXHAUSTED', perDay()), NOW)).toBeNull();
    // 500 and 404 are never read at all.
    expect(readErrorHint('gemini', 500, googleBody('RESOURCE_EXHAUSTED', perDay()), NOW)).toBeNull();
    expect(readErrorHint('gemini', 404, googleBody('FAILED_PRECONDITION'), NOW)).toBeNull();
  });
});

describe('readErrorHint: OpenRouter', () => {
  const at = (ms: number) => NOW + ms;

  it('reads a reset hours away as the day’s cap', () => {
    const hint = readErrorHint('openrouter', 429, openRouterBody(String(at(6 * 60 * 60_000))), NOW);
    expect(hint).toEqual({ kind: 'daily_limit', resetAt: new Date(at(6 * 60 * 60_000)).toISOString() });
    expect(asText(hint)).not.toContain('SENTINEL');
  });

  it('leaves a reset minutes away alone: that is the minute’s limit', () => {
    expect(readErrorHint('openrouter', 429, openRouterBody(String(at(60_000))), NOW)).toBeNull();
    expect(readErrorHint('openrouter', 429, openRouterBody(String(at(14 * 60_000))), NOW)).toBeNull();
    expect(readErrorHint('openrouter', 429, openRouterBody(String(at(16 * 60_000))), NOW)).toMatchObject({
      kind: 'daily_limit',
    });
  });

  it('does not believe a reset days away, or one in the past', () => {
    expect(readErrorHint('openrouter', 429, openRouterBody(String(at(49 * 60 * 60_000))), NOW)).toBeNull();
    expect(readErrorHint('openrouter', 429, openRouterBody(String(at(-60 * 60_000))), NOW)).toBeNull();
  });

  it('takes seconds or milliseconds, and nothing that is not a number', () => {
    const seconds = Math.floor(at(6 * 60 * 60_000) / 1000);
    expect(readErrorHint('openrouter', 429, openRouterBody(String(seconds)), NOW)).toMatchObject({
      kind: 'daily_limit',
      resetAt: new Date(seconds * 1000).toISOString(),
    });
    expect(readErrorHint('openrouter', 429, openRouterBody(at(6 * 60 * 60_000)), NOW)).toMatchObject({
      kind: 'daily_limit',
    });
    for (const bad of ['soon', '', '12e9', null, {}, [], Number.MAX_SAFE_INTEGER + 2]) {
      expect(readErrorHint('openrouter', 429, openRouterBody(bad), NOW)).toBeNull();
    }
  });

  it('reads none of Google’s shapes, and nothing on another status', () => {
    expect(readErrorHint('openrouter', 429, googleBody('RESOURCE_EXHAUSTED', perDay()), NOW)).toBeNull();
    expect(readErrorHint('openrouter', 400, openRouterBody(String(at(6 * 60 * 60_000))), NOW)).toBeNull();
  });
});

describe('readErrorHint: anything else is no hint', () => {
  it.each([
    ['null', null],
    ['a string', `error: ${SENTINEL}`],
    ['a number', 42],
    ['an empty object', {}],
    ['error as a string', { error: `quota exceeded ${SENTINEL}` }],
    ['details that are not an array', { error: { status: 'RESOURCE_EXHAUSTED', details: 'PerDay' } }],
    ['violations that are not an array', { error: { status: 'RESOURCE_EXHAUSTED', details: [quotaFailure('PerDay' as never)] } }],
    ['a quotaId that is not a string', { error: { status: 'RESOURCE_EXHAUSTED', details: [quotaFailure([{ quotaId: 7 }])] } }],
    ['another @type', { error: { status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'x.Help', violations: [{ quotaId: 'PerDay' }] }] } }],
    ['a prototype-shaped key', JSON.parse('{"error":{"status":"RESOURCE_EXHAUSTED","__proto__":{"details":[]}}}')],
  ])('%s', (_label, body) => {
    const hint = readErrorHint('gemini', 429, body, NOW);
    expect(hint).toBeNull();
    expect(asText(hint)).not.toContain('SENTINEL');
  });

  it('reads a deeply nested body without tripping over it', () => {
    let deep: unknown = { quotaId: 'PerDay' };
    for (let i = 0; i < 200; i++) deep = { details: [deep] };
    expect(readErrorHint('gemini', 429, { error: { status: 'RESOURCE_EXHAUSTED', details: [deep] } }, NOW)).toBeNull();
  });
});

describe('nextMidnightIn: the night the clocks change', () => {
  it.each([
    // Still PST on the 7th: midnight on the 8th comes before the 2 am change.
    ['the day before spring forward', '2026-03-07T20:00:00Z', '2026-03-08T08:00:00.000Z'],
    // Half an hour into the 8th, still PST: the next midnight is PDT's.
    ['the small hours of spring forward', '2026-03-08T08:30:00Z', '2026-03-09T07:00:00.000Z'],
    ['after spring forward', '2026-03-08T20:00:00Z', '2026-03-09T07:00:00.000Z'],
    ['the day before falling back', '2026-10-31T20:00:00Z', '2026-11-01T07:00:00.000Z'],
    ['the small hours of falling back', '2026-11-01T07:30:00Z', '2026-11-02T08:00:00.000Z'],
    ['after falling back', '2026-11-01T20:00:00Z', '2026-11-02T08:00:00.000Z'],
    ['an ordinary summer day', '2026-06-15T19:00:00Z', '2026-06-16T07:00:00.000Z'],
    // A minute before midnight: the next one is the one coming, not tomorrow's.
    ['a minute before midnight', '2026-06-16T06:59:00Z', '2026-06-16T07:00:00.000Z'],
  ])('%s', (_label, now, expected) => {
    expect(nextMidnightIn('America/Los_Angeles', Date.parse(now))).toBe(expected);
  });

  it('is always in the future, and within a day', () => {
    for (let h = 0; h < 48; h++) {
      const now = Date.parse('2026-03-07T00:00:00Z') + h * 3_600_000;
      const at = Date.parse(nextMidnightIn('America/Los_Angeles', now));
      expect(at).toBeGreaterThan(now);
      expect(at - now).toBeLessThanOrEqual(25 * 3_600_000);
    }
  });
});

describe('hintingFetch', () => {
  const res = (body: unknown, status: number, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const inner = (make: () => Response) => (async () => make()) as unknown as typeof fetch;

  async function thrown(f: typeof fetch): Promise<ProviderError | Response> {
    try {
      return await f('https://example.test/v1/chat/completions');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      return err as ProviderError;
    }
  }

  it('throws the hint as a ProviderError, with our reset time and our words', async () => {
    const f = hintingFetch(inner(() => res(googleBody('RESOURCE_EXHAUSTED', perDay()), 429)), 'gemini', { throwAll: true });
    const out = await thrown(f);
    expect(out).toBeInstanceOf(ProviderError);
    const e = out as ProviderError;
    expect(e.kind).toBe('daily_limit');
    expect(e.status).toBe(429);
    expect(e.resetAt).toBeTruthy();
    expect(`${e.message} ${JSON.stringify(e, Object.getOwnPropertyNames(e))}`).not.toContain('SENTINEL');
  });

  it('passes a 2xx, and a failure with no hint, through untouched', async () => {
    const ok = await thrown(hintingFetch(inner(() => res({ ok: true }, 200)), 'gemini', { throwAll: true }));
    expect(ok).toBeInstanceOf(Response);
    expect(await (ok as Response).json()).toEqual({ ok: true });

    const plain = await thrown(hintingFetch(inner(() => res({ error: 'nope' }, 400)), 'gemini', { throwAll: true }));
    expect(plain).toBeInstanceOf(Response);
    // The body is still there for the SDK to read.
    expect(await (plain as Response).text()).toContain('nope');
  });

  it('a CALL client throws only the 429 daily-limit hint', async () => {
    // Throwing from `fetch` makes the SDK retry; a 400 or 403 would then be
    // sent twice where its status alone is never retried.
    const region = () => res(googleBody('FAILED_PRECONDITION'), 400);
    expect(await thrown(hintingFetch(inner(region), 'gemini', { throwAll: false }))).toBeInstanceOf(Response);
    expect(await thrown(hintingFetch(inner(region), 'gemini', { throwAll: true }))).toBeInstanceOf(ProviderError);

    const dead = () => res(googleBody('INVALID_ARGUMENT', [{ '@type': 'google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }]), 400);
    expect(await thrown(hintingFetch(inner(dead), 'gemini', { throwAll: false }))).toBeInstanceOf(Response);

    const capped = () => res(googleBody('RESOURCE_EXHAUSTED', perDay()), 429);
    for (const throwAll of [true, false]) {
      const e = await thrown(hintingFetch(inner(capped), 'gemini', { throwAll }));
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as ProviderError).kind).toBe('daily_limit');
    }
    // A 429 whose hint is NOT the daily one still goes to the SDK there.
    const zero = () => res(googleBody('RESOURCE_EXHAUSTED', perDay('0')), 429);
    expect(await thrown(hintingFetch(inner(zero), 'gemini', { throwAll: false }))).toBeInstanceOf(Response);
    expect((await thrown(hintingFetch(inner(zero), 'gemini', { throwAll: true })) as ProviderError).kind).toBe('quota');
  });

  it('reads at most HINT_MAX_BYTES, by the header or by the stream', async () => {
    // The daily-limit hint sits at the head, so only the cap stops it.
    const body = JSON.stringify({ ...googleBody('RESOURCE_EXHAUSTED', perDay()), pad: 'x'.repeat(100 * 1024) });
    const json = { 'content-type': 'application/json' };

    // Declared too big: not read at all, and handed on as it came.
    const declared = new Response(body, { status: 429, headers: { ...json, 'content-length': String(body.length) } });
    const out = await thrown(hintingFetch(inner(() => declared), 'gemini', { throwAll: true }));
    // Too big to read is no hint: the response goes on as it is.
    expect(out).toBeInstanceOf(Response);
    expect((out as Response).status).toBe(429);
    expect(await (out as Response).text()).toBe(body);

    // No length: 1 KB at a time, counting every pull the reader makes.
    const CHUNK = 1024;
    const bytes = new TextEncoder().encode(body);
    let pulls = 0;
    let off = 0;
    const streamed = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            pulls += 1;
            if (off >= bytes.byteLength) return c.close();
            c.enqueue(bytes.slice(off, off + CHUNK));
            off += CHUNK;
          },
        }),
        { status: 429, headers: json }
      );
    const rest = await thrown(hintingFetch(inner(streamed), 'gemini', { throwAll: true }));
    expect(rest).toBeInstanceOf(Response);
    // The chunks that fill the cap, the one that passes it, and the one the
    // stream pulls ahead: never the whole body.
    expect(pulls).toBeLessThanOrEqual(Math.ceil(HINT_MAX_BYTES / CHUNK) + 2);
    // The SDK still gets every byte, head first, under the same status.
    expect((rest as Response).status).toBe(429);
    expect(await (rest as Response).text()).toBe(body);
  });

  it('a body that is not JSON, or has no body at all, is no hint', async () => {
    const html = () => new Response('<html>502</html>', { status: 429, headers: { 'content-type': 'text/html' } });
    expect(await thrown(hintingFetch(inner(html), 'openrouter', { throwAll: true }))).toBeInstanceOf(Response);
    const empty = () => new Response(null, { status: 429 });
    expect(await thrown(hintingFetch(inner(empty), 'openrouter', { throwAll: true }))).toBeInstanceOf(Response);
  });

  it('a fetch that rejects rejects, unchanged', async () => {
    const boom = new TypeError('fetch failed');
    const f = hintingFetch(
      (async () => {
        throw boom;
      }) as unknown as typeof fetch,
      'gemini',
      { throwAll: true }
    );
    await expect(f('https://example.test/')).rejects.toBe(boom);
  });
});
