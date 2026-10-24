import { describe, it, expect, vi } from 'vitest';

/**
 * How a routine's or a season's members reach their join table: the web's
 * whole-list write (lib/db.ts reconcileMembership, through updateRoutine and
 * updateSeason), and the iPhone's one-row writes (addContainerMember,
 * removeContainerMember, behind the `collect` action).
 *
 * The first block was written against reconcileMembership as it stood before
 * the 2f brief's race fix, and is kept unedited across it and across O6: it
 * pins every call a write with no `known` makes, row for row, so neither fix
 * changes a create, the agent API's PATCH or an undo of a trash.
 *
 * O6 (a stale tab keeps another device's routine order) changed what a web
 * tab with `known` sends for a routine: the rewritten block says how, and the
 * order block after it states the outcome on a small routine_items table,
 * written first against the code before the change for what must stay (a
 * reorder, the undo of a removal, no `known`). O7 gave a season's routineIds
 * the same `known` as its items.
 *
 * O12 and O13 add the iPhone's other two one-row writes: a routine's order,
 * one filtered UPDATE per member out of place (setRoutineMemberOrder, behind
 * `moveMember`), and a season's routine holds (addSeasonRoutine,
 * removeSeasonRoutine, behind `holdRoutine`). Their outcomes against a table
 * in flux are pinned through the route in app-containers.test.ts; here, the
 * calls they make.
 *
 * The client is a recorder, not a fake database: each query keeps its table
 * and every builder call in order, and answers what the test says, so a call
 * added, dropped or reordered shows here.
 */

vi.mock('@/lib/supabase', () => ({ createClient: () => ({}) }));
vi.mock('@/lib/openclaw-registry', () => ({ notifyPlugins: vi.fn() }));

import {
  addContainerMember,
  addSeasonRoutine,
  fetchRoutineMemberPlaces,
  removeContainerMember,
  removeSeasonRoutine,
  setRoutineMemberOrder,
  updateRoutine,
  updateSeason,
} from '@/lib/db';

const USER = 'user-1';

type Step = [method: string, ...args: unknown[]];
interface Query {
  table: string;
  steps: Step[];
}
interface Answer {
  data?: unknown;
  error?: { code: string; message?: string } | null;
}

const METHODS = ['select', 'eq', 'in', 'is', 'upsert', 'insert', 'delete', 'update', 'order', 'limit', 'maybeSingle'];

/** A client that records each query and answers it with `respond`, read when the query is awaited. */
function recorder(respond: (q: Query) => Answer | undefined = () => undefined) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const q: Query = { table, steps: [] };
      queries.push(q);
      const chain: Record<string, unknown> = {};
      for (const m of METHODS) {
        chain[m] = (...args: unknown[]) => {
          q.steps.push([m, ...args]);
          return chain;
        };
      }
      chain.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        Promise.resolve()
          .then(() => {
            const a = respond(q) ?? {};
            return { data: a.data ?? null, error: a.error ?? null };
          })
          .then(onFulfilled, onRejected);
      return chain;
    },
  };
  return { client, queries };
}

const verb = (q: Query) => q.steps[0]?.[0];

/** The join table holding `ids` (as the reconcile's select reads them); every write answered ok. */
const holding =
  (ids: string[], over: (q: Query) => Answer | undefined = () => undefined) =>
  (q: Query): Answer | undefined =>
    over(q) ?? (verb(q) === 'select' ? { data: ids.map((item_id) => ({ item_id })) } : undefined);

const routineRow = (item_id: string, sort_order: number) => ({
  routine_id: 'r1',
  item_id,
  user_id: USER,
  sort_order,
});
const seasonRow = (item_id: string) => ({ season_id: 'p1', item_id, user_id: USER });

const routineRead: Query = {
  table: 'routine_items',
  steps: [['select', 'item_id'], ['eq', 'routine_id', 'r1'], ['eq', 'user_id', USER]],
};
const seasonRead: Query = {
  table: 'season_items',
  steps: [['select', 'item_id'], ['eq', 'season_id', 'p1'], ['eq', 'user_id', USER]],
};
const routineUpsert = (...rows: ReturnType<typeof routineRow>[]): Query => ({
  table: 'routine_items',
  steps: [['upsert', rows, { onConflict: 'routine_id,item_id' }]],
});
const routineUpsertOne = (row: ReturnType<typeof routineRow>): Query => ({
  table: 'routine_items',
  steps: [['upsert', row, { onConflict: 'routine_id,item_id' }]],
});
const seasonUpsert = (...rows: ReturnType<typeof seasonRow>[]): Query => ({
  table: 'season_items',
  steps: [['upsert', rows, { onConflict: 'season_id,item_id' }]],
});
const routineDelete = (...ids: string[]): Query => ({
  table: 'routine_items',
  steps: [['delete'], ['eq', 'routine_id', 'r1'], ['eq', 'user_id', USER], ['in', 'item_id', ids]],
});
const seasonDelete = (...ids: string[]): Query => ({
  table: 'season_items',
  steps: [['delete'], ['eq', 'season_id', 'p1'], ['eq', 'user_id', USER], ['in', 'item_id', ids]],
});

/** A routine's join rows with their places, as a read with `known` asks for them; every write answered ok. */
const placed =
  (rows: [string, number | null][], over: (q: Query) => Answer | undefined = () => undefined) =>
  (q: Query): Answer | undefined =>
    over(q) ??
    (verb(q) === 'select' ? { data: rows.map(([item_id, sort_order]) => ({ item_id, sort_order })) } : undefined);
/** With `known`, a routine reads each row's place too. */
const routinePlacesRead: Query = {
  table: 'routine_items',
  steps: [['select', 'item_id, sort_order'], ['eq', 'routine_id', 'r1'], ['eq', 'user_id', USER]],
};
const routineAdded = (item_id: string, sort_order: number | null) => ({ routine_id: 'r1', item_id, user_id: USER, sort_order });
/** The additions of a routine whose order stands: ON CONFLICT DO NOTHING. */
const routineInsert = (...rows: ReturnType<typeof routineAdded>[]): Query => ({
  table: 'routine_items',
  steps: [['upsert', rows, { onConflict: 'routine_id,item_id', ignoreDuplicates: true }]],
});
const routineInsertOne = (row: ReturnType<typeof routineAdded>): Query => ({
  table: 'routine_items',
  steps: [['upsert', row, { onConflict: 'routine_id,item_id', ignoreDuplicates: true }]],
});

describe('reconcileMembership, as one web tab writes it', () => {
  it('a routine: one read, one upsert of the whole list in its order, one delete of the rest', async () => {
    const { client, queries } = recorder(holding(['a', 'c']));
    await updateRoutine(USER, 'r1', { itemIds: ['a', 'b'] }, client);
    expect(queries).toEqual([
      routineRead,
      routineUpsert(routineRow('a', 0), routineRow('b', 1)),
      routineDelete('c'),
    ]);
  });

  it('a season: the same, with no sort_order', async () => {
    const { client, queries } = recorder(holding(['a', 'c']));
    await updateSeason(USER, 'p1', { itemIds: ['a', 'b'] }, client);
    expect(queries).toEqual([seasonRead, seasonUpsert(seasonRow('a'), seasonRow('b')), seasonDelete('c')]);
  });

  it('a 23503 on the upsert falls back to one upsert per row, skipping the purged one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let upserts = 0;
    const { client, queries } = recorder(
      holding(['a', 'c'], (q) => {
        if (verb(q) !== 'upsert') return undefined;
        upserts += 1;
        // The whole list, then b alone: b was purged since the tab read it.
        return upserts === 1 || upserts === 3 ? { error: { code: '23503' } } : undefined;
      }),
    );
    await updateRoutine(USER, 'r1', { itemIds: ['a', 'b'] }, client);
    expect(queries).toEqual([
      routineRead,
      routineUpsert(routineRow('a', 0), routineRow('b', 1)),
      routineUpsertOne(routineRow('a', 0)),
      routineUpsertOne(routineRow('b', 1)),
      routineDelete('c'),
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('any other upsert error is thrown, and nothing is deleted', async () => {
    const { client, queries } = recorder(
      holding(['a', 'c'], (q) => (verb(q) === 'upsert' ? { error: { code: '42501' } } : undefined)),
    );
    await expect(updateRoutine(USER, 'r1', { itemIds: ['a', 'b'] }, client)).rejects.toMatchObject({
      code: '42501',
    });
    expect(queries).toEqual([routineRead, routineUpsert(routineRow('a', 0), routineRow('b', 1))]);
  });

  it('an empty list deletes every stored member and upserts nothing', async () => {
    const { client, queries } = recorder(holding(['a', 'c']));
    await updateRoutine(USER, 'r1', { itemIds: [] }, client);
    expect(queries).toEqual([routineRead, routineDelete('a', 'c')]);
  });

  it('a list already stored is upserted again (its order rewritten) and deletes nothing', async () => {
    const { client, queries } = recorder(holding(['b', 'a']));
    await updateRoutine(USER, 'r1', { itemIds: ['a', 'b'] }, client);
    expect(queries).toEqual([routineRead, routineUpsert(routineRow('a', 0), routineRow('b', 1))]);
  });

  it('a write with no itemIds never reads the join table', async () => {
    const { client, queries } = recorder();
    await updateRoutine(USER, 'r1', { name: 'Mornings' }, client);
    expect(queries.map((q) => q.table)).toEqual(['routines']);
  });
});

describe("reconcileMembership's known: a web tab writes only its own change", () => {
  // The routine expectations here were rewritten for O6 (a stale tab keeps
  // another device's routine order): with `known`, a routine reads each row's
  // place, and a write that adds or removes without reordering inserts its
  // additions after the highest place and rewrites no kept row. A season,
  // which has no order, sends exactly what it sent before.
  it('with known equal to what is stored: a routine inserts its additions last and rewrites no kept row; a season as before', async () => {
    const r = recorder(placed([['a', 0], ['c', 1]]));
    await updateRoutine(USER, 'r1', { itemIds: ['a', 'b'] }, r.client, { itemIds: ['a', 'c'] });
    expect(r.queries).toEqual([routinePlacesRead, routineInsert(routineAdded('b', 2)), routineDelete('c')]);

    const s = recorder(holding(['a', 'c']));
    await updateSeason(USER, 'p1', { itemIds: ['a', 'b'] }, s.client, { itemIds: ['a', 'c'] });
    expect(s.queries).toEqual([seasonRead, seasonUpsert(seasonRow('a'), seasonRow('b')), seasonDelete('c')]);

    const empty = recorder(placed([['a', 0], ['c', 1]]));
    await updateRoutine(USER, 'r1', { itemIds: [] }, empty.client, { itemIds: ['a', 'c'] });
    expect(empty.queries).toEqual([routinePlacesRead, routineDelete('a', 'c')]);
  });

  it("keeps a member the phone added since the tab's read, and puts the tab's add after it", async () => {
    // The tab knows [a] and adds b; the phone had added x.
    const { client, queries } = recorder(placed([['a', 0], ['x', 1]]));
    await updateRoutine(USER, 'r1', { itemIds: ['a', 'b'] }, client, { itemIds: ['a'] });
    expect(queries).toEqual([routinePlacesRead, routineInsert(routineAdded('b', 2))]);
  });

  it('does not put back a member the phone took out', async () => {
    // The tab knows [a, b] and removes a; the phone had removed b.
    const { client, queries } = recorder(placed([['a', 0]]));
    await updateRoutine(USER, 'r1', { itemIds: ['b'] }, client, { itemIds: ['a', 'b'] });
    expect(queries).toEqual([routinePlacesRead, routineDelete('a')]);
  });

  it("removes only the tab's own removal", async () => {
    // The tab knows [a] and removes it; the phone had added x.
    const { client, queries } = recorder(placed([['a', 0], ['x', 1]]));
    await updateRoutine(USER, 'r1', { itemIds: [] }, client, { itemIds: ['a'] });
    expect(queries).toEqual([routinePlacesRead, routineDelete('a')]);
  });

  it('a kept member keeps its stored place, and the add goes after the highest one', async () => {
    // The tab knows [a, b, c] and adds d; the phone had removed b.
    const { client, queries } = recorder(placed([['a', 0], ['c', 2]]));
    await updateRoutine(USER, 'r1', { itemIds: ['a', 'b', 'c', 'd'] }, client, { itemIds: ['a', 'b', 'c'] });
    expect(queries).toEqual([routinePlacesRead, routineInsert(routineAdded('d', 3))]);
  });

  it('additions take no place where any member has none, and the first in an empty routine is 0', async () => {
    const unplaced = recorder(placed([['a', null], ['c', 4]]));
    await updateRoutine(USER, 'r1', { itemIds: ['a', 'c', 'd', 'e'] }, unplaced.client, { itemIds: ['a', 'c'] });
    expect(unplaced.queries).toEqual([routinePlacesRead, routineInsert(routineAdded('d', null), routineAdded('e', null))]);

    const fresh = recorder(placed([]));
    await updateRoutine(USER, 'r1', { itemIds: ['d', 'e'] }, fresh.client, { itemIds: [] });
    expect(fresh.queries).toEqual([routinePlacesRead, routineInsert(routineAdded('d', 0), routineAdded('e', 1))]);
  });

  it('an add the phone already made is not written again', async () => {
    // The tab knows [a] and adds x; the phone had added x too.
    const { client, queries } = recorder(placed([['a', 0], ['x', 1]]));
    await updateRoutine(USER, 'r1', { itemIds: ['a', 'x'] }, client, { itemIds: ['a'] });
    expect(queries).toEqual([routinePlacesRead]);
  });

  it('a 23503 on the insert falls back to one insert per row, skipping the purged one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let upserts = 0;
    const { client, queries } = recorder(
      placed([['a', 0]], (q) => {
        if (verb(q) !== 'upsert') return undefined;
        upserts += 1;
        return upserts === 1 || upserts === 2 ? { error: { code: '23503' } } : undefined;
      }),
    );
    await updateRoutine(USER, 'r1', { itemIds: ['a', 'b', 'c'] }, client, { itemIds: ['a'] });
    expect(queries).toEqual([
      routinePlacesRead,
      routineInsert(routineAdded('b', 1), routineAdded('c', 2)),
      routineInsertOne(routineAdded('b', 1)),
      routineInsertOne(routineAdded('c', 2)),
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('a tab that reorders still writes the whole order, skipping what the phone removed', async () => {
    // The tab knows [a, b, c] and moves c first; the phone had removed b.
    const { client, queries } = recorder(placed([['a', 0], ['c', 2]]));
    await updateRoutine(USER, 'r1', { itemIds: ['c', 'a', 'b'] }, client, { itemIds: ['a', 'b', 'c'] });
    expect(queries).toEqual([routinePlacesRead, routineUpsert(routineRow('c', 0), routineRow('a', 1))]);
  });

  it('a season keeps the phone\'s add and its remove alike', async () => {
    // The tab knows [a, b] and adds c; the phone had removed b and added x.
    const { client, queries } = recorder(holding(['a', 'x']));
    await updateSeason(USER, 'p1', { itemIds: ['a', 'b', 'c'] }, client, { itemIds: ['a', 'b'] });
    expect(queries).toEqual([seasonRead, seasonUpsert(seasonRow('a'), seasonRow('c'))]);
  });

  it('the window it leaves open: an upsert still names every member the tab kept, so a routine remove no longer upserts', async () => {
    // Pinned so nobody reads more into `known` than it gives (the 2f brief's
    // §3.10). A routine whose order stands sends no upsert at all (O6): the
    // tab removes a from [a, m] with one delete, and a phone removal of m
    // that lands after this read stays removed.
    const r = recorder(placed([['a', 0], ['m', 1]]));
    await updateRoutine(USER, 'r1', { itemIds: ['m'] }, r.client, { itemIds: ['a', 'm'] });
    expect(r.queries).toEqual([routinePlacesRead, routineDelete('a')]);
    // A season still upserts what the tab kept: this read sees [a, m], so the
    // upsert names m, and a phone removal of m that lands after this read and
    // before this upsert, one round trip, is put back by it. PostgREST has no
    // transaction to hold the two statements together.
    const s = recorder(holding(['a', 'm']));
    await updateSeason(USER, 'p1', { itemIds: ['m'] }, s.client, { itemIds: ['a', 'm'] });
    expect(s.queries).toEqual([seasonRead, seasonUpsert(seasonRow('m')), seasonDelete('a')]);
  });

  it('without known (a create, the agent API, an undo of a trash), the stored list is overwritten, as before', async () => {
    const r = recorder(holding(['a', 'x']));
    await updateRoutine(USER, 'r1', { itemIds: ['a', 'b'] }, r.client);
    expect(r.queries).toEqual([
      routineRead,
      routineUpsert(routineRow('a', 0), routineRow('b', 1)),
      routineDelete('x'),
    ]);

    const s = recorder(holding(['a', 'x']));
    await updateSeason(USER, 'p1', { itemIds: ['b'] }, s.client, {});
    expect(s.queries).toEqual([seasonRead, seasonUpsert(seasonRow('b')), seasonDelete('a', 'x')]);
  });

});

describe("a season's routineIds take known too (O7)", () => {
  const holdsRead: Query = {
    table: 'season_routines',
    steps: [['select', 'routine_id'], ['eq', 'season_id', 'p1'], ['eq', 'user_id', USER]],
  };
  const holdsUpsert = (...ids: string[]): Query => ({
    table: 'season_routines',
    steps: [
      ['upsert', ids.map((routine_id) => ({ season_id: 'p1', routine_id, user_id: USER })), { onConflict: 'season_id,routine_id' }],
    ],
  });
  const holdsDelete = (...ids: string[]): Query => ({
    table: 'season_routines',
    steps: [['delete'], ['eq', 'season_id', 'p1'], ['eq', 'user_id', USER], ['in', 'routine_id', ids]],
  });
  const holding = (ids: string[]) => (q: Query): Answer | undefined =>
    verb(q) === 'select' ? { data: ids.map((routine_id) => ({ routine_id })) } : undefined;

  it('a hold the phone added since the tab read the season is kept by a stale web edit', async () => {
    // The tab knows [r1] and adds r2; the phone had added rP.
    const { client, queries } = recorder(holding(['r1', 'rP']));
    await updateSeason(USER, 'p1', { routineIds: ['r1', 'r2'] }, client, { routineIds: ['r1'] });
    expect(queries).toEqual([holdsRead, holdsUpsert('r1', 'r2')]);
  });

  it('a hold the phone took out is not put back', async () => {
    // The tab knows [r1, r2] and adds r3; the phone had taken r2 out.
    const { client, queries } = recorder(holding(['r1']));
    await updateSeason(USER, 'p1', { routineIds: ['r1', 'r2', 'r3'] }, client, { routineIds: ['r1', 'r2'] });
    expect(queries).toEqual([holdsRead, holdsUpsert('r1', 'r3')]);
  });

  it("a web removal is removed, and only the tab's own", async () => {
    // The tab knows [r1, r2] and takes r2 out; the phone had added rP.
    const known = recorder(holding(['r1', 'r2', 'rP']));
    await updateSeason(USER, 'p1', { routineIds: ['r1'] }, known.client, { routineIds: ['r1', 'r2'] });
    expect(known.queries).toEqual([holdsRead, holdsUpsert('r1'), holdsDelete('r2')]);

    // Before O7 (no known), the same edit took the phone's hold with it.
    const whole = recorder(holding(['r1', 'r2', 'rP']));
    await updateSeason(USER, 'p1', { routineIds: ['r1'] }, whole.client);
    expect(whole.queries).toEqual([holdsRead, holdsUpsert('r1'), holdsDelete('r2', 'rP')]);
  });

  it('each list takes its own known: an item edit names no hold, a hold edit no item', async () => {
    const { client, queries } = recorder((q) =>
      verb(q) === 'select'
        ? { data: q.table === 'season_items' ? [{ item_id: 'a' }, { item_id: 'x' }] : [{ routine_id: 'r1' }, { routine_id: 'rP' }] }
        : undefined,
    );
    await updateSeason(
      USER,
      'p1',
      { itemIds: ['a', 'b'], routineIds: ['r1', 'r2'] },
      client,
      { itemIds: ['a'], routineIds: ['r1'] },
    );
    expect(queries).toEqual([seasonRead, seasonUpsert(seasonRow('a'), seasonRow('b')), holdsRead, holdsUpsert('r1', 'r2')]);
  });
});

/**
 * routine_items for routine r1 as a table the recorder's queries act on: the
 * reconcile's read (projected to the columns it asks for), an upsert (an
 * update on conflict, or nothing with `ignoreDuplicates`), a plain insert (a
 * 23505 on conflict, as Postgres answers) and a delete by `in`. `between`
 * runs once, straight after the first read is answered: another device's
 * write landing in the gap before this call's own writes. `order()` is the
 * members as every read lists them: sort_order nulls last, then item_id.
 */
function routineTable(initial: [string, number | null][], between?: (rows: StoredRow[]) => void) {
  const rows: StoredRow[] = initial.map(([item_id, sort_order]) => ({ item_id, sort_order }));
  let read = false;
  const put = (row: Record<string, unknown>, onConflict: 'update' | 'nothing' | 'error'): Answer | undefined => {
    const hit = rows.find((r) => r.item_id === row.item_id);
    if (!hit) {
      rows.push({ item_id: row.item_id as string, sort_order: (row.sort_order as number | null | undefined) ?? null });
      return undefined;
    }
    if (onConflict === 'error') return { error: { code: '23505' } };
    if (onConflict === 'update' && 'sort_order' in row) hit.sort_order = row.sort_order as number | null;
    return undefined;
  };
  const respond = (q: Query): Answer | undefined => {
    const [name, ...args] = q.steps[0];
    if (name === 'select') {
      const columns = String(args[0]).split(',').map((c) => c.trim());
      const data = rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c as keyof StoredRow]])));
      if (!read) {
        read = true;
        between?.(rows);
      }
      return { data };
    }
    if (name === 'upsert' || name === 'insert') {
      const opts = args[1] as { ignoreDuplicates?: boolean } | undefined;
      const mode = name === 'insert' ? 'error' : opts?.ignoreDuplicates ? 'nothing' : 'update';
      for (const row of [args[0]].flat() as Record<string, unknown>[]) {
        const answer = put(row, mode);
        if (answer) return answer;
      }
      return undefined;
    }
    if (name === 'delete') {
      const ids = q.steps.find((s) => s[0] === 'in')?.[2] as string[];
      for (const memberId of ids) {
        const i = rows.findIndex((r) => r.item_id === memberId);
        if (i >= 0) rows.splice(i, 1);
      }
    }
    return undefined;
  };
  const order = () =>
    [...rows]
      .sort((a, b) =>
        a.sort_order === b.sort_order
          ? a.item_id.localeCompare(b.item_id)
          : a.sort_order === null
            ? 1
            : b.sort_order === null
              ? -1
              : a.sort_order - b.sort_order,
      )
      .map((r) => r.item_id);
  return { respond, order, rows };
}
interface StoredRow {
  item_id: string;
  sort_order: number | null;
}

describe("reconcileMembership's known keeps another device's routine order", () => {
  // The tab's order is what it read, plus its own change. A reorder made on
  // the phone since (one sort_order per moved row, O12's moveMember) is not
  // the tab's to undo: a tab that only adds or removes keeps every stored
  // place, and only a tab that itself reorders writes the whole order.

  it('a phone reorder, then a stale tab adds: the reorder is kept, the add goes last', async () => {
    // The tab read [a, b, c]; the phone moved c to the top since.
    const t = routineTable([['c', 0], ['a', 1], ['b', 2]]);
    const { client } = recorder(t.respond);
    await updateRoutine(USER, 'r1', { itemIds: ['a', 'b', 'c', 'd'] }, client, { itemIds: ['a', 'b', 'c'] });
    expect(t.order()).toEqual(['c', 'a', 'b', 'd']);
  });

  it('a phone reorder, then a stale tab removes: the reorder is kept', async () => {
    const t = routineTable([['c', 0], ['a', 1], ['b', 2]]);
    const { client } = recorder(t.respond);
    await updateRoutine(USER, 'r1', { itemIds: ['a', 'c'] }, client, { itemIds: ['a', 'b', 'c'] });
    expect(t.order()).toEqual(['c', 'a']);
  });

  it('a tab that reorders writes its order', async () => {
    const t = routineTable([['a', 0], ['b', 1], ['c', 2]]);
    const { client } = recorder(t.respond);
    await updateRoutine(USER, 'r1', { itemIds: ['c', 'a', 'b'] }, client, { itemIds: ['a', 'b', 'c'] });
    expect(t.order()).toEqual(['c', 'a', 'b']);
  });

  it("the web's undo of a removal puts the item back in its old place, not last", async () => {
    // Remove b from [a, b, c], then ⌘Z: syncContainers sends the restored
    // list with the list it held before the undo as known.
    const t = routineTable([['a', 0], ['b', 1], ['c', 2]]);
    await updateRoutine(USER, 'r1', { itemIds: ['a', 'c'] }, recorder(t.respond).client, { itemIds: ['a', 'b', 'c'] });
    expect(t.order()).toEqual(['a', 'c']);
    await updateRoutine(USER, 'r1', { itemIds: ['a', 'b', 'c'] }, recorder(t.respond).client, { itemIds: ['a', 'c'] });
    expect(t.order()).toEqual(['a', 'b', 'c']);
  });

  it('an add placed before a member the tab kept is a reorder, and writes the whole order', async () => {
    const t = routineTable([['b', 0], ['c', 1]]);
    const { client } = recorder(t.respond);
    await updateRoutine(USER, 'r1', { itemIds: ['a', 'b', 'c'] }, client, { itemIds: ['b', 'c'] });
    expect(t.order()).toEqual(['a', 'b', 'c']);
  });

  it('a phone collect of the same item between the read and the insert is no error, and keeps its place', async () => {
    // The tab read [a, b] and adds x, which it would place at 2. Since its
    // read the phone collected y (placed 2), then x (placed 3). An update on
    // conflict would move x to 2, ahead of y; DO NOTHING keeps the phone's 3.
    const t = routineTable([['a', 0], ['b', 1]], (rows) =>
      rows.push({ item_id: 'y', sort_order: 2 }, { item_id: 'x', sort_order: 3 }),
    );
    const { client } = recorder(t.respond);
    await expect(
      updateRoutine(USER, 'r1', { itemIds: ['a', 'b', 'x'] }, client, { itemIds: ['a', 'b'] }),
    ).resolves.toBeUndefined();
    expect(t.order()).toEqual(['a', 'b', 'y', 'x']);
    expect(t.rows.filter((r) => r.item_id === 'x')).toEqual([{ item_id: 'x', sort_order: 3 }]);
  });

  it('without known, the stored order is made to equal the list, as before', async () => {
    const t = routineTable([['c', 0], ['a', 1], ['b', 2]]);
    const { client } = recorder(t.respond);
    await updateRoutine(USER, 'r1', { itemIds: ['a', 'b', 'c', 'd'] }, client);
    expect(t.order()).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('addContainerMember: one row, last in a routine', () => {
  const lastPlace: Query = {
    table: 'routine_items',
    steps: [
      ['select', 'sort_order'],
      ['eq', 'routine_id', 'r1'],
      ['eq', 'user_id', USER],
      ['order', 'sort_order', { ascending: false, nullsFirst: true }],
      ['limit', 1],
    ],
  };
  const insert = (row: Record<string, unknown>): Query => ({ table: 'routine_items', steps: [['insert', row]] });
  /** The last place read answers `orders`, highest first as the query asks, nulls before. */
  const routineWith = (orders: (number | null)[]) => (q: Query): Answer | undefined =>
    verb(q) === 'select'
      ? {
          data: [...orders]
            .sort((a, b) => (a === null ? -1 : b === null ? 1 : b - a))
            .slice(0, 1)
            .map((sort_order) => ({ sort_order })),
        }
      : undefined;

  it('goes after the highest place', async () => {
    const { client, queries } = recorder(routineWith([0, 3]));
    expect(await addContainerMember(USER, 'routine', 'r1', 'x', client)).toBe(true);
    expect(queries).toEqual([lastPlace, insert({ routine_id: 'r1', item_id: 'x', user_id: USER, sort_order: 4 })]);
  });

  it('is first, at 0, in an empty routine', async () => {
    const { client, queries } = recorder(routineWith([]));
    await addContainerMember(USER, 'routine', 'r1', 'x', client);
    expect(queries).toEqual([lastPlace, insert({ routine_id: 'r1', item_id: 'x', user_id: USER, sort_order: 0 })]);
  });

  it('takes no place where any member has none, and sorts among them by its id', async () => {
    for (const orders of [[null], [null, null], [0, null, 3]]) {
      const { client, queries } = recorder(routineWith(orders));
      await addContainerMember(USER, 'routine', 'r1', 'x', client);
      expect(queries).toEqual([
        lastPlace,
        insert({ routine_id: 'r1', item_id: 'x', user_id: USER, sort_order: null }),
      ]);
    }
  });

  it('a season inserts with no sort_order, and reads no place', async () => {
    const { client, queries } = recorder();
    expect(await addContainerMember(USER, 'season', 'p1', 'x', client)).toBe(true);
    expect(queries).toEqual([{ table: 'season_items', steps: [['insert', seasonRow('x')]] }]);
  });

  it('a 23505 is a member already: false, its place kept, nothing else written', async () => {
    const { client, queries } = recorder((q) =>
      verb(q) === 'insert' ? { error: { code: '23505' } } : routineWith([0, 1])(q),
    );
    expect(await addContainerMember(USER, 'routine', 'r1', 'a', client)).toBe(false);
    expect(queries).toEqual([lastPlace, insert({ routine_id: 'r1', item_id: 'a', user_id: USER, sort_order: 2 })]);
  });

  it('any other error is thrown: the insert, or the read of the last place', async () => {
    const purged = recorder((q) => (verb(q) === 'insert' ? { error: { code: '23503' } } : undefined));
    await expect(addContainerMember(USER, 'season', 'p1', 'x', purged.client)).rejects.toMatchObject({
      code: '23503',
    });

    const unread = recorder((q) => (verb(q) === 'select' ? { error: { code: '42501' } } : undefined));
    await expect(addContainerMember(USER, 'routine', 'r1', 'x', unread.client)).rejects.toMatchObject({
      code: '42501',
    });
    expect(unread.queries).toEqual([lastPlace]);
  });
});

describe('removeContainerMember: that row alone', () => {
  it('one delete, filtered by the owner, the item and the user', async () => {
    const r = recorder();
    await removeContainerMember(USER, 'routine', 'r1', 'x', r.client);
    expect(r.queries).toEqual([
      {
        table: 'routine_items',
        steps: [['delete'], ['eq', 'routine_id', 'r1'], ['eq', 'item_id', 'x'], ['eq', 'user_id', USER]],
      },
    ]);

    const s = recorder();
    await removeContainerMember(USER, 'season', 'p1', 'x', s.client);
    expect(s.queries).toEqual([
      {
        table: 'season_items',
        steps: [['delete'], ['eq', 'season_id', 'p1'], ['eq', 'item_id', 'x'], ['eq', 'user_id', USER]],
      },
    ]);
  });

  it('an error is thrown', async () => {
    const { client } = recorder(() => ({ error: { code: '23503' } }));
    await expect(removeContainerMember(USER, 'routine', 'r1', 'x', client)).rejects.toMatchObject({
      code: '23503',
    });
  });
});

describe('fetchRoutineMemberPlaces: the order every read draws', () => {
  it('one select of the places, sort_order nulls last, then item_id', async () => {
    const { client, queries } = recorder(() => ({
      data: [
        { item_id: 'a', sort_order: 0 },
        { item_id: 'b', sort_order: null },
      ],
    }));
    expect(await fetchRoutineMemberPlaces(USER, 'r1', client)).toEqual([
      { itemId: 'a', sortOrder: 0 },
      { itemId: 'b', sortOrder: null },
    ]);
    expect(queries).toEqual([
      {
        table: 'routine_items',
        steps: [
          ['select', 'item_id, sort_order'],
          ['eq', 'routine_id', 'r1'],
          ['eq', 'user_id', USER],
          ['order', 'sort_order', { ascending: true, nullsFirst: false }],
          ['order', 'item_id', { ascending: true }],
        ],
      },
    ]);
  });

  it('an error is thrown', async () => {
    const { client } = recorder(() => ({ error: { code: '42501' } }));
    await expect(fetchRoutineMemberPlaces(USER, 'r1', client)).rejects.toMatchObject({ code: '42501' });
  });
});

describe('setRoutineMemberOrder: one filtered UPDATE per member out of place, never an upsert', () => {
  const placeUpdate = (item_id: string, sort_order: number): Query => ({
    table: 'routine_items',
    steps: [['update', { sort_order }], ['eq', 'routine_id', 'r1'], ['eq', 'item_id', item_id], ['eq', 'user_id', USER]],
  });
  const stored = (rows: [string, number | null][]) => rows.map(([itemId, sortOrder]) => ({ itemId, sortOrder }));

  it('writes each member whose place is not its index in the new order, in that order', async () => {
    const { client, queries } = recorder();
    const n = await setRoutineMemberOrder(USER, 'r1', stored([['a', 0], ['b', 1], ['c', 2], ['d', 3]]), ['a', 'd', 'b', 'c'], client);
    expect(n).toBe(3);
    expect(queries).toEqual([placeUpdate('d', 1), placeUpdate('b', 2), placeUpdate('c', 3)]);
    expect(queries.flatMap((q) => q.steps.map((st) => st[0]))).not.toContain('upsert');
    expect(queries.flatMap((q) => q.steps.map((st) => st[0]))).not.toContain('insert');
  });

  it('numbers places with gaps, and members with none', async () => {
    const { client, queries } = recorder();
    await setRoutineMemberOrder(USER, 'r1', stored([['a', 5], ['b', 6], ['c', null]]), ['b', 'a', 'c'], client);
    expect(queries).toEqual([placeUpdate('b', 0), placeUpdate('a', 1), placeUpdate('c', 2)]);
  });

  it('writes nothing when every place is already its index: a retry', async () => {
    const { client, queries } = recorder();
    expect(await setRoutineMemberOrder(USER, 'r1', stored([['a', 0], ['b', 1]]), ['a', 'b'], client)).toBe(0);
    expect(queries).toEqual([]);
  });

  it('never writes an id it did not read', async () => {
    const { client, queries } = recorder();
    await setRoutineMemberOrder(USER, 'r1', stored([['a', 1], ['b', 0]]), ['a', 'x', 'b'], client);
    expect(queries).toEqual([placeUpdate('a', 0), placeUpdate('b', 2)]);
  });

  it('stops at the first error and throws it, leaving the rest unwritten', async () => {
    let n = 0;
    const { client, queries } = recorder(() => (++n === 2 ? { error: { code: 'XX000' } } : undefined));
    await expect(
      setRoutineMemberOrder(USER, 'r1', stored([['a', 0], ['b', 1], ['c', 2]]), ['c', 'b', 'a'], client),
    ).rejects.toMatchObject({ code: 'XX000' });
    expect(queries).toEqual([placeUpdate('c', 0), placeUpdate('a', 2)]);
  });
});

describe('addSeasonRoutine and removeSeasonRoutine: one season_routines row', () => {
  const holdRow = { season_id: 'p1', routine_id: 'r1', user_id: USER };

  it('a hold is one insert, never an upsert', async () => {
    const { client, queries } = recorder();
    expect(await addSeasonRoutine(USER, 'p1', 'r1', client)).toBe(true);
    expect(queries).toEqual([{ table: 'season_routines', steps: [['insert', holdRow]] }]);
  });

  it('a 23505 is a hold already there: false, nothing else written', async () => {
    const { client, queries } = recorder(() => ({ error: { code: '23505' } }));
    expect(await addSeasonRoutine(USER, 'p1', 'r1', client)).toBe(false);
    expect(queries).toHaveLength(1);
  });

  it('any other error is thrown, a 23503 among them', async () => {
    const { client } = recorder(() => ({ error: { code: '23503' } }));
    await expect(addSeasonRoutine(USER, 'p1', 'r1', client)).rejects.toMatchObject({ code: '23503' });
  });

  it('a take-out is one delete, filtered by the season, the routine and the user', async () => {
    const { client, queries } = recorder();
    await removeSeasonRoutine(USER, 'p1', 'r1', client);
    expect(queries).toEqual([
      {
        table: 'season_routines',
        steps: [['delete'], ['eq', 'season_id', 'p1'], ['eq', 'routine_id', 'r1'], ['eq', 'user_id', USER]],
      },
    ]);
  });

  it('a take-out’s error is thrown', async () => {
    const { client } = recorder(() => ({ error: { code: '42501' } }));
    await expect(removeSeasonRoutine(USER, 'p1', 'r1', client)).rejects.toMatchObject({ code: '42501' });
  });
});
