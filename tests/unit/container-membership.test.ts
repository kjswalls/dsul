import { describe, it, expect, vi } from 'vitest';

/**
 * How a routine's or a season's members reach their join table: the web's
 * whole-list write (lib/db.ts reconcileMembership, through updateRoutine and
 * updateSeason), and the iPhone's one-row writes (addContainerMember,
 * removeContainerMember, behind the `collect` action).
 *
 * The first block was written against reconcileMembership as it stood before
 * the 2f brief's race fix, and is kept unedited across it: it pins every call
 * one web tab makes, row for row, so the fix can be shown to change nothing a
 * single writer sends.
 *
 * The client is a recorder, not a fake database: each query keeps its table
 * and every builder call in order, and answers what the test says, so a call
 * added, dropped or reordered shows here.
 */

vi.mock('@/lib/supabase', () => ({ createClient: () => ({}) }));
vi.mock('@/lib/openclaw-registry', () => ({ notifyPlugins: vi.fn() }));

import { addContainerMember, removeContainerMember, updateRoutine, updateSeason } from '@/lib/db';

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
  it('with known equal to what is stored, every call is the one-writer call above, row for row', async () => {
    const r = recorder(holding(['a', 'c']));
    await updateRoutine(USER, 'r1', { itemIds: ['a', 'b'] }, r.client, { itemIds: ['a', 'c'] });
    expect(r.queries).toEqual([
      routineRead,
      routineUpsert(routineRow('a', 0), routineRow('b', 1)),
      routineDelete('c'),
    ]);

    const s = recorder(holding(['a', 'c']));
    await updateSeason(USER, 'p1', { itemIds: ['a', 'b'] }, s.client, { itemIds: ['a', 'c'] });
    expect(s.queries).toEqual([seasonRead, seasonUpsert(seasonRow('a'), seasonRow('b')), seasonDelete('c')]);

    const empty = recorder(holding(['a', 'c']));
    await updateRoutine(USER, 'r1', { itemIds: [] }, empty.client, { itemIds: ['a', 'c'] });
    expect(empty.queries).toEqual([routineRead, routineDelete('a', 'c')]);
  });

  it("keeps a member the phone added since the tab's read", async () => {
    // The tab knows [a] and adds b; the phone had added x.
    const { client, queries } = recorder(holding(['a', 'x']));
    await updateRoutine(USER, 'r1', { itemIds: ['a', 'b'] }, client, { itemIds: ['a'] });
    expect(queries).toEqual([routineRead, routineUpsert(routineRow('a', 0), routineRow('b', 1))]);
  });

  it('does not put back a member the phone took out', async () => {
    // The tab knows [a, b] and removes a; the phone had removed b.
    const { client, queries } = recorder(holding(['a']));
    await updateRoutine(USER, 'r1', { itemIds: ['b'] }, client, { itemIds: ['a', 'b'] });
    expect(queries).toEqual([routineRead, routineDelete('a')]);
  });

  it("removes only the tab's own removal", async () => {
    // The tab knows [a] and removes it; the phone had added x.
    const { client, queries } = recorder(holding(['a', 'x']));
    await updateRoutine(USER, 'r1', { itemIds: [] }, client, { itemIds: ['a'] });
    expect(queries).toEqual([routineRead, routineDelete('a')]);
  });

  it('a kept member keeps its index in the list as its sort_order', async () => {
    // The tab knows [a, b, c] and adds d; the phone had removed b.
    const { client, queries } = recorder(holding(['a', 'c']));
    await updateRoutine(USER, 'r1', { itemIds: ['a', 'b', 'c', 'd'] }, client, { itemIds: ['a', 'b', 'c'] });
    expect(queries).toEqual([
      routineRead,
      routineUpsert(routineRow('a', 0), routineRow('c', 2), routineRow('d', 3)),
    ]);
  });

  it('a season keeps the phone\'s add and its remove alike', async () => {
    // The tab knows [a, b] and adds c; the phone had removed b and added x.
    const { client, queries } = recorder(holding(['a', 'x']));
    await updateSeason(USER, 'p1', { itemIds: ['a', 'b', 'c'] }, client, { itemIds: ['a', 'b'] });
    expect(queries).toEqual([seasonRead, seasonUpsert(seasonRow('a'), seasonRow('c'))]);
  });

  it('the window it leaves open: the upsert still names every member the tab kept', async () => {
    // Pinned so nobody reads more into `known` than it gives (the 2f brief's
    // §3.10). The tab removes a from [a, m]; this read sees [a, m], so the
    // upsert names m. A phone removal of m that lands after this read and
    // before this upsert, one round trip, is put back by it: PostgREST has no
    // transaction to hold the two statements together.
    const { client, queries } = recorder(holding(['a', 'm']));
    await updateRoutine(USER, 'r1', { itemIds: ['m'] }, client, { itemIds: ['a', 'm'] });
    expect(queries).toEqual([routineRead, routineUpsert(routineRow('m', 0)), routineDelete('a')]);
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

  it("a season's routineIds take no known: that list is still the whole list", async () => {
    const { client, queries } = recorder((q) =>
      verb(q) === 'select' ? { data: [{ routine_id: 'r9' }] } : undefined,
    );
    await updateSeason(USER, 'p1', { routineIds: ['r1'] }, client, { itemIds: ['r9'] });
    expect(queries).toEqual([
      {
        table: 'season_routines',
        steps: [['select', 'routine_id'], ['eq', 'season_id', 'p1'], ['eq', 'user_id', USER]],
      },
      {
        table: 'season_routines',
        steps: [['upsert', [{ season_id: 'p1', routine_id: 'r1', user_id: USER }], { onConflict: 'season_id,routine_id' }]],
      },
      {
        table: 'season_routines',
        steps: [['delete'], ['eq', 'season_id', 'p1'], ['eq', 'user_id', USER], ['in', 'routine_id', ['r9']]],
      },
    ]);
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
