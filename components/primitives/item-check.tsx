/**
 * The item checkbox's tick and its motion — one drawing for every surface that
 * ticks an item (planner rows, the item rail, Do stuff, routines, subtasks,
 * milestones, morning triage). The box itself stays each surface's own button;
 * these are the parts that must read identically everywhere.
 *
 * A ticked box is a raised card (`bg-check-fill shadow-check`: white paper
 * lifted by a soft shadow in light, a lighter graphite tile with a lit top edge
 * in dark) with a fine tick in the accent (`text-check-tick`). Its ring is the
 * fill's own colour, so it reads as no outline. A multi-count habit's progress
 * rises in `bg-check-part`, its ring in that colour too, so the outline runs
 * all the way round the part-filled box. The lime lives only in the tick, at
 * full strength.
 *
 * The box draws its edge with an inset ring, never a border: a border insets
 * the padding box by 1px, so a multi-count habit's rising fill stopped short of
 * the edge and left the corners empty. With the ring, the fill (painted above
 * the ring) runs to the box's own rounded edge.
 *
 * The motion (rules in app/globals.css, under "The item tick") runs only when
 * the user ticks or un-ticks something here: animateItemCheck() marks the box,
 * and the tick draws in, or erases back along its path, only while that mark
 * is on. A tick that arrives or leaves any other way — on load, from another
 * device, on undo — simply appears or goes.
 */
import { cn } from '@/lib/utils';

export function ItemTick({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={cn('item-tick absolute inset-0 size-full text-check-tick', className)}
    >
      <path pathLength={1} d="M4.3 8.4 7 11.1 12 5.4" />
    </svg>
  );
}

const SETTLE = 'item-check-settle';
const UNSETTLE = 'item-check-unsettle';

/**
 * Call it from the click that toggles an item, before the state changes, with
 * whether the item is done now. Ticking: the box settles in from 88% with no
 * overshoot, and the tick that mounts meanwhile draws itself in. Un-ticking:
 * the surface unmounts its tick, so a copy of it stays behind on the box and
 * erases back along its own path while the box settles from 94% and eases out
 * of its fill and shadow.
 */
export function animateItemCheck(el: HTMLElement | null, wasDone = false) {
  if (!el || typeof window === 'undefined') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  el.removeAttribute('data-ticking');
  el.removeAttribute('data-unticking');
  el.querySelectorAll('.item-tick-ghost').forEach((g) => g.remove());
  // Restart the animation when presses come faster than it runs.
  void el.offsetWidth;
  if (wasDone) {
    const tick = el.querySelector('.item-tick');
    if (tick) {
      const ghost = tick.cloneNode(true) as SVGElement;
      ghost.classList.add('item-tick-ghost');
      ghost.addEventListener('animationend', () => ghost.remove(), { once: true });
      // A box hidden mid-erase never fires animationend.
      window.setTimeout(() => ghost.remove(), 600);
      el.appendChild(ghost);
    }
    el.setAttribute('data-unticking', '');
  } else {
    el.setAttribute('data-ticking', '');
  }
  const settle = (e: AnimationEvent) => {
    if (e.target !== el || (e.animationName !== SETTLE && e.animationName !== UNSETTLE)) return;
    el.removeAttribute('data-ticking');
    el.removeAttribute('data-unticking');
    el.removeEventListener('animationend', settle);
  };
  el.addEventListener('animationend', settle);
}
