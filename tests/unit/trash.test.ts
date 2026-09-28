import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * THE TRASH (Organize console, Phase 4).
 *
 * Three things are worth a test here and each one is a way the feature passes
 * its own gate while destroying data:
 *
 *  1. `listDeleted` must JOIN membership. `itemIds` is not a column — only
 *     `fetchRoutines` produces it, and it hard-filters `deleted_at`, so a
 *     trashed routine has no other source anywhere in the codebase. Hand the
 *     store `itemIds: []` and `reconcileMembership`, which writes membership
 *     absolutely, hard-DELETEs every join row the soft delete existed to
 *     preserve. The gate ("the row is back on the canvas") passes either way.
 *  2. `restoreItem` must undo `deleteItem`'s subtask cascade, and only the part
 *     of it that belongs to the same gesture.
 *  3. Subtasks that went down WITH a parent must not appear as their own bin
 *     rows — one delete would otherwise deposit N+1 lines, and restoring the
 *     child alone puts it somewhere no canvas surface renders.
 */

interface Row {
  [key: string]: unknown;
}

let tables: Record<string, Row[]> = {};
const updates: { table: string; payload: Row; filters: [string, unknown][] }[] = [];

/**
 * Enough of PostgREST to answer these queries honestly: `.eq`, `.is`, `.in`,
 * `.not('deleted_at','is',null)`, `.order`, `.maybeSingle`, and thenable so a
 * query can be awaited without a terminal call.
 */
function makeClient() {
  const build = (table: string, kind: 'select' | 'update', payload?: Row, columns?: string) => {
    const filters: [string, unknown][] = [];
    // PostgREST returns ONLY the projected columns, and the mock has to as
    // well: a mock that hands back whole rows lets a function look correct
    // while reading a field its own query never asked for.
    const project = (row: Row): Row => {
      if (!columns || columns.trim() === '*') return { ...row };
      const keep = columns.split(',').map((c) => c.trim());
      return Object.fromEntries(keep.map((c) => [c, row[c]]));
    };
    const match = (row: Row) =>
      filters.every(([col, val]) => {
        if (col === '__notnull') return row[val as string] !== null && row[val as string] !== undefined;
        if (Array.isArray(val)) return val.includes(row[col]);
        return row[col] === val;
      });
    const run = () => {
      // items_windowed (migration 031) is a view over items — same rows, with
      // the two date arrays trimmed. Reads resolve to the same backing rows so
      // this suite keeps testing the bin's roll-up logic rather than the view;
      // writes still name `items`, which is what the update assertions check.
      const backing = table === 'items_windowed' ? 'items' : table;
      const hit = (tables[backing] ?? []).filter(match);
      if (kind === 'update') {
        updates.push({ table, payload: payload!, filters: [...filters] });
        for (const row of hit) Object.assign(row, payload);
        return Promise.resolve({ data: null, error: null });
      }
      return Promise.resolve({ data: hit.map(project), error: null });
    };
    const chain: Record<string, unknown> = {
      eq: (col: string, val: unknown) => (filters.push([col, val]), chain),
      is: (col: string, val: unknown) => (filters.push([col, val]), chain),
      in: (col: string, vals: unknown[]) => (filters.push([col, vals]), chain),
      not: (col: string, op: string, val: unknown) => {
        if (op === 'is' && val === null) filters.push(['__notnull', col]);
        return chain;
      },
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => run().then((r) => ({ data: (r.data as Row[])?.[0] ?? null, error: null })),
      then: (resolve: (v: unknown) => unknown) => run().then(resolve),
    };
    return chain;
  };
  return {
    from: (table: string) => ({
      select: (columns?: string) => build(table, 'select', undefined, columns),
      update: (payload: Row) => build(table, 'update', payload),
    }),
  };
}

vi.mock('@/lib/supabase', () => ({ createClient: () => makeClient() }));
vi.mock('@/lib/openclaw-registry', () => ({ notifyPlugins: vi.fn() }));

import { listDeleted, restoreItem, fetchTrashedNames } from '@/lib/db';

const U = 'u1';
const T1 = '2026-08-10T10:00:00.000Z';
const T2 = '2026-08-12T10:00:00.000Z';

const item = (over: Row): Row => ({
  id: 'i1', user_id: U, type: 'task', title: 'A task', status: 'pending',
  completed_dates: [], deleted_at: null, parent_item_id: null, ...over,
});

beforeEach(() => {
  updates.length = 0;
  tables = {
    items: [],
    projects: [],
    habit_groups: [],
    routines: [],
    routine_items: [],
    seasons: [],
    season_items: [],
    season_routines: [],
  };
});

describe('listDeleted', () => {
  it('hydrates a trashed routine from its surviving join rows', async () => {
    // The whole point of a soft delete here: deleteRoutine leaves routine_items
    // alone "so a restore within the 30-day window brings the routine back
    // intact". If this arrives empty, the first membership edit — or a plain
    // redo, which replays the full shape — hard-deletes all three.
    //
    // The fixture uses NON-DEFAULT values in every column and the assertion is
    // whole-object, because restoreFromTrash seats this entity verbatim and the
    // history subscriber snapshots it. Asserting only itemIds let every other
    // mapped field be dropped with the suite still green.
    tables.routines = [{
      id: 'r1', user_id: U, name: 'Morning', icon: 'icon:Sun', color: '#84cc16',
      paused_at: T1, paused_until: '2026-09-01', sort_order: 3, deleted_at: T2,
    }];
    tables.routine_items = [
      { routine_id: 'r1', item_id: 'a', user_id: U, sort_order: 0 },
      { routine_id: 'r1', item_id: 'b', user_id: U, sort_order: 1 },
      { routine_id: 'other', item_id: 'z', user_id: U, sort_order: 0 },
    ];

    const [entry] = await listDeleted(U);
    expect(entry.kind).toBe('routine');
    expect(entry.entity).toEqual({
      id: 'r1', name: 'Morning', icon: 'icon:Sun', color: '#84cc16',
      pausedAt: T1, pausedUntil: '2026-09-01', sortOrder: 3, itemIds: ['a', 'b'],
    });
    // And the entity NEVER carries the deletion stamp — a store row holding one
    // could enter an undo snapshot and be written back as a soft delete.
    expect('deletedAt' in (entry.entity as object)).toBe(false);
  });

  it('hydrates a trashed season from BOTH of its join tables', async () => {
    // state: 'completed' rather than 'active', so a hard-coded default cannot
    // pass this by accident.
    tables.seasons = [{
      id: 'p1', user_id: U, name: 'Summer', icon: 'icon:Sun', color: '#f97316',
      state: 'completed', starts_on: '2026-06-01', ends_on: '2026-08-31',
      sort_order: 2, updated_at: T1, deleted_at: T2,
    }];
    tables.season_items = [{ season_id: 'p1', item_id: 'a', user_id: U }];
    tables.season_routines = [{ season_id: 'p1', routine_id: 'r9', user_id: U }];

    const [entry] = await listDeleted(U);
    expect(entry.entity).toEqual({
      id: 'p1', name: 'Summer', icon: 'icon:Sun', color: '#f97316',
      state: 'completed', startsOn: '2026-06-01', endsOn: '2026-08-31',
      sortOrder: 2, updatedAt: T1, itemIds: ['a'], routineIds: ['r9'],
    });
  });

  it('maps a trashed project through the same mapper the live fetch uses', async () => {
    tables.projects = [{
      id: 'pr1', user_id: U, name: 'Work', emoji: 'icon:Briefcase', color: '#84cc16',
      repeat_frequency: 'weekdays', time_bucket: 'morning', start_time: '09:00',
      duration: 45, deleted_at: T2,
    }];

    const [entry] = await listDeleted(U);
    expect(entry.icon).toBe('icon:Briefcase');
    expect(entry.color).toBe('#84cc16');
    expect(entry.entity).toEqual({
      id: 'pr1', name: 'Work', emoji: 'icon:Briefcase', color: '#84cc16',
      repeatFrequency: 'weekdays', repeatDays: undefined, repeatMonthDay: undefined,
      timeBucket: 'morning', startTime: '09:00', duration: 45,
    });
  });

  it('rolls co-deleted subtasks up under their parent instead of listing them', async () => {
    tables.items = [
      item({ id: 'parent', title: 'Plan trip', deleted_at: T2 }),
      item({ id: 'kid1', title: 'Book flight', parent_item_id: 'parent', deleted_at: T2 }),
      item({ id: 'kid2', title: 'Pack', parent_item_id: 'parent', deleted_at: T2 }),
    ];

    const rows = await listDeleted(U);
    expect(rows.map((r) => r.id)).toEqual(['parent']);
    expect(rows[0].children?.map((c) => c.id)).toEqual(['kid1', 'kid2']);
  });

  it('keeps a subtask deleted on its own as its own row', async () => {
    // Its parent is LIVE, so restoring it lands somewhere the user can see —
    // the parent's detail panel reads `items`, not the tasks projection.
    tables.items = [
      item({ id: 'parent', title: 'Plan trip', deleted_at: null }),
      item({ id: 'kid1', title: 'Book flight', parent_item_id: 'parent', deleted_at: T2 }),
    ];

    const rows = await listDeleted(U);
    expect(rows.map((r) => r.id)).toEqual(['kid1']);
    expect(rows[0].children).toBeUndefined();
  });

  it('shows a subtask binned BEFORE its parent — in exactly one row, never none', async () => {
    // The bin's invisible corner, and the reason the deleted_at coupling went.
    // The skip asked "is the parent trashed" while the roll-up asked "at the
    // same instant"; a child binned on Monday whose parent followed on Tuesday
    // passed the first and failed the second, so it rendered in NO row — not
    // its own, not under the parent — and the stamp-matched restore cascade
    // would not have brought it back either. Invisible until the 30-day purge.
    tables.items = [
      item({ id: 'parent', title: 'Plan trip', deleted_at: T2 }),
      item({ id: 'kid', title: 'Book flight', parent_item_id: 'parent', deleted_at: T1 }),
    ];

    const rows = await listDeleted(U);
    expect(rows.map((r) => r.id)).toEqual(['parent']);
    expect(rows[0].children?.map((c) => c.id)).toEqual(['kid']);
  });

  it('leaves no trashed item out of the bin, whatever the stamps', async () => {
    // The invariant, stated directly: the skip and the roll-up are complements,
    // so every trashed row is reachable through exactly one bin entry. The
    // store's own deleteTask gives each child its own millisecond, so mixed
    // stamps under one parent are the NORMAL case, not an exotic one.
    tables.items = [
      item({ id: 'parent', deleted_at: '2026-08-12T10:00:00.001Z' }),
      item({ id: 'kidA', parent_item_id: 'parent', deleted_at: '2026-08-12T10:00:00.002Z' }),
      item({ id: 'kidB', parent_item_id: 'parent', deleted_at: '2026-08-12T10:00:00.003Z' }),
    ];

    const rows = await listDeleted(U);
    const reachable = new Set(rows.flatMap((r) => [r.id, ...(r.children ?? []).map((c) => c.id)]));
    expect(reachable).toEqual(new Set(['parent', 'kidA', 'kidB']));
  });

  it('reports the live members a trashed project still holds by id', async () => {
    // removeProject clears the store's copy and writes nothing to items, so the
    // DB link survives on purpose (027). This is the only way the store can
    // learn it back — without it a restored project comes back visibly empty.
    tables.projects = [{ id: 'pr1', user_id: U, name: 'Work', emoji: 'x', deleted_at: T2 }];
    tables.items = [
      item({ id: 'm1', project_id: 'pr1' }),
      item({ id: 'm2', project_id: 'pr1' }),
      item({ id: 'other', project_id: 'pr-else' }),
    ];

    const entry = (await listDeleted(U)).find((r) => r.kind === 'project')!;
    expect(entry.memberIds?.sort()).toEqual(['m1', 'm2']);
  });

  it('sorts across all five tables before capping, not within each', async () => {
    // Capping per-table would hide a routine deleted a minute ago behind a
    // hundred older items.
    tables.items = [item({ id: 'old', deleted_at: T1 })];
    tables.routines = [{ id: 'r1', user_id: U, name: 'Newer', deleted_at: T2 }];

    const rows = await listDeleted(U);
    expect(rows.map((r) => r.id)).toEqual(['r1', 'old']);
  });

  it('leaves live rows out entirely', async () => {
    tables.items = [item({ id: 'live', deleted_at: null })];
    tables.projects = [{ id: 'pr1', user_id: U, name: 'Work', emoji: 'x', deleted_at: null }];
    expect(await listDeleted(U)).toEqual([]);
  });
});

describe('restoreItem', () => {
  it('brings back the subtasks that went down in the same gesture', async () => {
    tables.items = [
      item({ id: 'parent', deleted_at: T2 }),
      item({ id: 'kid', parent_item_id: 'parent', deleted_at: T2 }),
    ];

    await restoreItem('parent', 'task');

    expect(tables.items.find((r) => r.id === 'parent')!.deleted_at).toBeNull();
    expect(tables.items.find((r) => r.id === 'kid')!.deleted_at).toBeNull();
  });

  it('brings back a child with a DIFFERENT stamp, because the stamps diverge in practice', async () => {
    // This is the assertion that reversed. It used to demand the opposite — a
    // child binned earlier stayed behind — on the theory that equal stamps mean
    // "same gesture". They do not: planner-store's deleteTask re-stamps every
    // child with its own `new Date()` after the parent's, so a plain one-click
    // delete already produces mixed stamps. Keying on them stranded subtasks in
    // a bin row that did not exist. Every trashed child under this parent now
    // comes back with it.
    tables.items = [
      item({ id: 'parent', deleted_at: T2 }),
      item({ id: 'kid', parent_item_id: 'parent', deleted_at: T1 }),
    ];

    await restoreItem('parent', 'task');

    expect(tables.items.find((r) => r.id === 'parent')!.deleted_at).toBeNull();
    expect(tables.items.find((r) => r.id === 'kid')!.deleted_at).toBeNull();
  });

  it('leaves a LIVE child alone', async () => {
    // The `not deleted_at is null` filter earns its place here: a live subtask
    // must not be written at all, or a restore would touch rows it has no
    // business touching.
    tables.items = [
      item({ id: 'parent', deleted_at: T2 }),
      item({ id: 'kid', parent_item_id: 'parent', deleted_at: null }),
    ];

    await restoreItem('parent', 'task');

    const written = updates.filter((u) => u.table === 'items');
    expect(written).toHaveLength(2);
    expect(tables.items.find((r) => r.id === 'kid')!.deleted_at).toBeNull();
  });

  it('does not cascade for a habit', async () => {
    // Habits cannot have subtasks — deleteItem guards the same way, and a
    // parent_item_id sweep here would be a query against nothing.
    tables.items = [item({ id: 'h1', type: 'habit', deleted_at: T2 })];
    await restoreItem('h1', 'habit');
    expect(updates.filter((u) => u.table === 'items')).toHaveLength(1);
  });
});

describe('fetchTrashedNames', () => {
  it('returns names AS STORED, so the caller can match the index exactly', async () => {
    // projects.name is plain text and the unique index is case-SENSITIVE, so
    // only an exact repeat collides. Folding here would refuse "work" against a
    // trashed "Work" — a name Postgres accepts.
    tables.projects = [{ id: 'pr1', user_id: U, name: 'Work', deleted_at: T2 }];
    const { projects } = await fetchTrashedNames(U);
    expect(projects).toEqual([{ id: 'pr1', name: 'Work' }]);
  });

  it('ignores live rows — the store already knows about those', async () => {
    tables.projects = [{ id: 'pr1', user_id: U, name: 'Live', deleted_at: null }];
    const { projects } = await fetchTrashedNames(U);
    expect(projects).toEqual([]);
  });
});
