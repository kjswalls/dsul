'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { usePlannerLoaded, usePlannerPreviewing } from '@/lib/planner-ready';
import { prefersReducedMotion } from '@/lib/zen-transition';
import { cn } from '@/lib/utils';

/** Held invisible this long (the CSS delay), so a warm load never flashes the line. */
export const SYNC_LINE_DELAY_MS = 300;
/** The done sweep's keyframes (app/globals.css). Its `animationend` is what unmounts a done line. */
export const SYNC_LINE_SWEEP = 'planner-sync-done';
/**
 * The backstop for a sweep that never reports its end (an ancestor with no box
 * plays no animation), counted from two frames after the landing — by when
 * the 400ms sweep has started.
 */
export const SYNC_LINE_DONE_MS = 420;

type SyncPhase = 'off' | 'syncing' | 'done';

interface SyncLineState {
  /** The `isPreview` this state was derived from — the edge detector. */
  previewing: boolean;
  phase: SyncPhase;
  /** performance.now() when this line started showing the preview. */
  shownAt: number;
}

const now = () => performance.now();

/**
 * What the line does as the preview ends. It completes ("done") only over a
 * real landing it was visibly up for; everything else ends it at once:
 *  - not loaded: a failed load, a crash drop (lib/planner-store.ts
 *    dropPreview) or an account change. Nothing synced, so nothing completes —
 *    the failure has its own Retry notice.
 *  - reduced motion (both vetoes): the sweep IS motion.
 *  - up for less than the delay: it never became visible, and a sweep would
 *    flash a line that was never seen.
 */
function landingPhase(loaded: boolean, shownAt: number): SyncPhase {
  if (!loaded || prefersReducedMotion()) return 'off';
  return now() - shownAt < SYNC_LINE_DELAY_MS ? 'off' : 'done';
}

/**
 * The look-only preview's steady signal: a neutral 2px hairline across the
 * top of the canvas while this browser's copy of the last session is up and
 * the fresh load is in flight (lib/planner-snapshot.ts). It is never lime
 * (CLAUDE.md), and it is ink on its own elements, so its fades reach nothing
 * else. Styles: "Planner preview: sync line" in app/globals.css.
 *
 * Nothing on the canvas is faded meanwhile. The one thing that dims is row
 * title TEXT, the waiting shimmer (lib/planner-shimmer.ts): a muted ink with a
 * band of full ink crossing it, its own ink on its own glyphs, never an
 * opacity on a container. This line's travelling bar IS that band, painted
 * the titles' way: the same keyframes, period and start, offset by the
 * track's own left edge (`--planner-shimmer-x`, measured here), so it crosses
 * the canvas exactly under the light crossing the titles, in the same frame.
 * After the shimmer's last pass the bar goes on alone, still saying "syncing".
 *
 * aria-hidden: the announcement is SettleHost's single role=status, so three
 * placements (desktop canvas, mobile content, Zen room) never speak three times.
 *
 * The syncing → done change happens on the SAME element, in the same render
 * that sees the landing (state adjusted during render, not in an effect): an
 * effect would commit one frame of nothing in between, unmounting the root and
 * restarting its fade-in.
 */
export function PlannerSyncLine({ className }: { className?: string }) {
  const previewing = usePlannerPreviewing() === true;
  const loaded = usePlannerLoaded();
  const [line, setLine] = useState<SyncLineState>(() => ({
    previewing,
    phase: previewing ? 'syncing' : 'off',
    shownAt: previewing ? now() : 0,
  }));

  if (line.previewing !== previewing) {
    setLine(
      previewing
        ? { previewing, phase: 'syncing', shownAt: now() }
        : { previewing, phase: landingPhase(loaded, line.shownAt), shownAt: line.shownAt }
    );
  }

  const root = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLSpanElement>(null);

  // Where the track starts in the viewport: the bar's keyframes are written in
  // viewport terms (the waiting shimmer's band), and this offset puts them on
  // the line. A background-position on the main thread, as on every title, so
  // a value written after the bar's animation started still reaches the
  // screen (a transform on the compositor kept the one it started with).
  // Before the first paint, and again when the window resizes.
  useLayoutEffect(() => {
    if (line.phase !== 'syncing') return;
    const place = () => {
      const el = bar.current;
      const track = el?.parentElement;
      if (!el || !track) return;
      el.style.setProperty('--planner-shimmer-x', `${Math.round(track.getBoundingClientRect().left * 100) / 100}px`);
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [line.phase]);

  // Done → off when the sweep ENDS, not on a clock started here: this effect
  // runs inside the landing's own task, before the browser has started the
  // sweep, and whatever synchronous work the landing sets off (a held
  // capture's addTask, other effects) would spend a timer's margin and cut the
  // fade mid-way. So the timer is only a backstop, and it starts two frames on.
  useEffect(() => {
    if (line.phase !== 'done') return;
    const end = () => setLine((l) => (l.phase === 'done' ? { ...l, phase: 'off' } : l));
    // Native, as Radix Presence listens. Only the sweep counts: the track's
    // fade-out bubbles up, and the root's own fade-in can end mid-done.
    const el = root.current;
    const onEnd = (event: AnimationEvent) => {
      if (event.animationName === SYNC_LINE_SWEEP) end();
    };
    el?.addEventListener('animationend', onEnd);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        timer = setTimeout(end, SYNC_LINE_DONE_MS);
      });
    });
    return () => {
      el?.removeEventListener('animationend', onEnd);
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      clearTimeout(timer);
    };
  }, [line.phase]);

  if (line.phase === 'off') return null;
  return (
    <div
      ref={root}
      aria-hidden="true"
      data-testid="planner-sync-line"
      data-state={line.phase}
      className={cn('planner-sync-line', className)}
    >
      <span className="planner-sync-line__track">
        <span ref={bar} className="planner-sync-line__bar" />
      </span>
    </div>
  );
}
