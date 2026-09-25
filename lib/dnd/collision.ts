import { closestCenter, type ClientRect, type CollisionDetection } from '@dnd-kit/core';

/**
 * `closestCenter`, minus the Week × Schedule hour cells hidden under a pinned
 * column head.
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
