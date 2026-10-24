/**
 * What dropping a schedule block does: one rule for the web and the phone.
 *
 * `planBlockDrop` answers what a drop MEANS, never how a client writes it. The
 * web maps each answer to a store call (lib/dnd/handle-drag-end.ts resolveDrop,
 * then components/shell/app-shell.tsx); the iPhone maps it to an item intent
 * (DsulCore BlockMoves.swift, checked against tests/fixtures/day/block-moves.json,
 * which tests/unit/block-moves-fixtures.test.ts writes from this file).
 *
 * It is keyed on the registry, never on task vs habit: `dateAnchored`, whether
 * the item repeats, `inProjectBlock`, and the gates the verbs already ask.
 *
 * - An hour. A dated one-off is PLACED on the day it was dropped on (its date
 *   and its time). Anything whose date is not the drop's to change keeps it and
 *   is RETIMED: a series, whose `startDate` is the series anchor (moving it would
 *   take every earlier day's occurrence away), and a type with no date at all
 *   (habits). On another Week column that means the time lands on its own day.
 *   The one exception is a series inside a project block: a time alone would
 *   leave it drawn in the block, so it is placed on its own start date, which
 *   releases it. A series still in the braindump is not a block yet, and is
 *   placed on the day like a one-off.
 * - Anytime. Its own day takes it, out of any time. Another day takes only a
 *   dated one-off, which moves there; a series or an undated type has no other
 *   day to go to. A task inside a project block is refused, since the block,
 *   not a part of day, is where it is drawn.
 * - The braindump. A dated type goes back behind Move to Braindump's own gate
 *   (lib/row-moves.ts canSendToBraindump: not repeating, not in a block, not a
 *   milestone, still open; and, as the verb and the server ask, dated and not a
 *   subtask). A type with no date has nothing to take away, so it
 *   pauses, where the registry lets it (the web's drop, lib/dnd/CONTRACT.md).
 *   A row the braindump already lists stays put.
 * - Its own place: nothing to do. A skipped occurrence never moves.
 */
import { getItemTypeConfig, isPausable } from '@/lib/item-registry';
import type { Item } from '@/lib/planner-types';
import { isRecurring } from '@/lib/recurrence';
import { canSendToBraindump } from '@/lib/row-moves';
import { getBucketForTime } from '@/lib/time-bucket';

/** The fields the rule reads: the app's camelCase item (lib/db.ts itemFromRow). */
export interface BlockItem {
  id: string;
  /** 'task', 'habit', or 'custom' with the slug in `customType`. */
  type: string;
  customType?: string;
  status?: string;
  repeatFrequency?: string;
  /** yyyy-MM-dd; a legacy row may hold a full ISO string. */
  startDate?: string;
  startTime?: string;
  timeBucket?: string;
  isScheduled?: boolean;
  inProjectBlock?: boolean;
  previousStartTime?: string;
  previousStartDate?: string;
  completedDates?: string[];
  parentItemId?: string | null;
}

/**
 * Where the block was lifted from: the day it was drawn on, and whether that
 * day's occurrence is skipped (the client knows it drew a skipped strip).
 */
export interface BlockOrigin {
  date: string;
  skipped: boolean;
}

/** Where it was let go. `startMin` is minutes after midnight on `date`. */
export type BlockTarget =
  | { kind: 'hour'; date: string; startMin: number }
  | { kind: 'anytime'; date: string }
  | { kind: 'braindump' };

export interface BlockDropContext {
  /**
   * Every live goal's milestone ids, or null while they are unknown (the phone
   * before its payload carries goals). Read only by the braindump drop.
   */
  milestoneIds: ReadonlySet<string> | null;
}

export type BlockDropRefusal =
  /** The occurrence on the origin day is skipped. */
  | 'skipped'
  /** Anytime, for a task drawn inside a project block. */
  | 'in-block'
  /** Another day's Anytime, for an item whose date the drop may not change. */
  | 'another-day'
  /** The braindump, for a dated item Move to Braindump refuses. */
  | 'not-braindump'
  /** The braindump, while the milestone ids are not known. */
  | 'milestones-unknown'
  /** The braindump, for an undated item the registry will not pause. */
  | 'not-pausable'
  /** An hour target outside the day. */
  | 'invalid';

export type BlockDrop =
  /** On `date` at `startMin`: the item's date becomes `date`. */
  | { kind: 'place'; date: string; startMin: number }
  /** At `startMin`, its date untouched. */
  | { kind: 'retime'; startMin: number }
  /** Under Anytime with no time; `date` null keeps its date, a string moves it there. */
  | { kind: 'anytime'; date: string | null }
  /** Back to the braindump. */
  | { kind: 'braindump' }
  /** Paused. */
  | { kind: 'pause' }
  /** Already there. */
  | { kind: 'none' }
  | { kind: 'refused'; reason: BlockDropRefusal };

const MINUTES_PER_DAY = 24 * 60;

/** `startMin` as the stored "HH:MM". */
export function startTimeOf(startMin: number): string {
  const h = Math.floor(startMin / 60);
  const m = startMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function typeNameOf(item: BlockItem): string {
  return item.type === 'custom' && item.customType ? item.customType : item.type;
}

function hasStash(item: BlockItem): boolean {
  return !!item.previousStartTime || !!item.previousStartDate;
}

const refused = (reason: BlockDropRefusal): BlockDrop => ({ kind: 'refused', reason });

export function planBlockDrop(
  item: BlockItem,
  from: BlockOrigin,
  target: BlockTarget,
  ctx: BlockDropContext,
): BlockDrop {
  if (from.skipped) return refused('skipped');

  const anchored = getItemTypeConfig(typeNameOf(item)).dateAnchored;
  const series = isRecurring(item);
  // Placed somewhere on the canvas, as the braindump's member test asks it
  // (lib/braindump-members.ts): marked scheduled, or filed under a part of day.
  const placed = !!item.isScheduled || !!item.timeBucket;
  // The drop may not change this item's date: a series block keeps its anchor,
  // and a type with no date has none. A series with no start date is drawn on
  // no day (lib/day-items.ts), and one in the braindump is not a block at all,
  // so a drop gives it the day it lands on, as it does a one-off (and as the
  // web's braindump-to-grid drop does).
  const keepsDate = !anchored || (series && !!item.startDate && placed);
  // On the grid as the web stores a placed row: a dated row says so with
  // `isScheduled`; an undated one is placed by its part of day alone.
  const onGrid = !anchored || !!item.isScheduled;

  if (target.kind === 'hour') {
    const { startMin } = target;
    if (!Number.isInteger(startMin) || startMin < 0 || startMin >= MINUTES_PER_DAY) {
      return refused('invalid');
    }
    const time = startTimeOf(startMin);
    const atTime =
      onGrid && !item.inProjectBlock && !hasStash(item) && item.startTime === time
      && item.timeBucket === getBucketForTime(time);
    if (keepsDate) {
      if (anchored && item.inProjectBlock) {
        return { kind: 'place', date: item.startDate!.split('T')[0], startMin };
      }
      return atTime ? { kind: 'none' } : { kind: 'retime', startMin };
    }
    if (atTime && item.startDate === target.date) return { kind: 'none' };
    return { kind: 'place', date: target.date, startMin };
  }

  if (target.kind === 'anytime') {
    if (item.inProjectBlock) return refused('in-block');
    const atAnytime = onGrid && item.timeBucket === 'anytime' && !item.startTime && !hasStash(item);
    if (keepsDate) {
      if (target.date !== from.date) return refused('another-day');
      return atAnytime ? { kind: 'none' } : { kind: 'anytime', date: null };
    }
    // A dated one-off is drawn only on its own date, so another day's Anytime
    // (or any day's, for a row with no date yet) moves it there.
    if (item.startDate?.split('T')[0] !== target.date) return { kind: 'anytime', date: target.date };
    return atAnytime ? { kind: 'none' } : { kind: 'anytime', date: null };
  }

  // The braindump. It already lists (lib/braindump-members.ts, suppression
  // aside) a dated row placed nowhere that is not let go, and an undated one
  // placed nowhere that does not repeat either.
  const member = !placed && (anchored ? item.status !== 'cancelled' : !series);
  if (member) return { kind: 'none' };
  if (!anchored) return isPausable(item as unknown as Item) ? { kind: 'pause' } : refused('not-pausable');
  if (!ctx.milestoneIds) return refused('milestones-unknown');
  // Move to Braindump's gate: the verb's (lib/verb-gates.ts, a row with a day
  // to take away) and the server's (lib/item-intents.ts applyUnschedule, never
  // a subtask), around canSendToBraindump.
  if (!item.startDate || item.parentItemId) return refused('not-braindump');
  return canSendToBraindump(item as unknown as Item, 'task', from.date, ctx.milestoneIds)
    ? { kind: 'braindump' }
    : refused('not-braindump');
}
