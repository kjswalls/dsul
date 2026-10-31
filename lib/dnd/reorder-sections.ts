import { movePeers, type PeerKind } from '../reorder';
import type { ReorderTarget } from '../drag-store';
import type { DragInput } from './sensors';

/**
 * The lists that can be reordered by drag, as mounted right now, and the hit
 * test a drag asks on every move.
 *
 * Not droppables. A reorder is decided by where the pointer is among the row's
 * own peers, read off the DOM, and only ever inside the section the row is
 * already in — so it never competes with the drop grammar in CONTRACT.md for
 * the pointer. A drop that reorders is one that would otherwise have landed the
 * row where it already is (its own day, bucket or braindump).
 */

interface Section {
  el: HTMLElement;
  peers: Record<PeerKind, string[]>;
}

const sections = new Map<string, Section>();

/**
 * How far left of a section the pointer still counts as inside it. The row's
 * grip (components/primitives/task-row.tsx) sits in the gutter left of the
 * rows, so a drag started on the grip begins outside the section's box, and
 * without this it could never land a reorder. Left only: on the right is the
 * Ask rail, and a row dragged there is not being put in order.
 */
const GRIP_GUTTER_PX = 24;

export function registerReorderSection(id: string, section: Section): () => void {
  sections.set(id, section);
  return () => {
    if (sections.get(id) === section) sections.delete(id);
  };
}

function rowIn(el: HTMLElement, id: string): HTMLElement | null {
  return el.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`);
}

/**
 * What releasing here would do as a reorder, or null.
 *
 * `moving` is the dragged row, or the selection it belongs to; a selection
 * reorders as a block only when every selected row is a peer in this section
 * (otherwise the drag is a group MOVE, as before). A finger never reorders:
 * on a phone long press is a move, and Move up / Move down are in the row's
 * menu (Kirby, 2026-10-24).
 */
export function reorderTargetAt(
  activeId: string,
  moving: readonly string[],
  point: { x: number; y: number },
  input: DragInput | null
): ReorderTarget | null {
  if (input === 'touch') return null;
  for (const [sectionId, { el, peers }] of sections) {
    const list = peers.task.includes(activeId) ? peers.task : peers.habit.includes(activeId) ? peers.habit : null;
    if (!list) continue;
    if (!moving.every((id) => list.includes(id))) return null;
    const box = el.getBoundingClientRect();
    if (point.x < box.left - GRIP_GUTTER_PX || point.x > box.right || point.y < box.top || point.y > box.bottom) continue;

    // The moving rows are left out of the hit test: the one being dragged may
    // be riding the pointer, and its own midpoint means nothing.
    const movingSet = new Set(moving);
    const rows = list
      .filter((id) => !movingSet.has(id))
      .map((id) => ({ id, el: rowIn(el, id) }))
      .filter((r): r is { id: string; el: HTMLElement } => !!r.el);
    if (rows.length === 0) return null;
    const before = rows.find((r) => {
      const b = r.el.getBoundingClientRect();
      return point.y < b.top + b.height / 2;
    });
    const sequence = movePeers(list, moving, before?.id ?? null);
    if (!sequence) return null;
    const edge = before ? before.el.getBoundingClientRect().top : rows[rows.length - 1].el.getBoundingClientRect().bottom;
    return { sectionId, sequence, lineY: edge - box.top };
  }
  return null;
}
