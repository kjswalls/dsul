import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * POST /api/agent/app-wake: waking the connected apps work was just handed to
 * (lib/agent-wake.ts). Pinned here: who may ask, that items are read as the
 * user, that only items still handed to an app and queued count, one run per
 * app per burst (grouped, then a one-minute cooldown), and that an app with no
 * wake is left out quietly.
 */

const h = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  rows: [] as Record<string, unknown>[],
  filters: [] as Array<[string, string, unknown]>,
  wakes: {} as Record<string, { url: string; token: string }>,
  afterQueue: [] as Array<() => unknown>,
  fired: [] as Array<{ url: string; text: string }>,
}));

vi.mock('@/lib/supabase-server', () => ({
  createClient: vi.fn(async () => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.in = (col: string, v: unknown) => (h.filters.push(['in', col, v]), chain);
    chain.eq = (col: string, v: unknown) => (h.filters.push(['eq', col, v]), chain);
    chain.is = async (col: string, v: unknown) => (h.filters.push(['is', col, v]), { data: h.rows, error: null });
    return {
      auth: { getUser: vi.fn(async () => ({ data: { user: h.user }, error: h.user ? null : { message: 'no' } })) },
      from: () => chain,
    };
  }),
}));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => ({}) }));
vi.mock('@/lib/agent-wake-store', () => ({
  getWake: vi.fn(async (_db: unknown, _uid: string, assignee: string) => h.wakes[assignee.toLowerCase()] ?? null),
}));
vi.mock('@/lib/agent-wake', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-wake')>()),
  fireRoutine: vi.fn(async (wake: { url: string }, text: string) => {
    h.fired.push({ url: wake.url, text });
    return true;
  }),
}));
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (fn: () => unknown) => {
    h.afterQueue.push(fn);
  },
}));

import { POST } from '@/app/api/agent/app-wake/route';

const A = '0b8f3c1e-4d2a-4f6b-9c1d-2e3f4a5b6c7d';
const B = '1b8f3c1e-4d2a-4f6b-9c1d-2e3f4a5b6c7d';
const C = '2b8f3c1e-4d2a-4f6b-9c1d-2e3f4a5b6c7d';
const CLAUDE = { url: 'https://api.anthropic.com/v1/claude_code/routines/trig_1/fire', token: 'tok-123456' };

const wake = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request('https://do.dsul.app/api/agent/app-wake', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  );
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  status: 'pending',
  assignee: 'Claude',
  ai_status: 'queued',
  ...over,
});
async function flushAfter() {
  for (const fn of h.afterQueue.splice(0)) await fn();
}

let clock = Date.parse('2026-10-14T12:00:00.000Z');
beforeEach(() => {
  clock += 600_000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  h.user = { id: 'user-1' };
  h.rows = [];
  h.filters = [];
  h.wakes = { claude: CLAUDE };
  h.afterQueue = [];
  h.fired = [];
});
afterEach(() => vi.useRealTimers());

describe('POST /api/agent/app-wake', () => {
  it('401s without a session and 403s a cross-site request', async () => {
    h.user = null;
    expect((await wake({ itemIds: [A] })).status).toBe(401);
    h.user = { id: 'user-1' };
    expect((await wake({ itemIds: [A] }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  });

  it('400s anything but 1 to 50 uuids', async () => {
    for (const body of [{}, { itemIds: [] }, { itemIds: ['nope'] }, { itemIds: Array(51).fill(A) }]) {
      expect((await wake(body)).status).toBe(400);
    }
  });

  it('reads the items as the user, scoped to them and out of the trash', async () => {
    h.rows = [row(A)];
    await wake({ itemIds: [A, A] });
    expect(h.filters).toEqual([
      ['in', 'id', [A]],
      ['eq', 'user_id', 'user-1'],
      ['is', 'deleted_at', null],
    ]);
  });

  it('wakes each app once for a burst, naming every item handed to it', async () => {
    h.rows = [row(A), row(B, { assignee: 'claude' })];
    const res = await wake({ itemIds: [A, B] });
    expect(await res.json()).toEqual({ woken: ['Claude'] });
    expect(h.fired).toEqual([]); // after the response
    await flushAfter();
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0].url).toBe(CLAUDE.url);
    expect(h.fired[0].text).toContain(`${A}, ${B}`);
  });

  it('leaves out OpenClaw, finished, running and taken-back items', async () => {
    h.rows = [
      row(A, { assignee: 'openclaw' }),
      row(B, { status: 'completed' }),
      row(C, { ai_status: 'working' }),
    ];
    expect(await (await wake({ itemIds: [A, B, C] })).json()).toEqual({ woken: [] });
    await flushAfter();
    expect(h.fired).toEqual([]);
  });

  it('leaves out an app with no wake: it finds the work the next time it is opened', async () => {
    h.wakes = {};
    h.rows = [row(A)];
    expect(await (await wake({ itemIds: [A] })).json()).toEqual({ woken: [] });
  });

  it('wakes an app at most once a minute', async () => {
    h.rows = [row(A)];
    expect(await (await wake({ itemIds: [A] })).json()).toEqual({ woken: ['Claude'] });
    vi.setSystemTime(clock + 30_000);
    expect(await (await wake({ itemIds: [A] })).json()).toEqual({ woken: [] });
    vi.setSystemTime(clock + 61_000);
    expect(await (await wake({ itemIds: [A] })).json()).toEqual({ woken: ['Claude'] });
  });
});
