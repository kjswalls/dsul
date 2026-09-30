import { closestCenter, type ClientRect, type CollisionDetection } from '@dnd-kit/core';

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

/**
 * The list-day containment above, then `closestCenter`, minus the Week ×
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
export const plannerCollision: CollisionDetection = (args) => {
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
