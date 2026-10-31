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
 * Cheap: one canvas, culled to the viewport, redrawn only when the camera or
 * the flourish moves (never on a clock), no React render per frame. Canvas
 * alpha is drawing, never a parent's opacity (D8). Not mounted under reduced
 * motion (a plain swap at 0.5).
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
}

interface Flight {
  /** Start, in its card's own pixels. */
  off: { x: number; y: number };
  /** End, in world pixels; null for a strip tile with no cell (it shrinks away at the cluster's middle). */
  dst: { x: number; y: number } | null;
  state: string;
  k: number;
}

interface ClusterFlights {
  list: Flight[];
  measured: boolean;
}

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
    return { tiles, more, measured: true };
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
 * order (cells innermost first), then the cells past the strip from its "+n"
 * chip (or its last tile). `k` orders the stream.
 */
export function planFlights(geom: StripGeom, cells: readonly RelayCell[]): Flight[] {
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
  for (; li < lit.length; li++) out.push({ off: from, dst: { x: lit[li].x, y: lit[li].y }, state: 'lit', k: out.length });
  for (; oi < open.length; oi++) out.push({ off: from, dst: { x: open[oi].x, y: open[oi].y }, state: 'open', k: out.length });
  return out;
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
        plan = { list: planFlights(geom, cells), measured: geom.measured };
        plans.current.set(c.key, plan);
      }
      drawCluster(ctx, c, plan.list, { e, sx, sy, cam, colors: col, glow });
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
}

/** One cluster's tiles at this frame. */
function drawCluster(ctx: CanvasRenderingContext2D, c: FarCluster, list: readonly Flight[], f: FrameCtx) {
  const { e, sx, sy, cam, colors, glow } = f;
  const z = cam.z;
  const tone: AtlasToneKey = colors.tones.get(c.color) ?? 'teal';
  const mode = colors.mode;
  // The card's top-left in world pixels (the cluster sits at its collapsed middle).
  const left = c.x - ATLAS_CARD_W / 2;
  const top = c.y - ATLAS_CARD_H / 2;
  const ox = ATLAS_CARD_W / 2;
  const oy = ATLAS_FOLD_Y;
  const n = list.length;
  const restAlpha = (lit: boolean) => (c.resting ? 0.35 : lit ? 0.85 : 0.6);
  const solid = toneColor(tone, mode, 1);
  const trail = toneColor(tone, mode, 0.55);
  for (const fl of list) {
    const q = tileFlight(e, fl.k, n);
    // Where its strip tile is now, carried through the card's fold.
    const a = { x: left + ox + (fl.off.x - ox) * sx, y: top + oy + (fl.off.y - oy) * sy };
    const b = fl.dst ?? { x: c.x, y: c.y };
    const p = flightPoint(a, b, q, fl.k);
    const grow = easeOutCubic(q);
    const worldSize = fl.dst ? STRIP_TILE + (CORE_TILE - STRIP_TILE) * grow : STRIP_TILE * (1 - grow);
    if (worldSize <= 0.05) continue;
    const s = worldSize * z;
    const x = p.x * z + cam.x;
    const y = p.y * z + cam.y;
    const lit = fl.state === 'lit';
    // The streak behind a tile in flight, strongest mid-flight.
    if (q > 0 && q < 1) {
      const back = flightPoint(a, b, Math.max(0, q - 0.14), fl.k);
      ctx.globalCompositeOperation = glow ? 'lighter' : 'source-over';
      ctx.globalAlpha = (lit ? 0.55 : 0.3) * Math.sin(Math.PI * q);
      ctx.strokeStyle = lit ? trail : colors.sub;
      ctx.lineWidth = Math.max(1, s * 0.45);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(back.x * z + cam.x, back.y * z + cam.y);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    // The strip's square, giving way to the relay tile as it lands.
    const plain = 1 - clamp01(q) ** 2;
    if (plain > 0.01) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = plain;
      squarePath(ctx, x - s / 2, y - s / 2, s, Math.max(1, s * 0.28));
      if (lit) {
        ctx.fillStyle = solid;
        ctx.fill();
      } else {
        ctx.fillStyle = colors.frameFill;
        ctx.fill();
        ctx.strokeStyle = fl.state === 'quiet' ? colors.dot : colors.sub;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    if (fl.dst && q > 0) {
      const sprite = tileSprite(tone, mode, lit);
      if (sprite) {
        ctx.globalCompositeOperation = glow ? 'lighter' : 'source-over';
        ctx.globalAlpha = restAlpha(lit) * clamp01(q) ** 1.5;
        const ss = s * SPRITE_PER_CORE;
        ctx.drawImage(sprite, x - ss / 2, y - ss / 2, ss, ss);
      }
    }
  }
}

function squarePath(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, r: number) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, s, s, Math.min(r, s / 2));
  else ctx.rect(x, y, s, s);
}
