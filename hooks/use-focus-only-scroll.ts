'use client';

import { useEffect, type RefObject } from 'react';

/**
 * Lets focus scroll a clipping box sideways to show what it focused, and puts
 * the box back at rest once focus moves to something that shows there, other
 * than along the row the box slid for, or out to the rest of the shell, or to
 * nothing.
 *
 * Written for DesktopShell's <main>. With the item panel docked, <main> can be
 * narrower than the canvas header's row, and the row's right end is clipped:
 * Zen and the Display shelf's reset ✕ up to about 1286px windows at the
 * default sidebar, WeekScale's controls up to about 1488px, the Display
 * trigger up to about 1245px, and with a wide sidebar the Display trigger even
 * at 1440. <main> is overflow-hidden, and a hidden box has no scrollbar but is
 * still a scroll container, so Tab onto a clipped control scrolls it into
 * view, as it must: a keyboard user has to see where focus is. What was
 * missing is the way back. Nothing else scrolls the box, so the canvas stayed
 * slid left until the panel closed, unless focus happened to reveal something
 * at the other end. `overflow-clip` was tried and is worse: a clip box never
 * scrolls, so the same Tab lands on a control nobody can see, one of them the
 * reset ✕, which clears every canvas Display setting.
 *
 * So a frame after focus moves anywhere, a key goes down in the box, the box
 * scrolls or resizes, or what the focused control paints starts or stops
 * showing whole or at all, the box is placed for whatever has focus: at rest if
 * it shows there, unless it holds (below), and otherwise moved only when it has
 * to be, because Radix closes a tooltip on any scroll around its trigger, and a
 * tooltip is the only name Zen and the shelf's ✕s show. One out of sight, or
 * showing a pixel or less, comes in to the least slide that shows it whole. So
 * does whatever has focus when the box's width changes (the item panel docks a
 * frame at a time), and a control the layout moves (the shelf refitting, a view
 * switched under it) once the move leaves it cut. Otherwise one that shows,
 * whole or cut part-way, keeps the slide the hook last made, as the browser
 * would leave it, and the tooltip focus opened stays up, unless the slide was
 * made for a layout that is gone (below). A slide the hook did not make comes
 * back as far as that least one: the browser centres what it reveals (Zen slid
 * Week 212px at 1240, where 47 shows it).
 *
 * A key moving focus along the row the box slid for keeps the slide too, for a
 * control that shows whole there, even where it would show at rest, for as long
 * as it keeps focus and shows whole. A row is a child of the box, and the one
 * that slides is the canvas header's. So Tab from Zen across the Display shelf
 * moves nothing while each of its ✕s shows whole at Zen's slide: they show at
 * rest, and going there would close each one's tooltip, and then bring the
 * reset ✕, out of sight at rest, back in and close its tooltip too. Focus
 * moving into another row, the schedule's, puts the box back at rest, and focus
 * a pointer moves, or a menu hands on, gets the rules above; focus a menu hands
 * back to the control it opened from finds what that control had, as a hold
 * does. Like the hold below, what the row keeps can be more than the control
 * needs: Shift+Tab back from the reset ✕ keeps the ✕'s slide across the header
 * for as long as each control shows whole at it, even the date's controls,
 * which show at rest.
 *
 * One the layout moves while it still shows whole at a slide the hook made
 * holds that slide for as long as it keeps focus and shows whole, even where it
 * would show at rest, so a key that moves it (Next paging the date, an arrow on
 * WeekScale's thumb) moves the canvas only when it has to. By then the slide it
 * holds can be more than it needs. A click on a button holds nothing: a button
 * the click moves (Next) is placed afresh. Where the slide was made for it,
 * that keeps it at the box's edge, under the pointer for the next click; where
 * the row only kept the slide and it shows at rest, the box goes back to rest,
 * and the canvas moves under the pointer by that slide. WeekScale's thumb is
 * not a button, and still holds when a pointer moves it.
 *
 * A slide made for a layout that is gone places afresh a control focus comes to
 * that it cuts. Focus moving on from a held slide finds one, held for the
 * control focus left. So does focus coming to a control the layout has moved
 * since the hook made the slide: switching the view from its menu, or by a key
 * with focus on a pill the switch leaves in place, moves Zen, and the slide the
 * row kept for the pill would cut it. The hook notes where each control of the
 * row sat when it made its slide, and one that has not moved since keeps the
 * slide, cut part-way, as the browser would leave it.
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
 * turned back, the box stays slid until focus moves or the box scrolls or
 * resizes, since a key on nothing never reaches it. (The box's own inert,
 * under the overlaid item panel, is not one.) And at rest with nothing past
 * either edge there is nothing to do, which is almost always. Nothing is noted
 * there but the box's width, so a control the layout moved back to a spot cut
 * part-way after a spell at rest would stay as the browser leaves it; nothing
 * in the shell does that today.
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
    // Where each control of the row sat at rest when the hook last made the
    // box's slide, rather than keeping one. A control found since in another
    // place was moved by a layout the slide was not made for.
    let sat: Map<Element, Span> | null = null;
    // Whether the element last placed for holds its slide: the layout moved it,
    // other than a button under a click, and it still showed whole. It holds
    // for as long as it keeps focus and keeps showing whole, and never holds a
    // slide something else made.
    let held = false;
    // Whether the element last placed for keeps a slide made for another
    // control in its row (the child of the box it sits in, noted in `row`):
    // focus came to it along that row by a key, not a pointer or a menu, and
    // it showed whole at the slide. It keeps it for as long as it keeps focus,
    // or gets it back from a layer, and keeps showing whole there, and the
    // slide is still the one the hook last placed (which can be one something
    // else made and the hook left, short of the least slide).
    let along = false;
    let row: Element | null = null;
    // Whether a pointer went down or came up since the last key went down in
    // the box.
    let clicked = false;
    const down = new Set<number>();
    const settle = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        const focused = document.activeElement;
        const inside = focused && box.contains(focused) ? focused : null;
        watch(inside);
        // Focus that comes back from a layer, or from nothing, to another
        // control comes along no row; back to the control it left, it finds
        // what that control had, as a hold does.
        if (!inside) row = null;
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
        let at: Element | null = null;
        if (inside) {
          span = measure(box, inside);
          if (span) {
            at = rowOf(box, inside);
            const widthChanged = box.clientWidth !== width;
            const shifted = last?.el === inside && !same(last, span);
            const moved = box.scrollLeft !== placed;
            const shown = whole(span, box.scrollLeft, box.clientWidth);
            // A button a click moves is placed afresh (a slider thumb is not
            // one, and holds).
            const pressed = clicked && inside instanceof HTMLButtonElement;
            // Focus moving on finds a slide made for a layout that is gone when
            // it was held for the control focus left, or when the layout has
            // moved the control focus came to since the slide was made.
            const was = sat?.get(inside);
            const gone =
              last !== null && last.el !== inside && (held || (was !== undefined && !same(was, span)));
            if (last?.el !== inside) {
              held = false;
              // `last !== null` only matters for a focused box, whose row is null.
              along = !clicked && last !== null && at === row;
            }
            if (shifted) {
              held = shown && !pressed;
              along = false;
            }
            along = along && shown && !widthChanged && !moved;
            const holds = held && shown && !widthChanged && !moved;
            const how = widthChanged || shifted || (gone && !shown) ? 'fresh' : moved ? 'moved' : 'kept';
            x = holds || along ? box.scrollLeft : place(span, box.scrollLeft, box.clientWidth, how);
            // A slide made here, for this control: note where its row sits.
            if (x !== 0 && !holds && !along && (how !== 'kept' || x !== box.scrollLeft)) {
              sat = controls(box, at);
            }
          }
        } else if (focused && focused !== document.body && !box.parentElement?.contains(focused)) {
          return;
        }
        if (x === 0) sat = null;
        if (box.scrollLeft !== x) box.scrollLeft = x;
        placed = box.scrollLeft;
        width = box.clientWidth;
        last = span;
        row = at;
      });
    };
    // Something can move the focused control with no event of its own: the
    // shelf refitting a frame after the box resized, a view switched from a
    // store, a season line appearing ahead of the review notice. So the
    // observer watches the control and its children, which a control squeezed
    // below its content paints past its box (measure()), and hears any of them
    // start or stop showing whole, or at all. Its root reaches a pixel past the
    // box's left and right edges, so what a slide shows whole to within a
    // fraction (the end of a squeezed control's paint, from a whole-pixel
    // scrollWidth, or the half pixel a control at rest may overhang) counts as
    // whole, and a later cut is heard. A cut of a pixel or less is not, nor a
    // move from cut to cut; those are placed at the next key, focus move,
    // scroll or resize.
    const seen = new IntersectionObserver(settle, { root: box, rootMargin: '0px 1px', threshold: [0, 1] });
    let watched: Element | null = null;
    let parts: Element[] = [];
    // Observing an element always reports it once, so each focus move settles
    // twice and the second finds nothing to do. Skipping that report would
    // also lose a move made before the observer first looked.
    const watch = (el: Element | null) => {
      if (el === watched) return;
      if (watched) seen.unobserve(watched);
      parts.forEach((part) => seen.unobserve(part));
      watched = el;
      parts = el ? Array.from(el.children) : [];
      if (el) seen.observe(el);
      parts.forEach((part) => seen.observe(part));
    };
    const press = (e: PointerEvent) => {
      down.add(e.pointerId);
      clicked = true;
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
  // paints its icon and "Start" past it, and the season line's to nothing and
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

/** The child of `box` that holds `el`: its row, such as the canvas header's. */
function rowOf(box: Element, el: Element) {
  let p: Element | null = el;
  while (p && p.parentElement !== box) p = p.parentElement;
  return p;
}

/** What focus can land on in a row. */
const CONTROLS = 'a[href], button, input, select, textarea, [tabindex]';

/** Where each control of `row` sits in `box` at rest. */
function controls(box: HTMLElement, row: Element | null) {
  const spans = new Map<Element, Span>();
  row?.querySelectorAll(CONTROLS).forEach((el) => {
    const span = measure(box, el);
    if (span) spans.set(el, span);
  });
  return spans;
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
 * counts as showing at rest, but a slide is rounded up to show it whole to the
 * last fraction of a pixel it measures, so the observer hears a later move
 * that cuts it. `how` says what happened since the hook last placed the box:
 * nothing (`kept`), something else scrolled it (`moved`), or its width or the
 * element's place changed, or focus came to it at a slide made for a layout
 * that is gone and that cuts it (`fresh`).
 */
function place({ from, to }: Span, x: number, width: number, how: 'kept' | 'moved' | 'fresh') {
  const over = to - width;
  const least = to - from > width ? Math.max(0, Math.floor(from)) : over <= 0.5 ? 0 : Math.ceil(over);
  if (least === 0) return 0;
  // Placed afresh, or out of sight where the box is now: bring it in. A pixel
  // or less showing counts as out of sight, because a least slide, rounded up
  // to show its control whole, can show up to a pixel of the control after it.
  if (how === 'fresh' || to - x <= 1 || from - x >= width - 1) return least;
  return how === 'moved' ? Math.min(x, least) : x;
}
