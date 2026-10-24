import type { TimeBucket } from './planner-types';
import { getBucketForTime } from './time-bucket';

/**
 * Changing a block's length on the schedule grid: where a dragged edge lands,
 * and the one write it ends in.
 *
 * The web's resize handles (components/views/day-schedule.tsx ScheduleBlock,
 * a mouse or pen on the 12px strip at either edge; a finger never resizes
 * there) and the iPhone's two grips (shown on a block chosen through Change
 * length; DsulCore ScheduleMath.swift `resizePreview`) run the same maths.
 * tests/fixtures/day/resize.json pins it for the Swift twin.
 *
 * The rules, in minutes since midnight:
 *
 *  - The bottom edge changes the length and keeps the start: the length plus
 *    the pointer's travel, snapped to 15, never under 15. The top edge moves
 *    the start and keeps the end: the start plus the travel, snapped to 15,
 *    never closer than 15 to the end, and never before 0:00.
 *  - The travel (`deltaMin`) is the pointer's movement plus the scroll's since
 *    the press, in minutes at the grid's hour height (`resizeDeltaMin`), so an
 *    edge keeps following while the grid scrolls under it.
 *  - The day holds both edges, and wins over the 15-minute floor. The end
 *    stops at 24:00 on both: the bottom edge's never runs past it (so a block
 *    starting after 23:45 runs to midnight and no further), and the top edge
 *    keeps a stored end past midnight at 24:00, so its start stops at 23:45
 *    and its length is never over a day. A start never goes before 0:00 (so
 *    a block ending before 0:15 can only start at 0:00). The grid draws
 *    nothing after midnight, the route caps a length at 1,440, and `HH:MM`
 *    has no 24:15 or -1:-5 to write.
 *  - An edge with nothing inside the day to hold to stays where it is, so
 *    nothing is written: the bottom edge of a block stored starting outside
 *    the day (24:00 or later, or before 0:00, as the old maths could write),
 *    and the top edge of one stored ending at or before 0:00.
 *  - These stops are the one change from the web's inline maths (Week and
 *    blocks PR 9): every block that starts and ends inside the day, and ends
 *    at 0:15 or later, lands where it did.
 *
 * The write (`resizeWrite`): the bottom edge sends the length alone; the top
 * edge sends the start, the length and the start's part of day together
 * (lib/time-bucket.ts getBucketForTime), since a time sent without its bucket
 * beside a stored Anytime is refused (lib/item-edit.ts editRefusal, `invalid`)
 * and the store's auto-correct leaves Anytime as it is. Nothing is written
 * when the edge lands where it started.
 */

export type ResizeEdge = 'top' | 'bottom';

/** A block's place on the grid: its start and its length, in minutes. */
export interface BlockSpan {
  startMin: number;
  duration: number;
}

/** Every edge lands on a quarter hour. */
export const RESIZE_SNAP_MIN = 15;

/** The shortest a grip makes a block, unless the day ends sooner. */
export const RESIZE_MIN_DURATION = 15;

/** Midnight at the end of the day: no grip moves an edge past it. */
export const DAY_END_MIN = 1440;

/** To the nearest quarter hour, halves up (JavaScript's Math.round). */
export function snapToQuarter(min: number): number {
  return Math.round(min / RESIZE_SNAP_MIN) * RESIZE_SNAP_MIN;
}

/** A travel in pixels at `hourPx` to the hour, in minutes (not snapped). */
export function resizeDeltaMin(deltaPx: number, hourPx: number): number {
  return (deltaPx / hourPx) * 60;
}

/**
 * Where the dragged edge puts the block, `deltaMin` minutes from where it was
 * pressed (positive is later). The other edge stays: the bottom edge keeps the
 * start, the top edge the end (at 24:00 when it was stored past midnight).
 * For a travel that is a number, an answer that differs from the block as
 * pressed starts at 0:00 or later, ends at 24:00 or sooner, and is at least a
 * minute long, so its write is one the route takes.
 *
 * It snaps with no travel too (a 9:10 block's top edge answers 9:15 at 0), so
 * a caller shows the block as pressed until the pointer or the grid has moved,
 * as the web's handles do: ScheduleBlock asks this only on a move or an
 * autoscroll step, so a press let go unmoved writes nothing.
 */
export function resizePreview(edge: ResizeEdge, startMin: number, duration: number, deltaMin: number): BlockSpan {
  if (edge === 'bottom') {
    // The start stays, so one outside the day has no length that ends inside it.
    if (startMin < 0 || startMin >= DAY_END_MIN) return { startMin, duration };
    const length = Math.max(RESIZE_MIN_DURATION, snapToQuarter(duration + deltaMin));
    return { startMin, duration: Math.min(length, DAY_END_MIN - startMin) };
  }
  // The end stays, held to 24:00, so one at or before 0:00 has no start before it.
  const end = Math.min(startMin + duration, DAY_END_MIN);
  if (end <= 0) return { startMin, duration };
  const latest = end - RESIZE_MIN_DURATION;
  const start = Math.max(0, Math.min(snapToQuarter(startMin + deltaMin), latest));
  return { startMin: start, duration: end - start };
}

/** Minutes since midnight as the stored `HH:MM`: 570 is "09:30". */
export function minutesToTime(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/** What a resize writes: the length alone, or the start with its length and part of day. */
export type ResizeWrite =
  | { duration: number }
  | { startTime: string; duration: number; timeBucket: TimeBucket };

/**
 * The write an edge ends in, `from` the block as it was pressed `to` where it
 * was let go: null when nothing changed. The web hands it to the store action
 * of the item's own type (updateTask or updateHabit); the phone sends it as
 * `time` to /api/app/items/:id.
 */
export function resizeWrite(edge: ResizeEdge, from: BlockSpan, to: BlockSpan): ResizeWrite | null {
  if (edge === 'bottom') return to.duration !== from.duration ? { duration: to.duration } : null;
  if (to.startMin === from.startMin && to.duration === from.duration) return null;
  const startTime = minutesToTime(to.startMin);
  return { startTime, duration: to.duration, timeBucket: getBucketForTime(startTime) };
}
