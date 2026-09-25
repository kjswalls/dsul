import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * ONE CLASSIFY KIND — migration 039.
 *
 * `project` and `group` were the same shape wearing two names, and tasks and
 * habits have been one entity since 019, so a second classify kind was a
 * distinction the data model no longer made. This file pins the three things
 * that the collapse could break silently, which is to say the three that a
 * green suite would otherwise not notice:
 *
 *   1. THE PINNED LEGACY PROJECTION. `habits[]` must keep emitting `group`, and
 *      `habitGroups[]` must keep being a required array of the four container
 *      fields. The OpenClaw plugin `safeParse`s the whole context response and
 *      THROWS on drift — one wrong key does not degrade a field, it bricks the
 *      plugin's entire cached context on its next fetch. Every other test in the
 *      repo works with the ITEM shape, so nothing else would have caught it.
 *
 *   2. ONE CONTAINER PER ITEM. The role survived the kind: an item still answers
 *      the CLASSIFY axis with exactly one value, on exactly one field.
 *
 *   3. THE MIGRATION IS RE-RUNNABLE, and leaves the ballast alone. Asserted
 *      against the SQL text, which is a weaker instrument than a database and
 *      is said so out loud below — but the specific clauses it names are the
 *      ones whose deletion turns a re-run from a no-op into a data loss.
 */

/* ── 1. the pinned legacy projection ────────────────────────────────────── */

import {
  HabitSchema,
  HabitGroupSchema,
  DsulContextResponseSchema,
  HABIT_FIELDS,
  type HabitItem,
} from '@dsul/types';
import {
  toLegacyHabit,
  fromLegacyHabit,
  fromLegacyHabitUpdates,
  createProject,
  updateProject,
  deleteProject,
} from '@/lib/db';
import { notifyPlugins } from '@/lib/openclaw-registry';

const habitItem = (over: Partial<HabitItem> = {}): HabitItem =>
  ({
    type: 'habit',
    id: 'h1',
    title: 'Stretch',
    project: 'Wellness',
    projectId: 'pr-well',
    streak: 3,
    status: 'pending',
    completedDates: ['2026-08-01'],
    skippedDates: [],
    dailyCounts: {},
    repeatFrequency: 'daily',
    ...over,
  }) as HabitItem;

describe('habits[] still speaks the legacy vocabulary', () => {
  it('renames the container field on the way out, and nothing else', () => {
    const legacy = toLegacyHabit(habitItem());

    // The field the plugin's schema requires…
    expect(legacy.group).toBe('Wellness');
    expect(legacy.groupId).toBe('pr-well');
    // …and the item field, which must not leak through. A `project` key would
    // PARSE (unknown keys are stripped) and quietly teach a model a second
    // vocabulary for one axis.
    expect(legacy).not.toHaveProperty('project');
    expect(legacy).not.toHaveProperty('projectId');
    expect(legacy).not.toHaveProperty('type');
  });

  it('parses against the pinned HabitSchema, key for key', () => {
    const legacy = toLegacyHabit(habitItem());
    // Zod STRIPS unknown keys rather than throwing, so `parse` succeeding proves
    // nothing about extras — the parsed result is the schema's own view of the
    // object, and comparing key sets is what catches a field the projection
    // emits that the contract never declared.
    const parsed = HabitSchema.parse(legacy);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(legacy).sort());
  });

  it("emits '' for an unfiled habit, restoring the column's NOT NULL semantics", () => {
    // `HabitSchema.group` is a REQUIRED string. The item field is optional, so
    // an unfiled habit reaches here as undefined and would fail the plugin's
    // parse — which is not a degraded field, it is a dead cache.
    const legacy = toLegacyHabit(habitItem({ project: undefined }));
    expect(legacy.group).toBe('');
    expect(() => HabitSchema.parse(legacy)).not.toThrow();
  });

  it('round-trips an item through the legacy shape and back', () => {
    const item = habitItem();
    expect(fromLegacyHabit(toLegacyHabit(item))).toEqual(item);
  });

  it('renames a PATCH body without inventing keys it was not given', () => {
    // Key presence is the whole contract: `updateItem`'s allowlists are
    // `'project' in updates` checks, so turning an absent key into an explicit
    // undefined would start writing NULL over a container nobody asked to clear.
    expect(fromLegacyHabitUpdates({ title: 'x' })).toEqual({ title: 'x' });
    expect(fromLegacyHabitUpdates({ group: 'Work' })).toEqual({ project: 'Work' });
    expect('project' in fromLegacyHabitUpdates({ title: 'x' })).toBe(false);
  });

  it('keeps the AGENT vocabulary out of the item field list', () => {
    // HABIT_FIELDS drives `diffItem` and the per-type update allowlist, so it
    // has to describe the ITEM. Keyed off the legacy shape it would put `group`
    // into every undo patch and drop `project` from all of them.
    expect(HABIT_FIELDS).toContain('project');
    expect(HABIT_FIELDS).not.toContain('group');
  });
});

/* ── the context route's habitGroups[] projection ───────────────────────── */

const projects = [
  {
    id: 'pr-1',
    name: 'Wellness',
    emoji: 'icon:Heart',
    color: 'var(--accent-2)',
    // A time block, which a habit group never had — see the assertion below.
    timeBucket: 'morning' as const,
    startTime: '07:00',
    duration: 30,
  },
];

vi.mock('@/lib/openclaw-registry', () => ({ notifyPlugins: vi.fn() }));
vi.mock('@/lib/supabase-server', () => ({ createClient: vi.fn(async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } })) }));
vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: { timezone: 'UTC' } }) }) }),
    }),
  }),
  resolveUserIdFromApiKey: vi.fn(async () => 'u1'),
}));
vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    fetchItems: vi.fn(async () => [habitItem({ project: 'Wellness' })]),
    fetchProjects: vi.fn(async () => projects),
    fetchRoutines: vi.fn(async () => []),
    fetchPrograms: vi.fn(async () => []),
    fetchGoals: vi.fn(async () => []),
  };
});

describe('/api/agent/context keeps habitGroups[] alive as a projection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const call = async () => {
    const { GET } = await import('@/app/api/agent/context/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(
      new NextRequest('http://localhost/api/agent/context', {
        headers: { authorization: 'Bearer key' },
      })
    );
    return res.json();
  };

  it('serves the whole container list under BOTH names', async () => {
    const body = await call();
    // A container IS a project and IS a habit group now, so the honest
    // projection is the same list twice. Omitting the key would brick a
    // deployed plugin — the field is REQUIRED in its schema.
    expect(body.habitGroups.map((g: { name: string }) => g.name)).toEqual(['Wellness']);
    expect(body.projects.map((p: { name: string }) => p.name)).toEqual(['Wellness']);
  });

  it('narrows habitGroups[] to the four fields a habit group ever had', async () => {
    const body = await call();
    // ProjectSchema carries a time block. An older plugin build strips unknown
    // keys rather than throwing, so shipping them would parse — and would
    // quietly tell a model that habit groups have schedules.
    expect(Object.keys(body.habitGroups[0]).sort()).toEqual(['color', 'emoji', 'id', 'name']);
    expect(() => HabitGroupSchema.parse(body.habitGroups[0])).not.toThrow();
  });

  it('parses whole against the plugin schema, which throws on drift', async () => {
    const body = await call();
    const parsed = DsulContextResponseSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    // And the habit reached it under the legacy field name.
    expect(body.habits[0].group).toBe('Wellness');
  });
});

/* ── the webhook half of the same contract ──────────────────────────────── */

describe('a container write still announces itself under BOTH event names', () => {
  /**
   * `habitGroups.updated` is in the plugin's pinned event enum
   * (DsulChangeEventSchema) and in the subscription it registers on setup
   * (openclaw-plugin/src/webhook.ts). `notifyPlugins` DROPS an unregistered
   * name, so going quiet on it does not fail anywhere — it silently
   * unsubscribes every deployed build and leaves it on a stale cache until
   * something else happens to move.
   *
   * That is precisely the shape of regression no other test in this repo can
   * see, because nothing else asserts on webhook names at all: deleting the
   * second `notifyPlugins` call left all 2026 tests green.
   */
  it('emits projects.updated AND habitGroups.updated for create, update and delete', async () => {
    // An explicit `client` rather than a module mock of `@/lib/supabase`: every
    // CRUD function here takes one, so no real Supabase client is ever
    // constructed and the test says nothing about how one would be built.
    const chain: Record<string, unknown> = {};
    chain.insert = async () => ({ error: null });
    chain.update = () => chain;
    chain.eq = () => chain;
    chain.then = (resolve: (v: { error: null }) => unknown) =>
      Promise.resolve({ error: null }).then(resolve);
    const client = { from: () => chain } as never;

    const project = { id: 'pr-1', name: 'Wellness', emoji: 'icon:Heart' };
    await createProject('u1', project, client);
    await updateProject('u1', 'pr-1', { name: 'Health' }, client);
    await deleteProject('u1', 'pr-1', client);

    const events = vi.mocked(notifyPlugins).mock.calls.map((c) => c[1]);
    expect(events).toEqual([
      'projects.updated', 'habitGroups.updated',
      'projects.updated', 'habitGroups.updated',
      'projects.updated', 'habitGroups.updated',
    ]);
    // Same payload under both names — an older build reads it as a habit-group
    // change and a newer one as a project change, and they are the same change.
    const calls = vi.mocked(notifyPlugins).mock.calls;
    for (let i = 0; i < calls.length; i += 2) {
      expect(calls[i][2]).toEqual(calls[i + 1][2]);
    }
  });
});

/* ── 2. one container per item ──────────────────────────────────────────── */

import {
  CLASSIFY_KINDS,
  CONTAINER_KINDS,
  getContainerKindConfig,
  NO_CONTAINER,
} from '@/lib/container-registry';
import { containerRefOf } from '@/lib/filters';
import { getAllItemTypeNames, getItemTypeConfig } from '@/lib/item-registry';
import type { Item } from '@/lib/planner-types';

describe('the CLASSIFY role survived the kind', () => {
  it('has exactly one kind, on exactly one item field', () => {
    expect(CLASSIFY_KINDS).toHaveLength(1);
    const fields = CLASSIFY_KINDS.map((k) => getContainerKindConfig(k).itemField);
    expect(new Set(fields).size).toBe(1);
    expect(fields[0]).toBe('project');
  });

  it('leaves the other two roles exactly as they were', () => {
    // The point of the ticket: collapse a KIND, keep the three ROLES. A
    // regression here is the collapse having gone one step too far.
    const roles = Object.values(CONTAINER_KINDS).map((c) => c.role);
    expect(new Set(roles)).toEqual(new Set(['classify', 'gate', 'aspire']));
    expect(roles.filter((r) => r === 'gate')).toHaveLength(2);
    expect(roles.filter((r) => r === 'aspire')).toHaveLength(1);
  });

  it('answers with one ref per item, whatever its type', () => {
    const asItem = (partial: Record<string, unknown>) => partial as unknown as Item;
    for (const typeName of getAllItemTypeNames()) {
      const type = typeName === 'task' || typeName === 'habit' ? typeName : 'custom';
      const row = asItem({ type, customType: typeName, project: 'Work' });
      expect(containerRefOf(row), typeName).toBe('project:Work');
    }
  });

  it('reads a stray value on the RETIRED field as unset, never as a second answer', () => {
    const asItem = (partial: Record<string, unknown>) => partial as unknown as Item;
    // `items."group"` survives as ballast. An item that somehow carried both
    // must answer with the one field the registry names, or "which container is
    // this in?" has two answers again.
    expect(containerRefOf(asItem({ type: 'habit', group: 'Health' }))).toBe(NO_CONTAINER);
    expect(containerRefOf(asItem({ type: 'habit', group: 'Health', project: 'Work' }))).toBe(
      'project:Work'
    );
  });

  it('keeps `containerRequired` as the thing that still distinguishes a habit', () => {
    // The capability, not the kind. This is what `unfiled` reads to decide
    // between unfiling a member and reassigning it.
    expect(getItemTypeConfig('habit').containerRequired).toBe(true);
    expect(getItemTypeConfig('task').containerRequired).toBe(false);
    expect(getItemTypeConfig('habit').containerKind).toBe(
      getItemTypeConfig('task').containerKind
    );
  });
});

/* ── 3. the migration ───────────────────────────────────────────────────── */

/**
 * A TEXT TEST, and worth saying what that is worth.
 *
 * This container has no Postgres, so nothing here executes the migration —
 * it cannot catch a syntax error, a wrong column name, or a join that matches
 * the wrong rows. What it CAN catch is the specific edits that turn a
 * re-runnable backfill into a destructive one, because each is a clause whose
 * absence is visible in the text: an UPDATE that stops checking whether the
 * destination is already set will drag a re-filed habit back to where it was,
 * and an INSERT without its conflict clause will 23505 the whole DO block on a
 * second pass.
 *
 * The migration is expected to be applied by hand (`pnpm db:push` is not run
 * from here), so a re-run is not hypothetical: it is the normal way a partially
 * applied migration is finished.
 */
const SQL = readFileSync(
  resolve(__dirname, '../../supabase/migrations/039_one_classify_kind.sql'),
  'utf8'
);

describe('migration 039 is safe to re-run', () => {
  it('guards every statement on the tables actually existing', () => {
    // `projects` and `habit_groups` predate the ledger: prod got them from the old
    // schema.sql bootstrap, and only 000_baseline.sql creates them on an empty
    // database. 027 takes the same posture.
    expect(SQL).toContain("to_regclass('public.projects')");
    expect(SQL).toContain("to_regclass('public.habit_groups')");
  });

  it('never fills a destination that already has a value', () => {
    // THE re-run property. After the app ships, moving a habit to a different
    // container writes `items.project` and leaves the frozen `"group"` at its
    // old value; an unguarded re-run would move it back.
    const updates = SQL.match(/update public\.items[\s\S]*?;/g) ?? [];
    expect(updates.length).toBeGreaterThan(0);
    for (const stmt of updates) {
      expect(stmt, stmt.slice(0, 60)).toMatch(/i\.project is null/);
    }
  });

  it('cannot insert the same container twice', () => {
    expect(SQL).toContain('on conflict (id) do nothing');
  });

  it('states the collision rule as a folded-name check', () => {
    // Fold-equal names MERGE and the project row survives. Compared exactly,
    // an account holding a project 'Health' and a group 'health' would get two
    // rows the app then resolves to one — half its habits pointing at a
    // container no lookup can reach.
    expect(SQL).toMatch(/lower\(p\.name\) = lower\(g\.name\)/);
    expect(SQL).toMatch(/c\.folded = lower\(i\."group"\)/);
  });

  it('keeps text-only references, which are most of them', () => {
    // 027 counted 223 of 228 group references belonging to an account with zero
    // habit_groups rows. Skipping them would blank the container on nearly
    // every habit in the database.
    expect(SQL).toMatch(/set project = i\."group"/);
  });

  it('drops nothing — the ballast is the rollback', () => {
    expect(SQL).not.toMatch(/drop\s+table/i);
    expect(SQL).not.toMatch(/drop\s+column/i);
    expect(SQL).not.toMatch(/delete\s+from/i);
    // And it never writes the frozen columns, which is what makes reverting the
    // app deploy a real rollback rather than a nominal one. Matched as
    // `"group" =` anywhere rather than `set "group" =`, because the column is
    // just as dead when it is the second assignment in a SET list — which is
    // exactly how the first version of this assertion was got past.
    expect(SQL).not.toMatch(/"group"\s*=/);
    // BOTH halves of the ballast. `group_id` is the other one, and it is what
    // makes the ids resolvable if the app is rolled back — clearing it destroys
    // half the rollback while passing every assertion above.
    expect(SQL).not.toMatch(/\bgroup_id\s*=/);
    // The TABLE is ballast too, and soft-deleting every row of it is a way to
    // destroy it that names neither `drop` nor `delete`.
    expect(SQL).not.toMatch(/update\s+(public\.)?habit_groups/i);
  });

  it('prefers a LIVE row over a binned one, on both sides of the fold', () => {
    // The preference appears twice — once choosing which of two fold-equal habit
    // groups becomes a project, once choosing which project a name resolves to —
    // and both orderings must put live first. Flipped, items are filed into a
    // container that is IN THE TRASH: they vanish from every surface while the
    // database looks healthy. `(x is not null)` sorts false before true in
    // Postgres, so this exact spelling is the live-first one.
    const orders = SQL.match(/order by[\s\S]*?;/g) ?? [];
    const prefs = orders.filter((o) => o.includes('deleted_at is not null'));
    expect(prefs.length).toBe(2);
    for (const o of prefs) {
      expect(o).toMatch(/\(\w+\.deleted_at is not null\)/);
      expect(o).not.toMatch(/deleted_at is not null\)\s+desc/i);
    }
  });

  it('carries soft-deleted groups across rather than skipping them', () => {
    // Their members still point at them (027 links deleted parents on purpose),
    // so leaving them behind strands exactly the rows a Trash restore is for.
    // A `where g.deleted_at is null` on the insert would do it silently.
    const insert = SQL.slice(SQL.indexOf('insert into public.projects'));
    expect(insert).toContain('g.deleted_at');
    expect(insert).not.toMatch(/g\.deleted_at is null/);
  });

  it('writes the id alongside the name whenever there is one to write', () => {
    // Name without id is the pre-027 state: invisible to the rename fan-out, so
    // renaming the container silently empties it again. Section 4 must set both;
    // section 5 sets only the name, and honestly, because there is no row.
    const canonUpdate = SQL.slice(SQL.indexOf('with canon as'));
    expect(canonUpdate).toMatch(/set project = c\.name,\s*\n\s*project_id = c\.id/);
  });

  it('leaves the habit_groups rows themselves untouched', () => {
    // Renaming them (to mark them migrated, say) would make the rollback land on
    // data the old build never wrote.
    expect(SQL).not.toMatch(/habit_groups\s+(g\s+)?set\b/i);
  });

  it('refuses an account it cannot repair rather than proceeding', () => {
    // Two LIVE projects whose names fold equal. The app is about to start
    // folding, which makes them indistinguishable to every lookup AND makes
    // deleting either unfile the other's members. A migration cannot pick which
    // glyph, colour and name survive, so it stops.
    const guard = SQL.slice(SQL.indexOf('-- ─── 1b.'), SQL.indexOf('-- ─── 2.'));
    // REFUSES, not warns. A `raise notice` here would scroll past in a db:push
    // and leave the account in exactly the state the guard exists to prevent —
    // which is why this asserts on the guard block rather than on the file
    // (the preconditions above raise too, and would satisfy a file-wide match).
    expect(guard).toMatch(/raise exception/);
    expect(guard).not.toMatch(/raise notice/);
    expect(guard).toMatch(/having count\(\*\) > 1/);
    // LIVE rows only — a binned case-variant is invisible to the store and
    // cannot collide, so refusing on one would block a healthy account.
    expect(guard).toMatch(/p\.deleted_at is null/);
    // And it runs BEFORE anything is written.
    expect(SQL.indexOf('-- ─── 1b.')).toBeLessThan(SQL.indexOf('insert into public.projects'));
  });
});
