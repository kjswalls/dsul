/**
 * Atlas's pan and zoom, as pure math (components/views/atlas/atlas-surface.tsx
 * applies it). The camera maps a world point to the screen as
 * `screen = world * z + (x, y)`: `x`/`y` are the screen position of the world
 * origin, `z` the scale.
 *
 * Every function stays finite on a zero-size viewport or an empty card list
 * (jsdom measures every rect as 0x0), handing back the camera it was given, or
 * z 1, rather than Infinity or NaN.
 */

export interface AtlasCamera {
  x: number;
  y: number;
  z: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Viewport {
  w: number;
  h: number;
}

/** PR1's zoom range. PR3 adds the far zoom below 0.5. */
export const ATLAS_MIN_ZOOM = 0.25;
export const ATLAS_MAX_ZOOM = 2;

/**
 * The lowest zoom the automatic first fit goes to: below it card A's type is
 * unreadable. The toolbar's Fit, an explicit request, keeps the full range.
 */
export const ATLAS_FIT_FLOOR = 0.6;

export const IDENTITY_CAMERA: AtlasCamera = { x: 0, y: 0, z: 1 };

/** Clamp a zoom to the range; a non-finite or non-positive one reads as 1. */
export function clampZoom(z: number): number {
  if (!Number.isFinite(z) || z <= 0) return 1;
  return Math.min(ATLAS_MAX_ZOOM, Math.max(ATLAS_MIN_ZOOM, z));
}

export function worldToScreen(cam: AtlasCamera, p: Point): Point {
  return { x: p.x * cam.z + cam.x, y: p.y * cam.z + cam.y };
}

export function screenToWorld(cam: AtlasCamera, p: Point): Point {
  const z = cam.z || 1;
  return { x: (p.x - cam.x) / z, y: (p.y - cam.y) / z };
}

/**
 * Zoom by `factor` about a screen point, keeping the world point under it
 * fixed (a pinch or Ctrl+wheel at the pointer, as in Figma).
 */
export function zoomAt(cam: AtlasCamera, point: Point, factor: number): AtlasCamera {
  if (!Number.isFinite(factor) || factor <= 0) return cam;
  const z = clampZoom(cam.z * factor);
  if (z === cam.z) return cam;
  const world = screenToWorld(cam, point);
  return { x: point.x - world.x * z, y: point.y - world.y * z, z };
}

/** Pan by a screen delta. */
export function panBy(cam: AtlasCamera, dx: number, dy: number): AtlasCamera {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return cam;
  return { x: cam.x + dx, y: cam.y + dy, z: cam.z };
}

/** The world rect that holds every rect, or null for none. */
export function boundsOf(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The camera that shows every rect, centred, with `pad` screen pixels around.
 * Never zooms past 1 (a single card is not blown up to fill the screen).
 * Returns `fallback` for a zero-size viewport or no rects.
 *
 * With a `floor`, never zooms out past it either; when the floor binds, the
 * bounds' top-left corner sits at (pad, pad) instead of the centre.
 */
export function fitBounds(
  rects: readonly Rect[],
  viewport: Viewport,
  pad = 48,
  fallback: AtlasCamera = IDENTITY_CAMERA,
  floor?: number,
): AtlasCamera {
  const b = boundsOf(rects);
  if (!b || viewport.w <= 0 || viewport.h <= 0) return fallback;
  const availW = Math.max(1, viewport.w - pad * 2);
  const availH = Math.max(1, viewport.h - pad * 2);
  const fit = Math.min(availW / Math.max(1, b.w), availH / Math.max(1, b.h), 1);
  const z = clampZoom(fit);
  if (floor !== undefined && z < floor) {
    const f = clampZoom(floor);
    return { x: pad - b.x * f, y: pad - b.y * f, z: f };
  }
  return {
    x: viewport.w / 2 - (b.x + b.w / 2) * z,
    y: viewport.h / 2 - (b.y + b.h / 2) * z,
    z,
  };
}

/** The camera that puts a world rect's centre in the middle of the viewport. */
export function centerOn(cam: AtlasCamera, rect: Rect, viewport: Viewport): AtlasCamera {
  if (viewport.w <= 0 || viewport.h <= 0) return cam;
  return {
    x: viewport.w / 2 - (rect.x + rect.w / 2) * cam.z,
    y: viewport.h / 2 - (rect.y + rect.h / 2) * cam.z,
    z: cam.z,
  };
}

/**
 * Pan just enough to bring a world rect fully on screen, keeping `insetRight`
 * screen pixels on the right clear (the docked item rail, 432px). Unchanged
 * when it is already visible. A rect larger than the room is aligned to its
 * top-left.
 */
export function ensureVisible(
  cam: AtlasCamera,
  rect: Rect,
  viewport: Viewport,
  insetRight = 0,
  margin = 16,
): AtlasCamera {
  if (viewport.w <= 0 || viewport.h <= 0) return cam;
  const right = Math.max(0, viewport.w - insetRight);
  const s = worldToScreen(cam, rect);
  const w = rect.w * cam.z;
  const h = rect.h * cam.z;
  let dx = 0;
  let dy = 0;
  if (s.x + w > right - margin) dx = right - margin - (s.x + w);
  if (s.x + dx < margin) dx = margin - s.x;
  if (s.y + h > viewport.h - margin) dy = viewport.h - margin - (s.y + h);
  if (s.y + dy < margin) dy = margin - s.y;
  if (dx === 0 && dy === 0) return cam;
  return { x: cam.x + dx, y: cam.y + dy, z: cam.z };
}
