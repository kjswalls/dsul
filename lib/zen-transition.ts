/**
 * Relay Lift's pure half — the timing and geometry of the move between the
 * planner and the Zen room, separated from components/zen/zen-stage.tsx so the
 * numbers can be read and tested without a canvas.
 *
 * ONE wave per switch. A ring of RelayField tiles runs out from a focal point
 * to the farthest corner, and the incoming surface is revealed behind it: the
 * reveal circle trails the ring's leading edge by half a band, so the seam
 * between the two surfaces always sits under lit tiles and is never seen. An
 * earlier sketch covered the whole screen with one wave and uncovered it with a
 * second; it read as two events and took twice as long.
 */

/** The whole move, wave and flight together. */
export const ZEN_WAVE_MS = 1000;

/** Width of the lit ring, as a fraction of the distance it travels. */
export const ZEN_BAND_FRAC = 0.22;

/** The share of the timeline the item spends lifting before it travels. */
export const ZEN_LIFT_SHARE = 0.16;

export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** Distance from a point to the farthest corner of a w×h box. */
export function farthestCorner(fx: number, fy: number, w: number, h: number): number {
  return Math.max(
    Math.hypot(fx, fy),
    Math.hypot(w - fx, fy),
    Math.hypot(fx, h - fy),
    Math.hypot(w - fx, h - fy)
  );
}

/**
 * Where the ring's leading edge is at progress `t` (0–1), in px from the focal.
 *
 * It travels `reach + band`, not `reach`, so the TRAILING edge — and with it
 * the reveal — clears the farthest corner exactly as the timeline ends. Stop at
 * `reach` and the last corner would still be under tiles on the final frame.
 */
export function waveFront(t: number, reach: number, band: number): number {
  return easeInOutCubic(clamp01(t)) * (reach + band);
}

/** Radius of the incoming surface's reveal circle for a given front. */
export function revealRadius(front: number, band: number): number {
  return Math.max(0, front - band * 0.5);
}

/**
 * How far through the ring a tile at distance `d` is: 0 as the leading edge
 * reaches it, 1 as the trailing edge leaves. Null when the ring is not over it.
 */
export function tilePhase(front: number, d: number, band: number): number | null {
  const u = (front - d) / band;
  return u <= 0 || u >= 1 ? null : u;
}

/**
 * The item's flight: a short lift in place, then an eased travel to its
 * destination. `lift` peaks mid-lift and settles to a held 1 for the travel,
 * so the item stays raised until it lands.
 */
export function flightAt(t: number): { lift: number; travel: number } {
  const c = clamp01(t);
  if (c < ZEN_LIFT_SHARE) return { lift: easeOutCubic(c / ZEN_LIFT_SHARE), travel: 0 };
  const travel = easeInOutCubic((c - ZEN_LIFT_SHARE) / (1 - ZEN_LIFT_SHARE));
  // Settles back down over the last fifth, so it lands rather than drops.
  const lift = travel > 0.8 ? 1 - (travel - 0.8) / 0.2 : 1;
  return { lift, travel };
}

/**
 * Both motion vetoes, the same two every motion surface honours: the OS
 * preference and dsul's own animations toggle (data-reduce-motion, stamped by
 * supabase-provider).
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return true;
  return (
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true ||
    document.documentElement.hasAttribute('data-reduce-motion')
  );
}
