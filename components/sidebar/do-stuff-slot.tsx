'use client';

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Maximize2 } from 'lucide-react';
import {
  doneNext,
  fitMissedIn,
  letMissedGo,
  openDesk,
  skipNext,
  useDeskHosted,
  useDoStuffStore,
  useSortArrival,
} from '@/lib/do-stuff';
import { fitIn, freeStretch, headsUp, missedBlocks, sprintFor, stretchLabel, type WalkBlock } from '@/lib/do-stuff-walk';
import { SprintButton, SprintRing } from '@/components/sidebar/sprint-ring';
import { PocketButton } from '@/components/sidebar/do-stuff-pocket';
import { NowCapsule } from '@/components/sidebar/now-capsule';
import { prefersReducedMotion } from '@/lib/zen-transition';
import { openFirstSteps, useCanFirstSteps } from '@/components/sidebar/first-steps';
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
  const missedSeen = useDoStuffStore((s) => s.missedSeen);
  const stretch = useMemo(() => freeStretch(blocks, nowMin), [blocks, nowMin]);
  // Every block missed right now, the latest first: the first is offered, and
  // answering it marks the rest seen (one question a run, not a chain).
  const missed = useMemo(() => missedBlocks(blocks, nowMin, new Set(missedSeen)), [blocks, nowMin, missedSeen]);
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
  const heads = headsUp(blocks, nowMin);
  const first = missed[0];
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
      sprint={sprintFor(stretch, nowMin)}
      // "wrap up here" only when the user is in the slot: a stretch that waits
      // on a block that is on now (`after`) is a meeting they are in, not time
      // they are spending here.
      heads={heads ? { ...heads, wrapUp: !stretch.after } : null}
      missed={
        first
          ? {
              id: first.id,
              title: first.title,
              at: fitIn(stretch, nowMin, first.duration),
              others: missed.slice(1).map((b) => b.id),
            }
          : null
      }
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
  sprint,
  heads,
  missed,
}: {
  id: string;
  title: string;
  top: number;
  height: number;
  compact: boolean;
  lead: string;
  rest: string;
  doneCount: number;
  sprint: { minutes: number; until: string | null } | null;
  /** The block about to start, said instead of the stretch; `wrapUp` when the user is here to wrap up. */
  heads: { title: string; inMin: number; wrapUp: boolean } | null;
  /**
   * A block that came and went, offered once: fit it in at `at` (null when
   * nothing worth it fits, and the offer is "let it go" alone), or let it go.
   * `others` are the rest missed right now, marked seen with it.
   */
  missed: { id: string; title: string; at: { startMin: number; duration: number } | null; others: readonly string[] } | null;
}) {
  const running = useDoStuffStore((s) => !!s.sprint);
  const ref = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const steps = useCanFirstSteps(id);
  const desk = useDoStuffStore((s) => s.desk);
  // The ⤢ only where a desk can open: the phone's router has no desk.
  const deskHosted = useDeskHosted();
  const ring = running && !desk;

  // Arrive once the sort has landed (the up-next card does the same).
  useSortArrival(ref);

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
      <NowCapsule
        title={title}
        onDone={() => doneNext(id)}
        onSkip={() => skipNext(id)}
        testIds={{ done: 'do-stuff-slot-done', skip: 'do-stuff-slot-skip' }}
      />
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
      {!compact && <SprintButton offer={sprint} forItem={id} />}
      {!compact && <PocketButton />}
      {deskHosted && !desk && (
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
        {!compact && missed && (
          <p className="flex min-w-0 items-center gap-1 text-[11.5px] text-muted-foreground" data-testid="do-stuff-missed">
            <span className="min-w-0 truncate">
              missed <span className="font-medium text-foreground">{missed.title}</span>?
            </span>
            {missed.at !== null && (
              <button
                type="button"
                onClick={() => fitMissedIn(missed.id, missed.at!, missed.others)}
                data-testid="do-stuff-missed-fit"
                className="shrink-0 rounded-[5px] px-1.5 hover:bg-accent hover:text-foreground"
              >
                fit it in
              </button>
            )}
            <button
              type="button"
              onClick={() => letMissedGo(missed.id, missed.others)}
              data-testid="do-stuff-missed-let-go"
              className="shrink-0 rounded-[5px] px-1.5 hover:bg-accent hover:text-foreground"
            >
              let it go
            </button>
          </p>
        )}
        {/* The offer takes the heading's place until it is answered. At the
            Desk the ring is the desk's (one ring for one sprint): the slot
            keeps its stretch line. */}
        {!compact && !missed && ring && <SprintRing size={14} className="h-[17px] self-start" />}
        {!compact && !missed && !ring && heads && (
          <p className="truncate text-[11.5px] text-muted-foreground" data-testid="do-stuff-heads-up">
            <span className="font-medium text-foreground">{heads.title}</span> in {heads.inMin}m
            {heads.wrapUp && ' · wrap up here'}
          </p>
        )}
        {!compact && !missed && !ring && !heads && (
          <p className="truncate text-[11.5px] text-muted-foreground" data-testid="do-stuff-slot-stretch">
            <span className="font-medium text-success-text">{lead}</span> · {rest}
            {doneCount > 0 && <span> · {doneCount} done</span>}
          </p>
        )}
        <p className={cn('min-w-0 truncate font-medium', compact ? 'flex-1 text-[13px]' : 'text-[15px]')}>{title}</p>
        {/* A block about to start leaves a sliver of a stretch, so the slot is
            one line by then: the heads-up rides beside the title. So does a
            running sprint, which ends exactly then (five minutes before the
            block): the ring, its minutes and "time's up" must not vanish at
            the end. */}
        {compact && ring && <SprintRing size={14} className="shrink-0" />}
        {compact && !ring && heads && (
          <span className="shrink-0 text-[11.5px] text-muted-foreground" data-testid="do-stuff-heads-up">
            <span className="font-medium text-foreground">{heads.title}</span> in {heads.inMin}m
          </span>
        )}
        {/* At the Desk the actions are the desk's: the slot only marks the time. */}
        {!desk && actions}
      </div>
    </div>
  );
}
