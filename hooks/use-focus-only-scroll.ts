'use client';

import { useEffect, type RefObject } from 'react';

/**
 * Lets focus scroll a clipping box sideways to show what it focused, and puts
 * the box back at rest once focus moves to something that shows there, or out
 * to the rest of the shell, or to nothing.
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
 * scrolls or resizes, or the focused control starts or stops showing entirely
 * or at all, the box is placed for whatever has focus: at rest if it shows
 * there, unless it holds (below), and otherwise moved only when it has to be,
 * because Radix closes a tooltip on any scroll around its trigger, and a
 * tooltip is the only name Zen and the ✕ show. One wholly out of sight comes
 * in to the least slide that shows it whole. So does whatever has focus when
 * the box's width changes (the item panel docks a frame at a time), and a
 * control the layout moves (the shelf refitting, a view switched under it)
 * once the move leaves it cut. Otherwise one that shows, whole or cut
 * part-way, keeps the slide the hook last made, as the browser would leave it,
 * so Tab from Zen to the ✕ moves nothing and the ✕'s tooltip stays up
 * (memory/plans/display-menu.md lists the few window widths where it cannot).
 * A slide the hook did not make comes back as far as that least one: the
 * browser centres what it reveals (Zen slid Week 212px at 1240, where 47
 * shows it).
 *
 * One the layout moves while it still shows whole at a slide the hook made
 * holds that slide for as long as it keeps focus and shows whole, even where
 * it would show at rest, so a key that moves it (Next paging the date, an
 * arrow on WeekScale's thumb) moves the canvas only when it has to. By then
 * the slide it holds can be more than it needs. A click holds nothing: a
 * button the click moves (Next) is placed afresh, which keeps it at the box's
 * edge, under the pointer for the next click. And focus moving on from a held
 * slide places the next control afresh if that slide cuts it, because the
 * slide was held for the control focus left.
 *
 * Four more holds, whatever has focus. While a pointer is down nothing moves:
 * a press moves focus, and sliding the box before the release moves what was
 * pressed out from under the pointer, so the click lands elsewhere or nowhere
 * and a drag runs offset from its block. The release settles it. While focus
 * is outside both the box and its parent (the shell's columns), it is in a
 * layer over the page, a menu, popover or dialog, most often drawn against a
 * control in the box, and sliding the box would leave that menu pointing at a
 * control out of view. While an ancestor of the box is inert, which only Zen's
 * switch does as it lifts the planner away, focus drops to nothing, and going
 * to rest would jump the planner sideways under the wave; if the switch is
 * turned back, the box stays slid until the next key, focus move, scroll or
 * resize. (The box's own inert, under the overlaid item panel, is not one.)
 * And at rest with nothing past either edge there is nothing to do, which is
 * almost always. Nothing is noted there but the box's width, so a control the
 * layout moved back to a spot cut part-way after a spell at rest would stay
 * as the browser leaves it; nothing in the shell does that today.
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
    // Whether the element last placed for holds its slide: the layout moved it,
    // other than a button under a click, and it still showed whole. It holds
    // for as long as it keeps focus and keeps showing whole, and never holds a
    // slide something else made.
    let held = false;
    // Whether a pointer came up since the last key went down in the box.
    let clicked = false;
    const down = new Set<number>();
    const settle = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        const focused = document.activeElement;
        const inside = focused && box.contains(focused) ? focused : null;
        watch(inside);
        if (down.size > 0) return;
        // <main> itself goes inert under the overlaid item panel; an ancestor
        // only while Zen's switch lifts the planner away.
        if (box.parentElement?.closest('[inert]')) return;
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
            // A button a click moves is placed afresh, which keeps it at the
            // box's edge, under the pointer for the next click.
            const pressed = clicked && inside instanceof HTMLButtonElement;
            // Focus moving on from a held slide finds a slide nothing asked for.
            const fromHeld = held && last !== null && last.el !== inside;
            if (last?.el !== inside) held = false;
            if (shifted) held = shown && !pressed;
            x =
              held && shown && !widthChanged && !moved
                ? box.scrollLeft
                : place(
                    span,
                    box.scrollLeft,
                    box.clientWidth,
                    widthChanged || shifted || (fromHeld && !shown) ? 'fresh' : moved ? 'moved' : 'kept'
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
    // store. The thresholds are exact, so this hears the control start or stop
    // showing entirely, with none of whole()'s half-pixel allowance, or at all.
    // A move from cut to cut is not heard, including one from the half pixel a
    // control at rest may overhang, and is placed at the next key, focus move,
    // scroll or resize.
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
      clicked = true;
      settle();
    };
    const key = () => {
      clicked = false;
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
    box.addEventListener('keydown', key, true);
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
      box.removeEventListener('keydown', key, true);
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
  // A box squeezed below its content still paints what overflows it, unless it
  // clips it, and a box squeezed to nothing still paints its focus ring. With
  // the item panel docked the review notice's button shrinks to its padding and
  // paints its icon and "Start" past it, and the program line's to nothing and
  // paints its icon. Measure what they paint, so a slide can show it.
  // scrollWidth is whole pixels, hence the rounded-up box; it is also taken
  // before transforms, and nothing in the shell has one.
  const paints = CLIPS.test(getComputedStyle(el).overflowX) ? 0 : el.scrollWidth;
  let right = paints > Math.ceil(r.width) ? r.left + paints : r.width > 0 ? r.right : r.left + 1;
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
 * the box's edge; 0 means it shows at rest. Half a pixel past the edge still
 * counts as showing at rest, but a slide shows it whole to the last fraction of
 * a pixel, so the observer, which measures exactly, hears it when a later move
 * cuts it. `how` says what happened since the hook last placed the box: nothing
 * (`kept`), something else scrolled it (`moved`), or its width or the
 * element's place changed, or focus came to it from a held slide that cuts it
 * (`fresh`).
 */
function place({ from, to }: Span, x: number, width: number, how: 'kept' | 'moved' | 'fresh') {
  const over = to - width;
  const least = to - from > width ? Math.max(0, Math.floor(from)) : over <= 0.5 ? 0 : Math.ceil(over);
  if (least === 0) return 0;
  // Placed afresh, or wholly out of sight where the box is now: bring it in.
  if (how === 'fresh' || to - x <= 0.5 || from - x >= width - 0.5) return least;
  return how === 'moved' ? Math.min(x, least) : x;
}
