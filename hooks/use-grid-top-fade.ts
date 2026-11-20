'use client';

import { useEffect, type RefObject } from 'react';

/**
 * The schedule's top fade (Kirby's pick, 2026-11-20): once the hour grid has
 * slid under the top of the scroll port, the port's top edge fades over 24px
 * instead of cutting rows and blocks in half. Never at rest, and never over
 * the Anytime rows above the grid: it switches on only when the grid's own top
 * has reached the edge (or the pinned lane caption, `capPx`, when lanes show).
 *
 * It writes `data-grid-fade` and `--grid-fade-top` straight onto the ScrollArea's root,
 * never React state, so a scroll re-renders nothing. The look is the
 * `[data-grid-fade]` rule in app/globals.css.
 */
export function useGridTopFade(
  /** The ScrollArea's root, or anything inside it. */
  innerRef: RefObject<HTMLElement | null>,
  gridRef: RefObject<HTMLElement | null>,
  capPx: number,
  /** Changes when the grid remounts (the day view keys its content by date). */
  resetKey: string
) {
  useEffect(() => {
    const root = innerRef.current?.closest<HTMLElement>('[data-slot="scroll-area"]');
    const port = root?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!root || !port) return;
    root.style.setProperty('--grid-fade-top', `${capPx}px`);

    let frame = 0;
    const update = () => {
      frame = 0;
      const grid = gridRef.current;
      if (!grid) return;
      const on = grid.getBoundingClientRect().top < port.getBoundingClientRect().top + capPx - 1;
      if (on) root.setAttribute('data-grid-fade', '');
      else root.removeAttribute('data-grid-fade');
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    port.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      port.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      root.removeAttribute('data-grid-fade');
    };
  }, [innerRef, gridRef, capPx, resetKey]);
}
