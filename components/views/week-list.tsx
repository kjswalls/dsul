'use client';

import { useMemo } from 'react';
import { format, startOfWeek, addDays, isToday, isSameDay } from 'date-fns';
import { ScrollArea } from '@/components/ui/scroll-area';
import { GroupSection } from '@/components/primitives/group-section';
import { TaskRow } from '@/components/primitives/task-row';
import { useDayItems } from '@/hooks/use-day-items';
import { usePlannerStore } from '@/lib/planner-store';
import { flattenDayRows } from '@/lib/day-items';
import { toDateStr } from '@/lib/recurrence';
import { groupRows } from '@/lib/grouping';
import { orderRows } from '@/lib/sort-rows';
import { useSinkHold } from '@/hooks/use-sink-hold';
import { useViewStore } from '@/lib/view-store';
import { useCanvasGroupBy } from '@/lib/extension-gates';
import { cn } from '@/lib/utils';

/**
 * Week × List (P5c): the week as a stacked agenda — a date heading per day
 * with that day's rows beneath. Empty days collapse to a whisper.
 */

function DaySection({ date }: { date: Date }) {
  const day = useDayItems(date);
  const { selectedDate, setSelectedDate, routines, programs, goals, userTimezone } =
    usePlannerStore();
  const groupBy = useCanvasGroupBy();
  const sortBy = useViewStore((s) => s.canvasSortBy);
  const selected = isSameDay(date, selectedDate);

  /**
   * Grouped, then sorted within each group — both post-derivation, never inside
   * deriveDayItems (see lib/sort-rows.ts).
   *
   * A week here is SEVEN independent lists, one per date heading, so both axes
   * apply per day: grouping by Project sections each day's own rows rather than
   * pulling the week into one partition. That is also why Week × List honours
   * ordering when Week × Schedule cannot — a day section has no time axis of its
   * own to contradict.
   *
   * The completed-sinks pass rides the same "seven independent lists" fact, and
   * takes THIS section's date rather than the store's `selectedDate`: a
   * recurring row's completion is per-date, so resolving all seven columns
   * against the selected day would sink Tuesday's tick in every column of the
   * week. Same rule TaskRow applies to its own per-date reads and writes below,
   * where `date` is passed for exactly this reason.
   *
   * Memoized on the date's identity, which `weekDays` below keeps stable, for
   * the reason Week × Buckets memoizes its own: `toDateStr` builds an uncached
   * Intl.DateTimeFormat per call, and this is seven sections re-running it on
   * every store change. Day × List and Day × Buckets resolve theirs unmemoized
   * because each pays for exactly one call per render — Day × Buckets already
   * threads one string down to all four cards rather than resolving per card.
   */
  const dateStr = useMemo(
    () => toDateStr(date, userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone),
    [date, userTimezone]
  );
  const { completedAs, rootRef } = useSinkHold<HTMLElement>();
  const groups = groupRows(flattenDayRows(day), groupBy, { routines, programs, goals }).map((g) => ({
    ...g,
    rows: orderRows(g.rows, sortBy, dateStr, completedAs),
  }));

  return (
    <section ref={rootRef}>
      <button
        onClick={() => setSelectedDate(date)}
        className={cn(
          'mb-1 flex items-baseline gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-accent',
          selected && 'bg-primary/10'
        )}
        title={`Select ${format(date, 'EEEE, MMMM d')}`}
      >
        <span className="text-base font-medium text-foreground">{format(date, 'EEEE')}</span>
        <span className="text-sm text-muted-foreground">{format(date, 'MMM d')}</span>
        {isToday(date) && (
          <span className="text-2xs font-medium uppercase tracking-wide text-success-text">today</span>
        )}
      </button>

      {day.totalCount === 0 ? (
        <p className="px-2 pb-2 font-serif text-sm italic text-muted-foreground/50">Nothing planned.</p>
      ) : (
        <div className="space-y-0 pl-2">
          {groups.map((g) =>
            // 'none' comes back as one section with an empty label, which is
            // this view's own default look: a flat list under the date heading.
            g.label ? (
              <GroupSection key={g.key} groupKey={g.key} label={g.label} gate={g.gate} variant="canvas">
                {g.rows.map((row) => (
                  <TaskRow key={row.item.id} row={row as never} date={date} />
                ))}
              </GroupSection>
            ) : (
              <div key={g.key || 'all'} className="space-y-0">
                {g.rows.map((row) => (
                  <TaskRow key={row.item.id} row={row as never} date={date} />
                ))}
              </div>
            )
          )}
        </div>
      )}
    </section>
  );
}

export function WeekList() {
  const { selectedDate, weekStartDay, navDirection } = usePlannerStore();

  const weekStartsOn = weekStartDay === 'monday' ? 1 : weekStartDay === 'saturday' ? 6 : 0;
  const weekDays = useMemo(() => {
    const start = startOfWeek(selectedDate, { weekStartsOn: weekStartsOn as 0 | 1 | 6 });
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [selectedDate, weekStartsOn]);

  return (
    <ScrollArea className="h-full flex-1">
      <div
        key={`${weekDays[0].toDateString()}-${navDirection ?? 'none'}`}
        className={cn(
          'canvas-container space-y-6 py-6 pb-20',
          navDirection && `animate-slide-in-from-${navDirection === 'left' ? 'right' : 'left'}`
        )}
      >
        {weekDays.map((day) => (
          <DaySection key={day.toDateString()} date={day} />
        ))}
      </div>
    </ScrollArea>
  );
}
