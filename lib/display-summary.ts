'use client';

import { useMemo } from 'react';

import { usePlannerStore } from './planner-store';
import { useViewStore, type TypeFilter } from './view-store';
import {
  EMPTY_VIEW_FILTERS,
  NO_PRIORITY,
  activeFilterCount,
  type PriorityFilterValue,
  type ViewFilters,
} from './filters';
import {
  CONTAINER_KINDS,
  NO_CONTAINER,
  containerKindOf,
  containerName,
  containerRef,
  foldContainerName,
  namesOfKind,
  sameContainerName,
  sameContainerRef,
} from './container-registry';
import { displayGoals, isGoalActive } from './goals';
import {
  goalsEnabled,
  useBraindumpGroupBy,
  useCanvasGroupBy,
  useGoalsEnabled,
} from './extension-gates';
import {
  BRAINDUMP_GROUP_BY_OPTIONS,
  CANVAS_GROUP_BY_OPTIONS,
  SORT_BY_OPTIONS,
  TYPE_OPTIONS,
} from './view-options';
import { PRIORITY_LABELS, type Goal, type Priority } from './planner-types';
import type { SortBy } from './sort-rows';

/**
 * display-summary.ts — what a surface's Display settings ARE, derived once.
 *
 * Three things read "what is set" on a surface: the Display trigger's dot and
 * count, the menu's Reset row, and the braindump's Display shelf, which spells
 * the settings out under the header while any are set. They have to agree to
 * the value, and the menu already paid for learning why: it replaced two
 * popovers whose bodies drifted apart field by field until one of them was
 * wrong (see the header of components/primitives/display-menu.tsx). A shelf
 * that worked out its own answer beside the dot's would be a third copy of the
 * same bet. So the count, the clauses and Reset all come from here, and neither
 * renderer re-derives any of them.
 *
 * Two rules the derivation keeps, both pinned by its tests:
 *
 *   · `activeCount > 0` exactly when `clauses` is non-empty — the dot is lit
 *     exactly when the shelf has something to say.
 *   · Every value the count counts renders as exactly one clause value. A
 *     duplicate collapses into its twin, which is the only way the values can
 *     number fewer than the count; and a value nothing can resolve (a deleted
 *     project, a goal id the store cannot name, a junk string from a
 *     hand-edited blob) is still named, because it is still counted. A lit dot
 *     over a shelf with nothing to account for it is the stranded clause the
 *     menu's own rules exist to prevent.
 *
 * The core is pure — `summarizeDisplay` is handed the slices it reads — so the
 * whole state matrix can be tested without a render. `useDisplaySummary` feeds
 * it from the stores, `resetDisplay` is the one reset, and
 * `removeDisplaySetting` takes off the one clause or value a shelf ✕ names.
 */

export type DisplaySurface = 'canvas' | 'braindump';

/* ── the vocabulary the menu and the shelf share ─────────────────────────── */

/**
 * The Priority section's rows, top to bottom. The menu builds its rows from
 * this, and a menu test holds the rows it draws to it. It is the shelf's order
 * too, which is this and never the stored one: a filter array is in the order
 * its values were clicked.
 */
export const PRIORITY_FILTER_ORDER: readonly PriorityFilterValue[] = [
  'high',
  'medium',
  'low',
  NO_PRIORITY,
];

function isPriority(v: string): v is Priority {
  return v !== NO_PRIORITY && (PRIORITY_FILTER_ORDER as readonly string[]).includes(v);
}

/**
 * High / Medium / Low / 'No priority'; any other stored string is returned
 * as-is.
 *
 * As-is rather than dropped: `normalizeFilters` checks that `priorities` is an
 * array, not what is in it, so a hand-edited blob can hold a string no row
 * offers. It is counted all the same, so it has to be called something.
 */
export function priorityFilterLabel(v: string): string {
  if (v === NO_PRIORITY) return 'No priority';
  return isPriority(v) ? PRIORITY_LABELS[v] : v;
}

/**
 * What a selected goal id is called when the goals list cannot name it —
 * deleted, or held over from a session whose goals table never loaded.
 */
export const UNKNOWN_GOAL_LABEL = 'Unknown goal';

/**
 * Before the planner's first load has landed, every selected goal id is
 * unknown. The store has simply not answered yet, and "Unknown goal" would read
 * as gone, so this neutral mark stands in until it does.
 */
const PENDING_GOAL_LABEL = '…';

/**
 * The Goal section's row order: displayGoals(goals), then SELECTED goals whose
 * state is not 'active', each in store order. (isGoalActive ≡ state ===
 * 'active', so the two never overlap.)
 *
 * An ended goal drops out of the list unless it is selected, because hiding a
 * selected one would strand the clause it still holds.
 */
export function goalMenuOrder(goals: readonly Goal[], selected: readonly string[]): Goal[] {
  return [
    ...displayGoals(goals),
    ...goals.filter((g) => selected.includes(g.id) && !isGoalActive(g)),
  ];
}

/* ── the model ───────────────────────────────────────────────────────────── */

/**
 * How a value is marked. Data, not an element: this module draws nothing, and
 * each renderer maps a kind to its mark.
 *
 * `dot` and `square` are the menu rows' own PriorityDot and ContainerSquare, so
 * a value wears one mark wherever it appears. `ring` is PriorityDot's hollow
 * form, which the menu already gives both unset values ("No priority", "No
 * project"); here it also marks the two stored values no row could ever have
 * offered, a priority string outside the list and a ref of no classify kind.
 * A value that had a row keeps its mark after the row is gone: a deleted
 * project its square, a goal id nothing answers to its Target. `target` is
 * lucide's Target, the glyph the app names goals with.
 */
export type DisplayGlyph =
  | { kind: 'dot'; value: Priority }
  | { kind: 'ring' }
  | { kind: 'square'; color: string }
  | { kind: 'target' };

/** One selected value of a multi-select clause. `key` is unique within its clause. */
export interface DisplayValue {
  key: string;
  label: string;
  glyph: DisplayGlyph;
}

/**
 * One setting, in the menu's section order. Grouping, ordering and the type
 * filter carry their chosen option's label. The three multi-selects carry their
 * values and their section's noun, which says in words what the glyph says to
 * the eye.
 */
export type DisplayClause =
  | { id: 'group'; label: string }
  | { id: 'sort'; label: string }
  // The canvas only, where no shelf mounts; kept so the model answers for both
  // surfaces and the count's type term has a clause behind it.
  | { id: 'type'; label: string }
  | { id: 'priority' | 'project' | 'goal'; noun: string; values: DisplayValue[] }
  | { id: 'hide-finished' };

export interface DisplaySummary {
  /** The trigger dot's count and the Reset badge. It counts VALUES, not clauses. */
  activeCount: number;
  clauses: DisplayClause[];
}

export interface DisplaySummaryInput {
  surface: DisplaySurface;
  filters: ViewFilters;
  /**
   * The EFFECTIVE (gated) group-by, never the stored one — a stored 'goal' reads
   * 'none' while Goals is off (`useCanvasGroupBy` / `useBraindumpGroupBy`).
   */
  groupBy: string;
  sortBy: SortBy;
  typeFilter: TypeFilter;
  goalsOn: boolean;
  /**
   * The planner's first load has landed: `!!userId && !isLoading`. `!isLoading`
   * alone is also true before the load begins, which is the store's initial
   * state (components/shell/app-shell.tsx reads it the same way).
   *
   * A load that FAILED has landed too, on purpose. The store has answered, if
   * badly, and the Display menu already names such an id "Unknown goal" (its
   * row for a goals table that could not be reached). Holding '…' until a load
   * succeeded would have the shelf and the menu it opens disagree about one
   * value for as long as the failure lasted.
   */
  loaded: boolean;
  projects: readonly { name: string }[];
  goals: readonly Goal[];
  projectColor: (name: string) => string;
}

const RING: DisplayGlyph = { kind: 'ring' };
const TARGET: DisplayGlyph = { kind: 'target' };

/**
 * An option's label, or the raw value when its list has none. A value the list
 * does not know is still counted, so it is still named.
 */
function labelOf(options: readonly { value: string; label: string }[], value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

/** Menu order first, whatever order they were clicked in; then anything outside it. */
function priorityValues(stored: readonly string[]): DisplayValue[] {
  const known = PRIORITY_FILTER_ORDER.filter((v) => stored.includes(v));
  const other = [
    ...new Set(stored.filter((v) => !(PRIORITY_FILTER_ORDER as readonly string[]).includes(v))),
  ];
  return [...known, ...other].map(
    (v): DisplayValue => ({
      key: v,
      label: priorityFilterLabel(v),
      glyph: isPriority(v) ? { kind: 'dot', value: v } : RING,
    })
  );
}

/**
 * The Project clause, in four runs.
 *
 *   1. Store projects a stored ref names, in store order, by the menu's own
 *      `checked` test. It folds, so a ref stored as 'personal' shows as the
 *      'Personal' row it ticks.
 *   2. `project:` refs no store project answers, in stored order: a DELETED
 *      project (removeProject never prunes a filter ref), or, before the planner
 *      has loaded, every ref. The menu has no row for these, and a stale ref is
 *      not inert — selected alone it empties the list — so this is the one
 *      place it gets named. Deduped on the folded name, as the menu's one
 *      checkbox would take them.
 *   3. Refs of no classify kind, a bare legacy name or any other prefix
 *      (`routine:` and `program:` among them, which this filter never
 *      writes): nothing here resolves them, so each is named by what follows
 *      its first colon (`containerName`), with the ring.
 *   4. The unset value, last, where its row is. It needs a label of its own:
 *      `containerName(NO_CONTAINER)` is ''.
 *
 * Colour takes no loaded gate. An uncoloured project's colour IS its name hash,
 * so all the planner's arrival can change is a colour the user picked, and the
 * store order the values settle into.
 */
function projectValues({ filters, projects, projectColor }: DisplaySummaryInput): DisplayValue[] {
  const stored = filters.containers;
  const names = namesOfKind(stored, 'project');

  const live = projects
    .filter((p) => names.some((n) => sameContainerName('project', n, p.name)))
    .map(
      (p): DisplayValue => ({
        key: containerRef('project', p.name),
        label: p.name,
        glyph: { kind: 'square', color: projectColor(p.name) },
      })
    );

  const seen = new Set<string>();
  const stale: DisplayValue[] = [];
  for (const name of names) {
    if (projects.some((p) => sameContainerName('project', name, p.name))) continue;
    const folded = foldContainerName('project', name);
    if (seen.has(folded)) continue;
    seen.add(folded);
    stale.push({
      key: containerRef('project', name),
      label: name,
      glyph: { kind: 'square', color: projectColor(name) },
    });
  }

  const unresolved = [
    ...new Set(stored.filter((ref) => ref !== NO_CONTAINER && containerKindOf(ref) === null)),
  ].map((ref): DisplayValue => ({ key: ref, label: containerName(ref), glyph: RING }));

  const unset: DisplayValue[] = stored.includes(NO_CONTAINER)
    ? [{ key: NO_CONTAINER, label: CONTAINER_KINDS.project.unsetLabel!, glyph: RING }]
    : [];

  return [...live, ...stale, ...unresolved, ...unset];
}

/**
 * The Goal clause: selected goals in the menu's row order, then one value per
 * id the goals list cannot name.
 *
 * Every value wears Target, the glyph the app names goals with wherever it
 * names them (the Goal grouping option, the item dialog's chip, the console
 * rail), rather than the colour square a menu row carries. That also keeps goal
 * colours, which can hash to lime --accent-8, off the resting surface.
 */
function goalValues({ filters, goals, loaded }: DisplaySummaryInput): DisplayValue[] {
  const selected = filters.goals;
  const known = goalMenuOrder(goals, selected)
    .filter((g) => selected.includes(g.id))
    .map((g): DisplayValue => ({ key: g.id, label: g.name, glyph: TARGET }));
  const unknown = [...new Set(selected.filter((id) => !goals.some((g) => g.id === id)))].map(
    (id): DisplayValue => ({
      key: id,
      label: loaded ? UNKNOWN_GOAL_LABEL : PENDING_GOAL_LABEL,
      glyph: TARGET,
    })
  );
  return [...known, ...unknown];
}

/**
 * Everything set on one surface: the count behind the trigger's dot, and the
 * clauses that account for it, in the menu's order.
 *
 * The count is VALUES, not clauses (three selected projects are three), and
 * grouping, ordering and the type filter are IN it, because Reset clears them.
 * The popover the Display menu replaced counted grouping for its dot while its
 * "Clear filters" reset neither, so the dot stayed lit after clearing with no
 * way to put it out from the panel that lit it.
 *
 * The goal clause counts, and renders, only while Goals is on. Off, nothing
 * consults `filters.goals` (lib/extension-gates.ts): a selection the switch
 * left behind narrows nothing and the menu has no row for it, so counting it
 * would light the dot over a clause nothing on screen accounts for. `groupBy`
 * arrives already resolved for the same reason.
 */
export function summarizeDisplay(input: DisplaySummaryInput): DisplaySummary {
  const { surface, filters, groupBy, sortBy, typeFilter, goalsOn } = input;
  const isCanvas = surface === 'canvas';
  const typeSet = isCanvas && typeFilter !== 'all';
  const groupSet = groupBy !== 'none';
  const sortSet = sortBy !== 'default';
  const activeCount =
    activeFilterCount({ ...filters, goals: goalsOn ? filters.goals : [] }) +
    (groupSet ? 1 : 0) +
    (sortSet ? 1 : 0) +
    (typeSet ? 1 : 0);

  const clauses: DisplayClause[] = [];
  if (groupSet) {
    const options = isCanvas ? CANVAS_GROUP_BY_OPTIONS : BRAINDUMP_GROUP_BY_OPTIONS;
    clauses.push({ id: 'group', label: labelOf(options, groupBy) });
  }
  if (sortSet) clauses.push({ id: 'sort', label: labelOf(SORT_BY_OPTIONS, sortBy) });
  if (typeSet) clauses.push({ id: 'type', label: labelOf(TYPE_OPTIONS, typeFilter) });

  const priorities = priorityValues(filters.priorities);
  // 'Priority' is a literal in the menu's section label too.
  if (priorities.length > 0) clauses.push({ id: 'priority', noun: 'Priority', values: priorities });
  const projects = projectValues(input);
  if (projects.length > 0) {
    clauses.push({ id: 'project', noun: CONTAINER_KINDS.project.label, values: projects });
  }
  const goals = goalsOn ? goalValues(input) : [];
  if (goals.length > 0) clauses.push({ id: 'goal', noun: CONTAINER_KINDS.goal.label, values: goals });

  if (filters.hideFinished) clauses.push({ id: 'hide-finished' });

  return { activeCount, clauses };
}

/**
 * A clause as the shelf reads — its visible text. The shelf keys its fit on
 * the joined text of every clause, and tests read it as the oracle.
 */
export function clauseText(c: DisplayClause): string {
  switch (c.id) {
    case 'group':
      return `Grouped by ${c.label}`;
    case 'sort':
      return `Sorted by ${c.label}`;
    case 'type':
      return c.label;
    case 'priority':
    case 'project':
    case 'goal':
      return c.values.map((v) => v.label).join(', ');
    case 'hide-finished':
      return 'Hide finished';
  }
}

/**
 * The live summary for one surface — the count DisplayMenu's trigger shows and
 * the clauses the braindump's shelf renders.
 *
 * One field selector per input, and none of them returns a fresh object:
 * zustand 5 compares a selector's result by identity and this repo has no
 * `useShallow`, so a selector that built an array would re-render forever. The
 * derivation runs in one memo over those slices instead. Both group-by hooks
 * run whatever the surface, since a hook cannot be conditional, and each
 * already answers with the resolved value.
 *
 * `getProjectColor` is one stable function that reads `projects` inside, which
 * is why `projects` is a dependency even when only a colour changed.
 */
export function useDisplaySummary(surface: DisplaySurface): DisplaySummary {
  const isCanvas = surface === 'canvas';
  const filters = useViewStore((s) => (isCanvas ? s.canvasFilters : s.braindumpFilters));
  const sortBy = useViewStore((s) => (isCanvas ? s.canvasSortBy : s.braindumpSortBy));
  const typeFilter = useViewStore((s) => s.typeFilter);
  const canvasGroupBy = useCanvasGroupBy();
  const braindumpGroupBy = useBraindumpGroupBy();
  const goalsOn = useGoalsEnabled();
  const loaded = usePlannerStore((s) => !!s.userId && !s.isLoading);
  const projects = usePlannerStore((s) => s.projects);
  const goals = usePlannerStore((s) => s.goals);
  const projectColor = usePlannerStore((s) => s.getProjectColor);
  const groupBy: string = isCanvas ? canvasGroupBy : braindumpGroupBy;

  return useMemo(
    () =>
      summarizeDisplay({
        surface,
        filters,
        groupBy,
        sortBy,
        typeFilter,
        goalsOn,
        loaded,
        projects,
        goals,
        projectColor,
      }),
    [surface, filters, groupBy, sortBy, typeFilter, goalsOn, loaded, projects, goals, projectColor]
  );
}

/**
 * Reset clears everything the Display menu OWNS for this surface. The menu's
 * "Reset display" row and the braindump shelf's ✕ are both this function, so
 * the two cannot come apart.
 *
 * `showPausedOnGrid` is deliberately excluded, and the menu captions its row
 * "Everywhere" for the same reason — it is an app-wide setting that happens to
 * be reachable there, not a display preference of this surface, and resetting
 * one surface must not silently change what the other five show.
 *
 * Reads the stores and the Goals gate when it is called rather than closing
 * over a render, so a button outside the menu gets the answer the row inside
 * it would. The setters are the store's own, so the canvas group-by and type
 * filter keep their planner-store mirrors.
 */
export function resetDisplay(surface: DisplaySurface): void {
  const view = useViewStore.getState();
  const goalsOn = goalsEnabled();
  const isCanvas = surface === 'canvas';
  const filters = isCanvas ? view.canvasFilters : view.braindumpFilters;
  const setFilters = isCanvas ? view.setCanvasFilters : view.setBraindumpFilters;

  // RESET CLEARS WHAT THE MENU IS SHOWING, and a gated clause is not showing.
  //
  // While Goals is off the menu renders no row for the goal filter and no
  // Goal value under Grouping, and the trigger deliberately does not count
  // either — the argument being that the menu does not own them. Clearing
  // them here would contradict that in the most annoying possible way:
  // Reset would silently destroy a selection the user cannot see, so
  // switching Goals back on would return an empty filter rather than the one
  // they left. Off has to be lossless, and this is the one path where it
  // nearly was not.
  setFilters({ ...EMPTY_VIEW_FILTERS, goals: goalsOn ? [] : filters.goals });
  // The STORED group-by: the resolved one already reads 'none' while Goals is
  // off, so testing it would clear exactly the grouping the switch is keeping.
  const keepGroupBy = (stored: string) => !goalsOn && stored === 'goal';
  if (isCanvas) {
    if (!keepGroupBy(view.canvasGroupBy)) view.setCanvasGroupBy('none');
    view.setCanvasSortBy('default');
    view.setTypeFilter('all');
  } else {
    if (!keepGroupBy(view.braindumpGroupBy)) view.setBraindumpGroupBy('none');
    view.setBraindumpSortBy('default');
  }
}

/* ── taking one setting off ──────────────────────────────────────────────── */

/**
 * What one of the shelf's per-setting ✕s names: a single clause, or one value
 * of a multi-select by its `DisplayValue.key`.
 */
export type DisplayRemoval =
  | { id: 'group' | 'sort' | 'type' | 'hide-finished' }
  | { id: 'priority' | 'project' | 'goal'; key: string };

/**
 * The filters with one drawn value taken off — EVERY stored value it stands
 * for, not just the one spelling the key carries.
 *
 * A value can stand for more than one stored entry, because duplicates
 * collapse into their twin (see `summarizeDisplay`): 'high' twice is one High,
 * and `project:Work` and `project:work` are one Work. Taking off only the
 * spelling in the key would leave the twin behind, and the value would stay
 * on the shelf after its ✕ was pressed. So projects compare the way the menu's
 * checkbox ticks them, folded (`sameContainerRef`, which leaves a ref of no
 * classify kind and the unset key to exact equality), and priorities and goals
 * compare exactly, as they are deduped.
 *
 * Pure, and never writes into the array it was handed.
 */
export function withoutDisplayValue(
  filters: ViewFilters,
  removal: Extract<DisplayRemoval, { key: string }>
): ViewFilters {
  const { key } = removal;
  switch (removal.id) {
    case 'priority':
      return { ...filters, priorities: filters.priorities.filter((v) => v !== key) };
    case 'project':
      return { ...filters, containers: filters.containers.filter((r) => !sameContainerRef(r, key)) };
    case 'goal':
      return { ...filters, goals: filters.goals.filter((id) => id !== key) };
  }
}

/**
 * Take one clause, or one value of a multi-select, off this surface — what a
 * shelf ✕ beside a single setting does, where the ✕ at the end is
 * `resetDisplay` and takes off all of them.
 *
 * Through the same setters Reset uses, so the canvas group-by and type filter
 * keep their planner-store mirrors. Reads the stores when it is called, as
 * Reset does. Nothing here consults the Goals gate: the shelf draws no goal
 * clause and no goal grouping while Goals is off, so no ✕ can name one, and
 * what the switch is keeping is kept.
 */
export function removeDisplaySetting(surface: DisplaySurface, removal: DisplayRemoval): void {
  const view = useViewStore.getState();
  const isCanvas = surface === 'canvas';
  switch (removal.id) {
    case 'group':
      if (isCanvas) view.setCanvasGroupBy('none');
      else view.setBraindumpGroupBy('none');
      return;
    case 'sort':
      if (isCanvas) view.setCanvasSortBy('default');
      else view.setBraindumpSortBy('default');
      return;
    case 'type':
      // The type filter is the canvas's alone; the braindump never shows it.
      if (isCanvas) view.setTypeFilter('all');
      return;
    case 'hide-finished': {
      const filters = isCanvas ? view.canvasFilters : view.braindumpFilters;
      const setFilters = isCanvas ? view.setCanvasFilters : view.setBraindumpFilters;
      setFilters({ ...filters, hideFinished: false });
      return;
    }
    default: {
      const filters = isCanvas ? view.canvasFilters : view.braindumpFilters;
      const setFilters = isCanvas ? view.setCanvasFilters : view.setBraindumpFilters;
      setFilters(withoutDisplayValue(filters, removal));
    }
  }
}
