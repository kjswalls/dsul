import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

/**
 * The display model — what a surface's Display settings are, derived once for
 * the trigger's dot, the menu's Reset row and the braindump's shelf.
 *
 * Mostly pure, and that is the point of the split: `summarizeDisplay` is handed
 * its inputs, so the count can be held against the menu's own formula over
 * every combination of settings rather than a handful, and the shelf's one
 * promise — it shows something exactly when the dot is lit, and names every
 * value the dot counts — can be checked over the same matrix. Reset and the
 * hook read the real stores, because what they get wrong is which store field
 * they read.
 */

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  createItemType: vi.fn(async () => {}),
  updateItemType: vi.fn(async () => {}),
  deleteItemType: vi.fn(async () => {}),
  createItem: vi.fn(async () => {}),
  updateItem: vi.fn(async () => {}),
  deleteItem: vi.fn(async () => {}),
  restoreItem: vi.fn(async () => {}),
  setItemCompletion: vi.fn(async () => {}),
  createProject: vi.fn(async () => {}),
  updateProject: vi.fn(async () => {}),
  deleteProject: vi.fn(async () => {}),
  restoreProject: vi.fn(async () => {}),
  fetchRoutines: vi.fn(async () => []),
  createRoutine: vi.fn(async () => {}),
  updateRoutine: vi.fn(async () => {}),
  deleteRoutine: vi.fn(async () => {}),
  restoreRoutine: vi.fn(async () => {}),
  fetchPrograms: vi.fn(async () => []),
  createProgram: vi.fn(async () => {}),
  updateProgram: vi.fn(async () => {}),
  deleteProgram: vi.fn(async () => {}),
  restoreProgram: vi.fn(async () => {}),
  fetchGoals: vi.fn(async () => []),
  createGoal: vi.fn(async () => {}),
  updateGoal: vi.fn(async () => {}),
  deleteGoal: vi.fn(async () => {}),
  restoreGoal: vi.fn(async () => {}),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));

import {
  PRIORITY_FILTER_ORDER,
  UNKNOWN_GOAL_LABEL,
  clauseText,
  goalMenuOrder,
  priorityFilterLabel,
  removeDisplaySetting,
  resetDisplay,
  summarizeDisplay,
  useDisplaySummary,
  withoutDisplayValue,
  type DisplayClause,
  type DisplayRemoval,
  type DisplaySummary,
  type DisplaySummaryInput,
  type DisplayValue,
} from '@/lib/display-summary';
import { CONTAINER_KINDS, NO_CONTAINER } from '@/lib/container-registry';
import {
  EMPTY_VIEW_FILTERS,
  NO_PRIORITY,
  activeFilterCount,
  type PriorityFilterValue,
  type ViewFilters,
} from '@/lib/filters';
import { EXT_GOALS } from '@/lib/extension-registry';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import type { SortBy } from '@/lib/sort-rows';
import type { Goal } from '@/lib/planner-types';
import { disableExtensions, enableExtensions } from './support/extensions';

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const goal = (over: Partial<Goal> & { id: string; name: string }): Goal => ({
  state: 'active',
  memberIds: [],
  milestoneIds: [],
  checkinIds: [],
  ...over,
});

const PROJECTS = [{ name: 'Work' }, { name: 'Personal' }, { name: 'Health' }];
const GOALS = [
  goal({ id: 'g1', name: 'Learn Chinese' }),
  goal({ id: 'g2', name: 'Ship v1', state: 'achieved' }),
  goal({ id: 'g3', name: 'Marathon' }),
  goal({ id: 'g4', name: 'Old thing', state: 'abandoned' }),
];
/** A stand-in for getProjectColor that shows which name it was asked about. */
const color = (name: string) => `color(${name})`;

/** A stored filter array may hold what its type does not allow — a hand-edited blob. */
const stored = (values: string[]) => values as PriorityFilterValue[];

const filters = (over: Partial<ViewFilters> = {}): ViewFilters => ({
  ...EMPTY_VIEW_FILTERS,
  ...over,
});

function input(over: Partial<DisplaySummaryInput> = {}): DisplaySummaryInput {
  return {
    surface: 'braindump',
    filters: EMPTY_VIEW_FILTERS,
    groupBy: 'none',
    sortBy: 'default',
    typeFilter: 'all',
    goalsOn: true,
    loaded: true,
    projects: PROJECTS,
    goals: GOALS,
    projectColor: color,
    ...over,
  };
}

const summarize = (over: Partial<DisplaySummaryInput> = {}) => summarizeDisplay(input(over));

type Multi = Extract<DisplayClause, { values: DisplayValue[] }>;
const multi = (s: DisplaySummary, id: Multi['id']): Multi | undefined =>
  s.clauses.find((c): c is Multi => c.id === id);
const labels = (s: DisplaySummary, id: Multi['id']) => multi(s, id)?.values.map((v) => v.label) ?? [];
const glyphs = (s: DisplaySummary, id: Multi['id']) => multi(s, id)?.values.map((v) => v.glyph) ?? [];
/** How many things the shelf draws: one per single clause, one per value of a multi. */
const rendered = (s: DisplaySummary) =>
  s.clauses.reduce((n, c) => n + ('values' in c ? c.values.length : 1), 0);

/* ── the matrix ───────────────────────────────────────────────────────────── */

/** Every combination of the dimensions' values, as one record per combination. */
function product<T extends Record<string, readonly unknown[]>>(
  dims: T
): { [K in keyof T]: T[K][number] }[] {
  return Object.entries(dims).reduce<Record<string, unknown>[]>(
    (rows, [key, values]) => rows.flatMap((row) => values.map((v) => ({ ...row, [key]: v }))),
    [{}]
  ) as { [K in keyof T]: T[K][number] }[];
}

/**
 * Each filter option carries how many values it STORES (what the dot counts)
 * and how many the shelf should DRAW for it. The two differ only where a
 * duplicate collapses — which is the rule under test.
 */
const PRIORITY_SETS = [
  { values: [] as string[], drawn: 0 },
  { values: ['low', 'high'], drawn: 2 },
  // A duplicate, and a string no row offers.
  { values: ['high', 'high', 'urgent'], drawn: 2 },
];
const CONTAINER_SETS = [
  { values: [] as string[], drawn: 0 },
  // Folds onto the store's 'Personal', plus the unset value.
  { values: [NO_CONTAINER, 'project:personal'], drawn: 2 },
  // A deleted project stored in two spellings, and a bare legacy name.
  { values: ['project:Gone', 'project:gone', 'Bare'], drawn: 2 },
  // Two spellings of one live project, which the menu ticks as one row.
  { values: ['project:Work', 'project:work'], drawn: 1 },
  // Every run at once: live, deleted, a bare name that spells a live project,
  // a kindless heading key, and the unset value — none may fold onto another.
  { values: ['project:Work', 'project:Gone', 'Work', 'none:project', NO_CONTAINER], drawn: 5 },
];
const GOAL_SETS = [
  { values: [] as string[], drawn: 0 },
  // Ended but selected, and an id the store cannot name.
  { values: ['g2', 'gone'], drawn: 2 },
  { values: ['g1', 'g1'], drawn: 1 },
];

interface Case {
  name: string;
  input: DisplaySummaryInput;
  /** The Display menu's own count, as it computed it inline before the model existed. */
  legacy: number;
  /** The same count, added up dimension by dimension. */
  counted: number;
  drawn: number;
}

const CASES: Case[] = product({
  surface: ['braindump', 'canvas'] as const,
  goalsOn: [true, false],
  loaded: [true, false],
  // 'goal' is the stored value; the caller resolves it, below.
  group: ['none', 'priority', 'goal'],
  sortBy: ['default', 'title'] as SortBy[],
  typeFilter: ['all', 'habits'] as const,
  priorities: PRIORITY_SETS,
  containers: CONTAINER_SETS,
  goals: GOAL_SETS,
  hideFinished: [false, true],
}).map((c) => {
  // What useCanvasGroupBy / useBraindumpGroupBy hand the model.
  const groupBy = c.group === 'goal' && !c.goalsOn ? 'none' : c.group;
  const f: ViewFilters = {
    containers: c.containers.values,
    priorities: stored(c.priorities.values),
    goals: c.goals.values,
    hideFinished: c.hideFinished,
  };
  const flags =
    (groupBy !== 'none' ? 1 : 0) +
    (c.sortBy !== 'default' ? 1 : 0) +
    (c.surface === 'canvas' && c.typeFilter !== 'all' ? 1 : 0) +
    (c.hideFinished ? 1 : 0);
  return {
    name: JSON.stringify({ ...c, priorities: f.priorities, containers: f.containers, goals: f.goals }),
    input: input({
      surface: c.surface,
      filters: f,
      groupBy,
      sortBy: c.sortBy,
      typeFilter: c.typeFilter,
      goalsOn: c.goalsOn,
      loaded: c.loaded,
    }),
    legacy:
      activeFilterCount({ ...f, goals: c.goalsOn ? f.goals : [] }) +
      (groupBy !== 'none' ? 1 : 0) +
      (c.sortBy !== 'default' ? 1 : 0) +
      (c.surface === 'canvas' && c.typeFilter !== 'all' ? 1 : 0),
    counted:
      flags +
      c.priorities.values.length +
      c.containers.values.length +
      (c.goalsOn ? c.goals.values.length : 0),
    drawn: flags + c.priorities.drawn + c.containers.drawn + (c.goalsOn ? c.goals.drawn : 0),
  };
});

describe('the count, over every combination of settings', () => {
  it('covers both surfaces, the Goals gate and the stranded clauses it leaves', () => {
    // A guard on the guard: a matrix that quietly lost a dimension would still
    // pass everything below.
    expect(CASES).toHaveLength(2 * 2 * 2 * 3 * 2 * 2 * 3 * 5 * 3 * 2);
  });

  it("is the menu's own formula, value for value", () => {
    const wrong = CASES.filter((c) => summarizeDisplay(c.input).activeCount !== c.legacy);
    expect(wrong.map((c) => c.name)).toEqual([]);
    // And the formula is the sum of its parts, so neither side is checking
    // itself: a stranded goal clause adds nothing while Goals is off, and a
    // stored 'goal' grouping is 'none' by the time it arrives.
    expect(CASES.filter((c) => c.legacy !== c.counted).map((c) => c.name)).toEqual([]);
  });

  it('lights the dot exactly when there is a clause to show', () => {
    const wrong = CASES.filter((c) => {
      const s = summarizeDisplay(c.input);
      return s.activeCount > 0 !== s.clauses.length > 0;
    });
    expect(wrong.map((c) => c.name)).toEqual([]);
  });

  it('draws every counted value once — only a duplicate collapses', () => {
    const wrong = CASES.filter((c) => rendered(summarizeDisplay(c.input)) !== c.drawn);
    expect(wrong.map((c) => c.name)).toEqual([]);
  });

  it('keys every value uniquely within its clause', () => {
    const wrong = CASES.filter((c) =>
      summarizeDisplay(c.input).clauses.some(
        (cl) => 'values' in cl && new Set(cl.values.map((v) => v.key)).size !== cl.values.length
      )
    );
    expect(wrong.map((c) => c.name)).toEqual([]);
  });
});

/* ── one ✕ each ───────────────────────────────────────────────────────────── */

/** What each thing the shelf draws is called, one per ✕ it wears. */
const drawnIds = (s: DisplaySummary): string[] =>
  s.clauses.flatMap((c) => ('values' in c ? c.values.map((v) => `${c.id}|${v.key}`) : [c.id]));

/** The removal each drawn thing's ✕ hands over, as the shelf builds it. */
const removals = (s: DisplaySummary): DisplayRemoval[] =>
  s.clauses.flatMap((c): DisplayRemoval[] =>
    'values' in c ? c.values.map((v) => ({ id: c.id, key: v.key })) : [{ id: c.id }]
  );

const removalId = (r: DisplayRemoval) => ('key' in r ? `${r.id}|${r.key}` : r.id);

/** `removeDisplaySetting` over the model's inputs rather than the stores. */
function inputWithout(inp: DisplaySummaryInput, r: DisplayRemoval): DisplaySummaryInput {
  switch (r.id) {
    case 'group':
      return { ...inp, groupBy: 'none' };
    case 'sort':
      return { ...inp, sortBy: 'default' };
    case 'type':
      return { ...inp, typeFilter: 'all' };
    case 'hide-finished':
      return { ...inp, filters: { ...inp.filters, hideFinished: false } };
    default:
      return { ...inp, filters: withoutDisplayValue(inp.filters, r) };
  }
}

describe('taking one thing off, over every combination of settings', () => {
  it('takes off exactly the value its ✕ names, twins included, and leaves every other', () => {
    const wrong: string[] = [];
    for (const c of CASES) {
      const before = summarizeDisplay(c.input);
      for (const r of removals(before)) {
        const after = summarizeDisplay(inputWithout(c.input, r));
        const expected = drawnIds(before).filter((id) => id !== removalId(r));
        if (JSON.stringify(drawnIds(after)) !== JSON.stringify(expected)) {
          wrong.push(`${c.name} − ${removalId(r)}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('puts the dot out exactly when the last thing drawn is taken off', () => {
    const wrong: string[] = [];
    for (const c of CASES) {
      const before = summarizeDisplay(c.input);
      const rs = removals(before);
      if (rs.length !== 1) continue;
      if (summarizeDisplay(inputWithout(c.input, rs[0])).activeCount !== 0) wrong.push(c.name);
    }
    expect(wrong).toEqual([]);
  });
});

describe('withoutDisplayValue', () => {
  it('takes off every stored spelling a project value stands for, the way the menu ticks it', () => {
    const f = filters({ containers: ['project:Work', 'project:work', 'project:Personal', NO_CONTAINER] });
    expect(withoutDisplayValue(f, { id: 'project', key: 'project:Work' }).containers).toEqual([
      'project:Personal',
      NO_CONTAINER,
    ]);
    expect(withoutDisplayValue(f, { id: 'project', key: NO_CONTAINER }).containers).toEqual([
      'project:Work',
      'project:work',
      'project:Personal',
    ]);
  });

  it('compares a ref of no classify kind exactly, as the shelf dedupes it', () => {
    const f = filters({ containers: ['Bare', 'bare', 'routine:X'] });
    expect(withoutDisplayValue(f, { id: 'project', key: 'Bare' }).containers).toEqual([
      'bare',
      'routine:X',
    ]);
  });

  it('takes off a duplicated priority or goal in one go', () => {
    const f = filters({ priorities: stored(['high', 'high', 'low']), goals: ['g1', 'g1', 'g2'] });
    expect(withoutDisplayValue(f, { id: 'priority', key: 'high' }).priorities).toEqual(['low']);
    expect(withoutDisplayValue(f, { id: 'goal', key: 'g1' }).goals).toEqual(['g2']);
  });

  it('never writes into the filters it was handed', () => {
    const f = filters({ containers: ['project:Work'], priorities: ['high'], goals: ['g1'] });
    const frozen = structuredClone(f);
    withoutDisplayValue(f, { id: 'project', key: 'project:Work' });
    withoutDisplayValue(f, { id: 'priority', key: 'high' });
    withoutDisplayValue(f, { id: 'goal', key: 'g1' });
    expect(f).toEqual(frozen);
  });
});

/* ── order ────────────────────────────────────────────────────────────────── */

describe('the menu order, whatever order things were clicked in', () => {
  it('orders the clauses as the menu sections run', () => {
    const everything = filters({
      priorities: ['low'],
      containers: ['project:Work'],
      goals: ['g1'],
      hideFinished: true,
    });

    const braindump = summarize({ filters: everything, groupBy: 'type', sortBy: 'title' });
    expect(braindump.clauses.map((c) => c.id)).toEqual([
      'group',
      'sort',
      'priority',
      'project',
      'goal',
      'hide-finished',
    ]);

    // The type filter sits where its section does: first under Filter.
    const canvas = summarize({
      surface: 'canvas',
      filters: everything,
      groupBy: 'priority',
      sortBy: 'priority',
      typeFilter: 'tasks',
    });
    expect(canvas.clauses.map((c) => c.id)).toEqual([
      'group',
      'sort',
      'type',
      'priority',
      'project',
      'goal',
      'hide-finished',
    ]);
  });

  it('lists priorities High, Medium, Low, No priority — then anything else', () => {
    const s = summarize({ filters: filters({ priorities: stored(['urgent', NO_PRIORITY, 'low', 'high']) }) });
    expect(labels(s, 'priority')).toEqual(['High', 'Low', 'No priority', 'urgent']);
  });

  it('lists projects in store order, then refs no project answers, then the unset value', () => {
    const s = summarize({
      filters: filters({
        containers: [NO_CONTAINER, 'project:Health', 'Bare', 'project:Gone', 'project:work'],
      }),
    });
    // Store order is Work, Personal, Health; the stored order is the reverse of
    // what the shelf shows.
    expect(labels(s, 'project')).toEqual(['Work', 'Health', 'Gone', 'Bare', 'No project']);
  });

  it('lists active goals, then selected ended ones, then ids it cannot name', () => {
    const s = summarize({ filters: filters({ goals: ['gone', 'g2', 'g3', 'g1'] }) });
    expect(labels(s, 'goal')).toEqual(['Learn Chinese', 'Marathon', 'Ship v1', UNKNOWN_GOAL_LABEL]);
  });
});

describe('goalMenuOrder — the Goal section rows', () => {
  it('is the active goals, then the selected goals that have ended, each in store order', () => {
    expect(goalMenuOrder(GOALS, []).map((g) => g.id)).toEqual(['g1', 'g3']);
    // g4 is abandoned and selected; g2 is achieved and not — so it stays out.
    expect(goalMenuOrder(GOALS, ['g4', 'g1']).map((g) => g.id)).toEqual(['g1', 'g3', 'g4']);
    expect(goalMenuOrder(GOALS, ['g2', 'g4']).map((g) => g.id)).toEqual(['g1', 'g3', 'g2', 'g4']);
  });
});

/* ── words ────────────────────────────────────────────────────────────────── */

describe('the words', () => {
  it("takes group labels from the surface's own list", () => {
    const braindump = summarize({ groupBy: 'type' });
    expect(braindump.clauses).toEqual([{ id: 'group', label: 'Type' }]);
    expect(clauseText(braindump.clauses[0])).toBe('Grouped by Type');

    // 'bucket' is the canvas's, labelled there; the braindump has no such value.
    const canvas = summarize({ surface: 'canvas', groupBy: 'bucket' });
    expect(clauseText(canvas.clauses[0])).toBe('Grouped by Time bucket');
  });

  it('spells Title A–Z with an en dash, as the menu does', () => {
    const s = summarize({ sortBy: 'title' });
    expect(clauseText(s.clauses[0])).toBe('Sorted by Title A–Z');
  });

  it('names a value its option list does not know, rather than dropping a counted clause', () => {
    const s = summarize({ groupBy: 'status', sortBy: 'sideways' as string as SortBy });
    expect(s.activeCount).toBe(2);
    expect(s.clauses.map(clauseText)).toEqual(['Grouped by status', 'Sorted by sideways']);
  });

  it('shows the type filter on the canvas only', () => {
    expect(summarize({ surface: 'canvas', typeFilter: 'habits' }).clauses.map(clauseText)).toEqual([
      'Habits',
    ]);
    // The braindump neither counts nor shows it, whatever the shared field holds.
    expect(summarize({ typeFilter: 'habits' })).toEqual({ activeCount: 0, clauses: [] });
  });

  it('reads a multi-select as its values, and Hide finished as itself', () => {
    const s = summarize({
      filters: filters({ priorities: ['low', 'high'], hideFinished: true }),
    });
    expect(s.clauses.map(clauseText)).toEqual(['High, Low', 'Hide finished']);
  });

  it('gives each multi-select its section noun, the project one from the registry', () => {
    const s = summarize({
      filters: filters({ priorities: ['high'], containers: ['project:Work'], goals: ['g1'] }),
    });
    expect(multi(s, 'priority')?.noun).toBe('Priority');
    expect(multi(s, 'project')?.noun).toBe(CONTAINER_KINDS.project.label);
    expect(multi(s, 'goal')?.noun).toBe(CONTAINER_KINDS.goal.label);
  });

  it('labels priorities as the menu rows do, and hands anything else back as-is', () => {
    expect(PRIORITY_FILTER_ORDER).toEqual(['high', 'medium', 'low', NO_PRIORITY]);
    expect(PRIORITY_FILTER_ORDER.map(priorityFilterLabel)).toEqual([
      'High',
      'Medium',
      'Low',
      'No priority',
    ]);
    expect(priorityFilterLabel('urgent')).toBe('urgent');
    // Not a lookup that an inherited key can answer.
    expect(priorityFilterLabel('toString')).toBe('toString');
  });
});

/* ── values that resolve to nothing ───────────────────────────────────────── */

describe('a value nothing can resolve is still named', () => {
  it('marks the unset values and junk with the ring, and real priorities with their dot', () => {
    const s = summarize({
      filters: filters({
        priorities: stored(['high', NO_PRIORITY, 'urgent']),
        containers: [NO_CONTAINER, 'Bare', 'other:Thing'],
      }),
    });
    expect(glyphs(s, 'priority')).toEqual([
      { kind: 'dot', value: 'high' },
      { kind: 'ring' },
      { kind: 'ring' },
    ]);
    // A bare legacy name and an unknown prefix both resolve against nothing.
    expect(labels(s, 'project')).toEqual(['Bare', 'Thing', 'No project']);
    expect(glyphs(s, 'project')).toEqual([{ kind: 'ring' }, { kind: 'ring' }, { kind: 'ring' }]);
  });

  it("shows the store's spelling of a project a ref names in another case", () => {
    const s = summarize({ filters: filters({ containers: ['project:personal'] }) });
    expect(multi(s, 'project')?.values).toEqual([
      { key: 'project:Personal', label: 'Personal', glyph: { kind: 'square', color: 'color(Personal)' } },
    ]);
  });

  it('names a deleted project from its ref, in its own colour', () => {
    // The menu has no row for it, and a stale ref is not inert: on its own it
    // empties the list. The shelf is the one place it is named.
    const s = summarize({ filters: filters({ containers: ['project:Client: Acme'] }) });
    expect(multi(s, 'project')?.values).toEqual([
      {
        key: 'project:Client: Acme',
        label: 'Client: Acme',
        glyph: { kind: 'square', color: 'color(Client: Acme)' },
      },
    ]);
  });

  it('names every project ref from its own spelling before the planner has loaded', () => {
    const s = summarize({
      projects: [],
      loaded: false,
      filters: filters({ containers: ['project:work', NO_CONTAINER] }),
    });
    expect(labels(s, 'project')).toEqual(['work', 'No project']);
    expect(s.activeCount).toBe(2);
  });

  it('calls an unknown goal id Unknown goal once loaded, and holds back before — same count', () => {
    const f = filters({ goals: ['g1', 'gone'] });
    const loaded = summarize({ filters: f, loaded: true });
    const loading = summarize({ filters: f, loaded: false });

    expect(labels(loaded, 'goal')).toEqual(['Learn Chinese', UNKNOWN_GOAL_LABEL]);
    expect(labels(loading, 'goal')).toEqual(['Learn Chinese', '…']);
    expect(loading.activeCount).toBe(loaded.activeCount);
    // Target for every goal value, the known and the unknown alike.
    expect(glyphs(loaded, 'goal')).toEqual([{ kind: 'target' }, { kind: 'target' }]);
  });

  it('shows no goal clause while Goals is off, and counts none', () => {
    const s = summarize({ goalsOn: false, filters: filters({ goals: ['g1'], priorities: ['low'] }) });
    expect(s.clauses.map((c) => c.id)).toEqual(['priority']);
    expect(s.activeCount).toBe(1);
  });
});

describe('duplicates collapse into one value, and still count as stored', () => {
  it.each([
    ['a repeated priority', filters({ priorities: ['high', 'high'] }), 'priority', ['High']],
    [
      'two spellings of a live project',
      filters({ containers: ['project:Work', 'project:work'] }),
      'project',
      ['Work'],
    ],
    [
      'two spellings of a deleted project — the first one stored',
      filters({ containers: ['project:gone', 'project:Gone'] }),
      'project',
      ['gone'],
    ],
    ['the unset value twice', filters({ containers: [NO_CONTAINER, NO_CONTAINER] }), 'project', ['No project']],
    ['a repeated goal', filters({ goals: ['g1', 'g1'] }), 'goal', ['Learn Chinese']],
    ['a repeated unknown goal', filters({ goals: ['gone', 'gone'] }), 'goal', [UNKNOWN_GOAL_LABEL]],
    // Neither resolves to anything, so each is keyed by what was stored — and
    // two values on one key would be two React children under one key too.
    ['a repeated junk priority', filters({ priorities: stored(['urgent', 'urgent']) }), 'priority', ['urgent']],
    ['a repeated bare ref', filters({ containers: ['Bare', 'Bare'] }), 'project', ['Bare']],
  ] as const)('%s', (_name, f, id, expected) => {
    const s = summarize({ filters: f });
    expect(labels(s, id)).toEqual(expected);
    expect(s.activeCount).toBe(2);
  });
});

/* ── Reset ────────────────────────────────────────────────────────────────── */

const view = () => useViewStore.getState();

/** Both surfaces set, so a reset of one can be seen to leave the other alone. */
function seedStores() {
  usePlannerStore.setState({
    userId: 'user-1',
    isLoading: false,
    projects: [],
    goals: [],
    showPausedOnGrid: true,
    groupBy: 'priority',
    timelineItemFilter: 'habits',
  });
  const everything = (goals: string[]): ViewFilters => ({
    containers: ['project:Work'],
    priorities: ['high'],
    goals,
    hideFinished: true,
  });
  useViewStore.setState({
    typeFilter: 'habits',
    canvasGroupBy: 'goal',
    canvasSortBy: 'title',
    canvasFilters: everything(['g1']),
    braindumpGroupBy: 'goal',
    braindumpSortBy: 'priority',
    braindumpFilters: everything(['g2']),
  });
}

describe('resetDisplay — the Reset row and the shelf ✕, one function', () => {
  beforeEach(seedStores);
  afterEach(cleanup);

  it('clears the braindump, goal clause and goal grouping included, while Goals is on', () => {
    enableExtensions(EXT_GOALS);
    const canvasBefore = view().canvasFilters;

    resetDisplay('braindump');

    expect(view().braindumpFilters).toEqual(EMPTY_VIEW_FILTERS);
    expect(view().braindumpGroupBy).toBe('none');
    expect(view().braindumpSortBy).toBe('default');
    // Per surface: the canvas, and the canvas-only type filter, are untouched.
    expect(view().canvasFilters).toBe(canvasBefore);
    expect(view().canvasGroupBy).toBe('goal');
    expect(view().canvasSortBy).toBe('title');
    expect(view().typeFilter).toBe('habits');
    // App-wide, not a preference of this surface.
    expect(usePlannerStore.getState().showPausedOnGrid).toBe(true);
  });

  it("keeps the braindump's goal clause and goal grouping while Goals is off", () => {
    disableExtensions(EXT_GOALS);

    resetDisplay('braindump');

    // Off has to be lossless: these are what switching Goals back on returns.
    expect(view().braindumpFilters).toEqual({ ...EMPTY_VIEW_FILTERS, goals: ['g2'] });
    expect(view().braindumpGroupBy).toBe('goal');
    expect(view().braindumpSortBy).toBe('default');
    expect(usePlannerStore.getState().showPausedOnGrid).toBe(true);
  });

  it('keeps only a goal grouping while Goals is off — any other grouping clears', () => {
    disableExtensions(EXT_GOALS);
    useViewStore.setState({ braindumpGroupBy: 'project' });

    resetDisplay('braindump');

    expect(view().braindumpGroupBy).toBe('none');
  });

  it('clears the canvas, its type filter too, through the setters that keep the mirrors', () => {
    enableExtensions(EXT_GOALS);
    const braindumpBefore = view().braindumpFilters;

    resetDisplay('canvas');

    expect(view().canvasFilters).toEqual(EMPTY_VIEW_FILTERS);
    expect(view().canvasGroupBy).toBe('none');
    expect(view().canvasSortBy).toBe('default');
    expect(view().typeFilter).toBe('all');
    // setCanvasGroupBy and setTypeFilter mirror into the planner store.
    expect(usePlannerStore.getState().groupBy).toBe('none');
    expect(usePlannerStore.getState().timelineItemFilter).toBe('all');
    expect(usePlannerStore.getState().showPausedOnGrid).toBe(true);
    expect(view().braindumpFilters).toBe(braindumpBefore);
    expect(view().braindumpGroupBy).toBe('goal');
  });

  it("keeps the canvas's goal clause and goal grouping while Goals is off", () => {
    disableExtensions(EXT_GOALS);

    resetDisplay('canvas');

    expect(view().canvasFilters).toEqual({ ...EMPTY_VIEW_FILTERS, goals: ['g1'] });
    expect(view().canvasGroupBy).toBe('goal');
    expect(view().typeFilter).toBe('all');
  });

  it.each([
    ['on', true],
    ['off', false],
  ])('leaves nothing counted, Goals %s', (_label, on) => {
    if (on) enableExtensions(EXT_GOALS);
    else disableExtensions(EXT_GOALS);

    resetDisplay('braindump');
    resetDisplay('canvas');

    // What it keeps while Goals is off, it keeps uncounted.
    expect(renderHook(() => useDisplaySummary('braindump')).result.current).toEqual({
      activeCount: 0,
      clauses: [],
    });
    expect(renderHook(() => useDisplaySummary('canvas')).result.current.activeCount).toBe(0);
  });

  it('never writes into the shared empty filters', () => {
    disableExtensions(EXT_GOALS);
    resetDisplay('braindump');
    enableExtensions(EXT_GOALS);
    resetDisplay('canvas');

    expect(EMPTY_VIEW_FILTERS).toEqual({
      containers: [],
      priorities: [],
      goals: [],
      hideFinished: false,
    });
  });
});

describe('removeDisplaySetting — one shelf ✕', () => {
  beforeEach(() => {
    seedStores();
    enableExtensions(EXT_GOALS);
  });
  afterEach(cleanup);

  it('takes one braindump setting off and leaves the rest, and the canvas, alone', () => {
    const canvasBefore = view().canvasFilters;

    removeDisplaySetting('braindump', { id: 'priority', key: 'high' });
    expect(view().braindumpFilters).toEqual({
      containers: ['project:Work'],
      priorities: [],
      goals: ['g2'],
      hideFinished: true,
    });

    removeDisplaySetting('braindump', { id: 'hide-finished' });
    expect(view().braindumpFilters.hideFinished).toBe(false);
    expect(view().braindumpFilters.containers).toEqual(['project:Work']);

    removeDisplaySetting('braindump', { id: 'group' });
    expect(view().braindumpGroupBy).toBe('none');
    expect(view().braindumpSortBy).toBe('priority');

    removeDisplaySetting('braindump', { id: 'sort' });
    expect(view().braindumpSortBy).toBe('default');

    expect(view().canvasFilters).toBe(canvasBefore);
    expect(view().canvasGroupBy).toBe('goal');
    expect(view().canvasSortBy).toBe('title');
    expect(view().typeFilter).toBe('habits');
  });

  it('clears the canvas grouping and type filter through the setters that keep the mirrors', () => {
    removeDisplaySetting('canvas', { id: 'group' });
    removeDisplaySetting('canvas', { id: 'type' });
    expect(view().canvasGroupBy).toBe('none');
    expect(view().typeFilter).toBe('all');
    expect(usePlannerStore.getState().groupBy).toBe('none');
    expect(usePlannerStore.getState().timelineItemFilter).toBe('all');
  });

  it("leaves the canvas's type filter alone when the braindump names it", () => {
    removeDisplaySetting('braindump', { id: 'type' });
    expect(view().typeFilter).toBe('habits');
  });

  it('takes a project off in every spelling it was stored in', () => {
    useViewStore.setState({
      braindumpFilters: filters({ containers: ['project:work', 'project:Work', NO_CONTAINER] }),
    });
    removeDisplaySetting('braindump', { id: 'project', key: 'project:Work' });
    expect(view().braindumpFilters.containers).toEqual([NO_CONTAINER]);
  });

  it('never touches Show paused, which is app-wide', () => {
    removeDisplaySetting('braindump', { id: 'group' });
    removeDisplaySetting('canvas', { id: 'goal', key: 'g1' });
    expect(usePlannerStore.getState().showPausedOnGrid).toBe(true);
    expect(view().canvasFilters.goals).toEqual([]);
  });
});

/* ── the hook ─────────────────────────────────────────────────────────────── */

describe('useDisplaySummary — the stores, resolved', () => {
  beforeEach(() => {
    seedStores();
    usePlannerStore.setState({
      projects: [{ id: 'p1', name: 'Work', emoji: '💼' }],
      goals: [goal({ id: 'g1', name: 'Learn Chinese' })],
    });
    useViewStore.setState({
      braindumpGroupBy: 'goal',
      braindumpSortBy: 'default',
      braindumpFilters: filters({ goals: ['g1'] }),
    });
  });
  afterEach(cleanup);

  it('reads the resolved group-by and the gated goal clause, and follows the switch', () => {
    disableExtensions(EXT_GOALS);
    const { result } = renderHook(() => useDisplaySummary('braindump'));
    // The stored 'goal' grouping and goal filter are both inert while Goals is off.
    expect(result.current).toEqual({ activeCount: 0, clauses: [] });

    act(() => enableExtensions(EXT_GOALS));
    expect(result.current.activeCount).toBe(2);
    expect(result.current.clauses.map(clauseText)).toEqual(['Grouped by Goal', 'Learn Chinese']);
  });

  it('reads only its own surface', () => {
    enableExtensions(EXT_GOALS);
    const { result } = renderHook(() => useDisplaySummary('canvas'));
    // seedStores set the canvas to a goal grouping, title sort, habits, and a
    // four-value filter; the braindump's settings are not in it.
    expect(result.current.clauses.map((c) => c.id)).toEqual([
      'group',
      'sort',
      'type',
      'priority',
      'project',
      'goal',
      'hide-finished',
    ]);
    expect(result.current.activeCount).toBe(7);
  });

  it('holds back the Unknown goal label until the planner has loaded', () => {
    enableExtensions(EXT_GOALS);
    usePlannerStore.setState({ userId: null, isLoading: false, goals: [] });
    const { result } = renderHook(() => useDisplaySummary('braindump'));
    // `!isLoading` alone is the store's initial state, before any load began.
    expect(labels(result.current, 'goal')).toEqual(['…']);

    act(() => usePlannerStore.setState({ userId: 'user-1', isLoading: true }));
    expect(labels(result.current, 'goal')).toEqual(['…']);

    act(() => usePlannerStore.setState({ isLoading: false }));
    expect(labels(result.current, 'goal')).toEqual([UNKNOWN_GOAL_LABEL]);
  });

  it('takes a project colour from the store, and follows it when it changes', () => {
    enableExtensions(EXT_GOALS);
    useViewStore.setState({ braindumpFilters: filters({ containers: ['project:Work'] }) });
    const { result } = renderHook(() => useDisplaySummary('braindump'));
    // No stored colour: getProjectColor's legacy token for 'work'.
    expect(glyphs(result.current, 'project')).toEqual([
      { kind: 'square', color: 'var(--habit-work)' },
    ]);

    act(() =>
      usePlannerStore.setState({ projects: [{ id: 'p1', name: 'Work', emoji: '💼', color: 'var(--accent-3)' }] })
    );
    expect(glyphs(result.current, 'project')).toEqual([{ kind: 'square', color: 'var(--accent-3)' }]);
  });

  it('hands back the same summary while nothing it reads has changed', () => {
    enableExtensions(EXT_GOALS);
    const { result, rerender } = renderHook(() => useDisplaySummary('braindump'));
    const first = result.current;

    rerender();
    // An unrelated write to a store it subscribes to.
    act(() => useViewStore.setState({ zenOpen: true }));

    expect(result.current).toBe(first);
  });
});
