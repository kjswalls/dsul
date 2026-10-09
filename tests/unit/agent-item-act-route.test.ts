import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/agent/items/:id/act — the phone's one-day verbs, for an agent.
 *
 * The route runs the phone's own handler (lib/app-api.ts runItemWrite), so
 * tests/unit/app-item-write.test.ts pins what each verb writes. This file pins
 * what is different about the agent's door: the agent key, the service-role
 * client, and therefore `user_id` on every row update; the narrower set of
 * verbs; that the stake report still fires; and that no recipe starts, since
 * the agent surface never reaches lib/recipes/.
 */

const USER = '6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';
const ITEM = '0b7e4a52-9c1d-4f3e-8a2b-5d6c7e8f9a0b';
const ROUTINE = '9e4b2c6a-1d3f-4a5b-8c7d-0e2f4a6b8c1d';
const DATE = '2026-10-02';

type Result = { data?: unknown; error?: unknown };
interface Query {
  table: string;
  calls: [string, unknown[]][];
}

const h = vi.hoisted(() => ({
  notifyPlugins: vi.fn(),
  after: vi.fn(),
  reportLiveCompletion: vi.fn(),
  afterItemWrite: vi.fn(),
  resolveUserIdFromApiKey: vi.fn(),
  serviceClient: {} as Record<string, unknown>,
}));

vi.mock('@/lib/openclaw-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/openclaw-registry')>()),
  notifyPlugins: h.notifyPlugins,
}));
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: h.after,
}));
vi.mock('@/lib/stakes/live', () => ({ reportLiveCompletion: h.reportLiveCompletion }));
vi.mock('@/lib/recipes/server', () => ({ afterItemWrite: h.afterItemWrite }));
vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: () => h.serviceClient,
  resolveUserIdFromApiKey: h.resolveUserIdFromApiKey,
}));

let queries: Query[] = [];
let respond: (q: Query) => Result;
let rpc: ReturnType<typeof vi.fn>;

function from(table: string) {
  const q: Query = { table, calls: [] };
  queries.push(q);
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve()
              .then(() => respond(q))
              .then(resolve, reject);
        }
        return (...args: unknown[]) => {
          q.calls.push([String(prop), args]);
          return builder;
        };
      },
    },
  );
  return builder;
}

const called = (q: Query, method: string) => q.calls.filter(([m]) => m === method).map(([, args]) => args);
const op = (q: Query) => (['insert', 'update', 'delete', 'select'] as const).find((m) => called(q, m).length > 0);
const itemUpdates = () => queries.filter((q) => q.table === 'items' && op(q) === 'update');

import { POST } from '@/app/api/agent/items/[id]/act/route';
import { AGENT_ITEM_ACTIONS } from '@/lib/app-api';
import { NextRequest } from 'next/server';

const act = (body: unknown, opts: { id?: string; auth?: string | null } = {}) => {
  const id = opts.id ?? ITEM;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.auth !== null) headers.authorization = opts.auth ?? 'Bearer agent-key';
  return POST(
    new NextRequest(`https://do.dsul.app/api/agent/items/${id}/act`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function runAfter() {
  for (const [callback] of h.after.mock.calls) await (callback as () => Promise<void>)();
}

const HABIT = {
  id: ITEM,
  type: 'habit',
  parent_item_id: null,
  repeat_frequency: 'daily',
  status: 'pending',
  start_date: null,
  time_bucket: 'morning',
  in_project_block: null,
  skipped_dates: [] as string[],
  daily_counts: {},
  current_day_count: 0,
  paused_at: null,
  paused_until: null,
  streak: 4,
};
const ONE_OFF = {
  ...HABIT,
  type: 'task',
  repeat_frequency: null,
  start_date: DATE,
  time_bucket: 'afternoon',
  in_project_block: false,
  daily_counts: null,
  current_day_count: null,
  streak: null,
};

let row: Record<string, unknown> | null;
/** Whether the day reads as already done (the transition read's `contains`). */
let doneBefore: boolean;

beforeEach(() => {
  vi.clearAllMocks();
  queries = [];
  row = HABIT;
  doneBefore = false;
  rpc = vi.fn(async () => ({ data: null, error: null }));
  h.resolveUserIdFromApiKey.mockResolvedValue(USER);
  h.reportLiveCompletion.mockResolvedValue({ ok: true, skipped: true });
  Object.assign(h.serviceClient, { from, rpc });
  respond = (q) => {
    if (q.table === 'item_events') return { data: null, error: null };
    if (q.table === 'routines' || q.table === 'seasons') return { data: { id: ROUTINE }, error: null };
    if (q.table === 'routine_items' || q.table === 'season_items') {
      return op(q) === 'select' ? { data: [{ sort_order: 3 }], error: null } : { data: null, error: null };
    }
    if (q.table !== 'items') return { data: null, error: { code: 'XX000', message: `unexpected ${q.table}` } };
    if (op(q) === 'update') return { data: null, error: null };
    if (called(q, 'contains').length > 0) return { data: doneBefore ? { id: ITEM } : null, error: null };
    return { data: row, error: null };
  };
});

describe('the agent key', () => {
  it('401s without a bearer, and reads nothing', async () => {
    const res = await act({ action: 'complete', date: DATE, done: true }, { auth: null });
    expect(res.status).toBe(401);
    expect(queries).toEqual([]);
  });

  it('401s a key that resolves to no one', async () => {
    h.resolveUserIdFromApiKey.mockResolvedValue(null);
    const res = await act({ action: 'complete', date: DATE, done: true });
    expect(res.status).toBe(401);
    expect(queries).toEqual([]);
  });
});

describe('which verbs an agent may send', () => {
  it('is the one-day and one-row verbs only', () => {
    expect([...AGENT_ITEM_ACTIONS]).toEqual(['complete', 'skip', 'move', 'resetStreak', 'collect']);
  });

  it.each([
    ['title', { action: 'title', title: 'Mine now' }],
    ['delete', { action: 'delete' }],
    ['pause', { action: 'pause', paused: true }],
    ['addSubtask', { action: 'addSubtask', id: '22222222-2222-4222-8222-222222222222', title: 'Eggs' }],
  ])('refuses %s, which the PATCH routes already take, and touches nothing', async (_, body) => {
    const res = await act(body);
    expect(res.status).toBe(400);
    expect(queries).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('400s a malformed body before reading the row', async () => {
    const res = await act({ action: 'complete', date: 'Oct 2', done: true });
    expect(res.status).toBe(400);
    expect(queries).toEqual([]);
  });

  it('404s an id that is not a uuid', async () => {
    const res = await act({ action: 'resetStreak' }, { id: 'nope' });
    expect(res.status).toBe(404);
    expect(queries).toEqual([]);
  });
});

describe('scoped to the key’s user, since the service role skips RLS', () => {
  it('reads the row as that user, live only', async () => {
    await act({ action: 'complete', date: DATE, done: true });
    expect(queries[0].table).toBe('items');
    expect(queries[0].calls).toEqual(
      expect.arrayContaining([
        ['eq', ['id', ITEM]],
        ['eq', ['user_id', USER]],
        ['is', ['deleted_at', null]],
      ]),
    );
  });

  it.each([
    ['complete', { action: 'complete', date: DATE, done: true }],
    ['skip', { action: 'skip', date: DATE, skipped: true }],
    ['resetStreak', { action: 'resetStreak' }],
    ['collect', { action: 'collect', kind: 'routine', containerId: ROUTINE, member: true }],
  ])('404s another user’s id for %s and writes nothing', async (_, body) => {
    row = null;
    const res = await act(body);
    expect(res.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
    expect(queries.filter((q) => op(q) !== 'select')).toEqual([]);
  });

  it('puts user_id on the habit tick’s row update', async () => {
    const res = await act({ action: 'complete', date: DATE, done: true });
    expect(res.status).toBe(200);
    const [update] = itemUpdates();
    expect(update.calls).toEqual(expect.arrayContaining([['eq', ['user_id', USER]]]));
  });

  it('puts user_id on a carry’s row update', async () => {
    row = ONE_OFF;
    const res = await act({ action: 'move', date: '2026-10-05' });
    expect(res.status).toBe(200);
    const [update] = itemUpdates();
    expect(called(update, 'update')[0][0]).toEqual({ start_date: '2026-10-05', time_bucket: 'afternoon' });
    expect(update.calls).toEqual(expect.arrayContaining([['eq', ['user_id', USER]]]));
  });

  it('puts user_id on a streak reset, and writes the counter alone', async () => {
    const res = await act({ action: 'resetStreak' });
    expect(res.status).toBe(200);
    const [update] = itemUpdates();
    expect(called(update, 'update')[0][0]).toEqual({ streak: 0 });
    expect(update.calls).toEqual(expect.arrayContaining([['eq', ['user_id', USER]]]));
  });

  it('adds one membership row as the user, last in the routine', async () => {
    const res = await act({ action: 'collect', kind: 'routine', containerId: ROUTINE, member: true });
    expect(res.status).toBe(200);
    const insert = queries.find((q) => q.table === 'routine_items' && op(q) === 'insert')!;
    expect(called(insert, 'insert')[0][0]).toEqual({ routine_id: ROUTINE, item_id: ITEM, user_id: USER, sort_order: 4 });
    expect(itemUpdates()).toEqual([]);
  });
});

describe('the same side effects as the phone’s tick', () => {
  it('ticks one date through the streak RPC and reports the stake, starting no recipe', async () => {
    const res = await act({ action: 'complete', date: DATE, done: true });
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('set_item_completion', {
      item_id: ITEM,
      item_type: 'habit',
      date_str: DATE,
      completed: true,
      adjust_streak: true,
    });
    await runAfter();
    expect(h.reportLiveCompletion).toHaveBeenCalledWith(h.serviceClient, {
      userId: USER,
      itemId: ITEM,
      dateStr: DATE,
      completed: true,
    });
    expect(h.afterItemWrite).not.toHaveBeenCalled();
  });

  it('refuses a tick on a skipped day, as the phone does', async () => {
    row = { ...HABIT, skipped_dates: [DATE] };
    const res = await act({ action: 'complete', date: DATE, done: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'skipped' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('refuses to skip a one-off', async () => {
    row = ONE_OFF;
    const res = await act({ action: 'skip', date: DATE, skipped: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'not_skippable' });
  });

  it('fires the item’s webhook once the write landed, so a plugin refetches', async () => {
    await act({ action: 'complete', date: DATE, done: true });
    await runAfter();
    expect(h.notifyPlugins).toHaveBeenCalledWith(USER, 'habits.updated', { action: 'update', id: ITEM, updates: {} });
  });

  it('fires tasks.updated for a task', async () => {
    row = ONE_OFF;
    await act({ action: 'move', date: '2026-10-05' });
    await runAfter();
    expect(h.notifyPlugins).toHaveBeenCalledWith(USER, 'tasks.updated', { action: 'update', id: ITEM, updates: {} });
  });

  it('fires nothing on a refusal', async () => {
    row = ONE_OFF;
    await act({ action: 'skip', date: DATE, skipped: true });
    await runAfter();
    expect(h.notifyPlugins).not.toHaveBeenCalled();
  });

  it('records the feed row with the user named, since auth.uid() is NULL on the service role', async () => {
    await act({ action: 'resetStreak' });
    await settle();
    const event = queries.find((q) => q.table === 'item_events' && op(q) === 'insert')!;
    expect(called(event, 'insert')[0][0]).toEqual(expect.objectContaining({ user_id: USER, item_id: ITEM }));
  });
});
