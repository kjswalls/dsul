import { isPausedOn } from '../active';
import { planBlockDrop, type BlockItem } from '../block-moves';
import { isPausable } from '../item-registry';
import type { HabitItem, Task } from '../planner-types';
import { placementOf } from './handle-drag-end';

/**
 * What a drop on the `sidebar` droppable writes, for one item or a selection.
 *
 * A task on the canvas goes back to the braindump (`unscheduleTasks`) where the
 * single drop would send it: the shared block drop rule (lib/block-moves.ts
 * planBlockDrop), whose braindump answer is Move to Braindump's, so never a
 * series, a finished task, one in a project block or a milestone. A habit
 * on the canvas is PAUSED instead (`setItemPaused`): it recurs, so it has no day
 * to take away, and its home is Organize's Paused section, which the
 * braindump's moon counts and opens. Anything already in the braindump stays put, and so does
 * a habit that cannot be paused or already is.
 *
 * Shared by the shell's drop (app-shell.tsx handleDragEnd) and the braindump's
 * landing preview, so the sidebar lights exactly when the drop will write.
 *
 * `rewrite` is what a selection's `unscheduleTasks` is called with: the canvas
 * tasks in `unschedule`, and the rows already in the braindump, written in its
 * shape again as the single drop writes them (milestones never; the bulk verb
 * refuses them). It is empty when the selection holds a canvas task the rule
 * keeps where it is and nothing on the canvas moves: the drop then falls
 * through to the dragged row alone, as a refused single drop does, instead of
 * rewriting braindump rows with nothing landing.
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
): { unschedule: string[]; pause: string[]; rewrite: string[] } {
  const idSet = new Set(ids);
  // The rule answers `none` for a row already in the braindump, so only a
  // placed row can answer `braindump`.
  const from = { date: todayStr, skipped: false };
  const unschedule = tasks
    .filter(
      (t) =>
        idSet.has(t.id) &&
        planBlockDrop({ type: 'task', ...t } as BlockItem, from, { kind: 'braindump' }, { milestoneIds }).kind ===
          'braindump'
    )
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
  const sendsBack = new Set(unschedule);
  const asked = tasks.filter((t) => idSet.has(t.id) && !milestoneIds.has(t.id));
  const held = asked.some((t) => placementOf(t).placed && !sendsBack.has(t.id));
  const rewrite =
    held && !unschedule.length && !pause.length
      ? []
      : asked.filter((t) => sendsBack.has(t.id) || !placementOf(t).placed).map((t) => t.id);
  return { unschedule, pause, rewrite };
}
