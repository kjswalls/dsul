import { boundsOf, centerOnPoint, viewRect, type AtlasCamera, type Point, type Rect, type Viewport } from './atlas-camera';

/**
 * The minimap's maths (design PR3, the cards mock): the far zoom in
 * miniature, with the viewport as a rounded frame. Pure, so the view and the
 * tests share it.
 */

/** The minimap's size in CSS pixels. */
export const ATLAS_MINIMAP_W = 184;
export const ATLAS_MINIMAP_H = 112;

/** World padding around the content, as the mock pads its bounds. */
export const ATLAS_MINIMAP_PAD = 80;

/** How long the minimap stays after the camera last moved. */
export const ATLAS_MINIMAP_IDLE_MS = 1400;

export interface MinimapFrame {
  /** The padded world bounds the minimap shows. */
  bounds: Rect;
  /** World to minimap scale. */
  k: number;
  /** Where the bounds start inside the minimap (centred). */
  ox: number;
  oy: number;
}

/** Fit the content's bounds (padded) into the minimap, centred. Null for none. */
export function minimapFrame(
  content: readonly Rect[],
  size: Viewport = { w: ATLAS_MINIMAP_W, h: ATLAS_MINIMAP_H },
  pad = ATLAS_MINIMAP_PAD
): MinimapFrame | null {
  const b0 = boundsOf(content);
  if (!b0 || size.w <= 0 || size.h <= 0) return null;
  const bounds = { x: b0.x - pad, y: b0.y - pad, w: b0.w + pad * 2, h: b0.h + pad * 2 };
  const k = Math.min(size.w / Math.max(1, bounds.w), size.h / Math.max(1, bounds.h));
  return { bounds, k, ox: (size.w - bounds.w * k) / 2, oy: (size.h - bounds.h * k) / 2 };
}

export function worldToMini(f: MinimapFrame, p: Point): Point {
  return { x: f.ox + (p.x - f.bounds.x) * f.k, y: f.oy + (p.y - f.bounds.y) * f.k };
}

export function miniToWorld(f: MinimapFrame, p: Point): Point {
  return { x: (p.x - f.ox) / f.k + f.bounds.x, y: (p.y - f.oy) / f.k + f.bounds.y };
}

/** The viewport's frame inside the minimap. */
export function viewportInMini(f: MinimapFrame, cam: AtlasCamera, viewport: Viewport): Rect {
  const v = viewRect(cam, viewport);
  const a = worldToMini(f, { x: v.x, y: v.y });
  return { x: a.x, y: a.y, w: v.w * f.k, h: v.h * f.k };
}

/** The camera a click or drag at a minimap point flies to: that point mid-viewport, zoom kept. */
export function cameraForMiniPoint(f: MinimapFrame, cam: AtlasCamera, p: Point, viewport: Viewport): AtlasCamera {
  return centerOnPoint(cam, miniToWorld(f, p), viewport);
}

/**
 * Whether the board is bigger than the screen: some of the content lies
 * outside the viewport at this camera (it is larger, or panned off). With
 * everything in view there is nothing to find, so no minimap.
 */
export function minimapNeeded(content: readonly Rect[], cam: AtlasCamera, viewport: Viewport): boolean {
  const b = boundsOf(content);
  if (!b || viewport.w <= 0 || viewport.h <= 0) return false;
  const v = viewRect(cam, viewport);
  const eps = 0.5 / (cam.z || 1);
  return b.x < v.x - eps || b.y < v.y - eps || b.x + b.w > v.x + v.w + eps || b.y + b.h > v.y + v.h + eps;
}
