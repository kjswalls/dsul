import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/app/items/:id — the iPhone's verbs on an item.
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
 * `skip` is the store's setItemSkipped: on a habit, toggleHabitStatus to
 * skipped or pending (the completion cleared either way, the skip RPC only on
 * a change, the status snapshot); on a task-like row, the two per-date RPCs and
 * nothing else. `move` is moveTaskToDate, behind lib/row-moves.ts's gate.
 * `pause` is setItemPaused, resolved by lib/item-pause.ts in the user's zone.
 *
 * And nothing here reaches the OpenClaw webhook, which the browser never does.
 */

const USER = '6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';
const ITEM = '0b7e4a52-9c1d-4f3e-8a2b-5d6c7e8f9a0b';
const PARENT = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';
const DATE = '2026-10-02';
const TOMORROW = '2026-10-03';
/**
 * 8pm on Oct 2 in Los Angeles, the stored zone, and already Oct 3 in UTC: a
 * pause resolved in the wrong zone writes the wrong day.
 */
const NOW = '2026-10-03T03:00:00.000Z';

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
  parent_item_id: null,
  repeat_frequency: 'daily',
  status: 'pending',
  start_date: null,
  time_bucket: 'morning',
  in_project_block: null,
  skipped_dates: ['2026-09-30'],
  daily_counts: { '2026-10-01': 3 },
  current_day_count: 1,
  paused_at: null,
  paused_until: null,
};
const RECURRING_TASK = {
  id: ITEM,
  type: 'task',
  parent_item_id: null,
  repeat_frequency: 'weekdays',
  status: 'pending',
  start_date: '2026-09-01',
  time_bucket: 'afternoon',
  in_project_block: false,
  skipped_dates: [] as string[],
  daily_counts: null,
  current_day_count: null,
  paused_at: null,
  paused_until: null,
};
const ONE_OFF = { ...RECURRING_TASK, repeat_frequency: null, start_date: DATE };
/** Paused since Sep 30 with no end: the ordinary "paused indefinitely" row. */
const PAUSED = { ...ONE_OFF, paused_at: '2026-09-30T14:03:22.123456+00:00' };

let row: Record<string, unknown> | null;
let updateResult: Result;
let settingsResult: Result;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://ref.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
  queries = [];
  row = HABIT;
  updateResult = { data: null, error: null };
  settingsResult = { data: { timezone: 'America/Los_Angeles' }, error: null };
  rpc = vi.fn(async () => ({ data: null, error: null }));
  h.reportLiveCompletion.mockResolvedValue({ ok: true, skipped: true });
  respond = (q) => {
    if (q.table === 'item_events') return { data: null, error: null };
    if (q.table === 'user_settings') return settingsResult;
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
    // Never completed_dates: no intent decides on it, and it grows without bound.
    expect(called(read, 'select')).toEqual([
      [
        'id, type, parent_item_id, repeat_frequency, status, start_date, time_bucket, in_project_block, ' +
          'skipped_dates, daily_counts, current_day_count, paused_at, paused_until',
      ],
    ]);
    expect(read.calls).toEqual(
      expect.arrayContaining([
        ['eq', ['id', ITEM]],
        ['eq', ['user_id', USER]],
        ['is', ['deleted_at', null]],
      ]),
    );
  });

  it.each([
    ['complete', { action: 'complete', date: DATE, done: true }],
    ['schedule', { action: 'schedule', date: DATE, startTime: '09:15' }],
    ['skip', { action: 'skip', date: DATE, skipped: true }],
    ['move', { action: 'move', date: TOMORROW }],
    ['pause', { action: 'pause', paused: true }],
  ])('404s another user’s id for %s, invisible under RLS, and writes nothing', async (_, body) => {
    // Load-bearing: set_item_completion, set_item_skip and updateItem filter
    // on id and type only, so without this read a foreign (or deleted) id
    // would be a silent no-op answered 200.
    row = null;
    const res = await write(body);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(rpc).not.toHaveBeenCalled();
    expect(writes('items', 'update')).toEqual([]);
    expect(h.after).not.toHaveBeenCalled();
    // Nothing past the row: not even the pause's zone.
    expect(queries.map((q) => q.table)).toEqual(['items']);
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

describe('skip, on a habit', () => {
  // HABIT is skipped on Sep 30 and open on DATE.
  const completion = (date: string) => [
    'set_item_completion',
    { item_id: ITEM, item_type: 'habit', date_str: date, completed: false, adjust_streak: true },
  ];
  const skipRpc = (date: string, skipped: boolean) => [
    'set_item_skip',
    { item_id: ITEM, item_type: 'habit', date_str: date, skipped },
  ];

  it('clears the day’s completion, skips it, then writes the status snapshot', async () => {
    const res = await write({ action: 'skip', date: DATE, skipped: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Completion first: a failure between the two leaves the day open,
    // never skipped-and-done.
    expect(rpc.mock.calls).toEqual([completion(DATE), skipRpc(DATE, true)]);
    // toggleHabitStatus's companion update, without the client's dailyCounts
    // the web sends along: the stored map is left exactly as it is.
    expect(writes('items', 'update')).toEqual([{ status: 'skipped', current_day_count: 1 }]);
    await settle();
    expect(writes('item_events', 'insert')).toEqual([
      {
        item_id: ITEM,
        item_type: 'habit',
        action: 'update',
        payload: { status: 'skipped', currentDayCount: 1 },
      },
    ]);
  });

  it('tells a live stake the day is not done, once the completion has landed', async () => {
    // A skip on a day already posted to Beeminder retracts the datapoint, as
    // the browser's own set_item_completion reports it.
    await write({ action: 'skip', date: DATE, skipped: true });
    expect(h.after).toHaveBeenCalledTimes(1);
    const [completed, skipped] = rpc.mock.invocationCallOrder;
    const reported = h.after.mock.invocationCallOrder[0];
    expect(completed).toBeLessThan(reported);
    expect(reported).toBeLessThan(skipped);
    expect(h.reportLiveCompletion).not.toHaveBeenCalled();
    await runAfter();
    expect(h.reportLiveCompletion).toHaveBeenCalledExactlyOnceWith(h.serviceClient, {
      userId: USER,
      itemId: ITEM,
      dateStr: DATE,
      completed: false,
    });
  });

  it('on a day already skipped, still clears the completion and the status, without a second skip', async () => {
    expect((await write({ action: 'skip', date: '2026-09-30', skipped: true })).status).toBe(200);
    expect(rpc.mock.calls).toEqual([completion('2026-09-30')]);
    expect(writes('items', 'update')).toEqual([{ status: 'skipped', current_day_count: 1 }]);
  });

  it('unskips: clears the completion, lifts the skip, and sets the status back to pending', async () => {
    expect((await write({ action: 'skip', date: '2026-09-30', skipped: false })).status).toBe(200);
    expect(rpc.mock.calls).toEqual([completion('2026-09-30'), skipRpc('2026-09-30', false)]);
    expect(writes('items', 'update')).toEqual([{ status: 'pending', current_day_count: 1 }]);
    await runAfter();
    expect(h.reportLiveCompletion.mock.calls[0][1]).toMatchObject({ dateStr: '2026-09-30', completed: false });
  });

  it('unskipping a day never skipped is toggleHabitStatus(pending): it unticks, and lifts nothing', async () => {
    await write({ action: 'skip', date: DATE, skipped: false });
    expect(rpc.mock.calls).toEqual([completion(DATE)]);
    expect(writes('items', 'update')).toEqual([{ status: 'pending', current_day_count: 1 }]);
  });

  it('starts the tally at 0 when the row has none', async () => {
    row = { ...HABIT, current_day_count: null, daily_counts: null };
    await write({ action: 'skip', date: DATE, skipped: true });
    expect(writes('items', 'update')).toEqual([{ status: 'skipped', current_day_count: 0 }]);
  });

  it('reads a NULL frequency as the habit default, daily, so the habit can still skip', async () => {
    row = { ...HABIT, repeat_frequency: null };
    expect((await write({ action: 'skip', date: DATE, skipped: true })).status).toBe(200);
    expect(rpc.mock.calls).toEqual([completion(DATE), skipRpc(DATE, true)]);
  });
});

describe('skip, on a recurring task', () => {
  beforeEach(() => {
    row = RECURRING_TASK;
  });

  it('clears the completion, then skips: no status, no update, no event', async () => {
    const res = await write({ action: 'skip', date: DATE, skipped: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(rpc.mock.calls).toEqual([
      [
        'set_item_completion',
        { item_id: ITEM, item_type: 'task', date_str: DATE, completed: false, adjust_streak: true },
      ],
      ['set_item_skip', { item_id: ITEM, item_type: 'task', date_str: DATE, skipped: true }],
    ]);
    await settle();
    // `pending|completed|cancelled` has no skip in it, and is a contract.
    expect(writes('items', 'update')).toEqual([]);
    expect(writes('item_events', 'insert')).toEqual([]);
    await runAfter();
    expect(h.reportLiveCompletion).toHaveBeenCalledExactlyOnceWith(h.serviceClient, {
      userId: USER,
      itemId: ITEM,
      dateStr: DATE,
      completed: false,
    });
  });

  it('unskips with the skip RPC alone', async () => {
    row = { ...RECURRING_TASK, skipped_dates: [DATE] };
    expect((await write({ action: 'skip', date: DATE, skipped: false })).status).toBe(200);
    expect(rpc.mock.calls).toEqual([
      ['set_item_skip', { item_id: ITEM, item_type: 'task', date_str: DATE, skipped: false }],
    ]);
    expect(writes('items', 'update')).toEqual([]);
    expect(h.after).not.toHaveBeenCalled();
  });

  it.each([
    ['a skip of a day already skipped', [DATE], true],
    ['an unskip of a day never skipped', [], false],
  ])('writes nothing for %s', async (_, skippedDates, skipped) => {
    row = { ...RECURRING_TASK, skipped_dates: skippedDates };
    const res = await write({ action: 'skip', date: DATE, skipped });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(rpc).not.toHaveBeenCalled();
    expect(writes('items', 'update')).toEqual([]);
    expect(h.after).not.toHaveBeenCalled();
  });

  it('skips a custom type by its stored slug', async () => {
    row = { ...RECURRING_TASK, type: 'book' };
    await write({ action: 'skip', date: DATE, skipped: true });
    expect(rpc.mock.calls.map(([, args]) => (args as { item_type: string }).item_type)).toEqual(['book', 'book']);
  });

  it('a completion that fails stops there: no report, no skip', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    rpc.mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'timeout' } });
    expect((await write({ action: 'skip', date: DATE, skipped: true })).status).toBe(500);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['set_item_completion']);
    expect(h.after).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a skip that fails after the completion landed still reports the day as not done', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    rpc
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'timeout' } });
    expect((await write({ action: 'skip', date: DATE, skipped: true })).status).toBe(500);
    await runAfter();
    expect(h.reportLiveCompletion.mock.calls[0][1]).toMatchObject({ completed: false });
    spy.mockRestore();
  });
});

describe('skip, refused', () => {
  it.each([
    ['a one-off task', ONE_OFF],
    ['a one-off custom type', { ...ONE_OFF, type: 'book' }],
    ['a subtask', { ...RECURRING_TASK, parent_item_id: PARENT }],
  ])('400s %s, which has no occurrence of its own to skip, and writes nothing', async (_, r) => {
    row = r;
    const res = await write({ action: 'skip', date: DATE, skipped: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'not_skippable' });
    expect(rpc).not.toHaveBeenCalled();
    expect(writes('items', 'update')).toEqual([]);
    expect(h.after).not.toHaveBeenCalled();
  });
});

describe('move', () => {
  beforeEach(() => {
    row = ONE_OFF;
  });

  it('writes moveTaskToDate’s two fields, keeping the bucket and the time', async () => {
    const res = await write({ action: 'move', date: TOMORROW });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Not isScheduled, not startTime: the carry is not the date chip.
    expect(writes('items', 'update')).toEqual([{ start_date: TOMORROW, time_bucket: 'afternoon' }]);
    expect(rpc).not.toHaveBeenCalled();
    expect(h.after).not.toHaveBeenCalled();
    await settle();
    expect(writes('item_events', 'insert')).toEqual([
      {
        item_id: ITEM,
        item_type: 'task',
        action: 'update',
        payload: { startDate: TOMORROW, timeBucket: 'afternoon' },
      },
    ]);
  });

  it('files an undated, unbucketed row under anytime, so a day view lists it', async () => {
    row = { ...ONE_OFF, start_date: null, time_bucket: null };
    await write({ action: 'move', date: TOMORROW });
    expect(writes('items', 'update')).toEqual([{ start_date: TOMORROW, time_bucket: 'anytime' }]);
  });

  it('reads a task’s NULL frequency as its type’s default, one-shot, so it moves', async () => {
    expect(ONE_OFF.repeat_frequency).toBeNull();
    expect((await write({ action: 'move', date: TOMORROW })).status).toBe(200);
  });

  it('moves a custom type by its stored slug', async () => {
    row = { ...ONE_OFF, type: 'book' };
    expect((await write({ action: 'move', date: TOMORROW })).status).toBe(200);
    const update = queries.find((q) => op(q) === 'update')!;
    expect(update.calls).toContainEqual(['eq', ['type', 'book']]);
  });

  it.each([
    ['a habit', HABIT],
    ['a habit with a NULL frequency', { ...HABIT, repeat_frequency: null }],
    ['a recurring task, whose date is the series anchor', RECURRING_TASK],
    ['a recurring custom type', { ...RECURRING_TASK, type: 'book' }],
    ['a task inside its project block', { ...ONE_OFF, in_project_block: true }],
    ['a completed task', { ...ONE_OFF, status: 'completed' }],
    ['a cancelled task', { ...ONE_OFF, status: 'cancelled' }],
    ['a subtask', { ...ONE_OFF, parent_item_id: PARENT }],
  ])('409s %s and writes nothing', async (_, r) => {
    row = r;
    const res = await write({ action: 'move', date: TOMORROW });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_movable' });
    expect(writes('items', 'update')).toEqual([]);
  });
});

describe('pause', () => {
  beforeEach(() => {
    row = ONE_OFF;
  });

  it('pauses from now, with no end, and records the web’s event', async () => {
    const res = await write({ action: 'pause', paused: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // The pause columns and nothing else: status, dates and bucket stay put,
    // so a resume finds the item where it was.
    expect(writes('items', 'update')).toEqual([{ paused_at: NOW, paused_until: null }]);
    expect(rpc).not.toHaveBeenCalled();
    await settle();
    expect(writes('item_events', 'insert')).toEqual([
      { item_id: ITEM, item_type: 'task', action: 'update', payload: { pausedAt: NOW, pausedUntil: null } },
    ]);
  });

  it('pauses until a day, which is live again on that day', async () => {
    await write({ action: 'pause', paused: true, pausedUntil: '2026-10-09' });
    expect(writes('items', 'update')).toEqual([{ paused_at: NOW, paused_until: '2026-10-09' }]);
  });

  it('takes Oct 3 as a resume day: already today in UTC, but tomorrow where the user is', async () => {
    expect((await write({ action: 'pause', paused: true, pausedUntil: TOMORROW })).status).toBe(200);
    expect(writes('items', 'update')).toEqual([{ paused_at: NOW, paused_until: TOMORROW }]);
  });

  it.each([DATE, '2026-09-30'])('409s a resume day of %s, which is not after today, and writes nothing', async (until) => {
    const res = await write({ action: 'pause', paused: true, pausedUntil: until });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'pause_refused' });
    expect(writes('items', 'update')).toEqual([]);
  });

  it('resumes as of today in the user’s zone, keeping the interval on the row', async () => {
    row = PAUSED;
    await write({ action: 'pause', paused: false });
    expect(writes('items', 'update')).toEqual([{ paused_until: DATE }]);
  });

  it('moves the end of a pause already running, and leaves its start', async () => {
    row = PAUSED;
    await write({ action: 'pause', paused: true, pausedUntil: '2026-10-20' });
    expect(writes('items', 'update')).toEqual([{ paused_until: '2026-10-20' }]);
  });

  it.each([
    ['a resume of a live item', ONE_OFF, { paused: false }],
    // Restamping would drag the interval's start forward and un-hide the days between.
    ['a pause of a paused item', PAUSED, { paused: true }],
  ])('writes nothing for %s', async (_, r, verb) => {
    row = r;
    const res = await write({ action: 'pause', ...verb });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await settle();
    expect(writes('items', 'update')).toEqual([]);
    expect(writes('item_events', 'insert')).toEqual([]);
  });

  it('pauses again, from now, an item whose last pause has ended', async () => {
    row = { ...ONE_OFF, paused_at: '2026-09-01T09:00:00+00:00', paused_until: '2026-09-15' };
    await write({ action: 'pause', paused: true });
    expect(writes('items', 'update')).toEqual([{ paused_at: NOW, paused_until: null }]);
  });

  it.each([
    ['a habit', HABIT, 'habit'],
    ['a custom type', { ...ONE_OFF, type: 'book' }, 'book'],
  ])('pauses %s by its stored slug', async (_, r, slug) => {
    row = r;
    expect((await write({ action: 'pause', paused: true })).status).toBe(200);
    const update = queries.find((q) => op(q) === 'update')!;
    expect(called(update, 'update')).toEqual([[{ paused_at: NOW, paused_until: null }]]);
    expect(update.calls).toContainEqual(['eq', ['type', slug]]);
  });

  it('400s a subtask, which follows its parent, before reading anything else', async () => {
    row = { ...ONE_OFF, parent_item_id: PARENT };
    const res = await write({ action: 'pause', paused: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'not_pausable' });
    expect(queries.map((q) => q.table)).toEqual(['items']);
  });
});

describe('pause: the zone "today" is read in', () => {
  beforeEach(() => {
    row = PAUSED;
  });

  /** The day a resume writes, which is today in the zone the route chose. */
  async function resumeDay(extra: Record<string, unknown> = {}) {
    expect((await write({ action: 'pause', paused: false, ...extra })).status).toBe(200);
    return writes('items', 'update')[0]?.paused_until;
  }

  it('reads the user’s stored zone, by its one column, as the user', async () => {
    expect(await resumeDay()).toBe(DATE);
    const settings = queries.filter((q) => q.table === 'user_settings');
    expect(settings).toHaveLength(1);
    expect(called(settings[0], 'select')).toEqual([['timezone']]);
    expect(settings[0].calls).toContainEqual(['eq', ['user_id', USER]]);
  });

  it('prefers the stored zone to the device’s', async () => {
    expect(await resumeDay({ timeZone: 'Asia/Tokyo' })).toBe(DATE);
  });

  it.each([
    ['no settings row', { data: null, error: null }],
    ['no stored zone', { data: { timezone: null }, error: null }],
    ['a blank stored zone', { data: { timezone: '  ' }, error: null }],
    ['a stored zone Intl does not know', { data: { timezone: 'Mars/Olympus' }, error: null }],
  ])('falls back to the device’s zone with %s', async (_, result) => {
    settingsResult = result;
    expect(await resumeDay({ timeZone: 'America/New_York' })).toBe(DATE);
  });

  it('falls back to UTC with neither', async () => {
    settingsResult = { data: { timezone: null }, error: null };
    expect(await resumeDay()).toBe(TOMORROW);
  });

  it('passes over a device zone Intl does not know', async () => {
    settingsResult = { data: null, error: null };
    expect(await resumeDay({ timeZone: 'Not/AZone' })).toBe(TOMORROW);
  });

  it('answers a failed settings read as an error, and writes nothing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    settingsResult = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
    const res = await write({ action: 'pause', paused: false, timeZone: 'America/New_York' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'failed' });
    settingsResult = { data: null, error: { code: 'PGRST303', message: 'JWT expired' } };
    expect((await write({ action: 'pause', paused: false })).status).toBe(401);
    expect(writes('items', 'update')).toEqual([]);
    spy.mockRestore();
  });
});

describe('validation', () => {
  it.each([
    ['invalid JSON', '{'],
    ['no action', { date: DATE, done: true }],
    ['an action that never existed', { action: 'explode', date: DATE }],
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
    ['a skip with no skipped', { action: 'skip', date: DATE }],
    ['skipped as a string', { action: 'skip', date: DATE, skipped: 'true' }],
    ['a skip with no date', { action: 'skip', skipped: true }],
    ['a move with no date', { action: 'move' }],
    ['a move to a day not on the calendar', { action: 'move', date: '2026-09-31' }],
    ['a pause with no paused', { action: 'pause' }],
    ['a resume with a resume day', { action: 'pause', paused: false, pausedUntil: '2026-10-09' }],
    ['a null resume day', { action: 'pause', paused: true, pausedUntil: null }],
    ['a resume day in another shape', { action: 'pause', paused: true, pausedUntil: 'Oct 9' }],
    ['a zone that is not a string', { action: 'pause', paused: true, timeZone: 5 }],
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
  it('none of it reaches OpenClaw, as none of the browser’s writes do', async () => {
    for (const [r, body] of [
      [HABIT, { action: 'complete', date: DATE, done: true, count: 1 }],
      [RECURRING_TASK, { action: 'complete', date: DATE, done: true }],
      [ONE_OFF, { action: 'complete', date: DATE, done: true }],
      [ONE_OFF, { action: 'schedule', date: DATE, startTime: '09:15' }],
      [HABIT, { action: 'skip', date: DATE, skipped: true }],
      [RECURRING_TASK, { action: 'skip', date: DATE, skipped: true }],
      [ONE_OFF, { action: 'move', date: TOMORROW }],
      [ONE_OFF, { action: 'pause', paused: true }],
      [PAUSED, { action: 'pause', paused: false }],
    ] as const) {
      row = r;
      expect((await write(body)).status).toBe(200);
    }
    await settle();
    expect(h.notifyPlugins).not.toHaveBeenCalled();
  });
});
