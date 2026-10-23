/**
 * The item checkbox's tick and its spring — one drawing for every surface that
 * ticks an item (planner rows, the item rail, Do stuff, routines, subtasks,
 * milestones, morning triage). The box itself stays each surface's own button;
 * these are the parts that must read identically everywhere.
 *
 * The box draws its edge with an inset ring, never a border: a border insets
 * the padding box by 1px, so a multi-count habit's rising fill stopped short of
 * the edge and left the corners empty. With the ring, the fill (painted above
 * the ring) runs to the box's own rounded edge.
 *
 * The motion (rules in app/globals.css, under "The item tick") runs only when
 * the user ticks something here: springItemCheck() marks the box, and the tick
 * draws in only while that mark is on. A tick that arrives any other way — on
 * load, from another device, on undo — simply appears.
 */
import { cn } from '@/lib/utils';

export function ItemTick({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={cn('item-tick absolute inset-0 size-full text-primary-foreground', className)}
    >
      <path pathLength={1} d="M4.3 8.4 7 11.1 12 5.4" />
    </svg>
  );
}

const SPRING = 'item-check-spring';

/**
 * Press the box: it dips, springs past full size and settles, and a tick that
 * mounts meanwhile draws itself in. Call it from the click that moves an item
 * toward done (never from an un-tick), before the state changes.
 */
export function springItemCheck(el: HTMLElement | null) {
  if (!el || typeof window === 'undefined') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  el.removeAttribute('data-spring');
  // Restart the animation when presses come faster than it runs.
  void el.offsetWidth;
  el.setAttribute('data-spring', '');
  const settle = (e: AnimationEvent) => {
    if (e.target !== el || e.animationName !== SPRING) return;
    el.removeAttribute('data-spring');
    el.removeEventListener('animationend', settle);
  };
  el.addEventListener('animationend', settle);
}
