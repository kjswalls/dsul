'use client';

import { useMemo } from 'react';
import { format, startOfWeek, addDays, isSameDay } from 'date-fns';
import { useDroppable } from '@dnd-kit/core';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { GroupSection } from '@/components/primitives/group-section';
import { TaskRow, type RowItem } from '@/components/primitives/task-row';
import {
  DAY_FIELD_LEFT,
  DAY_GUTTER_INSET,
  ECLIPSE_PX,
  LANE_PX,
  NowMarker,
  ScheduleBlock,
  deriveGridRange,
  deriveTimedEntries,
  deriveUntimedRows,
  formatClock,
  formatHourLabel,
  toOverlapEntries,
  FULL_DAY_RANGE,
  type TimedEntry,
} from '@/components/views/day-schedule';
import { layoutOverlaps } from '@/lib/schedule-overlap';
import { LANE_CAP_Z, MIN_CHANNEL_PX, WEEK_GUTTER_Z } from '@/lib/schedule-constants';
import { CANVAS_PAD_PX } from '@/lib/week-columns';
import { useFitHourPx, useResizeScrollCompensation } from '@/lib/use-fit-hour-px';
import { useWeekColumns } from '@/lib/use-week-columns';
import { useScheduleResizeStore } from '@/lib/schedule-resize-store';
import { usePlannerStore } from '@/lib/planner-store';
import { useCanvasGroupBy } from '@/lib/extension-gates';
import { groupRows } from '@/lib/grouping';
import { planLanes, isReceded, type LanePlan } from '@/lib/schedule-lanes';
import { useScheduleFocusStore } from '@/lib/schedule-focus-store';
import { LaneCapRow } from '@/components/primitives/lane-cap';
import { groupBySupport } from '@/lib/view-options';
import { useNowMinutes } from '@/lib/use-now-minutes';
import { useTimeFormat } from '@/lib/use-time-format';
import { toDateStr } from '@/lib/recurrence';
import { useDayItemsForDates } from '@/hooks/use-day-items';
import { programBoundaries, boundaryLabel } from '@/lib/program-boundaries';
import { cn } from '@/lib/utils';

/**
 * Week × Schedule: one grid, seven day-columns + a left hour gutter. Each
 * column has a per-day Anytime drop strip (untimed items) over an hour grid.
 * Drop onto a slot → `weekhour:{date}:{H}` (schedule at that day + hour); drop
 * onto the strip → `week:{date}:anytime` (un-time, keep the day). All columns
 * share the same top offsets (fixed header + anytime heights) so the gutter's
 * hour labels line up with every column's grid. Full-width, horizontal-scroll
 * when the week is tighter than the canvas (like week-buckets).
 */

const HEADER_H = 60;
const ANYTIME_H = 88;
/**
 * The program-boundary rail. Rendered on EVERY column of a week that has any
 * boundary at all — including the empty ones, and including the hour gutter —
 * because the seven hour grids have to stay on the same baseline. Growing one
 * column by 18px would slew its whole day against its neighbours, which is the
 * one thing this view cannot afford.
 */
const BOUNDARY_H = 18;

function WeekHourCell({
  dateStr,
  hour,
  isActive,
  hourPx,
}: {
  dateStr: string;
  hour: number;
  isActive: boolean;
  hourPx: number;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: `weekhour:${dateStr}:${hour}`, disabled: !isActive });
  return (
    <div
      ref={setNodeRef}
      data-dnd-id={`weekhour:${dateStr}:${hour}`}
      data-dnd-over={isOver ? 'true' : 'false'}
      className={cn('relative transition-colors', isOver && 'bg-primary/10')}
      style={{ height: hourPx }}
    >
      {/* The hairline starts at the pane, leaving the lane an unbroken channel —
          which is also what now separates one column from the next. The old
          per-cell left border would have run a second vertical line 5px from the
          rail, and two near-parallel rules per column read as noise. */}
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-0 right-0 border-b border-border/25"
        style={{ left: LANE_PX }}
      />
    </div>
  );
}

interface ColumnData {
  date: Date;
  dateStr: string;
  timed: TimedEntry[];
  untimed: RowItem[];
  /** Set only on a column where a program's cover changes hands. */
  boundary?: string;
}

function WeekScheduleColumn({
  col,
  hours,
  gridStartMin,
  hourPx,
  colPx,
  activeId,
  selected,
  today,
  nowY,
  showBoundaryRail,
  lanePlan,
}: {
  col: ColumnData;
  hours: number[];
  gridStartMin: number;
  hourPx: number;
  /**
   * The WEEK's lane plan, built once over all seven columns and handed down.
   *
   * Not per column: focus is a question about the week ("where does Deep Work
   * land"), and a per-column plan would give the same group a different lane key
   * set on a day it happens to be absent from — so focusing it would recede that
   * whole column instead of leaving it empty.
   */
  lanePlan: LanePlan;
  /** Width the week scale control asks for. The column may still exceed it —
   *  see minColPx below. */
  colPx: number;
  activeId: string | null;
  selected: boolean;
  today: boolean;
  showBoundaryRail: boolean;
  /** Y of the live-time marker, or null when this column isn't today (or the
   *  clock falls outside the visible window). */
  nowY: number | null;
}) {
  const setSelectedDate = usePlannerStore((s) => s.setSelectedDate);
  const routines = usePlannerStore((s) => s.routines);
  const programs = usePlannerStore((s) => s.programs);
  const goals = usePlannerStore((s) => s.goals);
  const canvasGroupBy = useCanvasGroupBy();
  const focusedKey = useScheduleFocusStore((s) => s.focusedKey);
  const dragging = !!activeId;
  const { isOver, setNodeRef } = useDroppable({ id: `week:${col.dateStr}:anytime` });

  // Per column, like the overlap pass below: seven strips are seven independent
  // lists. `'none'` comes back as one unlabelled group — today's flat strip.
  const untimedGroups = useMemo(
    () =>
      groupBySupport('week', 'schedule', canvasGroupBy).honoured
        ? groupRows(col.untimed, canvasGroupBy, { routines, programs, goals })
        : [{ key: '', label: '', rows: col.untimed }],
    [col.untimed, canvasGroupBy, routines, programs, goals]
  );

  // Per COLUMN, not per week: seven days are seven independent grids, and memoising
  // this one level up would rebuild all seven whenever any one day changed.
  //
  // Week gets ONE gesture for overlap — shingle right-flush, z ascending — because
  // a 140px column cannot carry a percentage split and already spends its width on
  // a wrapping title. No containment vocabulary here at all.
  const overlap = useMemo(
    () =>
      layoutOverlaps(toOverlapEntries(col.timed), {
        hourPx,
        gridStartMin,
        variant: 'week',
      }),
    [col.timed, hourPx, gridStartMin]
  );

  /*
   * How wide this column has to be for its narrowest pane to clear the floor.
   *
   * Week does not cap its channels the way day does — it GROWS. A day holding a
   * double-booking tiles it, and the two panes are each half a channel, so the
   * column needs two channels' worth of width for both titles to stay readable.
   * Every other day keeps its 140px minimum and the flex row settles it; if the
   * total no longer fits the canvas, the grid scrolls, which it is already built
   * to do (see the ScrollBar below).
   */
  const minColPx = useMemo(() => {
    let widest = MIN_CHANNEL_PX;
    for (const l of overlap.values()) {
      if (l.widthFraction > 0) widest = Math.max(widest, MIN_CHANNEL_PX / l.widthFraction);
    }
    return Math.round(widest);
  }, [overlap]);

  return (
    <div
      // Per-column identity, mirroring week-buckets — the two week views are
      // asserted against with the same selectors.
      data-testid="week-column"
      data-date={col.dateStr}
      data-selected={selected ? 'true' : 'false'}
      data-today={today ? 'true' : 'false'}
      // The hook the recede selects on. Hovering one column mutes the other
      // six; this column takes no mark of its own, which is the point — the
      // wash it used to carry (`hover:bg-accent`) read as a second selection
      // highlight next to the lime header pill rather than as a pointer echo.
      //
      // The recede is a TOKEN swap, never an opacity: a column opacity
      // composites everything inside it, and this column is full of lime —
      // the block accent rail and start bead of every project-less scheduled
      // task, the completion checkbox of every done row, multi-select marks,
      // and any project whose name happens to hash to --accent-8. Lime at 0.6
      // over the dark ramp turns olive (see primitives/task-row.tsx, which
      // names that exact number), and CLAUDE.md's accent rule forbids it.
      // Excluding the selected and today columns does not save it: an ordinary
      // Tuesday holds all of the above. So the neutrals recede and every
      // colour mark keeps its strength. The whole argument, the token list and
      // the touch-device guard are in globals.css under "the other six
      // recede"; this file only supplies the two attributes it selects on.
      data-week-col=""
      className="flex flex-none flex-col rounded-[10px]"
      /*
       * `flex-none` + an explicit width, where this used to be `flex-1` +
       * minWidth. That reads like a bigger change than it is: under the old
       * 1100px canvas cap, seven 140px columns plus the gutter and gaps always
       * wanted more room than the container had, so flex-grow never had free
       * space to hand out and every column sat pinned at its min-width at every
       * desktop size. flex-1 was inert; this replaces a constant.
       *
       * minWidth still wins over the requested width, and deliberately: a day
       * holding a double-booking grows to 280 so both tiled panes clear the
       * channel floor (see minColPx above). So "five days" on a week containing
       * an overlap gives four-and-a-bit and scrolls — week GROWS rather than
       * dividing, which is the contract memory/plans/overlap-blocks.md locks in,
       * and the scale control is not the place to break it.
       */
      style={{ width: Math.max(colPx, minColPx), minWidth: minColPx }}
    >
      {/* Program boundary rail. Muted and unbordered — a handover is not a
          warning, and the guilt-free law applies to the grid too. */}
      {showBoundaryRail && (
        <div
          style={{ height: BOUNDARY_H }}
          className="flex items-center justify-center overflow-hidden"
          data-testid={col.boundary ? 'week-program-boundary' : undefined}
          data-date={col.boundary ? col.dateStr : undefined}
        >
          {col.boundary && (
            <span
              className="text-muted-foreground truncate text-2xs font-medium"
              title={col.boundary}
            >
              {col.boundary}
            </span>
          )}
        </div>
      )}

      {/* Day header card */}
      <button
        onClick={() => setSelectedDate(col.date)}
        style={{ height: HEADER_H }}
        className={cn(
          'flex flex-col items-center justify-center gap-0.5 rounded-[10px] border shadow-soft-sm transition-colors',
          // On the lime fill the label takes the INK role (-foreground), not the
          // lime-as-text one: -text tracks the fill, so it was lime on lime.
          selected ? 'border-primary-foreground bg-primary' : 'border-surface-3 bg-surface-2'
        )}
        title={`Select ${format(col.date, 'EEEE, MMMM d')}`}
      >
        <span
          className={cn('text-xs font-medium uppercase', selected ? 'text-primary-foreground' : 'text-muted-foreground')}
        >
          {format(col.date, 'EEE')}
        </span>
        <span
          className={cn(
            'text-sm',
            selected
              ? 'font-semibold text-primary-foreground'
              : today
                ? 'font-bold text-success-text'
                : 'font-semibold text-foreground'
          )}
        >
          {format(col.date, 'MMM d')}
        </span>
      </button>

      {/* Per-day Anytime strip */}
      <div
        ref={setNodeRef}
        data-dnd-id={`week:${col.dateStr}:anytime`}
        data-dnd-over={isOver ? 'true' : 'false'}
        style={{ height: ANYTIME_H }}
        className={cn(
          'mt-2 overflow-y-auto rounded-[8px] border border-dashed border-border/40 p-1 transition-colors',
          isOver && 'border-primary bg-primary/5'
        )}
      >
        {/* Same rule as Day × Schedule: the hour grid below cannot take
            headings, this strip can. It is 88px and scrolls, so a grouped strip
            shows fewer rows at rest — that is the cost of having asked. */}
        {untimedGroups.map((g) =>
          g.label ? (
            <GroupSection key={g.key} groupKey={g.key} label={g.label} gate={g.gate} variant="canvas">
              {g.rows.map((row) => (
                <TaskRow key={row.item.id} row={row} density="compact" date={col.date} />
              ))}
            </GroupSection>
          ) : (
            g.rows.map((row) => (
              <TaskRow key={row.item.id} row={row} density="compact" date={col.date} />
            ))
          )
        )}
        {col.untimed.length === 0 && (
          <div className="pt-3 text-center text-2xs text-muted-foreground/40">Anytime</div>
        )}
      </div>

      {/* Hour grid. Every column carries its own lane: rail, beads, and — on
          today — the now-marker. */}
      <div className="relative mt-2">
        <div>
          {hours.map((h) => (
            <WeekHourCell key={h} dateStr={col.dateStr} hour={h} isActive={dragging} hourPx={hourPx} />
          ))}
        </div>
        <div className="pointer-events-none absolute inset-0">
          <span
            aria-hidden
            className="pointer-events-none absolute bottom-0 left-[5px] top-0 w-px bg-[var(--sched-rail)]"
          />
          {col.timed.map((entry) => (
            <ScheduleBlock
              key={entry.item.id}
              entry={entry}
              gridStartMin={gridStartMin}
              date={col.date}
              hourPx={hourPx}
              variant="week"
              layout={overlap.get(entry.item.id)}
              receded={isReceded(lanePlan, focusedKey, entry.item.id)}
            />
          ))}
          {nowY !== null && <NowMarker top={nowY} />}
        </div>
      </div>
    </div>
  );
}

export function WeekSchedule({ activeId }: { activeId: string | null }) {
  // Only what this file still reads for itself. Everything the day pipeline
  // needs — tasks, habits, projects, items, routines, the two show* prefs, and
  // both view-store filter slices — is read by useDayItemsForDates now.
  // `programs` stays: the boundary rail is Week × Schedule's own.
  const {
    selectedDate,
    weekStartDay,
    navDirection,
    programs,
    userTimezone,
    showCurrentTimeIndicator,
  } = usePlannerStore();
  const timeFormatStr = useTimeFormat();
  const timezone = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const nowMin = useNowMinutes(timezone);

  const weekStartsOn = weekStartDay === 'monday' ? 1 : weekStartDay === 'saturday' ? 6 : 0;
  const weekDays = useMemo(() => {
    const start = startOfWeek(selectedDate, { weekStartsOn: weekStartsOn as 0 | 1 | 6 });
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [selectedDate, weekStartsOn]);

  // All seven days from the one shared pipeline, so the shared hour range and
  // the columns come from one pass — and so a rule added to the canvas filter
  // set lands here without anyone remembering this file exists. The plural hook
  // is what makes that possible: Week × Schedule needs every column resolved
  // before it can size any of them, which is why this used to be a verbatim
  // second copy of use-day-items' body.
  const days = useDayItemsForDates(weekDays);

  const perDay: ColumnData[] = useMemo(() => {
    const dateStrs = weekDays.map((d) => toDateStr(d, timezone));
    const boundaries = programBoundaries(dateStrs, programs);
    return weekDays.map((d, i) => {
      const dateStr = dateStrs[i];
      const boundary = boundaries.get(dateStr);
      return {
        date: d,
        dateStr,
        timed: deriveTimedEntries(days[i]),
        untimed: deriveUntimedRows(days[i]),
        boundary: boundary ? boundaryLabel(boundary) : undefined,
      };
    });
  }, [weekDays, days, programs, timezone]);

  /**
   * ONE plan for the whole week — see the prop's note on WeekScheduleColumn.
   *
   * `variant: 'week'` forces focus mode unconditionally, and that is arithmetic
   * rather than a compromise: at every derived default on every common monitor a
   * week column is exactly one 140px channel, so there is nothing to divide.
   * Focus costs zero pixels and answers the question a week grid otherwise
   * cannot — where does this group actually land across the week.
   */
  const canvasGroupBy = useCanvasGroupBy();
  const routines = usePlannerStore((s) => s.routines);
  const goals = usePlannerStore((s) => s.goals);
  const lanePlan = useMemo(
    () =>
      planLanes(
        perDay.flatMap((c) => c.timed.map((e) => ({ itemType: e.itemType, item: e.item }))),
        canvasGroupBy,
        { variant: 'week', routines, programs, goals }
      ),
    [perDay, canvasGroupBy, routines, programs, goals]
  );

  // One shared range + hour height across the gutter and all 7 columns so the
  // labels stay aligned. Range spans the union of every day's items when idle,
  // the full day while dragging (every hour a drop target) or resizing (see/reach
  // any target time); rows shrink to fit the pane, except during resize where the
  // scale is frozen and the grid auto-scrolls instead.
  // One clock reading for the whole week: the diamond lands in today's column,
  // the reading of it goes in the shared gutter — so seven columns don't print
  // the same time seven times. Only weeks that contain today have a marker at
  // all, and only then does the window widen to make room for it.
  const todayStr = toDateStr(new Date(), timezone);
  const weekHasToday = weekDays.some((d) => toDateStr(d, timezone) === todayStr);
  const markerMin = showCurrentTimeIndicator && weekHasToday ? nowMin : null;

  const resizing = useScheduleResizeStore((s) => s.resizing);
  const allTimed = perDay.flatMap((c) => c.timed);
  const contentRange = useMemo(() => deriveGridRange(allTimed, markerMin), [allTimed, markerMin]);
  const { gridStartHour, gridEndHour } = activeId || resizing ? FULL_DAY_RANGE : contentRange;
  const hours = Array.from({ length: gridEndHour - gridStartHour }, (_, i) => gridStartHour + i);
  const { hourPx, anchorRef } = useFitHourPx(hours.length, resizing);
  useResizeScrollCompensation(gridStartHour, hourPx, resizing, anchorRef);

  // How wide the day columns are, and the ⌘-wheel gesture that changes it.
  const { colPx, scrolledX, ref: weekColsRef } = useWeekColumns('schedule');

  // All-or-nothing across the week: the rail costs 18px, and paying it on only
  // the columns that need it would misalign the seven hour grids.
  const showBoundaryRail = perDay.some((col) => !!col.boundary);

  const showNow = markerMin !== null && markerMin >= gridStartHour * 60 && markerMin < gridEndHour * 60;
  const nowMinShown = showNow ? markerMin! : null;
  const nowY = showNow ? ((markerMin! - gridStartHour * 60) / 60) * hourPx : null;
  const eclipsedHour =
    nowMinShown !== null && ((nowMinShown % 60) / 60) * hourPx < ECLIPSE_PX
      ? Math.floor(nowMinShown / 60)
      : null;

  return (
    <ScrollArea className="h-full flex-1">
      {/* ONE canvas-container around the caption AND the grid.
          The caption was in its own container for one commit, and a sticky box
          is constrained to its CONTAINING BLOCK: an 18px box holding an 18px
          element has no travel at all, so the caps scrolled away at ~43px on the
          one variant where they are the ONLY focus control. Sharing the grid's
          container is what gives them something to stick against — the same rule
          the pinned hour gutter below spells out in full.
          Its own `pt-6` went with it: LaneCapRow returns null when nothing is
          grouped, and a wrapper that pads regardless moved the whole ungrouped
          week 24px down. */}
      <div data-wide="true" className="canvas-container py-6 pb-20">
        <LaneCapRow plan={lanePlan} fieldLeft={DAY_FIELD_LEFT} z={LANE_CAP_Z} />
        <div ref={weekColsRef} className="flex gap-2">
        {/* Hour gutter — same top offsets as the columns so labels line up, and
            the same bare left-aligned mono marks the day view uses. Week has no
            Anytime rows of its own beside the gutter to answer to (its strips
            live inside the day columns), but the marks match day's inset anyway:
            switching scope shouldn't make the hour column change alignment under
            you. Narrowed to day's width for the same reason. */}
        {/*
          PINNED. Once columns are user-sized the grid scrolls sideways, and an
          hour grid whose hour labels have scrolled off the screen is just a
          field of rectangles. Four things make the pin work, none of them
          optional:

          1. It only works because the week grid dropped canvas-container's
             1100px cap (data-wide above). A sticky box is constrained to its
             CONTAINING BLOCK — this flex row — not to the scrollport, so under
             the cap the row ended at 1100px and the gutter came unstuck at
             scrollLeft > containerLeft + 1000, sliding off exactly when the
             scale control had made the grid wide enough to need it.
          2. The negative margin cancels canvas-container's left padding and the
             matching padding puts the content back, so the gutter's BOX starts
             at the scrollport edge while its labels stay where they were. Pin
             at `left-0` without it and columns scroll through the 32px of bare
             padding to the gutter's left.
          3. An opaque background, or the columns show through what they are
             supposed to be sliding under.
          4. WEEK_GUTTER_Z, which is one above the now-marker — see the constant
             for why z-10 is not enough.
        */}
        <div
          className={cn(
            'sticky left-0 flex flex-shrink-0 flex-col border-r bg-canvas transition-colors',
            // The edge treatment appears only once there is something behind
            // it. Hairline AND shadow for the same reason the body panel pairs
            // them: the shadow does the work in light mode, the hairline
            // survives in dark, where a black cast barely registers.
            scrolledX
              ? 'border-border/60 shadow-[6px_0_10px_-6px_rgb(0_0_0/0.12)]'
              : 'border-transparent'
          )}
          style={{
            zIndex: WEEK_GUTTER_Z,
            width: DAY_FIELD_LEFT + CANVAS_PAD_PX,
            marginLeft: -CANVAS_PAD_PX,
            paddingLeft: CANVAS_PAD_PX,
          }}
        >
          {/* The gutter matches the columns' vertical offsets exactly, so it
              pays the boundary rail's 18px too — otherwise every hour label
              sits 18px above the grid line it names. */}
          {showBoundaryRail && <div style={{ height: BOUNDARY_H }} />}
          <div style={{ height: HEADER_H }} />
          <div style={{ height: ANYTIME_H }} className="mt-2" />
          <div ref={anchorRef} className="relative mt-2">
            {hours.map((h) => (
              <div
                key={h}
                style={{ height: hourPx }}
                className={cn(
                  'pt-[3px] font-num text-2xs text-muted-foreground',
                  DAY_GUTTER_INSET,
                  // The live time is sitting on this label — it yields the column.
                  eclipsedHour === h && 'opacity-0'
                )}
              >
                {formatHourLabel(h, timeFormatStr)}
              </div>
            ))}
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
          </div>
        </div>

        {/*
          The week-nav slide lives on THIS wrapper, not on the row above, so the
          seven days slide in past a gutter that holds still. The hour labels are
          identical from one week to the next — sliding them is motion that means
          nothing, and once the grid scrolls sideways the pinned gutter visibly
          jitters 40px and back on every navigation.

          It has to be a wrapper rather than the class on each column, and it
          still does even though no column carries an opacity any more. The
          keyframes animate opacity 0.5 → 1, and an animation overrides a normal
          declaration — so the moment anyone gives a column a resting opacity
          again it would fade to 1 and then SNAP back the instant the animation
          ended. On a parent the two opacities multiply, which is what makes it
          smooth. (A resting column opacity is itself off the table now — see
          the column's own note — but the wrapper is what keeps the week slide
          from depending on that.)

          The key rides here too: it is what restarts the CSS animation on a week
          change, and keeping it off the row means the gutter — and the width
          measurement anchored to that row — survive the navigation.
        */}
        <div
          key={`${weekDays[0].toDateString()}-${navDirection ?? 'none'}`}
          // Scopes the recede to THIS row's columns. A pointer resting in a
          // gap between two columns hovers neither, so `:has()` misses and
          // nothing dims — which is why the rule keys on the columns rather
          // than on a `:hover` of the row itself.
          data-week-cols=""
          className={cn(
            'flex flex-none gap-2',
            navDirection && `animate-slide-in-from-${navDirection === 'left' ? 'right' : 'left'}`
          )}
        >
          {perDay.map((col) => (
            <WeekScheduleColumn
              key={col.dateStr}
              col={col}
              hours={hours}
              gridStartMin={gridStartHour * 60}
              hourPx={hourPx}
              colPx={colPx}
              activeId={activeId}
              selected={isSameDay(col.date, selectedDate)}
              // `col.dateStr === todayStr`, NOT date-fns `isToday`. isToday
              // reads the machine's local calendar day; todayStr is
              // `toDateStr(new Date(), timezone)` in the user's timezone, and
              // `nowY` is gated on that. With the two disagreeing across a date
              // boundary — a Tokyo user on a UTC machine at 21:00Z — the
              // now-marker landed in a column flagged `data-today="false"`, and
              // the header's lime date sat on the wrong day.
              today={col.dateStr === todayStr}
              nowY={col.dateStr === todayStr ? nowY : null}
              showBoundaryRail={showBoundaryRail}
              lanePlan={lanePlan}
            />
          ))}
          </div>
        </div>
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  );
}
