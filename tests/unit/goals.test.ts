import { describe, it, expect } from 'vitest';
import { fetchGoals, goalMemberRows, updateGoal, type GoalMembers } from '@/lib/db';
import { checkinStanding } from '@/lib/goals';
import {
  hydrateCustomTypes,
  isCheckinEligible,
  isCollectible,
  isMilestoneEligible,
} from '@/lib/item-registry';
import type { Item, ItemTypeDef } from '@/lib/planner-types';

/**
 * Phase 0 of memory/plans/long-term-goals.md — the two pieces of goal logic
 * that exist before any store or UI does: who may hold which role, and how the
 * three role arrays flatten into the one join table that stores them.
 *
 * Phase 1 extends this file with the derived helpers (progress, nextMilestone,
 * checkinStanding) and the demotion rule.
 */

const task = (over: Partial<Extract<Item, { type: 'task' }>> = {}): Item => ({
  type: 'task',
  id: 't1',
  title: 'Sit HSK 3',
  status: 'pending',
  isScheduled: false,
  order: 0,
  completedDates: [],
  skippedDates: [],
  ...over,
});

const habit = (over: Partial<Extract<Item, { type: 'habit' }>> = {}): Item => ({
  type: 'habit',
  id: 'h1',
  title: 'Practice Chinese',
  status: 'pending',
  repeatFrequency: 'daily',
  completedDates: [],
  skippedDates: [],
  streak: 0,
  project: 'Personal',
  dailyCounts: {},
  ...over,
});

describe('who may hold which role', () => {
  it('lets a one-shot task be a milestone', () => {
    expect(isMilestoneEligible(task())).toBe(true);
  });

  it('refuses a RECURRING task, because its scalar status never moves', () => {
    // The whole reason the capability is not the whole question. A recurring
    // item tracks completion per date (migration 016) and leaves `status`
    // alone forever, so a recurring milestone could never be counted achieved
    // and the goal would read permanently behind with nothing to click.
    expect(isMilestoneEligible(task({ repeatFrequency: 'daily' }))).toBe(false);
  });

  it('refuses a habit, which has a history rather than a completion', () => {
    expect(isMilestoneEligible(habit())).toBe(false);
    expect(isMilestoneEligible(habit({ repeatFrequency: 'none' }))).toBe(false);
  });

  it('refuses a subtask, which has no independent presence', () => {
    // Inherited from isCollectible rather than restated — a subtask surfaces
    // only inside its parent, so a milestone the user cannot find is worse
    // than no milestone.
    const sub = task({ parentItemId: 'parent' });
    expect(isCollectible(sub)).toBe(false);
    expect(isMilestoneEligible(sub)).toBe(false);
    expect(isCheckinEligible(sub)).toBe(false);
  });

  it('mirrors the rule for check-ins: recurring yes, one-shot no', () => {
    expect(isCheckinEligible(task({ repeatFrequency: 'weekdays' }))).toBe(true);
    expect(isCheckinEligible(habit())).toBe(true);
    expect(isCheckinEligible(task())).toBe(false);
    expect(isCheckinEligible(task({ repeatFrequency: 'none' }))).toBe(false);
  });

  it('lets a CUSTOM type be a milestone, including one whose type row is gone', () => {
    // Both paths resolve through buildCustomTypeConfig — a hydrated custom type
    // and the fallback template getItemTypeConfig mints for an item whose
    // item_types row was deleted. The template is task-shaped (dateAnchored,
    // TASK_FIELDS), so the "startDate IS the target date" premise holds for it,
    // and neither path had an assertion before.
    hydrateCustomTypes([
      { id: 'ty1', name: 'errand', label: 'Errand', labelPlural: 'Errands' } as ItemTypeDef,
    ]);
    const custom = (customType: string, over: Partial<Extract<Item, { type: 'custom' }>> = {}): Item => ({
      ...(task() as Extract<Item, { type: 'task' }>),
      type: 'custom',
      customType,
      ...over,
    });
    expect(isMilestoneEligible(custom('errand'))).toBe(true);
    expect(isMilestoneEligible(custom('deleted-type'))).toBe(true);
    // The recurrence rule still governs both.
    expect(isMilestoneEligible(custom('errand', { repeatFrequency: 'daily' }))).toBe(false);
    expect(isCheckinEligible(custom('deleted-type', { repeatFrequency: 'daily' }))).toBe(true);
    hydrateCustomTypes([]);
  });

  it('never lets one item satisfy both roles — they are opposites', () => {
    for (const item of [task(), task({ repeatFrequency: 'daily' }), habit()]) {
      expect(isMilestoneEligible(item) && isCheckinEligible(item)).toBe(false);
    }
  });
});

describe('flattening the three role arrays into join rows', () => {
  const members = (over: Partial<GoalMembers> = {}): GoalMembers => ({
    memberIds: [],
    milestoneIds: [],
    checkinIds: [],
    ...over,
  });

  it('tags each id with its role', () => {
    const rows = goalMemberRows(members({
      memberIds: ['m1'],
      milestoneIds: ['s1'],
      checkinIds: ['c1'],
    }));
    expect(rows).toEqual([
      { itemId: 's1', role: 'milestone', sortOrder: 0 },
      { itemId: 'c1', role: 'checkin', sortOrder: null },
      { itemId: 'm1', role: 'member', sortOrder: null },
    ]);
  });

  it('numbers milestones by array position and leaves every other role null', () => {
    // Homogeneous keys are not cosmetic: PostgREST bulk upserts need every row
    // to name the same columns, and a demoted milestone that kept its old
    // sort_order would perturb the order its new array comes back in.
    const rows = goalMemberRows(members({
      milestoneIds: ['s1', 's2', 's3'],
      memberIds: ['m1'],
    }));
    expect(rows.filter((r) => r.role === 'milestone').map((r) => r.sortOrder)).toEqual([0, 1, 2]);
    expect(rows.find((r) => r.itemId === 'm1')!.sortOrder).toBeNull();
    for (const row of rows) expect(row).toHaveProperty('sortOrder');
  });

  it('dedupes WITHIN one array quietly', () => {
    // One id twice in one array is not a contradiction, and a multi-add UI
    // produces it trivially. Left in, Postgres aborts the whole upsert with
    // 21000 ("cannot affect row a second time").
    const rows = goalMemberRows(members({ milestoneIds: ['s1', 's1', 's2'] }));
    expect(rows.map((r) => r.itemId)).toEqual(['s1', 's2']);
    expect(rows.map((r) => r.sortOrder)).toEqual([0, 1]);
  });

  it('REFUSES the same id in two arrays instead of picking a winner', () => {
    // Two contradictory instructions about one row. The primary key holds one
    // role, so honouring half of this would be last-write-wins roulette — the
    // same reasoning that makes the agent API reject `paused: false` sent with
    // a `pausedUntil` rather than guessing which half was meant.
    expect(() =>
      goalMemberRows(members({ milestoneIds: ['x'], memberIds: ['x'] })),
    ).toThrow(/two roles at once/);
    expect(() =>
      goalMemberRows(members({ checkinIds: ['x'], memberIds: ['x'] })),
    ).toThrow(/two roles at once/);
  });

  it('is empty for a goal with no members, so create can skip the write', () => {
    expect(goalMemberRows(members())).toEqual([]);
  });
});

/* ── the membership write, against a fake PostgREST ──────────────────────── */

/**
 * `reconcileGoalMembers` is where the two properties the pre-build review
 * pinned actually live, and both are invisible to a type checker: the write is
 * ONE pass (so a demotion never opens a delete window) and it is SCOPED to the
 * roles the caller named (so a partial patch does not empty the roles it never
 * mentioned). The second is the one that bites — `syncContainers` patches only
 * the fields that differ and swallows rejections with `.catch(console.error)`,
 * so a reconcile that demanded all three arrays would make membership undo a
 * silent no-op.
 *
 * Enough of PostgREST to answer honestly, including the projection rule: a mock
 * that hands back whole rows lets a function look correct while reading a
 * column its own query never asked for — which is exactly the bug this fix
 * repaired (the reconcile used to `select('item_id')` and then need a role it
 * had not fetched).
 */
interface Row { [k: string]: unknown }

function makeClient(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = seed;
  const log: { op: string; table: string; rows?: Row[]; filters: [string, unknown][] }[] = [];

  const build = (table: string, kind: string, payload?: Row | Row[], columns?: string) => {
    const filters: [string, unknown][] = [];
    const project = (row: Row): Row => {
      if (!columns || columns.trim() === '*') return { ...row };
      return Object.fromEntries(columns.split(',').map((c) => c.trim()).map((c) => [c, row[c]]));
    };
    const match = (row: Row) =>
      filters.every(([col, val]) => (Array.isArray(val) ? val.includes(row[col]) : row[col] === val));
    const run = () => {
      const rows = tables[table] ?? (tables[table] = []);
      if (kind === 'select') return Promise.resolve({ data: rows.filter(match).map(project), error: null });
      if (kind === 'upsert') {
        const incoming = (Array.isArray(payload) ? payload : [payload!]) as Row[];
        log.push({ op: 'upsert', table, rows: incoming, filters });
        for (const row of incoming) {
          const existing = rows.find((r) => r.goal_id === row.goal_id && r.item_id === row.item_id);
          if (existing) Object.assign(existing, row);
          else rows.push({ ...row });
        }
        return Promise.resolve({ data: null, error: null });
      }
      if (kind === 'delete') {
        const doomed = rows.filter(match);
        log.push({ op: 'delete', table, rows: doomed.map((r) => ({ ...r })), filters });
        tables[table] = rows.filter((r) => !doomed.includes(r));
        return Promise.resolve({ data: null, error: null });
      }
      // update
      log.push({ op: 'update', table, rows: [payload as Row], filters });
      for (const row of rows.filter(match)) Object.assign(row, payload);
      return Promise.resolve({ data: null, error: null });
    };
    const chain: Record<string, unknown> = {
      eq: (c: string, v: unknown) => (filters.push([c, v]), chain),
      is: (c: string, v: unknown) => (filters.push([c, v]), chain),
      in: (c: string, v: unknown[]) => (filters.push([c, v]), chain),
      order: () => chain,
      then: (resolve: (v: unknown) => unknown) => run().then(resolve),
    };
    return chain;
  };

  return {
    tables,
    log,
    client: {
      from: (table: string) => ({
        select: (columns?: string) => build(table, 'select', undefined, columns),
        update: (payload: Row) => build(table, 'update', payload),
        upsert: (payload: Row | Row[]) => build(table, 'upsert', payload),
        delete: () => build(table, 'delete'),
        insert: (payload: Row) => build(table, 'upsert', payload),
      }),
    },
  };
}

const G = 'g1';
const U = 'u1';
const join = (item_id: string, role: string, sort_order: number | null = null): Row => ({
  goal_id: G, item_id, user_id: U, role, sort_order,
});

describe('reconcileGoalMembers', () => {
  const seeded = () =>
    makeClient({
      goals: [{ id: G, user_id: U, name: 'Learn Chinese', state: 'active' }],
      goal_items: [join('s1', 'milestone', 0), join('c1', 'checkin'), join('m1', 'member')],
    });

  it('leaves roles the patch never mentions completely alone', async () => {
    // The failure this replaced: undo of "added a milestone" arrives as
    // {milestoneIds} alone. Read as a whole-set replacement it would delete
    // the check-in and the plain member too — and syncContainers swallows the
    // rejection, so nobody would ever see it happen.
    const { client, tables, log } = seeded();
    await updateGoal(U, G, { milestoneIds: ['s1', 's2'] }, client);
    expect(tables.goal_items.map((r) => r.item_id).sort()).toEqual(['c1', 'm1', 's1', 's2']);
    expect(log.filter((l) => l.op === 'delete')).toHaveLength(0);
  });

  it('removes only within the roles it was given', async () => {
    const { client, tables } = seeded();
    await updateGoal(U, G, { milestoneIds: [] }, client);
    expect(tables.goal_items.map((r) => r.item_id).sort()).toEqual(['c1', 'm1']);
  });

  it('demotes a milestone to member as ONE upsert, with no delete in between', async () => {
    // A demotion always changes two arrays, so both roles are in scope and the
    // union resolves it as an UPDATE of one row. Three per-role passes would
    // have deleted this row in the milestone pass and re-inserted it in the
    // member pass — and lost the membership outright if anything interrupted
    // between two requests with no transaction to hold them.
    const { client, tables, log } = seeded();
    await updateGoal(U, G, { milestoneIds: [], memberIds: ['m1', 's1'] }, client);
    expect(log.filter((l) => l.op === 'delete')).toHaveLength(0);
    const row = tables.goal_items.find((r) => r.item_id === 's1')!;
    expect(row.role).toBe('member');
    expect(row.sort_order).toBeNull();
  });

  it('promotes a member to milestone without deleting it first', async () => {
    const { client, tables, log } = seeded();
    // Both arrays carry their full new contents — s1 STAYS a milestone. Send
    // `{milestoneIds: ['m1']}` instead and s1 is genuinely gone from the goal,
    // which is the next test.
    await updateGoal(U, G, { milestoneIds: ['s1', 'm1'], memberIds: [] }, client);
    expect(log.filter((l) => l.op === 'delete')).toHaveLength(0);
    const row = tables.goal_items.find((r) => r.item_id === 'm1')!;
    expect(row.role).toBe('milestone');
    expect(row.sort_order).toBe(1);
  });

  it('treats an id dropped from a supplied array, and named in no other, as removed', async () => {
    // The semantic the scoping rule implies, pinned because it is the one place
    // "leave unmentioned roles alone" and "this array is the whole truth for
    // its role" meet. s1 leaves the milestone array and appears nowhere else in
    // the patch, so it leaves the goal — while c1, whose role the patch never
    // mentions, survives untouched.
    const { client, tables } = seeded();
    await updateGoal(U, G, { milestoneIds: ['m2'], memberIds: ['m1'] }, client);
    expect(tables.goal_items.map((r) => r.item_id).sort()).toEqual(['c1', 'm1', 'm2']);
  });

  it('honours a full three-array replacement as a whole-set write', async () => {
    const { client, tables } = seeded();
    await updateGoal(U, G, { milestoneIds: ['s1'], checkinIds: [], memberIds: [] }, client);
    expect(tables.goal_items.map((r) => r.item_id)).toEqual(['s1']);
  });

  it('refuses a contradictory patch BEFORE writing the column half', async () => {
    // Otherwise a rename persists and the membership throws, so a caller that
    // rolls back its optimistic state on the rejection diverges from the DB on
    // the name it already wrote.
    const { client, tables } = seeded();
    await expect(
      updateGoal(U, G, { name: 'Renamed', milestoneIds: ['x'], memberIds: ['x'] }, client),
    ).rejects.toThrow(/two roles at once/);
    expect(tables.goals[0].name).toBe('Learn Chinese');
  });

  it('writes nothing at all when the patch is empty', async () => {
    const { client, log } = seeded();
    await updateGoal(U, G, {}, client);
    expect(log).toHaveLength(0);
  });
});

describe('fetchGoals', () => {
  it('splits one join table into three arrays by role', async () => {
    const { client } = makeClient({
      goals: [{ id: G, user_id: U, name: 'Learn Chinese', state: 'active', deleted_at: null }],
      goal_items: [join('s1', 'milestone', 0), join('c1', 'checkin'), join('m1', 'member')],
    });
    const goals = await fetchGoals(U, client);
    expect(goals![0]).toMatchObject({
      milestoneIds: ['s1'], checkinIds: ['c1'], memberIds: ['m1'],
    });
  });

  it('files an unrecognised role as a plain member rather than dropping it', async () => {
    // Unreachable under 036's CHECK, and deliberate: a membership that vanishes
    // from every array is unrecoverable, while one that degrades is editable.
    const { client } = makeClient({
      goals: [{ id: G, user_id: U, name: 'G', state: 'active', deleted_at: null }],
      goal_items: [join('x1', 'some-future-role')],
    });
    const goals = await fetchGoals(U, client);
    expect(goals![0].memberIds).toEqual(['x1']);
  });

  it('gives every memberless goal its OWN arrays', async () => {
    // One hoisted `empty` object spread into each row would share three array
    // references across every memberless goal, so the first in-place push would
    // appear on all of them at once.
    const { client } = makeClient({
      goals: [
        { id: 'a', user_id: U, name: 'A', state: 'active', deleted_at: null },
        { id: 'b', user_id: U, name: 'B', state: 'active', deleted_at: null },
      ],
      goal_items: [],
    });
    const goals = await fetchGoals(U, client);
    expect(goals![0].memberIds).not.toBe(goals![1].memberIds);
  });

  it('returns null — not [] — when the table is not there yet', async () => {
    // The availability contract Phase 1's `goalsAvailable` is built on. `[]`
    // would say "you have no goals" to a store that would then offer to create
    // one against a table that does not exist.
    const client = {
      from: () => ({
        select: () => ({
          eq: function () { return this; },
          is: function () { return this; },
          order: function () { return this; },
          then: (r: (v: unknown) => unknown) => r({ data: null, error: { code: '42P01' } }),
        }),
      }),
    };
    expect(await fetchGoals(U, client)).toBeNull();
  });
});

describe('check-in standing', () => {
  // Named for the CADENCE UNDER TEST, not the value: 'weekly' is not in the
  // recurrence enum at all (migration 014 removed it; the schema normalizes
  // the legacy string to 'custom'), so a daily check-in is what actually
  // exercises the day-walk.
  const daily = (over: Partial<Extract<Item, { type: 'task' }>> = {}): Item =>
    task({ id: 'c1', title: 'Chinese check-in', repeatFrequency: 'daily', ...over });

  const goalWith = (checkinIds: string[]) => ({
    id: 'g1',
    name: 'Learn Chinese',
    state: 'active' as const,
    memberIds: [],
    milestoneIds: [],
    checkinIds,
  });

  it('walks calendar days in the USER’s zone, not the runtime’s', () => {
    // The defect this replaced built `new Date(todayStr + 'T12:00:00')` — which
    // parses in the RUNTIME's zone — and read each day back through the user's.
    // More than 12h east of the server, offset 0 already formatted as tomorrow,
    // so today's occurrence was never probed: on a weekly cadence the page
    // reported NEXT WEEK for a check-in due now.
    const items = new Map<string, Item>([['c1', daily()]]);
    const standing = checkinStanding(goalWith(['c1']), items, '2026-08-21', 'Pacific/Auckland');
    expect(standing.nextDue).toBe('2026-08-21');
    expect(standing.dueToday).toBe(true);
  });

  it('agrees with the grid on a dated check-in: its start day counts, nothing before it', () => {
    // A Sunday check-in moved to Wednesday 2026-08-19 shows on the grid that
    // Wednesday, so the goal page must call it due then, not "next Sunday".
    const sundays = { repeatFrequency: 'custom' as const, repeatDays: [0] };
    const moved = new Map<string, Item>([['c1', daily({ ...sundays, startDate: '2026-08-19' })]]);
    expect(checkinStanding(goalWith(['c1']), moved, '2026-08-19', 'UTC')).toMatchObject({
      nextDue: '2026-08-19',
      dueToday: true,
    });
    // Starting next Sunday: the Sundays before it are not due.
    const later = new Map<string, Item>([['c1', daily({ ...sundays, startDate: '2026-08-30' })]]);
    expect(checkinStanding(goalWith(['c1']), later, '2026-08-19', 'UTC').nextDue).toBe('2026-08-30');
  });

  it('treats a SKIPPED occurrence as answered, not as still due', () => {
    // A skip is the other per-date terminal mark a recurring item carries.
    // Counting only completion made the page say "Due today" for an occurrence
    // the user had struck off the grid an hour earlier.
    const items = new Map<string, Item>([
      ['c1', daily({ skippedDates: ['2026-08-21'] })],
    ]);
    const standing = checkinStanding(goalWith(['c1']), items, '2026-08-21', 'UTC');
    expect(standing.nextDue).toBe('2026-08-22');
    expect(standing.dueToday).toBe(false);
  });

  it('reports the last completed occurrence, and nothing when there is none', () => {
    const done = new Map<string, Item>([
      ['c1', daily({ completedDates: ['2026-08-14', '2026-08-07'] })],
    ]);
    expect(checkinStanding(goalWith(['c1']), done, '2026-08-21', 'UTC').lastDone).toBe('2026-08-14');
    const fresh = new Map<string, Item>([['c1', daily()]]);
    expect(checkinStanding(goalWith(['c1']), fresh, '2026-08-21', 'UTC').lastDone).toBeNull();
  });

  it('is empty for a goal with no check-in', () => {
    const standing = checkinStanding(goalWith([]), new Map(), '2026-08-21', 'UTC');
    expect(standing).toEqual({ item: null, nextDue: null, lastDone: null, dueToday: false });
  });
});

describe('the check-in bridge’s goal selection', () => {
  // The store action itself is driven in goals-store.test.ts; this pins the
  // rule it depends on — which goals a completed item checks in for. Getting
  // this wrong filed every note under whichever goal sorted first and left the
  // other's history permanently empty, no matter how many were written.
  const goalWith = (id: string, checkinIds: string[], state: 'active' | 'achieved' = 'active') => ({
    id,
    name: `Goal ${id}`,
    state,
    memberIds: [],
    milestoneIds: [],
    checkinIds,
  });

  const goalsForCheckin = (goals: ReturnType<typeof goalWith>[], itemId: string) =>
    goals.filter((g) => g.state === 'active' && g.checkinIds.includes(itemId));

  it('returns EVERY active goal the item checks in for', () => {
    const goals = [goalWith('a', ['c1']), goalWith('b', ['c1']), goalWith('c', ['other'])];
    expect(goalsForCheckin(goals, 'c1').map((g) => g.id)).toEqual(['a', 'b']);
  });

  it('ignores ended goals', () => {
    const goals = [goalWith('a', ['c1'], 'achieved'), goalWith('b', ['c1'])];
    expect(goalsForCheckin(goals, 'c1').map((g) => g.id)).toEqual(['b']);
  });

  it('is empty for an item that is nobody’s check-in', () => {
    expect(goalsForCheckin([goalWith('a', ['c1'])], 'x')).toEqual([]);
  });
});
