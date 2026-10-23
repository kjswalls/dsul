import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

/**
 * GET /api/app/trash and POST /api/app/trash/restore: the iPhone's Trash
 * (lib/app-containers.ts).
 *
 * The list is the web's own bin (lib/db.ts listDeleted) on the caller's
 * client, trimmed to what the phone draws: the kind, the name, when it went,
 * its glyph and colour, an item's type slug, the subtasks that come back with
 * a parent, and the members a project or a goal re-files (never a routine's
 * or a season's: the web shows no count for those). It is never cached.
 *
 * A restore is the web's Restore (planner-store.ts restoreFromTrash) through
 * the same lib/db.ts call per kind, read first: a row that is not the
 * caller's is 404, one already live is 200 with no write (a double tap, a
 * retry whose answer was lost), a project whose name a live project folds to
 * is 409 `name_taken`, and a subtask whose parent is in the bin too is 409
 * `parent_gone`. Never the service role, never a webhook, never an
 * item_events row.
 *
 * The database is an in-memory PostgREST with RLS: every statement sees only
 * the caller's rows, so "another user's id" is answered by the policy, as it
 * is in production, and not by a filter the route might forget.
 *
 * The list's answer over the world below is written to
 * tests/fixtures/app/trash-response.json, which DsulCore's decoder reads:
 *
 *   UPDATE_FIXTURES=1 pnpm test tests/unit/app-trash.test.ts
 */

const USER = '6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';
const OTHER = '0d1e2f3a-4b5c-4d6e-8f7a-9b0c1d2e3f4a';
const FIXTURE = path.resolve(__dirname, '../fixtures/app/trash-response.json');

/** Item n, project n, and so on: fixed, valid, lowercase uuids. */
const id = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ITEM = (n: number) => id('11111111', n);
const PROJECT = (n: number) => id('22222222', n);
const ROUTINE = (n: number) => id('33333333', n);
const SEASON = (n: number) => id('44444444', n);
const GOAL = (n: number) => id('55555555', n);

/** Postgres's own stamps: microseconds and an offset, as deleted_at arrives. */
const T = (day: number, hour = 9) => `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.123456+00:00`;

type Row = Record<string, unknown>;
type Filter = ['eq' | 'is' | 'notnull' | 'in' | 'neq', string, unknown];
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
let failing: string | null;

/**
 * Enough of PostgREST to answer the bin's and the restore's statements
 * honestly: select with a column list, update, eq / is / not-null / in / neq,
 * order (the bin sorts itself), maybeSingle, and thenable. `items_windowed`
 * (migration 031) reads the same rows as `items`.
 */
function database() {
  const build = (table: string, op: Statement['op'], payload?: Row, columns?: string) => {
    const filters: Filter[] = [];
    const backing = table === 'items_windowed' ? 'items' : table;
    // RLS: the caller's rows, and nothing else, whatever the statement asks.
    const visible = (row: Row) => row.user_id === USER;
    const match = (row: Row) =>
      visible(row) &&
      filters.every(([kind, col, val]) => {
        if (kind === 'eq') return row[col] === val;
        if (kind === 'neq') return row[col] !== val;
        if (kind === 'is') return (row[col] ?? null) === val;
        if (kind === 'notnull') return row[col] !== null && row[col] !== undefined;
        return (val as unknown[]).includes(row[col]);
      });
    // Only the projected columns, as PostgREST answers: a mock handing back
    // whole rows would let the route read a field its query never asked for.
    const project = (row: Row): Row => {
      if (!columns || columns.trim() === '*') return { ...row };
      return Object.fromEntries(columns.split(',').map((c) => [c.trim(), row[c.trim()] ?? null]));
    };
    const run = async () => {
      statements.push({ table, op, columns, payload, filters: [...filters] });
      if (failing === backing) return { data: null, error: { code: 'XX000', message: 'connection reset' } };
      const hit = (tables[backing] ?? []).filter(match);
      if (op === 'update') {
        for (const row of hit) Object.assign(row, payload);
        return { data: null, error: null };
      }
      return { data: hit.map(project), error: null };
    };
    const chain: Record<string, unknown> = {
      eq: (col: string, val: unknown) => (filters.push(['eq', col, val]), chain),
      neq: (col: string, val: unknown) => (filters.push(['neq', col, val]), chain),
      is: (col: string, val: unknown) => (filters.push(['is', col, val]), chain),
      in: (col: string, vals: unknown[]) => (filters.push(['in', col, vals]), chain),
      not: (col: string, operator: string, val: unknown) => {
        if (operator !== 'is' || val !== null) throw new Error(`unsupported not(${col}, ${operator})`);
        filters.push(['notnull', col, null]);
        return chain;
      },
      order: () => chain,
      limit: () => chain,
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

/** An item row as the table holds it: the caller's, live, with every column the mapper reads. */
const itemRow = (n: number, title: string, over: Row = {}): Row => ({
  id: ITEM(n),
  user_id: USER,
  type: 'task',
  title,
  status: 'pending',
  is_scheduled: false,
  completed_dates: [],
  skipped_dates: [],
  order: n,
  parent_item_id: null,
  project: null,
  project_id: null,
  deleted_at: null,
  ...over,
});

/**
 * The bin the fixture is written from, one of each thing a row can say:
 *   - a task deleted with two subtasks (one row, "2 subtasks");
 *   - a subtask deleted alone under a live parent (its own row);
 *   - a custom-type item (its slug), and a habit;
 *   - a project with two live members still pointing at it, and one with
 *     none and no glyph (`emoji: ''` says nothing);
 *   - a routine and a season with their glyphs and colours (no count);
 *   - a goal with a milestone, a check-in and a member (its count);
 *   - another user's trashed item, which RLS never shows;
 *   - live rows of every kind, which are not in the bin.
 */
function world(): Record<string, Row[]> {
  return {
    items: [
      itemRow(1, 'Plan the trip', { deleted_at: T(20) }),
      itemRow(2, 'Book the flight', { parent_item_id: ITEM(1), deleted_at: T(20) }),
      itemRow(3, 'Pack', { parent_item_id: ITEM(1), status: 'completed', deleted_at: T(20) }),
      itemRow(4, 'Write the toast'),
      itemRow(5, 'Buy the card', { parent_item_id: ITEM(4), deleted_at: T(21) }),
      itemRow(6, 'Dune', { type: 'book', deleted_at: T(18) }),
      itemRow(7, 'Stretch', { type: 'habit', repeat_frequency: 'daily', streak: 3, deleted_at: T(22, 7) }),
      itemRow(8, 'Invoice', { project: 'Admin', project_id: PROJECT(1) }),
      itemRow(9, 'Taxes', { project: 'Admin', project_id: PROJECT(1) }),
      itemRow(10, 'Run a 10K', { start_date: '2026-11-08', is_scheduled: true }),
      itemRow(11, 'Weekly review', { repeat_frequency: 'custom', repeat_days: [0] }),
      itemRow(12, 'Easy run', { type: 'habit', repeat_frequency: 'daily' }),
      { ...itemRow(13, 'Not mine'), user_id: OTHER, deleted_at: T(22) },
    ],
    projects: [
      { id: PROJECT(1), user_id: USER, name: 'Admin', emoji: 'icon:Briefcase', color: 'var(--accent-3)', deleted_at: T(19) },
      { id: PROJECT(2), user_id: USER, name: 'Garden', emoji: '', color: null, deleted_at: T(10) },
      { id: PROJECT(3), user_id: USER, name: 'Home', emoji: 'icon:House', color: null, deleted_at: null },
    ],
    routines: [
      {
        id: ROUTINE(1), user_id: USER, name: 'Morning', icon: 'icon:Sunrise', color: 'var(--accent-6)',
        paused_at: null, paused_until: null, sort_order: 0, usual_time: '07:00', deleted_at: T(21, 12),
      },
    ],
    routine_items: [{ routine_id: ROUTINE(1), item_id: ITEM(12), user_id: USER, sort_order: 0 }],
    seasons: [
      {
        id: SEASON(1), user_id: USER, name: 'Autumn', icon: 'icon:Leaf', color: null, state: 'auto',
        starts_on: '2026-09-01', ends_on: '2026-11-30', sort_order: 0, updated_at: T(1), deleted_at: T(15),
      },
    ],
    season_items: [{ season_id: SEASON(1), item_id: ITEM(12), user_id: USER }],
    season_routines: [{ season_id: SEASON(1), routine_id: ROUTINE(1), user_id: USER }],
    goals: [
      {
        id: GOAL(1), user_id: USER, name: 'Run a half marathon', why: 'To finish one.', icon: 'icon:Target',
        color: null, state: 'active', starts_on: '2026-09-01', target_on: '2027-03-01', achieved_at: null,
        sort_order: 0, deleted_at: T(17),
      },
    ],
    goal_items: [
      { goal_id: GOAL(1), item_id: ITEM(10), role: 'milestone', user_id: USER, sort_order: 0 },
      { goal_id: GOAL(1), item_id: ITEM(11), role: 'checkin', user_id: USER, sort_order: 1 },
      { goal_id: GOAL(1), item_id: ITEM(12), role: 'member', user_id: USER, sort_order: 2 },
    ],
  };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = () =>
  [b64({ alg: 'HS256' }), b64({ sub: USER, role: 'authenticated', exp: Date.now() / 1000 + 3600 }), 'sig'].join('.');

import * as trashRoute from '@/app/api/app/trash/route';
import { POST as restoreRoute } from '@/app/api/app/trash/restore/route';
import { TRASH_WRITES, TrashRestoreSchema } from '@/lib/app-containers';

const list = (auth: string | null = `Bearer ${token()}`) =>
  trashRoute.GET(
    new Request('https://do.dsul.app/api/app/trash', { headers: auth ? { authorization: auth } : {} }),
  );

const restore = (body: unknown, auth: string | null = `Bearer ${token()}`) =>
  restoreRoute(
    new Request('https://do.dsul.app/api/app/trash/restore', {
      method: 'POST',
      headers: { ...(auth ? { authorization: auth } : {}), 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

const row = (table: string, rowId: string) => tables[table].find((r) => r.id === rowId)!;

function setUp() {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://ref.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
  tables = world();
  statements = [];
  failing = null;
  h.createClient.mockImplementation(() => database());
}

beforeEach(setUp);

const serialize = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

describe('the Trash list fixture shared with DsulCore', () => {
  let generated: { entries: Row[] };

  beforeAll(async () => {
    setUp();
    const res = await list();
    expect(res.status).toBe(200);
    generated = (await res.json()) as { entries: Row[] };
    if (process.env.UPDATE_FIXTURES) {
      mkdirSync(path.dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, serialize(generated));
    }
  });

  it('the committed file exists', () => {
    expect(existsSync(FIXTURE), `missing ${FIXTURE}; run with UPDATE_FIXTURES=1`).toBe(true);
  });

  it('the committed answer is what the route answers today', () => {
    // On drift: if the change is intended, regenerate with UPDATE_FIXTURES=1
    // and make the same change in the phone's decoder.
    expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual(generated);
  });

  it('carries every row shape the decoder has to meet', () => {
    const kinds = new Set(generated.entries.map((e) => e.kind));
    expect([...kinds].sort()).toEqual(['goal', 'item', 'project', 'routine', 'season']);
    expect(generated.entries.some((e) => typeof e.childCount === 'number')).toBe(true);
    expect(generated.entries.some((e) => e.memberCount === 0)).toBe(true);
    expect(generated.entries.some((e) => e.kind === 'item' && e.itemType !== 'task' && e.itemType !== 'habit')).toBe(true);
    expect(generated.entries.some((e) => !('icon' in e))).toBe(true);
  });
});

describe('GET /api/app/trash', () => {
  it('lists the bin newest first, trimmed to what the phone draws', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as { entries: Row[] };
    expect(entries).toEqual([
      { kind: 'item', id: ITEM(7), name: 'Stretch', deletedAt: T(22, 7), itemType: 'habit' },
      { kind: 'routine', id: ROUTINE(1), name: 'Morning', deletedAt: T(21, 12), icon: 'icon:Sunrise', color: 'var(--accent-6)' },
      { kind: 'item', id: ITEM(5), name: 'Buy the card', deletedAt: T(21), itemType: 'task' },
      { kind: 'item', id: ITEM(1), name: 'Plan the trip', deletedAt: T(20), itemType: 'task', childCount: 2 },
      {
        kind: 'project', id: PROJECT(1), name: 'Admin', deletedAt: T(19), icon: 'icon:Briefcase',
        color: 'var(--accent-3)', memberCount: 2,
      },
      { kind: 'item', id: ITEM(6), name: 'Dune', deletedAt: T(18), itemType: 'book' },
      { kind: 'goal', id: GOAL(1), name: 'Run a half marathon', deletedAt: T(17), icon: 'icon:Target', memberCount: 3 },
      { kind: 'season', id: SEASON(1), name: 'Autumn', deletedAt: T(15), icon: 'icon:Leaf' },
      { kind: 'project', id: PROJECT(2), name: 'Garden', deletedAt: T(10), memberCount: 0 },
    ]);
  });

  it('counts members only on projects and goals, as the web’s rows do', async () => {
    const { entries } = (await (await list()).json()) as { entries: Row[] };
    for (const e of entries) {
      expect('memberCount' in e, `${e.kind} ${e.name}`).toBe(e.kind === 'project' || e.kind === 'goal');
      expect('childCount' in e, `${e.kind} ${e.name}`).toBe(e.id === ITEM(1));
      expect('itemType' in e, `${e.kind} ${e.name}`).toBe(e.kind === 'item');
    }
  });

  it('never sends the entity, a subtask its parent carries, or another user’s row', async () => {
    const { entries } = (await (await list()).json()) as { entries: Row[] };
    const keys = new Set(entries.flatMap((e) => Object.keys(e)));
    expect([...keys].sort()).toEqual(
      ['childCount', 'color', 'deletedAt', 'icon', 'id', 'itemType', 'kind', 'memberCount', 'name'].sort(),
    );
    const ids = entries.map((e) => e.id);
    expect(ids).not.toContain(ITEM(2));
    expect(ids).not.toContain(ITEM(3));
    expect(ids).not.toContain(ITEM(13));
    expect(ids).not.toContain(PROJECT(3));
  });

  it('is never cached, and the route is dynamic', async () => {
    const res = await list();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(trashRoute.dynamic).toBe('force-dynamic');
  });

  it('reads as the caller, never as the service role', async () => {
    await list();
    expect(h.createServiceClient).not.toHaveBeenCalled();
    const reads = statements.filter((s) => s.op === 'select');
    expect(reads.length).toBeGreaterThan(0);
    expect(writes()).toEqual([]);
  });

  it('is 401 with no bearer, or a token that is not one', async () => {
    expect((await list(null)).status).toBe(401);
    expect((await list('Bearer dsul_agentkey')).status).toBe(401);
    expect(statements).toEqual([]);
  });

  it('answers a failed table with a bare 500, never a bin with a hole in it', async () => {
    failing = 'routines';
    const res = await list();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'failed' });
  });

  it('answers an empty bin as an empty list', async () => {
    for (const rows of Object.values(tables)) for (const r of rows) if ('deleted_at' in r) r.deleted_at = null;
    const res = await list();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: [] });
  });
});

describe('POST /api/app/trash/restore', () => {
  it.each([
    ['item', ITEM(7), 'items'],
    ['project', PROJECT(1), 'projects'],
    ['routine', ROUTINE(1), 'routines'],
    ['season', SEASON(1), 'seasons'],
    ['goal', GOAL(1), 'goals'],
  ] as const)('puts a %s back where it was', async (kind, rowId, table) => {
    const res = await restore({ kind, id: rowId });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(row(table, rowId).deleted_at).toBeNull();
    // One write, to the row asked for, as the caller.
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ table, payload: { deleted_at: null } });
    expect(writes()[0].filters).toContainEqual(['eq', 'id', rowId]);
  });

  it('reads the row first, by id and user, whatever the policy says', async () => {
    await restore({ kind: 'routine', id: ROUTINE(1) });
    expect(statements[0]).toMatchObject({ table: 'routines', op: 'select', columns: 'id, deleted_at' });
    expect(statements[0].filters).toEqual([
      ['eq', 'id', ROUTINE(1)],
      ['eq', 'user_id', USER],
    ]);
  });

  it('brings an item back with the subtasks that went with it, and leaves the rest alone', async () => {
    const res = await restore({ kind: 'item', id: ITEM(1) });
    expect(res.status).toBe(200);
    expect(row('items', ITEM(1)).deleted_at).toBeNull();
    expect(row('items', ITEM(2)).deleted_at).toBeNull();
    expect(row('items', ITEM(3)).deleted_at).toBeNull();
    // Another trashed item is untouched.
    expect(row('items', ITEM(6)).deleted_at).toBe(T(18));
    // restoreItem's two statements: the row by id and its db type, then its trashed children.
    expect(writes().map((w) => w.filters)).toEqual([
      [
        ['eq', 'id', ITEM(1)],
        ['eq', 'type', 'task'],
      ],
      [
        ['eq', 'parent_item_id', ITEM(1)],
        ['notnull', 'deleted_at', null],
      ],
    ]);
  });

  it('restores a custom-type item by its slug, and a habit with no subtask cascade', async () => {
    await restore({ kind: 'item', id: ITEM(6) });
    expect(row('items', ITEM(6)).deleted_at).toBeNull();
    expect(writes()[0].filters).toContainEqual(['eq', 'type', 'book']);

    statements = [];
    await restore({ kind: 'item', id: ITEM(7) });
    expect(row('items', ITEM(7)).deleted_at).toBeNull();
    expect(writes()).toHaveLength(1);
  });

  it('restores a subtask deleted alone under a live parent', async () => {
    const res = await restore({ kind: 'item', id: ITEM(5) });
    expect(res.status).toBe(200);
    expect(row('items', ITEM(5)).deleted_at).toBeNull();
  });

  it('refuses a subtask whose parent is in the Trash too: 409 parent_gone, nothing written', async () => {
    // A list read before the parent went still offers the subtask's own row.
    const res = await restore({ kind: 'item', id: ITEM(2) });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'parent_gone' });
    expect(writes()).toEqual([]);
    expect(row('items', ITEM(2)).deleted_at).toBe(T(20));
    // The parent was asked by id and user.
    expect(statements[1]).toMatchObject({ table: 'items', op: 'select', columns: 'id, deleted_at' });
    expect(statements[1].filters).toEqual([
      ['eq', 'id', ITEM(1)],
      ['eq', 'user_id', USER],
    ]);
  });

  it('refuses a project whose name a live project folds to: 409 name_taken, naming it', async () => {
    tables.projects.push({ id: PROJECT(4), user_id: USER, name: 'admin', emoji: '', color: null, deleted_at: null });
    const res = await restore({ kind: 'project', id: PROJECT(1) });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'name_taken', project: { id: PROJECT(4), name: 'admin' } });
    expect(writes()).toEqual([]);
    expect(row('projects', PROJECT(1)).deleted_at).toBe(T(19));
  });

  it('lets a project back beside a trashed namesake, another user’s, or a different name', async () => {
    tables.projects.push(
      { id: PROJECT(5), user_id: USER, name: 'ADMIN', emoji: '', color: null, deleted_at: T(5) },
      { id: PROJECT(6), user_id: OTHER, name: 'Admin', emoji: '', color: null, deleted_at: null },
    );
    const res = await restore({ kind: 'project', id: PROJECT(1) });
    expect(res.status).toBe(200);
    expect(row('projects', PROJECT(1)).deleted_at).toBeNull();
  });

  it('answers 200 with no write for a row already live: a double tap, or a retry', async () => {
    expect((await restore({ kind: 'project', id: PROJECT(3) })).status).toBe(200);
    expect((await restore({ kind: 'item', id: ITEM(4) })).status).toBe(200);
    expect(writes()).toEqual([]);

    // The same restore twice lands once.
    statements = [];
    expect((await restore({ kind: 'season', id: SEASON(1) })).status).toBe(200);
    expect((await restore({ kind: 'season', id: SEASON(1) })).status).toBe(200);
    expect(writes()).toHaveLength(1);
  });

  it('is 404 for another user’s row and for no row at all, and writes nothing', async () => {
    const theirs = await restore({ kind: 'item', id: ITEM(13) });
    expect(theirs.status).toBe(404);
    expect(await theirs.json()).toEqual({ error: 'not_found' });
    expect(row('items', ITEM(13)).deleted_at).toBe(T(22));

    expect((await restore({ kind: 'goal', id: GOAL(9) })).status).toBe(404);
    // A real id under the wrong kind is no row of that kind.
    expect((await restore({ kind: 'routine', id: SEASON(1) })).status).toBe(404);
    expect(writes()).toEqual([]);
  });

  it('takes an uppercase id as the same row', async () => {
    const res = await restore({ kind: 'goal', id: GOAL(1).toUpperCase() });
    expect(res.status).toBe(200);
    expect(row('goals', GOAL(1)).deleted_at).toBeNull();
  });

  it.each([
    ['a body that is not JSON', '{nope'],
    ['no kind', { id: ITEM(1) }],
    ['no id', { kind: 'item' }],
    ['an unknown kind', { kind: 'habit', id: ITEM(7) }],
    ['the bin of a kind that has none', { kind: 'itemType', id: ITEM(7) }],
    ['an id that is not a uuid', { kind: 'item', id: 'sample-morning-routine' }],
    ['a key it does not take', { kind: 'item', id: ITEM(1), children: true }],
    ['an array', [{ kind: 'item', id: ITEM(1) }]],
  ])('is 400 invalid for %s, before any statement', async (_name, body) => {
    const res = await restore(body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid');
    expect(statements).toEqual([]);
  });

  it('is 401 with no bearer, and reads nothing', async () => {
    expect((await restore({ kind: 'item', id: ITEM(1) }, null)).status).toBe(401);
    expect(statements).toEqual([]);
    expect(row('items', ITEM(1)).deleted_at).toBe(T(20));
  });

  it('answers a failed read or write with a bare 500', async () => {
    failing = 'goals';
    const res = await restore({ kind: 'goal', id: GOAL(1) });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'failed' });
  });

  it('fires no webhook, writes no item_events, and never builds the service client', async () => {
    for (const [kind, rowId] of [
      ['item', ITEM(1)],
      ['project', PROJECT(1)],
      ['routine', ROUTINE(1)],
      ['season', SEASON(1)],
      ['goal', GOAL(1)],
    ] as const) {
      expect((await restore({ kind, id: rowId })).status).toBe(200);
    }
    expect(h.notifyPlugins).not.toHaveBeenCalled();
    expect(h.createServiceClient).not.toHaveBeenCalled();
    expect(statements.some((s) => s.table === 'item_events')).toBe(false);
    // Only the bin's own tables are written, and only deleted_at.
    for (const w of writes()) expect(w.payload).toEqual({ deleted_at: null });
  });
});

describe('what the payload says the phone may send', () => {
  it('lists the two Trash verbs, in the order the phone uses them', () => {
    expect(TRASH_WRITES).toEqual(['list', 'restore']);
  });

  it('takes exactly a kind and an id', () => {
    expect(TrashRestoreSchema.safeParse({ kind: 'season', id: SEASON(1) }).success).toBe(true);
    expect(Object.keys(TrashRestoreSchema.shape).sort()).toEqual(['id', 'kind']);
  });
});
