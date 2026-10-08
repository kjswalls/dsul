'use client';

import { useCallback, useLayoutEffect, useRef } from 'react';
import { MOD_CLICK_SETTLE_MS } from '@/lib/mods/limits';

/** Where an element sits in the page's layout, scrolling aside. */
function layoutBox(el: HTMLElement | null): string {
  if (!el) return '';
  let x = 0;
  let y = 0;
  for (let n: HTMLElement | null = el; n; n = n.offsetParent as HTMLElement | null) {
    x += n.offsetLeft;
    y += n.offsetTop;
  }
  return `${x},${y},${el.offsetWidth},${el.offsetHeight}`;
}

/**
 * Counts a press on a mod panel's control only as the person saw it
 * (memory/plans/mods.md, build order 9): the tree's seq at pointerdown or
 * keydown must still be the current one when the press lands, and the control
 * must have looked the same, at the same place, for MOD_CLICK_SETTLE_MS.
 *
 * `look` is everything the person reads off the control plus its index path,
 * so a reorder or a node inserted above restarts the clock even though React
 * keeps the instance. The layout box is checked at every redraw and again at
 * the press, which catches a shift no redraw of this control saw. A press
 * that fails is ignored without a word: the newer tree is already showing.
 */
export function useSettledPress<T extends HTMLElement>(seq: number, look: string) {
  const ref = useRef<T>(null);
  const shownAt = useRef(0);
  const shown = useRef<{ look: string; box: string } | null>(null);
  const seqNow = useRef(seq);
  const seqAtPress = useRef<number | null>(null);

  /** Restarts the clock when the control looks or sits anywhere new. */
  const check = useCallback((lookNow: string) => {
    const box = layoutBox(ref.current);
    const before = shown.current;
    if (!before || before.look !== lookNow || before.box !== box) shownAt.current = Date.now();
    shown.current = { look: lookNow, box };
  }, []);

  useLayoutEffect(() => {
    seqNow.current = seq;
    check(look);
  }, [check, seq, look]);

  /** The pointerdown or keydown that starts a press. */
  const press = useCallback(() => {
    check(look);
    seqAtPress.current = seqNow.current;
  }, [check, look]);

  /** Whether the press now landing counts. Spends the press either way. */
  const take = useCallback((): boolean => {
    const pressed = seqAtPress.current;
    seqAtPress.current = null;
    return pressed === seqNow.current && Date.now() - shownAt.current >= MOD_CLICK_SETTLE_MS;
  }, []);

  /** The tree's seq as of the last redraw. */
  const currentSeq = useCallback(() => seqNow.current, []);

  return { ref, press, take, currentSeq };
}
