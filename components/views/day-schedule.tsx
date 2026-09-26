'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useDroppable, useDraggable } from '@dnd-kit/core';
import { ArrowLeftToLine, Redo2, SkipForward, Undo2 } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { GroupSection } from '@/components/primitives/group-section';
import { TaskRow, type RowItem } from '@/components/primitives/task-row';
import { PriorityGlyph, MetaText, RollingMetaText, formatDuration } from '@/components/primitives/pills';
import { useDayItems } from '@/hooks/use-day-items';
import { useFieldWidth, useFitHourPx, useResizeScrollCompensation } from '@/lib/use-fit-hour-px';
import { useScheduleResizeStore } from '@/lib/schedule-resize-store';
import { isTouchPointer } from '@/lib/dnd/sensors';
import {
  HOUR_PX,
  HOVER_Z,
  LANE_PX,
  NOW_MARKER_Z,
  PANE_MIN_H,
  PANE_OFFSET,
  PANE_TALL_H,
  PANE_TRIM,
  PANE_WRAP_PX,
} from '@/lib/schedule-constants';
import {
  bandOnly,
  layoutOverlaps,
  type BlockLayout,
  type OverlapEntry,
  type OverlapLayout,
} from '@/lib/schedule-overlap';
import { planLanes, isReceded } from '@/lib/schedule-lanes';
import { useScheduleFocusStore } from '@/lib/schedule-focus-store';
import { LaneCapRow } from '@/components/primitives/lane-cap';
import { getItemTypeConfig } from '@/lib/item-registry';
import { milestoneItemIds } from '@/lib/goals';
import { canMoveToNextDay, canSendToBraindump, formatTargetDay, nextDayLabel, nextDayTarget } from '@/lib/row-moves';
import { RowControl, RowControlGroup } from '@/components/primitives/row-control';
import { useIsMobile } from '@/hooks/use-mobile';
import { usePlannerStore } from '@/lib/planner-store';
import { openEditFor } from '@/lib/ui-store';
import { useViewStore, type ScheduleMarkStyle } from '@/lib/view-store';
import { useCanvasGroupBy } from '@/lib/extension-gates';
import { useSelectionStore, rangeIds } from '@/lib/selection-store';
import { useNowMinutes } from '@/lib/use-now-minutes';
import { useTimeFormat } from '@/lib/use-time-format';
import { isRecurring, isCompletedOnDate, isSkippedOnDate, toDateStr } from '@/lib/recurrence';
import { sinkCompleted } from '@/lib/sort-rows';
import { useSinkHold } from '@/hooks/use-sink-hold';
import { suppressionReason } from '@/lib/active';
import { BUCKET_ORDER } from '@/lib/day-items';
import { groupRows } from '@/lib/grouping';
import { groupBySupport } from '@/lib/view-options';
import { ProgramNotice } from '@/components/views/program-notice';
import type { DayItems } from '@/lib/day-items';
import type { Task, HabitItem, TimeBucket, Item } from '@/lib/planner-types';
import { cn } from '@/lib/utils';

/**
 * Day × Schedule (P5d, per desktop_day_scheduleView.png): untimed items in
 * an ANYTIME section up top, then an hour gutter with duration-height
 * blocks. Dropping on an hour slot schedules at the top of that hour
 * (`hour:{H}`, CONTRACT.md).
 *
 * The block + derivation helpers are exported so week-schedule reuses them.
 *
 * ── The timeline's visual language ────────────────────────────────────────
 * Every block stands beside a LANE. The lane carries a hairline rail; the item's
 * accent swells that rail to 2px for exactly as long as the event runs, and a
 * bead pins its start on the hour line. So the accent is a mark ON the grid,
 * with real extent, rather than a stripe glued to a card — and the block itself
 * is lit from the rail side (see --sched-* in app/globals.css) so the colour
 * reads as a light source instead of as a coloured container.
 *
 * On hover the block picks up drafting-style REGISTRATION MARKS: four corner
 * crops and a caliper datum centred on each resizable edge. They sit OUTSIDE the
 * pane, the way real crop marks sit off the object they register, which is why
 * the component is built as an outer positioning wrapper around an
 * overflow-hidden pane — the pane would clip them — and why a hovered block
 * raises its z-index, so a flush neighbour can't paint over them.
 */

/**
 * The pane geometry moved to lib/schedule-constants.ts when the overlap pass
 * (lib/schedule-overlap.ts) needed it: that file is pure and has to agree with
 * this renderer down to the pixel, and importing a 'use client' component into
 * lib/ would be a cycle. Re-exported here because week-schedule imports LANE_PX
 * from this module, and because the numbers still belong to this component's
 * story even when they no longer live in its file.
 */
export { HOUR_PX, LANE_PX };

/**
 * Day view: the gutter's width, which is also the events layer's left offset —
 * the two now meet. They used to be 88 and 132, leaving 44px of nothing between
 * the hour labels and the first thing they label. That gap was survivable while
 * the gutter was a bordered box that read as its own object; against a bare
 * column of marks it just reads as the labels having drifted off the grid, and
 * it separated the live time from its own diamond by the width of a thumb.
 *
 * Sized to hold the widest thing the column prints — the live time at
 * "12:40 pm" — with the inset below, and no wider: every px past that reopens
 * the gap the labels just closed.
 */
export const DAY_FIELD_LEFT = 68;

/**
 * Where the hour marks start. This is TaskRow's own `px-2`, which is what puts
 * the Anytime rows' checkboxes at x=8 — and both the Anytime section and the
 * hour grid are direct children of the same canvas-container, so they share an
 * origin. Left-aligning the marks here therefore runs ONE edge down the whole
 * view: checkbox, checkbox, checkbox, 8 am, 9 am, 10 am.
 *
 * That's the reason these are left-aligned rather than right-aligned against
 * the lane, which is what the source study does. The study had no Anytime
 * section above its grid to answer to; this view does, and a shared edge with
 * the thing directly above beats a shared edge with the lane beside.
 */
export const DAY_GUTTER_INSET = 'pl-2';

/**
 * A clock time from minutes-since-midnight, in the user's 12h/24h preference.
 * `meridiem: false` drops the am/pm — used for the in-block start–end range,
 * where printing it twice spends the block's scarcest resource on nothing.
 */
export function formatClock(totalMin: number, timeFormatStr: string, meridiem = true) {
  const m = ((Math.round(totalMin) % 1440) + 1440) % 1440;
  const hour = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  if (timeFormatStr === 'HH:mm') return `${String(hour).padStart(2, '0')}:${mm}`;
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return meridiem ? `${h12}:${mm} ${hour < 12 ? 'am' : 'pm'}` : `${h12}:${mm}`;
}

/**
 * The live-time marker: a lime diamond seated on the rail, plus a short stub of
 * rule reaching into the lane.
 *
 * The rule is a STUB by design — it stops at the pane and never crosses it. A
 * lime hairline under 72%-opacity glass composites to a dimmed olive, and lime
 * is never allowed to dim (it is the one accent that stays at full strength in
 * both themes). So the marker lives in the lane, where nothing is layered over
 * it, and the hour gutter carries the reading of the clock.
 */
export function NowMarker({ top, lanes }: { top: number; lanes?: number[] }) {
  // ONE diamond, a stub per lane. Not one marker per lane: the clock is a single
  // fact about the day, and giving lane 0 alone a stub would read as "now" being
  // a property of that group. The diamond stays on the first lane's rail, where
  // the hour gutter's reading of the time already points.
  const stubs = lanes?.length ? lanes : [0];
  return (
    <div
      className="pointer-events-none absolute left-0 right-0 z-[var(--now-z)]"
      style={{ top, '--now-z': NOW_MARKER_Z } as React.CSSProperties}
      aria-hidden
    >
      <span
        className="absolute top-[-3.5px] h-[7px] w-[7px] rotate-45 bg-primary shadow-[0_0_0_1px_var(--canvas)]"
        style={{ left: `calc(${stubs[0]}% + 2px)` }}
      />
      {stubs.map((leftPct, i) => (
        // Still a 24px STUB in each lane's own channel, never a rule across the
        // lane: a lime hairline under 80%-opacity glass composites to a dimmed
        // olive, and lime is the one accent that is never allowed to dim.
        <span
          key={i}
          className="absolute top-0 w-6 border-t border-primary"
          style={{ left: `calc(${leftPct}% + 12px)` }}
        />
      ))}
    </div>
  );
}

/** How close (px) the live time has to fall to an hour label before that label
 *  steps aside for it. Both share the gutter column, so one of them has to. */
export const ECLIPSE_PX = 34;

/* Literal class names — Tailwind's JIT only keeps classes it can see as
   literals, so the week title's clamp can't be built by interpolation. Index is
   the line count minus one; anything past six lines is already more block than
   a week column ever gets. */
const LINE_CLAMP = [
  'line-clamp-1',
  'line-clamp-2',
  'line-clamp-3',
  'line-clamp-4',
  'line-clamp-5',
  'line-clamp-6',
];

export type TimedEntry = {
  itemType: 'task' | 'habit';
  item: Task | HabitItem;
  startMin: number;
  duration: number;
};

const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

/** The type's own fallback block length, for an item with no duration set. */
function defaultMinutes(item: Task | HabitItem, itemType: 'task' | 'habit'): number {
  const projected = item as { type?: string; customType?: string };
  return getItemTypeConfig(projected.type === 'custom' ? projected.customType! : itemType).schedule
    .defaultBlockMinutes;
}

/** Timed items (tasks/habits with startTime + project-block tasks) for one day. */
export function deriveTimedEntries(day: DayItems): TimedEntry[] {
  const allTasks = BUCKET_ORDER.flatMap((b) => day.tasksByBucket[b]);
  const allHabits = BUCKET_ORDER.flatMap((b) => day.habitsByBucket[b]);
  return [
    // Both branches read the item's own duration and fall back to the registry's
    // defaultBlockMinutes. The habit branch used to hardcode 30 because habits
    // had no duration field at all; now that they do, a habit block is as long as
    // the habit says it is.
    ...allHabits
      .filter((h) => h.startTime)
      .map((h) => ({
        itemType: 'habit' as const,
        item: h,
        startMin: toMin(h.startTime!),
        duration: h.duration ?? defaultMinutes(h, 'habit'),
      })),
    ...allTasks
      .filter((t) => t.startTime && !t.inProjectBlock)
      .map((t) => ({
        itemType: 'task' as const,
        item: t,
        startMin: toMin(t.startTime!),
        duration: t.duration ?? defaultMinutes(t, 'task'),
      })),
    ...day.recurringProjects
      .filter((p) => p.startTime)
      .flatMap((p) =>
        allTasks
          .filter((t) => t.inProjectBlock && t.project === p.name)
          .map((t) => ({ itemType: 'task' as const, item: t, startMin: toMin(p.startTime!), duration: p.duration ?? 60 }))
      ),
  ].sort((a, b) => a.startMin - b.startMin);
}

/**
 * TimedEntry[] → the overlap pass's input.
 *
 * The `projectBlock` key is the load-bearing part. Every task inside a recurring
 * project block takes the PROJECT's startTime and duration (see the third branch
 * of deriveTimedEntries), so a block holding four tasks emits four entries with
 * byte-identical extents. Without grouping them, three of the four are painted
 * over exactly — not clipped, not half-covered, but invisible — which is a worse
 * instance of the overlap bug than anything a user can produce by hand. Grouped,
 * they become one conflict unit and tile the band.
 */
export function toOverlapEntries(entries: TimedEntry[]): OverlapEntry[] {
  return entries.map((e) => ({
    id: e.item.id,
    startMin: e.startMin,
    duration: e.duration,
    projectBlock: (e.item as Task).inProjectBlock ? ((e.item as Task).project ?? null) : null,
  }));
}

/** Untimed items (no startTime, not in a project block) for one day. */
export function deriveUntimedRows(day: DayItems): RowItem[] {
  const allTasks = BUCKET_ORDER.flatMap((b) => day.tasksByBucket[b]);
  const allHabits = BUCKET_ORDER.flatMap((b) => day.habitsByBucket[b]);
  return [
    ...allHabits.filter((h) => !h.startTime).map((h) => ({ itemType: 'habit' as const, item: h })),
    ...allTasks.filter((t) => !t.startTime && !t.inProjectBlock).map((t) => ({ itemType: 'task' as const, item: t })),
  ];
}

/**
 * Visible hour window for a schedule grid: the content's own span padded by an
 * hour of context each side, floored to a minimum span so a light day isn't a
 * cramped sliver. Empty days fall back to a sane 8am–7pm. This replaces the old
 * always-pad-to-8..19 rule — which only ever grew the grid — so the range now
 * tracks what's actually scheduled, then `useFitHourPx` shrinks the rows to fit.
 */
export const GRID_MIN_SPAN = 8;

/** While a drag is active the grid expands to the full day so every hour is a
 *  drop target — the compact content window alone strands the boundary blocks
 *  (the latest block has no rows beneath it, off-window hours are unreachable). */
export const FULL_DAY_RANGE = { gridStartHour: 0, gridEndHour: 24 } as const;

/**
 * `includeMin` is a minute-of-day the window must contain — the live clock, on
 * a grid showing today. Without it the now-marker had nowhere to render on any
 * day whose items don't happen to bracket the current hour (an evening-only day
 * at 9am, an empty day at 7am), which reads as the marker being broken rather
 * than as the window being tight. Pass null to leave the window content-fit.
 */
export function deriveGridRange(
  entries: TimedEntry[],
  includeMin?: number | null
): { gridStartHour: number; gridEndHour: number } {
  let start: number;
  let end: number;
  if (entries.length === 0) {
    start = 8;
    end = 19;
  } else {
    start = Math.max(0, Math.min(...entries.map((e) => Math.floor(e.startMin / 60))) - 1);
    end = Math.min(24, Math.max(...entries.map((e) => Math.ceil((e.startMin + e.duration) / 60))) + 1);
  }
  if (includeMin != null) {
    start = Math.max(0, Math.min(start, Math.floor(includeMin / 60)));
    end = Math.min(24, Math.max(end, Math.floor(includeMin / 60) + 1));
  }
  if (end - start < GRID_MIN_SPAN) {
    const mid = (start + end) / 2;
    start = Math.max(0, Math.round(mid - GRID_MIN_SPAN / 2));
    end = Math.min(24, start + GRID_MIN_SPAN);
    start = Math.max(0, end - GRID_MIN_SPAN);
  }
  return { gridStartHour: start, gridEndHour: end };
}

/**
 * The gutter's hour mark. In 12h the ":00" is dropped — every label in the
 * column sits on the hour, so the zeroes are two characters of nothing repeated
 * down the grid, and dropping them is what lets the live time ("2:40 pm") read
 * as the one label with minutes on it. 24h keeps "07:00": a bare "07" isn't a
 * time in that idiom.
 */
export function formatHourLabel(hour: number, timeFormatStr: string) {
  if (timeFormatStr === 'HH:mm') return `${String(hour).padStart(2, '0')}:00`;
  if (hour === 0) return '12 am';
  if (hour < 12) return `${hour} am`;
  if (hour === 12) return '12 pm';
  return `${hour - 12} pm`;
}

function HourSlot({
  hour,
  isActive,
  label,
  isFirst,
  hourPx,
  eclipsed,
}: {
  hour: number;
  isActive: boolean;
  label: string;
  isFirst: boolean;
  hourPx: number;
  /** The live time is sitting on this label — it yields the column. */
  eclipsed?: boolean;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: `hour:${hour}`, disabled: !isActive });
  return (
    <div
      ref={setNodeRef}
      data-dnd-id={`hour:${hour}`}
      data-dnd-over={isOver ? 'true' : 'false'}
      className="relative flex"
      style={{ height: hourPx }}
    >
      {/* Gutter: a bare column of mono marks, no box. The old bordered cells
          drew a second grid beside the real one — every hour boxed on three
          sides — which competed with the hairlines that actually carry the time.
          Mono at text-2xs puts them in the same voice as every other numeral in
          the app (durations, streaks, the live time below), and they start on
          the Anytime checkboxes' edge — see DAY_GUTTER_INSET. */}
      <div
        className={cn('flex-shrink-0 pt-[3px] font-num text-2xs text-muted-foreground', DAY_GUTTER_INSET)}
        style={{ width: DAY_FIELD_LEFT }}
      >
        <span className={cn(eclipsed && 'opacity-0')}>{label}</span>
      </div>
      {/* Hour line in the event area. It starts at the PANE (field + lane), not
          short of it, so the lane stays an unbroken channel; the right inset is
          Figma's. None above the first row. */}
      {!isFirst && (
        <div
          className={cn(
            'pointer-events-none absolute right-[17px] top-0 border-t border-border/50',
            isActive && 'border-dashed'
          )}
          style={{ left: DAY_FIELD_LEFT + LANE_PX }}
        />
      )}
      <div className={cn('flex-1 transition-colors', isOver && 'bg-primary/10')} />
    </div>
  );
}

/**
 * The four corner marks a schedule block shows, in the user's chosen style
 * (Settings → Appearance → Schedule handles). Aria-hidden, anchored off the
 * pane's real inset so a tiled conflict member's marks track its own edges.
 *
 * Two states share one set of marks:
 *   • HOVER reveals them in neutral --ink-1 (transient).
 *   • SELECTED latches them on and turns them lime — the colour rides
 *     --blk-mk (set on the block wrapper), so a selected block's marks stay lit
 *     even while it's hovered. That's the signal a shared pane-brightness can't
 *     give: hover and selection now report on different channels.
 *
 *   nodes  — 6px hollow square on each vertex (a CAD bounding box)
 *   target — 9px open registration crosshair off each corner
 *   trim   — 5px trim-mark lozenge (rotated square) off each corner
 *
 * The LEFT-column marks seat at the pane's own left edge rather than off it: the
 * 12px lane (start bead + accent rail) lives just outside that edge, and a mark
 * pushed further left would collide with it.
 */
function BlockCorners({
  style,
  paneLeftCss,
  paneRightCss,
  selected,
}: {
  style: ScheduleMarkStyle;
  paneLeftCss: string;
  paneRightCss: string;
  selected: boolean;
}) {
  const reveal = selected
    ? 'pointer-events-none absolute opacity-100'
    : 'pointer-events-none absolute opacity-0 transition-opacity group-hover/blk:opacity-100';

  if (style === 'target') {
    const left = paneLeftCss;
    const right = `calc(${paneRightCss} - 8.5px)`;
    const corners: Array<{ pos: React.CSSProperties; y: string }> = [
      { pos: { left }, y: '-top-[8.5px]' },
      { pos: { right }, y: '-top-[8.5px]' },
      { pos: { left }, y: '-bottom-[8.5px]' },
      { pos: { right }, y: '-bottom-[8.5px]' },
    ];
    return (
      <>
        {corners.map((c, i) => (
          <span key={i} aria-hidden className={cn(reveal, 'h-[9px] w-[9px]', c.y)} style={c.pos}>
            <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--blk-mk)]" />
            <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[var(--blk-mk)]" />
            {/* the reticle's empty eye — a canvas dot punches the centre gap */}
            <span className="absolute left-1/2 top-1/2 h-[3px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--canvas)]" />
          </span>
        ))}
      </>
    );
  }

  if (style === 'trim') {
    const left = paneLeftCss;
    const right = `calc(${paneRightCss} - 6.5px)`;
    const loz = 'h-[5px] w-[5px] rotate-45 border border-[var(--blk-mk)]';
    return (
      <>
        <span aria-hidden className={cn(reveal, loz, '-top-[6.5px]')} style={{ left }} />
        <span aria-hidden className={cn(reveal, loz, '-top-[6.5px]')} style={{ right }} />
        <span aria-hidden className={cn(reveal, loz, '-bottom-[6.5px]')} style={{ left }} />
        <span aria-hidden className={cn(reveal, loz, '-bottom-[6.5px]')} style={{ right }} />
      </>
    );
  }

  // 'nodes' (default) — 6px hollow square seated just inside each pane corner.
  // Both columns hug their own edge (not straddling the vertex) so the frame is
  // symmetric AND the left pair clears the lane's rail + bead.
  const left = paneLeftCss;
  const right = paneRightCss;
  const node = 'h-1.5 w-1.5 rounded-[1px] border border-[var(--blk-mk)] bg-[var(--canvas)]';
  return (
    <>
      <span aria-hidden className={cn(reveal, node, '-top-[3px]')} style={{ left }} />
      <span aria-hidden className={cn(reveal, node, '-top-[3px]')} style={{ right }} />
      <span aria-hidden className={cn(reveal, node, '-bottom-[3px]')} style={{ left }} />
      <span aria-hidden className={cn(reveal, node, '-bottom-[3px]')} style={{ right }} />
    </>
  );
}

/**
 * The visible grip inside a resize hit-zone, in the user's chosen style. Seated
 * on the edge centre — the hit-zone straddles the edge, its line 9px in from the
 * zone's outer side. Colour rides --blk-mk (neutral on hover, lime when the
 * block is selected). A SECOND lime glyph — the reticle eye / centre patch —
 * lights only while THIS edge is being dragged: colour spent on one small active
 * glyph, and lime never dims. 'nodes' stays neutral apart from the select tint.
 */
function HandleGrip({
  style,
  edge,
  active,
  selected,
}: {
  style: ScheduleMarkStyle;
  edge: 'top' | 'bottom';
  active: boolean;
  selected: boolean;
}) {
  const reveal = selected
    ? 'pointer-events-none absolute left-1/2 -translate-x-1/2 opacity-100'
    : 'pointer-events-none absolute left-1/2 -translate-x-1/2 opacity-0 transition-opacity group-hover/blk:opacity-100';
  const seat = edge === 'top' ? 'top-[9px] -translate-y-1/2' : 'bottom-[9px] translate-y-1/2';

  if (style === 'target') {
    return (
      <span aria-hidden className={cn(reveal, seat, 'h-3 w-3 rounded-full border border-[var(--blk-mk)]')}>
        <span className="absolute -top-1 -bottom-1 left-1/2 w-px -translate-x-1/2 bg-[var(--blk-mk)]" />
        <span
          className={cn(
            'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full',
            active ? 'h-[3px] w-[3px] bg-[var(--primary)]' : 'h-[2px] w-[2px] bg-[var(--blk-mk)]'
          )}
        />
      </span>
    );
  }

  if (style === 'trim') {
    return (
      <span aria-hidden className={cn(reveal, seat, 'flex h-[3px] w-[14px] gap-px')}>
        <span className="h-full w-1 rounded-[0.5px] bg-[var(--blk-mk)]" />
        <span className={cn('h-full w-1 rounded-[0.5px]', active ? 'bg-[var(--primary)]' : 'bg-[var(--blk-mk)]')} />
        <span className="h-full w-1 rounded-[0.5px] bg-[var(--blk-mk)]" />
      </span>
    );
  }

  // 'nodes' (default) — a solid square grip matching the corner nodes.
  return (
    <span
      aria-hidden
      className={cn(reveal, seat, 'h-1.5 w-1.5 rounded-[1px] bg-[var(--blk-mk)] shadow-[0_0_0_1px_var(--canvas)]')}
    />
  );
}

export function ScheduleBlock({
  entry,
  gridStartMin,
  date,
  hourPx = HOUR_PX,
  variant = 'day',
  layout,
  fieldWidth,
  receded = false,
}: {
  entry: TimedEntry;
  gridStartMin: number;
  date?: Date;
  hourPx?: number;
  /** Week columns are ~140px wide. They drop the emission wash and the whole
   *  metadata rail and spend the width on a WRAPPING title instead — see the
   *  content block below. */
  variant?: 'day' | 'week';
  /** Measured width of the events layer. With `layout.widthFraction` this gives
   *  the pane's real px width, which is what decides the content treatment — see
   *  `narrow` below. Unknown (or absent) means "wide", i.e. today's behaviour. */
  fieldWidth?: number | null;
  /**
   * Where this block sits when it overlaps something (lib/schedule-overlap.ts).
   * ABSENT is the common case and the important one: an entry with nothing
   * overlapping it gets no layout, and every branch below then falls back to the
   * literal values this component always used — `left-0 right-1`, `marginLeft:
   * LANE_PX`, a rail at x=5, a bead at x=3, content centred in the whole pane.
   * An uncrowded day renders exactly the markup it rendered before the pass
   * existed.
   */
  layout?: BlockLayout;
  /**
   * Off-group while another grouping lane is focused (Phase 5b).
   *
   * SUBTRACTIVE, never a wrapper `opacity`. Three lime things live inside a
   * block — the done checkbox, the multi-select mark, and the entire accent of a
   * project-less task — and lime is the one colour in this app that never fades;
   * `day-schedule.tsx` already refused a wrapper opacity once for exactly that.
   * So recession is spent on the plate, the edge and the rail ink, and every lime
   * mark inside stays at full strength.
   */
  receded?: boolean;
}) {
  const {
    getProjectColor,
    selectedDate,
    userTimezone,
    routines,
    programs,
    toggleTaskStatus,
    setItemSkipped,
    updateTask,
    updateHabit,
    moveTaskToDate,
    unscheduleTask,
    goals,
  } = usePlannerStore();
  const timeFormatStr = useTimeFormat();
  const isMobile = useIsMobile();
  // Raw goals, not the display list: this gates a write (lib/row-moves.ts).
  const milestoneIds = useMemo(() => milestoneItemIds(goals ?? []), [goals]);
  // Multi-select membership for this block. Modifier-click selects; a plain
  // click still opens the editor. The grid has no hover checkbox (the list
  // surfaces do) — its dense pane leaves no safe slot — so selection here is a
  // ring + modifier-click, discoverable once a selection exists elsewhere.
  const isMultiSelected = useSelectionStore((s) => s.selectedIds.has(entry.item.id));
  const isWeek = variant === 'week';
  const { item, itemType } = entry;
  const isTask = itemType === 'task';
  const task = isTask ? (item as Task) : null;
  const habit = !isTask ? (item as HabitItem) : null;

  const timezone = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const rowDate = date ?? selectedDate;
  const dateStr = toDateStr(rowDate, timezone);
  // Asked at THIS block's date, same as TaskRow and for the same reason: a week
  // column and the day view are different questions, and only the block knows
  // which one it is. Non-null only when the item is set aside, so it doubles as
  // the flag. Reaches the screen only with showPausedOnGrid on, since otherwise
  // deriveDayItems has already excluded it.
  const suppression = suppressionReason(item as Item, dateStr, {
    userTimezone: timezone,
    routines,
    programs,
  });
  const suppressed = !!suppression;
  const done = isTask
    ? isRecurring(task!)
      ? isCompletedOnDate(task!, dateStr)
      : task!.status === 'completed'
    : habit!.completedDates.includes(dateStr);

  // One CLASSIFY axis (039): the container's colour, whatever the type.
  const accent = item.project ? getProjectColor(item.project) : 'var(--primary)';

  // Drag-to-resize an own-timed block. Bottom edge changes duration; top edge
  // changes start (bottom fixed). Live preview from local state; the store write
  // lands on pointer-up.
  //
  // WHETHER a type may be resized is a registry capability, not a task-vs-habit
  // branch — habits declare `resizable: false` because habitShape carries no
  // `duration` field to write the result to, and custom types declare true and
  // ride the task pipeline. The projected `Task`/`Habit` doesn't type its own
  // discriminator, so the registry name is resolved the way TaskRow's
  // delete-confirm resolves it. Project blocks are still excluded outright: they
  // take their extent from the project, not from the item.
  const projected = item as { type?: string; customType?: string };
  const typeName = projected.type === 'custom' ? projected.customType! : itemType;
  const typeConfig = getItemTypeConfig(typeName);
  const canResize = typeConfig.schedule.resizable && !!item.startTime && !task?.inProjectBlock;
  // Same capability + recurrence gate the row uses (lib/item-registry
  // isSkippable), resolved against the projection's runtime discriminator.
  const skipped =
    typeConfig.skippable && isRecurring(item) && isSkippedOnDate(item, dateStr);
  const [preview, setPreview] = useState<{ startMin: number; duration: number } | null>(null);

  // Put-it-off verbs, same gates as the row (lib/row-moves.ts). Timed blocks
  // keep their clock time through the carry, so this one reappears at the same
  // hour on the next day; the braindump drops the time with the date.
  const todayStr = toDateStr(new Date(), timezone);
  const nextDay = nextDayTarget(dateStr, todayStr);
  const canNextDay = canMoveToNextDay(item, itemType, dateStr);
  const canBraindump = canSendToBraindump(item, itemType, dateStr, milestoneIds);
  // Which edge is under an active resize — drives the one lime glyph the target/
  // trim mark styles light on the handle being dragged (see HandleGrip). A ref
  // alone won't do: the grip has to re-render to recolour.
  const [activeEdge, setActiveEdge] = useState<'top' | 'bottom' | null>(null);
  const effStartMin = preview?.startMin ?? entry.startMin;
  const effDuration = preview?.duration ?? entry.duration;

  // Resize flips a global flag; the grid then expands to the full day at a frozen
  // scale (so the block doesn't rescale under the cursor) and we auto-scroll to
  // follow the dragged edge — so you can see and reach any target time. The edge
  // is tracked in CONTENT space (pointer delta + scroll delta), so both the
  // auto-scroll and the one-time expand-compensation extend the resize correctly.
  const setResizing = useScheduleResizeStore((s) => s.setResizing);
  const resizeRef = useRef<{
    edge: 'top' | 'bottom';
    startMin: number;
    duration: number;
    hourPx: number;
    viewport: HTMLElement | null;
    clientYBase: number;
    scrollTopBase: number | null;
  } | null>(null);
  const pointerYRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const snap = (m: number) => Math.round(m / 15) * 15;
  const minToTime = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const bucketForMin = (m: number): TimeBucket => {
    const h = Math.floor(m / 60);
    return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  };

  const applyResize = () => {
    const r = resizeRef.current;
    if (!r || !r.viewport) return;
    // Baseline scroll captured on first apply — AFTER the expand-compensation has
    // settled — so only genuine (auto/user) scrolling extends the resize.
    if (r.scrollTopBase === null) r.scrollTopBase = r.viewport.scrollTop;
    const deltaPx = pointerYRef.current - r.clientYBase + (r.viewport.scrollTop - r.scrollTopBase);
    const delta = (deltaPx / r.hourPx) * 60;
    if (r.edge === 'bottom') {
      setPreview({ startMin: r.startMin, duration: Math.max(15, snap(r.duration + delta)) });
    } else {
      const end = r.startMin + r.duration;
      const ns = Math.min(Math.max(0, snap(r.startMin + delta)), end - 15);
      setPreview({ startMin: ns, duration: end - ns });
    }
  };

  // While resizing, scroll the viewport when the cursor nears its top/bottom edge
  // and re-apply so the dragged edge keeps tracking the pointer as rows scroll in.
  const autoScrollTick = () => {
    const r = resizeRef.current;
    if (!r || !r.viewport) {
      rafRef.current = null;
      return;
    }
    const rect = r.viewport.getBoundingClientRect();
    // Week × Schedule pins its column heads over the grid, so the grid's
    // visible top is the heads' bottom, not the viewport's: measured from the
    // viewport, a top edge dragged upward vanished under the heads well before
    // anything scrolled.
    const head = r.viewport.querySelector('[data-week-head]');
    const top = head ? Math.max(rect.top, head.getBoundingClientRect().bottom) : rect.top;
    const EDGE = 56;
    const y = pointerYRef.current;
    let dy = 0;
    if (y > rect.bottom - EDGE) dy = Math.min(16, (y - (rect.bottom - EDGE)) / 3);
    else if (y < top + EDGE) dy = -Math.min(16, (top + EDGE - y) / 3);
    if (dy !== 0) {
      r.viewport.scrollTop += dy;
      applyResize();
    }
    rafRef.current = requestAnimationFrame(autoScrollTick);
  };

  const onResizeDown = (edge: 'top' | 'bottom', e: React.PointerEvent) => {
    // A finger never resizes. The hit zone is 12px tall (9px out, 3px in) and
    // its grip is smaller still — a target no fingertip can aim at, but that a
    // scrolling thumb crosses constantly, and every crossing captures the
    // pointer and commits a new duration on release. So on touch this is not a
    // feature with a poor hit area, it is a silent edit dispatched by the scroll
    // gesture. Declining leaves the touch to the browser (nothing is captured
    // and nothing is preventDefaulted), so the grid scrolls as it should; the
    // duration field in the item dialog is the touch path to the same edit.
    //
    // Gated on pointerType, like the drag sensors in lib/dnd/sensors.ts, and for
    // the same reason: a touchscreen laptop must keep mouse resize on the very
    // same element.
    if (isTouchPointer(e.nativeEvent)) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const viewport = (e.currentTarget as HTMLElement).closest(
      '[data-slot="scroll-area-viewport"]'
    ) as HTMLElement | null;
    resizeRef.current = {
      edge,
      startMin: entry.startMin,
      duration: entry.duration,
      hourPx,
      viewport,
      clientYBase: e.clientY,
      scrollTopBase: null,
    };
    pointerYRef.current = e.clientY;
    setPreview({ startMin: entry.startMin, duration: entry.duration });
    setActiveEdge(edge);
    setResizing(true);
    rafRef.current = requestAnimationFrame(autoScrollTick);
  };
  const onResizeMove = (e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    pointerYRef.current = e.clientY;
    applyResize();
  };
  const onResizeUp = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const r = resizeRef.current;
    const p = preview;
    resizeRef.current = null;
    setPreview(null);
    setActiveEdge(null);
    setResizing(false);
    if (!r || !p) return;
    // The write has to go through the action for the item's OWN type: the store
    // narrows updateTask to task-like (non-habit) items, so sending a habit
    // resize through it would preview correctly and then silently no-op on
    // release. Both actions take the same Partial shape.
    const commit = isTask ? updateTask : updateHabit;
    if (r.edge === 'bottom') {
      if (p.duration !== entry.duration) commit(item.id, { duration: p.duration });
    } else if (p.startMin !== entry.startMin || p.duration !== entry.duration) {
      commit(item.id, {
        startTime: minToTime(p.startMin),
        duration: p.duration,
        timeBucket: bucketForMin(p.startMin),
      });
    }
  };

  // Stop the auto-scroll loop if the block unmounts mid-resize.
  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
  }, []);

  // The rail span sits on the item's TRUE extent; the pane is nudged down and
  // trimmed so consecutive blocks show a seam. Both are driven off startY, so
  // the bead always lands exactly on the hour line the item starts at.
  const startY = ((effStartMin - gridStartMin) / 60) * hourPx;
  const spanH = (effDuration / 60) * hourPx;
  const top = startY + PANE_OFFSET;
  const height = Math.max(spanH - PANE_TRIM, PANE_MIN_H);

  /*
   * The overlap layout is computed from the STORE's extents, so the moment a
   * resize starts it is stale — `preview` is local state, `entry` never changes,
   * and the pass would keep describing a block that is no longer that shape for
   * the whole gesture. Dropping it mid-resize means you drag against honest
   * geometry and the pockets/columns re-form on release, which is the same
   * reasoning that already suppresses `canExpand` below.
   *
   * But only the TIME-DERIVED half is stale. `preview` moves a block's start and
   * duration; it cannot move it into another lane. Dropping the whole layout used
   * to mean dropping the band with it, and since lanes landed every block carries
   * one — so pressing a resize handle threw the block to the field's left edge,
   * spanning every lane, until pointer-up. `bandOnly` keeps the x half and clears
   * everything the new extents invalidate.
   */
  const L = preview ? bandOnly(layout) : layout;

  // Content sits in its free band when something covers this pane, and in the
  // whole pane otherwise. Everything downstream measures the BAND, not the pane:
  // a 7h container whose title lives in a 208px band above its child is still a
  // two-row block, and a 40px band inside a tall pane is not.
  const contentH = L?.contentHeight ?? height;
  const tall = contentH >= PANE_TALL_H;

  // How many lines of the title actually fit — the week column's answer to long
  // titles. text-content is 12/17, and the pane pays 6px of padding top and
  // bottom, so this is the honest count rather than a guess.
  const titleLines = Math.max(1, Math.floor((contentH - 12) / 17));

  /*
   * The pane's own edges, as CSS lengths, for everything that has to register
   * against them from outside: the corner registration and both resize handles.
   * When a conflict member's pane starts at `calc(50% + 6px)`, marks pinned to
   * the literal LANE_PX would annotate empty grid, so they anchor off these.
   */
  const paneLeftCss = L?.paneLeft ?? `${LANE_PX}px`;
  const paneRightCss = L?.paneRight ?? '0px';
  const handleLeft = paneLeftCss;
  const handleRight = paneRightCss;
  // Which corner + handle treatment to draw (Settings → Appearance → Schedule
  // handles). The forms are defined in BlockCorners / HandleGrip below.
  const scheduleMarkStyle = useViewStore((s) => s.scheduleMarkStyle);

  /*
   * NARROW is a width, not a view.
   *
   * Week columns have always wrapped the title and dropped the metadata rail
   * because 140px cannot hold "title · duration" on one line. But nothing about
   * that is week-specific — it is what any pane that narrow needs, and once the
   * day grid can split into channels it produces panes exactly that size. So the
   * gate is the pane's real width: a 140px day channel and a 140px week column
   * now render identically, which is the point.
   *
   * Wide day panes are untouched: with no overlap the fraction is 1 and an ~880px
   * pane is nowhere near the threshold, so the common case keeps its single
   * truncated line and its metadata rail exactly as before.
   */
  const paneWidthPx = fieldWidth != null ? fieldWidth * (L?.widthFraction ?? 1) : null;
  const narrow = isWeek || (paneWidthPx != null && paneWidthPx < PANE_WRAP_PX);

  // …and where even that isn't enough (a 30-minute block at the minimum hour
  // height is 34px — one line — and no amount of reclaimed width fixes that),
  // hovering grows the block past its slot to show the whole title. It is the
  // only in-place answer: the block's height is its DURATION, so the alternative
  // is a popover, and this keeps the text where you were already looking.
  // Suppressed mid-resize, where the height is the thing being edited.
  // Follows `narrow` for the same reason the content treatment does — a squeezed
  // day channel needs the escape hatch just as much as a week column.
  const canExpand = narrow && !preview;

  // Done de-colours the rail with its bead: they are one glyph, not two states.
  // Off-group does the same, one step lighter — the rail is where the block's
  // identity lives, so it is the right thing to spend a recession on.
  const railColor = done
    ? 'color-mix(in oklab, var(--muted-foreground) 45%, transparent)'
    : receded
      ? 'var(--grp-off-ink)'
      : accent;

  // Blocks are drag sources — drop on another hour to reschedule, or on the
  // Anytime section to un-time. The source stays in place (dimmed) while the
  // DragOverlay ghost moves — same as TaskRow, and cheaper to repaint than
  // transforming this shadowed block every pointermove. Post-drop click guard
  // keeps a drop from opening the edit dialog.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: item.id });
  const wasDraggedRef = useRef(false);
  useEffect(() => {
    if (isDragging) {
      wasDraggedRef.current = true;
      return;
    }
    if (wasDraggedRef.current) {
      const t = setTimeout(() => {
        wasDraggedRef.current = false;
      }, 0);
      return () => clearTimeout(t);
    }
  }, [isDragging]);

  // A skipped occurrence collapses on the timeline the same way it collapses in
  // a list row (#194/#195): the bead still pins WHEN it was meant to happen, but
  // the block stops claiming its duration. Blocks are absolutely positioned, so
  // shrinking one reflows nothing — the hour it vacates simply reads as free.
  // Gated on the registry capability, so recurring tasks and recurring custom
  // types collapse here exactly as habits do.
  if (skipped) {
    return (
      <div
        data-testid="schedule-block"
        data-item-id={item.id}
        data-item-kind={itemType}
        data-item-type={typeName}
        data-row-variant="skipped"
        data-completed="false"
        data-start-min={entry.startMin}
        data-duration={entry.duration}
        // Same pointer contract as a live block: the wrapper (and so the 12px
        // lane) stays click-through to the hour slot underneath; only the strip
        // itself opts back in.
        //
        // A skipped block still takes its channel from the overlap pass. It
        // collapses in HEIGHT only — it keeps its horizontal band, so a skipped
        // occupant of a cluster doesn't stretch back across its neighbours'
        // channels the way an unpositioned block would.
        className={cn(
          'pointer-events-none absolute h-[24px]',
          !L && 'left-0 right-1',
          'z-[var(--blk-z)]'
        )}
        style={
          {
            top,
            '--blk-z': L?.z ?? 2,
            ...(L ? { left: L.left, right: L.right } : null),
          } as React.CSSProperties
        }
      >
        {L?.startTie && (
          <span
            aria-hidden
            className="pointer-events-none absolute border-t border-[var(--sched-rail)]"
            style={{ left: 6, right: L.startTie, top: -PANE_OFFSET }}
          />
        )}
        <span
          aria-hidden
          className="absolute w-[2px] rounded-[1px] bg-muted-foreground/35"
          style={{ left: L?.railX ?? 5, top: -PANE_OFFSET, height: 24 }}
        />
        <span
          aria-hidden
          className="absolute h-[6px] w-[6px] rounded-full bg-muted-foreground/45 shadow-[0_0_0_1px_var(--canvas)]"
          style={{ left: L?.beadX ?? 3, top: -PANE_OFFSET - 3 }}
        />
        <div
          onClick={() => openEditFor(item, itemType)}
          style={{ marginLeft: LANE_PX }}
          className="pointer-events-auto flex h-full cursor-pointer items-center gap-1.5 rounded-[5px] bg-surface-3/60 px-2 hover-wash"
        >
          <SkipForward className="h-3 w-3 flex-shrink-0 text-muted-foreground/60" />
          <span className="min-w-0 flex-1 truncate font-content text-content text-muted-foreground/70">
            {item.title}
          </span>
          <button
            type="button"
            title="Unskip"
            aria-label="Unskip"
            data-testid="item-unskip-button"
            onClick={(e) => {
              e.stopPropagation();
              setItemSkipped(item.id, false, rowDate);
            }}
            className="-mr-1 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-[4px] text-muted-foreground hover-wash hover:text-foreground"
          >
            <Undo2 className="h-3 w-3" />
          </button>
        </div>
      </div>
    );
  }

  const checkbox = isTask ? (
    <button
      onClick={(e) => {
        e.stopPropagation();
        toggleTaskStatus(item.id, undefined, isRecurring(task!) ? rowDate : undefined);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      aria-label={done ? 'Mark incomplete' : 'Mark complete'}
      className={cn(
        // Transparent, not filled: the pane behind it is already tinted glass,
        // and a second fill inside it reads as a box within a box.
        'mt-px flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-[5px] border bg-transparent transition-colors',
        done ? 'border-primary bg-primary' : 'border-muted-foreground/45 hover:border-primary'
      )}
    />
  ) : null;

  /*
   * The block's hover controls. Revealed only under a real hover pointer —
   * `:hover` sticks after a tap on a touch screen, and an invisible button that
   * takes the first tap would carry the item off unasked (the same guard the
   * week recede sits under) — and on keyboard focus of the pane. Never while
   * resizing, where the pane's shape is the thing being edited, and never on a
   * phone, where a tap opens the editor instead. The capsule is opaque so it
   * reads cleanly over the duration it covers on a wide pane.
   */
  const showControls = (canNextDay || canBraindump) && !preview && !isMobile;
  const controls = showControls ? (
    <RowControlGroup
      data-testid="block-controls"
      onPointerDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {canNextDay && (
        <RowControl
          icon={Redo2}
          label={nextDayLabel(nextDay, todayStr)}
          detail={formatTargetDay(nextDay)}
          testId="item-tomorrow-button"
          onClick={() => moveTaskToDate(item.id, nextDay)}
        />
      )}
      {canBraindump && (
        <RowControl
          icon={ArrowLeftToLine}
          label="Move to Braindump"
          testId="item-unschedule-button"
          onClick={() => unscheduleTask(item.id)}
        />
      )}
    </RowControlGroup>
  ) : null;
  const revealControls =
    'pointer-events-none opacity-0 transition-opacity [@media(hover:hover)_and_(pointer:fine)]:group-hover/blk:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:group-hover/blk:opacity-100 group-has-[:focus-visible]/blk:pointer-events-auto group-has-[:focus-visible]/blk:opacity-100';

  const titleClass = cn(
    'min-w-0 flex-1 font-content text-content text-foreground',
    // Set aside (showPausedOnGrid). Muted, never struck through and never a
    // wash over the whole block: the accent bar is `var(--primary)` on an
    // unprojected task, and fading the pane would take the lime down with it.
    suppressed && 'text-muted-foreground',
    // Same treatment as set-aside, and for the same reason: the title carries
    // the recession so the plate does not have to fade the marks inside it.
    receded && !done && 'text-muted-foreground',
    done && 'text-muted-foreground line-through opacity-60'
  );

  return (
    // The wrapper is the block's real extent: lane + pane. It is
    // pointer-events-none so the 12px lane stays click-through to the hour slot
    // underneath, with the pane and the resize targets opting back in — hover
    // still propagates up here from those children, which is what drives the
    // registration marks and the z-index raise.
    <div
      data-testid="schedule-block"
      data-item-id={item.id}
      data-item-kind={itemType}
      data-item-type={typeName}
      // A skipped block is a different DOM shape under the same testid (no
      // checkbox, no resize handles) — same disambiguation TaskRow carries.
      data-row-variant="default"
      data-completed={done ? 'true' : 'false'}
      data-suppressed={suppressed ? 'true' : 'false'}
      data-multiselected={isMultiSelected ? 'true' : 'false'}
      // Duration and start are the whole point of a schedule block, and both
      // are otherwise encoded only in inline pixel styles. These make the
      // hour-drop and resize outcomes assertable.
      data-start-min={effStartMin}
      data-duration={effDuration}
      className={cn(
        'group/blk pointer-events-none absolute h-[var(--blk-h)]',
        // No layout → the literal classes this block has always carried.
        !L && 'left-0 right-1',
        // z travels through a custom property rather than an interpolated class:
        // Tailwind's JIT only keeps class names it can see as literals, which
        // this file already documents at LINE_CLAMP.
        'z-[var(--blk-z)] hover:z-[var(--blk-zh)]',
        // The hover-expand. Everything that annotates the block — corners,
        // caliper marks — hangs off this wrapper, so they travel with it and the
        // grown block stays a coherent object rather than a pane escaping its
        // own registration.
        canExpand && 'hover:h-auto hover:min-h-[var(--blk-h)]',
        isDragging && 'opacity-50'
      )}
      style={
        {
          top,
          '--blk-h': `${height}px`,
          // The registration marks' ink: neutral --ink-1 normally, lime when the
          // block is selected. This is how selection reads THROUGH a hover — the
          // pane brightness is shared, but the mark colour is not (see BlockCorners).
          '--blk-mk': isMultiSelected && !done ? 'var(--primary)' : 'var(--ink-1)',
          '--blk-z': L?.z ?? 2,
          // A container lifts by ONE on hover, never to the leaf lift: raising it
          // to the top would put it above its own child, and since the pointer
          // has to cross the parent to reach the child, the parent would latch
          // :hover and the child could never be hovered or clicked at all.
          '--blk-zh': L?.zHover ?? HOVER_Z,
          ...(L ? { left: L.left, right: L.right } : null),
        } as React.CSSProperties
      }
    >
      {/* The start-tie: a real double-booking's "these begin together" cue.
          Drawn once, by the unit's first member (whose wrapper still spans the
          whole band), it runs along the shared start line from its own bead to
          the last member's. It replaces the old fat-rail-plus-compound-bead
          signal now that each member's rail sits beside its own tiled pane.
          Muted, like the branch ticks — a mark, never a badge. Rendered before
          the rail and bead so the beads paint over its ends. `left: 6` is the
          first bead's centre (beadX '3px' + half its 6px width). */}
      {L?.startTie && (
        <span
          aria-hidden
          className="pointer-events-none absolute border-t border-[var(--sched-rail)]"
          style={{ left: 6, right: L.startTie, top: -PANE_OFFSET }}
        />
      )}
      {/* The rail's accent span: the lane's 1px hairline swells to 2px for the
          duration of the event, so the accent has real extent on the grid rather
          than being a stripe glued to the card. Offset back up by PANE_OFFSET to
          undo the pane's nudge — this sits on the true start and end. */}
      {/* When two items are booked at the same time they tile side by side, each
          with its own rail beside its own pane; the start-tie above is what marks
          them as the same slot. */}
      <span
        aria-hidden
        className="absolute w-[2px] rounded-[1px]"
        style={{ left: L?.railX ?? 5, top: -PANE_OFFSET, height: spanH, background: railColor }}
      />
      {/* The start bead, punched out of the canvas so two beads 15 minutes apart
          still read as two at the minimum hour height. A NESTED bead is punched
          out of its parent's plate instead — it is mounted on the field, not on
          the grid. A double-booking's beads no longer meet: each rides its own
          tile beside its pane (see beadX), and the start-tie above links them. */}
      <span
        aria-hidden
        className="absolute h-[6px] w-[6px] rounded-full"
        style={{
          left: L?.beadX ?? 3,
          top: -PANE_OFFSET - 3,
          background: railColor,
          boxShadow: `0 0 0 1px ${L?.beadOnPocket ? 'var(--surface-2)' : 'var(--canvas)'}`,
        }}
      />

      {/* The channel forks ONCE per child, in the container's own lane, at the
          child's true start. A full-height inner rule would run a second
          near-parallel line down every column, which week-schedule.tsx already
          rejects in as many words. */}
      {L?.branchTicks.map((y, i) => (
        <span
          key={i}
          aria-hidden
          className="pointer-events-none absolute left-[6px] w-[6px] border-t border-[var(--sched-rail)]"
          style={{ top: y }}
        />
      ))}

      {/* The pane. overflow-hidden for the wash and the title, which is exactly
          why the registration marks below are siblings, not children. */}
      <div
        ref={setNodeRef}
        // The wrapper is the block's BAND, and a double-booking's members all
        // share one band — only their panes tile inside it. So the pane is the
        // only honest handle on "this item's pixels", for a test or anything else.
        data-slot="pane"
        {...attributes}
        {...listeners}
        // The pane is the block's only stable handle: the wrapper is
        // pointer-events-none and the title is inside a content box that changes
        // shape with the pane's width. `receded` rides it because that is the
        // element the recession is spent on.
        data-block-id={item.id}
        data-receded={receded ? 'true' : 'false'}
        onClick={(e) => {
          if (wasDraggedRef.current) return;
          const selection = useSelectionStore.getState();
          if (e.metaKey || e.ctrlKey) {
            selection.toggle(item.id);
            return;
          }
          if (e.shiftKey) {
            selection.selectRange(rangeIds(selection.anchorId, item.id));
            return;
          }
          selection.replace([item.id]);
          openEditFor(item, itemType);
        }}
        className={cn(
          // In flow, not absolute: the wrapper's hover-expand height is `auto`,
          // and an absolutely positioned pane would contribute nothing to it.
          'pointer-events-auto relative h-full cursor-grab touch-manipulation overflow-hidden rounded-[5px] border border-border active:cursor-grabbing',
          // …but `h-full` against that `auto` wrapper is a percentage of an
          // indefinite height, so it collapses the pane to its CONTENT. On a
          // block whose slot is taller than its title (a 3-hour block holding
          // two lines) the pane shrank out from under the cursor on hover, hover
          // was lost — the wrapper is pointer-events-none, so the pane is the
          // only target — the pane sprang back, and the block flickered between
          // the two sizes forever. The floor makes hovering a block that already
          // fits a no-op, and only a genuinely clipped title grows past it.
          canExpand && 'min-h-[var(--blk-h)]',
          'bg-[var(--sched-pane)] shadow-[var(--sched-shadow)] transition-[background-color,box-shadow] duration-150',
          // A NESTED plate is not glass. There is nothing informative behind it —
          // it sits in a pocket in its parent, not on the hour grid — and on
          // white, 94%-opaque over 80%-opaque is 0.00003 L apart, so translucency
          // cannot express this step at all in light mode. Solid surface-2 over
          // the pocket's ~0.975 is a real value step in both themes.
          L?.solid && !done && 'bg-[var(--surface-2)]',
          // Done recedes by thinning the plate and switching the lit edge off,
          // never by fading the whole block — opacity here composites the lime
          // checkbox down to olive. The text carries the rest of the fade.
          done
            ? 'bg-[var(--sched-pane-done)] shadow-[var(--sched-shadow-done)]'
            : 'hover:bg-[var(--sched-pane-hover)] hover:shadow-[var(--sched-shadow-hover)]',
          // Off-group: the plate thins and trades its modelling for a hairline.
          // It KEEPS its hover lamp — a receded block is still a live target you
          // can read, click and drag; recession says "not what you asked about",
          // not "unavailable". Ordered after `done` so a finished off-group block
          // stays finished-looking, which is the more specific fact.
          // shadow-[var(--sched-shadow-off)], never the literal ring: see the
          // token's own note in globals.css. A raw `shadow-[0_0_0_1px_…]` lands
          // in a different tailwind-merge group from the base shadow, so both
          // survive cn() and Tailwind's alphabetical utility order hands it to
          // the base — the hairline never paints, in either theme.
          receded && !done && 'bg-[var(--grp-off-pane)] shadow-[var(--sched-shadow-off)]',
          // Selected brightens the pane — lit brighter than hover, its own
          // latched state (the list rows latch a wash; a grid block latches the
          // lamp). Kept off `done` blocks, whose lamp is deliberately out.
          isMultiSelected && !done && 'bg-[var(--sched-pane-selected)] shadow-[var(--sched-shadow-hover)]'
        )}
        style={{ marginLeft: L?.paneLeft ?? LANE_PX, marginRight: L?.paneRight ?? 0 }}
      >
        {/* The pockets — one sunk well per child, above the wash and below the
            content. This is what makes containment read in light mode, and the
            reason this direction beat the ones that expressed depth with alpha. */}
        {L?.pockets.map((p, i) => (
          <span
            key={i}
            aria-hidden
            className="pointer-events-none absolute left-[2px] right-0 z-[1] bg-[var(--sched-pocket)] shadow-[var(--sched-pocket-lip)]"
            style={{ top: p.top, height: p.height }}
          />
        ))}
        {/* The emission wash — the accent bleeding off the rail-facing edge into
            the plate. Three stops, not two: a bright edge, a fast falloff by
            40px, then a long tail out to the reach. A straight two-stop ramp
            reads as a stripe with a soft right edge; this reads as light falling
            across the card and dissolving into it.

            Wide panes only. Across a 140px column an 84px gradient is more than
            half the pane, which is a coloured container by area — and that was
            always an argument about WIDTH, not about which view you are in, so it
            keys off the same threshold the content treatment does. */}
        {/* The wash is the block's lamp, and an off-group block is not lit. It
            goes rather than dimming: the gradient is built from the item's own
            accent, so fading it would be exactly the "lime through an opacity"
            move the recession rule forbids. */}
        {!done && !narrow && !receded && (
          <span
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-0 z-0 transition-opacity duration-150',
              // A container stops being a lamp and becomes the FIELD its contents
              // are lit against, so its own wash goes ambient. Without this the
              // child's wash reads as a second light source inside the first.
              L?.wash === 'field'
                ? 'opacity-[var(--sched-wash-field)]'
                : 'opacity-[var(--sched-wash)] group-hover/blk:opacity-[var(--sched-wash-hover)]'
            )}
            style={{
              background:
                `linear-gradient(90deg,` +
                ` color-mix(in oklab, ${accent} 32%, transparent) 0px,` +
                ` color-mix(in oklab, ${accent} 12%, transparent) 40px,` +
                ` transparent var(--sched-wash-reach))`,
            }}
          />
        )}

        {/*
          The content, re-anchored into its free band when something covers this
          pane. This is the move that actually fixes the reported bug: a 7-hour
          container used to centre its title over its WHOLE pane, so with a 3-hour
          task covering the bottom the title landed under it. Now it centres in the
          band above.

          The height goes through a custom property, never an inline `height`: an
          inline height on this div pins the indefinite-height chain that week's
          `canExpand` rides, which would kill hover-expand for every block in the
          grid. As a var it can be released on hover instead.
        */}
        <div
          className={cn(
            'relative z-[2] flex min-w-0 flex-col gap-px',
            L?.contentHeight != null ? 'h-[var(--clr-h)]' : 'h-full',
            canExpand && 'group-hover/blk:h-auto',
            narrow ? 'justify-start py-1.5 pl-1.5 pr-1' : 'justify-center pl-2.5 pr-2'
          )}
          style={
            L?.contentHeight != null
              ? ({ marginTop: L.contentTop ?? 0, '--clr-h': `${L.contentHeight}px` } as React.CSSProperties)
              : undefined
          }
        >
          {narrow ? (
            /* Narrow panes: the title WRAPS to every line the block's height can
               actually hold, and nothing competes with it for the width. The
               start time is gone — the bead already pins it on the rail and the
               shared gutter reads it off — and so are the duration and the
               priority glyph, which between them cost about a quarter of a 140px
               column. Height is finite, so the wrap is clamped rather than
               allowed to spill; hovering releases the clamp and grows the block
               (see canExpand), which is what makes the whole title readable
               without a tooltip. */
            <>
              <div className="flex min-w-0 items-start gap-1.5">
                {checkbox}
                <span
                  className={cn(
                    titleClass,
                    'break-words',
                    LINE_CLAMP[Math.min(titleLines, LINE_CLAMP.length) - 1],
                    canExpand && 'group-hover/blk:line-clamp-none'
                  )}
                  title={item.title}
                >
                  {item.title}
                </span>
              </div>
              {/* No width to overlay here without covering the title, so the
                  controls take their own row under it, shown only on hover. The
                  row is part of what hover grows the block to fit (canExpand is
                  always on here, since controls never show mid-resize), the same
                  transient grow a clipped title already gets. Hover only, not
                  keyboard focus: focus doesn't grow the block, so a focus-shown
                  row would sit clipped below the pane; while hidden it is out of
                  the tab order. */}
              {controls && (
                <div className="hidden pt-1 pl-[22px] [@media(hover:hover)_and_(pointer:fine)]:group-hover/blk:flex">
                  {controls}
                </div>
              )}
            </>
          ) : tall ? (
            <>
              <div className="relative flex min-w-0 items-center gap-2">
                {checkbox}
                <span className={cn(titleClass, 'truncate')}>{item.title}</span>
                {effDuration > 0 && (
                  <RollingMetaText
                    value={effDuration}
                    format={formatDuration}
                    active={!!preview}
                    className={cn('flex-shrink-0', done && 'opacity-60')}
                  />
                )}
                {controls && (
                  <span className={cn('absolute right-0 top-1/2 -translate-y-1/2', revealControls)}>{controls}</span>
                )}
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <MetaText className={cn('min-w-0 flex-1 truncate', done && 'opacity-60')}>
                  {formatClock(effStartMin, timeFormatStr, false)}–
                  {formatClock(effStartMin + effDuration, timeFormatStr, false)}
                </MetaText>
                {task?.priority && <PriorityGlyph priority={task.priority} className={cn(done && 'opacity-60')} />}
              </div>
            </>
          ) : (
            <div className="relative flex min-w-0 items-center gap-2">
              {checkbox}
              <span className={cn(titleClass, 'truncate')}>{item.title}</span>
              <span className={cn('flex flex-shrink-0 items-center gap-2', done && 'opacity-60')}>
                {task?.priority && <PriorityGlyph priority={task.priority} />}
                {effDuration > 0 && (
                  <RollingMetaText value={effDuration} format={formatDuration} active={!!preview} />
                )}
              </span>
              {controls && (
                <span className={cn('absolute right-0 top-1/2 -translate-y-1/2', revealControls)}>{controls}</span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Registration corners — the block's hover/select chrome, in whichever
          style the user picked (Settings → Appearance → Schedule handles). Each
          anchors off the PANE's own inset, not the literal LANE_PX: a tiled
          conflict member's pane starts at 50%, and marks left behind at x=8 would
          register a pane that is not there. Aria-hidden; revealed on hover. */}
      <BlockCorners
        style={scheduleMarkStyle}
        paneLeftCss={paneLeftCss}
        paneRightCss={paneRightCss}
        selected={isMultiSelected}
      />

      {/* Resize handles — drag the top or bottom edge to set start/duration. The
          hit zone straddles the edge (9px out, 3px in) so the target stays
          reachable; the visible grip inside it (HandleGrip) follows the chosen
          mark style and lights one lime glyph on the edge being dragged.

          A FLUSH shared edge — a container and its child both ending 17:00 — would

          A FLUSH shared edge — a container and its child both ending 17:00 — would
          otherwise put two full-width strips 0px apart and make the parent's edge
          unreachable. The parent's handle retreats into its own LANE instead: a
          20px grabber at left:0 where a nested child never reaches. The
          alternative was trimming the child 7px, which at hourPx 40 is a lie about
          ten and a half minutes. */}
      {canResize && (
        <>
          <div
            onPointerDown={(e) => onResizeDown('top', e)}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onClick={(e) => e.stopPropagation()}
            className="pointer-events-auto absolute -top-[9px] z-[3] h-3 cursor-ns-resize"
            style={
              L?.handleTopLane
                ? { left: 0, width: LANE_PX + 8 }
                : { left: handleLeft, right: handleRight }
            }
            aria-label="Resize start"
          >
            <HandleGrip style={scheduleMarkStyle} edge="top" active={activeEdge === 'top'} selected={isMultiSelected} />
          </div>
          <div
            onPointerDown={(e) => onResizeDown('bottom', e)}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onClick={(e) => e.stopPropagation()}
            className="pointer-events-auto absolute -bottom-[9px] z-[3] h-3 cursor-ns-resize"
            style={
              L?.handleBottomLane
                ? { left: 0, width: LANE_PX + 8 }
                : { left: handleLeft, right: handleRight }
            }
            aria-label="Resize duration"
          >
            <HandleGrip style={scheduleMarkStyle} edge="bottom" active={activeEdge === 'bottom'} selected={isMultiSelected} />
          </div>
        </>
      )}
    </div>
  );
}

export function DaySchedule({ activeId }: { activeId: string | null }) {
  const day = useDayItems();
  const { selectedDate, navDirection, userTimezone, showCurrentTimeIndicator } = usePlannerStore();
  const timeFormatStr = useTimeFormat();
  const dragging = !!activeId;
  const timezone = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const nowMin = useNowMinutes(timezone);

  const { isOver: isOverAnytime, setNodeRef: setAnytimeRef } = useDroppable({
    id: 'unscheduled:anytime',
  });

  const untimed = useMemo(() => deriveUntimedRows(day), [day]);
  const timed = useMemo(() => deriveTimedEntries(day), [day]);
  const overlapEntries = useMemo(() => toOverlapEntries(timed), [timed]);

  /**
   * Finished rows sink to the foot of each Anytime section, held a moment and
   * then slid (hooks/use-sink-hold.ts), like every other untimed row list. The
   * strip is one droppable with no per-row drop zones, so nothing resolves a
   * drop against a neighbour's position here; the hour grid below is where
   * position means time, and it is untouched.
   */
  const { completedAs, rootRef: anytimeRootRef } = useSinkHold(setAnytimeRef);
  const completionDateStr = toDateStr(selectedDate, timezone);

  // The Anytime strip sections like any other row list. `'none'` comes back as a
  // single unlabelled group, which renders as today's flat strip.
  const canvasGroupBy = useCanvasGroupBy();
  const routines = usePlannerStore((s) => s.routines);
  const programs = usePlannerStore((s) => s.programs);
  const goals = usePlannerStore((s) => s.goals);
  const untimedGroups = useMemo(
    () =>
      (groupBySupport('day', 'schedule', canvasGroupBy).honoured
        ? groupRows(untimed, canvasGroupBy, { routines, programs, goals })
        : [{ key: '', label: '', rows: untimed }]
      ).map((g) => ({ ...g, rows: sinkCompleted(g.rows, completionDateStr, completedAs) })),
    [untimed, canvasGroupBy, routines, programs, goals, completionDateStr, completedAs]
  );
  /** True when the strip renders real sections rather than one flat list. */
  const grouped = untimedGroups.some((g) => g.label);

  // The marker only exists on today, and only if the setting allows it —
  // Settings → "Show current time indicator" sat there for a long time with
  // nothing to switch; this is the thing it switches.
  const isToday = toDateStr(selectedDate, timezone) === toDateStr(new Date(), timezone);
  const markerMin = showCurrentTimeIndicator && isToday ? nowMin : null;

  // Content-fit hour window when idle; the full day while dragging (every hour a
  // drop target) or resizing (see/reach any target time). Rows shrink to fit the
  // pane; during resize the scale is frozen and the grid auto-scrolls instead.
  //
  // On today the window is also widened to contain the live clock, so the marker
  // always has somewhere to land. Without that it silently disappeared whenever
  // the hour happened to fall outside what's scheduled — at 7am on a day that
  // starts at 9, which is exactly when you most want to see where "now" is.
  const resizing = useScheduleResizeStore((s) => s.resizing);
  // Width of the events layer, which is what the overlap pass turns into "as many
  // channels as actually fit at MIN_CHANNEL_PX". This is the whole mobile answer:
  // the same component in a ~294px field gets two channels instead of six without
  // either shell having to say so.
  //
  // FROZEN during a drag or a resize. The lane budget is derived from this
  // width, so an unfrozen measurement lets a lane count change mid-gesture —
  // and the blocks would then jump sideways under the cursor that is dragging
  // one of them. Nothing else reads it in a way a stale value can hurt: the
  // channel count and the wrap threshold both degrade gracefully for the length
  // of one gesture.
  const { fieldWidth, fieldRef } = useFieldWidth(dragging || resizing);
  const contentRange = useMemo(() => deriveGridRange(timed, markerMin), [timed, markerMin]);
  const { gridStartHour, gridEndHour } = dragging || resizing ? FULL_DAY_RANGE : contentRange;
  const hours = Array.from({ length: gridEndHour - gridStartHour }, (_, i) => gridStartHour + i);
  const { hourPx, anchorRef } = useFitHourPx(hours.length, resizing);
  useResizeScrollCompensation(gridStartHour, hourPx, resizing, anchorRef);

  // Still a range check: the drag/resize override swaps in the full day, and the
  // widening above doesn't apply to it.
  const showNow = markerMin !== null && markerMin >= gridStartHour * 60 && markerMin < gridEndHour * 60;
  const nowMinShown = showNow ? markerMin! : null;
  const nowY = showNow ? ((markerMin! - gridStartHour * 60) / 60) * hourPx : null;
  const eclipsedHour =
    nowMinShown !== null && ((nowMinShown % 60) / 60) * hourPx < ECLIPSE_PX
      ? Math.floor(nowMinShown / 60)
      : null;

  /**
   * The grouping's answer on x: lanes, or focus (lib/schedule-lanes.ts).
   *
   * Built from the TIMED rows only. The Anytime strip above sections by the same
   * grouping but with headings, and a group that exists only up there has no lane
   * to name — a cap over an empty band would be a channel with nothing in it.
   */
  const lanePlan = useMemo(
    () =>
      planLanes(
        timed.map((e) => ({ itemType: e.itemType, item: e.item })),
        canvasGroupBy,
        { variant: 'day', fieldWidth, routines, programs, goals }
      ),
    [timed, canvasGroupBy, fieldWidth, routines, programs, goals]
  );
  const focusedKey = useScheduleFocusStore((s) => s.focusedKey);

  /**
   * Where overlapping blocks go. Keyed on hourPx because a pane floored at
   * PANE_MIN_H covers grid it does not own, so the PAINTED extents the pass packs
   * on move with the scale — the TOPOLOGY does not, by construction.
   *
   * ONE PASS PER LANE. That is not an optimisation, it is the semantics: two
   * blocks in different lanes may share a time but never a column, so they are
   * not a conflict and must not cluster, column-pack or occlude each other. The
   * lane's band goes in as the pass's root, and every rule inside it — packing,
   * containment, the inset cascade, the content band — then runs against the
   * lane's width instead of the field's.
   */
  const overlap = useMemo(() => {
    const base = { hourPx, gridStartMin: gridStartHour * 60, variant: 'day' as const, fieldWidth };
    if (lanePlan.mode !== 'lanes') return layoutOverlaps(overlapEntries, base);

    const merged: OverlapLayout = new Map();
    for (const lane of lanePlan.lanes) {
      const inLane = overlapEntries.filter((e) => lanePlan.laneOf.get(e.id) === lane.key);
      const sub = layoutOverlaps(inLane, {
        ...base,
        root: { leftPct: lane.leftPct, rightPct: lane.rightPct },
      });
      for (const [id, L] of sub) merged.set(id, L);
    }
    return merged;
  }, [overlapEntries, hourPx, gridStartHour, fieldWidth, lanePlan]);

  return (
    <ScrollArea className="h-full flex-1">
      <div
        key={`${selectedDate.toDateString()}-${navDirection ?? 'none'}`}
        className={cn(
          'canvas-container space-y-4 py-6 pb-20',
          navDirection && `animate-slide-in-from-${navDirection === 'left' ? 'right' : 'left'}`
        )}
      >
        {/* Above everything, because it qualifies everything below it: this day
            is missing work, and here is what is holding it. Renders on no other
            day — see ProgramNotice. */}
        <ProgramNotice className="px-1" />

        {/* ANYTIME — untimed items; drop here to keep something time-free */}
        {(untimed.length > 0 || dragging) && (
          <div
            ref={anytimeRootRef}
            data-dnd-id="unscheduled:anytime"
            data-dnd-over={isOverAnytime ? 'true' : 'false'}
            // mb-8 rather than padding, so the drop ring hugs the rows and not
            // the gap. It overrides the parent's space-y-4 bottom margin (a
            // zero-specificity :where rule), so the list sits 32px above the
            // timeline instead of 16px.
            className={cn('mb-8 rounded-card transition-colors', isOverAnytime && 'bg-primary/5 ring-2 ring-ring/50')}
          >
            {/* The grid below cannot take headings — a row's y position IS its
                time, so a section either breaks the axis or floats free of it.
                This strip is an ordinary row list and can; the grid gets the
                same partition expressed on x, as lanes.

                The strip's own "Anytime" heading gives way to the group headings
                rather than sitting above them. Nesting them read as a stutter at
                best and as a literal "Anytime › Anytime" when grouping by time
                bucket, and the strip is already identified by its position and
                its drop target. */}
            {grouped ? (
              untimedGroups.map((g) => (
                <GroupSection key={g.key} groupKey={g.key} label={g.label} gate={g.gate} variant="canvas">
                  {g.rows.map((row) => (
                    <TaskRow key={row.item.id} row={row} />
                  ))}
                </GroupSection>
              ))
            ) : (
              <GroupSection label="Anytime" variant="canvas">
                {/* groupRows returns [] for an empty strip, which renders while dragging. */}
                {(untimedGroups[0]?.rows ?? []).map((row) => (
                  <TaskRow key={row.item.id} row={row} />
                ))}
                {untimed.length === 0 && dragging && (
                  <div className="py-2 text-center text-xs text-muted-foreground/50">
                    Drop here to keep it time-free
                  </div>
                )}
              </GroupSection>
            )}
          </div>
        )}

        {/* The partition's only caption. Above the grid rather than inside it,
            because it names the x axis — and sticky, so it survives a scroll
            down a long day. */}
        <LaneCapRow plan={lanePlan} fieldLeft={DAY_FIELD_LEFT} />

        {/* Hour grid with absolutely positioned blocks */}
        <div ref={anchorRef} className="relative">
          <div>
            {hours.map((hour, i) => (
              <HourSlot
                key={hour}
                hour={hour}
                isActive={dragging}
                label={formatHourLabel(hour, timeFormatStr)}
                isFirst={i === 0}
                hourPx={hourPx}
                eclipsed={eclipsedHour === hour}
              />
            ))}
          </div>

          {/* The live time takes its place in the gutter's own column — same
              left edge, same face and size as every hour label, so it reads as
              one of them rather than as a chip floating over the grid. Lime and
              medium weight mark it as the living one; it is centred on the rule
              where the hour labels are top-aligned, which is the other half of
              why the label it lands on steps aside. */}
          {nowY !== null && (
            <span
              className={cn(
                'pointer-events-none absolute left-0 z-[6] -translate-y-1/2 font-num text-2xs font-medium text-success-text',
                DAY_GUTTER_INSET
              )}
              style={{ top: nowY }}
            >
              {formatClock(nowMinShown!, timeFormatStr)}
            </span>
          )}

          {/* The events layer: lane on the left, panes to the right of it. Top
              is flush with the grid — the old 4px nudge now lives inside the
              block (PANE_OFFSET) so the rail and bead can still sit on the true
              hour line while the pane clears its neighbour. */}
          <div ref={fieldRef} className="absolute bottom-0 right-0 top-0" style={{ left: DAY_FIELD_LEFT }}>
            {/* One rail per lane. The hour rules deliberately do NOT break at a
                lane boundary — the grammar is "y is shared, x is categorical",
                and ruling each lane separately would draw a table, which claims
                the cells are independent of each other. The rail is what says
                where a lane begins. */}
            {(lanePlan.mode === 'lanes' ? lanePlan.lanes : [{ key: 'field', leftPct: 0 }]).map((lane) => (
              <span
                key={lane.key}
                aria-hidden
                className="pointer-events-none absolute bottom-0 top-0 w-px bg-[var(--sched-rail)]"
                style={{ left: `calc(${lane.leftPct}% + 5px)` }}
              />
            ))}
            {timed.map((entry) => (
              <ScheduleBlock
                key={entry.item.id}
                entry={entry}
                gridStartMin={gridStartHour * 60}
                hourPx={hourPx}
                layout={overlap.get(entry.item.id)}
                fieldWidth={fieldWidth}
                receded={isReceded(lanePlan, focusedKey, entry.item.id)}
              />
            ))}
            {nowY !== null && (
              <NowMarker
                top={nowY}
                lanes={lanePlan.mode === 'lanes' ? lanePlan.lanes.map((l) => l.leftPct) : undefined}
              />
            )}
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}
