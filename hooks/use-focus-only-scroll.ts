'use client';

import { useEffect, type RefObject } from 'react';

/**
 * Lets focus scroll a clipping box sideways to show what it focused, and puts
 * the box back at rest as soon as nothing focused needs that.
 *
 * Written for DesktopShell's <main>. With the item panel docked, <main> can be
 * narrower than the canvas header's row, and the row's right end is clipped:
 * Zen and the Display shelf's ✕ at the default sidebar, WeekScale's controls up
 * to about 1486px windows, and even the Display trigger with a wide sidebar.
 * <main> is overflow-hidden, and a hidden box has no scrollbar but is still a
 * scroll container, so Tab onto a clipped control scrolls it into view, as it
 * must: a keyboard user has to see where focus is. What was missing is the way
 * back. Nothing else scrolls the box, so the whole canvas stayed slid left
 * until the panel closed. `overflow-clip` was tried and is worse: a clip box
 * never scrolls, so the same Tab lands on a control nobody can see, one of
 * them the ✕, which resets every Display setting.
 *
 * So a frame after any focus move or scroll inside the box (after the
 * browser's own focus scroll), the box goes where the element with focus
 * wants it: at rest if it shows there, else wherever it shows whole. Chromium
 * scrolls only for a control that is wholly hidden, so one cut part-way, at
 * the edge of those widths (the ✕ showed 19% of itself in Week at 1265px), is
 * scrolled the rest of the way here. One wider than the box stays where the
 * browser put it. While focus is outside both the box and its parent (the
 * shell's columns), it is in a menu or dialog opened over the canvas, and the
 * box stays put: the menu is anchored to a control in it, and Radix hands focus
 * back to that control with preventScroll, so it had better still be showing.
 */
export function useFocusOnlyScroll(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    let frame = 0;
    const settle = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        // Nothing runs past either edge: nothing to show, nothing to put back.
        if (box.scrollLeft === 0 && box.scrollWidth <= box.clientWidth) return;
        const focused = document.activeElement;
        let x = 0;
        if (focused && box.contains(focused)) {
          x = scrollToShow(box, focused);
        } else if (focused && focused !== document.body && !box.parentElement?.contains(focused)) {
          return;
        }
        if (box.scrollLeft !== x) box.scrollLeft = x;
      });
    };
    box.addEventListener('focusin', settle);
    box.addEventListener('focusout', settle);
    box.addEventListener('scroll', settle);
    return () => {
      cancelAnimationFrame(frame);
      box.removeEventListener('focusin', settle);
      box.removeEventListener('focusout', settle);
      box.removeEventListener('scroll', settle);
    };
  }, [ref]);
}

const CLIPS = /^(hidden|clip|auto|scroll)$/;

/**
 * The scrollLeft at which `box` shows `el`: 0 if it shows at rest, the one it
 * has if it shows whole there already, else the nearest that shows it whole.
 * What shows of `el` is its box clipped by every clipping ancestor below
 * `box`: the schedule's full-width headings run past their own scroll viewport,
 * and it is the viewport, not `box`, that cuts them.
 */
function scrollToShow(box: HTMLElement, el: Element) {
  const x = box.scrollLeft;
  let { left, right } = el.getBoundingClientRect();
  for (let p = el.parentElement; p && p !== box; p = p.parentElement) {
    if (!CLIPS.test(getComputedStyle(p).overflowX)) continue;
    const c = p.getBoundingClientRect();
    left = Math.max(left, c.left);
    right = Math.min(right, c.right);
  }
  // Hidden by something inside the box, which the box's scroll cannot help.
  if (right <= left) return 0;
  // Its span at rest, from the box's inner left edge.
  const origin = box.getBoundingClientRect().left + box.clientLeft;
  const from = left + x - origin;
  const to = right + x - origin;
  const width = box.clientWidth;
  if (from >= -0.5 && to <= width + 0.5) return 0;
  if (to - from > width) return x;
  if (from - x >= -0.5 && to - x <= width + 0.5) return x;
  return to - x > width ? Math.ceil(to - width) : Math.max(0, Math.floor(from));
}
