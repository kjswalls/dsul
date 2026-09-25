import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from 'react';
import { isRowCompletedOn, type SortableRow } from '@/lib/sort-rows';
import { useDragStore } from '@/lib/drag-store';

/**
 * How long a row that was just ticked (or unticked) keeps its old place before
 * the sink moves it. Long enough to see the checkbox land and the title strike
 * through where you clicked; short enough that the list has settled before you
 * look for the next thing.
 */
export const SINK_HOLD_MS = 700;
/** The slide from the old place to the new one, once the hold lets go. */
export const SINK_SLIDE_MS = 320;

/**
 * Hold the completed-sinks pass for a moment, then slide rows to their new place.
 *
 * `sinkCompleted` (lib/sort-rows.ts) is a pure function of the rows it is
 * handed, so on its own a tick moves the row to the foot of its group in the
 * same frame the checkbox fills — the row you clicked is gone from under the
 * pointer before you have seen it change. This hook sits between the store and
 * that pass and answers "which side of the sink does this row sort on" with the
 * value it had BEFORE the change, until the list has been still for
 * {@link SINK_HOLD_MS}. Then every pending row commits at once and each row's
 * move is animated from where it was (a FLIP over `[data-item-id]` under
 * `rootRef`).
 *
 * VIEW-LEVEL, on purpose. A completion reaches the store from the checkbox, the
 * command palette, Beacon, the EOD review and realtime sync, so a hold armed at
 * any one of those would miss the rest. Watching what each surface renders
 * catches all of them, and leaves the store's own state instant — the row's
 * checkbox, strike-through and every count are live; only its POSITION waits.
 *
 * One timer, debounced: ticking three rows in quick succession keeps all three
 * in place and moves them together once you stop, rather than shuffling the
 * list under the pointer between clicks. Unticking a row inside its hold just
 * cancels it, since nothing ever moved.
 *
 * Keyed by item AND date, because a recurring row's completion is per-date and
 * Week × List renders the same habit in seven sections that can disagree.
 *
 * Rows a pass does not draw are forgotten, so one that changed off-surface
 * (another date, filtered out) returns already in place. A drag in progress
 * postpones the commit until the drop.
 *
 * The FLIP only runs on a commit this hook made, never on an ordinary re-render,
 * so a group collapsing or a window resize does not animate. Reduced motion
 * keeps the hold (it is a pause, not motion) and drops the slide.
 */
export function useSinkHold<E extends HTMLElement = HTMLDivElement>(
  /**
   * A callback ref the root element also needs — a surface's dnd-kit
   * `setNodeRef`. Merged here so the returned `rootRef` keeps ONE identity: an
   * inline merge would be a new ref every render, and React would detach and
   * re-attach the droppable each commit, which makes dnd-kit's ResizeObserver
   * swallow the growth of the very cell a drag just entered.
   */
  forwardRef?: (el: E | null) => void,
) {
  /** The completion each row SORTS by. Written only in effects and timers. */
  const committed = useRef(new Map<string, boolean>());
  /** The completion each row actually HAS, as of the last ordering pass. */
  const observed = useRef(new Map<string, boolean>());
  /** What `completedAs` has seen since the last effect — one ordering pass. */
  const batch = useRef(new Map<string, boolean>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Which rows the armed timer is holding, so a re-render doesn't re-arm it. */
  const lastSignature = useRef('');
  const before = useRef<Map<Element, DOMRect> | null>(null);
  const root = useRef<E | null>(null);
  const [version, commit] = useReducer((n: number) => n + 1, 0);

  const rootRef = useCallback(
    (el: E | null) => {
      root.current = el;
      forwardRef?.(el);
    },
    [forwardRef],
  );

  const completedAs = useCallback(
    (row: SortableRow, dateStr: string | null): boolean => {
      const actual = isRowCompletedOn(row, dateStr);
      const key = `${row.item.id}|${dateStr ?? ''}`;
      batch.current.set(key, actual);
      return committed.current.get(key) ?? actual;
    },
    // `version` is the point: a new function identity after each commit lets a
    // memoized caller (the braindump) re-run its ordering with the new values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );

  // Every render: adopt rows seen for the first time, and (re)arm or disarm the
  // hold for rows whose completion now differs from where they sort.
  useEffect(() => {
    // Only a render that actually ran the ordering replaces what we know. The
    // braindump orders inside a useMemo, so most of its renders call
    // `completedAs` for nothing, and an empty batch there means "unchanged",
    // not "every row left".
    if (batch.current.size > 0) {
      observed.current = batch.current;
      batch.current = new Map();
      // Forget rows this pass did not draw. A row that changed while it was
      // off-surface — another date, filtered out, ticked from Beacon while you
      // looked elsewhere — comes back sorted where it now belongs, rather than
      // where it last was and then sliding as if you had just ticked it.
      for (const key of committed.current.keys()) {
        if (!observed.current.has(key)) committed.current.delete(key);
      }
    }
    let pending = false;
    for (const [key, actual] of observed.current) {
      const c = committed.current.get(key);
      if (c === undefined) committed.current.set(key, actual);
      else if (c !== actual) pending = true;
    }
    if (!pending) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      return;
    }
    // A change nobody has seen yet restarts the clock; a re-render with the
    // same pending set must not, or a busy store would hold rows forever.
    const signature = pendingSignature(committed.current, observed.current);
    if (timer.current && signature === lastSignature.current) return;
    lastSignature.current = signature;
    if (timer.current) clearTimeout(timer.current);
    const fire = () => {
      // Never reorder under a drag: the FLIP would override the dragged row's
      // own inline transform and snap it back toward its slot, and the drop
      // zones would shift beneath the pointer. Wait for the drop.
      if (useDragStore.getState().activeId) {
        timer.current = setTimeout(fire, SINK_HOLD_MS);
        return;
      }
      timer.current = null;
      lastSignature.current = '';
      before.current = measure(root.current);
      for (const [key, actual] of observed.current) committed.current.set(key, actual);
      commit();
    };
    timer.current = setTimeout(fire, SINK_HOLD_MS);
  });

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  useLayoutEffect(() => {
    const first = before.current;
    before.current = null;
    if (!first || prefersReducedMotion()) return;
    for (const [el, rect] of measure(root.current) ?? []) {
      const was = first.get(el);
      if (!was) continue;
      const dy = was.top - rect.top;
      if (Math.abs(dy) < 1 || typeof (el as HTMLElement).animate !== 'function') continue;
      (el as HTMLElement).animate(
        [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }],
        { duration: SINK_SLIDE_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
      );
    }
  }, [version]);

  return { completedAs, rootRef };
}

function pendingSignature(committed: Map<string, boolean>, observed: Map<string, boolean>): string {
  const keys: string[] = [];
  for (const [key, actual] of observed) {
    if (committed.get(key) !== actual) keys.push(`${key}:${actual ? 1 : 0}`);
  }
  return keys.join(',');
}

function measure(root: HTMLElement | null): Map<Element, DOMRect> | null {
  if (!root) return null;
  const rects = new Map<Element, DOMRect>();
  root.querySelectorAll('[data-item-id]').forEach((el) => {
    // The row's outermost box: on mobile TaskRow sits inside SwipeRow's
    // overflow-hidden strip, which would clip a row slid out of it.
    const box = el.closest('[data-sink-row]') ?? el;
    rects.set(box, box.getBoundingClientRect());
  });
  return rects;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
