import type { GroupBy } from './planner-types';
import type { SortBy, SortableRow, CompletedAs } from './sort-rows';
import { isRowSettledOn } from './sort-rows';
import { getItemTypeConfig } from './item-registry';
import { typeNameOf } from './filters';

/**
 * Drag to reorder — the rules, pure, in one place.
 *
 * Kirby's call (2026-10-24): rows reorder by drag on a pointer, in every list
 * that is in the user's own order, and never by drag on a phone (long press is
 * already a MOVE there; the phone gets Move up / Move down in the row's menu).
 * See lib/dnd/CONTRACT.md "A drop inside a row's own section reorders".
 *
 * What a reorder writes is `items.order`, ONE number per item. There is no
 * per-day order: moving a daily habit up on Friday moves it up every day, and
 * the braindump, the lists and the bucket cards all read the same number. A
 * per-day order would need a table of its own for little gain.
 *
 * Who may move, and among whom:
 *
 *  - Only an ORDERABLE type (the registry's `orderable`), with no clock time
 *    (a timed row's place is its time), not finished on the day drawn (finished
 *    rows sink below the order, `sinkCompleted`), and not inside a project
 *    block (that block has no list of its own).
 *  - Only among PEERS: the movable rows of the same section and the same kind
 *    (a habit among habits, a task among tasks). Tasks and habits have kept
 *    separate order sequences since 019, so interleaving them by number would
 *    be noise.
 *  - Only when the list is in that order at all: Default ordering, and a
 *    grouping that does not bring an order of its own (a routine's, a season's
 *    or a goal's sequence belongs to Organize).
 */

/** Groupings whose sections keep the planner order inside them. */
const ORDER_KEEPING_GROUPS: ReadonlySet<GroupBy | 'type'> = new Set<GroupBy | 'type'>([
  'none',
  'project',
  'priority',
  'bucket',
  'type',
]);

/** Is this list in the user's own order, so that a reorder means something? */
export function reorderAllowed(sortBy: SortBy, groupBy: GroupBy | 'type'): boolean {
  return sortBy === 'default' && ORDER_KEEPING_GROUPS.has(groupBy);
}

/** The kind a row reorders among: habits with habits, everything task-like with tasks. */
export type PeerKind = 'task' | 'habit';

function typeNameOfRow(row: SortableRow): string {
  return row.itemType === 'habit' ? 'habit' : typeNameOf(row.item);
}

/**
 * Can this row be dragged into a new place on the day `dateStr` (null: the
 * braindump, which carries no date)?
 */
export function isRowMovable(
  row: SortableRow,
  dateStr: string | null,
  completedAs: CompletedAs = isRowSettledOn
): boolean {
  if (!getItemTypeConfig(typeNameOfRow(row)).orderable) return false;
  const item = row.item as { startTime?: string; inProjectBlock?: boolean };
  if (item.startTime) return false;
  if (item.inProjectBlock) return false;
  return !completedAs(row, dateStr);
}

/** A section's movable rows, by kind, in the order drawn. */
export function peersOf(
  rows: readonly SortableRow[],
  dateStr: string | null,
  completedAs?: CompletedAs
): Record<PeerKind, string[]> {
  const peers: Record<PeerKind, string[]> = { task: [], habit: [] };
  for (const row of rows) {
    if (isRowMovable(row, dateStr, completedAs)) peers[row.itemType].push(row.item.id);
  }
  return peers;
}

/**
 * Two `order`s compared, a missing one LAST — how the load reads it (`ORDER BY
 * "order"` puts NULLs last; habits made since 019 never wrote one), so the
 * first render after a load keeps the load's own order.
 */
export function compareOrder(a: number | undefined | null, b: number | undefined | null): number {
  if (a == null) return b == null ? 0 : 1;
  if (b == null) return -1;
  return a - b;
}

function byTimeThenOrder(a: SortableRow, b: SortableRow): number {
  const at = (a.item as { startTime?: string }).startTime;
  const bt = (b.item as { startTime?: string }).startTime;
  if (at && bt) return at.localeCompare(bt);
  if (at) return -1;
  if (bt) return 1;
  return compareOrder((a.item as { order?: number }).order, (b.item as { order?: number }).order);
}

/**
 * A list section in planner order: within each kind, timed rows by their time,
 * then untimed rows by `order`. Each kind keeps the slots it already held, so a
 * section that drew habits then tasks still does; only who sits in each slot
 * changes. Stable, and the SAME ARRAY back when nothing moves (sort-rows.ts's
 * convention).
 *
 * The lists used to order untimed rows by their time bucket first, a split the
 * lists never draw. With reorder, the order you set is the order you see.
 */
export function inPlannerOrder<T extends SortableRow>(rows: T[]): T[] {
  const sorted: Record<PeerKind, T[]> = {
    task: rows.filter((r) => r.itemType === 'task').sort(byTimeThenOrder),
    habit: rows.filter((r) => r.itemType === 'habit').sort(byTimeThenOrder),
  };
  const cursor: Record<PeerKind, number> = { task: 0, habit: 0 };
  const out = rows.map((r) => sorted[r.itemType][cursor[r.itemType]++]);
  return out.every((r, i) => r === rows[i]) ? rows : out;
}

/**
 * `peers` with `moving` (one id or a block, in its drawn order) taken out and
 * put back before `beforeId` (null: at the end). Null when that changes nothing.
 */
export function movePeers(
  peers: readonly string[],
  moving: readonly string[],
  beforeId: string | null
): string[] | null {
  const movingSet = new Set(moving);
  const block = peers.filter((id) => movingSet.has(id));
  if (block.length === 0) return null;
  const rest = peers.filter((id) => !movingSet.has(id));
  // Dropping onto a row of the block itself puts it where it was: aim at the
  // first row after it that is not moving.
  let anchor = beforeId;
  if (anchor && movingSet.has(anchor)) {
    const from = peers.indexOf(anchor);
    anchor = peers.slice(from).find((id) => !movingSet.has(id)) ?? null;
  }
  const at = anchor === null ? rest.length : rest.indexOf(anchor);
  if (at < 0) return null;
  const next = [...rest.slice(0, at), ...block, ...rest.slice(at)];
  return next.every((id, i) => id === peers[i]) ? null : next;
}

/** One step up (-1) or down (+1) among peers, or null at either end. */
export function stepPeers(peers: readonly string[], id: string, dir: -1 | 1): string[] | null {
  const i = peers.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= peers.length) return null;
  const next = [...peers];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/**
 * The `order` each id in `sequence` takes so that sorting by `order` draws
 * them in that sequence — only the ids whose number changes.
 *
 * The numbers they already hold are reused, smallest first, so the block keeps
 * its place among items this list does not show (another day's rows, filtered
 * ones). Ties are pulled apart upwards: habits and agent-made tasks often all
 * sit at 0 (or have none) until the first reorder.
 */
export function ordersFor(
  sequence: readonly string[],
  current: ReadonlyMap<string, number | undefined>
): Map<string, number> {
  // A missing order sorts last, so it takes the next number up.
  const values = sequence
    .map((id) => current.get(id) ?? Number.POSITIVE_INFINITY)
    .sort((a, b) => a - b);
  for (let i = 0; i < values.length; i++) {
    const floor = i === 0 ? 0 : values[i - 1] + 1;
    if (!Number.isFinite(values[i]) || (i > 0 && values[i] < floor)) values[i] = floor;
  }
  const changed = new Map<string, number>();
  sequence.forEach((id, i) => {
    if (current.get(id) !== values[i]) changed.set(id, values[i]);
  });
  return changed;
}
