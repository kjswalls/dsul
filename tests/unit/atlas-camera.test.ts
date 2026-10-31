import { describe, expect, it } from 'vitest';
import {
  ATLAS_FIT_FLOOR,
  ATLAS_MAX_ZOOM,
  ATLAS_MIN_ZOOM,
  centerOn,
  clampZoom,
  ensureVisible,
  fitBounds,
  panBy,
  screenToWorld,
  worldToScreen,
  zoomAt,
} from '@/lib/atlas-camera';

const finite = (c: { x: number; y: number; z: number }) =>
  [c.x, c.y, c.z].every((n) => Number.isFinite(n));

describe('atlas camera', () => {
  it('round-trips world and screen', () => {
    const cam = { x: 40, y: -20, z: 1.5 };
    const p = { x: 123, y: 456 };
    const back = screenToWorld(cam, worldToScreen(cam, p));
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
  });

  it('zoomAt keeps the world point under the pointer fixed', () => {
    const cam = { x: 30, y: 50, z: 1 };
    const pointer = { x: 400, y: 300 };
    const before = screenToWorld(cam, pointer);
    const next = zoomAt(cam, pointer, 1.6);
    expect(next.z).toBeCloseTo(1.6);
    const after = screenToWorld(next, pointer);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('clamps the zoom to 0.12 to 2 (PR3 extends it down for the far zoom)', () => {
    expect(clampZoom(10)).toBe(ATLAS_MAX_ZOOM);
    expect(clampZoom(0.01)).toBe(ATLAS_MIN_ZOOM);
    expect(clampZoom(NaN)).toBe(1);
    expect(clampZoom(0)).toBe(1);
    expect(zoomAt({ x: 0, y: 0, z: 2 }, { x: 0, y: 0 }, 3).z).toBe(2);
    expect(ATLAS_MIN_ZOOM).toBe(0.12);
    expect(zoomAt({ x: 0, y: 0, z: 0.12 }, { x: 0, y: 0 }, 0.1).z).toBe(0.12);
  });

  it('pans by a screen delta', () => {
    expect(panBy({ x: 1, y: 2, z: 1 }, 10, -5)).toEqual({ x: 11, y: -3, z: 1 });
  });

  it('fitBounds centres the cards and never zooms past 1', () => {
    const cam = fitBounds([{ x: 0, y: 0, w: 260, h: 190 }], { w: 1000, h: 800 });
    expect(cam.z).toBe(1);
    const centre = worldToScreen(cam, { x: 130, y: 95 });
    expect(centre.x).toBeCloseTo(500);
    expect(centre.y).toBeCloseTo(400);
    const wide = fitBounds([{ x: 0, y: 0, w: 4000, h: 190 }], { w: 1000, h: 800 }, 0);
    expect(wide.z).toBeCloseTo(0.25);
  });

  it('fitBounds and clampZoom stay finite on a 0x0 viewport or no rects', () => {
    const current = { x: 5, y: 6, z: 0.8 };
    expect(fitBounds([{ x: 0, y: 0, w: 260, h: 190 }], { w: 0, h: 0 }, 48, current)).toEqual(current);
    expect(fitBounds([], { w: 1000, h: 800 }, 48, current)).toEqual(current);
    expect(finite(fitBounds([{ x: 0, y: 0, w: 0, h: 0 }], { w: 1000, h: 800 }))).toBe(true);
    expect(Number.isFinite(clampZoom(Infinity))).toBe(true);
  });

  it('ensureVisible pans a card out from under the 432px rail, and leaves a visible one alone', () => {
    const cam = { x: 0, y: 0, z: 1 };
    const viewport = { w: 1200, h: 800 };
    const card = { x: 900, y: 100, w: 260, h: 190 };
    // Without the inset it fits; with the rail docked it is under it.
    expect(ensureVisible(cam, card, viewport, 0)).toBe(cam);
    const next = ensureVisible(cam, card, viewport, 432);
    const s = worldToScreen(next, card);
    expect(s.x + card.w).toBeLessThanOrEqual(1200 - 432);
    expect(next.y).toBe(0);
    expect(ensureVisible(cam, card, { w: 0, h: 0 }, 432)).toBe(cam);
  });

  it('centerOn puts a card in the middle', () => {
    const cam = centerOn({ x: 0, y: 0, z: 0.5 }, { x: 1000, y: 1000, w: 260, h: 200 }, { w: 800, h: 600 });
    const c = worldToScreen(cam, { x: 1130, y: 1100 });
    expect(c.x).toBeCloseTo(400);
    expect(c.y).toBeCloseTo(300);
  });

  it('fitBounds with a floor stops there and anchors the top-left corner at the pad', () => {
    const rects = [{ x: 100, y: 50, w: 12000, h: 6000 }];
    const cam = fitBounds(rects, { w: 1100, h: 760 }, 48, undefined, ATLAS_FIT_FLOOR);
    expect(cam.z).toBe(ATLAS_FIT_FLOOR);
    expect(worldToScreen(cam, { x: 100, y: 50 })).toEqual({ x: 48, y: 48 });
    // Without one, the same bounds go all the way down.
    expect(fitBounds(rects, { w: 1100, h: 760 }, 48).z).toBe(ATLAS_MIN_ZOOM);
    // A map that fits above the floor is centred as before.
    const small = [{ x: 0, y: 0, w: 500, h: 300 }];
    expect(fitBounds(small, { w: 1100, h: 760 }, 48, undefined, ATLAS_FIT_FLOOR)).toEqual(fitBounds(small, { w: 1100, h: 760 }, 48));
  });
});
