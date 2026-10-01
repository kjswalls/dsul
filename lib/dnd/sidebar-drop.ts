import { isPausedOn } from '../active';
import { isPausable } from '../item-registry';
import type { HabitItem, Task } from '../planner-types';
import { placementOf } from './handle-drag-end';

/**
 * What a drop on the `sidebar` droppable writes, for one item or a selection.
 *
 * A task on the canvas goes back to the braindump (`unscheduleTasks`). A habit
 * on the canvas is PAUSED instead (`setItemPaused`): it recurs, so it has no day
 * to take away, and the braindump's only home for it is the Paused section at
 * the sidebar's foot. Anything already in the braindump stays put, and so does
 * a habit that cannot be paused or already is.
 *
 * Shared by the shell's drop (app-shell.tsx handleDragEnd) and the braindump's
 * landing preview, so the sidebar lights exactly when the drop will write.
 *
 * `todayStr` is wall-clock today in the user's timezone: setItemPaused reads it
 * the same way, so the preview and the write agree on "already paused".
 */
export function sidebarDropPlan(
  ids: readonly string[],
  tasks: readonly Task[],
  habits: readonly HabitItem[],
  milestoneIds: ReadonlySet<string>,
  todayStr: string,
  tz: string
): { unschedule: string[]; pause: string[] } {
  const idSet = new Set(ids);
  const unschedule = tasks
    .filter((t) => idSet.has(t.id) && !milestoneIds.has(t.id) && placementOf(t).placed)
    .map((t) => t.id);
  const pause = habits
    .filter(
      (h) =>
        idSet.has(h.id) &&
        placementOf(h).placed &&
        isPausable(h) &&
        !isPausedOn(h, todayStr, tz)
    )
    .map((h) => h.id);
  return { unschedule, pause };
}
