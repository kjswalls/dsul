import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * The goal agent routes, exercised end-to-end against an in-memory PostgREST
 * stand-in (plan Phase 4).
 *
 * **This is not the plan's Phase 4 gate.** That gate is live calls against a
 * running server — the standard seasons was held to — and it is still owed:
 * this container has no Supabase credentials, so no goal route in this
 * repository has ever spoken to a database.
 *
 * What the stand-in buys is the half a live call and a type-check both miss:
 * that the handlers name the right tables and columns, that the refusals fire
 * before any write lands, and that the multi-query sequences (ownership →
 * validate → trash-keep → state → reconcile) compose. To buy that it has to
 * REFUSE things, not just record them — a fake that accepts everything is wrong
 * in the same direction as the code it is testing. So it declares each table's
 * columns, its NOT NULLs and its unique keys, and it honours the projection
 * rule that tests/unit/goals.test.ts documents by name: handing back whole rows
 * lets a function look correct while reading a column its own query never
 * asked for, which is exactly the reconcile bug that file was built to catch.
 *
 * It is still a JavaScript object store. It models no foreign keys, no RLS, no
 * concurrency, and no PostgREST version differences — see the plan's ledger for
 * what remains untested until a live call is made.
 */

interface Row {
  [col: string]: unknown
}

interface TableSchema {
  columns: string[]
  notNull: string[]
  /** Unique keys, primary first. `onConflict` must name one of these exactly. */
  unique: string[][]
}

/** Only the tables the goal handlers touch, mirroring migration 036 + items. */
const SCHEMA: Record<string, TableSchema> = {
  goals: {
    columns: [
      'id', 'user_id', 'name', 'why', 'icon', 'color', 'state',
      'starts_on', 'target_on', 'achieved_at', 'sort_order',
      'created_at', 'updated_at', 'deleted_at',
    ],
    notNull: ['id', 'user_id', 'name', 'state'],
    unique: [['id'], ['id', 'user_id']],
  },
  goal_items: {
    columns: ['goal_id', 'item_id', 'user_id', 'role', 'sort_order'],
    notNull: ['goal_id', 'item_id', 'user_id', 'role'],
    unique: [['goal_id', 'item_id']],
  },
  items: {
    columns: [
      'id', 'user_id', 'type', 'title', 'status', 'parent_item_id',
      'repeat_frequency', 'start_date', 'is_scheduled', 'item_order',
      'streak', 'deleted_at', 'updated_at',
    ],
    notNull: ['id', 'user_id', 'type'],
    unique: [['id'], ['id', 'user_id']],
  },
  item_events: {
    columns: ['id', 'user_id', 'item_id', 'item_type', 'action', 'payload', 'created_at'],
    notNull: ['user_id', 'item_id', 'item_type', 'action'],
    unique: [['id']],
  },
}

class FakePostgrestError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** Tables the goal handlers touch, seeded per test. */
let db: Record<string, Row[]>;
/** Every statement the handlers issued, so a test can assert what did NOT run. */
let queryLog: { op: string; table: string; columns?: string }[] = [];

type Filter = (row: Row) => boolean;

function builder(table: string) {
  const schema = SCHEMA[table]
  if (!schema) throw new Error(`fake: no schema declared for table "${table}"`)
  const filters: Filter[] = [];
  let mode: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
  let payload: Row[] = [];
  let columns: string | undefined;
  let conflictCols: string[] = [];
  const orderBy: { col: string; ascending: boolean; nullsFirst?: boolean }[] = [];

  const rows = () => (db[table] ??= []);
  const matched = () => rows().filter((r) => filters.every((f) => f(r)));

  // PGRST204: PostgREST rejects a body naming a column the schema cache has
  // never heard of. A fake that accepts `startsOn` where the column is
  // `starts_on` turns a guaranteed production 500 into a green test.
  const checkColumns = (row: Row) => {
    for (const col of Object.keys(row)) {
      if (!schema.columns.includes(col)) {
        throw new FakePostgrestError(
          'PGRST204',
          `Could not find the '${col}' column of '${table}' in the schema cache`,
        )
      }
    }
  }
  // 23502, for the same reason.
  const checkNotNull = (row: Row) => {
    for (const col of schema.notNull) {
      if (row[col] === undefined || row[col] === null) {
        throw new FakePostgrestError(
          '23502',
          `null value in column "${col}" of relation "${table}" violates not-null constraint`,
        )
      }
    }
  }
  const keyOf = (row: Row, key: string[]) => JSON.stringify(key.map((c) => row[c]))
  // 23505 on insert, and 42P10 when `onConflict` does not name a real unique
  // key — the error real Postgres raises on EVERY membership write if the
  // upsert's conflict target is wrong.
  const checkUnique = (row: Row, ignore?: Row) => {
    for (const key of schema.unique) {
      if (key.some((c) => row[c] === undefined || row[c] === null)) continue
      const clash = rows().find((r) => r !== ignore && keyOf(r, key) === keyOf(row, key))
      if (clash) {
        throw new FakePostgrestError(
          '23505',
          `duplicate key value violates unique constraint on (${key.join(', ')}) of "${table}"`,
        )
      }
    }
  }

  const project = (row: Row): Row => {
    if (!columns || columns.trim() === '*') return { ...row }
    return Object.fromEntries(
      columns.split(',').map((c) => c.trim()).map((c) => {
        if (!schema.columns.includes(c)) {
          throw new FakePostgrestError(
            '42703',
            `column ${table}.${c} does not exist`,
          )
        }
        return [c, row[c]]
      }),
    )
  }

  const run = () => {
    queryLog.push({ op: mode, table, columns })
    switch (mode) {
      case 'select': {
        // Copies AND a projection. PostgREST hands back JSON containing only
        // the columns asked for, so a handler can neither observe a later write
        // through a row it already read nor use a field it never selected.
        const sorted = [...matched()].sort((a, b) => {
          for (const { col, ascending, nullsFirst } of orderBy) {
            const av = a[col]
            const bv = b[col]
            const aNull = av === null || av === undefined
            const bNull = bv === null || bv === undefined
            if (aNull !== bNull) return (aNull ? 1 : -1) * (nullsFirst === true ? -1 : 1)
            if (aNull) continue
            if (av === bv) continue
            return (av! < bv! ? -1 : 1) * (ascending ? 1 : -1)
          }
          return 0
        })
        return { data: sorted.map(project), error: null };
      }
      case 'insert':
        for (const r of payload) {
          checkColumns(r)
          checkNotNull(r)
          checkUnique(r)
          rows().push({ ...r })
        }
        return { data: payload, error: null };
      case 'upsert': {
        if (!schema.unique.some((k) => keyOf({}, k) === keyOf({}, conflictCols) &&
            k.length === conflictCols.length && k.every((c, i) => c === conflictCols[i]))) {
          throw new FakePostgrestError(
            '42P10',
            `there is no unique or exclusion constraint matching the ON CONFLICT specification (${conflictCols.join(', ')})`,
          )
        }
        for (const incoming of payload) {
          checkColumns(incoming)
          checkNotNull(incoming)
          const existing = rows().find((r) => conflictCols.every((c) => r[c] === incoming[c]));
          checkUnique(incoming, existing)
          if (existing) Object.assign(existing, incoming);
          else rows().push({ ...incoming });
        }
        return { data: payload, error: null };
      }
      case 'update': {
        checkColumns(payload[0])
        const hits = matched()
        for (const row of hits) Object.assign(row, payload[0]);
        for (const row of hits) checkNotNull(row)
        return { data: hits.map(project), error: null };
      }
      case 'delete': {
        const doomed = new Set(matched());
        db[table] = rows().filter((r) => !doomed.has(r));
        return { data: null, error: null };
      }
    }
  };

  // Errors surface the way supabase-js surfaces them — as an `error` on the
  // result, not a throw — so the handlers' own error branches are reachable.
  const settle = () => {
    try {
      return run() as { data: unknown; error: unknown }
    } catch (e) {
      const err = e as FakePostgrestError
      return { data: null, error: { code: err.code, message: err.message } }
    }
  }

  const self: Record<string, unknown> = {
    select: (cols?: string) => {
      columns = cols
      return self
    },
    insert: (data: Row | Row[]) => {
      mode = 'insert';
      payload = Array.isArray(data) ? data : [data];
      return self;
    },
    upsert: (data: Row | Row[], opts?: { onConflict?: string }) => {
      mode = 'upsert';
      payload = Array.isArray(data) ? data : [data];
      conflictCols = (opts?.onConflict ?? '').split(',').map((c) => c.trim()).filter(Boolean);
      return self;
    },
    update: (data: Row) => {
      mode = 'update';
      payload = [data];
      return self;
    },
    delete: () => {
      mode = 'delete';
      return self;
    },
    eq: (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return self;
    },
    neq: (col: string, val: unknown) => {
      filters.push((r) => r[col] !== val);
      return self;
    },
    is: (col: string, val: unknown) => {
      filters.push((r) => (val === null ? r[col] == null : r[col] === val));
      return self;
    },
    in: (col: string, vals: unknown[]) => {
      filters.push((r) => vals.includes(r[col]));
      return self;
    },
    order: (col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) => {
      // Ordering is not decoration here: fetchGoals' own comment says the
      // item_id tiebreak exists because heap order is free to reshuffle between
      // identical fetches and a membership diff reads that as a real change. A
      // fake that ignores .order() returns insertion order and hides it.
      orderBy.push({ col, ascending: opts?.ascending !== false, nullsFirst: opts?.nullsFirst })
      return self
    },
    maybeSingle: () => {
      const x = settle() as { data: Row[] | null; error: unknown };
      return Promise.resolve({ data: x.data?.[0] ?? null, error: x.error });
    },
    single: () => {
      const x = settle() as { data: Row[] | null; error: unknown };
      if (x.error) return Promise.resolve({ data: null, error: x.error })
      const row = x.data?.[0] ?? null;
      // supabase-js `.single()` does not throw without .throwOnError(); it
      // returns PGRST116 in the error slot and null data.
      return Promise.resolve(
        row ? { data: row, error: null } : { data: null, error: { code: 'PGRST116' } },
      );
    },
    then: (res: (v: unknown) => void, rej?: (e: unknown) => void) =>
      Promise.resolve(settle()).then(res, rej),
  };
  return self;
}

const serviceClient = { from: (table: string) => builder(table) };

vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: () => serviceClient,
  resolveUserIdFromApiKey: vi.fn(async () => USER),
}));

const USER = 'user-1';
const OTHER = 'user-2';

const post = async (body: unknown) => {
  const { POST } = await import('@/app/api/agent/goals/route');
  return POST(
    new NextRequest('http://localhost/api/agent/goals', {
      method: 'POST',
      headers: { Authorization: 'Bearer k', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
};

const patch = async (id: string, body: unknown) => {
  const { PATCH } = await import('@/app/api/agent/goals/[id]/route');
  return PATCH(
    new NextRequest(`http://localhost/api/agent/goals/${id}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer k', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
};

const del = async (id: string) => {
  const { DELETE } = await import('@/app/api/agent/goals/[id]/route');
  return DELETE(
    new NextRequest(`http://localhost/api/agent/goals/${id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer k' },
    }),
    { params: Promise.resolve({ id }) },
  );
};

const uuid = (n: number) => `${'0'.repeat(8 - String(n).length)}${n}-1111-4111-8111-111111111111`;
const M1 = uuid(1); // one-shot task — milestone material
const C1 = uuid(2); // recurring task — check-in material
const W1 = uuid(3); // plain work
const GONE = uuid(9); // trashed

beforeEach(() => {
  queryLog = [];
  db = {
    goals: [],
    goal_items: [],
    items: [
      { id: M1, user_id: USER, type: 'task', parent_item_id: null, repeat_frequency: null, deleted_at: null },
      { id: C1, user_id: USER, type: 'task', parent_item_id: null, repeat_frequency: 'weekdays', deleted_at: null },
      { id: W1, user_id: USER, type: 'task', parent_item_id: null, repeat_frequency: null, deleted_at: null },
      { id: GONE, user_id: USER, type: 'task', parent_item_id: null, repeat_frequency: null, deleted_at: '2026-08-01T00:00:00Z' },
    ],
  };
});

const rolesOf = (goalId: string) =>
  Object.fromEntries(
    db.goal_items.filter((r) => r.goal_id === goalId).map((r) => [r.item_id, r.role]),
  );

describe('POST /api/agent/goals', () => {
  it('creates a goal and writes each membership with its role', async () => {
    const res = await post({
      name: 'Learn Chinese',
      why: 'so I can talk to my in-laws',
      startsOn: '2026-01-01',
      targetOn: '2027-01-01',
      milestoneIds: [M1],
      checkinIds: [C1],
      memberIds: [W1],
    });
    expect(res.status).toBe(201);
    const { goal } = (await res.json()) as { goal: { id: string } };

    const stored = db.goals[0];
    expect(stored.name).toBe('Learn Chinese');
    expect(stored.user_id).toBe(USER);
    expect(stored.state).toBe('active');
    expect(stored.target_on).toBe('2027-01-01');
    expect(rolesOf(goal.id)).toEqual({ [M1]: 'milestone', [C1]: 'checkin', [W1]: 'member' });
  });

  it('refuses a recurring item as a milestone, before anything is written', async () => {
    const res = await post({ name: 'X', milestoneIds: [C1] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('cannot be a milestone');
    // The refusal is worth nothing if the goal row landed anyway.
    expect(db.goals).toHaveLength(0);
  });

  it('refuses a one-shot item as a check-in', async () => {
    const res = await post({ name: 'X', checkinIds: [M1] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('cannot be a check-in');
    expect(db.goals).toHaveLength(0);
  });

  it('refuses an id that is not this user’s item', async () => {
    db.items.push({ id: uuid(7), user_id: OTHER, type: 'task', parent_item_id: null, repeat_frequency: null });
    const res = await post({ name: 'X', memberIds: [uuid(7)] });
    expect(res.status).toBe(400);
    // "Do not exist" is the truthful answer to give a caller who cannot see
    // another tenant's rows — confirming the id exists elsewhere would leak it.
    expect((await res.json()).error).toContain('do not exist');
    // The sibling refusals assert this; this one used not to.
    expect(db.goals).toHaveLength(0);
  });

  it('refuses a subtask, which cannot join a collection at all', async () => {
    // The registry rule the pickers enforce by only rendering eligible items:
    // a subtask surfaces only inside its parent, so collecting one produces
    // membership the user can neither see nor undo.
    const SUB = uuid(8);
    db.items.push({
      id: SUB, user_id: USER, type: 'task', parent_item_id: M1,
      repeat_frequency: null, deleted_at: null,
    });
    const res = await post({ name: 'X', memberIds: [SUB] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('subtasks belong to their parent');
    expect(db.goals).toHaveLength(0);
  });

  it('refuses a caller-supplied id that already exists', async () => {
    // GoalCreateSchema accepts an id, so a model retrying a create it thinks
    // failed can send one twice. Postgres answers 23505; the handler must not
    // report 201 for a row it did not write.
    const ID = uuid(50);
    db.goals.push({ id: ID, user_id: USER, name: 'Taken', state: 'active', deleted_at: null });
    const res = await post({ name: 'Mine', id: ID });
    expect(res.status).toBe(500);
    expect(db.goals).toHaveLength(1);
    expect(db.goals[0].name).toBe('Taken');
  });

  it('stamps achievedAt for a goal created already achieved', async () => {
    const res = await post({ name: 'Ran a marathon', state: 'achieved' });
    expect(res.status).toBe(201);
    // Not expect.any(String), which accepts "".
    expect(db.goals[0].achieved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('leaves achieved_at null for an ordinary new goal', async () => {
    await post({ name: 'X' });
    expect(db.goals[0].achieved_at).toBeNull();
  });
});

describe('PATCH /api/agent/goals/:id', () => {
  // Real uuids: the columns are `uuid`, so a 'goal-1' would be 22P02 in
  // production and every case here would 404 for the wrong reason.
  const G = uuid(101);
  // A SECOND goal, present in every case. goal_items is one table keyed by
  // user, so "patching goal A deletes goal B's rows" is the likeliest real bug
  // in it — and it is structurally unreachable in a fixture holding one goal.
  const OTHER_GOAL = uuid(102);
  beforeEach(() => {
    db.goals.push(
      { id: G, user_id: USER, name: 'Learn Chinese', state: 'active', achieved_at: null, deleted_at: null },
      { id: OTHER_GOAL, user_id: USER, name: 'Ship the business', state: 'active', achieved_at: null, deleted_at: null },
    );
    db.goal_items.push(
      { goal_id: OTHER_GOAL, item_id: M1, user_id: USER, role: 'milestone', sort_order: 0 },
      { goal_id: OTHER_GOAL, item_id: W1, user_id: USER, role: 'member', sort_order: null },
    );
  });

  const otherGoalUntouched = () =>
    expect(rolesOf(OTHER_GOAL)).toEqual({ [M1]: 'milestone', [W1]: 'member' });

  it('404s on another user’s goal without reading its body', async () => {
    db.goals[0].user_id = OTHER;
    const res = await patch(G, { name: 'Renamed' });
    expect(res.status).toBe(404);
    expect(db.goals[0].name).toBe('Learn Chinese');
  });

  it('404s on a trashed goal', async () => {
    db.goals[0].deleted_at = '2026-08-01T00:00:00Z';
    expect((await patch(G, { name: 'Renamed' })).status).toBe(404);
  });

  it('stamps achieved_at on achieve and does not restamp on a retry', async () => {
    expect((await patch(G, { state: 'achieved' })).status).toBe(200);
    const first = db.goals[0].achieved_at as string;
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Whole-set replacement is designed to be idempotent, so a repeat is
    // expected traffic — and must not drag the achievement date forward.
    expect((await patch(G, { state: 'achieved' })).status).toBe(200);
    expect(db.goals[0].achieved_at).toBe(first);
  });

  it('clears achieved_at when the goal reopens', async () => {
    await patch(G, { state: 'achieved' });
    await patch(G, { state: 'active' });
    expect(db.goals[0].achieved_at).toBeNull();
  });

  it('replaces one role array without disturbing the others', async () => {
    await patch(G, { milestoneIds: [M1], checkinIds: [C1], memberIds: [W1] });
    expect(rolesOf(G)).toEqual({ [M1]: 'milestone', [C1]: 'checkin', [W1]: 'member' });

    await patch(G, { memberIds: [] });
    expect(rolesOf(G)).toEqual({ [M1]: 'milestone', [C1]: 'checkin' });
    // The reconcile's DELETE is scoped to this goal, not to this user.
    otherGoalUntouched();
  });

  it('demotes rather than duplicates when an id moves between roles', async () => {
    await patch(G, { milestoneIds: [M1] });
    await patch(G, { milestoneIds: [], memberIds: [M1] });
    expect(db.goal_items.filter((r) => r.goal_id === G && r.item_id === M1)).toHaveLength(1);
    expect(rolesOf(G)).toEqual({ [M1]: 'member' });
    // The same item is a milestone of the OTHER goal — role is a property of
    // the membership, not the item, and a demotion here must not reach it.
    otherGoalUntouched();
  });

  it('keeps a trashed member the caller could not see', async () => {
    db.goal_items.push({ goal_id: G, item_id: GONE, user_id: USER, role: 'member', sort_order: 0 });
    // items[] on the wire is deleted_at-filtered, so a model rebuilding the
    // list omits the trashed id. Pruning it here would make a restore return
    // the item as a non-member, silently.
    await patch(G, { memberIds: [W1] });
    expect(rolesOf(G)).toEqual({ [W1]: 'member', [GONE]: 'member' });
  });

  it('scopes the trash-keeping to the role being replaced', async () => {
    db.goal_items.push({ goal_id: G, item_id: GONE, user_id: USER, role: 'member', sort_order: 0 });
    // A milestoneIds patch must not resurrect a trashed MEMBER as a milestone.
    await patch(G, { milestoneIds: [M1] });
    expect(rolesOf(G)).toEqual({ [M1]: 'milestone', [GONE]: 'member' });
    otherGoalUntouched();
  });

  it('moves a TRASHED member between roles instead of 500ing', async () => {
    // The review's blocker. The arrays are replaced independently but write ONE
    // join table, so `{milestoneIds: [], memberIds: [X]}` used to have the
    // milestone pass put the trashed X back — and goalMemberRows then refused
    // the whole body for naming X twice. The request is legal by every stated
    // contract (context publishes the id, the overlap refine passes, validation
    // counts trashed items as existing) and the caller had no way to succeed.
    db.goal_items.push({ goal_id: G, item_id: GONE, user_id: USER, role: 'milestone', sort_order: 0 });
    const res = await patch(G, { milestoneIds: [], memberIds: [GONE] });
    expect(res.status).toBe(200);
    expect(rolesOf(G)).toEqual({ [GONE]: 'member' });
  });

  it('moves a trashed member the other way too', async () => {
    db.goal_items.push({ goal_id: G, item_id: GONE, user_id: USER, role: 'member', sort_order: null });
    const res = await patch(G, { memberIds: [], milestoneIds: [GONE] });
    expect(res.status).toBe(200);
    expect(rolesOf(G)).toEqual({ [GONE]: 'milestone' });
  });

  it('still keeps a trashed id the body does not mention at all', async () => {
    // The exclusion must not become a blanket "stop keeping trashed members".
    db.goal_items.push({ goal_id: G, item_id: GONE, user_id: USER, role: 'member', sort_order: null });
    await patch(G, { memberIds: [W1], milestoneIds: [M1] });
    expect(rolesOf(G)).toEqual({ [W1]: 'member', [M1]: 'milestone', [GONE]: 'member' });
  });

  it('refuses the pause verb with a pointer at the alternatives', async () => {
    const res = await patch(G, { paused: true });
    expect(res.status).toBe(400);
    // The refusal MESSAGE, read out of the field Zod puts it in — a substring
    // match on the whole serialised body would pass on any key that merely
    // happens to contain the word. `details` is what carries the pointer, and
    // the pointer is the entire reason the key is carried to be refused.
    const body = (await res.json()) as {
      error: string
      details: { fieldErrors: Record<string, string[]> }
    };
    expect(body.error).toBe('Validation failed');
    const message = body.details.fieldErrors.state.join(' ');
    expect(message).toContain('season');
    expect(message).toContain("state: 'achieved'");
    expect(db.goals[0].state).toBe('active');
  });

  it('refuses a caller-chosen achievedAt', async () => {
    const res = await patch(G, { achievedAt: '2020-01-01T00:00:00Z' });
    expect(res.status).toBe(400);
    expect(db.goals[0].achieved_at).toBeNull();
  });

  it('refuses a body that gives one id two roles', async () => {
    const res = await patch(G, { milestoneIds: [M1], memberIds: [M1] });
    expect(res.status).toBe(400);
    expect(db.goal_items.filter((r) => r.goal_id === G)).toHaveLength(0);
    otherGoalUntouched();
  });
});

describe('DELETE /api/agent/goals/:id', () => {
  const G = uuid(101);
  beforeEach(() => {
    db.goals.push({ id: G, user_id: USER, name: 'X', state: 'active', deleted_at: null });
    db.goal_items.push({ goal_id: G, item_id: M1, user_id: USER, role: 'milestone', sort_order: 0 });
  });

  it('soft-deletes and leaves the membership rows — with their roles — intact', async () => {
    expect((await del(G)).status).toBe(200);
    expect(db.goals[0].deleted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Restoring a goal whose members came back as plain 'member' would zero
    // its progress denominator without saying so.
    expect(rolesOf(G)).toEqual({ [M1]: 'milestone' });
  });

  it('404s on another user’s goal and deletes nothing', async () => {
    db.goals[0].user_id = OTHER;
    expect((await del(G)).status).toBe(404);
    expect(db.goals[0].deleted_at).toBeNull();
  });
});

/**
 * Decision 3's SECOND enforcement point.
 *
 * The store demotes an invalidated role on the UI path with a receipt toast.
 * An agent PATCH is the other way `repeatFrequency` flips, and until this
 * existed an OpenClaw write could make a milestone recurring with nothing
 * taking the role back — a row whose scalar status migration 016 has frozen, so
 * the goal reads permanently behind with nothing to click.
 */
describe('the agent item PATCH demotes a role its own edit invalidated', () => {
  const G = uuid(101);
  beforeEach(() => {
    db.goals.push({ id: G, user_id: USER, name: 'Learn Chinese', state: 'active', deleted_at: null });
  });

  const patchTask = async (id: string, body: unknown) => {
    const { PATCH } = await import('@/app/api/agent/tasks/[id]/route');
    return PATCH(
      new NextRequest(`http://localhost/api/agent/tasks/${id}`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer k', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
  };

  it('demotes a milestone that has just been made recurring', async () => {
    db.goal_items.push({ goal_id: G, item_id: M1, user_id: USER, role: 'milestone', sort_order: 3 });
    const res = await patchTask(M1, { repeatFrequency: 'weekdays' });
    expect(res.status).toBe(200);
    // The edit itself is never blocked — a goal must not constrain its members.
    expect(db.items.find((i) => i.id === M1)!.repeat_frequency).toBe('weekdays');
    expect(rolesOf(G)).toEqual({ [M1]: 'member' });
    expect(await res.json()).toEqual({ success: true, demoted: [{ goalId: G, from: 'milestone' }] });
    // The ordinal goes with the role. goalMemberRows emits sort_order as null
    // off the member array, and a demoted row that kept a milestone's ordinal
    // would sort ahead of every real member for good.
    expect(db.goal_items.find((r) => r.item_id === M1)!.sort_order).toBeNull();
  });

  it('demotes a check-in that has just stopped recurring — the mirror case', async () => {
    db.goal_items.push({ goal_id: G, item_id: C1, user_id: USER, role: 'checkin', sort_order: 0 });
    // Clearing the field, not setting it to a value: `in` rather than
    // truthiness is what makes this reach the scan at all.
    await patchTask(C1, { repeatFrequency: 'none' });
    expect(rolesOf(G)).toEqual({ [C1]: 'member' });
  });

  it('leaves a still-valid role alone', async () => {
    db.goal_items.push({ goal_id: G, item_id: C1, user_id: USER, role: 'checkin', sort_order: 0 });
    await patchTask(C1, { repeatFrequency: 'daily' });
    expect(rolesOf(G)).toEqual({ [C1]: 'checkin' });
  });

  it('does not scan when the patch cannot invalidate anything', async () => {
    db.goal_items.push({ goal_id: G, item_id: M1, user_id: USER, role: 'milestone', sort_order: 0 });
    const res = await patchTask(M1, { title: 'HSK 3 exam, rescheduled' });
    expect(await res.json()).toEqual({ success: true });
    expect(rolesOf(G)).toEqual({ [M1]: 'milestone' });
    // Asserted against the QUERY LOG, not the outcome. The outcome is
    // byte-identical whether the scan ran or not, so an outcome-only assertion
    // would stay green with the gate deleted — and deleting it doubles the
    // round-trips on the hottest agent write path.
    expect(queryLog.some((q) => q.table === 'goal_items')).toBe(false);
  });

  it('DOES scan when the patch touches recurrence', async () => {
    db.goal_items.push({ goal_id: G, item_id: W1, user_id: USER, role: 'member', sort_order: null });
    queryLog = [];
    await patchTask(W1, { repeatFrequency: 'daily' });
    expect(queryLog.some((q) => q.table === 'goal_items' && q.op === 'select')).toBe(true);
  });
});

/**
 * The read side, over rows the WRITE side actually produced.
 *
 * Every assertion above reads `db.goal_items` directly, which is why the stale
 * `sort_order` the review found could hide: the ordinal only matters once
 * fetchGoals turns rows back into three arrays. This closes the loop.
 */
describe('what the routes write is what fetchGoals serves back', () => {
  it('round-trips all three roles, and a demoted milestone does not jump the queue', async () => {
    const { fetchGoals } = await import('@/lib/db');
    const created = await post({
      name: 'Learn Chinese',
      milestoneIds: [M1],
      checkinIds: [C1],
      memberIds: [W1],
    });
    const { goal } = (await created.json()) as { goal: { id: string } };

    let goals = (await fetchGoals(USER, serviceClient as never))!;
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({
      name: 'Learn Chinese',
      state: 'active',
      milestoneIds: [M1],
      checkinIds: [C1],
      memberIds: [W1],
    });

    // Make the milestone recurring through the agent item route: it demotes,
    // and must land BEHIND the existing member rather than ahead of it.
    const { PATCH } = await import('@/app/api/agent/tasks/[id]/route');
    await PATCH(
      new NextRequest(`http://localhost/api/agent/tasks/${M1}`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer k', 'Content-Type': 'application/json' },
        body: JSON.stringify({ repeatFrequency: 'weekdays' }),
      }),
      { params: Promise.resolve({ id: M1 }) },
    );

    goals = (await fetchGoals(USER, serviceClient as never))!;
    expect(goals[0].milestoneIds).toEqual([]);
    // Both rows now carry a null sort_order, so the item_id tiebreak decides —
    // which is the whole point: the demoted row took a POSITION rather than
    // keeping the milestone ordinal that would have pinned it to the front
    // regardless of what else the goal holds.
    expect(goals[0].memberIds).toEqual([M1, W1].sort());
    expect(goal.id).toBe(goals[0].id);

    // And the stale-ordinal failure the review found, stated directly.
    expect(db.goal_items.find((r) => r.item_id === M1)!.sort_order).toBeNull();
  });
});
