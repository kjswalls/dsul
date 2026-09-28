import { describe, it, expect } from 'vitest';
import { groupRows, type GroupableRow } from '@/lib/grouping';
import { groupBySupport } from '@/lib/view-options';
import type { Goal, GroupBy, HabitItem, Task } from '@/lib/planner-types';

/**
 * The shared grouping core (Phase 5a).
 *
 * `buildListGroups` lived inside components/views/day-list.tsx, which is why one
 * view honoured five values and the other five honoured at most one. These cases
 * are about what moved and what CHANGED while it moved — the container axis and
 * the priority axis both stopped hoisting habits into a section named after
 * their type.
 */

const task = (id: string, over: Partial<Task> = {}): Task =>
  ({
    id,
    title: `Task ${id}`,
    status: 'pending',
    isScheduled: true,
    order: 0,
    timeBucket: 'morning',
    ...over,
  }) as Task;

const habit = (id: string, over: Partial<HabitItem> = {}): HabitItem =>
  ({
    id,
    title: `HabitItem ${id}`,
    project: 'Health',
    streak: 0,
    status: 'pending',
    completedDates: [],
    skippedDates: [],
    repeatFrequency: 'daily',
    timeBucket: 'morning',
    ...over,
  }) as HabitItem;

const t = (id: string, over: Partial<Task> = {}): GroupableRow => ({
  itemType: 'task',
  item: task(id, over),
});
const h = (id: string, over: Partial<HabitItem> = {}): GroupableRow => ({
  itemType: 'habit',
  item: habit(id, over),
});

const goal = (id: string, over: Partial<Goal> = {}): Goal => ({
  id,
  name: `Goal ${id}`,
  state: 'active',
  memberIds: [],
  milestoneIds: [],
  checkinIds: [],
  ...over,
});

const labels = (gs: { label: string }[]) => gs.map((g) => g.label);
const ids = (g: { rows: GroupableRow[] }) => g.rows.map((r) => r.item.id);

describe('groupRows — the container axis', () => {
  it('sections habits by their own container instead of hoisting them out', () => {
    // The half of the habits fix grouping never got. buildListGroups put every
    // habit in one "Habits" section and grouped only the tasks, so "group by
    // Project" answered a question about tasks and then filed the rest of the
    // day under its own type name. A habit is not container-less — it answers
    // on the same axis, exactly as passesContainerFilter has since Phase 1.
    const out = groupRows([h('h1', { project: 'Health' }), t('t1', { project: 'Work' })], 'project');

    expect(labels(out)).toEqual(['Health', 'Work']);
    expect(out.map(ids)).toEqual([['h1'], ['t1']]);
  });

  it('puts a habit and a task naming the SAME container in ONE section', () => {
    // The asserted opposite before migration 039: DEFAULT_PROJECTS and
    // DEFAULT_HABIT_GROUPS both seeded Work, and the two namespaces had to keep
    // two same-named sections apart under distinct React keys. One namespace
    // means the collision is gone at the source, and "Work" is one place.
    const out = groupRows([h('h1', { project: 'Work' }), t('t1', { project: 'Work' })], 'project');

    expect(out).toHaveLength(1);
    expect(out[0].key).toBe('project:work');
    expect(ids(out[0])).toEqual(['h1', 't1']);
  });

  it('merges two case-variant spellings of ONE container', () => {
    // The filter folds case, because makeAddDraft writes a lowercase 'personal'
    // against a seeded 'Personal' whenever the container list has not loaded.
    // Keyed on the raw ref, grouping split them into two sections that the
    // menu's single "Personal" checkbox selects together.
    const out = groupRows([h('h1', { project: 'personal' }), h('h2', { project: 'Personal' })], 'project');

    expect(out).toHaveLength(1);
    expect(ids(out[0])).toEqual(['h1', 'h2']);
    // First spelling seen wins the heading — the store's own order.
    expect(out[0].label).toBe('personal');
  });

  it('folds case for TASK containers too, since one kind means one policy', () => {
    const out = groupRows([t('t1', { project: 'work' }), t('t2', { project: 'Work' })], 'project');

    expect(out).toHaveLength(1);
    expect(out[0].key).toBe('project:work');
  });

  it('gives every unset item ONE section, whatever its type', () => {
    // Two headings before 039 — "No group" over habits and "No project" over
    // tasks — because "No project" over a stack of habits would have been
    // false. One kind, one unset heading, and it is the registry's
    // `unsetLabel`.
    const out = groupRows([h('h1', { project: '' }), t('t1', { project: undefined })], 'project');

    expect(labels(out)).toEqual(['No project']);
    expect(ids(out[0])).toEqual(['h1', 't1']);
  });

  it('puts the unset sections last, however early they arrive', () => {
    // The sort side's rule (sort-rows.ts UNSET_RANK) applied to sections: most
    // items have no container, so first would bury the ones that do.
    const out = groupRows(
      [t('none1', { project: undefined }), t('w', { project: 'Work' })],
      'project'
    );

    expect(labels(out)).toEqual(['Work', 'No project']);
  });

  it('resolves a custom type through the registry, not as a bare task', () => {
    // The custom template carries containerKind: 'projects' (Step 1). Before
    // that fix buildListGroups filed every custom item under "No project"
    // while it carried a real one.
    const out = groupRows(
      [{ itemType: 'task', item: task('c', { type: 'custom', customType: 'errand', project: 'Work' } as Partial<Task>) }],
      'project'
    );

    expect(labels(out)).toEqual(['Work']);
  });
});

describe('groupRows — the priority axis', () => {
  it('lands a habit in No priority, not in a section named for its type', () => {
    // The same call sortRows already makes: a type that does not CARRY priority
    // ranks as unset. The old "Habits" section here was type grouping smuggled
    // into a priority question — and it silently excluded custom types, which
    // DO carry priority and so were ranked while habits were hoisted.
    const out = groupRows([h('h1'), t('t1', { priority: 'high' })], 'priority');

    expect(labels(out)).toEqual(['High', 'No priority']);
    expect(ids(out[1])).toEqual(['h1']);
  });

  it('holds the High/Medium/Low/None ladder whatever order rows arrive in', () => {
    const out = groupRows(
      [t('l', { priority: 'low' }), t('n'), t('hi', { priority: 'high' }), t('m', { priority: 'medium' })],
      'priority'
    );

    expect(labels(out)).toEqual(['High', 'Medium', 'Low', 'No priority']);
  });

  it('emits no empty sections for the bands nothing is in', () => {
    const out = groupRows([t('hi', { priority: 'high' })], 'priority');
    expect(labels(out)).toEqual(['High']);
  });
});

describe('groupRows — the bucket axis', () => {
  it('orders sections by BUCKET_ORDER, not by arrival', () => {
    const out = groupRows(
      [t('e', { timeBucket: 'evening' }), t('a', { timeBucket: 'anytime' })],
      'bucket'
    );

    expect(labels(out)).toEqual(['Anytime', 'Evening']);
  });

  it('keeps a bucketless row in a trailing section rather than eating it', () => {
    // Unreachable from the canvas — deriveDayItems drops anything without a
    // bucket — but the braindump's corpus is exactly the rows that have none,
    // and a grouping that dropped them would be a disappearing-items bug.
    const out = groupRows([t('u', { timeBucket: undefined }), t('m')], 'bucket');

    expect(labels(out)).toEqual(['Morning', 'No time bucket']);
    expect(ids(out[1])).toEqual(['u']);
  });
});

describe('groupRows — the aspire axis', () => {
  /**
   * A goal is many-to-many, so it is NOT a partition — the same shape routines
   * and seasons have, and these cases are deliberately the routine cases with
   * a goal in them. The rule is first-claim-wins, borrowed rather than invented:
   * rendering a row under each of its goals is two checkboxes for one
   * obligation, and the second copy is a row shift-range and ⌘A silently skip.
   */
  it('claims a row for ONE goal — the first, in store order', () => {
    const health = goal('g1', { memberIds: ['run'] });
    const marathon = goal('g2', { memberIds: ['run'] });

    const out = groupRows([t('run')], 'goal', { goals: [health, marathon] });

    expect(labels(out)).toEqual(['Goal g1']);
    expect(out.flatMap(ids)).toEqual(['run']);
  });

  it('follows STORE ORDER for the claim, so reordering the goals moves the row', () => {
    const health = goal('g1', { memberIds: ['run'] });
    const marathon = goal('g2', { memberIds: ['run'] });

    const out = groupRows([t('run')], 'goal', { goals: [marathon, health] });

    expect(labels(out)).toEqual(['Goal g2']);
  });

  it('holds habits and tasks together — a goal is the one container that spans both', () => {
    const g = goal('g1', { memberIds: ['practice', 'book-exam'] });

    const out = groupRows([t('book-exam'), h('practice')], 'goal', { goals: [g] });

    expect(labels(out)).toEqual(['Goal g1']);
    expect(ids(out[0])).toEqual(['practice', 'book-exam']);
  });

  it("orders a section by the GOAL's own sequence — milestones, check-ins, members", () => {
    // Not the row order it was handed. The checkpoints lead, which is the one
    // place the goal's timeline order is visible outside its own surface.
    const g = goal('g1', { memberIds: ['m1'], milestoneIds: ['ms1'], checkinIds: ['c1'] });

    const out = groupRows([t('m1'), t('c1'), t('ms1')], 'goal', { goals: [g] });

    expect(ids(out[0])).toEqual(['ms1', 'c1', 'm1']);
  });

  it('keys on the goal ID, so two goals sharing a NAME stay two sections', () => {
    // `goals.name` is `text not null` with no UNIQUE and rename shipped with the
    // feature, exactly as for routines — keying on the name would merge two
    // goals into one heading holding both their work.
    const a = goal('g1', { name: 'Fitness', memberIds: ['x'] });
    const b = goal('g2', { name: 'Fitness', memberIds: ['y'] });

    const out = groupRows([t('x'), t('y')], 'goal', { goals: [a, b] });

    expect(out.map((g) => g.key)).toEqual(['g1', 'g2']);
    expect(labels(out)).toEqual(['Fitness', 'Fitness']);
  });

  it('files everything else under a trailing "No goal", and never drops it', () => {
    const g = goal('g1', { memberIds: ['served'] });

    const out = groupRows([t('loose'), t('served')], 'goal', { goals: [g] });

    expect(labels(out)).toEqual(['Goal g1', 'No goal']);
    expect(out.map((g) => g.key)).toEqual(['g1', 'goal:none']);
    expect(ids(out[1])).toEqual(['loose']);
  });

  it('sections by ACTIVE goals only, and lets an ended goal\'s work fall loose', () => {
    // The same cut the role glyph makes: an achieved goal's milestone is
    // history. The row is not hidden — nothing an aspire container does may
    // remove a row from a surface.
    const done = goal('g1', { state: 'achieved', memberIds: ['x'] });

    const out = groupRows([t('x')], 'goal', { goals: [done] });

    expect(labels(out)).toEqual(['No goal']);
    expect(ids(out[0])).toEqual(['x']);
  });

  it('carries no `gate`, so a goal heading has no pause switch', () => {
    const out = groupRows([t('x')], 'goal', { goals: [goal('g1', { memberIds: ['x'] })] });

    expect(out[0].gate).toBeUndefined();
  });

  it('answers with one loose section when the caller passes no goals at all', () => {
    expect(labels(groupRows([t('x')], 'goal'))).toEqual(['No goal']);
  });
});

describe('groupRows — the contract every caller depends on', () => {
  const rows = [
    h('h1', { project: 'Health' }),
    h('h2', { project: '' }),
    t('t1', { project: 'Work', priority: 'low', timeBucket: 'evening' }),
    t('t2', { priority: 'high' }),
    t('t3', { project: 'Work' }),
  ];
  const values: GroupBy[] = ['none', 'project', 'priority', 'bucket', 'routine', 'season', 'goal'];
  // A goal that claims SOME of the rows, so the 'goal' sweep exercises both a
  // real section and the loose bucket rather than one trivial group.
  const ctx = { routines: [], seasons: [], goals: [goal('g1', { memberIds: ['h1', 't2'] })] };

  it('never loses a row and never renders one twice', () => {
    for (const value of values) {
      const out = groupRows(rows, value, ctx);
      const seen = out.flatMap(ids);
      expect([...seen].sort()).toEqual(['h1', 'h2', 't1', 't2', 't3']);
    }
  });

  it('never emits an empty section', () => {
    for (const value of values) {
      const out = groupRows(rows, value, ctx);
      expect(out.every((g) => g.rows.length > 0)).toBe(true);
    }
  });

  it('returns rows in the order they arrived, so the CALLER can sort per group', () => {
    // Load-bearing, not incidental. Every surface applies sortRows to each
    // group after this returns; if this sorted, grouping and ordering would
    // fight. And sorting the flat list BEFORE this runs reorders the sections,
    // because the maps here are filled by walking the rows — the defect the
    // braindump shipped for one commit.
    const out = groupRows([t('z', { project: 'Work' }), t('a', { project: 'Work' })], 'project');

    expect(ids(out[0])).toEqual(['z', 'a']);
  });

  it("hands 'none' back as one unlabelled section, not as a per-view default", () => {
    // A surface whose no-grouping look is something richer — Day x List's
    // HABITS / TASKS / PROJECTS — owns that itself. It is a presentation choice
    // for that view, not an answer to "group by what".
    const out = groupRows(rows, 'none');

    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('');
    // The SAME ARRAY, unreordered. 'none' is both stores' default and the flat
    // producer for Week x List, both Anytime strips and the braindump, and
    // nothing downstream re-orders it — sortRows('default') is an identity and
    // the two Schedules never call it at all. So whatever this returns reaches
    // the DOM, and asserting only the length let a sort inside this branch pass.
    expect(out[0].rows).toBe(rows);
  });

  it('returns nothing at all for no rows', () => {
    expect(groupRows([], 'none')).toEqual([]);
    expect(groupRows([], 'project')).toEqual([]);
  });
});

describe('groupBySupport — how far a value reaches', () => {
  it('calls Time bucket on Buckets inert, because the view IS that partition', () => {
    // The only combination left that does nothing. Four cards of one bucket
    // each, sectioned by bucket, is four cards holding one section apiece.
    expect(groupBySupport('day', 'buckets', 'bucket')).toEqual({
      honoured: false,
      note: 'Already by bucket',
    });
    expect(groupBySupport('week', 'buckets', 'bucket').honoured).toBe(false);
  });

  it('honours the rest of Buckets, and says which part of a Day card it reaches', () => {
    // Untimed only: the timed spine below carries the
    // scheduled:{bucket}:before|after:{type}:{id} drop zones, and inferDropTime
    // resolves those against the neighbouring row's own time.
    expect(groupBySupport('day', 'buckets', 'priority')).toEqual({
      honoured: true,
      note: 'Untimed rows only',
    });
  });

  it('reaches a whole week CELL, which has no spine to protect', () => {
    // One week:{date}:{bucket} droppable, no per-row drop zones, and the cell
    // renders every habit before every task — so it was never in one time order
    // for a partition to disturb.
    expect(groupBySupport('week', 'buckets', 'priority')).toEqual({ honoured: true, note: null });
  });

  it('honours Schedule outright now that the grid partitions on x', () => {
    // Phase 5b: Day divides into lanes where the field can afford them and falls
    // back to focus where it cannot; Week is always focus. Which of the two you
    // get depends on the measured field and the group count, which a rail cannot
    // state — the cap row above the grid shows it instead.
    for (const scope of ['day', 'week'] as const) {
      expect(groupBySupport(scope, 'schedule', 'project')).toEqual({ honoured: true, note: null });
      expect(groupBySupport(scope, 'schedule', 'routine')).toEqual({ honoured: true, note: null });
    }
  });

  it('keeps Time bucket on Schedule to the Anytime strip', () => {
    // y already IS time. Four bucket-lanes would be a diagonal staircase with
    // three quarters of the field dead, so the grid declines it and the strip
    // still sections by it — honoured, partly, which is what the rail says.
    for (const scope of ['day', 'week'] as const) {
      expect(groupBySupport(scope, 'schedule', 'bucket')).toEqual({
        honoured: true,
        note: 'Anytime only',
      });
    }
  });

  it('never blocks None — it is how you turn grouping off from anywhere', () => {
    for (const scope of ['day', 'week'] as const) {
      for (const layout of ['buckets', 'schedule', 'list'] as const) {
        expect(groupBySupport(scope, layout, 'none')).toEqual({ honoured: true, note: null });
      }
    }
  });

  it('leaves both List layouts unqualified', () => {
    for (const scope of ['day', 'week'] as const) {
      for (const value of ['project', 'priority', 'bucket', 'routine'] as const) {
        expect(groupBySupport(scope, 'list', value)).toEqual({ honoured: true, note: null });
      }
    }
  });
});
