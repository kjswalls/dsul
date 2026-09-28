import { describe, it, expect } from 'vitest';
import { deriveDayItems, type DayItemsInput } from '@/lib/day-items';
import { EMPTY_VIEW_FILTERS, passesFilters, passesGoalFilter, type ViewFilters } from '@/lib/filters';
import { displayGoals, goalFilterItemIds, goalItemIds } from '@/lib/goals';
import { inactiveItemIdsOn } from '@/lib/active';
import { groupRows, type GroupableRow } from '@/lib/grouping';
import { containerRef } from '@/lib/container-registry';
import type { Goal, HabitItem, Item, Project, Task } from '@/lib/planner-types';

/**
 * Filtering and grouping by GOAL — the aspire axis on a display surface.
 *
 * A goal is the third container role: many-to-many like a gate, but it switches
 * nothing off. Both halves of that are load-bearing here and neither is
 * self-evident from the code shape, so they are pinned:
 *
 *   MANY-TO-MANY means the axis is not a partition. An item may serve three
 *   goals, so the FILTER unions them and the GROUPING claims each row once —
 *   `lib/grouping.ts`'s documented first-claim-wins rule, borrowed verbatim
 *   from routines rather than invented here.
 *
 *   NO SUPPRESSION means every path that decides whether an item is ACTIVE
 *   stays goal-blind. A filter narrows what you are looking at and clears with
 *   one click; `inactiveItemIdsOn` is DB state that outlives the session. The
 *   cases below check that the second never learns about the first.
 *
 * The ROLE on the membership is in scope too: all three roles filter and group
 * as members, because a role says what an item does FOR the goal, not whether
 * it serves it.
 */

const TZ = 'America/New_York';
const DATE_STR = '2026-07-08'; // a Wednesday

const task = (id: string, over: Partial<Task> = {}): Task =>
  ({
    id,
    title: `task ${id}`,
    status: 'pending',
    isScheduled: true,
    order: 0,
    startDate: DATE_STR,
    timeBucket: 'morning',
    ...over,
  }) as Task;

const habit = (id: string, over: Partial<HabitItem> = {}): HabitItem =>
  ({
    id,
    // Carried so `typeNameOf` resolves this row as a habit: the point of the
    // habit cases below is that the goal clause reaches a type the priority
    // clause is not allowed to touch, which is only a real assertion if the row
    // says what it is.
    type: 'habit',
    title: `habit ${id}`,
    project: 'wellness',
    status: 'pending',
    streak: 0,
    completedDates: [],
    skippedDates: [],
    repeatFrequency: 'daily',
    timeBucket: 'morning',
    ...over,
  }) as HabitItem;

const goal = (id: string, over: Partial<Goal> = {}): Goal => ({
  id,
  name: `Goal ${id}`,
  state: 'active',
  memberIds: [],
  milestoneIds: [],
  checkinIds: [],
  ...over,
});

const filters = (over: Partial<ViewFilters>): ViewFilters => ({ ...EMPTY_VIEW_FILTERS, ...over });

const input = (over: Partial<DayItemsInput>): DayItemsInput => ({
  tasks: [],
  habits: [],
  projects: [],
  dateStr: DATE_STR,
  timezone: TZ,
  typeFilter: 'all',
  showCompletedTasks: true,
  ...over,
});

const t = (id: string, over: Partial<Task> = {}): GroupableRow => ({
  itemType: 'task',
  item: task(id, over),
});
const h = (id: string, over: Partial<HabitItem> = {}): GroupableRow => ({
  itemType: 'habit',
  item: habit(id, over),
});
const ids = (g: { rows: GroupableRow[] }) => g.rows.map((r) => r.item.id);

/* ── what a selection resolves to ───────────────────────────────────────── */

describe('goalFilterItemIds — the selection, resolved', () => {
  it('takes all three ROLES, because a role is not a degree of membership', () => {
    // The decision, stated as a test: filtering to "Learn Chinese" and losing
    // the HSK 3 milestone and the Sunday check-in would drop exactly the two
    // things the goal is measured by. A role says what an item DOES for the
    // goal; every role serves it.
    const g = goal('g1', { memberIds: ['m1'], milestoneIds: ['ms1'], checkinIds: ['c1'] });

    expect([...goalFilterItemIds([g], ['g1'])!].sort()).toEqual(['c1', 'm1', 'ms1']);
  });

  it('UNIONS a multi-goal selection rather than intersecting it', () => {
    const a = goal('g1', { memberIds: ['a1'] });
    const b = goal('g2', { memberIds: ['b1'] });

    expect([...goalFilterItemIds([a, b], ['g1', 'g2'])!].sort()).toEqual(['a1', 'b1']);
  });

  it('is null — INERT, not empty — when nothing is selected', () => {
    expect(goalFilterItemIds([goal('g1', { memberIds: ['m1'] })], [])).toBeNull();
  });

  it('is null when the selection names only a goal that has ENDED', () => {
    // A goal achieved while it was filtering. An empty SET here would empty the
    // surface with nothing on it to say why — the failure mode view-store's
    // renameContainerRef exists to prevent for a stale container ref.
    const achieved = goal('g1', { state: 'achieved', memberIds: ['m1'] });

    expect(goalFilterItemIds([achieved], ['g1'])).toBeNull();
  });

  it('is null when the selection names a goal that no longer exists', () => {
    expect(goalFilterItemIds([goal('g1')], ['deleted'])).toBeNull();
  });

  it('is an EMPTY set — not null — for a live goal that holds nothing', () => {
    // The one case where emptying the view is truthful: this goal really has no
    // work. Distinguishing it from "cannot resolve" is the whole point of the
    // null.
    const empty = goalFilterItemIds([goal('g1')], ['g1']);

    expect(empty).not.toBeNull();
    expect(empty!.size).toBe(0);
  });

  it('lists members in goalItemIds order — milestones, check-ins, then members', () => {
    // What a grouped section leads with. The arrays are disjoint on read (the
    // join table's PK is (goal_id, item_id)), so no dedupe is involved.
    const g = goal('g1', { memberIds: ['m1'], milestoneIds: ['ms1'], checkinIds: ['c1'] });

    expect(goalItemIds(g)).toEqual(['ms1', 'c1', 'm1']);
  });

  it('offers only ACTIVE goals to a display surface', () => {
    const live = goal('g1');
    const done = goal('g2', { state: 'achieved' });
    const dropped = goal('g3', { state: 'abandoned' });

    expect(displayGoals([live, done, dropped]).map((g) => g.id)).toEqual(['g1']);
  });
});

/* ── the predicate ──────────────────────────────────────────────────────── */

describe('passesGoalFilter — membership, with no pass-through', () => {
  const members = new Set(['t1', 'h1']);

  it('is a no-op on an empty selection', () => {
    expect(passesGoalFilter(task('t9'), [], members)).toBe(true);
  });

  it('admits a member and excludes a non-member', () => {
    expect(passesGoalFilter(task('t1'), ['g1'], members)).toBe(true);
    expect(passesGoalFilter(task('t2'), ['g1'], members)).toBe(false);
  });

  it('excludes a HABIT that is not a member — membership is not a type capability', () => {
    // Unlike priority and container, there is no field to carry and no type to
    // exempt: every item type may join a goal. A pass-through here would leave
    // every habit in the list while the menu claims to show one goal.
    expect(passesGoalFilter(habit('h1'), ['g1'], members)).toBe(true);
    expect(passesGoalFilter(habit('h2'), ['g1'], members)).toBe(false);
  });

  it('goes INERT when the resolution is missing, rather than hiding everything', () => {
    // Reached two ways: a selection that names no live goal, and a surface that
    // does not offer this filter at all. Emptying a list because a resolver was
    // absent is the failure lib/filters.ts was written to stop.
    expect(passesGoalFilter(task('t2'), ['g1'], null)).toBe(true);
    expect(passesGoalFilter(task('t2'), ['g1'], undefined)).toBe(true);
  });

  it('stacks with the other clauses inside passesFilters', () => {
    const inWork = task('t1', { project: 'Work' });
    const inHome = task('t2', { project: 'Home' });
    const f = filters({ goals: ['g1'], containers: ['project:Work'] });

    expect(passesFilters(inWork, f, undefined, new Set(['t1']))).toBe(true);
    // A member of the goal, but the wrong project: both clauses narrow.
    expect(passesFilters(inHome, f, undefined, new Set(['t1', 't2']))).toBe(false);
  });
});

/* ── the surface ────────────────────────────────────────────────────────── */

describe('a goal clause on the canvas day derivation', () => {
  const member = task('t1');
  const stranger = task('t2');
  const memberHabit = habit('h1');
  const strangerHabit = habit('h2');
  const g = goal('g1', { memberIds: ['t1'], milestoneIds: ['h1'] });

  const day = (over: Partial<DayItemsInput>) =>
    deriveDayItems(
      input({
        tasks: [member, stranger],
        habits: [memberHabit, strangerHabit],
        ...over,
      })
    );

  it('narrows both tasks and habits to the goal it names', () => {
    const out = day({
      filters: filters({ goals: ['g1'] }),
      goalMemberIds: goalFilterItemIds([g], ['g1']),
    });

    expect(out.tasksByBucket.morning.map((x) => x.id)).toEqual(['t1']);
    expect(out.habitsByBucket.morning.map((x) => x.id)).toEqual(['h1']);
  });

  it('shows everything again the moment the clause is cleared', () => {
    const out = day({ filters: EMPTY_VIEW_FILTERS, goalMemberIds: null });

    expect(out.tasksByBucket.morning.map((x) => x.id)).toEqual(['t1', 't2']);
    expect(out.habitsByBucket.morning.map((x) => x.id)).toEqual(['h1', 'h2']);
  });

  it('keeps the whole day when the selected goal has ended', () => {
    // The graceful-degradation path end to end: the goal is achieved, the
    // resolution is null, and the day is intact rather than blank.
    const achieved = { ...g, state: 'achieved' as const };
    const out = day({
      filters: filters({ goals: ['g1'] }),
      goalMemberIds: goalFilterItemIds([achieved], ['g1']),
    });

    expect(out.tasksByBucket.morning.map((x) => x.id)).toEqual(['t1', 't2']);
  });

  /* ── the fourth row kind ──────────────────────────────────────────────── */

  const block = (name: string): Project => ({
    id: `p-${name}`,
    name,
    emoji: '📁',
    startTime: '09:00',
    timeBucket: 'morning',
    repeatFrequency: 'daily',
  });

  it('drops EVERY project block under a resolvable goal clause', () => {
    // A block is a `projects` row, never an item, so it holds no id
    // `goal_items` could name — the membership question has one answer for all
    // of them and it is no. Leaving them behind reproduces the artefact the
    // container axis was fixed for: a narrowed grid under a full set of empty
    // blocks. Renders on Day × Buckets, Week × Buckets and Day × Schedule.
    const out = day({
      projects: [block('Work'), block('Side')],
      filters: filters({ goals: ['g1'] }),
      goalMemberIds: goalFilterItemIds([g], ['g1']),
    });

    expect(out.tasksByBucket.morning.map((x) => x.id)).toEqual(['t1']);
    expect(out.recurringProjects.map((p) => p.name)).toEqual([]);
  });

  it('leaves every block alone under an UNRESOLVABLE one, because nothing narrowed', () => {
    // The inert clause narrows no rows, so it must not narrow the blocks
    // either — an achieved goal blanking the grid's time structure while every
    // task stays put is the same lie in the other direction.
    const achieved = { ...g, state: 'achieved' as const };
    const out = day({
      projects: [block('Work'), block('Side')],
      filters: filters({ goals: ['g1'] }),
      goalMemberIds: goalFilterItemIds([achieved], ['g1']),
    });

    expect(out.recurringProjects.map((p) => p.name)).toEqual(['Work', 'Side']);
  });

  it('still narrows blocks by the container axis when no goal is selected', () => {
    // The guard on the guard: the goal clause must not have taken the container
    // rule's place, only stacked in front of it.
    const out = day({
      projects: [block('Work'), block('Side')],
      filters: filters({ containers: [containerRef('project', 'Work')] }),
    });

    expect(out.recurringProjects.map((p) => p.name)).toEqual(['Work']);
  });
});

/* ── a goal suppresses nothing ──────────────────────────────────────────── */

describe('a goal never switches an item off', () => {
  it('leaves the activation resolver goal-blind, whatever the goal is doing', () => {
    // `inactiveItemIdsOn` is the one place suppression is decided, and its
    // context carries routines and seasons only — there is no goal channel to
    // pass, by construction (lib/container-registry.ts's role seam). Asserted
    // at runtime as well as in the type, because "a goal you are behind on is
    // the last thing that should hide its work" is a product promise, not an
    // implementation detail.
    const items = [task('t1'), task('t2')] as unknown as Item[];

    const inactive = inactiveItemIdsOn(items, DATE_STR, {
      userTimezone: TZ,
      routines: [],
      seasons: [],
    });

    expect(inactive.size).toBe(0);
  });

  it('never drops a row from a grouping, even for an abandoned goal', () => {
    // Grouping by goal hides nothing: a member of an abandoned goal is not in
    // that goal's section (there is none) — it falls into the loose bucket.
    const abandoned = goal('g1', { state: 'abandoned', memberIds: ['t1'] });
    const rows = [t('t1'), t('t2')];

    const out = groupRows(rows, 'goal', { goals: [abandoned] });

    expect(out.map((g) => g.label)).toEqual(['No goal']);
    expect(out.flatMap(ids).sort()).toEqual(['t1', 't2']);
  });

  it('gives a goal section no gate, so its heading has no switch', () => {
    // The aspire role in one field. A routine/season section carries `gate`
    // and its header renders a pause switch; a goal has nothing to switch.
    const out = groupRows([t('t1'), h('h1')], 'goal', {
      goals: [goal('g1', { memberIds: ['t1', 'h1'] })],
    });

    expect(out.every((g) => g.gate === undefined)).toBe(true);
  });
});
