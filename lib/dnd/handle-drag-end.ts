import type { TimeBucket } from '../planner-types';
import { toDateStr } from '../recurrence';
import { isDropTargetOffered } from './drop-targets';
import type { DragInput } from './sensors';

/**
 * Pure resolution of a dnd-kit drop into a planner command.
 *
 * The droppable-ID grammar this parses is the parity contract for all view
 * rewrites — see lib/dnd/CONTRACT.md. The shell owns mapping the returned
 * command onto planner-store actions.
 */

export const BUCKET_IDS: readonly TimeBucket[] = ['anytime', 'morning', 'afternoon', 'evening'];

export type DropPosition = 'before' | 'after' | 'empty';

export type DropCommand =
  | { kind: 'schedule-task'; taskId: string; bucket: TimeBucket; time?: string; dateStr: string }
  | { kind: 'schedule-habit'; habitId: string; bucket: TimeBucket; time?: string }
  | { kind: 'assign-habit-bucket'; habitId: string; bucket: TimeBucket }
  | { kind: 'unschedule'; itemId: string }
  | { kind: 'move-task-to-project-block'; taskId: string }
  | { kind: 'move-task-to-date'; taskId: string; dateStr: string };

/**
 * Where the dragged item sits right now, as far as a `list:{date}` drop cares.
 *
 * `placed` is the braindump's own membership test turned around
 * (components/sidebar/braindump.tsx): a task is in the braindump exactly when it
 * has no `isScheduled` and no `timeBucket`; a habit when it has no `timeBucket`
 * and no recurrence. Anything else is on the canvas.
 */
export interface DragPlacement {
  placed: boolean;
  /**
   * The task's `startDate` as a bare `yyyy-MM-dd` (legacy rows can hold a full
   * ISO string; lib/day-items.ts cuts those at 'T' too). Habits carry no date.
   */
  dateStr?: string;
  /**
   * A recurring item's `startDate` is its SERIES anchor, not the day the row is
   * showing on, so a drop can neither compare it to a list day nor move it: the
   * carry verbs refuse recurring items for the same reason (lib/row-moves.ts).
   */
  recurring?: boolean;
}

export function placementOf(item: {
  type?: string;
  isScheduled?: boolean;
  timeBucket?: string;
  startDate?: string;
  repeatFrequency?: string;
}): DragPlacement {
  const recurring = !!item.repeatFrequency && item.repeatFrequency !== 'none';
  return {
    placed: !!(item.isScheduled || item.timeBucket || (item.type === 'habit' && recurring)),
    dateStr: item.startDate?.split('T')[0],
    recurring,
  };
}

/**
 * `list:{yyyy-MM-dd}` — a Day × List body, or one day's section of Week × List.
 *
 * A list has no buckets and no hours to aim at, so the drop can only say WHICH
 * DAY. What that means depends on where the item comes from:
 *
 * - From the braindump, it is the Week × Schedule Anytime strip's drop
 *   (`week:{date}:anytime`): onto that day, Anytime, no time.
 * - From the canvas, onto a DIFFERENT day, it is the row's Reschedule verb
 *   (`moveTaskToDate`): the day changes and the bucket and clock time the user
 *   already gave it are kept. Resetting them to Anytime would be the drop
 *   deciding something the list never showed.
 * - Onto the day it is already on, it is nothing. The list's own rows are drag
 *   sources sitting inside this target, and a drag that goes nowhere must not
 *   write (or arm an undo) on release.
 * - A recurring task on the canvas: nothing. Its date is the series anchor,
 *   so "move" would shift or truncate the whole series (lib/row-moves.ts
 *   refuses it in the carry verbs for the same reason).
 * - A habit: nothing. One on the canvas recurs and has no day to move to; one
 *   in the braindump does not recur, and giving it a bucket with no recurrence
 *   would take it off the braindump and put it on no day at all
 *   (shouldShowOnDate is false for 'none').
 */
export function listDropCommand(
  itemId: string,
  itemType: 'task' | 'habit',
  placement: DragPlacement,
  dateStr: string
): DropCommand | null {
  if (itemType === 'habit') return null;
  if (!placement.placed) return { kind: 'schedule-task', taskId: itemId, bucket: 'anytime', dateStr };
  if (placement.recurring || placement.dateStr === dateStr) return null;
  return { kind: 'move-task-to-date', taskId: itemId, dateStr };
}

/**
 * The members of a multi-selection a `list:{date}` drop moves with
 * `moveTasksToDate`: task-likes that are in the braindump or on another day,
 * minus milestones (the bulk verb refuses them) and recurring canvas tasks (see
 * listDropCommand). Shared by the shell's drop and the zone's highlight, so the
 * target lights exactly when the drop will write.
 */
export function listGroupMovers<
  T extends { id: string; isScheduled?: boolean; timeBucket?: string; startDate?: string; repeatFrequency?: string },
>(ids: ReadonlySet<string> | readonly string[], dateStr: string, tasks: readonly T[], milestoneIds: ReadonlySet<string>): string[] {
  const idSet = new Set(ids);
  return tasks
    .filter((t) => {
      if (!idSet.has(t.id) || milestoneIds.has(t.id)) return false;
      const at = placementOf(t);
      if (!at.placed) return true;
      return !at.recurring && at.dateStr !== dateStr;
    })
    .map((t) => t.id);
}

export interface DropContext {
  /** What kind of item is being dragged (null → drop is ignored). */
  itemType: 'task' | 'habit' | null;
  /**
   * What is driving the gesture — `dragInputOf(event.activatorEvent)`, i.e. the
   * sensor that actually claimed THIS drag, never a viewport or capability
   * query. Required rather than defaulted so a new caller has to answer it:
   * defaulting to `'pointer'` would hand any future call site the desktop
   * grammar by omission, which is how a touch rule half-reverts.
   *
   * Not every target is offered to every input (lib/dnd/drop-targets.ts) — a
   * drop on one that is withheld resolves to nothing.
   */
  input: DragInput;
  /** Project of the dragged task, for the projectblock guard. */
  draggedTaskProject?: string;
  /**
   * Where the dragged item sits now, for the `list:{date}` guard. Omitted reads
   * as "in the braindump", the one case where every list drop acts.
   */
  draggedPlacement?: DragPlacement;
  /**
   * The day the canvas is showing, and the user's timezone. The dropped day
   * string is resolved HERE via toDateStr(selectedDate, userTimezone) — the same
   * convention deriveDayItems keys a task's startDate against. Passing a string
   * pre-formatted with date-fns (the machine's timezone) silently assigned the
   * MACHINE tz's day, so a user whose saved timezone differed saw a day-view
   * drop land a day off (drop on "today" → shows tomorrow).
   */
  selectedDate: Date;
  userTimezone: string;
  /** Start time of the reference item in a scheduled:{...}:{before|after} drop. */
  getRefTime: (refType: 'task' | 'habit', refId: string) => string | undefined;
  /** Infer a concrete time for a drop into a scheduled section. */
  inferDropTime: (bucket: TimeBucket, position: DropPosition, refTime?: string) => string;
}

export function resolveDrop(
  itemId: string,
  targetId: string,
  ctx: DropContext
): DropCommand | null {
  const { itemType } = ctx;
  if (!itemType) return null;
  /**
   * The GRAMMAR-LEVEL input rule: what does this id mean for this input?
   *
   * Not a backstop for the view's mount gate — a different question, asked at a
   * different level. The view decides what to OFFER, which is per-view and about
   * geometry (day-buckets.tsx swaps the sliver for a `spine:` box on touch, so
   * the finger still gets a target in that gap). This is a total function over
   * every id shape in lib/dnd/CONTRACT.md and every view that will ever emit
   * one: an id a view should not have offered resolves to nothing here, rather
   * than to a time the user cannot see themselves having asked for.
   *
   * An id the grammar does not classify passes, so this can only ever subtract
   * the targets lib/dnd/drop-targets.ts names.
   */
  if (!isDropTargetOffered(targetId, ctx.input)) return null;
  const selectedDateStr = toDateStr(ctx.selectedDate, ctx.userTimezone);

  // scheduled:{bucket}:{before|after}:{refType}:{refId} | scheduled:{bucket}:empty
  if (targetId.startsWith('scheduled:')) {
    const parts = targetId.split(':');
    const bucket = parts[1] as TimeBucket;
    const position = parts[2] as DropPosition;

    let time: string;
    if (position === 'empty') {
      time = ctx.inferDropTime(bucket, 'empty');
    } else {
      const refTime = ctx.getRefTime(parts[3] as 'task' | 'habit', parts[4]);
      time = ctx.inferDropTime(bucket, position, refTime);
    }

    return itemType === 'task'
      ? { kind: 'schedule-task', taskId: itemId, bucket, time, dateStr: selectedDateStr }
      : { kind: 'schedule-habit', habitId: itemId, bucket, time };
  }

  // Bare bucket id (outer bucket droppable) — assign without a time
  if ((BUCKET_IDS as readonly string[]).includes(targetId)) {
    const bucket = targetId as TimeBucket;
    return itemType === 'task'
      ? { kind: 'schedule-task', taskId: itemId, bucket, dateStr: selectedDateStr }
      : { kind: 'assign-habit-bucket', habitId: itemId, bucket };
  }

  // spine:{bucket}:{above|below}:{itemId} — the touch-only stand-in for the
  // sliver above. Same box, same centre; the COMMAND is the difference. It
  // assigns the bucket with no time, which is exactly the untimed section's
  // action — the `{above|below}:{itemId}` tail is there to keep the ids unique
  // per gap (dnd-kit keys its registry by id) and is deliberately not read.
  // See lib/dnd/drop-targets.ts for why deleting the sliver instead of
  // substituting for it re-routes the bottom of a tall card to the next bucket.
  if (targetId.startsWith('spine:')) {
    const bucket = targetId.split(':')[1] as TimeBucket;
    return itemType === 'task'
      ? { kind: 'schedule-task', taskId: itemId, bucket, dateStr: selectedDateStr }
      : { kind: 'assign-habit-bucket', habitId: itemId, bucket };
  }

  // unscheduled:{bucket} — untimed section of a bucket
  if (targetId.startsWith('unscheduled:')) {
    const bucket = targetId.replace('unscheduled:', '') as TimeBucket;
    return itemType === 'task'
      ? { kind: 'schedule-task', taskId: itemId, bucket, dateStr: selectedDateStr }
      : { kind: 'assign-habit-bucket', habitId: itemId, bucket };
  }

  // sidebar — drop back into the Braindump, i.e. unschedule
  if (targetId === 'sidebar') {
    return { kind: 'unschedule', itemId };
  }

  // projectblock:{projectName} — only tasks belonging to that project
  if (targetId.startsWith('projectblock:')) {
    const projectName = targetId.replace('projectblock:', '');
    if (itemType === 'task' && ctx.draggedTaskProject === projectName) {
      return { kind: 'move-task-to-project-block', taskId: itemId };
    }
    return null;
  }

  // hour:{H} — day-schedule grid slot; drop lands at the top of that hour
  // in the bucket that owns it (P5d "drop-on-hour" v1)
  if (targetId.startsWith('hour:')) {
    const hour = Number(targetId.slice(5));
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
    const bucket: TimeBucket = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
    const time = `${String(hour).padStart(2, '0')}:00`;
    return itemType === 'task'
      ? { kind: 'schedule-task', taskId: itemId, bucket, time, dateStr: selectedDateStr }
      : { kind: 'schedule-habit', habitId: itemId, bucket, time };
  }

  // weekhour:{yyyy-MM-dd}:{H} — week-schedule grid slot; drop lands at the top
  // of that hour on that day's column (date has no colons, so split is safe)
  if (targetId.startsWith('weekhour:')) {
    const parts = targetId.split(':');
    const dateStr = parts[1];
    const hour = Number(parts[2]);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
    const bucket: TimeBucket = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
    const time = `${String(hour).padStart(2, '0')}:00`;
    return itemType === 'task'
      ? { kind: 'schedule-task', taskId: itemId, bucket, time, dateStr }
      : { kind: 'schedule-habit', habitId: itemId, bucket, time };
  }

  // list:{yyyy-MM-dd} — a list-layout day (see listDropCommand)
  if (targetId.startsWith('list:')) {
    const dateStr = targetId.slice('list:'.length);
    return listDropCommand(itemId, itemType, ctx.draggedPlacement ?? { placed: false }, dateStr);
  }

  // week:{yyyy-MM-dd}:{bucket}
  if (targetId.startsWith('week:')) {
    const parts = targetId.split(':');
    const dateStr = parts[1];
    const bucket = parts[2] as TimeBucket;
    return itemType === 'task'
      ? { kind: 'schedule-task', taskId: itemId, bucket, dateStr }
      : { kind: 'schedule-habit', habitId: itemId, bucket };
  }

  return null;
}
