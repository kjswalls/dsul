// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /api/agent/events — the work feed an agent holds open
 * (app/api/agent/events/route.ts). A line means "you have work"; it never
 * says what, and it is said once per queuing, not once per reconnect.
 */

const h = vi.hoisted(() => ({
  caller: null as null | { userId: string; scope: string; who: () => Promise<string> },
  throws: false,
  /** Each read of the queue takes the next answer; the last one repeats. */
  reads: [] as Array<{ data: unknown[] | null; error: unknown }>,
  filters: [] as Array<[string, ...unknown[]]>,
}));

vi.mock('@/lib/agent-caller', () => ({
  NO_QUEUE: '\u0000',
  resolveAgentCaller: vi.fn(async () => {
    if (h.throws) throw new Error('db down');
    return h.caller;
  }),
}));

vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: () => {
    const chain: Record<string, unknown> = {};
    for (const op of ['from', 'select', 'eq', 'is', 'not', 'or']) {
      chain[op] = (...args: unknown[]) => {
        h.filters.push([op, ...args]);
        return chain;
      };
    }
    chain.limit = async () => (h.reads.length > 1 ? h.reads.shift()! : h.reads[0]);
    return chain;
  },
}));

import { GET, HOLD_MS, POLL_MS, RECENT_MS } from '@/app/api/agent/events/route';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const row = (id: string, assignee: string, atMsAgo: number, extra: Record<string, unknown> = {}) => ({
  id,
  assignee,
  ai_status: 'queued',
  ai_status_at: new Date(NOW - atMsAgo).toISOString(),
  status: 'pending',
  ...extra,
});

const req = (auth?: string) =>
  new Request('https://do.dsul.app/api/agent/events', { headers: auth ? { authorization: auth } : {} });

/** Reads everything the feed says until it closes on its own. */
async function drain(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      out += decoder.decode(value);
    }
  })();
  await vi.advanceTimersByTimeAsync(HOLD_MS + POLL_MS * 2);
  await pump;
  return out;
}

const works = (text: string) => text.split('\n').filter((l) => l === 'data: work').length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h.caller = { userId: 'user-1', scope: 'planner', who: async () => 'openclaw' };
  h.throws = false;
  h.reads = [{ data: [], error: null }];
  h.filters = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/agent/events', () => {
  it('refuses a request with no bearer, or one that is no live token', async () => {
    expect((await GET(req())).status).toBe(401);
    h.caller = null;
    expect((await GET(req('Bearer dsul_ak_nope'))).status).toBe(401);
  });

  it('answers 503 when the token cannot be checked, and 403 to a caller with no queue', async () => {
    h.throws = true;
    expect((await GET(req('Bearer dsul_ak_x'))).status).toBe(503);
    h.throws = false;
    h.caller = { userId: 'user-1', scope: 'planner', who: async () => '\u0000' };
    expect((await GET(req('Bearer dsul_ak_x'))).status).toBe(403);
  });

  it('streams, reads only this account, and closes itself inside the function limit', async () => {
    const res = await GET(req('Bearer dsul_ak_x'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await drain(res);
    expect(text.startsWith(': dsul\n\n')).toBe(true);
    expect(text).toContain(': ping');
    expect(works(text)).toBe(0);
    expect(h.filters).toContainEqual(['eq', 'user_id', 'user-1']);
    expect(h.filters).toContainEqual(['is', 'deleted_at', null]);
  });

  it('on connect, announces work queued recently, once', async () => {
    h.reads = [{ data: [row('a', 'openclaw', 60_000)], error: null }];
    expect(works(await drain(await GET(req('Bearer dsul_ak_x'))))).toBe(1);
  });

  it('on connect, stays quiet about work queued long ago: the agent already heard and passed', async () => {
    h.reads = [{ data: [row('a', 'openclaw', RECENT_MS + 60_000)], error: null }];
    expect(works(await drain(await GET(req('Bearer dsul_ak_x'))))).toBe(0);
  });

  it('announces a hand-off and a re-queue (an answer, a Try again) as they land', async () => {
    const old = row('a', 'openclaw', RECENT_MS * 2);
    h.reads = [
      { data: [old], error: null },
      { data: [old], error: null },
      { data: [old, row('b', 'openclaw', 0)], error: null },
      { data: [old, row('b', 'openclaw', 0)], error: null },
      // `a` answered: same id, a new stamp.
      { data: [{ ...old, ai_status_at: new Date(NOW + 20_000).toISOString() }, row('b', 'openclaw', 0)], error: null },
    ];
    expect(works(await drain(await GET(req('Bearer dsul_ak_x'))))).toBe(2);
  });

  it("hears only its own queue: Claude's work is not OpenClaw's, and a finished item is nothing", async () => {
    h.reads = [
      { data: [], error: null },
      { data: [row('c', 'Claude', 0), row('d', 'openclaw', 0, { status: 'completed' })], error: null },
    ];
    expect(works(await drain(await GET(req('Bearer dsul_ak_x'))))).toBe(0);

    h.caller = { userId: 'user-1', scope: 'planner', who: async () => 'Claude' };
    h.reads = [
      { data: [], error: null },
      { data: [row('c', 'claude', 0)], error: null },
    ];
    expect(works(await drain(await GET(req('Bearer dsul_ak_x'))))).toBe(1);
  });

  it('OpenClaw still hears work handed to its old name', async () => {
    h.reads = [
      { data: [], error: null },
      { data: [row('e', 'beacon', 0)], error: null },
    ];
    expect(works(await drain(await GET(req('Bearer dsul_ak_x'))))).toBe(1);
  });

  it('closes early after reads keep failing, so the agent reconnects', async () => {
    h.reads = [{ data: null, error: { code: 'XX000' } }];
    const res = await GET(req('Bearer dsul_ak_x'));
    const reader = res.body!.getReader();
    let done = false;
    const pump = (async () => {
      for (;;) {
        const r = await reader.read();
        if (r.done) return void (done = true);
      }
    })();
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    await pump;
    expect(done).toBe(true);
  });
});
