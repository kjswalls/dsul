'use client';

import { useEffect, type RefObject } from 'react';

/**
 * Lets focus scroll a clipping box sideways to show what it focused, and puts
 * the box back at rest as soon as nothing focused needs that.
 *
 * Written for DesktopShell's <main>. With the item panel docked, <main> can be
 * narrower than the canvas header's row, and the row's right end is clipped:
 * Zen and the Display shelf's ✕ up to about 1286px windows at the default
 * sidebar, WeekScale's controls up to about 1488px, the Display trigger up to
 * about 1245px, and with a wide sidebar the Display trigger even at 1440.
 * <main> is overflow-hidden, and a hidden box has no scrollbar but is still a
 * scroll container, so Tab onto a clipped control scrolls it into view, as it
 * must: a keyboard user has to see where focus is. What was missing is the way
 * back. Nothing else scrolls the box, so the canvas stayed slid left until the
 * panel closed, unless focus happened to reveal something at the other end.
 * `overflow-clip` was tried and is worse: a clip box never scrolls, so the
 * same Tab lands on a control nobody can see, one of them the ✕, which resets
 * every canvas Display setting.
 *
 * So a frame after focus moves anywhere, a key goes down in the box, the box
 * scrolls or resizes, or the focused control starts or stops showing whole or
 * at all, the box is placed for whatever has focus: at rest if it shows there,
 * and otherwise moved only when it has to be, because Radix closes a tooltip
 * on any scroll around its trigger, and a tooltip is the only name Zen and the
 * ✕ show. One wholly out of sight comes in to the least slide that shows it
 * whole. So does whatever has focus when the box's width changes (the item
 * panel docks a frame at a time), and a control the layout moves (the shelf
 * refitting, a view switched under it) once the move leaves it cut. One that
 * still shows whole at a slide the hook made holds that slide, for as long as
 * it keeps focus and shows whole, so a key that moves it (Next paging the
 * date, an arrow on WeekScale's thumb) moves the canvas only when it has to.
 * Otherwise one that shows, whole or cut part-way, keeps the slide the hook
 * last made, as the browser would leave it, so Tab from Zen to the ✕ moves
 * nothing and the ✕'s tooltip stays up (memory/plans/display-menu.md lists
 * the few window widths where it cannot). A slide the hook did not make comes
 * back as far as that least one: the browser centres what it reveals (Zen
 * slid Week 212px at 1240, where 46 shows it).
 *
 * Three holds. While a pointer is down nothing moves: a press moves focus, and
 * sliding the box before the release moves what was pressed out from under
 * the pointer, so the click lands elsewhere or nowhere and a drag runs offset
 * from its block. The release settles it. While focus is outside both the box
 * and its parent (the shell's columns), it is in a layer over the page, a
 * menu, popover or dialog, most often drawn against a control in the box, and
 * sliding the box would leave that menu pointing at a control out of view. And
 * at rest with nothing past either edge there is nothing to do, which is
 * almost always.
 */
export function useFocusOnlyScroll(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const box = ref.current;
    // jsdom has neither observer, and a suite can mount the shell without them.
    if (!box || typeof IntersectionObserver === 'undefined' || typeof ResizeObserver === 'undefined') {
      return;
    }
    let frame = 0;
    // How the hook last left the box: its slide, its width, and where the
    // focused element sat at rest. Something else has moved what differs.
    let placed = box.scrollLeft;
    let width = box.clientWidth;
    let last: Span | null = null;
    // Whether the element last placed for holds its slide: the layout moved it
    // while it showed whole. It holds for as long as it keeps focus and keeps
    // showing whole, and never holds a slide something else made.
    let held = false;
    const down = new Set<number>();
    const settle = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        const focused = document.activeElement;
        const inside = focused && box.contains(focused) ? focused : null;
        watch(inside);
        if (down.size > 0) return;
        if (box.scrollLeft === 0 && box.scrollWidth <= box.clientWidth) {
          width = box.clientWidth;
          return;
        }
        let x = 0;
        let span: Span | null = null;
        if (inside) {
          span = measure(box, inside);
          if (span) {
            const widthChanged = box.clientWidth !== width;
            const shifted = last?.el === inside && !same(last, span);
            const moved = box.scrollLeft !== placed;
            const shown = whole(span, box.scrollLeft, box.clientWidth);
            if (last?.el !== inside) held = false;
            if (shifted) held = shown;
            x =
              held && shown && !widthChanged && !moved
                ? box.scrollLeft
                : place(
                    span,
                    box.scrollLeft,
                    box.clientWidth,
                    widthChanged || shifted ? 'fresh' : moved ? 'moved' : 'kept'
                  );
          }
        } else if (focused && focused !== document.body && !box.parentElement?.contains(focused)) {
          return;
        }
        if (box.scrollLeft !== x) box.scrollLeft = x;
        placed = box.scrollLeft;
        width = box.clientWidth;
        last = span;
      });
    };
    // Something can move the focused control with no event of its own: the
    // shelf refitting a frame after the box resized, a view switched from a
    // store. When that makes it start or stop showing whole, or at all, it is
    // heard here. A move that leaves it cut part-way is not, and is placed at
    // the next key, focus move, scroll or resize.
    const seen = new IntersectionObserver(settle, { root: box, threshold: [0, 1] });
    let watched: Element | null = null;
    // Observing an element always reports it once, so each focus move settles
    // twice and the second finds nothing to do. Skipping that report would
    // also lose a move made before the observer first looked.
    const watch = (el: Element | null) => {
      if (el === watched) return;
      if (watched) seen.unobserve(watched);
      watched = el;
      if (el) seen.observe(el);
    };
    const press = (e: PointerEvent) => {
      down.add(e.pointerId);
    };
    const release = (e: PointerEvent) => {
      down.delete(e.pointerId);
      settle();
    };
    // A release can go unheard: outside the window, or taken by a native
    // context menu, which opens on the press on macOS and Linux. Losing the
    // window or opening that menu ends the press.
    const reset = () => {
      down.clear();
      settle();
    };
    const resized = new ResizeObserver(settle);
    resized.observe(box);
    document.addEventListener('focusin', settle);
    document.addEventListener('focusout', settle);
    box.addEventListener('keydown', settle, true);
    box.addEventListener('scroll', settle);
    window.addEventListener('pointerdown', press, true);
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    window.addEventListener('blur', reset);
    window.addEventListener('contextmenu', reset, true);
    return () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      seen.disconnect();
      document.removeEventListener('focusin', settle);
      document.removeEventListener('focusout', settle);
      box.removeEventListener('keydown', settle, true);
      box.removeEventListener('scroll', settle);
      window.removeEventListener('pointerdown', press, true);
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      window.removeEventListener('blur', reset);
      window.removeEventListener('contextmenu', reset, true);
    };
  }, [ref]);
}

/** A focused element's span in the box at rest, from the box's inner left edge. */
type Span = { el: Element; from: number; to: number };

const CLIPS = /^(hidden|clip|auto|scroll)$/;

/**
 * Where what shows of `el` sits in `box` at rest: its box clipped by every
 * clipping ancestor below `box`, because the schedule's full-width headings
 * run past their own scroll viewport, and it is the viewport, not `box`, that
 * cuts them. Null when something inside `box` clips all of it, which no slide
 * of `box` can help.
 */
function measure(box: HTMLElement, el: Element): Span | null {
  const r = el.getBoundingClientRect();
  let left = r.left;
  // A box squeezed to nothing still paints what overflows it, and its focus
  // ring: the program line's button, with the item panel docked, keeps its
  // icon. Measure that, so a slide can show it.
  let right = r.width > 0 ? r.right : r.left + Math.max(1, el.scrollWidth);
  for (let p = el.parentElement; p && p !== box; p = p.parentElement) {
    if (!CLIPS.test(getComputedStyle(p).overflowX)) continue;
    const c = p.getBoundingClientRect();
    left = Math.max(left, c.left);
    right = Math.min(right, c.right);
  }
  if (right <= left) return null;
  const shift = box.scrollLeft - box.getBoundingClientRect().left - box.clientLeft;
  return { el, from: left + shift, to: right + shift };
}

/** The same span to within half a pixel, past any rounding in the layout. */
function same(a: Span, b: Span) {
  return Math.abs(a.from - b.from) <= 0.5 && Math.abs(a.to - b.to) <= 0.5;
}

/** Whether all of `span` shows from slide `x` in a box `width` wide, to within half a pixel. */
function whole({ from, to }: Span, x: number, width: number) {
  return from - x >= -0.5 && to - x <= width + 0.5;
}

/**
 * Where the box goes for `span`, from slide `x` in a box `width` wide. Its
 * least slide shows it whole, or for one wider than the box, puts its start at
 * the box's edge; 0 means it shows at rest. `how` says what happened since the
 * hook last placed the box: nothing (`kept`), something else scrolled it
 * (`moved`), or its width or the element's place changed (`fresh`).
 */
function place({ from, to }: Span, x: number, width: number, how: 'kept' | 'moved' | 'fresh') {
  const least =
    to - from > width ? Math.max(0, Math.floor(from)) : Math.max(0, Math.ceil(to - width - 0.5));
  if (least === 0) return 0;
  // Placed afresh, or wholly out of sight where the box is now: bring it in.
  if (how === 'fresh' || to - x <= 0.5 || from - x >= width - 0.5) return least;
  return how === 'moved' ? Math.min(x, least) : x;
}
