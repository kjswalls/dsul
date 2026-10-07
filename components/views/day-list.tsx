'use client';

import { format } from 'date-fns';
import { ScrollArea } from '@/components/ui/scroll-area';
import { GroupSection } from '@/components/primitives/group-section';
import { TaskRow } from '@/components/primitives/task-row';
import { useDayItems } from '@/hooks/use-day-items';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { useCanvasGroupBy } from '@/lib/extension-gates';
import { flattenDayRows } from '@/lib/day-items';
import { toDateStr } from '@/lib/recurrence';
import { groupRows, type RowGroup } from '@/lib/grouping';
import { orderRows } from '@/lib/sort-rows';
import { useSinkHold } from '@/hooks/use-sink-hold';
import { SeasonNotice } from '@/components/views/season-notice';
import { ListDropZone } from '@/components/views/list-drop-zone';
import { AddRow } from '@/components/planner/slot-composer';
import { rowScope } from '@/lib/slot-add';
import { useIsMobile } from '@/hooks/use-mobile';
import type { Task, HabitItem } from '@/lib/planner-types';
import { cn } from '@/lib/utils';

/**
 * Day × List (P5c): one flat, full-width list in slash-label groups (see
 * design/redesign/desktop_day_listView.png). Default grouping: HABITS /
 * TASKS / PROJECTS; canvasGroupBy overrides. Rows stay drag sources, and the
 * whole list is ONE drop target for this day (`list:{date}`, see
 * components/views/list-drop-zone.tsx) — no per-row zones, so a braindump item
 * dropped anywhere on it lands on this day.
 */

export type ListRow = { itemType: 'task' | 'habit'; item: Task | HabitItem };

/**
 * This view's no-grouping look: HABITS / TASKS / PROJECTS.
 *
 * Local, not in lib/grouping.ts, because it is a presentation choice for this
 * one view rather than an answer to "group by what" — Week × List's 'none' is a
 * flat list, the braindump's is a flat list, and the shared core's `'none'` is
 * one unlabelled section so each surface can render its own.
 */
function defaultListGroups(rows: ListRow[]): RowGroup<ListRow>[] {
  const habits = rows.filter((r) => r.itemType === 'habit');
  const tasks = rows.filter((r) => r.itemType === 'task');
  return [
    { key: 'Habits', label: 'Habits', rows: habits },
    { key: 'Tasks', label: 'Tasks', rows: tasks.filter((r) => !(r.item as Task).project) },
    { key: 'Projects', label: 'Projects', rows: tasks.filter((r) => (r.item as Task).project) },
  ].filter((g) => g.rows.length > 0);
}

export function DayList() {
  const day = useDayItems();
  const { selectedDate, navDirection, routines, seasons, goals, userTimezone } =
    usePlannerStore();
  const canvasGroupBy = useCanvasGroupBy();
  const sortBy = useViewStore((s) => s.canvasSortBy);
  const { completedAs, rootRef } = useSinkHold();

  /**
   * Sorted WITHIN each group, after grouping — the two axes are independent and
   * grouping owns the outer order.
   *
   * 'default' returns the same array, so routine grouping keeps the routine's
   * own sequence (routine_items.sort_order, the only place that order is visible
   * outside the manager). An explicit Ordering overrides it, which is the right
   * precedence: the user asked for it on this surface, now.
   *
   * `orderRows` then sinks finished rows to the foot of each group. Safe on the
   * WHOLE list here, unlike Day × Buckets: this layout has no per-row drop zones
   * at all (the one `list:{date}` target is the whole day), so nothing resolves
   * a drop against a neighbour's time and there is no timed spine to contradict.
   *
   * The day is resolved in the USER's zone, the same conversion TaskRow makes
   * for its own `completed` — a recurring row's completion is per-date, so
   * reading it against the browser's zone would sink today's tick a day early
   * or late for anyone east or west of it.
   */
  const dateStr = toDateStr(selectedDate, userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const rows = flattenDayRows(day);
  const addHere = !useIsMobile();
  const groups = (
    canvasGroupBy === 'none'
      ? defaultListGroups(rows)
      : groupRows(rows, canvasGroupBy, { routines, seasons, goals })
  ).map((g) => ({ ...g, rows: orderRows(g.rows, sortBy, dateStr, completedAs) }));

  return (
    <ScrollArea className="h-full flex-1">
      <div
        ref={rootRef}
        key={`${selectedDate.toDateString()}-${navDirection ?? 'none'}`}
        className={cn(
          'canvas-container space-y-5 py-6 pb-20',
          navDirection && `animate-slide-in-from-${navDirection === 'left' ? 'right' : 'left'}`
        )}
      >
        {/* Before the empty state, not after it: "nothing planned yet" is a
            lie on a day whose work is real and merely away, and that is exactly
            the day this line exists for. */}
        <SeasonNotice />

        {/* The floor gives an empty or short day a target worth aiming at;
            the negative margin lets the drop tint breathe past the rows. */}
        <ListDropZone dateStr={dateStr} className="-mx-2 min-h-[50vh] space-y-5 px-2">
          {day.totalCount === 0 ? (
            <div className="py-16 text-center">
              <p className="font-serif text-lg italic text-muted-foreground">
                Nothing planned for {format(selectedDate, 'EEEE')} yet.
              </p>
            </div>
          ) : (
            groups.map((g) => (
              <GroupSection key={g.key} groupKey={g.key} label={g.label} gate={g.gate} variant="canvas">
                {g.rows.map((row) => (
                  <TaskRow key={row.item.id} row={row as never} />
                ))}
              </GroupSection>
            ))
          )}
          {/* The day's own add line, at its end like the braindump's. Pointer
              surfaces only: the phone keeps its capture bar. */}
          {addHere && (
            <AddRow
              persistent
              target={{ kind: 'row', scope: rowScope('list', dateStr), dateStr, bucket: 'anytime' }}
              placeholder={`Add to ${format(selectedDate, 'EEEE')}`}
            />
          )}
        </ListDropZone>
      </div>
    </ScrollArea>
  );
}
