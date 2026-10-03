import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

/**
 * GET /api/app/planner — what the iPhone app reads, and the payload fixture
 * the Swift side decodes.
 *
 * The rows below are snake_case, the way load_planner (migration 050) answers,
 * and they go through the real loader and the real itemFromRow. The route's
 * answer is written to tests/fixtures/app/planner-response.json, which
 * DsulCore's PlannerPayloadTests.swift decodes: a change to the payload that
 * the Swift decoder doesn't make turns CI red there, and a change to the rows
 * or the mapping that isn't regenerated turns it red here. Regenerate with:
 *
 *   UPDATE_FIXTURES=1 pnpm test tests/unit/app-planner.test.ts
 *
 * and commit the JSON with the Swift change. Never hand-edit it.
 *
 * The rows deliberately carry the awkward cases a decoder meets in prod: a
 * Postgres timestamptz with microseconds and `+00:00`, a free-text bucket the
 * app has no case for ('noon'), a NULL repeat_frequency, a habit whose
 * container is only in the frozen `group` column, a custom type, a subtask.
 * And what the item sheet shows: notes with a line break, priorities, a
 * reminder with an anchor and one without, and the custom type's own label
 * (item_types), which the sheet words that item by.
 */

const FIXTURE = path.resolve(__dirname, '../fixtures/app/planner-response.json');
const NOW = '2026-10-02T15:04:05.000Z';

const USER = '6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const PROJECT_ADMIN = '22222222-2222-4222-8222-000000000001';
const PROJECT_HEALTH = '22222222-2222-4222-8222-000000000002';
const ROUTINE_MORNING = '33333333-3333-4333-8333-000000000001';
const ROUTINE_EVENING = '33333333-3333-4333-8333-000000000002';
const SEASON_AUTUMN = '44444444-4444-4444-8444-000000000001';

// ── The fake Supabase ─────────────────────────────────────────────────────────

type Result = { data?: unknown; error?: unknown; count?: number | null };
interface Query {
  table: string;
  calls: [string, unknown[]][];
}

const h = vi.hoisted(() => ({
  createClient: vi.fn(),
  notifyPlugins: vi.fn(),
}));

vi.mock('@supabase/supabase-js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
  createClient: h.createClient,
}));
vi.mock('@/lib/openclaw-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/openclaw-registry')>()),
  notifyPlugins: h.notifyPlugins,
}));

let queries: Query[] = [];
let respond: (q: Query) => Result = () => ({ data: null, error: null });
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

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = () =>
  [b64({ alg: 'HS256' }), b64({ sub: USER, role: 'authenticated', exp: Date.now() / 1000 + 3600 }), 'sig'].join('.');

import { GET } from '@/app/api/app/planner/route';

const get = () =>
  GET(new Request('https://do.dsul.app/api/app/planner', { headers: { authorization: `Bearer ${token()}` } }));

// ── The rows ──────────────────────────────────────────────────────────────────

/** Columns every items_windowed row carries that itemFromRow never reads. */
const rowBase = (n: number) => ({
  id: id(n),
  user_id: USER,
  created_at: `2026-09-${String(n).padStart(2, '0')}T08:00:00.000000+00:00`,
  updated_at: `2026-09-${String(n).padStart(2, '0')}T08:00:00.000000+00:00`,
  deleted_at: null,
  notes: null,
  completed_dates: [],
  skipped_dates: [],
});

const ITEM_ROWS = [
  {
    // A habit with a daily target: three of eight glasses so far today.
    ...rowBase(1),
    type: 'habit',
    title: 'Drink water',
    status: 'pending',
    project: 'Health',
    project_id: PROJECT_HEALTH,
    group: null,
    streak: 4,
    completed_dates: ['2026-09-30', '2026-10-01'],
    daily_counts: { '2026-10-01': 8, '2026-10-02': 3 },
    times_per_day: 8,
    current_day_count: 3,
    repeat_frequency: 'daily',
    time_bucket: 'morning',
    start_time: null,
    duration: null,
  },
  {
    // NULL repeat_frequency (the registry default, daily) and a container that
    // only the frozen `group` column still names.
    ...rowBase(2),
    type: 'habit',
    title: 'Stretch',
    status: 'skipped',
    project: null,
    group: 'Fitness',
    streak: 0,
    skipped_dates: ['2026-10-02'],
    daily_counts: null,
    times_per_day: null,
    current_day_count: null,
    repeat_frequency: null,
    time_bucket: 'evening',
    start_time: '21:30',
    duration: 15,
  },
  {
    // A recurring task, anchored, done once and skipped once.
    ...rowBase(3),
    type: 'task',
    title: 'Water the plants',
    status: 'pending',
    priority: 'low',
    project: null,
    start_date: '2026-09-01',
    repeat_frequency: 'custom',
    repeat_days: [1, 4],
    repeat_month_day: null,
    completed_dates: ['2026-09-28'],
    skipped_dates: ['2026-10-01'],
    time_bucket: 'evening',
    start_time: '18:00',
    duration: 20,
    is_scheduled: true,
    order: 0,
  },
  {
    // A one-off task, timed today, with notes and a reminder at a clock time.
    ...rowBase(4),
    type: 'task',
    title: 'Call the bank',
    status: 'pending',
    priority: 'high',
    notes: 'Ask about the wire fee.\nHave the card ready.',
    reminder_time: '14:15',
    reminder_anchor: null,
    project: 'Admin',
    project_id: PROJECT_ADMIN,
    start_date: '2026-10-02',
    repeat_frequency: null,
    time_bucket: 'afternoon',
    start_time: '14:30',
    duration: 30,
    is_scheduled: true,
    order: 1,
  },
  {
    // A custom type, unscheduled: braindump material.
    ...rowBase(5),
    type: 'book',
    title: 'Read Dune',
    status: 'pending',
    start_date: null,
    repeat_frequency: null,
    time_bucket: null,
    start_time: null,
    is_scheduled: false,
    order: 2,
  },
  {
    // A subtask of the bank call, already done.
    ...rowBase(6),
    type: 'task',
    title: 'Find the account number',
    status: 'completed',
    parent_item_id: id(4),
    start_date: null,
    time_bucket: null,
    is_scheduled: false,
    order: 3,
  },
  {
    // Plain braindump: no bucket, not scheduled.
    ...rowBase(7),
    type: 'task',
    title: 'Buy stamps',
    status: 'pending',
    start_date: null,
    time_bucket: null,
    is_scheduled: false,
    order: 4,
  },
  {
    // Paused, with the timestamptz exactly as Postgres's to_jsonb spells it,
    // and an exclusive end date.
    ...rowBase(8),
    type: 'task',
    title: 'Learn Spanish',
    status: 'pending',
    start_date: '2026-08-01',
    repeat_frequency: 'daily',
    time_bucket: 'morning',
    start_time: '07:30',
    duration: 25,
    is_scheduled: true,
    order: 5,
    paused_at: '2026-09-30T14:03:22.123456+00:00',
    paused_until: '2026-10-15',
  },
  {
    // A bucket the app has no case for. items.time_bucket is free text, and
    // the agent API can write it.
    ...rowBase(9),
    type: 'task',
    title: 'Lunch walk',
    status: 'pending',
    start_date: '2026-10-02',
    time_bucket: 'noon',
    is_scheduled: true,
    order: 6,
  },
  {
    // Drawn inside its project's block, at the block's time.
    ...rowBase(10),
    type: 'task',
    title: 'Inbox zero',
    status: 'pending',
    project: 'Admin',
    project_id: PROJECT_ADMIN,
    start_date: '2026-10-02',
    time_bucket: 'morning',
    in_project_block: true,
    is_scheduled: true,
    order: 7,
  },
  {
    // A routine member, done today, cued after something rather than at a time.
    ...rowBase(11),
    type: 'habit',
    title: 'Meditate',
    status: 'done',
    notes: 'Ten minutes, eyes closed.',
    reminder_time: '06:30',
    reminder_anchor: 'I pour my coffee',
    project: null,
    group: null,
    streak: 12,
    completed_dates: ['2026-10-01', '2026-10-02'],
    daily_counts: {},
    repeat_frequency: 'weekdays',
    time_bucket: 'morning',
    start_time: '06:30',
    duration: 10,
  },
];

const PROJECT_ROWS = [
  {
    // A recurring block: weekday mornings, 9-10.
    id: PROJECT_ADMIN,
    user_id: USER,
    name: 'Admin',
    emoji: '📋',
    color: 'blue',
    repeat_frequency: 'weekdays',
    repeat_days: null,
    repeat_month_day: null,
    time_bucket: 'morning',
    start_time: '09:00',
    duration: 60,
    notes: null,
  },
  {
    // A monthly block with no month day: the two rules answer differently.
    id: PROJECT_HEALTH,
    user_id: USER,
    name: 'Health',
    emoji: '🌿',
    color: null,
    repeat_frequency: 'monthly',
    repeat_days: null,
    repeat_month_day: null,
    time_bucket: 'evening',
    start_time: '19:00',
    duration: null,
    notes: null,
  },
];

const ROUTINE_ROWS = [
  {
    id: ROUTINE_MORNING,
    user_id: USER,
    name: 'Morning routine',
    icon: null,
    color: null,
    paused_at: null,
    paused_until: null,
    sort_order: 0,
    usual_time: '06:30',
    notes: null,
  },
  {
    id: ROUTINE_EVENING,
    user_id: USER,
    name: 'Wind-down',
    icon: null,
    color: null,
    paused_at: '2026-09-20T21:00:00+00:00',
    paused_until: null,
    sort_order: 1,
    usual_time: null,
    notes: null,
  },
];

// In the fetch order both loaders guarantee (sort_order nulls last, item_id).
const ROUTINE_ITEM_ROWS = [
  { routine_id: ROUTINE_MORNING, item_id: id(11), sort_order: 0 },
  { routine_id: ROUTINE_MORNING, item_id: id(1), sort_order: 1 },
  { routine_id: ROUTINE_EVENING, item_id: id(2), sort_order: 0 },
];

const SEASON_ROWS = [
  {
    // An active season holding the morning routine and the plants.
    id: SEASON_AUTUMN,
    user_id: USER,
    name: 'Autumn',
    icon: null,
    color: null,
    state: 'active',
    starts_on: '2026-09-01',
    ends_on: '2026-11-30',
    sort_order: 0,
    updated_at: '2026-09-01T08:00:00.5+00:00',
    notes: null,
  },
];
const SEASON_ITEM_ROWS = [{ season_id: SEASON_AUTUMN, item_id: id(3) }];
const SEASON_ROUTINE_ROWS = [{ season_id: SEASON_AUTUMN, routine_id: ROUTINE_MORNING }];

/**
 * The custom type 'book', labelled as its owner named it, which is not the
 * capitalised slug the phone falls back to. The row carries more than the
 * payload sends (icon, colour, config), so the test proves the route names it.
 */
const ITEM_TYPE_ROWS = [
  {
    id: '55555555-5555-4555-8555-000000000001',
    user_id: USER,
    name: 'book',
    label: 'Book to read',
    label_plural: 'Books to read',
    icon: 'icon:BookOpen',
    color: 'var(--accent-3)',
    config: {},
    created_at: '2026-09-01T08:00:00.000000+00:00',
    updated_at: '2026-09-01T08:00:00.000000+00:00',
  },
];

const BUNDLE = {
  v: 1,
  uid: USER,
  items: ITEM_ROWS,
  projects: PROJECT_ROWS,
  item_types: ITEM_TYPE_ROWS,
  routines: ROUTINE_ROWS,
  routine_items: ROUTINE_ITEM_ROWS,
  seasons: SEASON_ROWS,
  season_items: SEASON_ITEM_ROWS,
  season_routines: SEASON_ROUTINE_ROWS,
  goals: [],
  goal_items: [],
};

/**
 * The settings row as a careless `select('*')` would return it — the agent key
 * included — so the test proves the route names its columns rather than
 * trusting the mock to have left the key out.
 */
const SETTINGS_ROW = {
  timezone: 'America/Los_Angeles',
  show_completed_tasks: true,
  week_start_day: 'monday',
  time_format: '24h',
  app_icon: 'lime',
  openclaw_api_key: `dsul_${'ab'.repeat(32)}`,
  openclaw_webhook_url: 'https://hooks.example.com',
};

function respondWith(tables: Record<string, Result>) {
  respond = (q) => tables[q.table] ?? { data: null, error: { code: 'XX000', message: `unexpected ${q.table}` } };
}

const serialize = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

/** Every key at every depth, so a leak is found wherever it nests. */
function allKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      allKeys(v, out);
    }
  }
  return out;
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterAll(() => {
  vi.useRealTimers();
});

/** A signed-in user whose load_planner answers BUNDLE. */
function setUp() {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://ref.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
  queries = [];
  rpc = vi.fn(async () => ({ data: BUNDLE, error: null }));
  respondWith({ user_settings: { data: SETTINGS_ROW, error: null } });
  h.createClient.mockImplementation(() => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: USER } }, error: null })) },
    from,
    rpc,
  }));
}

beforeEach(setUp);

describe('the payload fixture shared with DsulCore', () => {
  let generated: Record<string, unknown>;

  // beforeAll runs ahead of the file's beforeEach, so it sets up for itself.
  beforeAll(async () => {
    setUp();
    const res = await get();
    expect(res.status).toBe(200);
    generated = (await res.json()) as Record<string, unknown>;
    if (process.env.UPDATE_FIXTURES) {
      mkdirSync(path.dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, serialize(generated));
    }
  });

  it('the committed file exists', () => {
    expect(existsSync(FIXTURE), `missing ${FIXTURE}; run with UPDATE_FIXTURES=1`).toBe(true);
  });

  it('the committed payload is what the route answers today', () => {
    // On drift: if the change is intended, regenerate with UPDATE_FIXTURES=1
    // and make the same change in ios/DsulCore (Item.swift's decoder).
    expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual(generated);
  });

  it('has the documented top-level shape', () => {
    expect(Object.keys(generated).sort()).toEqual(
      ['fetchedAt', 'itemTypes', 'items', 'projects', 'routines', 'seasons', 'settings', 'userId', 'v', 'writes'].sort(),
    );
    expect(generated.v).toBe(1);
    expect(generated.userId).toBe(USER);
    expect(generated.fetchedAt).toBe(NOW);
    expect(generated.settings).toEqual({
      timezone: 'America/Los_Angeles',
      showCompletedTasks: true,
      weekStartDay: 'monday',
      timeFormat: '24h',
      appIcon: 'lime',
    });
    // The intents the item route takes. Additive: an older server sends no
    // list, which the phone reads as ['complete', 'schedule'].
    expect(generated.writes).toEqual(['complete', 'schedule', 'skip', 'move', 'pause', 'title', 'notes', 'delete']);
    // The custom type's names, and nothing else of its row.
    expect(generated.itemTypes).toEqual([{ name: 'book', label: 'Book to read', labelPlural: 'Books to read' }]);
  });

  it('carries every case the Swift decoder has to meet', () => {
    const items = generated.items as Record<string, unknown>[];
    const byTitle = (title: string) => items.find((i) => i.title === title)!;
    expect(items).toHaveLength(ITEM_ROWS.length);

    // camelCase Item, as itemFromRow maps it.
    expect(byTitle('Drink water')).toMatchObject({
      type: 'habit',
      timesPerDay: 8,
      dailyCounts: { '2026-10-01': 8, '2026-10-02': 3 },
      currentDayCount: 3,
      streak: 4,
    });
    expect(byTitle('Stretch')).toMatchObject({ type: 'habit', repeatFrequency: 'daily', project: 'Fitness' });
    expect(byTitle('Water the plants')).toMatchObject({
      type: 'task',
      repeatFrequency: 'custom',
      repeatDays: [1, 4],
      skippedDates: ['2026-10-01'],
    });
    expect(byTitle('Call the bank')).toMatchObject({
      type: 'task',
      status: 'pending',
      startTime: '14:30',
      priority: 'high',
      notes: 'Ask about the wire fee.\nHave the card ready.',
      reminderTime: '14:15',
    });
    expect(byTitle('Call the bank')).not.toHaveProperty('repeatFrequency');
    expect(byTitle('Call the bank')).not.toHaveProperty('reminderAnchor');
    expect(byTitle('Water the plants')).toMatchObject({ priority: 'low' });
    expect(byTitle('Buy stamps')).not.toHaveProperty('priority');
    expect(byTitle('Buy stamps')).not.toHaveProperty('notes');
    expect(byTitle('Meditate')).toMatchObject({
      notes: 'Ten minutes, eyes closed.',
      reminderTime: '06:30',
      reminderAnchor: 'I pour my coffee',
    });
    // The custom-type envelope: the slug travels as customType.
    expect(byTitle('Read Dune')).toMatchObject({ type: 'custom', customType: 'book', isScheduled: false });
    expect(byTitle('Find the account number')).toMatchObject({ parentItemId: id(4) });
    expect(byTitle('Learn Spanish')).toMatchObject({
      pausedAt: '2026-09-30T14:03:22.123456+00:00',
      pausedUntil: '2026-10-15',
    });
    expect(byTitle('Lunch walk')).toMatchObject({ timeBucket: 'noon' });
    expect(byTitle('Inbox zero')).toMatchObject({ inProjectBlock: true, project: 'Admin' });

    expect(generated.projects).toContainEqual(
      expect.objectContaining({ name: 'Admin', repeatFrequency: 'weekdays', startTime: '09:00', duration: 60 }),
    );
    expect(generated.routines).toContainEqual(
      expect.objectContaining({ name: 'Morning routine', itemIds: [id(11), id(1)] }),
    );
    expect(generated.seasons).toEqual([
      expect.objectContaining({ name: 'Autumn', itemIds: [id(3)], routineIds: [ROUTINE_MORNING] }),
    ]);
  });

  it('leaks no openclaw_* key, at any depth', () => {
    expect(allKeys(generated).filter((k) => k.toLowerCase().startsWith('openclaw'))).toEqual([]);
    expect(JSON.stringify(generated)).not.toContain(SETTINGS_ROW.openclaw_api_key);
  });
});

describe('GET /api/app/planner', () => {
  it('reads one RPC as the user, and the settings by named columns', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(rpc).toHaveBeenCalledExactlyOnceWith('load_planner');

    const settings = queries.filter((q) => q.table === 'user_settings');
    expect(settings).toHaveLength(1);
    expect(settings[0].calls).toContainEqual([
      'select',
      ['timezone, show_completed_tasks, week_start_day, time_format, app_icon'],
    ]);
    expect(settings[0].calls).toContainEqual(['eq', ['user_id', USER]]);
    // Nothing else is read: no per-table burst on top of the RPC.
    expect(queries.map((q) => q.table)).toEqual(['user_settings']);
  });

  it('falls back to the web’s defaults when there is no settings row', async () => {
    respondWith({ user_settings: { data: null, error: null } });
    const body = await (await get()).json();
    expect(body.settings).toEqual({
      timezone: null,
      showCompletedTasks: true,
      weekStartDay: 'sunday',
      timeFormat: '12h',
      appIcon: null,
    });
  });

  it('answers a week start or time format the app has no case for as the default', async () => {
    respondWith({ user_settings: { data: { ...SETTINGS_ROW, week_start_day: 'friday', time_format: '12' }, error: null } });
    const settings = (await (await get()).json()).settings;
    expect(settings.weekStartDay).toBe('sunday');
    expect(settings.timeFormat).toBe('12h');
    respondWith({ user_settings: { data: { ...SETTINGS_ROW, week_start_day: 'saturday', time_format: null }, error: null } });
    const again = (await (await get()).json()).settings;
    expect(again.weekStartDay).toBe('saturday');
    expect(again.timeFormat).toBe('12h');
  });

  it('reads the settings again without app_icon on a database without migration 056', async () => {
    respond = (q) => {
      if (q.table !== 'user_settings') return { data: null, error: { code: 'XX000', message: `unexpected ${q.table}` } };
      const columns = String(q.calls.find(([m]) => m === 'select')?.[1][0]);
      return columns.includes('app_icon')
        ? { data: null, error: { code: '42703', message: 'column user_settings.app_icon does not exist' } }
        : {
            data: { timezone: 'Europe/Paris', show_completed_tasks: false, week_start_day: 'monday', time_format: '24h' },
            error: null,
          };
    };
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).settings).toEqual({
      timezone: 'Europe/Paris',
      showCompletedTasks: false,
      weekStartDay: 'monday',
      timeFormat: '24h',
      appIcon: null,
    });
    const selects = queries.filter((q) => q.table === 'user_settings').map((q) => q.calls.find(([m]) => m === 'select')?.[1][0]);
    expect(selects).toEqual([
      'timezone, show_completed_tasks, week_start_day, time_format, app_icon',
      'timezone, show_completed_tasks, week_start_day, time_format',
    ]);
  });

  it('answers app_icon as the web reads it: null stays unchosen, an unknown slug is Aurora', async () => {
    respondWith({ user_settings: { data: { ...SETTINGS_ROW, app_icon: null }, error: null } });
    expect((await (await get()).json()).settings.appIcon).toBeNull();
    respondWith({ user_settings: { data: { ...SETTINGS_ROW, app_icon: 'sunset' }, error: null } });
    expect((await (await get()).json()).settings.appIcon).toBe('aurora');
    respondWith({ user_settings: { data: { ...SETTINGS_ROW, app_icon: 'aurora' }, error: null } });
    expect((await (await get()).json()).settings.appIcon).toBe('aurora');
  });

  it('401s a JWT PostgREST rejects, so the phone refreshes', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST301', message: 'JWT expired' } });
    expect((await get()).status).toBe(401);
  });

  it('500s anything else, without the database’s words', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    rpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } });
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'failed' });

    respondWith({ user_settings: { data: null, error: { code: '42501', message: 'permission denied for table user_settings' } } });
    rpc.mockResolvedValue({ data: BUNDLE, error: null });
    const settingsFailed = await get();
    expect(settingsFailed.status).toBe(500);
    expect(await settingsFailed.json()).toEqual({ error: 'failed' });
    spy.mockRestore();
  });

  it('refuses an answer for a different session', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    rpc.mockResolvedValue({ data: { ...BUNDLE, uid: '00000000-0000-4000-8000-000000000000' }, error: null });
    expect((await get()).status).toBe(500);
    spy.mockRestore();
  });

  // LAST in the file: a missing RPC flips db.ts's module-level latch, and every
  // later load in this module goes straight to the per-table path, so the
  // tests after this one run on it.
  const PER_TABLE: Record<string, Result> = {
    user_settings: { data: SETTINGS_ROW, error: null },
    items_windowed: { data: ITEM_ROWS, error: null },
    projects: { data: PROJECT_ROWS, error: null },
    item_types: { data: ITEM_TYPE_ROWS, error: null },
    routines: { data: ROUTINE_ROWS, error: null },
    routine_items: { data: ROUTINE_ITEM_ROWS, error: null },
    seasons: { data: SEASON_ROWS, error: null },
    season_items: { data: SEASON_ITEM_ROWS, error: null },
    season_routines: { data: SEASON_ROUTINE_ROWS, error: null },
  };

  it('without load_planner, reads the tables as the user and answers the same payload', async () => {
    const viaRpc = await (await get()).json();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    queries = [];
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'no such function' } });
    respondWith(PER_TABLE);
    const res = await get();
    warn.mockRestore();

    expect(res.status).toBe(200);
    const viaTables = await res.json();
    // Item types included: the sheet words a custom item by its label.
    expect(viaTables).toEqual(viaRpc);
    // The phone doesn't read goals yet, so they aren't read.
    const tables = queries.map((q) => q.table);
    expect(tables).toContain('item_types');
    expect(tables).not.toContain('goals');
    // Every table read is scoped to the caller (RLS does it too).
    for (const q of queries) expect(q.calls, q.table).toContainEqual(['eq', ['user_id', USER]]);
  });

  it('answers itemTypes null, and still answers, when the item_types table is unreachable', async () => {
    // On the per-table path since the test above.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    respondWith({
      ...PER_TABLE,
      item_types: { data: null, error: { code: '42P01', message: 'relation "item_types" does not exist' } },
    });
    const res = await get();
    warn.mockRestore();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.itemTypes).toBeNull();
    expect(body.items).toHaveLength(ITEM_ROWS.length);
    expect(rpc).not.toHaveBeenCalled();
  });
});
