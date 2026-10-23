import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * POST /api/app/containers/:kind/:id: one field of one container, from the
 * iPhone (lib/app-containers.ts postContainerWrite). O8a takes two intents:
 * a routine's `pause` (Pause, Pause until, Resume) and a season's `state`
 * (On, Off, Dates), the web's setRoutinePaused and setSeasonState.
 *
 * What the route promises, each pinned below:
 *   - 404 for an unknown kind, a malformed id, and any container that is not
 *     the caller's LIVE row (never one, in the Trash, another user's), with
 *     nothing written: the row is read first because updateRoutine and
 *     updateSeason do not filter deleted_at and a zero-row update says 200;
 *   - 400 for anything but one strict intent of that kind;
 *   - a pause resolved at today in the account's zone, from one `now`, through
 *     resolvePauseWrite: a retry writes nothing, a resume keeps the interval,
 *     and a resume day not after today is 409 `pause_refused`;
 *   - a season's state stored exactly as picked, and nothing written when it
 *     already has it;
 *   - each intent writes its own columns and no other;
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

/** 13:00 in New York on Friday Oct 23, 2026. */
const NOW = '2026-10-23T17:00:00.000Z';
const TODAY = '2026-10-23';
const STAMP = '2026-10-01T12:00:00.123456+00:00';

type Row = Record<string, unknown>;
type Filter = ['eq' | 'is', string, unknown];
interface Statement {
  table: string;
  op: 'select' | 'update';
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

/** Enough of PostgREST for the route: select (a column list or *), update, eq, is, maybeSingle. */
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
      const hit = (tables[table] ?? []).filter(match);
      if (op === 'update') {
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
    }),
  };
}

const writes = () => statements.filter((s) => s.op === 'update');

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

/**
 *   - Morning: live, never paused;
 *   - Evening: paused since Oct 20, no return day;
 *   - Stretch: paused since Oct 20, back Oct 30;
 *   - Garden: paused Oct 1 to Oct 10, over (the interval kept on the row);
 *   - Old: in the Trash; Theirs: another user's;
 *   - Autumn: auto, Sep 1 to Nov 30 (live today); Shelf: off by hand;
 *     Always: on by hand; Gone: in the Trash; Not mine: another user's;
 *   - a goal and a project, which take no intent yet;
 *   - Organize switched off, which gates nothing here.
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
    goals: [{ id: GOAL(1), user_id: USER, name: 'Run', state: 'active', deleted_at: null }],
    projects: [{ id: PROJECT(1), user_id: USER, name: 'Work', emoji: '', deleted_at: null }],
    user_settings: [{ user_id: USER, timezone: 'America/New_York' }],
    user_extensions: [{ user_id: USER, slug: 'organize', enabled: false }],
  };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = () =>
  [b64({ alg: 'HS256' }), b64({ sub: USER, role: 'authenticated', exp: Date.now() / 1000 + 3600 }), 'sig'].join('.');

import { POST as containerRoute } from '@/app/api/app/containers/[kind]/[id]/route';
import {
  CONTAINER_WRITES,
  RoutineWriteSchema,
  SeasonWriteSchema,
  containerIntentPatch,
  containerWrites,
} from '@/lib/app-containers';
import { routineFromRow, seasonFromRow, type RoutineRow, type SeasonRow } from '@/lib/db';

const write = (kind: string, rowId: string, body: unknown, auth: string | null = `Bearer ${token()}`) =>
  containerRoute(
    new Request(`https://do.dsul.app/api/app/containers/${kind}/${rowId}`, {
      method: 'POST',
      headers: { ...(auth ? { authorization: auth } : {}), 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ kind, id: rowId }) },
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
  ])('%s is 404 after one read, and nothing is written', async (_name, kind, rowId, body, table) => {
    const res = await write(kind, rowId, body);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(statements).toEqual([liveRead(table, rowId)]);
    expect(row('routines', ROUTINE(5)).paused_at).toBeNull();
    expect(tables.routines.find((r) => r.id === ROUTINE(6))!.paused_at).toBeNull();
    expect(row('seasons', SEASON(4)).state).toBe('auto');
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
    ['an action no kind takes', { action: 'rename', name: 'Mornings' }],
    ['an empty object', {}],
  ])('a routine given %s', async (_name, body) => {
    const res = await write('routine', ROUTINE(1), body);
    expect(res.status).toBe(400);
    expect(statements).toEqual([]);
  });

  it.each([
    ['goal', GOAL(1)],
    ['project', PROJECT(1)],
  ])('a %s takes no intent yet: any body is 400, and nothing is read', async (kind, rowId) => {
    for (const body of [{ action: 'rename', name: 'X' }, { action: 'state', state: 'achieved' }, {}]) {
      const res = await write(kind, rowId, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid');
    }
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
  });
});

describe('what the payload says the phone may send', () => {
  it('lists each kind’s intents, read off its union; a kind with none lists none', () => {
    expect(CONTAINER_WRITES).toEqual({ routine: ['pause'], season: ['state'], goal: [], project: [] });
  });

  it('hands the payload fresh lists, so nothing downstream can grow the constant', () => {
    const copy = containerWrites();
    expect(copy).toEqual(CONTAINER_WRITES);
    copy.routine.push('rename');
    expect(CONTAINER_WRITES.routine).toEqual(['pause']);
  });

  it('takes exactly the keys of each intent', () => {
    expect(RoutineWriteSchema.safeParse({ action: 'pause', paused: true, pausedUntil: '2026-10-30', timeZone: 'UTC' }).success).toBe(true);
    expect(RoutineWriteSchema.safeParse({ action: 'pause', paused: true, extra: 1 }).success).toBe(false);
    expect(SeasonWriteSchema.safeParse({ action: 'state', state: 'auto' }).success).toBe(true);
    expect(SeasonWriteSchema.safeParse({ action: 'state', state: 'auto', updatedAt: NOW }).success).toBe(false);
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

/*
 * The fixture the phone's port is pinned by (tests/fixtures/organize/
 * container-writes.json, written by organize-fixtures.test.ts off
 * containerIntentPatch) is also what this route does: each case's row,
 * written at its `now` in its zone, reads back as its `after`, and each
 * refused body is a 400 here. So the phone steps and replays exactly what the
 * server stores, not merely what the pure rule says.
 */
describe('the route answers every case in container-writes.json', () => {
  interface FixtureCase {
    name: string;
    kind: 'routine' | 'season';
    before: Record<string, unknown> & { itemIds: string[]; routineIds?: string[] };
    body: unknown;
    now: string;
    timeZone: string;
    today: string;
    expected: { refused: string | null; status: number; patch: Record<string, unknown> | null; after: Record<string, unknown> };
  }
  const fixture = JSON.parse(
    readFileSync(path.resolve(__dirname, '../fixtures/organize/container-writes.json'), 'utf8'),
  ) as { cases: FixtureCase[]; invalid: { name: string; kind: string; body: unknown; expected: { status: number; error: string } }[] };

  const v = (c: FixtureCase, key: string) => (c.before[key] ?? null) as unknown;

  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    vi.setSystemTime(new Date(c.now));
    // The zone the case pins is the account's; with UTC, none is stored and the device's is used.
    tables.user_settings = [{ user_id: USER, timezone: c.timeZone === 'UTC' ? null : c.timeZone }];
    const rowId = c.kind === 'routine' ? ROUTINE(1) : SEASON(1);
    const table = c.kind === 'routine' ? 'routines' : 'seasons';
    tables[table] =
      c.kind === 'routine'
        ? [
            routineRow(1, c.before.name as string, {
              paused_at: v(c, 'pausedAt'),
              paused_until: v(c, 'pausedUntil'),
              sort_order: v(c, 'sortOrder'),
              usual_time: v(c, 'usualTime'),
            }),
          ]
        : [
            seasonRow(1, c.before.name as string, {
              state: v(c, 'state'),
              starts_on: v(c, 'startsOn'),
              ends_on: v(c, 'endsOn'),
              sort_order: v(c, 'sortOrder'),
            }),
          ];

    const res = await write(c.kind, rowId, c.body);
    expect(res.status).toBe(c.expected.status);
    expect(await res.json()).toEqual(c.expected.refused ? { error: c.expected.refused } : { ok: true });

    const patch = c.expected.patch ?? {};
    expect(writes().length).toBe(Object.keys(patch).length > 0 ? 1 : 0);
    const stored = row(table, rowId);
    const after =
      c.kind === 'routine'
        ? routineFromRow(stored as unknown as RoutineRow, c.before.itemIds)
        : seasonFromRow(stored as unknown as SeasonRow, c.before.itemIds, c.before.routineIds ?? []);
    const read = JSON.parse(JSON.stringify({ ...after, id: c.before.id })) as Record<string, unknown>;
    delete read.updatedAt;
    expect(read).toEqual(c.expected.after);
  });

  it.each(fixture.invalid.map((c) => [c.name, c] as const))('%s: 400, nothing read', async (_name, c) => {
    const rowId = { routine: ROUTINE(1), season: SEASON(1), goal: GOAL(1), project: PROJECT(1) }[c.kind]!;
    const res = await write(c.kind, rowId, c.body);
    expect(res.status).toBe(c.expected.status);
    expect((await res.json()).error).toBe(c.expected.error);
    expect(statements).toEqual([]);
  });
});
