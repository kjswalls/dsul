'use client';

import { useMemo } from 'react';
import { format, startOfWeek, addDays, isToday, isSameDay } from 'date-fns';
import { useDroppable } from '@dnd-kit/core';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { BucketCard, bucketGap } from '@/components/primitives/bucket-card';
import { GroupSection } from '@/components/primitives/group-section';
import { TaskRow } from '@/components/primitives/task-row';
import { ProjectBlock } from '@/components/views/project-block';
import { useCurrentBucket } from '@/hooks/use-current-bucket';
import { useDayItems } from '@/hooks/use-day-items';
import { useWeekColumns } from '@/lib/use-week-columns';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore, type BucketStyle } from '@/lib/view-store';
import { useCanvasGroupBy } from '@/lib/extension-gates';
import { openEditFor } from '@/lib/ui-store';
import { BUCKET_ORDER } from '@/lib/day-items';
import { groupRows, type GroupableRow } from '@/lib/grouping';
import { groupBySupport } from '@/lib/view-options';
import { sinkCompleted } from '@/lib/sort-rows';
import { WEEK_BUCKET_MAX_H } from '@/lib/schedule-constants';
import { toDateStr } from '@/lib/recurrence';
import type { TimeBucket } from '@/lib/planner-types';
import { cn } from '@/lib/utils';

/**
 * Week × Buckets (P5b): seven columns of mini bucket cards. Drops use
 * `week:{yyyy-MM-dd}:{bucket}` per lib/dnd/CONTRACT.md. The selected day is
 * highlighted by its lime header pill; hovering a day recedes the other six by
 * a transient opacity — the accent rule's one exception, taken for speed over
 * a token swap that spared the lime and cost ~300ms a hover. Columns keep a min
 * width and snap-scroll so 13" screens see ~4 comfortable columns (per the
 * mockup) instead of 7 crushed ones.
 */

function WeekBucketCell({
  date,
  bucket,
  activeId,
  isCurrent,
  variant,
}: {
  date: Date;
  bucket: TimeBucket;
  activeId: string | null;
  isCurrent: boolean;
  variant: BucketStyle;
}) {
  const dateStr = format(date, 'yyyy-MM-dd');
  const { isOver, setNodeRef } = useDroppable({ id: `week:${dateStr}:${bucket}` });
  const { tasksByBucket, habitsByBucket, recurringProjects } = useDayItems(date);
  const canvasGroupBy = useCanvasGroupBy();
  const routines = usePlannerStore((s) => s.routines);
  const programs = usePlannerStore((s) => s.programs);
  const goals = usePlannerStore((s) => s.goals);
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const tasks = tasksByBucket[bucket];
  const habits = habitsByBucket[bucket];
  // The header count stays "everything in this bucket", project-block tasks
  // included — same as day-buckets' `totalItems`.
  const count = tasks.length + habits.length;

  // Recurring project time blocks landing on this day, in this bucket — the
  // same selection day-buckets makes. Week used to render every task flat and
  // no blocks at all, so a task the user had filed into a project block came
  // back as a loose row here and the block itself was invisible (#193).
  const bucketProjects = recurringProjects.filter((p) => p.timeBucket === bucket);
  const looseTasks = tasks.filter((t) => !t.inProjectBlock);

  // Placeholder only when there is genuinely nothing — a bucket whose only
  // content is a project block still renders the block (day-buckets guards its
  // empty copy with `bucketProjects.length === 0` for the same reason).
  const isEmpty = looseTasks.length === 0 && habits.length === 0 && bucketProjects.length === 0;

  /**
   * ALL of the cell's rows, unlike Day × Buckets, which hands over its untimed
   * rows only.
   *
   * There is no spine to protect here: the whole cell is one `week:{date}:{bucket}`
   * droppable with no per-row drop zones, so no drop resolves against a
   * neighbour's time — and the cell was never in one time order anyway, since it
   * renders every habit before every task.
   */
  const allRows: GroupableRow[] = [
    ...habits.map((h) => ({ itemType: 'habit' as const, item: h })),
    ...looseTasks.map((t) => ({ itemType: 'task' as const, item: t })),
  ];
  /**
   * The day finished rows are resolved at — NOT the `dateStr` above.
   *
   * That one is the droppable id and is browser-local `format()`, while a
   * recurring row's completion is read per-date by TaskRow through
   * `toDateStr(date, timezone)`. One cell answering two different calendar days
   * is exactly the disagreement this has to avoid. And it is THIS cell's date
   * rather than the store's selected one: the seven columns are seven different
   * days, so the selected day would sink Tuesday's tick in every column.
   *
   * Memoized on the date's identity — `weekDays` is memoized upstream, so it is
   * stable — the same trade hooks/use-day-items.ts makes and for the same
   * reason: `toDateStr` builds an uncached Intl.DateTimeFormat per call, this
   * grid mounts 28 cells, and dnd-kit re-renders every droppable on each
   * collision-target change.
   */
  const completionDateStr = useMemo(
    () => toDateStr(date, userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone),
    [date, userTimezone]
  );
  /**
   * Finished rows sink to the foot of the cell, and this cell takes the pass
   * WHOLE for the same reason it hands grouping everything: no spine.
   *
   * Two applications because there are two render paths, and the grouped one
   * takes it PER GROUP, on `allRows` — never on a pre-sunk flat list. The group
   * map is filled by walking the rows, so its insertion order is "whichever
   * group owns the first row"; sinking beforehand would move the SECTIONS,
   * which is the bug the braindump shipped for one commit (lib/grouping.ts,
   * rule 1).
   *
   * Only ONE of the two ever runs: the ungrouped pass is applied at its own
   * render branch below rather than hoisted here, since the grouped path would
   * discard it — and an O(n) partition spent for nothing, 28 cells deep and on
   * every dnd re-render, is the cost the memo above exists to avoid.
   */
  const grouped =
    canvasGroupBy !== 'none' && groupBySupport('week', 'buckets', canvasGroupBy).honoured
      ? groupRows(allRows, canvasGroupBy, { routines, programs, goals }).map((g) => ({
          ...g,
          rows: sinkCompleted(g.rows, completionDateStr),
        }))
      : null;

  return (
    <div
      ref={setNodeRef}
      data-dnd-id={`week:${dateStr}:${bucket}`}
      data-dnd-over={isOver ? 'true' : 'false'}
    >
      {/* The empty placeholder is gone. It used to render a transparent '·' to
          hold the cell's height; an empty bucket now collapses to its 16px
          caption, and the drop slot opens from BucketCard when a drag starts —
          so the column's height tracks its content instead of being four equal
          boxes whether or not anything is in them.
          Issue #193's cap lives on BucketCard's own scroller now (contentMaxH),
          so project blocks and rows still scroll as one capped list. */}
      <BucketCard
        bucket={bucket}
        count={count}
        density="mini"
        isDropTarget={isOver}
        dragging={!!activeId}
        isEmpty={isEmpty}
        isCurrent={isCurrent}
        variant={variant}
        contentMaxH={isEmpty ? undefined : WEEK_BUCKET_MAX_H}
      >
        {!isEmpty && (
          <>
            {/* Blocks lead the cell. Day view can afford to put them below the
                untimed rows because nothing is capped there; here the bucket
                stops at WEEK_BUCKET_MAX_H, and a block trailing a long row list
                would never be on screen. */}
            {bucketProjects.map((project) => (
              <ProjectBlock
                key={project.name}
                project={project}
                tasks={tasks.filter((t) => t.project === project.name)}
                onTaskClick={(task) => openEditFor(task, 'task')}
                activeId={activeId}
                variant="week"
                date={date}
              />
            ))}
            {grouped
              ? grouped.map((g) => (
                  <GroupSection key={g.key} groupKey={g.key} label={g.label} gate={g.gate} variant="canvas">
                    {g.rows.map((row) => (
                      <TaskRow key={row.item.id} row={row as never} density="compact" date={date} />
                    ))}
                  </GroupSection>
                ))
              : sinkCompleted(allRows, completionDateStr).map((row) => (
                  <TaskRow key={row.item.id} row={row as never} density="compact" date={date} />
                ))}
          </>
        )}
      </BucketCard>
    </div>
  );
}

function WeekColumn({
  date,
  activeId,
  colPx,
  currentBucket,
  variant,
}: {
  date: Date;
  activeId: string | null;
  /** Width the week scale control asks for. */
  colPx: number;
  currentBucket: TimeBucket | null;
  variant: BucketStyle;
}) {
  const { selectedDate, setSelectedDate } = usePlannerStore();
  const selected = isSameDay(date, selectedDate);
  const today = isToday(date);

  return (
    <div
      data-testid="week-column"
      // Per-column identity. Without it the only handles are nth() and
      // title^="Select ", both position-dependent — and the column order is
      // reshuffled by the weekStartDay setting. `today` also replaces the
      // getByText('today') assertion, which only ever matched week-LIST.
      data-date={format(date, 'yyyy-MM-dd')}
      data-selected={selected ? 'true' : 'false'}
      data-today={today ? 'true' : 'false'}
      // Flex gap for the same reason day-buckets uses it: the cell wrapper is
      // the week:{date}:{bucket} droppable, so spacing must live between the
      // boxes rather than inside one. Also spaces the day header off the stack.
      //
      // The width was a fixed `w-60 min-w-60` until the week scale control
      // landed. It stayed effectively fixed for that control's first release
      // too — WEEK_GEOMETRY.buckets floored at the same 240px, which on a 1440px
      // window is what four of the six stops resolved to, so most of the slider
      // did nothing here. The floor is derived now (see the constant); 240 is
      // still roughly where the DEFAULT lands, but the stops either side of it
      // are distinct.
      style={{ width: colPx, gap: bucketGap(variant, 'mini') }}
      // The same recede Schedule's column takes, so the two views emphasise
      // identically — see that column, and globals.css, for the whole argument.
      //
      // Unselected columns here used to carry `opacity-75`, then per-element
      // muting off a `data-dim` flag; the flag existed because today's column
      // renders the lime current-bucket segment and fading lime through a
      // parent's opacity is the one thing the accent rule forbids. Both were
      // keyed to SELECTION, so six days out of seven sat muted with the
      // pointer nowhere near the grid — and THAT, the resting dim, is what was
      // wrong with them. The recede is an opacity again, but keyed to the
      // pointer and only ever transient: it is the one exception the accent
      // rule carries, taken because the token version that spared the lime
      // cost ~300ms of recalc and repaint on a busy week in this view (a mini
      // bucket card is a deep tree) against ~22ms for opacity. The lime
      // current-bucket bead and every checkbox composite while the pointer is
      // on another day, and fade back (after a brief hold) when it leaves.
      //
      // `group/col` stays for the bucket cards that hang off it. The day
      // header keeps its OWN hover wash (below) — that one is a button
      // affordance, not the day emphasis, and the two do not collide: the
      // column under the pointer is the one column that never recedes.
      data-week-col=""
      className="group/col flex flex-none snap-start flex-col rounded-[10px]"
    >
      <button
        onClick={() => setSelectedDate(date)}
        data-testid="week-column-header"
        className={cn(
          'group/dayhdr relative flex h-[60px] w-full flex-col items-center justify-center gap-0.5 rounded-[10px] border shadow-soft-sm transition-colors',
          // Ink role on the lime fill — see week-schedule's day header.
          selected ? 'border-primary-foreground bg-primary' : 'border-surface-3 bg-surface-2'
        )}
        title={`Select ${format(date, 'EEEE, MMMM d')}`}
      >
        {/* An unselected header sits at FULL surface strength — its old
            `bg-surface-2/60` was half the resting recede — so it needs a hover
            affordance of its own, and this is it, on its own element.
            It cannot be `hover:bg-accent`: --accent is translucent and would
            REPLACE the card's fill rather than sit on it. It cannot be
            `hover-wash` either, which is the layering answer to exactly that —
            hover-wash paints a `background-image`, and background-image is not
            an interpolable property, so under the button's `transition-colors`
            it snapped on where the old `bg-surface-2/60 → bg-surface-2` faded.
            A wash element fading its OWN opacity does fade, and it sits behind
            the two labels (which take `relative` for it), so today's lime date
            is never composited through it. */}
        {!selected && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[10px] bg-accent opacity-0 transition-opacity group-hover/dayhdr:opacity-100"
          />
        )}
        <span
          className={cn(
            'relative text-sm font-normal uppercase',
            // Full-strength muted ink, matching Schedule's day header. The old
            // `/70` was the other half of the resting recede, which is gone —
            // nothing in this view is muted at rest, and now nothing is muted
            // on hover either.
            selected ? 'text-primary-foreground' : 'text-muted-foreground'
          )}
        >
          {format(date, 'EEEE')}
        </span>
        <span
          className={cn(
            'relative text-sm',
            selected
              ? 'font-semibold text-primary-foreground'
              : today
                ? // `today` stays full-strength lime even on an unselected
                  // column — it is the same mark the current-bucket bead is.
                  'font-bold text-success-text'
                : 'font-semibold text-foreground'
          )}
        >
          {format(date, 'MMMM d')}
        </span>
      </button>

      {BUCKET_ORDER.map((bucket) => (
        <WeekBucketCell
          key={bucket}
          date={date}
          bucket={bucket}
          activeId={activeId}
          isCurrent={currentBucket === bucket}
          variant={variant}
        />
      ))}
    </div>
  );
}

export function WeekBuckets({ activeId }: { activeId: string | null }) {
  const { selectedDate, weekStartDay, navDirection } = usePlannerStore();
  const { colPx, ref: weekColsRef } = useWeekColumns('buckets');
  // ONE clock for the whole grid, unscoped — each column gates it with isToday
  // below. Seven columns × four cells calling this themselves would be 28
  // intervals for one wall clock. No `mounted` flag: the hook already returns
  // null on the first render, which is the hydration guard.
  const currentBucket = useCurrentBucket();
  const bucketStyle = useViewStore((s) => s.bucketStyle);

  const weekStartsOn = weekStartDay === 'monday' ? 1 : weekStartDay === 'saturday' ? 6 : 0;
  const weekDays = useMemo(() => {
    const start = startOfWeek(selectedDate, { weekStartsOn: weekStartsOn as 0 | 1 | 6 });
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [selectedDate, weekStartsOn]);

  return (
    <ScrollArea className="h-full flex-1">
      <div
        ref={weekColsRef}
        key={`${weekDays[0].toDateString()}-${navDirection ?? 'none'}`}
        data-wide="true"
        // Scopes the recede to this row's columns — see week-schedule's row.
        data-week-cols=""
        className={cn(
          'canvas-container flex snap-x snap-mandatory gap-7 py-6 pb-20',
          navDirection && `animate-slide-in-from-${navDirection === 'left' ? 'right' : 'left'}`
        )}
      >
        {weekDays.map((day) => (
          <WeekColumn
            key={day.toDateString()}
            date={day}
            activeId={activeId}
            colPx={colPx}
            currentBucket={isToday(day) ? currentBucket : null}
            variant={bucketStyle}
          />
        ))}
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  );
}
