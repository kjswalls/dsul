'use client';

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Check, Maximize2 } from 'lucide-react';
import { doneNext, openDesk, skipNext, sortDelay, useDoStuffStore } from '@/lib/do-stuff';
import { freeStretch, stretchLabel, type WalkBlock } from '@/lib/do-stuff-walk';
import { openFirstSteps, useCanFirstSteps } from '@/components/sidebar/first-steps';
import { prefersReducedMotion } from '@/lib/zen-transition';
import { cn } from '@/lib/utils';

/** Room the slot keeps for its full face; a shorter stretch gets one line. */
const FULL_PX = 88;
/** The least a slot is drawn at, even for a sliver of a gap. */
const MIN_PX = 40;
/** Clear of the now marker's diamond on the slot's top edge. */
const INSET_PX = 6;

/**
 * "In the day" (Kirby's pick, 2026-10-16): while doing stuff, the current item
 * opens inside today's schedule, in the free stretch between now and the next
 * thing on the clock, so the plan and the day share one screen. The stretch is
 * the schedule's own blocks (lib/do-stuff-walk.ts); the item is the plan's
 * next, as the list publishes it. Nothing here decides what wants doing.
 *
 * Drawn inside DaySchedule's events field, on today only, and never while a
 * block is being dragged or resized. While it is drawn it says so (the store's
 * `slot`), and the header's up-next card and the list's card stand down: one
 * current item, in one place.
 *
 * It arrives after the sort has landed (SORT_SETTLE_MS), and a new item rises
 * into it in place: the slot itself never moves on done.
 */
export function DoStuffSlot({
  blocks,
  nowMin,
  gridStartHour,
  gridEndHour,
  hourPx,
}: {
  blocks: readonly WalkBlock[];
  nowMin: number;
  gridStartHour: number;
  gridEndHour: number;
  hourPx: number;
}) {
  const next = useDoStuffStore((s) => (s.on ? s.next : null));
  const doneCount = useDoStuffStore((s) => s.doneCount);
  const stretch = useMemo(() => freeStretch(blocks, nowMin), [blocks, nowMin]);
  const gridStart = gridStartHour * 60;
  const gridEnd = gridEndHour * 60;
  const shown = !!next && !!stretch && stretch.startMin >= gridStart && stretch.startMin < gridEnd;

  useEffect(() => {
    if (!shown) return;
    useDoStuffStore.setState({ slot: true });
    return () => useDoStuffStore.setState({ slot: false });
  }, [shown]);

  if (!shown || !next || !stretch) return null;
  const top = ((stretch.startMin - gridStart) / 60) * hourPx;
  const span = ((Math.min(stretch.endMin, gridEnd) - stretch.startMin) / 60) * hourPx;
  const height = Math.max(MIN_PX, span - INSET_PX * 2);
  const label = stretchLabel(stretch, nowMin);
  return (
    <SlotFace
      id={next.id}
      title={next.title}
      top={top + INSET_PX}
      height={height}
      compact={height < FULL_PX}
      lead={label.lead}
      rest={label.rest}
      doneCount={doneCount}
    />
  );
}

function SlotFace({
  id,
  title,
  top,
  height,
  compact,
  lead,
  rest,
  doneCount,
}: {
  id: string;
  title: string;
  top: number;
  height: number;
  compact: boolean;
  lead: string;
  rest: string;
  doneCount: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const steps = useCanFirstSteps(id);
  const desk = useDoStuffStore((s) => s.desk);

  // Arrive once the sort has landed: a clip from the top edge, never an
  // opacity, since the notch is lime.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion() || typeof el.animate !== 'function') return;
    el.animate(
      [
        { clipPath: 'inset(0 0 100% 0)', transform: 'translate(0, -4px)' },
        { clipPath: 'inset(0)', transform: 'none' },
      ],
      { duration: 320, delay: sortDelay(), easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' }
    );
  }, []);

  // A new item rises into the slot in place; the slot stays where it is.
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = bodyRef.current;
    if (!el || prefersReducedMotion() || typeof el.animate !== 'function') return;
    el.animate(
      [
        { clipPath: 'inset(100% 0 0 0)', transform: 'translate(0, 8px)' },
        { clipPath: 'inset(0)', transform: 'none' },
      ],
      { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' }
    );
  }, [id]);

  const actions = (
    <div className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        onClick={() => doneNext(id)}
        aria-label={`Done: ${title}`}
        data-testid="do-stuff-slot-done"
        className="flex h-7 items-center gap-1 rounded-[7px] bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
      >
        <Check aria-hidden className="size-3" />
        done
      </button>
      <button
        type="button"
        onClick={() => skipNext(id)}
        data-testid="do-stuff-slot-skip"
        className="h-7 rounded-[7px] px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        skip
      </button>
      {steps && !compact && (
        <button
          type="button"
          onClick={() => openFirstSteps(id)}
          data-testid="do-stuff-slot-first-steps"
          className="h-7 rounded-[7px] px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          first steps
        </button>
      )}
      {!desk && (
        <button
          type="button"
          onClick={openDesk}
          aria-label={`Open the desk: ${title}`}
          title="Open the desk (D)"
          data-testid="do-stuff-slot-desk"
          className="flex size-7 items-center justify-center rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Maximize2 aria-hidden className="size-3.5" />
        </button>
      )}
    </div>
  );

  return (
    <div
      ref={ref}
      data-testid="do-stuff-slot"
      data-compact={compact || undefined}
      aria-label={`Now: ${title}`}
      className="absolute left-[14px] right-2 z-[3] overflow-hidden rounded-[10px] border border-border bg-surface-2 shadow-elev-sm"
      style={{ top, height }}
    >
      {/* The notch: its own element at full strength, never faded (lime). */}
      <span aria-hidden className="absolute bottom-2 left-0 top-2 w-[3px] rounded-r-full bg-primary" />
      <div
        ref={bodyRef}
        className={cn('flex h-full min-w-0 pl-4 pr-2', compact ? 'items-center gap-3' : 'flex-col justify-center gap-1.5 py-2')}
      >
        {!compact && (
          <p className="truncate text-[11.5px] text-muted-foreground" data-testid="do-stuff-slot-stretch">
            <span className="font-medium text-success-text">{lead}</span> · {rest}
            {doneCount > 0 && <span> · {doneCount} done</span>}
          </p>
        )}
        <p className={cn('min-w-0 truncate font-medium', compact ? 'flex-1 text-[13px]' : 'text-[15px]')}>{title}</p>
        {/* At the Desk the actions are the desk's: the slot only marks the time. */}
        {!desk && actions}
      </div>
    </div>
  );
}
