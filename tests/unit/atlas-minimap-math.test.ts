import { describe, expect, it } from 'vitest';
import {
  ATLAS_FAR_ZOOM,
  ATLAS_HANDOFF_ZOOM,
  centerOnPoint,
  flyCamera,
  handoffCardScale,
  handoffProgress,
  screenToWorld,
  viewRect,
} from '@/lib/atlas-camera';
import {
  ATLAS_MINIMAP_H,
  ATLAS_MINIMAP_PAD,
  ATLAS_MINIMAP_W,
  cameraForMiniPoint,
  miniToWorld,
  minimapFrame,
  minimapNeeded,
  viewportInMini,
  worldToMini,
} from '@/lib/atlas-minimap';

/** The minimap's viewport maths and the far zoom's camera helpers (design PR3). */

const content = [
  { x: 0, y: 0, w: 260, h: 190 },
  { x: 2000, y: 900, w: 260, h: 190 },
];
const viewport = { w: 1200, h: 800 };

describe('atlas minimap maths', () => {
  it('fits the padded content into 184 by 112, centred', () => {
    const f = minimapFrame(content)!;
    expect(f.bounds).toEqual({ x: -ATLAS_MINIMAP_PAD, y: -ATLAS_MINIMAP_PAD, w: 2260 + 160, h: 1090 + 160 });
    const tl = worldToMini(f, { x: f.bounds.x, y: f.bounds.y });
    const br = worldToMini(f, { x: f.bounds.x + f.bounds.w, y: f.bounds.y + f.bounds.h });
    expect(tl.x).toBeGreaterThanOrEqual(-1e-9);
    expect(tl.y).toBeGreaterThanOrEqual(-1e-9);
    expect(br.x).toBeLessThanOrEqual(ATLAS_MINIMAP_W + 1e-9);
    expect(br.y).toBeLessThanOrEqual(ATLAS_MINIMAP_H + 1e-9);
    // One axis fills, the other is centred.
    expect(Math.min(tl.x, tl.y)).toBeCloseTo(0);
    expect(tl.x + (ATLAS_MINIMAP_W - br.x)).toBeCloseTo(2 * tl.x);
    expect(minimapFrame([])).toBeNull();
  });

  it('round-trips world and minimap points', () => {
    const f = minimapFrame(content)!;
    const p = { x: 812, y: 333 };
    const back = miniToWorld(f, worldToMini(f, p));
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
  });

  it('draws the viewport frame where the camera looks', () => {
    const f = minimapFrame(content)!;
    const cam = { x: -500, y: -100, z: 0.5 };
    const v = viewRect(cam, viewport);
    expect(v).toEqual({ x: 1000, y: 200, w: 2400, h: 1600 });
    const frame = viewportInMini(f, cam, viewport);
    const tl = worldToMini(f, { x: 1000, y: 200 });
    expect(frame.x).toBeCloseTo(tl.x);
    expect(frame.y).toBeCloseTo(tl.y);
    expect(frame.w).toBeCloseTo(2400 * f.k);
    expect(frame.h).toBeCloseTo(1600 * f.k);
  });

  it('a click flies the camera so that point is mid-viewport, zoom kept', () => {
    const f = minimapFrame(content)!;
    const cam = { x: 0, y: 0, z: 0.8 };
    const p = { x: 92, y: 56 };
    const next = cameraForMiniPoint(f, cam, p, viewport);
    expect(next.z).toBe(0.8);
    const mid = screenToWorld(next, { x: 600, y: 400 });
    const want = miniToWorld(f, p);
    expect(mid.x).toBeCloseTo(want.x);
    expect(mid.y).toBeCloseTo(want.y);
  });

  it('is needed only when some of the board is off screen', () => {
    // Everything in view at a low zoom: no minimap.
    expect(minimapNeeded(content, { x: 20, y: 20, z: 0.4 }, viewport)).toBe(false);
    // Bigger than the screen at zoom 1.
    expect(minimapNeeded(content, { x: 0, y: 0, z: 1 }, viewport)).toBe(true);
    // Small but panned off.
    const small = [{ x: 0, y: 0, w: 260, h: 190 }];
    expect(minimapNeeded(small, { x: 100, y: 100, z: 1 }, viewport)).toBe(false);
    expect(minimapNeeded(small, { x: -200, y: 100, z: 1 }, viewport)).toBe(true);
    expect(minimapNeeded([], { x: 0, y: 0, z: 1 }, viewport)).toBe(false);
    expect(minimapNeeded(content, { x: 0, y: 0, z: 1 }, { w: 0, h: 0 })).toBe(false);
  });
});

describe('atlas far zoom camera', () => {
  it('hands off between 0.6 and 0.5', () => {
    expect(ATLAS_HANDOFF_ZOOM).toBe(0.6);
    expect(ATLAS_FAR_ZOOM).toBe(0.5);
    expect(handoffProgress(1)).toBe(0);
    expect(handoffProgress(0.6)).toBe(0);
    expect(handoffProgress(0.55)).toBeCloseTo(0.5);
    expect(handoffProgress(0.5)).toBe(1);
    expect(handoffProgress(0.2)).toBe(1);
    expect(handoffProgress(NaN)).toBe(0);
    expect(handoffCardScale(0.6)).toBe(1);
    expect(handoffCardScale(0.5)).toBeCloseTo(0.4);
  });

  it('centres a world point, at a zoom', () => {
    const cam = centerOnPoint({ x: 0, y: 0, z: 0.3 }, { x: 500, y: 250 }, viewport, 1);
    expect(cam).toEqual({ x: 100, y: 150, z: 1 });
  });

  it('flies in a straight line with a geometric zoom', () => {
    const from = { x: 0, y: 0, z: 0.25 };
    const to = centerOnPoint(from, { x: 3000, y: 1000 }, viewport, 1);
    expect(flyCamera(from, to, viewport, 0)).toBe(from);
    expect(flyCamera(from, to, viewport, 1)).toBe(to);
    const mid = flyCamera(from, to, viewport, 0.5);
    expect(mid.z).toBeCloseTo(0.5);
    const c0 = screenToWorld(from, { x: 600, y: 400 });
    const c = screenToWorld(mid, { x: 600, y: 400 });
    expect(c.x).toBeCloseTo((c0.x + 3000) / 2);
    expect(c.y).toBeCloseTo((c0.y + 1000) / 2);
  });
});
