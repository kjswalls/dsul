import { describe, expect, it } from 'vitest';
import {
  GHOST_ROW_H,
  ghostShapeFor,
  ghostSize,
  ghostTransform,
  gridHourOf,
} from '@/lib/dnd/ghost-shape';
import { DAY_FIELD_LEFT, LANE_PX, PANE_MIN_H, PANE_OFFSET, PANE_TRIM } from '@/lib/schedule-constants';

const row = { width: 640, height: 29 };
const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });

describe('drag ghost shape (Kirby pick B, 2026-10-30)', () => {
  it('reads the hour from Day and Week grid ids, and nothing else', () => {
    expect(gridHourOf('hour:9')).toEqual({ hour: 9, fieldLeft: DAY_FIELD_LEFT });
    expect(gridHourOf('weekhour:2026-10-30:14')).toEqual({ hour: 14, fieldLeft: 0 });
    expect(gridHourOf('week:2026-10-30:anytime')).toBeNull();
    expect(gridHourOf('sidebar')).toBeNull();
    expect(gridHourOf('list:2026-10-30')).toBeNull();
  });

  it('is the twin with nothing under it, or over a list at least its width', () => {
    expect(ghostShapeFor({ overId: null, overRect: null, home: row, fromBlock: false, durationMin: 30 })).toEqual({
      kind: 'home',
    });
    expect(
      ghostShapeFor({ overId: 'list:2026-10-30', overRect: rect(0, 0, 900, 400), home: row, fromBlock: false, durationMin: 30 })
    ).toEqual({ kind: 'home' });
  });

  it('never overhangs a narrower list: a Day row carried into the braindump fits it', () => {
    const shape = ghostShapeFor({ overId: 'sidebar', overRect: rect(0, 0, 280, 800), home: row, fromBlock: false, durationMin: 30 });
    expect(shape).toEqual({ kind: 'row', width: 280 });
    expect(ghostSize(shape, row, false)).toEqual({ width: 280, height: 29 });
  });

  it('turns a block carried to a list into a row', () => {
    const block = { width: 700, height: 71 };
    const shape = ghostShapeFor({ overId: 'list:2026-10-30', overRect: rect(0, 0, 900, 400), home: block, fromBlock: true, durationMin: 60 });
    expect(shape.kind).toBe('row');
    expect(ghostSize(shape, block, true).height).toBe(GHOST_ROW_H);
  });

  it('snaps to the hour on a grid as a block as long as the item, past the Day gutter', () => {
    const slot = rect(300, 500, 900, 75);
    const shape = ghostShapeFor({ overId: 'hour:11', overRect: slot, home: row, fromBlock: false, durationMin: 60 });
    expect(shape).toEqual({
      kind: 'block',
      hour: 11,
      rect: {
        left: 300 + DAY_FIELD_LEFT + LANE_PX,
        top: 500 + PANE_OFFSET,
        width: 900 - 4 - DAY_FIELD_LEFT - LANE_PX,
        height: 75 - PANE_TRIM,
      },
    });
  });

  it('a week column has no gutter, and a short item keeps a readable floor', () => {
    const shape = ghostShapeFor({ overId: 'weekhour:2026-10-30:9', overRect: rect(100, 50, 140, 40), home: row, fromBlock: false, durationMin: 15 });
    expect(shape.kind === 'block' && shape.rect.left).toBe(100 + LANE_PX);
    expect(shape.kind === 'block' && shape.rect.height).toBe(PANE_MIN_H);
  });

  it('places a snapped block by undoing the overlay origin, ignoring the pointer', () => {
    const shape = ghostShapeFor({ overId: 'hour:9', overRect: rect(300, 500, 900, 75), home: row, fromBlock: false, durationMin: 60 });
    const t = ghostTransform({ shape, transform: { x: 37, y: 91 }, homeRect: rect(320, 200, 640, 29), grabX: 100 });
    expect(shape.kind === 'block' && { x: 320 + t.x, y: 200 + t.y }).toEqual({
      x: shape.kind === 'block' ? shape.rect.left : 0,
      y: shape.kind === 'block' ? shape.rect.top : 0,
    });
  });

  it('slides a narrowed row left so the pointer stays on it', () => {
    const t = ghostTransform({ shape: { kind: 'row', width: 280 }, transform: { x: -400, y: 10 }, homeRect: rect(0, 0, 640, 29), grabX: 500 });
    // Grabbed 500px in; the 280px row keeps the pointer 256px in.
    expect(t).toEqual({ x: -400 + (500 - 256), y: 10 });
    // A grab already inside the narrow width moves nothing.
    expect(ghostTransform({ shape: { kind: 'row', width: 280 }, transform: { x: 5, y: 6 }, homeRect: rect(0, 0, 640, 29), grabX: 40 })).toEqual({ x: 5, y: 6 });
  });
});
