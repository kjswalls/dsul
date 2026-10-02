import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/app/items/:id — the iPhone's two verbs on an item.
 *
 * `complete` has to do exactly what the web's tick does for the same row, and
 * the three kinds of row do three different things (lib/item-toggle.ts and the
 * store's toggleHabitStatus / toggleTaskStatus):
 *   - a habit: the per-date RPC with the streak, then a status/tally update and
 *     its event; a counted habit's tally is merged one date at a time;
 *   - a recurring task: the per-date RPC and nothing else;
 *   - a one-off: the scalar status, and its event.
 * Every per-date completion is reported to a live stake after the response.
 *
 * `schedule` is the web's drop of a braindump row onto an hour.
 *
 * And nothing here reaches the OpenClaw webhook, which the browser never does.
 */

const USER = '6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';
const ITEM = '0b7e4a52-9c1d-4f3e-8a2b-5d6c7e8f9a0b';
const DATE = '2026-10-02';

type Result = { data?: unknown; error?: unknown; count?: number | null };
interface Query {
  table: string;
  calls: [string, unknown[]][];
}

const h = vi.hoisted(() => ({
  createClient: vi.fn(),
  notifyPlugins: vi.fn(),
  after: vi.fn(),
  reportLiveCompletion: vi.fn(),
  serviceClient: { service: true },
}));

vi.mock('@supabase/supabase-js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
  createClient: h.createClient,
}));
vi.mock('@/lib/openclaw-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/openclaw-registry')>()),
  notifyPlugins: h.notifyPlugins,
}));
// after() throws outside a request scope, and the report is the thing under
// test: the mock collects the callback so a test can run it.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: h.after,
}));
vi.mock('@/lib/stakes/live', () => ({ reportLiveCompletion: h.reportLiveCompletion }));
vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: () => h.serviceClient,
  resolveUserIdFromApiKey: vi.fn(),
}));

let queries: Query[] = [];
let respond: (q: Query) => Result;
let rpc: ReturnType<typeof vi.fn>;

/** A query builder: every method chains, and awaiting it asks `respond`. */
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
const op = (q: Query) => (['insert', 'update', 'select'] as const).find((m) => called(q, m).length > 0);
const writes = (table: string, method: 'insert' | 'update') =>
  queries.filter((q) => q.table === table && op(q) === method).map((q) => called(q, method)[0][0] as Record<string, unknown>);

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = () =>
  [b64({ alg: 'HS256' }), b64({ sub: USER, role: 'authenticated', exp: Date.now() / 1000 + 3600 }), 'sig'].join('.');

import { POST } from '@/app/api/app/items/[id]/route';

const write = (body: unknown, id = ITEM) =>
  POST(
    new Request(`https://do.dsul.app/api/app/items/${id}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

/** Wait out the fire-and-forget event insert. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Run what the route handed to after(), the way Next would once it answered. */
async function runAfter() {
  for (const [callback] of h.after.mock.calls) await (callback as () => Promise<void>)();
}

const HABIT = {
  id: ITEM,
  type: 'habit',
  repeat_frequency: 'daily',
  skipped_dates: ['2026-09-30'],
  daily_counts: { '2026-10-01': 3 },
  current_day_count: 1,
};
const RECURRING_TASK = {
  id: ITEM,
  type: 'task',
  repeat_frequency: 'weekdays',
  skipped_dates: [],
  daily_counts: null,
  current_day_count: null,
};
const ONE_OFF = { ...RECURRING_TASK, repeat_frequency: null };

let row: Record<string, unknown> | null;
let updateResult: Result;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://ref.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
  queries = [];
  row = HABIT;
  updateResult = { data: null, error: null };
  rpc = vi.fn(async () => ({ data: null, error: null }));
  h.reportLiveCompletion.mockResolvedValue({ ok: true, skipped: true });
  respond = (q) => {
    if (q.table === 'item_events') return { data: null, error: null };
    if (q.table !== 'items') return { data: null, error: { code: 'XX000', message: `unexpected ${q.table}` } };
    if (op(q) === 'update') return updateResult;
    return { data: row, error: null };
  };
  h.createClient.mockImplementation(() => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: USER } }, error: null })) },
    from,
    rpc,
  }));
});

describe('reading the row first', () => {
  it('selects the row as the user, live only, and nothing more', async () => {
    await write({ action: 'complete', date: DATE, done: true });
    const read = queries[0];
    expect(read.table).toBe('items');
    expect(called(read, 'select')).toEqual([
      ['id, type, repeat_frequency, skipped_dates, daily_counts, current_day_count'],
    ]);
    expect(read.calls).toEqual(
      expect.arrayContaining([
        ['eq', ['id', ITEM]],
        ['eq', ['user_id', USER]],
        ['is', ['deleted_at', null]],
      ]),
    );
  });

  it('404s another user’s id, invisible under RLS, and writes nothing', async () => {
    // Load-bearing: set_item_completion filters on id and type only, so
    // without this read a foreign id would be a silent no-op answered 200.
    row = null;
    const res = await write({ action: 'complete', date: DATE, done: true });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(rpc).not.toHaveBeenCalled();
    expect(writes('items', 'update')).toEqual([]);
    expect(h.after).not.toHaveBeenCalled();
  });

  it('404s an id that is not a uuid without asking the database', async () => {
    expect((await write({ action: 'complete', date: DATE, done: true }, 'not-a-uuid')).status).toBe(404);
    expect(queries).toEqual([]);
  });

  it('reads an uppercase id as the lowercase row', async () => {
    await write({ action: 'complete', date: DATE, done: true }, ITEM.toUpperCase());
    expect(queries[0].calls).toContainEqual(['eq', ['id', ITEM]]);
  });
});

describe('complete, on a habit', () => {
  it('ticks through the RPC with the streak, then writes the status snapshot', async () => {
    const res = await write({ action: 'complete', date: DATE, done: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(rpc).toHaveBeenCalledExactlyOnceWith('set_item_completion', {
      item_id: ITEM,
      item_type: 'habit',
      date_str: DATE,
      completed: true,
      adjust_streak: true,
    });
    // The store's companion update: no arrays, no streak, and no tally when
    // none was sent, so the stored map is left exactly as it is.
    expect(writes('items', 'update')).toEqual([{ status: 'done', current_day_count: 1 }]);
    await settle();
    expect(writes('item_events', 'insert')).toEqual([
      {
        item_id: ITEM,
        item_type: 'habit',
        action: 'update',
        payload: { status: 'done', currentDayCount: 1 },
      },
    ]);
  });

  it('reports the completion to a live stake once the response is out', async () => {
    await write({ action: 'complete', date: DATE, done: true });
    expect(h.after).toHaveBeenCalledTimes(1);
    expect(h.reportLiveCompletion).not.toHaveBeenCalled();
    await runAfter();
    expect(h.reportLiveCompletion).toHaveBeenCalledExactlyOnceWith(h.serviceClient, {
      userId: USER,
      itemId: ITEM,
      dateStr: DATE,
      completed: true,
    });
  });

  it('reports an untick too, which withdraws the datapoint', async () => {
    await write({ action: 'complete', date: DATE, done: false });
    expect(rpc.mock.calls[0][1]).toMatchObject({ completed: false, adjust_streak: true });
    expect(writes('items', 'update')).toEqual([{ status: 'pending', current_day_count: 1 }]);
    await runAfter();
    expect(h.reportLiveCompletion.mock.calls[0][1]).toMatchObject({ completed: false });
  });

  it('merges a counted habit’s tally one date at a time', async () => {
    // Two of three: not done yet. dailyCounts is written whole by the column,
    // so yesterday's 3 has to survive today's 2.
    await write({ action: 'complete', date: DATE, done: false, count: 2 });
    expect(rpc.mock.calls[0][1]).toMatchObject({ completed: false });
    expect(writes('items', 'update')).toEqual([
      { status: 'pending', daily_counts: { '2026-10-01': 3, [DATE]: 2 }, current_day_count: 2 },
    ]);
    await settle();
    expect(writes('item_events', 'insert')[0].payload).toEqual({
      status: 'pending',
      dailyCounts: { '2026-10-01': 3, [DATE]: 2 },
      currentDayCount: 2,
    });
  });

  it('marks a counted habit done at its target', async () => {
    await write({ action: 'complete', date: DATE, done: true, count: 3 });
    expect(rpc.mock.calls[0][1]).toMatchObject({ completed: true });
    expect(writes('items', 'update')).toEqual([
      { status: 'done', daily_counts: { '2026-10-01': 3, [DATE]: 3 }, current_day_count: 3 },
    ]);
  });

  it('clears the day to 0 on an untick, rather than leaving 3/3 with an empty box', async () => {
    row = { ...HABIT, daily_counts: { [DATE]: 3 }, current_day_count: 3 };
    await write({ action: 'complete', date: DATE, done: false, count: 0 });
    expect(rpc.mock.calls[0][1]).toMatchObject({ completed: false });
    expect(writes('items', 'update')).toEqual([
      { status: 'pending', daily_counts: { [DATE]: 0 }, current_day_count: 0 },
    ]);
  });

  it('starts from an empty tally when the row has none', async () => {
    row = { ...HABIT, daily_counts: null, current_day_count: null };
    await write({ action: 'complete', date: DATE, done: true });
    expect(writes('items', 'update')).toEqual([{ status: 'done', current_day_count: 0 }]);
    await write({ action: 'complete', date: DATE, done: false, count: 1 });
    expect(writes('items', 'update').at(-1)).toEqual({
      status: 'pending',
      daily_counts: { [DATE]: 1 },
      current_day_count: 1,
    });
  });

  it('409s a skipped date and writes nothing', async () => {
    // Ticking a skip would turn a deliberate skip back into an open loop,
    // which the nightly settlement counts as a miss.
    const res = await write({ action: 'complete', date: '2026-09-30', done: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'skipped' });
    expect(rpc).not.toHaveBeenCalled();
    expect(writes('items', 'update')).toEqual([]);
    expect(h.after).not.toHaveBeenCalled();
  });
});

describe('complete, on a recurring task', () => {
  beforeEach(() => {
    row = RECURRING_TASK;
  });

  it('is the per-date RPC and nothing else: no status, no event', async () => {
    const res = await write({ action: 'complete', date: DATE, done: true });
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('set_item_completion', {
      item_id: ITEM,
      item_type: 'task',
      date_str: DATE,
      completed: true,
      adjust_streak: true,
    });
    await settle();
    expect(writes('items', 'update')).toEqual([]);
    expect(writes('item_events', 'insert')).toEqual([]);
    await runAfter();
    expect(h.reportLiveCompletion).toHaveBeenCalledExactlyOnceWith(h.serviceClient, {
      userId: USER,
      itemId: ITEM,
      dateStr: DATE,
      completed: true,
    });
  });

  it('counts a custom type with a frequency as recurring, by its stored slug', async () => {
    row = { ...RECURRING_TASK, type: 'book' };
    await write({ action: 'complete', date: DATE, done: false });
    expect(rpc.mock.calls[0][1]).toMatchObject({ item_type: 'book', completed: false });
  });

  it('409s a skipped date', async () => {
    row = { ...RECURRING_TASK, skipped_dates: [DATE] };
    expect((await write({ action: 'complete', date: DATE, done: true })).status).toBe(409);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('400s a count, which only a habit has', async () => {
    expect((await write({ action: 'complete', date: DATE, done: true, count: 2 })).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('complete, on a one-off', () => {
  beforeEach(() => {
    row = ONE_OFF;
  });

  it('writes the scalar status and its event, and nothing per-date', async () => {
    const res = await write({ action: 'complete', date: DATE, done: true });
    expect(res.status).toBe(200);
    expect(rpc).not.toHaveBeenCalled();
    expect(writes('items', 'update')).toEqual([{ status: 'completed' }]);
    await settle();
    expect(writes('item_events', 'insert')).toEqual([
      { item_id: ITEM, item_type: 'task', action: 'update', payload: { status: 'completed' } },
    ]);
    // A one-off is not stake-eligible, and the web does not report it.
    expect(h.after).not.toHaveBeenCalled();
  });

  it('unticks back to pending', async () => {
    await write({ action: 'complete', date: DATE, done: false });
    expect(writes('items', 'update')).toEqual([{ status: 'pending' }]);
  });

  it('uses the custom type’s own done status', async () => {
    row = { ...ONE_OFF, type: 'book' };
    await write({ action: 'complete', date: DATE, done: true });
    const update = queries.find((q) => op(q) === 'update')!;
    expect(called(update, 'update')).toEqual([[{ status: 'completed' }]]);
    expect(update.calls).toContainEqual(['eq', ['type', 'book']]);
  });
});

describe('schedule', () => {
  beforeEach(() => {
    row = ONE_OFF;
  });

  it('writes the web’s hour-drop field set, dated to the day it landed on', async () => {
    const res = await write({ action: 'schedule', date: DATE, startTime: '09:15' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(writes('items', 'update')).toEqual([
      {
        is_scheduled: true,
        time_bucket: 'morning',
        start_time: '09:15',
        in_project_block: false,
        previous_start_time: null,
        previous_start_date: null,
        start_date: DATE,
      },
    ]);
    expect(rpc).not.toHaveBeenCalled();
    expect(h.after).not.toHaveBeenCalled();
  });

  it.each([
    ['00:30', 'morning'],
    ['12:00', 'afternoon'],
    ['18:45', 'evening'],
  ])('files %s under %s', async (startTime, bucket) => {
    await write({ action: 'schedule', date: DATE, startTime });
    expect(writes('items', 'update')[0].time_bucket).toBe(bucket);
  });

  it('400s a habit, which has no start date to set', async () => {
    row = HABIT;
    const res = await write({ action: 'schedule', date: DATE, startTime: '09:15' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'not_schedulable' });
    expect(writes('items', 'update')).toEqual([]);
  });
});

describe('validation', () => {
  it.each([
    ['invalid JSON', '{'],
    ['no action', { date: DATE, done: true }],
    ['an unknown action', { action: 'skip', date: DATE }],
    ['a date that is not on the calendar', { action: 'complete', date: '2026-02-31', done: true }],
    ['a date in another shape', { action: 'complete', date: '2026-10-2', done: true }],
    ['no date', { action: 'complete', done: true }],
    ['done as a string', { action: 'complete', date: DATE, done: 'true' }],
    ['a negative count', { action: 'complete', date: DATE, done: false, count: -1 }],
    ['a count over 1000', { action: 'complete', date: DATE, done: false, count: 1001 }],
    ['a fractional count', { action: 'complete', date: DATE, done: false, count: 1.5 }],
    ['24:00', { action: 'schedule', date: DATE, startTime: '24:00' }],
    ['a time without minutes', { action: 'schedule', date: DATE, startTime: '9' }],
    ['a schedule with no date', { action: 'schedule', startTime: '09:15' }],
  ])('400s %s before touching the row', async (_, body) => {
    const res = await write(body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid');
    expect(queries).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('takes a leap day', async () => {
    expect((await write({ action: 'complete', date: '2028-02-29', done: true })).status).toBe(200);
  });
});

describe('failures', () => {
  it('401s a JWT PostgREST rejects mid-write', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST303', message: 'JWT expired' } });
    expect((await write({ action: 'complete', date: DATE, done: true })).status).toBe(401);
    expect(h.after).not.toHaveBeenCalled();
  });

  it('500s anything else without the database’s words', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    updateResult = { data: null, error: { code: '23514', message: 'violates check constraint "items_status_check"' } };
    row = ONE_OFF;
    const res = await write({ action: 'complete', date: DATE, done: true });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'failed' });
    expect(text).not.toContain('items_status_check');
    spy.mockRestore();
  });

  it('still reports a habit completion whose companion update failed', async () => {
    // The RPC landed, so the day IS complete; the report is about that.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    updateResult = { data: null, error: { code: '57014', message: 'timeout' } };
    expect((await write({ action: 'complete', date: DATE, done: true })).status).toBe(500);
    await runAfter();
    expect(h.reportLiveCompletion).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('webhooks', () => {
  it('none of it reaches OpenClaw, as none of the browser’s ticks do', async () => {
    for (const [r, body] of [
      [HABIT, { action: 'complete', date: DATE, done: true, count: 1 }],
      [RECURRING_TASK, { action: 'complete', date: DATE, done: true }],
      [ONE_OFF, { action: 'complete', date: DATE, done: true }],
      [ONE_OFF, { action: 'schedule', date: DATE, startTime: '09:15' }],
    ] as const) {
      row = r;
      expect((await write(body)).status).toBe(200);
    }
    await settle();
    expect(h.notifyPlugins).not.toHaveBeenCalled();
  });
});
