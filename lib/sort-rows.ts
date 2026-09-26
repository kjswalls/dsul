import type { HabitItem, Priority, Task } from './planner-types';
import { fieldApplies, typeNameOf } from './filters';
import { getItemTypeConfig } from './item-registry';
import { isCompletedOnDate, isRecurring } from './recurrence';

/**
 * Row ordering applied POST-DERIVATION, for the surfaces that can take it.
 *
 * Two passes live here and they share one rule about where they may run:
 * `sortRows`, the user-chosen Ordering, and `sinkCompleted`, the always-on rule
 * that finished work drops to the foot of its group.
 *
 * Never inside `deriveDayItems`. That function is shared by all six canvas
 * surfaces, and two of them depend on its comparator for correctness rather
 * than for looks: `inferDropTime` (lib/dnd/infer-drop-time.ts:42-69) resolves a
 * drop as "30 minutes before/after THAT ITEM's time", not as a slot index, so
 * "the gap above row X" only means "just before X" while the row above X is
 * earlier in the day. Re-sort the timed spine and a drop lands at a time that
 * contradicts where the row visibly went.
 *
 * That is also why Ordering is offered on List only. Sorting just the untimed
 * sub-section of a Buckets card was considered and rejected: a sort control
 * that silently governs half a card is worse than none.
 *
 * `sinkCompleted` DOES reach that untimed sub-section, and the difference is
 * not a softening of the rule above — it is that the two passes displace
 * different things. An Ordering is a menu value that claims the surface it is
 * attached to, so honouring it on half a card breaks a promise the control
 * made. The sink makes no claim and has no control; what it must not do is
 * overwrite an order the USER authored. The untimed section has none — its
 * order is "habits, then tasks, then whatever the derivation emitted" — while
 * the timed spine's order IS each row's own `startTime`, which the user set and
 * which `inferDropTime` then reads back. So the spine keeps its clock and the
 * untimed rows take the sink, on Day × Buckets only; Week × Buckets has no
 * spine at all (its cells carry no per-row droppable) and takes it whole.
 * See the call sites in components/views/*.tsx for the per-surface reasoning.
 *
 * "The untimed section has none" is true today, and by accident rather than by
 * design: lib/day-items.ts sorts untimed rows by `order`, `task.orderable` is
 * true, and planner-store.ts exposes `reorderTasks` — but nothing under
 * components/ or app/ calls it, so that `order` is a creation sequence nobody
 * has dragged. Wire drag-to-reorder into the untimed section and the sink
 * begins silently overriding an order the user DID author, which is the one
 * thing the paragraph above says it must not do. Revisit this file then, not
 * only the call site.
 */

export type SortBy = 'default' | 'priority' | 'title';

export const SORT_VALUES: readonly SortBy[] = ['default', 'priority', 'title'];

export const isSortBy = (v: unknown): v is SortBy =>
  typeof v === 'string' && (SORT_VALUES as readonly string[]).includes(v);

/**
 * Unset sorts LAST, not first.
 *
 * The filter path's companion rule gives unset priority an explicit "No
 * priority" value so it stops being deleted; the sort's version of the same
 * courtesy is to keep it visible at the end rather than floating it to the top.
 * Most items have no priority, so first would bury the ones that do.
 */
const RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
const UNSET_RANK = 3;

export interface SortableRow {
  itemType: 'task' | 'habit';
  /** See GroupableRow — the ITEM shape, not the legacy projection. */
  item: Task | HabitItem;
}

/**
 * A type that does not CARRY priority ranks as unset rather than being pushed
 * to the end by a missing field — the sort-side reading of the pass-through
 * rule. A habit has no priority, so under "Priority" it lands with everything
 * else that has none, and under "Title" it interleaves with tasks normally.
 */
function priorityRank(row: SortableRow): number {
  // 'habit' from the ROW, not re-derived from the item: `itemType` is what the
  // surface built the row as, and typeNameOf falls back to 'task' for any row
  // whose runtime discriminator is missing. Task-likes still resolve through the
  // registry, so a custom type answers with its own config rather than 'task'.
  const typeName = row.itemType === 'habit' ? 'habit' : typeNameOf(row.item);
  if (!fieldApplies(typeName, 'priority')) return UNSET_RANK;
  const p = (row.item as { priority?: Priority }).priority;
  return p ? RANK[p] : UNSET_RANK;
}

/**
 * Numeric and case-insensitive: "Task 10" after "Task 2", and "apple" beside
 * "Apple" rather than in a separate uppercase run.
 */
const byTitle = (a: SortableRow, b: SortableRow): number =>
  (a.item.title ?? '').localeCompare(b.item.title ?? '', undefined, {
    sensitivity: 'base',
    numeric: true,
  });

/**
 * Sort a rendered row list.
 *
 * 'default' returns the SAME ARRAY, not a copy: the derivation's own order IS
 * the default, so there is nothing to do. (It also skips an O(n) copy per
 * render. It does not yet save any caller a memo invalidation — all three hand
 * this a freshly-built array literal — so don't claim that until one of them
 * memoizes.)
 *
 * Every other value copies before sorting (Array#sort mutates) and relies on
 * sort stability, which ES2019 guarantees: rows comparing equal keep the
 * derivation's order, so "Priority" inside a bucket is still time-ordered
 * within each priority band.
 */
export function sortRows<T extends SortableRow>(rows: T[], sortBy: SortBy): T[] {
  if (sortBy === 'default') return rows;
  if (sortBy === 'title') return [...rows].sort(byTitle);
  return [...rows].sort((a, b) => priorityRank(a) - priorityRank(b));
}

/* ── completed sinks ────────────────────────────────────────────────────────*/

/**
 * Is this row FINISHED on the day it is being drawn for?
 *
 * Two rules, and which one applies is decided by recurrence, never by type:
 *
 *  - A recurring item's completion is per-DATE (`completedDates`), never the
 *    scalar `status` — migration 016's semantics, and the reason a habit ticked
 *    today must not read as finished on every other day of the week.
 *  - A one-shot item's is its scalar `status`, compared against the registry's
 *    `doneStatus` for its type rather than a literal. The vocabularies differ on
 *    purpose (`completed` for tasks and custom types, `done` for habits) and are
 *    external contracts the OpenClaw plugin parses, so this asks the registry
 *    which value means finished instead of testing for either.
 *
 * `cancelled` and `skipped` deliberately do NOT count. `doneStatus` is the only
 * field in the registry that names a finished state; there is no "terminal
 * statuses" set to ask, so treating those two as done would mean hardcoding one
 * member of each vocabulary and asserting they mean the same thing — the exact
 * merge the legacy-projection contract forbids. It is also what the rows
 * already say: `data-completed` is false on both, a cancelled task is not
 * struck through, and a skipped occurrence renders in its own minimized form.
 *
 * `dateStr` is NULLABLE and the null case is load-bearing, not a convenience: a
 * dateless surface (the braindump) has no day to resolve a recurring item's
 * completion against, and TaskRow already refuses to draw one as completed
 * there (`suppressCompletedLook`, issue #181). Passing null keeps this predicate
 * in step with what the row renders — a recurring row that shows no completion
 * mark must not move as if it had one.
 */
export function isRowCompletedOn(row: SortableRow, dateStr: string | null): boolean {
  const item = row.item as { status?: string; repeatFrequency?: string; completedDates?: string[] };
  if (isRecurring(item)) {
    return dateStr !== null && isCompletedOnDate(item, dateStr);
  }
  // 'habit' from the ROW for the same reason priorityRank takes it from there:
  // typeNameOf falls back to 'task' for a projection missing its runtime
  // discriminator, and 'task' answers `completed` where a habit answers `done`.
  const typeName = row.itemType === 'habit' ? 'habit' : typeNameOf(row.item);
  return item.status === getItemTypeConfig(typeName).doneStatus;
}

/**
 * Which side of the sink a row sorts on. {@link isRowCompletedOn} by default;
 * a surface passes `useSinkHold`'s `completedAs` (hooks/use-sink-hold.ts) so a
 * row just ticked keeps its place for a moment and then slides down, rather
 * than vanishing to the foot of the group in the frame its checkbox fills.
 */
export type CompletedAs = (row: SortableRow, dateStr: string | null) => boolean;

/**
 * Finished work sinks to the foot of its own group.
 *
 * ALWAYS ON, and not a fourth setting. The app already has two controls for
 * completed rows and both are about whether they are there at all — the global
 * `showCompletedTasks` and the Display menu's `hideFinished` — so this only ever
 * takes effect for a user who has asked to keep seeing finished work. A toggle
 * to undo it would be a preference whose entire job is to restore the state the
 * two existing preferences already reach by removing the rows.
 *
 * A PARTITION, not a comparator. Stability inside each half is then structural
 * rather than a property of Array#sort: both halves are appended in the order
 * they were walked, so an Ordering already applied by {@link sortRows} survives
 * intact within each half, and 'default' rows keep the derivation's own order.
 *
 * Returns the SAME ARRAY when the split is trivial, the convention `sortRows`
 * sets for 'default': a list with nothing finished, or with nothing unfinished,
 * is already in this order.
 *
 * SCOPE IS THE CALLER'S. This is applied post-derivation and per group, exactly
 * like `sortRows`, and for the same reason — see this file's header. Day ×
 * Buckets hands over its untimed rows only (the note at that call site says
 * why), and both Schedule views hand over their Anytime strips only: each strip
 * sits behind one droppable, so nothing there resolves a drop against a
 * neighbour's time, while the hour grid below is position-as-time and never
 * takes the pass.
 *
 * One place is outside the pass entirely, and the omission is not forced by
 * the spine rule above:
 *
 *  - The braindump's `pausedGroups` never reaches {@link orderRows}, so a
 *    finished row under a "Paused" heading stays put while one in the working
 *    list sinks. That section is a recovery surface grouped BY CAUSE, and it
 *    already declines `braindumpFilters` and `braindumpSortBy` on the grounds
 *    that shaping it would reintroduce the hiding it exists to undo; letting
 *    the sink alone through would make it the single working-list rule that
 *    leaks in.
 */
export function sinkCompleted<T extends SortableRow>(
  rows: T[],
  dateStr: string | null,
  completedAs: CompletedAs = isRowCompletedOn,
): T[] {
  const open: T[] = [];
  const done: T[] = [];
  for (const row of rows) (completedAs(row, dateStr) ? done : open).push(row);
  if (done.length === 0 || open.length === 0) return rows;
  return [...open, ...done];
}

/**
 * The full post-derivation ordering pass for the list surfaces: the chosen
 * Ordering first, then the sink.
 *
 * Composed here rather than at the three call sites so the two can never be
 * applied in the other order. Sinking first and sorting second would let Title
 * A–Z lift a completed row back over an unfinished one, which is the whole
 * behaviour undone by an ordering the user picked for a different reason.
 */
export function orderRows<T extends SortableRow>(
  rows: T[],
  sortBy: SortBy,
  dateStr: string | null,
  completedAs?: CompletedAs,
): T[] {
  return sinkCompleted(sortRows(rows, sortBy), dateStr, completedAs);
}
