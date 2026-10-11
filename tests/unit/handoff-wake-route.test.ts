import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * POST /api/agent/handoff-wake: the server half of the hand-off wake
 * (ai-vision-decisions.md, decisions 2 and 4, 2026-10-11).
 *
 * The browser cannot reach the plugin (`notifyPlugins` needs the service key),
 * so this route sends `items.handedOff` for it, once the item read through the
 * session client says it really is handed to the agent and still queued. Pinned
 * here: who may ask, what it reads, what it answers (never a 500), the one
 * event and its three fields, and the per-item cooldown.
 */

const h = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  row: null as Record<string, unknown> | null,
  readError: null as { code: string } | null,
  filters: [] as Array<[string, string, unknown]>,
  afterQueue: [] as Array<() => unknown>,
  notifyPlugins: vi.fn(async () => {}),
}));

vi.mock('@/lib/supabase-server', () => ({
  createClient: vi.fn(async () => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = (col: string, v: unknown) => (h.filters.push(['eq', col, v]), chain);
    chain.is = (col: string, v: unknown) => (h.filters.push(['is', col, v]), chain);
    chain.maybeSingle = async () => ({ data: h.readError ? null : h.row, error: h.readError });
    return {
      auth: { getUser: vi.fn(async () => ({ data: { user: h.user }, error: h.user ? null : { message: 'no' } })) },
      from: (table: string) => (h.filters.push(['from', table, null]), chain),
    };
  }),
}));
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (fn: () => unknown) => {
    h.afterQueue.push(fn);
  },
}));
vi.mock('@/lib/openclaw-registry', () => ({ notifyPlugins: h.notifyPlugins }));

import { POST } from '@/app/api/agent/handoff-wake/route';

const ITEM = '0b8f3c1e-4d2a-4f6b-9c1d-2e3f4a5b6c7d';

const wake = (body: unknown = { itemId: ITEM }, headers: Record<string, string> = {}) =>
  POST(
    new Request('https://do.dsul.app/api/agent/handoff-wake', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  );

const handedOff = (over: Record<string, unknown> = {}) => ({
  id: ITEM,
  title: 'Book the dentist',
  type: 'task',
  status: 'pending',
  assignee: 'openclaw',
  ai_status: 'queued',
  ...over,
});

async function flushAfter() {
  const queued = h.afterQueue.splice(0);
  for (const fn of queued) await fn();
}

// One clock for the whole file: the cooldown is module state, so every test
// starts ten minutes after the last one began, and none inherits a wake.
let clock = Date.parse('2026-10-11T12:00:00.000Z');

beforeEach(() => {
  clock += 600_000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  h.user = { id: 'user-1' };
  h.row = handedOff();
  h.readError = null;
  h.filters = [];
  h.afterQueue = [];
  h.notifyPlugins.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/agent/handoff-wake', () => {
  it('401s without a session, and reads nothing', async () => {
    h.user = null;
    const res = await wake();
    expect(res.status).toBe(401);
    expect(h.filters.some(([op]) => op === 'from')).toBe(false);
    expect(h.notifyPlugins).not.toHaveBeenCalled();
  });

  it('403s a cross-site request', async () => {
    const res = await wake(undefined, { 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(403);
  });

  it('400s a body without a uuid itemId', async () => {
    for (const body of [{}, { itemId: 'nope' }, { itemId: 42 }]) {
      expect((await wake(body)).status).toBe(400);
    }
    expect(h.notifyPlugins).not.toHaveBeenCalled();
  });

  it('404s an item the session client cannot see (missing, another user’s, or trashed)', async () => {
    h.row = null;
    const res = await wake();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    // Read as the user, scoped to them, and never from the trash.
    expect(h.filters).toEqual(
      expect.arrayContaining([
        ['from', 'items', null],
        ['eq', 'id', ITEM],
        ['eq', 'user_id', 'user-1'],
        ['is', 'deleted_at', null],
      ])
    );
    await flushAfter();
    expect(h.notifyPlugins).not.toHaveBeenCalled();
  });

  it('409s an item not assigned to the agent, or no longer queued', async () => {
    for (const over of [
      { assignee: null, ai_status: null },
      { assignee: 'beacon' },
      { ai_status: 'working' },
      { ai_status: 'blocked' },
      { ai_status: 'done' },
      { status: 'completed' },
      { status: 'cancelled' },
    ]) {
      h.row = handedOff(over);
      const res = await wake();
      expect(res.status, JSON.stringify(over)).toBe(409);
    }
    await flushAfter();
    expect(h.notifyPlugins).not.toHaveBeenCalled();
  });

  it('answers 503, never 500, when the read fails', async () => {
    h.readError = { code: '57014' };
    expect((await wake()).status).toBe(503);
  });

  it('sends items.handedOff once, after the response, with only itemId, title and type', async () => {
    const res = await wake();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ woken: true });
    // Nothing is sent before the response.
    expect(h.notifyPlugins).not.toHaveBeenCalled();
    await flushAfter();
    expect(h.notifyPlugins).toHaveBeenCalledTimes(1);
    expect(h.notifyPlugins).toHaveBeenCalledWith('user-1', 'items.handedOff', {
      itemId: ITEM,
      title: 'Book the dentist',
      type: 'task',
    });
  });

  it('wakes an assignment with no status yet, which the queue serves as queued', async () => {
    h.row = handedOff({ ai_status: null });
    expect((await wake()).status).toBe(200);
    await flushAfter();
    expect(h.notifyPlugins).toHaveBeenCalledTimes(1);
  });

  it('wakes an item at most once a minute: hand off, take back, hand off sends one', async () => {
    expect(await (await wake()).json()).toEqual({ woken: true });
    vi.setSystemTime(clock + 30_000);
    const again = await wake();
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ woken: false });
    await flushAfter();
    expect(h.notifyPlugins).toHaveBeenCalledTimes(1);

    // A minute on, it wakes again.
    vi.setSystemTime(clock + 61_000);
    expect(await (await wake()).json()).toEqual({ woken: true });
    await flushAfter();
    expect(h.notifyPlugins).toHaveBeenCalledTimes(2);
  });

  it('keeps the cooldown per item', async () => {
    const OTHER = '1c9f4d2f-5e3b-4a7c-8d2e-3f4a5b6c7d8e';
    await wake();
    h.row = handedOff({ id: OTHER });
    expect(await (await wake({ itemId: OTHER })).json()).toEqual({ woken: true });
    await flushAfter();
    expect(h.notifyPlugins).toHaveBeenCalledTimes(2);
  });
});
