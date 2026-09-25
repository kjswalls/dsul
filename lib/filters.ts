import type { HabitItem, Item, Priority, Task } from './planner-types';
import { getItemTypeConfig } from './item-registry';
import {
  NO_CONTAINER,
  classifyKindForItemType,
  containerRef,
  getContainerKindConfig,
  sameContainerRef,
} from './container-registry';

/**
 * The filter vocabulary, and the pure predicates over it.
 *
 * Deliberately store-free — `lib/day-items.ts` is documented pure and imports
 * only planner-types + recurrence, and it needs these.
 *
 * The container GRAMMAR — what a ref is, which kinds exist, how two of them
 * compare — moved to `lib/container-registry.ts` in Phase A. What is left here
 * is the filter side: which items a selection admits. Import the vocabulary from
 * the registry, never from this module; a re-export would be a second place to
 * look and eventually a second answer.
 */

/**
 * "Carries the field, but the value is unset."
 *
 * A first-class value, not an absence. `buildListGroups` has always minted
 * "No priority" / "No project" buckets for GROUPING; the filter path never
 * learned about them, so "show me High" silently deleted every task whose
 * priority was never set — which is most of them.
 *
 * 'none' is safe as the priority sentinel: it is already the item dialog's
 * draft vocabulary for unset (item-dialog.tsx:279) and is converted to
 * `undefined` before every write (`:336`, `:747`), so no stored item can carry
 * it as a real value.
 */
export const NO_PRIORITY = 'none';
export type PriorityFilterValue = Priority | typeof NO_PRIORITY;

/**
 * One filter set. Held separately by the braindump and the canvas — only the
 * shape is shared. See lib/view-store.ts for why it used to be four types.
 */
export interface ViewFilters {
  containers: string[];
  priorities: PriorityFilterValue[];
  /**
   * Goal IDS — never refs.
   *
   * The classify axis is a name namespace (`project:Work`) because that is what
   * the item column holds; a goal is referenced by id everywhere else in the
   * app (container-registry's ref grammar says so in as many words: routines,
   * programs and goals have no refs, because their names are not unique and
   * rename shipped on day one).
   *
   * See `passesGoalFilter` for what a selection means and why the resolution
   * arrives from outside this module.
   */
  goals: string[];
  hideFinished: boolean;
}

/* ── the pass-through rule ─────────────────────────────────────────────── */

/**
 * THE RULE: a predicate on field F may only exclude items of a type that
 * CARRIES F. Types where F is absent pass through untouched.
 *
 * What it replaces: three copies of `if (priorities.length || projects.length)
 * return []` — one per surface — which deleted every habit the moment any
 * priority or project filter was on. Habits carry neither field, so the filter
 * silently meant "and also hide all habits". It was commented as intended.
 *
 * `fields` is Object.keys(taskShape)/Object.keys(habitShape), so it cannot
 * drift from the schemas, and ItemDialog already interrogates it exactly this
 * way (`config.fields.includes('duration')`).
 */
export function fieldApplies(typeName: string, field: string): boolean {
  return getItemTypeConfig(typeName).fields.includes(field);
}

/**
 * The registry type name for a projection row or a full Item.
 *
 * The projections carry their runtime discriminator, so a row from `tasks` is
 * an Item in all but declared type. `tasks` is task-LIKE — custom-type items
 * ride it — which is why this resolves the registry name rather than assuming
 * 'task'.
 */
export function typeNameOf(row: Task | HabitItem | Item): string {
  const r = row as { type?: string; customType?: string };
  if (r.type === 'custom') return r.customType ?? 'custom';
  return r.type ?? 'task';
}

/**
 * The container this item answers with, as a prefixed ref — or `null` when its
 * type carries no container axis at all (pass-through).
 *
 * This is the load-bearing half of the habits fix. A habit is not
 * container-less: it answers with its GROUP. The axis is one question resolved
 * per type through the registry's `containerKind`, so a habit is excluded from
 * "show me Work" because its group is not selected, never because it cannot be
 * asked.
 *
 * An empty string counts as unset, not as a container named "". itemFromRow
 * maps `group: row.group ?? ''` (db.ts:108), so '' is a real live value and is
 * exactly what "No group" must catch.
 */
export function containerRefOf(row: Task | HabitItem | Item, typeName = typeNameOf(row)): string | null {
  const kind = classifyKindForItemType(getItemTypeConfig(typeName).containerKind);
  if (kind === null) return null;
  // The field is the registry's, not a branch: `project` for projects, `group`
  // for habit groups. A third classify kind reads its own column with no edit
  // here, which is the whole point of moving the two-way `if` into config.
  const field = getContainerKindConfig(kind).itemField!;
  const value = (row as Record<string, unknown>)[field];
  return typeof value === 'string' && value ? containerRef(kind, value) : NO_CONTAINER;
}

/** Empty selection = no-op. Then the pass-through rule, then membership. */
export function passesContainerFilter(
  row: Task | HabitItem | Item,
  containers: string[],
  typeName = typeNameOf(row)
): boolean {
  if (containers.length === 0) return true;
  const ref = containerRefOf(row, typeName);
  if (ref === null) return true; // carries no container axis — pass through
  // Case policy lives in the registry's `caseFold` — habit groups fold, projects
  // do not, and `foldRef` is the only expression of that.
  return containers.some((c) => sameContainerRef(c, ref));
}

/** Empty selection = no-op. Habits carry no priority, so they pass through. */
export function passesPriorityFilter(
  row: Task | HabitItem | Item,
  priorities: PriorityFilterValue[],
  typeName = typeNameOf(row)
): boolean {
  if (priorities.length === 0) return true;
  if (!fieldApplies(typeName, 'priority')) return true;
  const value = (row as { priority?: Priority }).priority ?? NO_PRIORITY;
  return priorities.includes(value);
}

/**
 * Empty selection = no-op. Then MEMBERSHIP — and no pass-through rule, because
 * there is no field to carry.
 *
 * The pass-through rule above is about a predicate on a FIELD: a habit carries
 * no `priority`, so a priority clause may not exclude it. Goal membership is
 * not a field and not a type capability — it lives in `goal_items`, and every
 * item type may join a goal. So a selection excludes any row that is not a
 * member, whatever its type, which is exactly what "show me the work serving
 * this goal" has to mean. A pass-through here would leave every habit in the
 * list while claiming to show one goal.
 *
 * `memberIds` is the selection RESOLVED to item ids, and it arrives from the
 * caller — `goalFilterItemIds` in lib/goals.ts — because this module is
 * store-free by contract (lib/day-items.ts imports it and is documented pure,
 * which is the whole reason the vocabulary lives here). It is the same bargain
 * as `DayItemsInput.inactiveItemIds`: resolved once per surface rather than
 * re-derived per row.
 *
 * A null/absent resolution means the clause is INERT, not empty. Two callers
 * produce it: `goalFilterItemIds` when the selection names no live goal (see
 * its own note), and any surface that does not offer this filter at all.
 * Emptying a list because a resolver was missing is the failure this whole
 * module was written to stop.
 */
export function passesGoalFilter(
  row: Task | HabitItem | Item,
  goals: readonly string[],
  memberIds?: ReadonlySet<string> | null
): boolean {
  if (goals.length === 0) return true;
  if (!memberIds) return true;
  return memberIds.has(row.id);
}

/**
 * All three narrowing axes. `hideFinished` is deliberately NOT here —
 * "finished" is a question about a DATE (completed-on, skipped-on), and this
 * module is date-blind. Each surface applies it beside its own date logic.
 */
export function passesFilters(
  row: Task | HabitItem | Item,
  filters: ViewFilters,
  typeName = typeNameOf(row),
  goalMemberIds?: ReadonlySet<string> | null
): boolean {
  return (
    passesPriorityFilter(row, filters.priorities, typeName) &&
    passesContainerFilter(row, filters.containers, typeName) &&
    passesGoalFilter(row, filters.goals, goalMemberIds)
  );
}

export const EMPTY_VIEW_FILTERS: ViewFilters = {
  containers: [],
  priorities: [],
  goals: [],
  hideFinished: false,
};

/**
 * Rehydrate a filter object from whatever an existing localStorage payload
 * holds.
 *
 * Load-bearing, not defensive dressing: see the `merge` note on view-store's
 * persist config. A stored blob predates `containers`/`hideFinished` and
 * carries `projects`/`hideCompleted`, so without this every existing install
 * reads `filters.containers` as `undefined` and `.length` throws.
 *
 * Legacy `projects` held bare names which were project names by construction —
 * both writers stored `project.name` verbatim — so they map into the `project:`
 * namespace UNCONDITIONALLY.
 *
 * Not "unless it already looks prefixed". Project names are unvalidated free
 * text (manage-categories only trims; there is no CHECK constraint), so a
 * project called "Client: Acme" would fail a contains-a-colon test and be left
 * bare — after which `namesOfKind` drops it, the project filter silently
 * stops narrowing, and the habits-wipe stops firing, while the trigger still
 * counts it as one active clause. The filter reads as active and does nothing.
 *
 * Re-run safety comes from branch ORDER, not from inspecting the value: output
 * always carries `containers`, so a second pass takes the first branch and
 * never reaches here — which is why the RETIRED-KIND rewrite below sits inside
 * that first branch instead.
 */
/**
 * `group:Health` → `project:Health`, for blobs written before migration 039.
 *
 * THIS IS NOT COSMETIC. `containerKindOf` answers only for kinds the registry
 * still knows, so a retired `group:` ref reads as "not a container ref":
 * `namesOfKind` drops it, the Display menu's checkbox never shows as ticked,
 * and `passesContainerFilter` narrows to the OTHER selected containers only —
 * while `activeFilterCount` still counts the clause. The filter reads as active
 * and quietly answers a different question. `localStorage` survives the reload
 * that would otherwise fix it, which is what makes it worth a rewrite rather
 * than a drop.
 *
 * Deduped, for `renameContainerRef`'s reason: a blob holding both
 * `project:Work` and `group:Work` would otherwise render "Work" twice in the
 * chip row and toggle only one of them off.
 *
 * Anything that is not a retired classify prefix passes through untouched —
 * including bare legacy names, which the branch above owns.
 */
const RETIRED_CLASSIFY_PREFIX = 'group:';

function adoptRetiredKinds(containers: string[]): string[] {
  if (!containers.some((c) => c.startsWith(RETIRED_CLASSIFY_PREFIX))) return containers;
  return [
    ...new Set(
      containers.map((c) =>
        c.startsWith(RETIRED_CLASSIFY_PREFIX)
          ? containerRef('project', c.slice(RETIRED_CLASSIFY_PREFIX.length))
          : c,
      ),
    ),
  ];
}

export function normalizeFilters(raw: unknown): ViewFilters {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_VIEW_FILTERS };
  const f = raw as Record<string, unknown>;

  const containers = Array.isArray(f.containers)
    ? adoptRetiredKinds(f.containers as string[])
    : Array.isArray(f.projects)
      ? (f.projects as string[]).map((name) => containerRef('project', name))
      : [];

  return {
    containers,
    priorities: Array.isArray(f.priorities) ? (f.priorities as Priority[]) : [],
    // Every blob written before the goal clause existed predates this field, so
    // it is the `containers` hazard again in miniature: `filters.goals.length`
    // on an undefined throws before anything can render. There is no legacy
    // key to migrate from — the clause is new — so the only job here is the
    // empty array.
    goals: Array.isArray(f.goals) ? (f.goals as string[]) : [],
    hideFinished:
      typeof f.hideFinished === 'boolean'
        ? f.hideFinished
        : typeof f.hideCompleted === 'boolean'
          ? f.hideCompleted
          : false,
  };
}

/** True when nothing is narrowing the view. */
export const isEmptyFilters = (f: ViewFilters): boolean =>
  f.containers.length === 0 &&
  f.priorities.length === 0 &&
  f.goals.length === 0 &&
  !f.hideFinished;

/** How many clauses are active — the trigger's dot and the reset row's count. */
export const activeFilterCount = (f: ViewFilters): number =>
  f.containers.length + f.priorities.length + f.goals.length + (f.hideFinished ? 1 : 0);

/**
 * How many clauses actually NARROW the list, for a count that reads "8 of 23".
 *
 * Not `activeFilterCount`, which answers "is the Display dot lit" and so counts
 * two things this must not: `hideFinished`, which only removes finished rows
 * and so never changes a count of OPEN ones, and a goal selection that
 * resolves to nothing (`goalMemberIds` null — no live goal named, or the Goals
 * extension off), which `passesGoalFilter` treats as inert. Counting either
 * would print "23 of 23" over a list nothing has narrowed.
 */
export const narrowingClauseCount = (
  f: ViewFilters,
  goalMemberIds: ReadonlySet<string> | null | undefined
): number => f.containers.length + f.priorities.length + (goalMemberIds ? f.goals.length : 0);
