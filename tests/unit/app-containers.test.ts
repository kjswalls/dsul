import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * POST /api/app/containers/:kind/:id: one field of one container, from the
 * iPhone (lib/app-containers.ts postContainerWrite). O8a took a routine's
 * `pause` (Pause, Pause until, Resume) and a season's `state` (On, Off,
 * Dates), the web's setRoutinePaused and setSeasonState. O8b adds the other
 * fields (a routine's usual time, a season's runs, a goal's state and window,
 * notes and the why) and O9 the name, glyph and colour of every kind, with a
 * project rename's clash checks and its members' re-file. O10 adds the
 * delete, and O11 the create route beside it (POST /api/app/containers/:kind,
 * postContainerCreate), both pinned at the end of this file.
 *
 * What the route promises, each pinned below:
 *   - 404 for an unknown kind, a malformed id, and any container that is not
 *     the caller's LIVE row (never one, in the Trash, another user's), with
 *     nothing written: the row is read first because the update functions do
 *     not filter deleted_at (updateProject not even user_id) and a zero-row
 *     update says 200;
 *   - 400 for anything but one strict intent of that kind, an inverted range
 *     and a null glyph among them;
 *   - a pause resolved at today in the account's zone, from one `now`, through
 *     resolvePauseWrite: a retry writes nothing, a resume keeps the interval,
 *     and a resume day not after today is 409 `pause_refused`;
 *   - a season's state stored exactly as picked, and nothing written when it
 *     already has it; a goal's through resolveGoalStateWrite, so a goal
 *     achieved twice keeps its first `achievedAt`;
 *   - a project rename refused 409 `name_taken` on a live folded clash and
 *     `name_in_trash` on the bin's exact one, and otherwise followed by its
 *     members' name, by project_id only;
 *   - each intent writes its own columns and no other;
 *   - a delete stamps the row's deleted_at and nothing else, once: a row
 *     already in the bin is 200 with no write, and no row at all is 404;
 *   - a create inserts the container containerCreateRecord makes, under the
 *     phone's id; a retry by id is 200 with no insert, a project's live
 *     folded clash is 409 `name_taken` and the bin's exact one
 *     `name_in_trash`;
 *   - no extension gate, no webhook, no item_events, never the service role.
 *
 * The database is an in-memory PostgREST with RLS, as in app-trash.test.ts:
 * every statement sees only the caller's rows.
 */

const USER = '6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';
const OTHER = '0d1e2f3a-4b5c-4d6e-8f7a-9b0c1d2e3f4a';

const id = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ROUTINE = (n: number) => id('33333333', n);
const SEASON = (n: number) => id('44444444', n);
const GOAL = (n: number) => id('55555555', n);
const PROJECT = (n: number) => id('22222222', n);
const ITEM = (n: number) => id('11111111', n);

/** 13:00 in New York on Friday Oct 23, 2026. */
const NOW = '2026-10-23T17:00:00.000Z';
const TODAY = '2026-10-23';
const STAMP = '2026-10-01T12:00:00.123456+00:00';

type Row = Record<string, unknown>;
type Filter = ['eq' | 'is', string, unknown];
interface Statement {
  table: string;
  op: 'select' | 'update' | 'insert';
  columns?: string;
  payload?: Row;
  filters: Filter[];
}

const h = vi.hoisted(() => ({
  createClient: vi.fn(),
  notifyPlugins: vi.fn(),
  createServiceClient: vi.fn(),
}));

vi.mock('@supabase/supabase-js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
  createClient: h.createClient,
}));
vi.mock('@/lib/openclaw-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/openclaw-registry')>()),
  notifyPlugins: h.notifyPlugins,
}));
vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: h.createServiceClient,
  resolveUserIdFromApiKey: vi.fn(),
}));

let tables: Record<string, Row[]>;
let statements: Statement[];
/** A table whose every statement fails, as a dropped connection would. */
let failing: { table: string; op?: Statement['op'] } | null;

/** projects_user_id_name_key: one user's names, exact-case, live and trashed rows alike. */
const UNIQUE_NAME = new Set(['projects']);
/**
 * Runs just before an insert is checked, as another request committing first
 * would: a test that races two sends of one create puts the row here.
 */
let beforeInsert: ((table: string, payload: Row) => void) | null;
/** As beforeInsert, for an update: a test that races a rename puts the other device's row here. */
let beforeUpdate: ((table: string, payload: Row) => void) | null;

const uniqueViolation = (constraint: string) => ({
  data: null,
  error: { code: '23505', message: `duplicate key value violates unique constraint "${constraint}"` },
});

/** Enough of PostgREST for the route: select (a column list or *), update, insert, eq, is, maybeSingle. */
function database() {
  const build = (table: string, op: Statement['op'], payload?: Row, columns?: string) => {
    const filters: Filter[] = [];
    // RLS: the caller's rows, and nothing else, whatever the statement asks.
    const match = (row: Row) =>
      row.user_id === USER &&
      filters.every(([kind, col, val]) => (kind === 'eq' ? row[col] === val : (row[col] ?? null) === val));
    const project = (row: Row): Row => {
      if (!columns || columns.trim() === '*') return { ...row };
      return Object.fromEntries(columns.split(',').map((c) => [c.trim(), row[c.trim()] ?? null]));
    };
    const run = async () => {
      statements.push({ table, op, columns, payload, filters: [...filters] });
      if (failing && failing.table === table && (!failing.op || failing.op === op)) {
        return { data: null, error: { code: 'XX000', message: 'connection reset' } };
      }
      if (op === 'insert' && payload) {
        beforeInsert?.(table, payload);
        // RLS's WITH CHECK: a row for anyone else is refused outright.
        if (payload.user_id !== USER) return { data: null, error: { code: '42501', message: 'new row violates row-level security policy' } };
        const all = (tables[table] ??= []);
        // The primary key spans every user's rows, and the bin's.
        if (all.some((r) => r.id === payload.id)) return uniqueViolation(`${table}_pkey`);
        if (UNIQUE_NAME.has(table) && all.some((r) => r.user_id === USER && r.name === payload.name)) {
          return uniqueViolation('projects_user_id_name_key');
        }
        // The columns' own defaults, then what was sent.
        all.push({ created_at: NOW, deleted_at: null, ...payload });
        return { data: null, error: null };
      }
      if (op === 'update' && payload) beforeUpdate?.(table, payload);
      const hit = (tables[table] ?? []).filter(match);
      if (op === 'update') {
        if (UNIQUE_NAME.has(table) && payload && 'name' in payload) {
          const held = (tables[table] ?? []).some((r) => r.user_id === USER && r.name === payload.name && !hit.includes(r));
          if (held) return uniqueViolation('projects_user_id_name_key');
        }
        for (const row of hit) Object.assign(row, payload);
        return { data: null, error: null };
      }
      return { data: hit.map(project), error: null };
    };
    const chain: Record<string, unknown> = {
      eq: (col: string, val: unknown) => (filters.push(['eq', col, val]), chain),
      is: (col: string, val: unknown) => (filters.push(['is', col, val]), chain),
      maybeSingle: () => run().then((r) => ({ data: (r.data as Row[] | null)?.[0] ?? null, error: r.error })),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => run().then(resolve, reject),
    };
    return chain;
  };
  return {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: USER } }, error: null })) },
    from: (table: string) => ({
      select: (columns?: string) => build(table, 'select', undefined, columns),
      update: (payload: Row) => build(table, 'update', payload),
      insert: (payload: Row) => build(table, 'insert', payload),
    }),
  };
}

const writes = () => statements.filter((s) => s.op === 'update');
const inserts = () => statements.filter((s) => s.op === 'insert');

const routineRow = (n: number, name: string, over: Row = {}): Row => ({
  id: ROUTINE(n),
  user_id: USER,
  name,
  icon: null,
  color: null,
  paused_at: null,
  paused_until: null,
  sort_order: n,
  usual_time: null,
  notes: null,
  created_at: STAMP,
  updated_at: STAMP,
  deleted_at: null,
  ...over,
});

const seasonRow = (n: number, name: string, over: Row = {}): Row => ({
  id: SEASON(n),
  user_id: USER,
  name,
  icon: null,
  color: null,
  state: 'auto',
  starts_on: null,
  ends_on: null,
  sort_order: n,
  notes: null,
  created_at: STAMP,
  updated_at: STAMP,
  deleted_at: null,
  ...over,
});

const goalRow = (n: number, name: string, over: Row = {}): Row => ({
  id: GOAL(n),
  user_id: USER,
  name,
  why: null,
  icon: null,
  color: null,
  state: 'active',
  starts_on: null,
  target_on: null,
  achieved_at: null,
  sort_order: n,
  created_at: STAMP,
  updated_at: STAMP,
  deleted_at: null,
  ...over,
});

const projectRow = (n: number, name: string, over: Row = {}): Row => ({
  id: PROJECT(n),
  user_id: USER,
  name,
  emoji: '',
  color: null,
  repeat_frequency: null,
  repeat_days: null,
  repeat_month_day: null,
  time_bucket: null,
  start_time: null,
  duration: null,
  notes: null,
  created_at: STAMP,
  deleted_at: null,
  ...over,
});

const itemRow = (n: number, title: string, over: Row = {}): Row => ({
  id: ITEM(n),
  user_id: USER,
  type: 'task',
  title,
  project: null,
  project_id: null,
  deleted_at: null,
  ...over,
});

/** When Read more was achieved, a week ago. */
const ACHIEVED = '2026-10-16T09:30:00.000Z';

/**
 *   - Morning: live, never paused;
 *   - Evening: paused since Oct 20, no return day;
 *   - Stretch: paused since Oct 20, back Oct 30;
 *   - Garden: paused Oct 1 to Oct 10, over (the interval kept on the row);
 *   - Old: in the Trash; Theirs: another user's;
 *   - Autumn: auto, Sep 1 to Nov 30 (live today); Shelf: off by hand;
 *     Always: on by hand; Gone: in the Trash; Not mine: another user's;
 *   - Run a half: active, with a why and a window; Read more: achieved a
 *     week ago; Old goal: in the Trash; Their goal: another user's;
 *   - Work and Home live; Errands in the Trash, still holding its name;
 *     Garden: another user's;
 *   - Home's members by project_id: Fix the tap, Mow (its text drifted to
 *     "home") and Old chore (in the Trash); Stranger says "Home" with no id;
 *     Report is Work's; Their chore is another user's, under Home's id;
 *   - Organize and Goals switched off, which gate nothing here.
 */
function world(): Record<string, Row[]> {
  return {
    routines: [
      routineRow(1, 'Morning'),
      routineRow(2, 'Evening', { paused_at: '2026-10-20T13:00:00+00:00' }),
      routineRow(3, 'Stretch', { paused_at: '2026-10-20T13:00:00+00:00', paused_until: '2026-10-30' }),
      routineRow(4, 'Garden', { paused_at: '2026-10-01T13:00:00+00:00', paused_until: '2026-10-10' }),
      routineRow(5, 'Old', { deleted_at: STAMP }),
      { ...routineRow(6, 'Theirs'), user_id: OTHER },
    ],
    seasons: [
      seasonRow(1, 'Autumn', { starts_on: '2026-09-01', ends_on: '2026-11-30' }),
      seasonRow(2, 'Shelf', { state: 'paused' }),
      seasonRow(3, 'Always', { state: 'active' }),
      seasonRow(4, 'Gone', { deleted_at: STAMP }),
      { ...seasonRow(5, 'Not mine'), user_id: OTHER },
    ],
    goals: [
      goalRow(1, 'Run a half', { why: 'To feel strong.', starts_on: '2026-09-01', target_on: '2027-03-15' }),
      goalRow(2, 'Read more', { state: 'achieved', achieved_at: ACHIEVED }),
      goalRow(3, 'Old goal', { deleted_at: STAMP }),
      { ...goalRow(4, 'Their goal'), user_id: OTHER },
    ],
    projects: [
      projectRow(1, 'Work'),
      projectRow(2, 'Home', { emoji: 'icon:House', notes: 'Chores.' }),
      projectRow(3, 'Errands', { deleted_at: STAMP }),
      { ...projectRow(4, 'Garden'), user_id: OTHER },
    ],
    items: [
      itemRow(1, 'Fix the tap', { project: 'Home', project_id: PROJECT(2) }),
      itemRow(2, 'Mow', { project: 'home', project_id: PROJECT(2) }),
      itemRow(3, 'Old chore', { project: 'Home', project_id: PROJECT(2), deleted_at: STAMP }),
      itemRow(4, 'Stranger', { project: 'Home' }),
      itemRow(5, 'Report', { project: 'Work', project_id: PROJECT(1) }),
      { ...itemRow(6, 'Their chore', { project: 'Home', project_id: PROJECT(2) }), user_id: OTHER },
    ],
    user_settings: [{ user_id: USER, timezone: 'America/New_York' }],
    user_extensions: [
      { user_id: USER, slug: 'organize', enabled: false },
      { user_id: USER, slug: 'goals', enabled: false },
    ],
  };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = () =>
  [b64({ alg: 'HS256' }), b64({ sub: USER, role: 'authenticated', exp: Date.now() / 1000 + 3600 }), 'sig'].join('.');

import { POST as containerRoute } from '@/app/api/app/containers/[kind]/[id]/route';
import { POST as createRoute } from '@/app/api/app/containers/[kind]/route';
import {
  CONTAINER_CREATE_SCHEMAS,
  CONTAINER_WRITES,
  CONTAINER_WRITE_SCHEMAS,
  GoalCreateSchema,
  GoalWriteSchema,
  ProjectCreateSchema,
  ProjectWriteSchema,
  RoutineCreateSchema,
  RoutineWriteSchema,
  SeasonCreateSchema,
  SeasonWriteSchema,
  containerCreateRecord,
  containerIntentPatch,
  containerWrites,
} from '@/lib/app-containers';
import {
  goalFromRow,
  projectFromRow,
  routineFromRow,
  seasonFromRow,
  type GoalRow,
  type ProjectRow,
  type RoutineRow,
  type SeasonRow,
} from '@/lib/db';

const write = (kind: string, rowId: string, body: unknown, auth: string | null = `Bearer ${token()}`) =>
  containerRoute(
    new Request(`https://do.dsul.app/api/app/containers/${kind}/${rowId}`, {
      method: 'POST',
      headers: { ...(auth ? { authorization: auth } : {}), 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ kind, id: rowId }) },
  );

const create = (kind: string, body: unknown, auth: string | null = `Bearer ${token()}`) =>
  createRoute(
    new Request(`https://do.dsul.app/api/app/containers/${kind}`, {
      method: 'POST',
      headers: { ...(auth ? { authorization: auth } : {}), 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ kind }) },
  );

const row = (table: string, rowId: string) => tables[table].find((r) => r.id === rowId)!;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://ref.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
  tables = world();
  statements = [];
  failing = null;
  beforeInsert = null;
  beforeUpdate = null;
  h.createClient.mockImplementation(() => database());
});

afterEach(() => {
  vi.useRealTimers();
});

const liveRead = (table: string, rowId: string): Statement => ({
  table,
  op: 'select',
  columns: '*',
  payload: undefined,
  filters: [
    ['eq', 'id', rowId],
    ['eq', 'user_id', USER],
    ['is', 'deleted_at', null],
  ],
});

describe("a routine's pause", () => {
  it('pauses a live routine from now, with no return day: the two pause columns and nothing else', async () => {
    const res = await write('routine', ROUTINE(1), { action: 'pause', paused: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(statements[0]).toEqual(liveRead('routines', ROUTINE(1)));
    expect(writes()).toEqual([
      {
        table: 'routines',
        op: 'update',
        columns: undefined,
        payload: { paused_at: NOW, paused_until: null },
        filters: [
          ['eq', 'id', ROUTINE(1)],
          ['eq', 'user_id', USER],
        ],
      },
    ]);
  });

  it('pauses until a day: the exclusive return day is stored as sent', async () => {
    expect((await write('routine', ROUTINE(1), { action: 'pause', paused: true, pausedUntil: '2026-10-30' })).status).toBe(200);
    expect(writes().map((w) => w.payload)).toEqual([{ paused_at: NOW, paused_until: '2026-10-30' }]);
    expect(row('routines', ROUTINE(1))).toMatchObject({ paused_at: NOW, paused_until: '2026-10-30' });
  });

  it('resumes a paused routine at today, keeping when the pause began on the row', async () => {
    expect((await write('routine', ROUTINE(2), { action: 'pause', paused: false })).status).toBe(200);
    expect(writes().map((w) => w.payload)).toEqual([{ paused_until: TODAY }]);
    expect(row('routines', ROUTINE(2))).toMatchObject({ paused_at: '2026-10-20T13:00:00+00:00', paused_until: TODAY });
  });

  it('moves the end of a running pause without restamping its start', async () => {
    expect((await write('routine', ROUTINE(3), { action: 'pause', paused: true, pausedUntil: '2026-11-02' })).status).toBe(200);
    expect(writes().map((w) => w.payload)).toEqual([{ paused_until: '2026-11-02' }]);
  });

  it('a pause that is already so writes nothing: a retry, a double tap, a resume of a live routine', async () => {
    expect((await write('routine', ROUTINE(2), { action: 'pause', paused: true })).status).toBe(200);
    expect((await write('routine', ROUTINE(1), { action: 'pause', paused: false })).status).toBe(200);
    // A pause that is over is live: resuming it changes nothing.
    expect((await write('routine', ROUTINE(4), { action: 'pause', paused: false })).status).toBe(200);
    expect(writes()).toEqual([]);

    // The same pause twice lands once, and the second never restamps it.
    expect((await write('routine', ROUTINE(1), { action: 'pause', paused: true, pausedUntil: '2026-10-30' })).status).toBe(200);
    vi.setSystemTime(new Date('2026-10-23T18:00:00.000Z'));
    expect((await write('routine', ROUTINE(1), { action: 'pause', paused: true })).status).toBe(200);
    expect(writes()).toHaveLength(1);
    expect(row('routines', ROUTINE(1)).paused_at).toBe(NOW);
  });

  it('pausing a routine whose last pause is over starts a new one', async () => {
    expect((await write('routine', ROUTINE(4), { action: 'pause', paused: true })).status).toBe(200);
    expect(writes().map((w) => w.payload)).toEqual([{ paused_at: NOW, paused_until: null }]);
  });

  it('refuses a return day that is not after today on a live routine: 409 pause_refused, nothing written', async () => {
    for (const day of [TODAY, '2026-10-01']) {
      const res = await write('routine', ROUTINE(1), { action: 'pause', paused: true, pausedUntil: day });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'pause_refused' });
    }
    expect(writes()).toEqual([]);
  });

  it("resolves today in the account's zone, then the device's, then UTC", async () => {
    // 22:30 on Oct 23 in New York is 02:30 on Oct 24 in UTC.
    vi.setSystemTime(new Date('2026-10-24T02:30:00.000Z'));
    await write('routine', ROUTINE(2), { action: 'pause', paused: false, timeZone: 'Asia/Tokyo' });
    expect(row('routines', ROUTINE(2)).paused_until).toBe('2026-10-23');

    tables = world();
    tables.user_settings = [];
    await write('routine', ROUTINE(2), { action: 'pause', paused: false, timeZone: 'America/Los_Angeles' });
    expect(row('routines', ROUTINE(2)).paused_until).toBe('2026-10-23');

    tables = world();
    tables.user_settings = [{ user_id: USER, timezone: 'Not/AZone' }];
    await write('routine', ROUTINE(2), { action: 'pause', paused: false });
    expect(row('routines', ROUTINE(2)).paused_until).toBe('2026-10-24');

    // The zone was read once a write, as the caller, by user.
    const reads = statements.filter((s) => s.table === 'user_settings');
    expect(reads).toHaveLength(3);
    expect(reads[0]).toMatchObject({ columns: 'timezone', filters: [['eq', 'user_id', USER]] });
  });

  it('a return day of today on a routine paused in the zone the account names is refused, read in that zone', async () => {
    // Oct 24 has begun in UTC but not in New York, so Oct 24 is still after today.
    vi.setSystemTime(new Date('2026-10-24T02:30:00.000Z'));
    expect((await write('routine', ROUTINE(1), { action: 'pause', paused: true, pausedUntil: '2026-10-24' })).status).toBe(200);
    tables = world();
    tables.user_settings = [{ user_id: USER, timezone: 'UTC' }];
    expect((await write('routine', ROUTINE(1), { action: 'pause', paused: true, pausedUntil: '2026-10-24' })).status).toBe(409);
  });

  it.each([
    ['a return day with a resume', { action: 'pause', paused: false, pausedUntil: '2026-10-30' }],
    ['no paused', { action: 'pause' }],
    ['a null return day', { action: 'pause', paused: true, pausedUntil: null }],
    ['a day that is not on the calendar', { action: 'pause', paused: true, pausedUntil: '2026-02-31' }],
    ['a day that is not a day', { action: 'pause', paused: true, pausedUntil: 'Friday' }],
    ['a key it does not take', { action: 'pause', paused: true, pausedAt: NOW }],
    ['a zone past its bound', { action: 'pause', paused: true, timeZone: 'x'.repeat(101) }],
    ["a season's intent", { action: 'state', state: 'paused' }],
  ])('is 400 invalid for %s, before any statement', async (_name, body) => {
    const res = await write('routine', ROUTINE(1), body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid');
    expect(statements).toEqual([]);
  });
});

describe("a season's state", () => {
  it.each([
    ['On', SEASON(1), 'active'],
    ['Off', SEASON(1), 'paused'],
    ['Dates', SEASON(2), 'auto'],
    ['On, from Off', SEASON(2), 'active'],
    ['Dates, from On', SEASON(3), 'auto'],
  ] as const)('writes %s exactly as picked, and only the state', async (_name, seasonId, state) => {
    const res = await write('season', seasonId, { action: 'state', state });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(statements[0]).toEqual(liveRead('seasons', seasonId));
    expect(writes()).toEqual([
      {
        table: 'seasons',
        op: 'update',
        columns: undefined,
        payload: { state },
        filters: [
          ['eq', 'id', seasonId],
          ['eq', 'user_id', USER],
        ],
      },
    ]);
    expect(row('seasons', seasonId).state).toBe(state);
  });

  it('On for a dated season that is live today stays On, never handed back to its dates', async () => {
    // seasonStateForSwitch would answer `auto` here (the calendar already
    // agrees); the Status chip's On pins it on past its end, so it is stored raw.
    await write('season', SEASON(1), { action: 'state', state: 'active' });
    expect(row('seasons', SEASON(1)).state).toBe('active');
  });

  it('the state it already has writes nothing, so updated_at (the sweep’s evidence of a switch) is never restamped', async () => {
    for (const [seasonId, state] of [
      [SEASON(1), 'auto'],
      [SEASON(2), 'paused'],
      [SEASON(3), 'active'],
    ] as const) {
      expect((await write('season', seasonId, { action: 'state', state })).status).toBe(200);
    }
    expect(writes()).toEqual([]);
    // Reads no zone either: only a pause does.
    expect(statements.some((s) => s.table === 'user_settings')).toBe(false);
  });

  it.each([
    ['a state it does not know', { action: 'state', state: 'on' }],
    ['no state', { action: 'state' }],
    ['a null state', { action: 'state', state: null }],
    ['a key it does not take', { action: 'state', state: 'active', startsOn: TODAY }],
    ["a routine's intent", { action: 'pause', paused: true }],
  ])('is 400 invalid for %s, before any statement', async (_name, body) => {
    const res = await write('season', SEASON(1), body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid');
    expect(statements).toEqual([]);
  });
});

/** One update statement as lib/db.ts sends it: by id and user, or (updateProject) by id alone. */
const updateOf = (table: string, rowId: string, payload: Row, byUser = true): Statement => ({
  table,
  op: 'update',
  columns: undefined,
  payload,
  filters: byUser
    ? [
        ['eq', 'id', rowId],
        ['eq', 'user_id', USER],
      ]
    : [['eq', 'id', rowId]],
});

const itemProject = (n: number) => tables.items.find((r) => r.id === ITEM(n))!.project;

describe("a routine's usual time and note (O8b)", () => {
  it.each([
    ['sets a usual time', { action: 'usualTime', usualTime: '07:15' }, { usual_time: '07:15' }],
    ['clears it with null', { action: 'usualTime', usualTime: null }, { usual_time: null }],
    ['writes a note trimmed', { action: 'notes', notes: '  Lights out by ten.\n' }, { notes: 'Lights out by ten.' }],
    ['clears the note with null', { action: 'notes', notes: null }, { notes: null }],
    ['clears the note when it trims to nothing', { action: 'notes', notes: ' \n\t ' }, { notes: null }],
  ])('%s: that column and nothing else', async (_name, body, payload) => {
    const res = await write('routine', ROUTINE(3), body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(statements[0]).toEqual(liveRead('routines', ROUTINE(3)));
    expect(writes()).toEqual([updateOf('routines', ROUTINE(3), payload)]);
    // A field write never touches the pause, and reads no zone.
    expect(row('routines', ROUTINE(3))).toMatchObject({ paused_at: '2026-10-20T13:00:00+00:00', paused_until: '2026-10-30' });
    expect(statements.some((s) => s.table === 'user_settings')).toBe(false);
  });

  it('writes the time it already has again: a retry is harmless', async () => {
    expect((await write('routine', ROUTINE(1), { action: 'usualTime', usualTime: '21:30' })).status).toBe(200);
    expect((await write('routine', ROUTINE(1), { action: 'usualTime', usualTime: '21:30' })).status).toBe(200);
    expect(writes().map((w) => w.payload)).toEqual([{ usual_time: '21:30' }, { usual_time: '21:30' }]);
  });

  it.each([
    ['a time that is not HH:mm', { action: 'usualTime', usualTime: '7:15' }],
    ['a time past the day', { action: 'usualTime', usualTime: '24:00' }],
    ['no time key', { action: 'usualTime' }],
    ['a zone, which only a pause takes', { action: 'usualTime', usualTime: '07:00', timeZone: 'UTC' }],
    ['a why, which only a goal has', { action: 'why', why: 'x' }],
  ])('is 400 for %s, before any statement', async (_name, body) => {
    expect((await write('routine', ROUTINE(1), body)).status).toBe(400);
    expect(statements).toEqual([]);
  });
});

describe("a season's runs and note (O8b)", () => {
  it.each([
    ['moves both ends', { startsOn: '2026-11-01', endsOn: '2027-02-28' }, { starts_on: '2026-11-01', ends_on: '2027-02-28' }],
    ['clears the end', { startsOn: '2026-09-01', endsOn: null }, { starts_on: '2026-09-01', ends_on: null }],
    ['clears the start', { startsOn: null, endsOn: '2026-11-30' }, { starts_on: null, ends_on: '2026-11-30' }],
    ['clears both', { startsOn: null, endsOn: null }, { starts_on: null, ends_on: null }],
    ['takes a one-day run', { startsOn: '2026-12-25', endsOn: '2026-12-25' }, { starts_on: '2026-12-25', ends_on: '2026-12-25' }],
  ])('%s: both columns together, and nothing else', async (_name, range, payload) => {
    const res = await write('season', SEASON(1), { action: 'dates', ...range });
    expect(res.status).toBe(200);
    expect(writes()).toEqual([updateOf('seasons', SEASON(1), payload)]);
    expect(row('seasons', SEASON(1)).state).toBe('auto');
  });

  it('gives a season switched off its dates without switching it', async () => {
    expect((await write('season', SEASON(2), { action: 'dates', startsOn: '2026-12-01', endsOn: '2027-01-31' })).status).toBe(200);
    expect(row('seasons', SEASON(2))).toMatchObject({ state: 'paused', starts_on: '2026-12-01', ends_on: '2027-01-31' });
  });

  it('refuses runs that end before they start: 400, nothing read', async () => {
    const res = await write('season', SEASON(1), { action: 'dates', startsOn: '2026-12-01', endsOn: '2026-11-30' });
    expect(res.status).toBe(400);
    expect(statements).toEqual([]);
  });

  it.each([
    ['one end left out', { action: 'dates', startsOn: '2026-12-01' }],
    ['a day not on the calendar', { action: 'dates', startsOn: '2026-02-30', endsOn: null }],
    ['a state riding along', { action: 'dates', startsOn: null, endsOn: null, state: 'auto' }],
    ['a goal’s window', { action: 'window', startsOn: null, targetOn: null }],
  ])('is 400 for %s', async (_name, body) => {
    expect((await write('season', SEASON(1), body)).status).toBe(400);
    expect(statements).toEqual([]);
  });

  it('writes its note trimmed, and clears it', async () => {
    await write('season', SEASON(1), { action: 'notes', notes: ' Leaves, soup. ' });
    await write('season', SEASON(1), { action: 'notes', notes: null });
    expect(writes().map((w) => w.payload)).toEqual([{ notes: 'Leaves, soup.' }, { notes: null }]);
  });
});

describe("a goal's state, window and why (O8b)", () => {
  it('achieves a goal: the state and a stamp at now, nothing else', async () => {
    const res = await write('goal', GOAL(1), { action: 'state', state: 'achieved' });
    expect(res.status).toBe(200);
    expect(statements[0]).toEqual(liveRead('goals', GOAL(1)));
    expect(writes()).toEqual([updateOf('goals', GOAL(1), { state: 'achieved', achieved_at: NOW })]);
    // A goal's state touches no membership.
    expect(statements.some((s) => s.table === 'goal_items')).toBe(false);
  });

  it('a goal achieved twice keeps its first achievedAt', async () => {
    expect((await write('goal', GOAL(1), { action: 'state', state: 'achieved' })).status).toBe(200);
    vi.setSystemTime(new Date('2026-10-23T17:00:05.000Z'));
    expect((await write('goal', GOAL(1), { action: 'state', state: 'achieved' })).status).toBe(200);
    expect(writes()).toHaveLength(1);
    expect(row('goals', GOAL(1))).toMatchObject({ state: 'achieved', achieved_at: NOW });

    // One achieved a week ago keeps that stamp too.
    expect((await write('goal', GOAL(2), { action: 'state', state: 'achieved' })).status).toBe(200);
    expect(writes()).toHaveLength(1);
    expect(row('goals', GOAL(2)).achieved_at).toBe(ACHIEVED);
  });

  it('reopening clears the stamp; setting aside keeps it', async () => {
    await write('goal', GOAL(2), { action: 'state', state: 'abandoned' });
    expect(writes().map((w) => w.payload)).toEqual([{ state: 'abandoned' }]);
    expect(row('goals', GOAL(2))).toMatchObject({ state: 'abandoned', achieved_at: ACHIEVED });

    await write('goal', GOAL(2), { action: 'state', state: 'active' });
    expect(writes().map((w) => w.payload)[1]).toEqual({ state: 'active', achieved_at: null });
    expect(row('goals', GOAL(2))).toMatchObject({ state: 'active', achieved_at: null });
  });

  it('the state it already has writes nothing', async () => {
    expect((await write('goal', GOAL(1), { action: 'state', state: 'active' })).status).toBe(200);
    expect(writes()).toEqual([]);
  });

  it.each([
    ['moves both ends', { startsOn: '2026-10-01', targetOn: '2027-04-30' }, { starts_on: '2026-10-01', target_on: '2027-04-30' }],
    ['drops the target', { startsOn: '2026-09-01', targetOn: null }, { starts_on: '2026-09-01', target_on: null }],
    ['clears both', { startsOn: null, targetOn: null }, { starts_on: null, target_on: null }],
    ['takes a target on its first day', { startsOn: '2026-10-23', targetOn: '2026-10-23' }, { starts_on: '2026-10-23', target_on: '2026-10-23' }],
  ])('a window that %s: both columns together, and nothing else', async (_name, range, payload) => {
    expect((await write('goal', GOAL(1), { action: 'window', ...range })).status).toBe(200);
    expect(writes()).toEqual([updateOf('goals', GOAL(1), payload)]);
  });

  it('refuses a window that closes before it opens: 400, nothing read', async () => {
    const res = await write('goal', GOAL(1), { action: 'window', startsOn: '2026-10-23', targetOn: '2026-10-22' });
    expect(res.status).toBe(400);
    expect(statements).toEqual([]);
  });

  it('writes the why trimmed, and clears it blank or null', async () => {
    await write('goal', GOAL(1), { action: 'why', why: '  For the race in March. ' });
    await write('goal', GOAL(1), { action: 'why', why: '   ' });
    await write('goal', GOAL(1), { action: 'why', why: null });
    expect(writes().map((w) => w.payload)).toEqual([{ why: 'For the race in March.' }, { why: null }, { why: null }]);
  });

  it.each([
    ['a state it does not know', { action: 'state', state: 'paused' }],
    ['a stamp the server would make', { action: 'state', state: 'achieved', achievedAt: NOW }],
    ['notes, which a goal does not have', { action: 'notes', notes: 'x' }],
    ['a season’s runs', { action: 'dates', startsOn: null, endsOn: null }],
  ])('is 400 for %s', async (_name, body) => {
    expect((await write('goal', GOAL(1), body)).status).toBe(400);
    expect(statements).toEqual([]);
  });
});

describe("a project's note (O8b)", () => {
  it('writes it trimmed, by id after the live read, and clears it', async () => {
    expect((await write('project', PROJECT(2), { action: 'notes', notes: 'Repairs.\n' })).status).toBe(200);
    expect((await write('project', PROJECT(2), { action: 'notes', notes: ' ' })).status).toBe(200);
    expect(writes()).toEqual([
      updateOf('projects', PROJECT(2), { notes: 'Repairs.' }, false),
      updateOf('projects', PROJECT(2), { notes: null }, false),
    ]);
    expect(row('projects', PROJECT(2)).notes).toBeNull();
    expect(h.notifyPlugins).not.toHaveBeenCalled();
  });
});

describe('rename, icon and colour (O9)', () => {
  it.each([
    ['routine', 'routines', ROUTINE(1)],
    ['season', 'seasons', SEASON(1)],
    ['goal', 'goals', GOAL(1)],
  ] as const)('a %s: each writes its own column, and nothing else', async (kind, table, rowId) => {
    for (const body of [
      { action: 'rename', name: '  Renamed  ' },
      { action: 'icon', icon: 'icon:Moon' },
      { action: 'color', color: 'var(--accent-8)' },
      { action: 'color', color: null },
    ]) {
      expect((await write(kind, rowId, body)).status).toBe(200);
    }
    expect(writes()).toEqual([
      updateOf(table, rowId, { name: 'Renamed' }),
      updateOf(table, rowId, { icon: 'icon:Moon' }),
      updateOf(table, rowId, { color: 'var(--accent-8)' }),
      updateOf(table, rowId, { color: null }),
    ]);
    expect(row(table, rowId)).toMatchObject({ name: 'Renamed', icon: 'icon:Moon', color: null });
    // No name rule but a project's, and no member is touched.
    expect(statements.filter((s) => s.table !== table)).toEqual([]);
  });

  it('a routine may take a name another routine has: only projects fold names together', async () => {
    expect((await write('routine', ROUTINE(1), { action: 'rename', name: 'Evening' })).status).toBe(200);
    expect(row('routines', ROUTINE(1)).name).toBe('Evening');
  });

  it("a project's glyph is its emoji column, and its colour clears to the name hash", async () => {
    await write('project', PROJECT(2), { action: 'icon', icon: 'icon:Hammer' });
    await write('project', PROJECT(2), { action: 'color', color: 'var(--accent-6)' });
    await write('project', PROJECT(2), { action: 'color', color: null });
    expect(writes()).toEqual([
      updateOf('projects', PROJECT(2), { emoji: 'icon:Hammer' }, false),
      updateOf('projects', PROJECT(2), { color: 'var(--accent-6)' }, false),
      updateOf('projects', PROJECT(2), { color: null }, false),
    ]);
    // Neither touches a member.
    expect(itemProject(1)).toBe('Home');
  });
});

describe('a project rename (O9)', () => {
  const clashRead: Statement = {
    table: 'projects',
    op: 'select',
    columns: '*',
    payload: undefined,
    filters: [
      ['eq', 'user_id', USER],
      ['is', 'deleted_at', null],
    ],
  };
  const refile = (name: string): Statement => ({
    table: 'items',
    op: 'update',
    columns: undefined,
    payload: { project: name },
    filters: [
      ['eq', 'user_id', USER],
      ['eq', 'project_id', PROJECT(2)],
    ],
  });

  it('checks for a clash, renames the row, then re-files its members, in that order', async () => {
    const res = await write('project', PROJECT(2), { action: 'rename', name: ' House ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(statements).toEqual([
      liveRead('projects', PROJECT(2)),
      clashRead,
      updateOf('projects', PROJECT(2), { name: 'House' }, false),
      refile('House'),
    ]);
  });

  it('re-files its members by project_id only: a drifted name follows, a trashed member follows, a stranger does not', async () => {
    await write('project', PROJECT(2), { action: 'rename', name: 'House' });
    expect(row('projects', PROJECT(2)).name).toBe('House');
    expect(itemProject(1)).toBe('House');
    // Its text had drifted to "home"; the id is what a member is.
    expect(itemProject(2)).toBe('House');
    // In the Trash, and comes back holding the current name.
    expect(itemProject(3)).toBe('House');
    // Says "Home" with no id: not a member.
    expect(itemProject(4)).toBe('Home');
    expect(itemProject(5)).toBe('Work');
    // Another user's row under the same id is never reached.
    expect(tables.items.find((r) => r.id === ITEM(6))!.project).toBe('Home');
  });

  it('takes its own name in another case, and re-files to it', async () => {
    expect((await write('project', PROJECT(2), { action: 'rename', name: 'home' })).status).toBe(200);
    expect(row('projects', PROJECT(2)).name).toBe('home');
    expect(itemProject(1)).toBe('home');
  });

  it('refuses a live project’s name in any case: 409 name_taken, that project named, nothing written', async () => {
    for (const name of ['Work', 'WORK', ' work ']) {
      const res = await write('project', PROJECT(2), { action: 'rename', name });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'name_taken', project: { id: PROJECT(1), name: 'Work' } });
    }
    expect(writes()).toEqual([]);
    expect(tables).toEqual(world());
  });

  it('refuses the exact name a project in the Trash holds: 409 name_in_trash, and no member moves', async () => {
    const res = await write('project', PROJECT(2), { action: 'rename', name: 'Errands' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'name_in_trash' });
    // The update was tried and refused by the index, the clash read again to
    // tell the bin's holder from a live one, and the fan-out never ran.
    expect(statements.map((s) => `${s.op} ${s.table}`)).toEqual([
      'select projects',
      'select projects',
      'update projects',
      'select projects',
    ]);
    expect(tables).toEqual(world());
  });

  it('a live project that takes the exact name after the clash read is name_taken, never the Trash’s sentence', async () => {
    // Another device makes "House" between this rename's clash read and its update.
    beforeUpdate = (table) => {
      beforeUpdate = null;
      if (table === 'projects') tables.projects.push(projectRow(9, 'House', { created_at: NOW }));
    };
    const res = await write('project', PROJECT(2), { action: 'rename', name: 'House' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'name_taken', project: { id: PROJECT(9), name: 'House' } });
    expect(statements).toEqual([
      liveRead('projects', PROJECT(2)),
      clashRead,
      updateOf('projects', PROJECT(2), { name: 'House' }, false),
      clashRead,
    ]);
    expect(row('projects', PROJECT(2)).name).toBe('Home');
    expect(itemProject(1)).toBe('Home');
  });

  it('a trashed name in another case is no clash: the index is exact-case, and the Trash is not live', async () => {
    // Restoring "Errands" later is what refuses it (the restore's name_taken).
    expect((await write('project', PROJECT(2), { action: 'rename', name: 'errands' })).status).toBe(200);
    expect(row('projects', PROJECT(2)).name).toBe('errands');
  });

  it('another user’s project with the name is no clash', async () => {
    expect((await write('project', PROJECT(2), { action: 'rename', name: 'Garden' })).status).toBe(200);
    expect(row('projects', PROJECT(2)).name).toBe('Garden');
  });

  it('a failed fan-out puts the old name back before the 500, so nothing is split', async () => {
    failing = { table: 'items', op: 'update' };
    const res = await write('project', PROJECT(2), { action: 'rename', name: 'House' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'failed' });
    // The phone never re-sends a failed write, so the route undoes step 2
    // itself: the answer then matches the phone's revert.
    expect(writes()).toEqual([
      updateOf('projects', PROJECT(2), { name: 'House' }, false),
      refile('House'),
      updateOf('projects', PROJECT(2), { name: 'Home' }, false),
    ]);
    expect(tables).toEqual(world());
    expect(h.notifyPlugins).not.toHaveBeenCalled();
  });

  it('when putting the name back fails too, the fan-out’s 500 stands, and a later rename heals the split', async () => {
    let projectUpdates = 0;
    const base = h.createClient.getMockImplementation()!;
    h.createClient.mockImplementation(() => {
      const db = base() as ReturnType<typeof database>;
      const from = db.from;
      db.from = (table: string) => {
        const t = from(table);
        if (table !== 'projects') return t;
        return {
          ...t,
          update: (payload: Row) => {
            projectUpdates += 1;
            // The second update of projects is the name going back.
            if (projectUpdates === 2) failing = { table: 'projects', op: 'update' };
            return t.update(payload);
          },
        };
      };
      return db;
    });
    failing = { table: 'items', op: 'update' };
    const first = await write('project', PROJECT(2), { action: 'rename', name: 'House' });
    expect(first.status).toBe(500);
    expect(await first.json()).toEqual({ error: 'failed' });
    // Best effort only: the row kept the new name, the members the old.
    expect(row('projects', PROJECT(2)).name).toBe('House');
    expect(itemProject(1)).toBe('Home');

    // Any later rename re-files by project_id, even to the name the row has.
    h.createClient.mockImplementation(base);
    failing = null;
    statements = [];
    const again = await write('project', PROJECT(2), { action: 'rename', name: 'House' });
    expect(again.status).toBe(200);
    expect(writes()).toEqual([updateOf('projects', PROJECT(2), { name: 'House' }, false), refile('House')]);
    expect([itemProject(1), itemProject(2), itemProject(3)]).toEqual(['House', 'House', 'House']);
  });

  it('a failed clash read is a bare 500, and nothing is written', async () => {
    let reads = 0;
    const base = h.createClient.getMockImplementation()!;
    h.createClient.mockImplementation(() => {
      const db = base() as ReturnType<typeof database>;
      const from = db.from;
      db.from = (table: string) => {
        const t = from(table);
        if (table !== 'projects') return t;
        return {
          ...t,
          select: (columns?: string) => {
            reads += 1;
            // The second read of projects is the clash check.
            if (reads === 2) failing = { table: 'projects', op: 'select' };
            return t.select(columns);
          },
        };
      };
      return db;
    });
    const res = await write('project', PROJECT(2), { action: 'rename', name: 'House' });
    expect(res.status).toBe(500);
    expect(writes()).toEqual([]);
  });
});

describe('what is not a container of the caller’s: 404, nothing written', () => {
  it.each([
    ['an unknown kind', 'habit', ROUTINE(1)],
    ['a plural', 'routines', ROUTINE(1)],
    ['a kind in capitals', 'Routine', ROUTINE(1)],
    ['an item', 'item', ROUTINE(1)],
    ['a sample id', 'routine', 'sample-morning-routine'],
    ['an id with a tail', 'routine', `${ROUTINE(1)}x`],
  ])('%s is 404 before the body is read or any statement runs', async (_name, kind, rowId) => {
    const res = await write(kind, rowId, '{not json');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(statements).toEqual([]);
  });

  it.each([
    ['a routine in the Trash', 'routine', ROUTINE(5), { action: 'pause', paused: true }, 'routines'],
    ['another user’s routine', 'routine', ROUTINE(6), { action: 'pause', paused: true }, 'routines'],
    ['no routine at all', 'routine', ROUTINE(9), { action: 'pause', paused: true }, 'routines'],
    ['a season in the Trash', 'season', SEASON(4), { action: 'state', state: 'paused' }, 'seasons'],
    ['another user’s season', 'season', SEASON(5), { action: 'state', state: 'paused' }, 'seasons'],
    ['a season’s id asked as a routine', 'routine', SEASON(1), { action: 'pause', paused: true }, 'routines'],
    ['a routine in the Trash, renamed', 'routine', ROUTINE(5), { action: 'rename', name: 'Back' }, 'routines'],
    ['a season in the Trash, given runs', 'season', SEASON(4), { action: 'dates', startsOn: null, endsOn: null }, 'seasons'],
    ['a goal in the Trash', 'goal', GOAL(3), { action: 'state', state: 'achieved' }, 'goals'],
    ['another user’s goal', 'goal', GOAL(4), { action: 'why', why: 'Mine now.' }, 'goals'],
    ['no goal at all', 'goal', GOAL(9), { action: 'rename', name: 'X' }, 'goals'],
    ['a project in the Trash, given a note', 'project', PROJECT(3), { action: 'notes', notes: 'Back?' }, 'projects'],
    ['a project in the Trash, renamed', 'project', PROJECT(3), { action: 'rename', name: 'Chores' }, 'projects'],
    ['another user’s project', 'project', PROJECT(4), { action: 'color', color: 'var(--accent-2)' }, 'projects'],
    ['a goal’s id asked as a project', 'project', GOAL(1), { action: 'color', color: null }, 'projects'],
  ])('%s is 404 after one read, and nothing is written', async (_name, kind, rowId, body, table) => {
    const res = await write(kind, rowId, body);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(statements).toEqual([liveRead(table, rowId)]);
    expect(tables).toEqual(world());
  });

  it('takes an uppercase id as the same row', async () => {
    const res = await write('routine', ROUTINE(1).toUpperCase(), { action: 'pause', paused: true });
    expect(res.status).toBe(200);
    expect(row('routines', ROUTINE(1)).paused_at).toBe(NOW);
    expect(statements[0].filters).toContainEqual(['eq', 'id', ROUTINE(1)]);
  });
});

describe('every other body is 400', () => {
  it.each([
    ['not JSON', '{nope'],
    ['an array', [{ action: 'pause', paused: true }]],
    ['no action', { paused: true }],
    ['a create, which is its own route', { action: 'create', id: ROUTINE(9), name: 'Desk' }],
    ['an action no kind takes', { action: 'archive' }],
    ['an empty object', {}],
  ])('a routine given %s', async (_name, body) => {
    const res = await write('routine', ROUTINE(1), body);
    expect(res.status).toBe(400);
    expect(statements).toEqual([]);
  });

  it.each([
    ['goal', GOAL(1)],
    ['project', PROJECT(2)],
  ])('a %s given no intent, or another kind’s, is 400, and nothing is read', async (kind, rowId) => {
    for (const body of [
      {},
      { action: 'pause', paused: true },
      { action: 'dates', startsOn: null, endsOn: null },
      { action: 'usualTime', usualTime: '07:00' },
    ]) {
      const res = await write(kind, rowId, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid');
    }
    expect(statements).toEqual([]);
  });

  it.each([
    ['routine', ROUTINE(1)],
    ['season', SEASON(1)],
    ['goal', GOAL(1)],
    ['project', PROJECT(2)],
  ])('a %s’s glyph is never cleared: a null icon is 400', async (kind, rowId) => {
    const res = await write(kind, rowId, { action: 'icon', icon: null });
    expect(res.status).toBe(400);
    expect(statements).toEqual([]);
  });

  it.each([
    ['a blank name', { action: 'rename', name: '  ' }],
    ['a name past the bound', { action: 'rename', name: 'x'.repeat(10_001) }],
    ['an icon that is not a token', { action: 'icon', icon: 'Moon' }],
    ['a colour that is not a ramp token', { action: 'color', color: 'red' }],
    ['a ninth ramp step', { action: 'color', color: 'var(--accent-9)' }],
    ['notes past the bound', { action: 'notes', notes: 'x'.repeat(200_001) }],
    ['a note that is not text', { action: 'notes', notes: 3 }],
  ])('%s is 400, before any statement', async (_name, body) => {
    const res = await write('routine', ROUTINE(1), body);
    expect(res.status).toBe(400);
    expect(statements).toEqual([]);
  });
});

describe('who it answers to', () => {
  it('takes a pause and a season switch with Organize off, and never reads the switches', async () => {
    // Paused's Resume is the web's one ungated way back; a gate here would refuse it.
    expect((await write('routine', ROUTINE(2), { action: 'pause', paused: false })).status).toBe(200);
    expect((await write('season', SEASON(2), { action: 'state', state: 'auto' })).status).toBe(200);
    expect(writes()).toHaveLength(2);
    expect(statements.some((s) => s.table === 'user_extensions')).toBe(false);
  });

  it('takes every other field with Organize and Goals off, and never reads the switches', async () => {
    expect((await write('routine', ROUTINE(1), { action: 'usualTime', usualTime: '07:00' })).status).toBe(200);
    expect((await write('season', SEASON(1), { action: 'notes', notes: 'Soup.' })).status).toBe(200);
    expect((await write('goal', GOAL(1), { action: 'state', state: 'achieved' })).status).toBe(200);
    expect((await write('project', PROJECT(2), { action: 'rename', name: 'House' })).status).toBe(200);
    expect(statements.some((s) => s.table === 'user_extensions')).toBe(false);
  });

  it('fires no webhook, writes no item_events, and never builds the service client', async () => {
    await write('routine', ROUTINE(1), { action: 'pause', paused: true });
    await write('season', SEASON(1), { action: 'state', state: 'paused' });
    expect(writes()).toHaveLength(2);
    expect(h.notifyPlugins).not.toHaveBeenCalled();
    expect(h.createServiceClient).not.toHaveBeenCalled();
    expect(statements.some((s) => s.table === 'item_events')).toBe(false);
    // Only the container rows themselves are written: no member row, no item.
    expect(new Set(writes().map((w) => w.table))).toEqual(new Set(['routines', 'seasons']));
  });

  it('fires no webhook for any project write, though the server holds the service key', async () => {
    // lib/db.ts's project functions announce to plugins unless told not to,
    // and on a server notifyPlugins has the key it lacks in a browser.
    for (const body of [
      { action: 'notes', notes: 'Repairs.' },
      { action: 'rename', name: 'House' },
      { action: 'icon', icon: 'icon:Hammer' },
      { action: 'color', color: 'var(--accent-6)' },
      { action: 'color', color: null },
    ]) {
      expect((await write('project', PROJECT(2), body)).status).toBe(200);
    }
    expect(writes().filter((w) => w.table === 'projects')).toHaveLength(5);
    expect(h.notifyPlugins).not.toHaveBeenCalled();
    expect(h.createServiceClient).not.toHaveBeenCalled();
    expect(statements.some((s) => s.table === 'item_events')).toBe(false);
  });

  it('is 401 with no bearer, or a token that is not one, and reads nothing', async () => {
    expect((await write('routine', ROUTINE(1), { action: 'pause', paused: true }, null)).status).toBe(401);
    expect((await write('routine', ROUTINE(1), { action: 'pause', paused: true }, 'Bearer nope')).status).toBe(401);
    expect(statements).toEqual([]);
  });

  it('answers a failed read, zone read or write with a bare 500', async () => {
    failing = { table: 'routines', op: 'select' };
    let res = await write('routine', ROUTINE(1), { action: 'pause', paused: true });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'failed' });

    failing = { table: 'user_settings' };
    res = await write('routine', ROUTINE(1), { action: 'pause', paused: true });
    expect(res.status).toBe(500);
    expect(writes()).toEqual([]);

    failing = { table: 'seasons', op: 'update' };
    res = await write('season', SEASON(1), { action: 'state', state: 'paused' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'failed' });

    failing = { table: 'goals', op: 'select' };
    res = await write('goal', GOAL(1), { action: 'state', state: 'achieved' });
    expect(res.status).toBe(500);

    failing = { table: 'goals', op: 'update' };
    res = await write('goal', GOAL(1), { action: 'why', why: 'x' });
    expect(res.status).toBe(500);

    failing = { table: 'projects', op: 'update' };
    res = await write('project', PROJECT(2), { action: 'notes', notes: 'x' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'failed' });
  });
});

describe('what the payload says the phone may send', () => {
  it('lists each kind’s intents, read off its union', () => {
    expect(CONTAINER_WRITES).toEqual({
      routine: ['pause', 'usualTime', 'notes', 'rename', 'icon', 'color', 'delete', 'create'],
      season: ['state', 'dates', 'notes', 'rename', 'icon', 'color', 'delete', 'create'],
      goal: ['state', 'window', 'why', 'rename', 'icon', 'color', 'delete', 'create'],
      project: ['notes', 'rename', 'icon', 'color', 'delete', 'create'],
    });
  });

  it('lists `create` for exactly the kinds the create route takes, after the intents', () => {
    expect(CONTAINER_CREATE_SCHEMAS).toEqual({
      routine: RoutineCreateSchema,
      season: SeasonCreateSchema,
      goal: GoalCreateSchema,
      project: ProjectCreateSchema,
    });
    for (const [kind, actions] of Object.entries(CONTAINER_WRITES)) {
      expect(actions.at(-1), kind).toBe('create');
      expect(actions.indexOf('create'), kind).toBe(actions.length - 1);
      expect(actions.filter((a) => a === 'create'), kind).toHaveLength(1);
    }
  });

  it('hands the payload fresh lists, so nothing downstream can grow the constant', () => {
    const copy = containerWrites();
    expect(copy).toEqual(CONTAINER_WRITES);
    copy.routine.push('moveMember');
    copy.project.push('moveMember');
    expect(CONTAINER_WRITES.routine).not.toContain('moveMember');
    expect(CONTAINER_WRITES.project).not.toContain('moveMember');
  });

  it('parses each kind’s body with that kind’s schema', () => {
    expect(CONTAINER_WRITE_SCHEMAS).toEqual({
      routine: RoutineWriteSchema,
      season: SeasonWriteSchema,
      goal: GoalWriteSchema,
      project: ProjectWriteSchema,
    });
  });

  it('takes exactly the keys of each intent', () => {
    expect(RoutineWriteSchema.safeParse({ action: 'pause', paused: true, pausedUntil: '2026-10-30', timeZone: 'UTC' }).success).toBe(true);
    expect(RoutineWriteSchema.safeParse({ action: 'pause', paused: true, extra: 1 }).success).toBe(false);
    expect(SeasonWriteSchema.safeParse({ action: 'state', state: 'auto' }).success).toBe(true);
    expect(SeasonWriteSchema.safeParse({ action: 'state', state: 'auto', updatedAt: NOW }).success).toBe(false);
    expect(RoutineWriteSchema.safeParse({ action: 'usualTime', usualTime: '07:00', timeZone: 'UTC' }).success).toBe(false);
    expect(SeasonWriteSchema.safeParse({ action: 'dates', startsOn: null, endsOn: null, state: 'auto' }).success).toBe(false);
    expect(GoalWriteSchema.safeParse({ action: 'state', state: 'achieved', achievedAt: NOW }).success).toBe(false);
    expect(GoalWriteSchema.safeParse({ action: 'window', startsOn: null, targetOn: null, endsOn: null }).success).toBe(false);
    expect(ProjectWriteSchema.safeParse({ action: 'rename', name: 'House', emoji: 'icon:House' }).success).toBe(false);
    expect(ProjectWriteSchema.safeParse({ action: 'notes', notes: 'x', color: null }).success).toBe(false);
    for (const schema of [RoutineWriteSchema, SeasonWriteSchema, GoalWriteSchema, ProjectWriteSchema]) {
      expect(schema.safeParse({ action: 'delete' }).success).toBe(true);
      expect(schema.safeParse({ action: 'delete', permanent: true }).success).toBe(false);
    }
    expect(GoalCreateSchema.safeParse({ id: GOAL(9), name: 'Run', startsOn: TODAY }).success).toBe(true);
    expect(RoutineCreateSchema.safeParse({ id: ROUTINE(9), name: 'Desk', startsOn: TODAY }).success).toBe(false);
    expect(ProjectCreateSchema.safeParse({ id: PROJECT(9), name: 'Desk', emoji: '' }).success).toBe(false);
    expect(SeasonCreateSchema.safeParse({ id: SEASON(9), name: 'Autumn', state: 'auto' }).success).toBe(false);
  });
});

describe('containerIntentPatch: the rule the route and the phone share', () => {
  const ctx = { now: new Date(NOW), timeZone: 'America/New_York' };
  const routine = { id: 'r', name: 'R', itemIds: [] };
  const season = { id: 's', name: 'S', state: 'auto' as const, itemIds: [], routineIds: [] };

  it('a pause with no return day clears the stored one: the key is present, its value undefined', () => {
    const result = containerIntentPatch(
      { kind: 'routine', container: { ...routine, pausedAt: '2026-10-01T13:00:00Z', pausedUntil: '2026-10-10' }, intent: { action: 'pause', paused: true } },
      ctx,
    );
    expect(result).toEqual({ patch: { pausedAt: NOW, pausedUntil: undefined } });
    expect('pausedUntil' in (result as { patch: object }).patch).toBe(true);
  });

  it('never reads the members: a container with members answers as one with none', () => {
    const intent = { action: 'state', state: 'paused' } as const;
    expect(containerIntentPatch({ kind: 'season', container: { ...season, itemIds: ['a'], routineIds: ['r'] }, intent }, ctx)).toEqual(
      containerIntentPatch({ kind: 'season', container: season, intent }, ctx),
    );
  });

  it('refuses with a code and a status, never a sentence', () => {
    expect(
      containerIntentPatch({ kind: 'routine', container: routine, intent: { action: 'pause', paused: true, pausedUntil: TODAY } }, ctx),
    ).toEqual({ refused: 'pause_refused', status: 409 });
  });
});

/** The delete's one read: by id and user, whatever the row's deleted_at. */
const deleteRead = (table: string, rowId: string): Statement => ({
  table,
  op: 'select',
  columns: 'id, deleted_at',
  payload: undefined,
  filters: [
    ['eq', 'id', rowId],
    ['eq', 'user_id', USER],
  ],
});

describe('a delete (O10)', () => {
  /** Join rows the delete must leave, so a restore brings the container back whole. */
  const joins = (): Record<string, Row[]> => ({
    routine_items: [{ user_id: USER, routine_id: ROUTINE(1), item_id: ITEM(1), position: 0 }],
    season_items: [{ user_id: USER, season_id: SEASON(1), item_id: ITEM(5) }],
    season_routines: [{ user_id: USER, season_id: SEASON(1), routine_id: ROUTINE(1) }],
    goal_items: [{ user_id: USER, goal_id: GOAL(1), item_id: ITEM(1), role: 'milestone' }],
  });
  beforeEach(() => Object.assign(tables, joins()));

  it.each([
    ['routine', 'routines', ROUTINE(1)],
    ['season', 'seasons', SEASON(1)],
    ['goal', 'goals', GOAL(1)],
  ])('a live %s: one read, then its deleted_at stamped by id and user, and nothing else', async (kind, table, rowId) => {
    const res = await write(kind, rowId, { action: 'delete' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(statements).toEqual([deleteRead(table, rowId), updateOf(table, rowId, { deleted_at: NOW })]);
    const after = world();
    Object.assign(after, joins());
    (after[table].find((r) => r.id === rowId) as Row).deleted_at = NOW;
    expect(tables).toEqual(after);
  });

  it('a live project: stamped by id, as deleteProject writes it, and its members keep their name and id', async () => {
    const res = await write('project', PROJECT(2), { action: 'delete' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(statements).toEqual([deleteRead('projects', PROJECT(2)), updateOf('projects', PROJECT(2), { deleted_at: NOW }, false)]);
    expect(row('projects', PROJECT(2)).deleted_at).toBe(NOW);
    // The web unfiles them in its session only; the rows are as they were.
    expect(tables.items).toEqual(world().items);
  });

  it.each([
    ['routine', 'routines', ROUTINE(5)],
    ['season', 'seasons', SEASON(4)],
    ['goal', 'goals', GOAL(3)],
    ['project', 'projects', PROJECT(3)],
  ])('a %s already in the Trash is 200 with no write, so its 30 days never restart', async (kind, table, rowId) => {
    const res = await write(kind, rowId, { action: 'delete' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(statements).toEqual([deleteRead(table, rowId)]);
    expect(row(table, rowId).deleted_at).toBe(STAMP);
  });

  it('a second send of one delete writes once: the retry finds it in the bin', async () => {
    expect((await write('season', SEASON(1), { action: 'delete' })).status).toBe(200);
    vi.setSystemTime(new Date('2026-10-23T17:05:00.000Z'));
    expect((await write('season', SEASON(1), { action: 'delete' })).status).toBe(200);
    expect(writes()).toHaveLength(1);
    expect(row('seasons', SEASON(1)).deleted_at).toBe(NOW);
  });

  it.each([
    ['another user’s routine', 'routine', 'routines', ROUTINE(6)],
    ['no routine at all', 'routine', 'routines', ROUTINE(9)],
    ['another user’s season', 'season', 'seasons', SEASON(5)],
    ['another user’s goal', 'goal', 'goals', GOAL(4)],
    ['another user’s project', 'project', 'projects', PROJECT(4)],
    ['a routine’s id asked as a project', 'project', 'projects', ROUTINE(1)],
  ])('%s is 404 after the one read, and nothing is written', async (_name, kind, table, rowId) => {
    const res = await write(kind, rowId, { action: 'delete' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(statements).toEqual([deleteRead(table, rowId)]);
    const after = world();
    Object.assign(after, joins());
    expect(tables).toEqual(after);
  });

  it('a field write after the delete is 404: a trashed container takes no edit', async () => {
    expect((await write('routine', ROUTINE(1), { action: 'delete' })).status).toBe(200);
    const res = await write('routine', ROUTINE(1), { action: 'rename', name: 'Mornings' });
    expect(res.status).toBe(404);
    expect(row('routines', ROUTINE(1)).name).toBe('Morning');
  });

  it('takes an uppercase id as the same row', async () => {
    const res = await write('goal', GOAL(1).toUpperCase(), { action: 'delete' });
    expect(res.status).toBe(200);
    expect(statements[0]).toEqual(deleteRead('goals', GOAL(1)));
    expect(row('goals', GOAL(1)).deleted_at).toBe(NOW);
  });

  it('a delete with any other key is 400, and nothing is read', async () => {
    for (const body of [{ action: 'delete', permanent: true }, { action: 'delete', id: ROUTINE(1) }, { action: 'delete', deletedAt: NOW }]) {
      const res = await write('routine', ROUTINE(1), body);
      expect(res.status).toBe(400);
    }
    expect(statements).toEqual([]);
  });

  it('deletes with Organize and Goals off, fires no webhook, writes no item_events, and never builds the service client', async () => {
    for (const [kind, rowId] of [
      ['routine', ROUTINE(1)],
      ['season', SEASON(1)],
      ['goal', GOAL(1)],
      ['project', PROJECT(2)],
    ] as const) {
      expect((await write(kind, rowId, { action: 'delete' })).status).toBe(200);
    }
    expect(writes()).toHaveLength(4);
    expect(statements.some((s) => s.table === 'user_extensions')).toBe(false);
    expect(statements.some((s) => s.table === 'item_events')).toBe(false);
    expect(new Set(statements.map((s) => s.table))).toEqual(new Set(['routines', 'seasons', 'goals', 'projects']));
    expect(h.notifyPlugins).not.toHaveBeenCalled();
    expect(h.createServiceClient).not.toHaveBeenCalled();
  });

  it('answers a failed read or a failed stamp with a bare 500', async () => {
    failing = { table: 'routines', op: 'select' };
    let res = await write('routine', ROUTINE(1), { action: 'delete' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'failed' });
    expect(writes()).toEqual([]);

    failing = { table: 'projects', op: 'update' };
    res = await write('project', PROJECT(2), { action: 'delete' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'failed' });
    expect(row('projects', PROJECT(2)).deleted_at).toBeNull();
  });
});

/** A new container's id, as the phone mints one. */
const NEW = (n: number) => id('cccccccc', n);

/** The create's id read: by id and user, whatever the row's deleted_at. */
const idRead = (table: string, rowId: string): Statement => ({
  table,
  op: 'select',
  columns: 'id',
  payload: undefined,
  filters: [
    ['eq', 'id', rowId],
    ['eq', 'user_id', USER],
  ],
});
/** findLiveProjectByName: every live project of the caller's, folded here. */
const clashRead: Statement = {
  table: 'projects',
  op: 'select',
  columns: '*',
  payload: undefined,
  filters: [
    ['eq', 'user_id', USER],
    ['is', 'deleted_at', null],
  ],
};
const insertOf = (table: string, payload: Row): Statement => ({ table, op: 'insert', columns: undefined, payload, filters: [] });

/** Each kind's insert, as lib/db.ts's create writes a container made with nothing but a name and a glyph. */
const inserted = {
  routine: (rowId: string, name: string, icon: string | null): Row => ({
    id: rowId,
    user_id: USER,
    name,
    icon,
    color: null,
    paused_at: null,
    paused_until: null,
    sort_order: null,
  }),
  season: (rowId: string, name: string, icon: string | null): Row => ({
    id: rowId,
    user_id: USER,
    name,
    icon,
    color: null,
    state: 'auto',
    starts_on: null,
    ends_on: null,
    sort_order: null,
  }),
  goal: (rowId: string, name: string, icon: string | null, startsOn: string | null): Row => ({
    id: rowId,
    user_id: USER,
    name,
    why: null,
    icon,
    color: null,
    state: 'active',
    starts_on: startsOn,
    target_on: null,
    achieved_at: null,
    sort_order: null,
  }),
  project: (rowId: string, name: string, emoji: string): Row => ({
    id: rowId,
    user_id: USER,
    name,
    emoji,
    color: null,
    repeat_frequency: null,
    repeat_days: null,
    repeat_month_day: null,
    time_bucket: null,
    start_time: null,
    duration: null,
  }),
};

describe('a create (O11)', () => {
  it('a routine: the id read, then the insert, and it reads back as containerCreateRecord made it', async () => {
    const body = { id: NEW(1), name: 'Evening wind-down', icon: 'icon:Repeat' };
    const res = await create('routine', body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: NEW(1) });
    expect(statements).toEqual([idRead('routines', NEW(1)), insertOf('routines', inserted.routine(NEW(1), 'Evening wind-down', 'icon:Repeat'))]);
    expect(JSON.parse(JSON.stringify(routineFromRow(row('routines', NEW(1)) as unknown as RoutineRow, [])))).toEqual(
      JSON.parse(JSON.stringify(containerCreateRecord({ kind: 'routine', body }).container)),
    );
  });

  it('a season: `auto` with no dates, so it is always on and hides nothing', async () => {
    const res = await create('season', { id: NEW(2), name: 'Autumn', icon: 'icon:CalendarRange' });
    expect(res.status).toBe(200);
    expect(statements).toEqual([idRead('seasons', NEW(2)), insertOf('seasons', inserted.season(NEW(2), 'Autumn', 'icon:CalendarRange'))]);
    const back = seasonFromRow(row('seasons', NEW(2)) as unknown as SeasonRow, [], []);
    expect(back.state).toBe('auto');
    expect(back.startsOn).toBeUndefined();
    expect(back.endsOn).toBeUndefined();
  });

  it('a goal: active, its window opening on the first day sent, and on none when none is sent', async () => {
    let res = await create('goal', { id: NEW(3), name: 'Run a half', icon: 'icon:Target', startsOn: TODAY });
    expect(res.status).toBe(200);
    res = await create('goal', { id: NEW(4), name: 'Read more' });
    expect(res.status).toBe(200);
    expect(inserts()).toEqual([
      insertOf('goals', inserted.goal(NEW(3), 'Run a half', 'icon:Target', TODAY)),
      insertOf('goals', inserted.goal(NEW(4), 'Read more', null, null)),
    ]);
    const back = goalFromRow(row('goals', NEW(3)) as unknown as GoalRow, { memberIds: [], milestoneIds: [], checkinIds: [] });
    expect(back).toMatchObject({ state: 'active', startsOn: TODAY, memberIds: [], milestoneIds: [], checkinIds: [] });
    expect(back.targetOn).toBeUndefined();
  });

  it('a project: the folded clash read, then the insert, its glyph in the emoji column, and none is ""', async () => {
    let res = await create('project', { id: NEW(5), name: 'Allotment', icon: 'icon:Briefcase' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: NEW(5) });
    expect(statements).toEqual([
      idRead('projects', NEW(5)),
      clashRead,
      insertOf('projects', inserted.project(NEW(5), 'Allotment', 'icon:Briefcase')),
    ]);
    res = await create('project', { id: NEW(6), name: 'Garage' });
    expect(res.status).toBe(200);
    expect(row('projects', NEW(6)).emoji).toBe('');
    expect(projectFromRow(row('projects', NEW(6)) as unknown as ProjectRow)).toMatchObject({ id: NEW(6), name: 'Garage', emoji: '' });
  });

  it('stores the name trimmed, and takes an uppercase id as its lowercase self', async () => {
    const res = await create('routine', { id: NEW(7).toUpperCase(), name: '  Lunch walk \n' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: NEW(7) });
    expect(row('routines', NEW(7)).name).toBe('Lunch walk');
    expect(statements[0]).toEqual(idRead('routines', NEW(7)));
  });

  it('a routine, season or goal may take a name another of its kind has: only projects fold names together', async () => {
    expect((await create('routine', { id: NEW(8), name: 'Morning' })).status).toBe(200);
    expect((await create('season', { id: NEW(9), name: 'autumn' })).status).toBe(200);
    expect((await create('goal', { id: NEW(10), name: 'Old goal' })).status).toBe(200);
    expect(statements.some((s) => s.op === 'select' && s.columns === '*')).toBe(false);
    expect(inserts()).toHaveLength(3);
  });

  describe('a second send of one create', () => {
    it.each([
      ['routine', 'routines'],
      ['season', 'seasons'],
      ['goal', 'goals'],
      ['project', 'projects'],
    ])('a %s already made is 200 with its id, and nothing more is written', async (kind, table) => {
      const body = { id: NEW(11), name: 'Twice' };
      expect((await create(kind, body)).status).toBe(200);
      statements = [];
      const res = await create(kind, body);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, id: NEW(11) });
      expect(statements).toEqual([idRead(table, NEW(11))]);
      expect(tables[table].filter((r) => r.id === NEW(11))).toHaveLength(1);
    });

    it('one since put in the Trash is 200 and stays there: the retry never brings it back', async () => {
      tables.routines.push(routineRow(12, 'Binned', { id: NEW(12), deleted_at: STAMP }));
      const res = await create('routine', { id: NEW(12), name: 'Binned' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, id: NEW(12) });
      expect(statements).toEqual([idRead('routines', NEW(12))]);
      expect(row('routines', NEW(12)).deleted_at).toBe(STAMP);
    });

    it('one that commits between the read and the insert is 200: the key refuses, and the read after finds it', async () => {
      beforeInsert = (table, payload) => {
        beforeInsert = null;
        tables[table].push({ ...payload, created_at: NOW, deleted_at: null });
      };
      const res = await create('project', { id: NEW(13), name: 'Shed' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, id: NEW(13) });
      expect(statements).toEqual([
        idRead('projects', NEW(13)),
        clashRead,
        insertOf('projects', inserted.project(NEW(13), 'Shed', '')),
        idRead('projects', NEW(13)),
      ]);
      expect(tables.projects.filter((r) => r.id === NEW(13))).toHaveLength(1);
    });

    it('an id another user’s row holds is a bare 500, never a name refusal', async () => {
      for (const [kind, rowId] of [
        ['routine', ROUTINE(6)],
        ['project', PROJECT(4)],
      ] as const) {
        const res = await create(kind, { id: rowId, name: 'Mine now' });
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: 'failed' });
      }
      expect(row('routines', ROUTINE(6)).name).toBe('Theirs');
      expect(row('projects', PROJECT(4)).name).toBe('Garden');
    });
  });

  describe('a project’s name', () => {
    it('refuses a live project’s name in any case: 409 name_taken with that project, and nothing written', async () => {
      for (const name of ['Work', 'work', ' WORK ']) {
        const res = await create('project', { id: NEW(14), name });
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: 'name_taken', project: { id: PROJECT(1), name: 'Work' } });
      }
      expect(inserts()).toEqual([]);
      expect(tables).toEqual(world());
    });

    it('refuses the exact name a project in the Trash holds: 409 name_in_trash, after the key refuses it', async () => {
      const res = await create('project', { id: NEW(15), name: 'Errands' });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'name_in_trash' });
      expect(statements).toEqual([
        idRead('projects', NEW(15)),
        clashRead,
        insertOf('projects', inserted.project(NEW(15), 'Errands', '')),
        idRead('projects', NEW(15)),
        clashRead,
      ]);
      expect(tables).toEqual(world());
    });

    it('a live project that takes the exact name after the clash read is name_taken, never the Trash’s sentence', async () => {
      // Another device makes "Shed" between this create's clash read and its insert.
      beforeInsert = (table) => {
        beforeInsert = null;
        if (table === 'projects') tables.projects.push(projectRow(9, 'Shed', { created_at: NOW }));
      };
      const res = await create('project', { id: NEW(29), name: 'Shed' });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'name_taken', project: { id: PROJECT(9), name: 'Shed' } });
      expect(statements).toEqual([
        idRead('projects', NEW(29)),
        clashRead,
        insertOf('projects', inserted.project(NEW(29), 'Shed', '')),
        idRead('projects', NEW(29)),
        clashRead,
      ]);
      expect(tables.projects.some((r) => r.id === NEW(29))).toBe(false);
    });

    it('a trashed name in another case is no clash: the index is exact-case, and the Trash is not live', async () => {
      const res = await create('project', { id: NEW(16), name: 'errands' });
      expect(res.status).toBe(200);
      expect(row('projects', NEW(16)).name).toBe('errands');
    });

    it('another user’s project with the name is no clash', async () => {
      const res = await create('project', { id: NEW(17), name: 'Garden' });
      expect(res.status).toBe(200);
      expect(row('projects', NEW(17)).name).toBe('Garden');
    });
  });

  describe('what it refuses', () => {
    it.each([
      ['an unknown kind', 'habit'],
      ['a plural', 'routines'],
      ['a kind in capitals', 'Routine'],
      ['an item', 'item'],
    ])('%s is 404 before the body is read or any statement runs', async (_name, kind) => {
      const res = await create(kind, '{not json');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
      expect(statements).toEqual([]);
    });

    it.each([
      ['not JSON', 'routine', '{nope'],
      ['an array', 'routine', [{ id: NEW(18), name: 'Desk' }]],
      ['an empty object', 'season', {}],
      ['no id', 'goal', { name: 'Run' }],
      ['a sample id', 'routine', { id: 'sample-morning-routine', name: 'Desk' }],
      ['a blank name', 'project', { id: NEW(18), name: ' ' }],
      ['a name past the bound', 'routine', { id: NEW(18), name: 'x'.repeat(10_001) }],
      ['a null icon', 'season', { id: NEW(18), name: 'Autumn', icon: null }],
      ['an icon that is not a token', 'goal', { id: NEW(18), name: 'Run', icon: 'Target' }],
      ['a first day on a season', 'season', { id: NEW(18), name: 'Autumn', startsOn: TODAY }],
      ['a first day not on the calendar', 'goal', { id: NEW(18), name: 'Run', startsOn: '2026-02-30' }],
      ['a project’s glyph as emoji', 'project', { id: NEW(18), name: 'Home', emoji: 'icon:House' }],
      ['members', 'routine', { id: NEW(18), name: 'Desk', itemIds: [ITEM(1)] }],
      ['a colour', 'project', { id: NEW(18), name: 'Home', color: 'var(--accent-2)' }],
      ['an action', 'goal', { action: 'create', id: NEW(18), name: 'Run' }],
    ])('%s is 400 invalid, before any statement', async (_name, kind, body) => {
      const res = await create(kind, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid');
      expect(statements).toEqual([]);
    });

    it('is 401 with no bearer, or a token that is not one, and reads nothing', async () => {
      expect((await create('routine', { id: NEW(19), name: 'Desk' }, null)).status).toBe(401);
      expect((await create('routine', { id: NEW(19), name: 'Desk' }, 'Bearer nope')).status).toBe(401);
      expect(statements).toEqual([]);
    });

    it('answers a failed id read, clash read or insert with a bare 500, and makes nothing', async () => {
      failing = { table: 'routines', op: 'select' };
      let res = await create('routine', { id: NEW(20), name: 'Desk' });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'failed' });
      expect(inserts()).toEqual([]);

      // The id read passes and the clash read fails: the second select of projects.
      let reads = 0;
      h.createClient.mockImplementation(() => {
        const db = database();
        const from = db.from;
        db.from = (table: string) => {
          const t = from(table);
          if (table !== 'projects') return t;
          return {
            ...t,
            select: (columns?: string) => {
              reads += 1;
              if (reads === 2) failing = { table: 'projects', op: 'select' };
              return t.select(columns);
            },
          };
        };
        return db;
      });
      failing = null;
      res = await create('project', { id: NEW(21), name: 'Shed' });
      expect(res.status).toBe(500);
      expect(inserts()).toEqual([]);

      h.createClient.mockImplementation(() => database());
      failing = { table: 'goals', op: 'insert' };
      res = await create('goal', { id: NEW(22), name: 'Run' });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'failed' });
      expect(tables.goals.some((r) => r.id === NEW(22))).toBe(false);
    });
  });

  describe('who it answers to', () => {
    it('makes each kind with Organize and Goals off, and never reads the switches', async () => {
      expect((await create('routine', { id: NEW(23), name: 'Desk' })).status).toBe(200);
      expect((await create('season', { id: NEW(24), name: 'Autumn' })).status).toBe(200);
      expect((await create('goal', { id: NEW(25), name: 'Run' })).status).toBe(200);
      expect((await create('project', { id: NEW(26), name: 'Shed' })).status).toBe(200);
      expect(statements.some((s) => s.table === 'user_extensions')).toBe(false);
    });

    it('fires no webhook, writes no item_events or member rows, and never builds the service client', async () => {
      expect((await create('routine', { id: NEW(27), name: 'Desk' })).status).toBe(200);
      expect((await create('season', { id: NEW(30), name: 'Winter', icon: 'icon:Snowflake' })).status).toBe(200);
      expect((await create('goal', { id: NEW(31), name: 'Swim', startsOn: TODAY })).status).toBe(200);
      expect((await create('project', { id: NEW(28), name: 'Shed', icon: 'icon:Hammer' })).status).toBe(200);
      expect(h.notifyPlugins).not.toHaveBeenCalled();
      expect(h.createServiceClient).not.toHaveBeenCalled();
      expect(new Set(statements.map((s) => s.table))).toEqual(new Set(['routines', 'seasons', 'goals', 'projects']));
    });
  });
});

/*
 * The fixture the phone's port is pinned by (tests/fixtures/organize/
 * container-writes.json, written by organize-fixtures.test.ts off
 * containerIntentPatch) is also what this route does: each case's row,
 * written at its `now` in its zone, reads back as its `after`, and each
 * refused body is a 400 here. So the phone steps and replays exactly what the
 * server stores, not merely what the pure rule says.
 */
describe('the route answers every case in container-writes.json', () => {
  type Kind = 'routine' | 'season' | 'goal' | 'project';
  interface FixtureCase {
    name: string;
    kind: Kind;
    before: Record<string, unknown> & {
      itemIds?: string[];
      routineIds?: string[];
      memberIds?: string[];
      milestoneIds?: string[];
      checkinIds?: string[];
    };
    body: unknown;
    now: string;
    timeZone: string;
    today: string;
    expected: { refused: string | null; status: number; patch: Record<string, unknown> | null; after: Record<string, unknown> };
  }
  type Refused = { name: string; kind: Kind; body: unknown; expected: { status: number; error: string } };
  const fixture = JSON.parse(
    readFileSync(path.resolve(__dirname, '../fixtures/organize/container-writes.json'), 'utf8'),
  ) as {
    cases: FixtureCase[];
    invalid: Refused[];
    deletes: { name: string; kind: Kind; body: unknown; expected: { status: number } }[];
    creates: {
      name: string;
      kind: Kind;
      body: Record<string, unknown>;
      expected: { status: number; id: string; after: Record<string, unknown> };
    }[];
    createInvalid: Refused[];
  };

  const TABLE: Record<Kind, string> = { routine: 'routines', season: 'seasons', goal: 'goals', project: 'projects' };
  /** Home's id, so a project rename re-files the world's members as it would a real one's. */
  const ROW_ID: Record<Kind, string> = { routine: ROUTINE(1), season: SEASON(1), goal: GOAL(1), project: PROJECT(2) };

  const v = (c: FixtureCase, key: string) => (c.before[key] ?? null) as unknown;
  /** The case's container as its stored row: every column the kind's FromRow reads. */
  const storedRow = (c: FixtureCase): Row => {
    const name = c.before.name as string;
    const shared = { icon: v(c, 'icon'), color: v(c, 'color') };
    switch (c.kind) {
      case 'routine':
        return routineRow(1, name, {
          ...shared,
          paused_at: v(c, 'pausedAt'),
          paused_until: v(c, 'pausedUntil'),
          sort_order: v(c, 'sortOrder'),
          usual_time: v(c, 'usualTime'),
          notes: v(c, 'notes'),
        });
      case 'season':
        return seasonRow(1, name, {
          ...shared,
          state: v(c, 'state'),
          starts_on: v(c, 'startsOn'),
          ends_on: v(c, 'endsOn'),
          sort_order: v(c, 'sortOrder'),
          notes: v(c, 'notes'),
        });
      case 'goal':
        return goalRow(1, name, {
          ...shared,
          why: v(c, 'why'),
          state: v(c, 'state'),
          starts_on: v(c, 'startsOn'),
          target_on: v(c, 'targetOn'),
          achieved_at: v(c, 'achievedAt'),
          sort_order: v(c, 'sortOrder'),
        });
      case 'project':
        return projectRow(2, name, { emoji: c.before.emoji ?? '', color: v(c, 'color'), notes: v(c, 'notes') });
    }
  };
  /** The stored row read back the way the payload builds it, with the members the case gave. */
  const readBack = (c: FixtureCase, stored: Row) => {
    switch (c.kind) {
      case 'routine':
        return routineFromRow(stored as unknown as RoutineRow, c.before.itemIds ?? []);
      case 'season':
        return seasonFromRow(stored as unknown as SeasonRow, c.before.itemIds ?? [], c.before.routineIds ?? []);
      case 'goal':
        return goalFromRow(stored as unknown as GoalRow, {
          memberIds: c.before.memberIds ?? [],
          milestoneIds: c.before.milestoneIds ?? [],
          checkinIds: c.before.checkinIds ?? [],
        });
      case 'project':
        return projectFromRow(stored as unknown as ProjectRow);
    }
  };

  it('covers every kind', () => {
    expect(new Set(fixture.cases.map((c) => c.kind))).toEqual(new Set(['routine', 'season', 'goal', 'project']));
  });

  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    vi.setSystemTime(new Date(c.now));
    // The zone the case pins is the account's; with UTC, none is stored and the device's is used.
    tables.user_settings = [{ user_id: USER, timezone: c.timeZone === 'UTC' ? null : c.timeZone }];
    const table = TABLE[c.kind];
    const rowId = ROW_ID[c.kind];
    tables[table] = [storedRow(c)];

    const res = await write(c.kind, rowId, c.body);
    expect(res.status).toBe(c.expected.status);
    expect(await res.json()).toEqual(c.expected.refused ? { error: c.expected.refused } : { ok: true });

    // The container's own table: one write for a patch, none for an empty one
    // (a project rename's members are the items table's, pinned above).
    const patch = c.expected.patch ?? {};
    expect(writes().filter((w) => w.table === table).length).toBe(Object.keys(patch).length > 0 ? 1 : 0);
    const read = JSON.parse(JSON.stringify({ ...readBack(c, row(table, rowId)), id: c.before.id })) as Record<string, unknown>;
    delete read.updatedAt;
    expect(read).toEqual(c.expected.after);
  });

  it.each(fixture.invalid.map((c) => [c.name, c] as const))('%s: 400, nothing read', async (_name, c) => {
    const res = await write(c.kind, ROW_ID[c.kind], c.body);
    expect(res.status).toBe(c.expected.status);
    expect((await res.json()).error).toBe(c.expected.error);
    expect(statements).toEqual([]);
  });

  it('deletes and creates every kind', () => {
    expect(fixture.deletes.map((c) => c.kind)).toEqual(['routine', 'season', 'goal', 'project']);
    expect(new Set(fixture.creates.map((c) => c.kind))).toEqual(new Set(['routine', 'season', 'goal', 'project']));
  });

  // The world's live row of the kind: the delete stamps it and the phone drops it.
  it.each(fixture.deletes.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const table = TABLE[c.kind];
    const rowId = ROW_ID[c.kind];
    const res = await write(c.kind, rowId, c.body);
    expect(res.status).toBe(c.expected.status);
    expect(await res.json()).toEqual({ ok: true });
    expect(row(table, rowId).deleted_at).toBe(NOW);
    expect(writes()).toEqual([expect.objectContaining({ table, payload: { deleted_at: NOW } })]);
  });

  // The kind's table emptied first, so no name the world holds (a trashed
  // project's among them) is in the way: what is pinned is the container
  // made, which the phone's optimistic step makes too.
  it.each(fixture.creates.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const table = TABLE[c.kind];
    tables[table] = [];
    const res = await create(c.kind, c.body);
    expect(res.status).toBe(c.expected.status);
    expect(await res.json()).toEqual({ ok: true, id: c.expected.id });
    expect(inserts()).toHaveLength(1);
    const stored = row(table, c.expected.id);
    const back = (() => {
      switch (c.kind) {
        case 'routine':
          return routineFromRow(stored as unknown as RoutineRow, []);
        case 'season':
          return seasonFromRow(stored as unknown as SeasonRow, [], []);
        case 'goal':
          return goalFromRow(stored as unknown as GoalRow, { memberIds: [], milestoneIds: [], checkinIds: [] });
        case 'project':
          return projectFromRow(stored as unknown as ProjectRow);
      }
    })();
    const read = JSON.parse(JSON.stringify(back)) as Record<string, unknown>;
    delete read.updatedAt;
    expect(read).toEqual(c.expected.after);
  });

  it.each(fixture.createInvalid.map((c) => [c.name, c] as const))('a create with %s: 400, nothing read', async (_name, c) => {
    const res = await create(c.kind, c.body);
    expect(res.status).toBe(c.expected.status);
    expect((await res.json()).error).toBe(c.expected.error);
    expect(statements).toEqual([]);
  });
});
