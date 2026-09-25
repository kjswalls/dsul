'use client';

import { useDroppable } from '@dnd-kit/core';
import { ScrollArea } from '@/components/ui/scroll-area';
import { BucketCard, bucketGap } from '@/components/primitives/bucket-card';
import { GroupSection } from '@/components/primitives/group-section';
import { TaskRow } from '@/components/primitives/task-row';
import { ProjectBlock } from '@/components/views/project-block';
import { useCurrentBucket } from '@/hooks/use-current-bucket';
import { useDayItems } from '@/hooks/use-day-items';
import { usePlannerStore } from '@/lib/planner-store';
import { useDragStore } from '@/lib/drag-store';
import { isDropTargetOffered } from '@/lib/dnd/drop-targets';
import { useViewStore, type BucketStyle } from '@/lib/view-store';
import { useCanvasGroupBy } from '@/lib/extension-gates';
import { openEditFor, openAddDialog } from '@/lib/ui-store';
import { BUCKET_ORDER } from '@/lib/day-items';
import { groupRows, type GroupableRow, type RowGroup } from '@/lib/grouping';
import { groupBySupport } from '@/lib/view-options';
import { sinkCompleted } from '@/lib/sort-rows';
import { useSinkHold } from '@/hooks/use-sink-hold';
import { toDateStr } from '@/lib/recurrence';
import type { Task, HabitItem, Project, TimeBucket } from '@/lib/planner-types';
import { cn } from '@/lib/utils';

/**
 * Day × Buckets — the default canvas view, rewritten on the primitives
 * (P5a). DnD droppable ids follow lib/dnd/CONTRACT.md exactly:
 *   {bucket}                      whole-card highlight + fallback drop
 *   unscheduled:{bucket}          untimed section (drop → no time)
 *   scheduled:{bucket}:{pos}:{refType}:{refId} + scheduled:{bucket}:empty
 *   spine:{bucket}:{above|below}:{itemId}   the same gap box, for a finger:
 *                                 assigns the bucket, no time (drop-targets.ts)
 */

/**
 * The gap between two timed rows: ONE box, two meanings, chosen by input type.
 *
 * A cursor gets `scheduled:{bucket}:{before|after}:{ref}` — schedule at that
 * row's time ±30 min, unchanged in every respect. A finger gets
 * `spine:{bucket}:{above|below}:{id}` — assign this bucket, no time. Which of
 * the two is offered is not decided here; it is `OFFERED_TO` in
 * lib/dnd/drop-targets.ts, and this component just asks. The input comes from
 * the drag store, i.e. from the activator event of the gesture actually in
 * progress — never a media query, so a touchscreen laptop's mouse keeps the
 * timed sliver while the same machine's finger does not.
 *
 * SUBSTITUTING rather than dropping the box is load-bearing, and the reason is
 * geometric. Collision is `closestCenter`, which compares centres and not
 * containment, so these boxes are what give the timed spine a droppable centre
 * every ~44px. Mount nothing for touch and the lowest centre a tall bucket card
 * owns becomes the card's own middle — everything below the midpoint between
 * that and the next card's centre then resolves to the NEXT BUCKET, which is a
 * silent wrong-bucket write in the view whose whole job is bucket placement.
 * Same box, same rect, same centre: touch geometry is main's, to the pixel, and
 * only the command changes. `tests/unit/dnd-touch-drop-geometry.test.tsx` holds
 * the band shut.
 */
function TimedGapDropZone({
  bucket,
  position,
  refType,
  refId,
  isActive,
}: {
  bucket: TimeBucket;
  position: 'before' | 'after';
  refType: 'task' | 'habit';
  refId: string;
  isActive: boolean;
}) {
  const sliverId = `scheduled:${bucket}:${position}:${refType}:${refId}`;
  const spineId = `spine:${bucket}:${position === 'before' ? 'above' : 'below'}:${refId}`;
  // Both registered unconditionally — hooks cannot be conditional, and a
  // droppable with no node attached has no rect, so the unused one cannot be
  // collided with. Exactly one is offered to any given input; the table is what
  // guarantees that, and a test asserts it.
  const sliver = useDroppable({ id: sliverId });
  const spine = useDroppable({ id: spineId });
  const input = useDragStore((s) => s.input);

  if (!isActive || !input) return null;
  const timed = isDropTargetOffered(sliverId, input);
  const zone = timed ? sliver : isDropTargetOffered(spineId, input) ? spine : null;
  if (!zone) return null;
  const { isOver, setNodeRef } = zone;

  return (
    <div
      ref={setNodeRef}
      // CONTRACT.md declares this droppable but it used to emit no DOM marker,
      // which made it both untestable and invisible to a test aiming nearby —
      // collision is closestCenter, so a drop meant for unscheduled:{bucket}
      // can silently resolve here instead and assign a TIME.
      data-dnd-id={timed ? sliverId : spineId}
      data-dnd-over={isOver ? 'true' : 'false'}
      // Identical geometry either way, hover included. That is deliberate: the
      // touch path must keep main's rects exactly, or the spine's centres move.
      className={cn('-my-0.5 flex h-2 items-center transition-all', isOver && 'my-1 h-6')}
    >
      {timed ? (
        /* A solid 2px rule, not a dashed box. The dashed rectangle was the only
           drop affordance in the view that looked nothing like the view; a rule
           where the row will land is the same gesture the schedule grid uses.
           Lime never takes alpha — see the NowMarker. */
        <span
          aria-hidden
          className={cn(
            'h-[2px] w-full rounded-[1px] transition-colors',
            isOver ? 'bg-primary' : 'bg-transparent'
          )}
        />
      ) : (
        /* Not a rule: this drop sets no time, so a line drawn between two rows
           would promise a position the row will not take. The armed tray fill
           is the affordance the empty-bucket tray already uses for "this bucket
           takes it, untimed". */
        <span
          aria-hidden
          className={cn(
            'h-full w-full rounded-md transition-colors',
            isOver ? 'bg-[var(--bkt-tray-armed)]' : 'bg-transparent'
          )}
        />
      )}
    </div>
  );
}

function EmptyBucketDropZone({ bucket }: { bucket: TimeBucket }) {
  const { isOver, setNodeRef } = useDroppable({ id: `scheduled:${bucket}:empty` });
  return (
    <div
      ref={setNodeRef}
      data-dnd-id={`scheduled:${bucket}:empty`}
      data-dnd-over={isOver ? 'true' : 'false'}
      // A step BELOW the slot it sits in, in every state, so it never flattens
      // into an armed bucket. --chip-well would be the token if the recessed
      // -container contract lands; against the open slot's 0.9737 / 0.1878 the
      // well reads at −0.016 / −0.019 either way.
      className={cn(
        'flex items-center justify-center rounded-lg transition-all',
        isOver ? 'h-12 bg-[var(--bkt-tray-armed)]' : 'h-10 bg-[color-mix(in_oklab,var(--bkt-tray),var(--surface-3)_55%)]'
      )}
    >
      {isOver ? (
        <span aria-hidden className="h-[2px] w-[calc(100%-24px)] rounded-[1px] bg-primary" />
      ) : (
        <span className="text-xs text-muted-foreground">Drop here to schedule with time</span>
      )}
    </div>
  );
}

interface DayBucketProps {
  bucket: TimeBucket;
  tasks: Task[];
  habits: HabitItem[];
  recurringProjects: Project[];
  activeId: string | null;
  isCurrent: boolean;
  variant: BucketStyle;
  /**
   * The rendered day, in the USER's zone. Threaded down rather than re-resolved
   * per card: a recurring row's completion is per-date, and `toDateStr` builds
   * an uncached Intl.DateTimeFormat per call (see the note in
   * hooks/use-day-items.ts) — four cards would pay for it four times to reach
   * the same answer.
   */
  dateStr: string;
}

/**
 * This card's no-grouping look inside the untimed section: HABITS then TASKS.
 *
 * Local for the same reason Day × List's is — it is what this view renders when
 * nothing is grouped, not an answer to "group by what".
 */
function defaultBucketGroups(rows: GroupableRow[]): RowGroup<GroupableRow>[] {
  return [
    { key: 'Habits', label: 'Habits', rows: rows.filter((r) => r.itemType === 'habit') },
    { key: 'Tasks', label: 'Tasks', rows: rows.filter((r) => r.itemType === 'task') },
  ].filter((g) => g.rows.length > 0);
}

function DayBucket({ bucket, tasks, habits, recurringProjects, activeId, isCurrent, variant, dateStr }: DayBucketProps) {
  const canvasGroupBy = useCanvasGroupBy();
  const routines = usePlannerStore((s) => s.routines);
  const programs = usePlannerStore((s) => s.programs);
  const goals = usePlannerStore((s) => s.goals);
  const dragging = !!activeId;

  // Whole-card droppable: highlight + fallback drop target (bare bucket id)
  const { isOver, setNodeRef: setBucketRef } = useDroppable({ id: bucket });
  const { isOver: isOverUnscheduled, setNodeRef: setUnscheduledRef } = useDroppable({
    id: `unscheduled:${bucket}`,
  });

  const untimedTasks = tasks.filter((t) => !t.startTime && !t.inProjectBlock);
  const timedTasks = tasks.filter((t) => t.startTime && !t.inProjectBlock);
  const untimedHabits = habits.filter((h) => !h.startTime);
  const timedHabits = habits.filter((h) => h.startTime);

  const totalItems = tasks.length + habits.length;
  const hasUntimed = untimedTasks.length > 0 || untimedHabits.length > 0;
  const hasTimed = timedTasks.length > 0 || timedHabits.length > 0;
  const bucketProjects = recurringProjects.filter((p) => p.timeBucket === bucket);

  /**
   * The UNTIMED rows only — the timed spine below is never partitioned.
   *
   * `inferDropTime` resolves `scheduled:{bucket}:before|after:{type}:{id}` as
   * ±30 min from THAT row's own time (lib/dnd/CONTRACT.md), so "the gap above
   * row X" only means "just before X" while the row above X is earlier in the
   * day. Group the spine and a drop lands at a time that contradicts where the
   * row visibly went. `groupBySupport` states the same rule to the menu, which
   * puts "Untimed rows only" on the Grouping rail here.
   *
   * This used to honour 'project' and nothing else, so choosing Priority on
   * Buckets rendered identically to None with the trigger still counting it.
   */
  const untimedRows: GroupableRow[] = [
    ...untimedHabits.map((h) => ({ itemType: 'habit' as const, item: h })),
    ...untimedTasks.map((t) => ({ itemType: 'task' as const, item: t })),
  ];
  /**
   * Finished rows sink to the foot of each untimed section — the SAME half of
   * the card grouping already governs, and stopping at the same line for the
   * same reason.
   *
   * This is not the "sort control that silently governs half a card" that
   * lib/sort-rows.ts records as considered and rejected. That objection is about
   * a menu value claiming a surface and then reaching half of it. There is no
   * control here and nothing claimed; what the sink must not do is overwrite an
   * order the USER authored, and the two halves differ on exactly that. The
   * untimed section's order is "habits, then tasks, then whatever the derivation
   * emitted" — nobody chose it. The timed spine's order IS each row's own
   * `startTime`, which the user set and which `inferDropTime` reads back:
   * `scheduled:{bucket}:before|after:{type}:{id}` resolves to ±30 min from that
   * row's time (lib/dnd/CONTRACT.md), so a completed 9am row pushed below an
   * 11am one would make "drop above the 11am row" assign 10:30 — a time on the
   * far side of the row the pointer was actually above.
   *
   * So the spine keeps its clock and only the untimed rows move. A completed
   * timed row staying put is not the sink failing there; it is that the spine's
   * position already means something else.
   */
  const { completedAs, rootRef } = useSinkHold(setBucketRef);
  const untimedGroups = (
    canvasGroupBy !== 'none' && groupBySupport('day', 'buckets', canvasGroupBy).honoured
      ? groupRows(untimedRows, canvasGroupBy, { routines, programs, goals })
      : defaultBucketGroups(untimedRows)
  ).map((g) => ({ ...g, rows: sinkCompleted(g.rows, dateStr, completedAs) }));

  // Timed rows flat, sorted by time (already time-sorted from deriveDayItems)
  const timedRows = [
    ...timedHabits.map((h) => ({ type: 'habit' as const, item: h, time: h.startTime! })),
    ...timedTasks.map((t) => ({ type: 'task' as const, item: t, time: t.startTime! })),
  ].sort((a, b) => a.time.localeCompare(b.time));

  return (
    <div
      ref={rootRef}
      data-dnd-bucket={bucket}
      data-dnd-id={bucket}
      // `isOver` on the bare bucket only — the untimed section reports its own
      // hover below, and a drag helper needs to know which of the two it is on
      // before it releases the pointer.
      data-dnd-over={isOver ? 'true' : 'false'}
    >
      <BucketCard
        bucket={bucket}
        count={totalItems}
        onAdd={(b, type) => openAddDialog(type, b, usePlannerStore.getState().selectedDate)}
        isCurrent={isCurrent}
        isDropTarget={isOver || isOverUnscheduled}
        dragging={dragging}
        isEmpty={totalItems === 0 && bucketProjects.length === 0}
        variant={variant}
        // What a shut card lists in its caption, in the order the open card
        // draws it: untimed rows (grouped and sunk), then project blocks, then
        // the timed spine.
        peek={[
          ...untimedGroups.flatMap((g) => g.rows.map((r) => r.item.title)),
          ...bucketProjects.map((p) => p.name),
          ...timedRows.map((r) => r.item.title),
        ]}
      >
        {/* Unscheduled section — dedicated drop target, mounted whenever
            dragging so the rect is measurable (see CONTRACT.md). */}
        {(hasUntimed || dragging) && (
          <div
            ref={setUnscheduledRef}
            data-dnd-id={`unscheduled:${bucket}`}
            data-dnd-over={isOverUnscheduled ? 'true' : 'false'}
            // The 16px indent is gone: the bucket's own content edge already
            // aligns rows with the caption above them, and pl-4 pushed every
            // row 16px past it — which is what made "one edge runs the whole
            // bucket" untrue by exactly that much.
            className="space-y-2"
          >
            {untimedGroups.map((g) => (
              <GroupSection key={g.key} groupKey={g.key} label={g.label} gate={g.gate} variant="canvas">
                {g.rows.map((row) => (
                  <TaskRow key={row.item.id} row={row as never} />
                ))}
              </GroupSection>
            ))}
            {!hasUntimed && dragging && (
              <div className="py-3 text-center text-xs text-muted-foreground/50">
                Drop here to add unscheduled
              </div>
            )}
          </div>
        )}

        {/* Untimed → timed. The full-width rule with a clock in the middle is
            gone: it was a second horizontal division inside a bucket that no
            longer has even one (the header band's divider went with the band).
            In its place the timed section indents and takes a 6px branch tick
            off the spine — day-schedule.tsx:996-1002's gesture, which is how
            that view already says "this hangs off the rail". */}
        {hasUntimed && (hasTimed || bucketProjects.length > 0) && bucket !== 'anytime' && (
          <div aria-hidden className="relative h-4">
            <span className="absolute left-0 top-1/2 w-1.5 border-t border-border" />
          </div>
        )}

        {/* Scheduled section: project blocks + timed rows */}
        {(hasTimed || bucketProjects.length > 0 || dragging) && (
          <div className={cn(hasUntimed ? 'pl-2' : 'pt-1')}>
            {bucketProjects.map((project) => (
              <ProjectBlock
                key={project.name}
                project={project}
                tasks={tasks.filter((t) => t.project === project.name)}
                onTaskClick={(task) => openEditFor(task, 'task')}
                activeId={activeId}
              />
            ))}

            {timedRows.map((entry, idx) => (
              <div key={entry.item.id}>
                <TimedGapDropZone
                  bucket={bucket}
                  position="before"
                  refType={entry.type}
                  refId={entry.item.id}
                  isActive={dragging}
                />
                <TaskRow row={{ itemType: entry.type, item: entry.item } as never} />
                {idx === timedRows.length - 1 && (
                  <TimedGapDropZone
                    bucket={bucket}
                    position="after"
                    refType={entry.type}
                    refId={entry.item.id}
                    isActive={dragging}
                  />
                )}
              </div>
            ))}

            {!hasTimed && dragging && bucket !== 'anytime' && <EmptyBucketDropZone bucket={bucket} />}
          </div>
        )}

        {/* Completely empty and not dragging renders NOTHING — BucketCard
            collapses to its 22px caption. The serif "Nothing here yet" line
            that used to live here cost ~100px per empty bucket, and four empty
            buckets is a common evening; the column's vertical rhythm is now a
            readout of the shape of the day instead of four equal boxes. The
            add affordance is still in the caption, and a drag opens the slot. */}
      </BucketCard>
    </div>
  );
}

export function DayBuckets({ activeId }: { activeId: string | null }) {
  const { tasksByBucket, habitsByBucket, recurringProjects } = useDayItems();
  const { selectedDate, navDirection, userTimezone } = usePlannerStore();
  // Resolved once for all four cards — see the note on DayBucketProps.dateStr.
  const dateStr = toDateStr(
    selectedDate,
    userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  );
  // No `mounted` flag — useCurrentBucket returns null on the first render,
  // which is the hydration guard the flag used to duplicate.
  const currentBucket = useCurrentBucket(selectedDate);
  const bucketStyle = useViewStore((s) => s.bucketStyle);

  return (
    <ScrollArea className="h-full flex-1">
      <div
        key={`${selectedDate.toDateString()}-${navDirection ?? 'none'}`}
        // Full container width — the cards run the same edges as the header
        // capsule above them (that is what `canvas-container` is for). A
        // narrower centred column was tried and reverted: the moat read as the
        // view having shrunk rather than as the buckets having become objects,
        // and the card's own edge already does the containing.
        //
        // Flex GAP, not space-y-* and not padding inside the sections. The
        // section's box is the {bucket} droppable's rect, so trailing space
        // inside it drags the bare bucket's centre down onto
        // scheduled:{bucket}:empty — see the note in bucket-card's GEO table.
        // Gap puts the space between the boxes instead of in one of them.
        style={{ gap: bucketGap(bucketStyle, 'full') }}
        className={cn(
          'canvas-container flex flex-col py-6 pb-20',
          navDirection && `animate-slide-in-from-${navDirection === 'left' ? 'right' : 'left'}`
        )}
      >
        {BUCKET_ORDER.map((bucket) => (
          <DayBucket
            key={bucket}
            bucket={bucket}
            tasks={tasksByBucket[bucket]}
            habits={habitsByBucket[bucket]}
            recurringProjects={recurringProjects}
            activeId={activeId}
            isCurrent={currentBucket === bucket}
            variant={bucketStyle}
            dateStr={dateStr}
          />
        ))}
      </div>
    </ScrollArea>
  );
}
