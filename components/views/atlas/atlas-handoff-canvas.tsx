'use client';

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useAtlasUiStore } from '@/lib/atlas-ui-store';
import { handoffShown, viewRect } from '@/lib/atlas-camera';
import { ATLAS_CARD_H, ATLAS_CARD_W } from '@/lib/atlas-seed';
import { ATLAS_GRID_PITCH, type RelayCell, type RelayGrid } from '@/lib/atlas-relay-grid';
import { toneColor, type AtlasToneKey } from '@/lib/atlas-tones';
import {
  ATLAS_FOLD_Y,
  clamp01,
  easeOutCubic,
  flightPoint,
  foldScale,
  smoothstep,
  sweepAt,
  tileFlight,
} from '@/lib/atlas-motion';
import { tileSprite, type FarCluster, type FarScene } from '@/components/views/atlas/atlas-far-canvas';
import type { AtlasColors } from '@/components/views/atlas/use-atlas-colors';

/**
 * The far zoom handoff's moving part (round 2, part B): every card's tiles in
 * flight between its strip and its cells on the Relay grid, drawn on one
 * canvas OVER the cards, so a tile visibly lifts off the folding card.
 *
 * It is scrubbed, never timed: each frame reads the handoff shown (the zoom's
 * own, or a fly-in's flourish, lib/atlas-camera.ts `handoffShown`) and draws
 * every tile where lib/atlas-motion.ts puts it for that value, so a pinch held
 * still holds the stream still, and a pinch back runs it backwards. It draws
 * only strictly inside the handoff (0 < e < 1); at the ends the cards (at 0)
 * or the constellation canvas (at 1) have every tile, and this one is blank.
 *
 * A tile's start is measured from the card itself (each strip tile's offset
 * in its card, read once per card per scene and cached), then carried through
 * the card's fold, so at e = 0 it sits exactly on the strip tile it replaces
 * (globals.css hides those by visibility through the band). Its end is its
 * cell. It travels on an eased, bowed path, grows from the strip's 7px into a
 * relay tile, and trails a short streak while it moves. Lit tiles go to lit
 * cells and open ones to open cells, so nothing changes state in flight.
 *
 * Only the strip's own tiles (at most ATLAS_TILE_CAP) and a few more from the
 * "+n" chip fly (FLIGHT_EXTRA); a cluster's other cells (up to a hundred on a
 * big container) settle in place on their cells as the handoff ends, one
 * sprite each, so a big board flies tens of tiles a cluster, never hundreds.
 * Tiles that never sat on the strip grow from nothing, so the first frame of
 * the band is never a stack of squares over the chip or a goal's track.
 *
 * The light's pass over each folding card is drawn here too, clipped to the
 * card's folded box (a soft band of ink laid over the card), so a frame
 * restyles nothing on the page.
 *
 * Cheap: one canvas, mounted only while the handoff can be strictly between
 * its ends (atlas-view.tsx), culled per cluster and per tile, paths batched by
 * style, redrawn only when the camera or the flourish moves (never on a
 * clock), no React render per frame. Canvas alpha is drawing, never a
 * parent's opacity (D8). Not mounted under reduced motion (a plain swap at
 * 0.5).
 */

/** A strip tile, in its card's own pixels (centre). */
interface StripTile {
  x: number;
  y: number;
  state: string;
}

interface StripGeom {
  tiles: StripTile[];
  /** The "+n" chip, where tiles past the strip come from. */
  more: { x: number; y: number } | null;
  /** Read from the card on screen (false: estimated before it mounted). */
  measured: boolean;
  /** The card's height (for the light's pass); absent when estimated. */
  h?: number;
}

interface Flight {
  /** Start, in its card's own pixels. */
  off: { x: number; y: number };
  /** End, in world pixels; null for a strip tile with no cell (it shrinks away at the cluster's middle). */
  dst: { x: number; y: number } | null;
  state: string;
  k: number;
  /** Not on the strip (from the chip, or a goal's card): it grows from nothing. */
  extra?: boolean;
}

/** A cell no tile flies to: it settles in place as the handoff ends. */
interface Settle {
  x: number;
  y: number;
  lit: boolean;
}

interface ClusterFlights {
  list: Flight[];
  settle: Settle[];
  measured: boolean;
  h: number;
}

/** Tiles past the strip that fly from its chip, at most, per cluster. */
export const FLIGHT_EXTRA = 8;

/** A strip tile's size, and the relay tile's core it grows into (tileSprite's 22 of 64). */
const STRIP_TILE = 7;
const CORE_TILE = ATLAS_GRID_PITCH * 1.6 * (22 / 64);
/** The sprite is drawn so its core matches the square it replaces. */
const SPRITE_PER_CORE = 64 / 22;
/** The card's strip, for a card not on screen yet: 14px in, 10px a tile, wrapping. */
const STRIP_X = 15 + STRIP_TILE / 2;
const STRIP_PER_ROW = 23;

/** A card's strip read from the DOM, or estimated from the cluster before it mounts. */
export function stripGeometry(root: ParentNode | null, c: FarCluster): StripGeom {
  const el = root?.querySelector<HTMLElement>(`[data-atlas-card="${c.key}"]`) ?? null;
  if (el) {
    const strip = el.querySelector<HTMLElement>('[data-testid="atlas-tiles"]');
    const tiles: StripTile[] = [];
    let more: StripGeom['more'] = null;
    if (strip) {
      for (const t of Array.from(strip.children) as HTMLElement[]) {
        const cx = t.offsetLeft + t.offsetWidth / 2;
        const cy = t.offsetTop + t.offsetHeight / 2;
        if (t.tagName === 'I') tiles.push({ x: cx, y: cy, state: t.dataset.tile ?? 'open' });
        else more = { x: cx, y: cy };
      }
    }
    return { tiles, more, measured: true, h: el.offsetHeight || undefined };
  }
  const n = Math.min(c.tiles, 60);
  const tiles: StripTile[] = [];
  for (let i = 0; i < n; i++) {
    tiles.push({
      x: STRIP_X + (i % STRIP_PER_ROW) * (STRIP_TILE + 3),
      y: ATLAS_FOLD_Y + Math.floor(i / STRIP_PER_ROW) * (STRIP_TILE + 3),
      state: i < c.lit ? 'lit' : 'open',
    });
  }
  return { tiles, more: null, measured: false };
}

/**
 * Pairs each strip tile with a cell: lit with lit and open with open, in
 * order (cells innermost first), then up to `extra` cells past the strip
 * from its "+n" chip (or its last tile), innermost first. The cells left
 * over settle in place (`settle`). `k` orders the stream.
 */
export function planFlights(
  geom: StripGeom,
  cells: readonly RelayCell[],
  extra: number = FLIGHT_EXTRA
): { list: Flight[]; settle: Settle[] } {
  const ranked = [...cells].sort((a, b) => a.rank - b.rank);
  const lit = ranked.filter((c) => c.lit);
  const open = ranked.filter((c) => !c.lit);
  let li = 0;
  let oi = 0;
  const out: Flight[] = [];
  for (const t of geom.tiles) {
    const cell = t.state === 'lit' ? lit[li++] : open[oi++];
    out.push({ off: { x: t.x, y: t.y }, dst: cell ? { x: cell.x, y: cell.y } : null, state: t.state, k: out.length });
  }
  const last = geom.tiles[geom.tiles.length - 1];
  const from = geom.more ?? (last ? { x: last.x, y: last.y } : { x: ATLAS_CARD_W / 2, y: ATLAS_FOLD_Y });
  // The cells past the strip, innermost first; the first `extra` fly.
  const rest = [...lit.slice(li), ...open.slice(oi)].sort((x, y) => x.rank - y.rank);
  const settle: Settle[] = [];
  let budget = Math.max(0, extra);
  for (const c of rest) {
    if (budget > 0) {
      budget--;
      out.push({ off: from, dst: { x: c.x, y: c.y }, state: c.lit ? 'lit' : 'open', k: out.length, extra: true });
    } else settle.push({ x: c.x, y: c.y, lit: c.lit });
  }
  return { list: out, settle };
}

export function AtlasHandoffCanvas({
  scene,
  grid,
  colors,
}: {
  scene: FarScene;
  grid: RelayGrid;
  colors: AtlasColors;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef({ scene, grid, colors });
  const plans = useRef(new Map<string, ClusterFlights>());
  useLayoutEffect(() => {
    live.current = { scene, grid, colors };
    // A new scene (a tick, a move, a filter) or grid: re-read every strip.
    plans.current.clear();
  }, [scene, grid, colors]);

  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const raf = useRef<number | null>(null);

  const draw = useCallback(() => {
    const el = canvasRef.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const { w, h, dpr } = size.current;
    if (w <= 0 || h <= 0) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const { camera: cam, flourish } = useAtlasUiStore.getState();
    const e = handoffShown(cam.z, flourish);
    if (e <= 0 || e >= 1) return;
    const { scene: sc, grid: g, colors: col } = live.current;
    const { sx, sy } = foldScale(e);
    const v = viewRect(cam, { w, h });
    const glow = col.mode === 'glow';
    const root = el.parentElement;
    const reachPad = ATLAS_CARD_W;
    for (const c of sc.clusters) {
      const r = ((g.reach.get(c.key) ?? 0) + 2) * g.pitch + reachPad;
      if (c.x + r < v.x || c.x - r > v.x + v.w || c.y + r < v.y || c.y - r > v.y + v.h) continue;
      let plan = plans.current.get(c.key);
      if (!plan || !plan.measured) {
        const geom = stripGeometry(root, c);
        const cells = (g.byCluster.get(c.key) ?? []).filter((cell) => cell.role === 'tile');
        plan = { ...planFlights(geom, cells), measured: geom.measured, h: geom.h ?? ATLAS_CARD_H };
        plans.current.set(c.key, plan);
      }
      drawCluster(ctx, c, plan, { e, sx, sy, cam, colors: col, glow, w, h });
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }, []);

  const requestDraw = useCallback(() => {
    if (raf.current !== null) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = null;
      draw();
    });
  }, [draw]);

  // Size: DPR at most 2, from the canvas's own box, redrawn in the same task.
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const measure = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = el.clientWidth;
      const h = el.clientHeight;
      const s = size.current;
      if (w === s.w && h === s.h && dpr === s.dpr) return;
      size.current = { w, h, dpr };
      el.width = Math.max(1, Math.round(w * dpr));
      el.height = Math.max(1, Math.round(h * dpr));
      draw();
    };
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [draw]);

  // The camera or the flourish moving redraws (never a React render).
  useEffect(
    () =>
      useAtlasUiStore.subscribe((s, prev) => (s.camera !== prev.camera || s.flourish !== prev.flourish) && requestDraw()),
    [requestDraw]
  );
  useEffect(() => {
    requestDraw();
  }, [scene, grid, colors, requestDraw]);
  useEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
    },
    []
  );

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      data-testid="atlas-handoff-canvas"
      className="pointer-events-none absolute inset-0 size-full"
    />
  );
}

interface FrameCtx {
  e: number;
  sx: number;
  sy: number;
  cam: { x: number; y: number; z: number };
  colors: AtlasColors;
  glow: boolean;
  /** The canvas, in CSS pixels, for culling each tile. */
  w: number;
  h: number;
}

/** Alphas are rounded to this many steps, so tiles of a style share one path. */
const ALPHA_STEPS = 8;
const qa = (a: number) => Math.round(clamp01(a) * ALPHA_STEPS) / ALPHA_STEPS;

/** A batch of rounded squares (or streaks) that share one style. */
interface Batch {
  alpha: number;
  lit: boolean;
  quiet: boolean;
  width: number;
  pts: number[];
}

function batchOf(map: Map<string, Batch>, lit: boolean, quiet: boolean, alpha: number, width = 0): Batch {
  const key = `${lit ? 1 : 0}${quiet ? 1 : 0}|${alpha}|${width}`;
  let b = map.get(key);
  if (!b) {
    b = { alpha, lit, quiet, width, pts: [] };
    map.set(key, b);
  }
  return b;
}

/** One cluster's tiles (and the light over its card) at this frame. */
function drawCluster(ctx: CanvasRenderingContext2D, c: FarCluster, plan: ClusterFlights, f: FrameCtx) {
  const { e, sx, sy, cam, colors, glow } = f;
  const z = cam.z;
  const tone: AtlasToneKey = colors.tones.get(c.color) ?? 'teal';
  const mode = colors.mode;
  // The card's top-left in world pixels (the cluster sits at its collapsed middle).
  const left = c.x - ATLAS_CARD_W / 2;
  const top = c.y - ATLAS_CARD_H / 2;
  const ox = ATLAS_CARD_W / 2;
  const oy = ATLAS_FOLD_Y;
  const list = plan.list;
  const n = list.length;
  const restAlpha = (lit: boolean) => (c.resting ? 0.35 : lit ? 0.85 : 0.6);
  const solid = toneColor(tone, mode, 1);
  const trail = toneColor(tone, mode, 0.55);
  const litSprite = tileSprite(tone, mode, true);
  const openSprite = tileSprite(tone, mode, false);
  // A tile is drawn only if its box (sprite and streak included) meets the canvas.
  const margin = CORE_TILE * SPRITE_PER_CORE * z;
  const onScreen = (x: number, y: number) => x > -margin && y > -margin && x < f.w + margin && y < f.h + margin;

  sweepCard(ctx, f, left, top, plan.h);

  const streaks = new Map<string, Batch>();
  const squares = new Map<string, Batch>();
  const sprites: { x: number; y: number; ss: number; lit: boolean; alpha: number }[] = [];

  for (const fl of list) {
    const q = tileFlight(e, fl.k, n);
    // Where its strip tile is now, carried through the card's fold.
    const a = { x: left + ox + (fl.off.x - ox) * sx, y: top + oy + (fl.off.y - oy) * sy };
    const b = fl.dst ?? { x: c.x, y: c.y };
    const p = flightPoint(a, b, q, fl.k);
    const grow = easeOutCubic(q);
    // A strip tile starts at the strip's size; a tile from the chip from nothing.
    const startSize = fl.extra ? 0 : STRIP_TILE;
    const worldSize = fl.dst ? startSize + (CORE_TILE - startSize) * grow : STRIP_TILE * (1 - grow);
    if (worldSize <= 0.05) continue;
    const s = worldSize * z;
    const x = p.x * z + cam.x;
    const y = p.y * z + cam.y;
    if (!onScreen(x, y)) continue;
    const lit = fl.state === 'lit';
    // The streak behind a tile in flight, strongest mid-flight.
    if (q > 0 && q < 1) {
      const alpha = qa((lit ? 0.55 : 0.3) * Math.sin(Math.PI * q));
      if (alpha > 0) {
        const back = flightPoint(a, b, Math.max(0, q - 0.14), fl.k);
        batchOf(streaks, lit, false, alpha, Math.max(1, Math.round(s * 0.45))).pts.push(
          back.x * z + cam.x,
          back.y * z + cam.y,
          x,
          y
        );
      }
    }
    // The strip's square, giving way to the relay tile as it lands.
    const plain = qa(1 - clamp01(q) ** 2);
    if (plain > 0) batchOf(squares, lit, fl.state === 'quiet', plain).pts.push(x - s / 2, y - s / 2, s);
    if (fl.dst && q > 0) {
      const alpha = qa(restAlpha(lit) * clamp01(q) ** 1.5);
      if (alpha > 0) sprites.push({ x, y, ss: s * SPRITE_PER_CORE, lit, alpha });
    }
  }

  // The cells no tile flies to settle on their cells as the handoff ends,
  // growing in as the last of the stream lands.
  const settleT = smoothstep(0.62, 1, e);
  if (settleT > 0) {
    const ss = CORE_TILE * (0.5 + 0.5 * settleT) * z * SPRITE_PER_CORE;
    for (const cell of plan.settle) {
      const x = cell.x * z + cam.x;
      const y = cell.y * z + cam.y;
      if (!onScreen(x, y)) continue;
      const alpha = qa(restAlpha(cell.lit) * settleT);
      if (alpha > 0) sprites.push({ x, y, ss, lit: cell.lit, alpha });
    }
  }

  ctx.lineCap = 'round';
  ctx.globalCompositeOperation = glow ? 'lighter' : 'source-over';
  for (const b of streaks.values()) {
    ctx.globalAlpha = b.alpha;
    ctx.strokeStyle = b.lit ? trail : colors.sub;
    ctx.lineWidth = b.width;
    ctx.beginPath();
    for (let i = 0; i < b.pts.length; i += 4) {
      ctx.moveTo(b.pts[i], b.pts[i + 1]);
      ctx.lineTo(b.pts[i + 2], b.pts[i + 3]);
    }
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
  for (const b of squares.values()) {
    ctx.globalAlpha = b.alpha;
    ctx.beginPath();
    for (let i = 0; i < b.pts.length; i += 3) squarePath(ctx, b.pts[i], b.pts[i + 1], b.pts[i + 2]);
    if (b.lit) {
      ctx.fillStyle = solid;
      ctx.fill();
    } else {
      ctx.fillStyle = colors.frameFill;
      ctx.fill();
      ctx.strokeStyle = b.quiet ? colors.dot : colors.sub;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  if (sprites.length > 0 && (litSprite || openSprite)) {
    ctx.globalCompositeOperation = glow ? 'lighter' : 'source-over';
    // By alpha, so the state changes once a step, not once a tile.
    sprites.sort((p, q) => p.alpha - q.alpha);
    let alpha = -1;
    for (const sp of sprites) {
      const img = sp.lit ? litSprite : openSprite;
      if (!img) continue;
      if (sp.alpha !== alpha) {
        alpha = sp.alpha;
        ctx.globalAlpha = alpha;
      }
      ctx.drawImage(img, sp.x - sp.ss / 2, sp.y - sp.ss / 2, sp.ss, sp.ss);
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

/* ── The light's pass ─────────────────────────────────────────────────────── */

/** The band of light: the ink colour, soft at both edges, cached per colour. */
const sweepSprites = new Map<string, HTMLCanvasElement | null>();
function sweepSprite(ink: string): HTMLCanvasElement | null {
  if (sweepSprites.has(ink)) return sweepSprites.get(ink)!;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 4;
  const g = c.getContext('2d');
  if (!g) {
    sweepSprites.set(ink, null);
    return null;
  }
  // The ink, solid, then kept only where a soft alpha ramp says (any CSS
  // colour works, since the ramp is black at varying alpha).
  g.fillStyle = ink;
  g.fillRect(0, 0, 64, 4);
  g.globalCompositeOperation = 'destination-in';
  const ramp = g.createLinearGradient(0, 0, 64, 0);
  ramp.addColorStop(0, 'rgba(0,0,0,0)');
  ramp.addColorStop(0.5, 'rgba(0,0,0,1)');
  ramp.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = ramp;
  g.fillRect(0, 0, 64, 4);
  sweepSprites.set(ink, c);
  return c;
}

/** How strong the light is (the ink at 11%, as the card's own wash would be). */
const SWEEP_ALPHA = 0.11;
/** The band's width, as a share of the card's. */
const SWEEP_W = 0.6;
/** The band leans this much (x per y), so it reads as light, not a wipe. */
const SWEEP_LEAN = 0.18;
const CARD_RADIUS = 16;

/**
 * A soft band of ink passing left to right over a folding card, clipped to
 * the card's folded box: from a quarter of a card off its left edge to a
 * quarter off its right, over the first part of the handoff (sweepAt).
 */
function sweepCard(ctx: CanvasRenderingContext2D, f: FrameCtx, left: number, top: number, cardH: number) {
  const s = sweepAt(f.e);
  if (s <= 0 || s >= 1) return;
  const img = sweepSprite(f.colors.fg);
  if (!img) return;
  const { sx, sy, cam } = f;
  const z = cam.z;
  // The card's folded box, on screen (its fold closes onto the strip's line).
  const w = ATLAS_CARD_W * sx * z;
  const h = Math.max(1, cardH * sy * z);
  const x = (left + (ATLAS_CARD_W / 2) * (1 - sx)) * z + cam.x;
  const y = (top + ATLAS_FOLD_Y * (1 - sy)) * z + cam.y;
  if (x + w < 0 || y + h < 0 || x > f.w || y > f.h) return;
  const bw = w * SWEEP_W;
  const cx = x + w * (-0.25 + 1.5 * s);
  ctx.save();
  squarePathRect(ctx, x, y, w, h, CARD_RADIUS * Math.min(sx, sy) * z);
  ctx.clip();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = SWEEP_ALPHA;
  // Leaning: a shear about the box's middle line.
  ctx.transform(1, 0, -SWEEP_LEAN, 1, SWEEP_LEAN * (y + h / 2), 0);
  ctx.drawImage(img, cx - bw / 2, y, bw, h);
  ctx.restore();
}

/** A strip square, added to the current path (the caller begins and fills it). */
function squarePath(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  const r = Math.max(1, s * 0.28);
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, s, s, Math.min(r, s / 2));
  else ctx.rect(x, y, s, s);
}

/** A rounded box as a fresh path. */
function squarePathRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
  else ctx.rect(x, y, w, h);
}
