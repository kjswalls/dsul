import type { AtlasLayout } from '@/lib/view-store';
import type { Point, Rect } from '@/lib/atlas-camera';

/**
 * Strands and season frames on Atlas's card layer (round 2): the round-1
 * mock's dashed threads from a goal to each card that feeds it, and the
 * dashed frame around a season and its routines with its dates on a tab.
 *
 * The links themselves are never derived here. atlas-view computes them once
 * (laneFor: each card to the goal holding most of its items) and hands the
 * same list to the far canvas's threads and to these strands, so the two
 * zooms can never disagree about what feeds what. This module is geometry
 * and policy only.
 */

/** A strand: a goal card's key and the key of a card feeding it. */
export interface AtlasStrandLink {
  from: string;
  to: string;
}

/** A season frame: the season card's key, what it frames, and its tab. */
export interface AtlasFrameSpec {
  key: string;
  color: string;
  kind: string;
  name: string;
  dates: string | null;
  members: readonly string[];
}

/**
 * At most this many strands at rest. Over it the board keeps drawing, but
 * only the nearest few per goal (strandsToDraw), so there is never a count
 * where every strand vanishes at once; the hovered or focused card's own are
 * always drawn on top of that. A hundred dashed curves crossing a hundred
 * cards read as noise, not as links; forty short ones and one card's handful
 * always read.
 */
export const ATLAS_STRAND_REST_CAP = 40;

/**
 * A season frame larger than this many times its members' own area is not
 * drawn: a routine dragged across the board would otherwise stretch the
 * frame under every card in between, claiming cards the season does not hold.
 * Members sitting together (a row, a pair stacked, an L) stay well under it.
 */
export const ATLAS_FRAME_MAX_SPREAD = 4;

/** How far a season frame stands off its members, and the room its tab takes on top. */
export const ATLAS_FRAME_PAD = 26;
export const ATLAS_FRAME_TAB = 34;

/**
 * Which layouts draw what:
 * - Your map: strands and season frames. Nothing else there says what feeds
 *   a goal or what a season holds.
 * - Momentum and Timeline: strands only. A season's routines sit in whichever
 *   column or day they belong to, so a frame round them would span the board.
 * - By goal: neither. Its lanes already are the goal link, and a strand from a
 *   lane's head to every card under it would only repeat the lane.
 */
export function strandPolicy(layout: AtlasLayout): { strands: boolean; frames: boolean } {
  switch (layout) {
    case 'map':
      return { strands: true, frames: true };
    case 'momentum':
    case 'timeline':
      return { strands: true, frames: false };
    case 'goal':
      return { strands: false, frames: false };
  }
}

/**
 * The strands to draw now, in `links` order (a strand keeps its place, so a
 * hot one only changes colour and its fade plays). Up to the cap: all of
 * them. Over it: each goal's nearest feeders first, taken round robin across
 * goals (every goal's closest, then every goal's second closest, ...) until
 * the cap, so each goal keeps at least one strand while goals number under
 * the cap; plus every strand with a hot end. `positions` are where the cards
 * rest; a card without one ranks last.
 */
export function strandsToDraw(
  links: readonly AtlasStrandLink[],
  hot: ReadonlySet<string>,
  positions?: ReadonlyMap<string, Point>
): AtlasStrandLink[] {
  if (links.length <= ATLAS_STRAND_REST_CAP) return [...links];
  const byGoal = new Map<string, { i: number; d: number }[]>();
  links.forEach((l, i) => {
    const a = positions?.get(l.from);
    const b = positions?.get(l.to);
    const d = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : Infinity;
    const list = byGoal.get(l.from) ?? [];
    list.push({ i, d });
    byGoal.set(l.from, list);
  });
  for (const list of byGoal.values()) list.sort((x, y) => x.d - y.d || x.i - y.i);
  const keep = new Set<number>();
  for (let rank = 0; keep.size < ATLAS_STRAND_REST_CAP; rank++) {
    let any = false;
    for (const list of byGoal.values()) {
      if (rank >= list.length) continue;
      any = true;
      keep.add(list[rank].i);
      if (keep.size >= ATLAS_STRAND_REST_CAP) break;
    }
    if (!any) break;
  }
  return links.filter((l, i) => keep.has(i) || hot.has(l.from) || hot.has(l.to));
}

export function isHotStrand(link: AtlasStrandLink, hot: ReadonlySet<string>): boolean {
  return hot.has(link.from) || hot.has(link.to);
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The curve from a goal card `a` to a feeding card `b`, both in world pixels.
 * Beside each other, it leaves the goal's facing side near its top and meets
 * the other card's facing side by its title, as the mock draws it. Stacked
 * (overlapping in x), it runs bottom to top instead, so it never doubles back
 * through either card.
 */
export function strandPath(a: Rect, b: Rect): string {
  const gap = 20;
  const ay = a.y + Math.min(a.h / 2, 60);
  const by = b.y + Math.min(b.h / 2, 28);
  if (b.x >= a.x + a.w + gap) {
    const x1 = a.x + a.w;
    const x2 = b.x;
    const dx = Math.max(60, (x2 - x1) / 2);
    return `M${r1(x1)} ${r1(ay)} C ${r1(x1 + dx)} ${r1(ay)}, ${r1(x2 - dx)} ${r1(by)}, ${r1(x2)} ${r1(by)}`;
  }
  if (b.x + b.w + gap <= a.x) {
    const x1 = a.x;
    const x2 = b.x + b.w;
    const dx = Math.max(60, (x1 - x2) / 2);
    return `M${r1(x1)} ${r1(ay)} C ${r1(x1 - dx)} ${r1(ay)}, ${r1(x2 + dx)} ${r1(by)}, ${r1(x2)} ${r1(by)}`;
  }
  const ax = a.x + a.w / 2;
  const bx = b.x + b.w / 2;
  const down = b.y >= a.y;
  const y1 = down ? a.y + a.h : a.y;
  const y2 = down ? b.y : b.y + b.h;
  const dy = Math.max(60, Math.abs(y2 - y1) / 2) * (down ? 1 : -1);
  return `M${r1(ax)} ${r1(y1)} C ${r1(ax)} ${r1(y1 + dy)}, ${r1(bx)} ${r1(y2 - dy)}, ${r1(bx)} ${r1(y2)}`;
}

/**
 * A season frame's box round its members' rects, or null with none drawn, or
 * when the members are spread too far apart to frame honestly
 * (ATLAS_FRAME_MAX_SPREAD).
 */
export function frameBox(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let own = 0;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
    own += r.w * r.h;
  }
  if (own > 0 && (x1 - x0) * (y1 - y0) > own * ATLAS_FRAME_MAX_SPREAD) return null;
  return {
    x: x0 - ATLAS_FRAME_PAD,
    y: y0 - ATLAS_FRAME_TAB,
    w: x1 - x0 + ATLAS_FRAME_PAD * 2,
    h: y1 - y0 + ATLAS_FRAME_TAB + ATLAS_FRAME_PAD,
  };
}

/**
 * Where a card is drawn right now, from its computed transform: the matrix a
 * browser reports mid-glide, or the `translate(...)` jsdom echoes back. The
 * handoff's scale is never in play (strands are off in the band).
 */
export function parseTranslate(transform: string | null | undefined): Point | null {
  if (!transform || transform === 'none') return null;
  const m = transform.match(/^matrix\(([^)]+)\)/);
  if (m) {
    const v = m[1].split(',').map((s) => parseFloat(s));
    if (v.length === 6 && Number.isFinite(v[4]) && Number.isFinite(v[5])) return { x: v[4], y: v[5] };
    return null;
  }
  const m3 = transform.match(/^matrix3d\(([^)]+)\)/);
  if (m3) {
    const v = m3[1].split(',').map((s) => parseFloat(s));
    if (v.length === 16 && Number.isFinite(v[12]) && Number.isFinite(v[13])) return { x: v[12], y: v[13] };
    return null;
  }
  const t = transform.match(/translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/);
  if (t) return { x: parseFloat(t[1]), y: parseFloat(t[2]) };
  return null;
}
