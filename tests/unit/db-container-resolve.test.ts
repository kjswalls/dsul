import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Server-side container-id resolution (migration 027).
 *
 * THE AGENT PATH HAS NO STORE. planner-store's projectIdFor resolves
 * every client write against containers already in memory, but
 * /api/agent/tasks and /api/agent/habits never touch Zustand — and both create
 * schemas deliberately `.omit()` the id, because an agent holds no id↔name map.
 * So lib/db.ts has to do the lookup, or an agent-named container yields a row
 * with the name and a NULL id: invisible to the id-keyed rename fan-out, which
 * is the exact orphaning Phase 0 exists to remove.
 *
 * The UPDATE half matters more than the create half, and is the reason this is
 * a bug rather than an omission: leaving a stale id behind is WORSE than the
 * pre-027 behaviour, because the fan-out treats the id as truth and would drag
 * the item back into the container it was moved out of.
 */

const inserts: { table: string; payload: Record<string, unknown> }[] = [];
const updated: { table: string; payload: Record<string, unknown> }[] = [];

let rows: Record<string, { id: string; name: string; user_id: string }[]> = {};
/** Simulates a pre-027 database, where the lookup itself cannot be answered. */
let selectErrors = false;

vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    from: (table: string) => ({
      insert: (payload: Record<string, unknown>) => {
        inserts.push({ table, payload });
        return Promise.resolve({ error: null });
      },
      update: (payload: Record<string, unknown>) => {
        const chain = {
          eq: () => chain,
          is: () => chain,
          then: (resolve: (v: { error: null }) => unknown) => {
            updated.push({ table, payload });
            return Promise.resolve({ error: null }).then(resolve);
          },
        };
        return chain;
      },
      select: () => {
        const filters: [string, unknown][] = [];
        const run = () =>
          selectErrors
            ? Promise.resolve({ data: null, error: { message: 'relation does not exist' } })
            : Promise.resolve({
                data: (rows[table] ?? []).filter((r) =>
                  filters.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v)
                ),
                error: null,
              });
        const chain = {
          eq: (col: string, val: unknown) => {
            filters.push([col, val]);
            return chain;
          },
          limit: run,
          // PostgrestFilterBuilder is thenable, so a query can be awaited
          // WITHOUT .limit() — which is exactly how the case-folding fallback
          // fetches the user's whole (tiny) container list.
          then: (resolve: (v: unknown) => unknown) => run().then(resolve),
        };
        return chain;
      },
    }),
  }),
}));
vi.mock('@/lib/openclaw-registry', () => ({ notifyPlugins: vi.fn() }));

import { createItem, updateItem, updateTask, updateHabit } from '@/lib/db';
import type { Item } from '@dsul/types';

const itemsInsert = () => inserts.find((i) => i.table === 'items')!.payload;
const itemsUpdate = () => updated.find((u) => u.table === 'items')!.payload;

const task: Item = {
  type: 'task', id: 't1', title: 'x', status: 'pending', isScheduled: false, order: 0,
};
const habit: Item = {
  type: 'habit', id: 'h1', title: 'y', project: 'Wellness', streak: 0, status: 'pending',
  completedDates: [], skippedDates: [], dailyCounts: {}, repeatFrequency: 'daily',
};

beforeEach(() => {
  inserts.length = 0;
  updated.length = 0;
  selectErrors = false;
  rows = {
    // One table since 039 collapsed the two CLASSIFY kinds. `habit_groups` is
    // deliberately absent: a lookup that still read it would find nothing here
    // and the habit cases below would go red rather than silently pass.
    projects: [
      { id: 'pr-work', name: 'Work', user_id: 'u1' },
      { id: 'gr-well', name: 'Wellness', user_id: 'u1' },
    ],
  };
});

describe('create resolves the container name to an id', () => {
  it('links a task the agent filed by name', async () => {
    await createItem('u1', { ...task, project: 'Work' });
    expect(itemsInsert()).toMatchObject({ project: 'Work', project_id: 'pr-work' });
  });

  it('links a habit the agent filed by name', async () => {
    await createItem('u1', habit);
    expect(itemsInsert()).toMatchObject({ project: 'Wellness', project_id: 'gr-well' });
  });

  it('writes no id column when there is no name to resolve', async () => {
    await createItem('u1', task);
    expect(itemsInsert()).not.toHaveProperty('project_id');
  });

  it('leaves an already-resolved id alone instead of re-querying', async () => {
    // The store resolves its own before it ever reaches here.
    await createItem('u1', { ...task, project: 'Work', projectId: 'pr-explicit' });
    expect(itemsInsert()).toMatchObject({ project_id: 'pr-explicit' });
  });

  it('omits the column entirely when the lookup cannot be answered', async () => {
    // Pre-027 database: PostgREST rejects an INSERT naming a column absent from
    // its schema cache, so a guessed NULL here would break every item create,
    // not only container-bearing ones.
    //
    // A weak test on its own, and worth saying so: on the CREATE path "no such
    // container" and "cannot ask" both end as an omitted column, so this cannot
    // distinguish them. The update pair below is where the distinction is
    // observable and therefore where it is actually pinned.
    selectErrors = true;
    await createItem('u1', { ...task, project: 'Work' });
    expect(itemsInsert()).not.toHaveProperty('project_id');
  });
});

describe('null and undefined are different answers', () => {
  it('NULLs the id when the container does not exist', async () => {
    await updateTask('t1', { project: 'Housework' });
    expect(itemsUpdate()).toHaveProperty('project_id', null);
  });

  it('OMITS the column when the lookup itself cannot be answered', async () => {
    // Same patch, same absent container — but a database that cannot answer
    // must not have a NULL guessed onto it, or every re-file against a pre-027
    // schema fails with PGRST204 instead of degrading.
    selectErrors = true;
    await updateTask('t1', { project: 'Housework' });
    expect(itemsUpdate()).not.toHaveProperty('project_id');
  });
});

/**
 * Through updateTask/updateHabit, NOT updateItem — that boundary IS the fix.
 * `lib/agent-api.ts` is the only caller of these two wrappers in the tree, so
 * putting the resolution here makes "this write means a re-file" an explicit
 * entry point rather than something inferred from the patch's shape. See the
 * undo case at the bottom for what inferring it cost.
 */
describe('an agent re-file moves the id with the name', () => {
  it('resolves the new container', async () => {
    await updateTask('t1', { project: 'Work' });
    expect(itemsUpdate()).toMatchObject({ project: 'Work', project_id: 'pr-work' });
  });

  it('CLEARS the id when the new name matches no container', async () => {
    // The stale-id trap. Left pointing at the old project, the rename fan-out
    // would rewrite this item's name and pull it back into a container the
    // agent had explicitly moved it out of.
    await updateTask('t1', { project: 'Housework' });
    expect(itemsUpdate()).toMatchObject({ project: 'Housework', project_id: null });
  });

  it('clears the id when the item is unfiled', async () => {
    await updateTask('t1', { project: undefined });
    expect(itemsUpdate()).toMatchObject({ project: null, project_id: null });
  });

  it('does the same on the habit side, through the LEGACY field name', async () => {
    // The agent's vocabulary is pinned: `HabitUpdateSchema` still takes `group`,
    // and `fromLegacyHabitUpdates` renames it to `project` at the boundary. A
    // patch that reached the allowlist still spelled `group` would write
    // nothing at all, silently.
    await updateHabit('h1', { group: 'Wellness' });
    expect(itemsUpdate()).toMatchObject({ project: 'Wellness', project_id: 'gr-well' });
  });

  it('unfiles a habit for real, frozen group column included', async () => {
    // A habit's project is optional (2026-10-01). Cleared, both names go: the
    // read falls back to `"group"` when `project` is NULL, so leaving the old
    // habit-group name there would refile the habit on the next load.
    await updateItem('h1', 'habit', { project: undefined, projectId: undefined });
    expect(itemsUpdate()).toMatchObject({ project: null, group: null, project_id: null });
  });

  it('folds case, as every other container lookup does', async () => {
    // projectIdFor, getProjectEmoji, getProjectColor and addProject's de-dupe
    // all normalise. Exact-only here does not merely fail to link — it writes
    // NULL over an id that was already correct, putting the item outside the
    // rename fan-out.
    await updateHabit('h1', { group: 'wellness' });
    expect(itemsUpdate()).toMatchObject({ project: 'wellness', project_id: 'gr-well' });
  });

  it('folds on the TASK side too, which is what 039 changed', async () => {
    // Projects compared exactly before the kinds merged, so this asserted a
    // NULL id. One kind means one policy and the folding half is the survivor.
    await updateTask('t1', { project: 'work' });
    expect(itemsUpdate()).toMatchObject({ project: 'work', project_id: 'pr-work' });
  });

  it('does not re-query when the caller already sent both halves', async () => {
    await updateTask('t1', { project: 'Work', projectId: 'pr-explicit' } as Parameters<
      typeof updateTask
    >[1]);
    expect(itemsUpdate()).toMatchObject({ project_id: 'pr-explicit' });
  });

  it('touches neither column when the patch names no container', async () => {
    await updateTask('t1', { title: 'renamed' });
    expect(itemsUpdate()).not.toHaveProperty('project_id');
  });
});

describe('updateItem does NOT infer a re-file from a name-only patch', () => {
  it('leaves the id untouched — this is the undo path', async () => {
    // THE REGRESSION THIS BOUNDARY EXISTS FOR. Renaming a project rewrites its
    // members' `project` text in the same set(), so undo's diffItem produces
    // exactly {project: <old name>} — no id, because the member's id never
    // moved. Resolved here, that looked like a re-file into a container whose
    // name had not been restored yet (the item loop runs before syncContainers,
    // and both are unawaited), so it wrote project_id = null onto every member
    // and unlinked the container it was restoring.
    await updateItem('t1', 'task', { project: 'Work' });
    expect(itemsUpdate()).toMatchObject({ project: 'Work' });
    expect(itemsUpdate()).not.toHaveProperty('project_id');
  });

  it('still writes an id the caller sent explicitly', async () => {
    await updateItem('t1', 'task', { project: 'Work', projectId: 'pr-work' });
    expect(itemsUpdate()).toMatchObject({ project: 'Work', project_id: 'pr-work' });
  });
});
