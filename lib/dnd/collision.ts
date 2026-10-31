import { closestCenter, pointerWithin, type ClientRect, type CollisionDetection } from '@dnd-kit/core';

/**
 * A `list:{date}` target the POINTER is inside wins outright.
 *
 * The list targets are whole days — Day × List's body, each Week × List section
 * — so they are big, stacked and uneven. `closestCenter` compares centres, and
 * over a tall Monday under a short Sunday it hands the top of Monday to Sunday:
 * the centre-distance band CONTRACT.md measures for bucket cards, at the size of
 * a day. Containment has no such band, and a list day has nothing inside it to
 * separate (no per-row droppables), so the box the pointer is in is the answer.
 * Outside every list box (the gutter below the week, or the sidebar) this falls
 * through to the rules below unchanged.
 */
function listDayUnderPointer(args: Parameters<CollisionDetection>[0]) {
  const p = args.pointerCoordinates;
  if (!p) return null;
  for (const container of args.droppableContainers) {
    if (!String(container.id).startsWith('list:')) continue;
    const r = args.droppableRects.get(container.id);
    if (!r || !(p.x >= r.left && p.x <= r.left + r.width && p.y >= r.top && p.y <= r.top + r.height)) {
      continue;
    }
    // A day scrolled out of its list's viewport still has its full rect, and
    // the part of it under the header capsule is not a place anyone can see
    // they are dropping on.
    const port = container.node?.current?.closest?.('[data-slot="scroll-area-viewport"]');
    const v = port?.getBoundingClientRect();
    if (!v || (p.y >= v.top && p.y <= v.bottom && p.x >= v.left && p.x <= v.right)) {
      return [{ id: container.id, data: { droppableContainer: container, value: 0 } }];
    }
  }
  return null;
}

const inside = (p: { x: number; y: number }, r: { left: number; top: number; width: number; height: number }) =>
  p.x >= r.left && p.x <= r.left + r.width && p.y >= r.top && p.y <= r.top + r.height;

/**
 * Atlas: the card the POINTER is inside wins, and nothing else on the board does.
 *
 * Cards are big and sit anywhere on a pannable board, so `closestCenter` would
 * hand a drop in the gap between two cards to whichever centre was nearer, and
 * a drop on empty board to the braindump (the only other droppable mounted
 * while Atlas shows), which would send a row from a card back to the
 * braindump. So:
 *
 * - A card counts only while the pointer is inside its box AND inside the Atlas
 *   viewport (`[data-atlas-root]`, one at a time): a card panned under the
 *   header or off the edge still has its full rect, and that part is not a
 *   place anyone can see.
 * - The card must also be what the pointer is ON, asked of the DOM
 *   (`elementsFromPoint`, skipping the drag ghost): an expanded card over the
 *   one below goes to the one painted on top, and a card under the minimap or
 *   under the Ask or item overlay below 1180px is not a target at all, since
 *   nobody can see they are dropping on it. Without `elementsFromPoint`
 *   (jsdom), the last one mounted.
 * - Inside the viewport but on no card (between cards, the far zoom, an open
 *   focus sheet): no target. The drop springs back and the shell says why.
 *   Outside the viewport: `null`, and the rules below run with every `atlas:`
 *   id left out, so the braindump still takes its drops.
 */
function atlasCardUnderPointer(args: Parameters<CollisionDetection>[0]) {
  const p = args.pointerCoordinates;
  if (!p || typeof document === 'undefined') return null;
  const root = document.querySelector('[data-atlas-root]');
  if (!root || !inside(p, root.getBoundingClientRect())) return null;
  const hits: (typeof args.droppableContainers)[number][] = [];
  for (const container of args.droppableContainers) {
    if (!String(container.id).startsWith('atlas:')) continue;
    const r = args.droppableRects.get(container.id);
    if (r && inside(p, r)) hits.push(container);
  }
  if (hits.length === 0) return [];
  let pick: (typeof hits)[number] | undefined = hits[hits.length - 1];
  if (typeof document.elementsFromPoint === 'function') {
    const top = document
      .elementsFromPoint(p.x, p.y)
      .find((el) => !el.closest('[data-testid="drag-ghost"]'));
    const card = top?.closest('[data-atlas-card]');
    pick = card ? hits.find((c) => card.contains(c.node?.current ?? null)) : undefined;
    if (!pick) return [];
  }
  return [{ id: pick.id, data: { droppableContainer: pick, value: 0 } }];
}

/**
 * The Atlas card containment and the list-day containment above, then `closestCenter`, minus the Week ×
 * Schedule hour cells hidden under a pinned column head.
 *
 * The week columns pin their day header and Anytime strip while the hour grid
 * scrolls under them, but a scrolled-under cell is still a live droppable at its
 * real rect. Hour cells sit one hourPx apart right under the strip, so one of
 * them is nearly always closer to the pointer than the strip's own centre: a
 * drop aimed at Anytime would schedule the item at an hour nobody could see.
 * A cell whose centre is under any head is out of the running.
 *
 * The heads are read from the DOM (`data-week-head`) because the pin moves with
 * every scroll; off the week view there are none and this is closestCenter.
 */
export const plannerCollision: CollisionDetection = (input) => {
  const atlas = atlasCardUnderPointer(input);
  if (atlas) return atlas;
  // Atlas cards answer by containment only, never by a nearest centre.
  const args = input.droppableContainers.some((c) => String(c.id).startsWith('atlas:'))
    ? { ...input, droppableContainers: input.droppableContainers.filter((c) => !String(c.id).startsWith('atlas:')) }
    : input;
  // Atlas showing, pointer off the board: only a target the pointer is
  // actually inside (the braindump) may take the drop. With no distance
  // limit, closestCenter would hand a release over the header or the rail to
  // the braindump, which unschedules or pauses a card's row.
  if (typeof document !== 'undefined' && document.querySelector('[data-atlas-root]')) {
    if (pointerWithin(args).length === 0) return [];
  }
  const list = listDayUnderPointer(args);
  if (list) return list;
  if (typeof document === 'undefined') return closestCenter(args);
  const heads = Array.from(document.querySelectorAll<HTMLElement>('[data-week-head]'), (h) =>
    h.getBoundingClientRect()
  );
  if (heads.length === 0) return closestCenter(args);
  const hidden = (r: ClientRect) => {
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    return heads.some((h) => cx >= h.left && cx <= h.right && cy >= h.top && cy < h.bottom);
  };
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter((c) => {
      if (!String(c.id).startsWith('weekhour:')) return true;
      const r = args.droppableRects.get(c.id);
      return !r || !hidden(r);
    }),
  });
};
