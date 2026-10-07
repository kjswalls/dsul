import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { demoteInvalidGoalRoles, roleShape, type RoleRow } from '@/lib/goal-roles';

/**
 * lib/goal-roles.ts: the server's copy of decision 3's demotion, which the
 * agent item PATCH (lib/agent-api.ts) and the iPhone app's repeat edit
 * (lib/app-api.ts) both run. agent-goal-routes.test.ts drives it through the
 * agent PATCH over a stateful fake database; these drive it directly, on a
 * small fake client that records each query, so the statements it makes (and
 * the ones it doesn't) are pinned whichever route calls it.
 */

const USER = 'user-1';
const ITEM = 'item-1';

interface Query {
  table: string;
  calls: [string, ...unknown[]][];
}

type Result = { data: unknown; error: unknown };

/**
 * A client whose every query is recorded in `queries`, answered by `answer`
 * once it is awaited (or `maybeSingle()` is called). A query's kind is the
 * first of select/update it names.
 */
function fakeClient(answer: (q: Query) => Result) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const q: Query = { table, calls: [] };
      queries.push(q);
      const settle = () => Promise.resolve(answer(q));
      const builder: Record<string, unknown> = {
        then: (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) => settle().then(res, rej),
        maybeSingle: () => {
          q.calls.push(['maybeSingle']);
          return settle();
        },
      };
      for (const method of ['select', 'update', 'eq', 'neq', 'in']) {
        builder[method] = (...args: unknown[]) => {
          q.calls.push([method, ...args]);
          return builder;
        };
      }
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, queries };
}

const kind = (q: Query) => q.calls.find(([m]) => m === 'select' || m === 'update')?.[0];

/** The client a held role, an item row and a write answer from; any of them may fail. */
function held(
  roles: { goal_id: string; role: string }[],
  item: RoleRow | null,
  errors: { roles?: unknown; item?: unknown; write?: unknown } = {},
) {
  return fakeClient((q) => {
    if (q.table === 'goal_items' && kind(q) === 'select') {
      return errors.roles ? { data: null, error: errors.roles } : { data: roles, error: null };
    }
    if (q.table === 'items') return errors.item ? { data: null, error: errors.item } : { data: item, error: null };
    if (q.table === 'goal_items' && kind(q) === 'update') return { data: null, error: errors.write ?? null };
    throw new Error(`unexpected ${q.table}`);
  });
}

const row = (over: Partial<RoleRow> = {}): RoleRow => ({
  id: ITEM,
  type: 'task',
  parent_item_id: null,
  repeat_frequency: null,
  ...over,
});

/** The demotion's write, as the fake recorded it. */
const demotion = (goalIds: string[]) => ({
  table: 'goal_items',
  calls: [
    ['update', { role: 'member', sort_order: null }],
    ['eq', 'user_id', USER],
    ['eq', 'item_id', ITEM],
    ['in', 'goal_id', goalIds],
  ],
});

describe('roleShape', () => {
  it('reads a NULL frequency as the type’s default: a habit repeats daily, a task not at all', () => {
    expect(roleShape(row({ type: 'habit' }))).toMatchObject({ type: 'habit', repeatFrequency: 'daily' });
    expect(roleShape(row())).toMatchObject({ type: 'task', repeatFrequency: 'none' });
    expect(roleShape(row({ repeat_frequency: 'weekdays' }))).toMatchObject({ repeatFrequency: 'weekdays' });
  });

  it('wears a custom type in the app’s envelope, and carries the parent', () => {
    expect(roleShape(row({ type: 'errand', parent_item_id: 'p' }))).toMatchObject({
      type: 'custom',
      customType: 'errand',
      parentItemId: 'p',
      repeatFrequency: 'none',
    });
  });
});

describe('demoteInvalidGoalRoles', () => {
  it('with no role held: one goal_items select, no item read, nothing returned', async () => {
    const { client, queries } = held([], row());
    expect(await demoteInvalidGoalRoles(client, USER, ITEM)).toEqual([]);
    expect(queries).toEqual([
      {
        table: 'goal_items',
        calls: [
          ['select', 'goal_id, role'],
          ['eq', 'user_id', USER],
          ['eq', 'item_id', ITEM],
          ['neq', 'role', 'member'],
        ],
      },
    ]);
  });

  it('takes back a check-in on an item that no longer repeats', async () => {
    const { client, queries } = held([{ goal_id: 'g1', role: 'checkin' }], row());
    expect(await demoteInvalidGoalRoles(client, USER, ITEM)).toEqual([{ goalId: 'g1', from: 'checkin' }]);
    expect(queries.map((q) => [q.table, kind(q)])).toEqual([
      ['goal_items', 'select'],
      ['items', 'select'],
      ['goal_items', 'update'],
    ]);
    expect(queries[1].calls).toEqual([
      ['select', 'id, type, parent_item_id, repeat_frequency'],
      ['eq', 'id', ITEM],
      ['eq', 'user_id', USER],
      ['maybeSingle'],
    ]);
    expect(queries[2]).toEqual(demotion(['g1']));
  });

  it('takes back a milestone on an item that repeats now', async () => {
    const { client, queries } = held([{ goal_id: 'g1', role: 'milestone' }], row({ repeat_frequency: 'daily' }));
    expect(await demoteInvalidGoalRoles(client, USER, ITEM)).toEqual([{ goalId: 'g1', from: 'milestone' }]);
    expect(queries[2]).toEqual(demotion(['g1']));
  });

  it('demotes only the untrue roles, in one write across their goals', async () => {
    const { client, queries } = held(
      [
        { goal_id: 'g1', role: 'checkin' },
        { goal_id: 'g2', role: 'checkin' },
      ],
      row(),
    );
    expect(await demoteInvalidGoalRoles(client, USER, ITEM)).toEqual([
      { goalId: 'g1', from: 'checkin' },
      { goalId: 'g2', from: 'checkin' },
    ]);
    expect(queries.filter((q) => kind(q) === 'update')).toEqual([demotion(['g1', 'g2'])]);
  });

  it('leaves a check-in that still repeats alone, a NULL habit included', async () => {
    for (const item of [row({ repeat_frequency: 'weekdays' }), row({ type: 'habit' })]) {
      const { client, queries } = held([{ goal_id: 'g1', role: 'checkin' }], item);
      expect(await demoteInvalidGoalRoles(client, USER, ITEM)).toEqual([]);
      expect(queries.some((q) => kind(q) === 'update')).toBe(false);
    }
  });

  it('leaves a milestone on a one-off alone', async () => {
    const { client, queries } = held([{ goal_id: 'g1', role: 'milestone' }], row());
    expect(await demoteInvalidGoalRoles(client, USER, ITEM)).toEqual([]);
    expect(queries.some((q) => kind(q) === 'update')).toBe(false);
  });

  it('returns nothing when the item is gone, and writes nothing', async () => {
    const { client, queries } = held([{ goal_id: 'g1', role: 'milestone' }], null);
    expect(await demoteInvalidGoalRoles(client, USER, ITEM)).toEqual([]);
    expect(queries.some((q) => kind(q) === 'update')).toBe(false);
  });

  // The agent PATCH's other trigger ('parentItemId' in fields): a subtask may hold no role.
  it('takes back a milestone on a one-off that is now a subtask', async () => {
    const { client, queries } = held([{ goal_id: 'g1', role: 'milestone' }], row({ parent_item_id: 'parent' }));
    expect(await demoteInvalidGoalRoles(client, USER, ITEM)).toEqual([{ goalId: 'g1', from: 'milestone' }]);
    expect(queries[2]).toEqual(demotion(['g1']));
  });

  it('takes back a check-in on a daily item that is now a subtask', async () => {
    const { client, queries } = held(
      [{ goal_id: 'g1', role: 'checkin' }],
      row({ parent_item_id: 'parent', repeat_frequency: 'daily' }),
    );
    expect(await demoteInvalidGoalRoles(client, USER, ITEM)).toEqual([{ goalId: 'g1', from: 'checkin' }]);
    expect(queries[2]).toEqual(demotion(['g1']));
  });

  it('throws each query’s error', async () => {
    const boom = { message: 'boom' };
    const roles = [{ goal_id: 'g1', role: 'checkin' }];
    await expect(demoteInvalidGoalRoles(held(roles, row(), { roles: boom }).client, USER, ITEM)).rejects.toBe(boom);
    await expect(demoteInvalidGoalRoles(held(roles, row(), { item: boom }).client, USER, ITEM)).rejects.toBe(boom);
    await expect(demoteInvalidGoalRoles(held(roles, row(), { write: boom }).client, USER, ITEM)).rejects.toBe(boom);
  });
});
