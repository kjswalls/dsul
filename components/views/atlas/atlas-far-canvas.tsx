'use client';

import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ZoomIn } from 'lucide-react';
import { ContainerContextMenu } from '@/components/planner/container-context-menu';
import { ItemMenuRow } from '@/components/planner/item-context-menu';
import { useAtlasUiStore } from '@/lib/atlas-ui-store';
import { ATLAS_COPY } from '@/lib/atlas-copy';
import { handoffProgress, viewRect, type AtlasCamera } from '@/lib/atlas-camera';
import {
  ATLAS_GRID_PITCH,
  ATLAS_WAVE_PERIOD_MS,
  buildRelayGrid,
  cellNum,
  cellsInView,
  dotStride,
  waveAt,
  type RelayCell,
  type RelayGrid,
} from '@/lib/atlas-relay-grid';
import { paleColor, toneColor, type AtlasToneKey, type AtlasToneMode } from '@/lib/atlas-tones';
import type { AtlasKind } from '@/lib/atlas-model';
import type { AtlasColors } from '@/components/views/atlas/use-atlas-colors';

/**
 * Atlas's far zoom (design PR3, Kirby's "Relay grid"), ported from
 * project-canvas/constellation.html's `drawMix`: the board's dot grid at 26px,
 * each container's nearest cells turned into relay tiles (one per item, lit =
 * done), the next 1.5 cells of dots catching its colour and fading out, and a
 * gentle wave from the tiles out through the dots for anything touched this
 * week. On paper (Bloom) each cluster sits in a multiply wash and lit tiles
 * cast a pale pool; in the dark (and under Dusk) tiles glow additively.
 *
 * Canvas 2D at DPR 2 at most. It draws only on a change (camera, data,
 * colours, size) or while the wave runs, at most 30 frames a second. The wave
 * runs only when something was touched this week, the canvas is on screen and
 * the tab is visible, and never under reduced motion (one still frame). While
 * it runs, everything that is not waving is painted once into a cached layer.
 *
 * In the handoff band (zoom 0.6 to 0.5) the canvas draws its content at a
 * per-frame alpha (canvas pixels, never a parent's opacity, D8) while the
 * cards shrink toward their clusters above it. The dot grid is drawn at full
 * strength throughout, since it takes over from the board's CSS dots.
 *
 * Each cluster also has a real element on top (below 0.5 only): a button that
 * flies in on a click or Enter, shows the tooltip on hover or focus, and is
 * wrapped in ContainerContextMenu, so the right-click is the container's menu
 * from the shared wrappers (never bare Radix).
 */

export interface FarCluster {
  key: string;
  kind: AtlasKind;
  id: string;
  name: string;
  kindLabel: string;
  color: string;
  /** World centre. */
  x: number;
  y: number;
  tiles: number;
  lit: number;
  resting: boolean;
  /** The wave's strength, 0 (still) to 1 (lib/atlas-relay-grid liveness). */
  live: number;
  allDone: boolean;
  nextTitle: string | null;
  restingSince?: string;
}

export interface FarSeason {
  key: string;
  label: string;
  /** Cluster keys it outlines (itself and its routines). */
  members: readonly string[];
}

export interface FarScene {
  clusters: readonly FarCluster[];
  /** [goal cluster, feeding cluster]. */
  threads: readonly (readonly [string, string])[];
  seasons: readonly FarSeason[];
}

/** The most often the wave repaints. */
const WAVE_FRAME_MS = 1000 / 30;
/**
 * Slack on that throttle: 33.3ms is exactly two 60Hz frames, and vsync
 * jitter would otherwise push every few draws to a third frame.
 */
const WAVE_FRAME_SLACK_MS = 4;

/* ── Sprites: one per tone, mode and lit state, as relay-field draws a tile ── */

const sprites = new Map<string, HTMLCanvasElement | null>();

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** The mock's `sprite()`: a halo, a dim outer square, and a bright core (lit) or an outline (open). */
export function tileSprite(k: AtlasToneKey, mode: AtlasToneMode, lit: boolean): HTMLCanvasElement | null {
  const key = `${k}|${mode}|${lit ? 1 : 0}`;
  if (sprites.has(key)) return sprites.get(key)!;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  if (!g) {
    sprites.set(key, null);
    return null;
  }
  if (mode === 'glow') {
    const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    rg.addColorStop(0, toneColor(k, mode, lit ? 0.55 : 0.18));
    rg.addColorStop(0.55, toneColor(k, mode, lit ? 0.16 : 0.05));
    rg.addColorStop(1, toneColor(k, mode, 0));
    g.fillStyle = rg;
    g.fillRect(0, 0, 64, 64);
  } else if (lit) {
    // Bloom: a coloured pool under a lit tile, in place of glow.
    const rg = g.createRadialGradient(32, 36, 0, 32, 36, 30);
    rg.addColorStop(0, paleColor(k, 0.95));
    rg.addColorStop(0.5, paleColor(k, 0.35));
    rg.addColorStop(1, paleColor(k, 0));
    g.fillStyle = rg;
    g.fillRect(0, 0, 64, 64);
  }
  roundRect(g, 16, 16, 32, 32, 7);
  g.fillStyle = mode === 'glow' ? toneColor(k, mode, lit ? 0.2 : 0.12) : paleColor(k, lit ? 0.55 : 0.4);
  g.fill();
  roundRect(g, 21, 21, 22, 22, 6);
  if (lit) {
    g.fillStyle = toneColor(k, mode, 1);
    g.fill();
  } else {
    g.strokeStyle = toneColor(k, mode, 0.55);
    g.lineWidth = 1.5;
    g.stroke();
  }
  sprites.set(key, c);
  return c;
}

/** Aura alphas are quantised to this many steps, so each style string is built and parsed once. */
const ALPHA_STEPS = 32;
const auraStyles = new Map<string, string>();
/** A tone at a quantised alpha, cached: an aura dot costs no string and no colour parse. */
function auraStyle(k: AtlasToneKey, mode: AtlasToneMode, step: number): string {
  const key = `${k}|${mode}|${step}`;
  let st = auraStyles.get(key);
  if (!st) {
    st = toneColor(k, mode, step / ALPHA_STEPS);
    auraStyles.set(key, st);
  }
  return st;
}

/** Scratch, reused across frames: aura dots by style (x, y, r triples), and the live cells. */
const auraBuckets = new Map<string, number[]>();
const liveScratch: RelayCell[] = [];

interface Paint {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  cam: AtlasCamera;
  grid: RelayGrid;
  byKey: ReadonlyMap<string, FarCluster>;
  scene: FarScene;
  colors: AtlasColors;
  /** The handoff alpha for everything but the dot grid. */
  alpha: number;
  /** The wave's phase, 0 to 1; null for a still frame. */
  phase: number | null;
}

const toneOf = (p: Paint, c: FarCluster): AtlasToneKey => p.colors.tones.get(c.color) ?? 'teal';

function screen(p: Paint, x: number, y: number): [number, number] {
  return [x * p.cam.z + p.cam.x, y * p.cam.z + p.cam.y];
}

/** The dot grid: every free cell, thinned so dots stay at least 7px apart. */
function paintDots(p: Paint) {
  const { ctx, cam, grid } = p;
  const P = grid.pitch;
  const v = viewRect(cam, { w: p.w, h: p.h });
  const s = dotStride(cam.z, P);
  const i0 = Math.floor(v.x / P / s) * s - s;
  const j0 = Math.floor(v.y / P / s) * s - s;
  const i1 = Math.ceil((v.x + v.w) / P) + 1;
  const j1 = Math.ceil((v.y + v.h) / P) + 1;
  const dr = Math.max(0.8, Math.min(1.4, cam.z * 1.6));
  const r = 1.1 * dr;
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = p.colors.dot;
  ctx.beginPath();
  for (let j = j0; j <= j1; j += s) {
    for (let i = i0; i <= i1; i += s) {
      if (grid.occupied.has(cellNum(i, j))) continue;
      const x = (i + 0.5) * P * cam.z + cam.x;
      const y = (j + 0.5) * P * cam.z + cam.y;
      ctx.rect(x - r, y - r, r * 2, r * 2);
    }
  }
  ctx.fill();
}

/** Bloom's watercolour wash under each cluster that is not resting. */
function paintPools(p: Paint) {
  const { ctx, cam } = p;
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = p.alpha;
  for (const c of p.scene.clusters) {
    if (c.resting) continue;
    const [x, y] = screen(p, c.x, c.y);
    const R = (120 + Math.max(0, c.tiles - c.lit) * 22) * cam.z;
    if (x + R < 0 || y + R < 0 || x - R > p.w || y - R > p.h) continue;
    const k = toneOf(p, c);
    const g = ctx.createRadialGradient(x, y, 0, x, y, R);
    g.addColorStop(0, paleColor(k, 0.32 * (0.4 + c.live * 0.6)));
    g.addColorStop(1, paleColor(k, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - R, y - R, R * 2, R * 2);
  }
  ctx.restore();
}

/** A season's dashed outline around what it holds, and the goal threads. */
function paintLinks(p: Paint) {
  const { ctx, cam, grid } = p;
  ctx.save();
  ctx.globalAlpha = p.alpha;
  ctx.strokeStyle = p.colors.dot;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 5]);
  for (const [from, to] of p.scene.threads) {
    const a = p.byKey.get(from);
    const b = p.byKey.get(to);
    if (!a || !b) continue;
    const [x0, y0] = screen(p, a.x, a.y);
    const [x1, y1] = screen(p, b.x, b.y);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.bezierCurveTo((x0 + x1) / 2, y0, (x0 + x1) / 2, y1, x1, y1);
    ctx.stroke();
  }
  ctx.setLineDash([3, 6]);
  for (const s of p.scene.seasons) {
    const ms = s.members.map((k) => p.byKey.get(k)).filter((c): c is FarCluster => !!c);
    if (ms.length === 0) continue;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let reach = 0;
    for (const c of ms) {
      const [x, y] = screen(p, c.x, c.y);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
      reach = Math.max(reach, grid.reach.get(c.key) ?? 0);
    }
    const pad = (reach + 2.5) * grid.pitch * cam.z + 14;
    roundRect(ctx, x0 - pad, y0 - pad, x1 - x0 + pad * 2, y1 - y0 + pad * 2 + 30, 28);
    ctx.stroke();
    ctx.font = `500 11px ${p.colors.font}`;
    ctx.fillStyle = p.colors.sub;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(s.label.toUpperCase(), x0 - pad + 18, y0 - pad - 6);
  }
  ctx.restore();
}

/** One cluster's aura dots and tiles, with the wave at `phase` (null: still). */
function paintCells(p: Paint, cells: readonly RelayCell[]) {
  const { ctx, cam, grid } = p;
  const mode = p.colors.mode;
  const glow = mode === 'glow';
  const P = grid.pitch;
  const dr = Math.max(0.8, Math.min(1.4, cam.z * 1.6));
  const ts = P * cam.z * 1.6;
  ctx.save();
  ctx.globalCompositeOperation = glow ? 'lighter' : 'source-over';
  ctx.globalAlpha = p.alpha;
  // The aura: dots of one style share one path and one fill.
  for (const list of auraBuckets.values()) list.length = 0;
  for (const cell of cells) {
    if (cell.role === 'tile') continue;
    const c = p.byKey.get(cell.key);
    if (!c) continue;
    const wave = p.phase === null || c.resting ? 0 : waveAt(cell.d, p.phase, c.live);
    const f = Math.max(0, 1 - cell.da);
    const a = (c.resting ? 0.05 : 0.1 + f * 0.45) + wave * 0.5;
    const style = auraStyle(toneOf(p, c), mode, Math.round(Math.min(1, a) * ALPHA_STEPS));
    let list = auraBuckets.get(style);
    if (!list) {
      list = [];
      auraBuckets.set(style, list);
    }
    list.push(cell.x * cam.z + cam.x, cell.y * cam.z + cam.y, (1.1 + f * 1.1 + wave * 1.2) * dr);
  }
  for (const [style, list] of auraBuckets) {
    if (list.length === 0) continue;
    ctx.fillStyle = style;
    ctx.beginPath();
    for (let n = 0; n < list.length; n += 3) {
      ctx.moveTo(list[n] + list[n + 2], list[n + 1]);
      ctx.arc(list[n], list[n + 1], list[n + 2], 0, Math.PI * 2);
    }
    ctx.fill();
  }
  // The tiles, over the aura.
  for (const cell of cells) {
    if (cell.role !== 'tile') continue;
    const c = p.byKey.get(cell.key);
    if (!c) continue;
    const sprite = tileSprite(toneOf(p, c), mode, cell.lit);
    if (!sprite) continue;
    const wave = p.phase === null || c.resting ? 0 : waveAt(cell.d, p.phase, c.live);
    ctx.globalAlpha = p.alpha * Math.min(1, (c.resting ? 0.35 : cell.lit ? 0.85 : 0.6) + wave * 0.4);
    const s = ts * (1 + wave * 0.14);
    ctx.drawImage(sprite, cell.x * cam.z + cam.x - s / 2, cell.y * cam.z + cam.y - s / 2, s, s);
  }
  ctx.restore();
}

/** Name, then "5 left" / "all done" / "resting", under each cluster. */
function paintLabels(p: Paint) {
  const { ctx, cam, grid } = p;
  ctx.save();
  ctx.globalAlpha = p.alpha;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const c of p.scene.clusters) {
    const [x, y] = screen(p, c.x, c.y);
    const o = ((grid.reach.get(c.key) ?? 0) + 1.4) * grid.pitch * cam.z + 8;
    if (x < -200 || x > p.w + 200 || y + o < -40 || y > p.h + 40) continue;
    ctx.font = `600 12.5px ${p.colors.font}`;
    ctx.fillStyle = c.resting ? p.colors.sub : p.colors.fg;
    ctx.fillText(c.name, x, y + o);
    ctx.font = `500 11px ${p.colors.font}`;
    ctx.fillStyle = p.colors.sub;
    const left = Math.max(0, c.tiles - c.lit);
    ctx.fillText(
      c.resting ? ATLAS_COPY.farResting : c.allDone || (c.tiles > 0 && left === 0) ? ATLAS_COPY.farAllDone : ATLAS_COPY.farLeft(left),
      x,
      y + o + 17
    );
  }
  ctx.restore();
}

/**
 * Paint a frame. `part`: everything (a still frame), only what does not wave
 * (the cached layer while the wave runs), or only the waving clusters.
 */
function paint(p: Paint, part: 'all' | 'static' | 'live', waving: ReadonlySet<string>) {
  const v = viewRect(p.cam, { w: p.w, h: p.h });
  const view = { x0: v.x, y0: v.y, x1: v.x + v.w, y1: v.y + v.h };
  if (part !== 'live') {
    // The mock's order: the washes first, so the grid stays crisp over them.
    if (p.colors.mode === 'bloom') paintPools(p);
    paintDots(p);
    paintLinks(p);
    const inView = cellsInView(p.grid.all, view, p.grid.pitch);
    const cells = part === 'static' ? inView.filter((c) => !waving.has(c.key)) : inView;
    paintCells({ ...p, phase: part === 'static' ? null : p.phase }, cells);
    paintLabels(p);
    return;
  }
  liveScratch.length = 0;
  for (const key of waving) {
    const own = p.grid.byCluster.get(key);
    if (own) for (const cell of own) liveScratch.push(cell);
  }
  paintCells(p, cellsInView(liveScratch, view, p.grid.pitch));
}

export function AtlasFarCanvas({
  scene,
  colors,
  reduced,
  interactive,
  width,
  onFly,
}: {
  scene: FarScene;
  colors: AtlasColors;
  reduced: boolean;
  /** Below 0.5: the cluster buttons are on (in the handoff band the cards are). */
  interactive: boolean;
  /** The board's width, to keep the tooltip on screen. */
  width: number;
  onFly: (key: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const grid = useMemo(
    () =>
      buildRelayGrid(
        scene.clusters.map((c) => ({ key: c.key, x: c.x, y: c.y, tiles: c.tiles, lit: c.lit })),
        ATLAS_GRID_PITCH
      ),
    [scene.clusters]
  );
  const byKey = useMemo(() => new Map(scene.clusters.map((c) => [c.key, c])), [scene.clusters]);
  const waving = useMemo(
    () => new Set(reduced ? [] : scene.clusters.filter((c) => c.live > 0 && !c.resting).map((c) => c.key)),
    [scene.clusters, reduced]
  );

  // Everything the painter reads, in a ref: a camera move repaints without a render.
  const live = useRef({ grid, byKey, scene, colors, waving });
  useEffect(() => {
    live.current = { grid, byKey, scene, colors, waving };
  });

  // Paused when the canvas is off screen or the tab is hidden.
  const [tabVisible, setTabVisible] = useState(true);
  const [onScreen, setOnScreen] = useState(true);
  const visible = tabVisible && onScreen;
  useEffect(() => {
    const el = canvasRef.current;
    const onVis = () => setTabVisible(document.visibilityState !== 'hidden');
    onVis();
    document.addEventListener('visibilitychange', onVis);
    const io =
      el && typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting))
        : null;
    if (el) io?.observe(el);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      io?.disconnect();
    };
  }, []);

  // The painter: a still frame on demand, or the wave loop.
  const frame = useRef<{
    raf: number | null;
    last: number;
    dirty: boolean;
    /** The wave loop is running: it draws any pending change on its next frame. */
    looping: boolean;
    layer: HTMLCanvasElement | null;
    size: { w: number; h: number; dpr: number };
  }>({ raf: null, last: 0, dirty: true, looping: false, layer: null, size: { w: 0, h: 0, dpr: 1 } });

  const draw = useCallback(
    (t: number) => {
      const el = canvasRef.current;
      const ctx = el?.getContext('2d');
      if (!el || !ctx) return;
      const f = frame.current;
      const { w, h, dpr } = f.size;
      if (w <= 0 || h <= 0) return;
      const cam = useAtlasUiStore.getState().camera;
      const L = live.current;
      const runWave = L.waving.size > 0;
      const base: Paint = {
        ctx,
        w,
        h,
        cam,
        grid: L.grid,
        byKey: L.byKey,
        scene: L.scene,
        colors: L.colors,
        alpha: handoffProgress(cam.z),
        phase: runWave ? (t / ATLAS_WAVE_PERIOD_MS) % 1 : null,
      };
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!runWave) {
        paint(base, 'all', L.waving);
        return;
      }
      // The wave: the still part is painted once into a cached layer.
      if (!f.layer) f.layer = document.createElement('canvas');
      const layer = f.layer;
      const lctx = layer.getContext('2d');
      if (!lctx) {
        paint(base, 'all', L.waving);
        return;
      }
      if (f.dirty || layer.width !== el.width || layer.height !== el.height) {
        layer.width = el.width;
        layer.height = el.height;
        lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        lctx.clearRect(0, 0, w, h);
        paint({ ...base, ctx: lctx }, 'static', L.waving);
        f.dirty = false;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(layer, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint(base, 'live', L.waving);
    },
    []
  );

  const requestDraw = useCallback(() => {
    const f = frame.current;
    f.dirty = true;
    // The wave loop picks the change up on its next frame: one draw, not two.
    if (f.looping || f.raf !== null) return;
    f.raf = requestAnimationFrame((t) => {
      f.raf = null;
      draw(t);
    });
  }, [draw]);

  // Size: DPR at most 2, from the canvas's own box. Resizing the backing
  // store clears it, so it happens only on a real change and is redrawn in
  // the same task (a deferred draw would paint one blank frame). A layout
  // effect, so the first frame is drawn before the first paint.
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const measure = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = el.clientWidth;
      const h = el.clientHeight;
      const f = frame.current;
      if (w === f.size.w && h === f.size.h && dpr === f.size.dpr) return;
      f.size = { w, h, dpr };
      el.width = Math.max(1, Math.round(w * dpr));
      el.height = Math.max(1, Math.round(h * dpr));
      f.dirty = true;
      draw(performance.now());
    };
    measure();
    // A move between a 1x and a 2x screen changes the ratio, not the box.
    let mq: MediaQueryList | null = null;
    const onDpr = () => {
      measure();
      arm();
    };
    const arm = () => {
      mq?.removeEventListener('change', onDpr);
      mq = typeof window.matchMedia === 'function' ? window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`) : null;
      mq?.addEventListener?.('change', onDpr);
    };
    arm();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      mq?.removeEventListener?.('change', onDpr);
    };
  }, [draw]);

  // A camera move repaints (never a React render).
  useEffect(() => useAtlasUiStore.subscribe((s, prev) => s.camera !== prev.camera && requestDraw()), [requestDraw]);
  // So does new data, new colours or a new wave set.
  useEffect(() => {
    requestDraw();
  }, [grid, colors, waving, scene, requestDraw]);

  // The wave loop: only with something to wave, on screen, tab visible, and
  // never under reduced motion.
  // A pending change (a camera move) is drawn at once, past the throttle.
  useEffect(() => {
    if (waving.size === 0 || !visible || reduced) return;
    const f = frame.current;
    f.looping = true;
    let raf = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (!f.dirty && t - f.last < WAVE_FRAME_MS - WAVE_FRAME_SLACK_MS) return;
      f.last = t;
      draw(t);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      f.looping = false;
      cancelAnimationFrame(raf);
      // Anything that came in while the loop owned drawing still lands.
      if (f.dirty) requestDraw();
    };
  }, [waving, visible, reduced, draw, requestDraw]);

  useEffect(
    () => () => {
      const f = frame.current;
      if (f.raf !== null) cancelAnimationFrame(f.raf);
      f.raf = null;
      f.layer = null;
    },
    []
  );

  // The tooltip: one element, shown by mounting (never a fade). The hits
  // unmount in the handoff band with no pointerleave, so leaving interactive
  // drops the tip, or it would come back over nothing on the way out again.
  const [tip, setTip] = useState<string | null>(null);
  const [tipInteractive, setTipInteractive] = useState(interactive);
  if (tipInteractive !== interactive) {
    setTipInteractive(interactive);
    if (!interactive) setTip(null);
  }
  const tipCluster = tip ? byKey.get(tip) : undefined;

  return (
    <>
      <canvas
        ref={canvasRef}
        aria-hidden
        data-testid="atlas-far-canvas"
        data-atlas-far-mode={colors.mode}
        data-waving={waving.size > 0 && visible && !reduced ? 'true' : undefined}
        className="pointer-events-none absolute inset-0 size-full"
      />
      {interactive && (
        <FarHitLayer clusters={scene.clusters} grid={grid} onFly={onFly} onTip={setTip} />
      )}
      {interactive && tipCluster && <FarTip cluster={tipCluster} width={width} />}
    </>
  );
}

/** The cluster buttons, in a layer carrying the camera's transform (one node re-renders on a pan). */
function FarHitLayer({
  clusters,
  grid,
  onFly,
  onTip,
}: {
  clusters: readonly FarCluster[];
  grid: RelayGrid;
  onFly: (key: string) => void;
  onTip: (key: string | null) => void;
}) {
  const { x, y, z } = useAtlasUiStore((s) => s.camera);
  return (
    <div
      role="group"
      aria-label={ATLAS_COPY.farLabel}
      className="absolute left-0 top-0 origin-top-left"
      data-testid="atlas-far-hits"
      style={{ transform: `translate(${x}px, ${y}px) scale(${z})` }}
    >
      {clusters.map((c) => (
        <FarHit key={c.key} cluster={c} reach={grid.reach.get(c.key) ?? 0} onFly={onFly} onTip={onTip} />
      ))}
    </div>
  );
}

const FarHit = memo(function FarHit({
  cluster,
  reach,
  onFly,
  onTip,
}: {
  cluster: FarCluster;
  reach: number;
  onFly: (key: string) => void;
  onTip: (key: string | null) => void;
}) {
  const half = (reach + 2) * ATLAS_GRID_PITCH;
  const statusId = useId();
  // A click flies in; a drag that starts here pans (the surface takes the
  // press and its pointer capture, so the release is heard on window).
  const press = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointerup', up, true);
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) onFly(cluster.key);
    };
    window.addEventListener('pointerup', up, true);
  };
  return (
    <ContainerContextMenu
      kind={cluster.kind}
      id={cluster.id}
      extra={
        <ItemMenuRow
          icon={<ZoomIn className="size-3.5" />}
          label={ATLAS_COPY.farZoomIn}
          testId="container-menu-zoom-in"
          onSelect={() => onFly(cluster.key)}
        />
      }
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={ATLAS_COPY.farClusterLabel(cluster.name, cluster.kindLabel)}
        aria-describedby={statusId}
        data-atlas-far-cluster={cluster.key}
        className="absolute cursor-zoom-in rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ left: cluster.x - half, top: cluster.y - half, width: half * 2, height: half * 2 }}
        onPointerDown={press}
        onPointerEnter={() => onTip(cluster.key)}
        onPointerLeave={() => onTip(null)}
        onFocus={() => onTip(cluster.key)}
        onBlur={() => onTip(null)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          e.stopPropagation();
          onFly(cluster.key);
        }}
      >
        {/* What the tiles and the tooltip show, for a screen reader. */}
        <span id={statusId} className="sr-only">
          {farClusterStatus(cluster)}
        </span>
      </div>
    </ContainerContextMenu>
  );
});

/** What the canvas and the tooltip show for a cluster, as one sentence for a screen reader. */
function farClusterStatus(c: FarCluster): string {
  const tip = ATLAS_COPY.farTip(c.kindLabel, c.lit, c.tiles);
  const line = c.resting
    ? c.restingSince
      ? ATLAS_COPY.restingSince(c.restingSince)
      : ATLAS_COPY.farResting
    : c.nextTitle
      ? ATLAS_COPY.farNext(c.nextTitle)
      : ATLAS_COPY.farNothingLeft;
  return ATLAS_COPY.farClusterStatus(tip, line);
}

/** Room the tooltip needs above its cluster; nearer the top it sits below. */
const TIP_ROOM = 96;

/** "Name / Project · 2 of 7 done / Next: …", above the cluster (below it near the top). */
function FarTip({ cluster, width: w }: { cluster: FarCluster; width: number }) {
  const cam = useAtlasUiStore((s) => s.camera);
  const x = cluster.x * cam.z + cam.x;
  const y = cluster.y * cam.z + cam.y;
  const below = y - 18 < TIP_ROOM;
  return (
    <div
      role="tooltip"
      data-testid="atlas-far-tip"
      className="pointer-events-none absolute z-30 max-w-60 rounded-xl border border-border bg-popover px-3 py-2 text-xs leading-snug text-popover-foreground shadow-[var(--shadow-elev-sm)]"
      style={{
        left: w > 0 ? Math.max(130, Math.min(w - 130, x)) : x,
        top: below ? y + 18 : y - 18,
        transform: below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
      }}
    >
      <b className="block text-[13px] font-semibold">{cluster.name}</b>
      <span className="text-muted-foreground">
        {ATLAS_COPY.farTip(cluster.kindLabel, cluster.lit, cluster.tiles)}
        {cluster.resting && cluster.restingSince ? ` · ${ATLAS_COPY.restingSince(cluster.restingSince)}` : ''}
      </span>
      <br />
      {cluster.nextTitle ? ATLAS_COPY.farNext(cluster.nextTitle) : ATLAS_COPY.farNothingLeft}
    </div>
  );
}
