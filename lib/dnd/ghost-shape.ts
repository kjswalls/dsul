import { DAY_FIELD_LEFT, LANE_PX, PANE_MIN_H, PANE_OFFSET, PANE_TRIM } from '@/lib/schedule-constants';

/**
 * What the drag ghost looks like over the target under it (Kirby's pick B,
 * 2026-10-30, mock: /mnt/project-files/drag-polish/drag-panel.html).
 *
 * It picks up as an exact twin of what was grabbed, at its size. Over another
 * place it takes the shape it would land as there:
 *
 * - `home`  nothing under it, or its own kind of place at its own width: the twin.
 * - `row`   a list (a bucket, a list day, the braindump, an Anytime strip): a
 *           row never wider than the place under it, so a Day row carried into
 *           the braindump or a week column fits it instead of overhanging it.
 * - `block` an hour on a schedule grid: a block at that hour, as long as the
 *           item, sitting where the block will be. The ghost snaps there instead
 *           of floating, so it IS the landing preview and the hour needs no tint.
 *
 * Pure geometry, so the DragGhost and the overlay's snap modifier answer from
 * one place and a unit test can pin it.
 */

export interface GhostRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type GhostShape =
  | { kind: 'home' }
  | { kind: 'row'; width: number }
  | { kind: 'block'; rect: GhostRect; hour: number };

/** The block wrapper's `right-1`. */
const BLOCK_RIGHT_INSET = 4;
/** A synthesized row's height when the twin can't be a clone (a block carried to a list). */
export const GHOST_ROW_H = 29;
/** The widest a block carried into a list may be drawn: a Day list is the canvas's width. */
const ROW_FROM_BLOCK_MAX_W = 480;

/** `hour:{H}` (Day, whose slot spans the gutter the blocks start past) or `weekhour:{date}:{H}` (Week): the hour and how far in the field starts. */
export function gridHourOf(overId: string): { hour: number; fieldLeft: number } | null {
  const day = /^hour:(\d{1,2})$/.exec(overId);
  if (day) return { hour: Number(day[1]), fieldLeft: DAY_FIELD_LEFT };
  const week = /^weekhour:\d{4}-\d{2}-\d{2}:(\d{1,2})$/.exec(overId);
  if (week) return { hour: Number(week[1]), fieldLeft: 0 };
  return null;
}

export function ghostShapeFor(args: {
  overId: string | null;
  overRect: GhostRect | null;
  /** The grabbed element's size at pickup. */
  home: { width: number; height: number };
  /** True when a schedule block was grabbed, false for a row. */
  fromBlock: boolean;
  /** The item's block length, for the hour it would land on. */
  durationMin: number;
}): GhostShape {
  const { overId, overRect, home, fromBlock, durationMin } = args;
  if (!overId || !overRect) return { kind: 'home' };

  const grid = gridHourOf(overId);
  if (grid) {
    // The slot is one hour tall, so its height is the grid's hour scale.
    const hourPx = overRect.height;
    const left = overRect.left + grid.fieldLeft + LANE_PX;
    return {
      kind: 'block',
      hour: grid.hour,
      rect: {
        left,
        top: overRect.top + PANE_OFFSET,
        width: Math.max(0, overRect.left + overRect.width - BLOCK_RIGHT_INSET - left),
        height: Math.max(PANE_MIN_H, Math.round((durationMin / 60) * hourPx) - PANE_TRIM),
      },
    };
  }

  const width = Math.min(fromBlock ? ROW_FROM_BLOCK_MAX_W : home.width, overRect.width);
  // A row over a list at least as wide as itself is just itself.
  if (!fromBlock && width >= home.width) return { kind: 'home' };
  return { kind: 'row', width };
}

/** The ghost's size for a shape: the home size, a row's width at its height, or the block. */
export function ghostSize(shape: GhostShape, home: { width: number; height: number }, fromBlock: boolean) {
  if (shape.kind === 'block') return { width: shape.rect.width, height: shape.rect.height };
  if (shape.kind === 'row') return { width: shape.width, height: fromBlock ? GHOST_ROW_H : home.height };
  return home;
}

/**
 * Where the overlay's transform puts the ghost. The overlay sits on the grabbed
 * element's rect plus the transform, so a block is placed by undoing that; a row
 * that narrowed slides left just enough to keep the pointer on it (a row grabbed
 * near its right end and carried into the braindump would otherwise trail behind
 * the cursor).
 */
export function ghostTransform(args: {
  shape: GhostShape;
  transform: { x: number; y: number };
  homeRect: { left: number; top: number; width: number; height: number };
  /** Where the pointer grabbed, from the grabbed element's left edge. */
  grabX: number;
}): { x: number; y: number } {
  const { shape, transform, homeRect, grabX } = args;
  if (shape.kind === 'block') {
    return { x: shape.rect.left - homeRect.left, y: shape.rect.top - homeRect.top };
  }
  if (shape.kind === 'row') {
    const keep = Math.min(grabX, Math.max(0, shape.width - 24));
    return { x: transform.x + (grabX - keep), y: transform.y };
  }
  return transform;
}
