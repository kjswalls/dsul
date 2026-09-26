'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import {
  DEFAULT_LIGHT_PALETTE,
  relayLightColors,
  type RelayLightPaletteKey,
} from '@/lib/relay-palettes';

/**
 * RelayField — an ambient "data relay" visualization: a grid of glowing
 * rounded-square tiles that pulse in a wave rippling out from a focal point.
 * Ported from the Sunday Softworks site (a full-bleed canvas hero) and tuned
 * for dsul. Dark mode reads the live theme tokens and blends additively
 * (`lighter`) so the tiles bloom as glowing nodes on the navy ground. Light
 * mode can't add light to near-white paper, so it inverts the trick: a
 * monochrome GRAYSCALE ramp (near-neutral, only a whisper of the cool ink hue),
 * painted `source-over`, whose pulse deepens the tiles DOWNWARD instead of
 * brightening them — a "sonar" that reads as intentional tonal texture, where a
 * full-spectrum palette would scatter into confetti on the warm gray.
 *
 * Each tile is a pre-baked 64px sprite: a radial glow halo plus two nested
 * rounded squares (dim outer, bright core). The pulse envelope is a quick
 * bloom → decay → dim-floor on a 3.6s period; a per-tile phase derived from its
 * distance to the focal point makes the whole field breathe outward.
 *
 * Performance/a11y (inherited from the source): DPR capped at 2, paused when
 * offscreen (IntersectionObserver) or the tab is hidden (visibilitychange),
 * and frozen to a single static frame under `prefers-reduced-motion`.
 *
 * The element is `pointer-events-none` and `aria-hidden` — a pure decoration
 * layer. Consumers wrap a `relative` target and drop this in as
 * `<RelayField className="absolute inset-0" … />`.
 */
export interface RelayFieldProps {
  className?: string;
  /** CSS mask-image to fade the field's edges (applied to -webkit + standard). */
  mask?: string;
  /** Vertical origin of the ripple, 0 (top) – 1 (bottom). Default 0.42. */
  focalY?: number;
  /**
   * Horizontal origin of the ripple, 0 (left) – 1 (right). Default 0.5.
   *
   * Exists for surfaces whose content is not horizontally centred — the login
   * page measures its own sign-in column and passes its centre, so the wave is
   * born under the content rather than in whichever half happens to be empty.
   */
  focalX?: number;
  /** Target grid spacing in px. Smaller = denser field. Default 40. */
  pitch?: number;
  /** Pulse period in seconds. Default 3.6. */
  period?: number;
  /**
   * Drives a smooth intensity ramp: while true the field settles toward
   * `activeIntensity`, otherwise toward `idleIntensity`. Use for
   * brighten-on-focus / brighten-while-streaming, or a one-shot burst.
   */
  active?: boolean;
  /** Master alpha multiplier at rest (active=false). Default 0.6. */
  idleIntensity?: number;
  /**
   * Overrides `idleIntensity` in a LIGHT context — the idle mirror of
   * `activeIntensityLight`. Light-mode tiles are subtractive ink on paper, so
   * the same idle level reads far fainter than the dark glow; this lets one
   * instance sit brighter on paper without touching its dark rest level. Falls
   * back to `idleIntensity` when unset.
   */
  idleIntensityLight?: number;
  /** Master alpha multiplier while `active`. Default 1. */
  activeIntensity?: number;
  /**
   * Overrides `activeIntensity` when the field sits in a LIGHT context, so the
   * same instance can run a gentler active state on paper than its glow does in
   * dark mode. Falls back to `activeIntensity` when unset.
   */
  activeIntensityLight?: number;
  /**
   * A token, not a flag: every time this value CHANGES the field's ripple
   * restarts from the focal point and flares briefly — a stone dropped in the
   * pond. It is the SAME wave the field always runs, re-struck; nothing new is
   * drawn over the top. Increment a counter to trigger it.
   */
  burst?: number;
  /**
   * How far above its settled level the field flares on a burst, as a multiple.
   * Relative rather than absolute so one value reads the same in both themes,
   * where the settled levels differ. Default 1.6.
   */
  burstBoost?: number;
  /**
   * Seconds for the flare to fall back to the settled level. Default 0.9.
   *
   * Needs its own decay rather than riding the field's settle lerp: that lerp
   * is tuned for a focus ramp and lands inside ~300ms, which is over before the
   * restarted ripple has travelled anywhere, so the flare and the wave read as
   * two unrelated events. This wants to still be fading while the first ring is
   * on its way out.
   */
  burstDecay?: number;
  /**
   * Center-to-edge intensity ramp. Alpha is scaled by
   * `radialGain + (1 - radialGain) * d`, where d is 0 at the focal point and 1
   * at the farthest corner — so `radialGain < 1` starts the ring calm at the
   * center and lets it grow hotter as it expands outward. Default 1 (uniform).
   */
  radialGain?: number;
  /**
   * When true, the ripple's focal point smoothly chases the pointer across the
   * field's container instead of resting at `focalX`/`focalY` — which is also
   * the point `pointerParallax` leans away from, so a field whose resting focal
   * has been moved onto its content leans away from the content, not from the
   * middle of the window. Adds a window pointer
   * listener, so opt in only where the field is meant to be interactive.
   * Default false.
   */
  pointerFocus?: boolean;
  /**
   * When true, a click/tap flares the whole field brighter for a beat (a
   * `burstBoost`/`burstDecay` swell) — a brightness pulse in place, without
   * restarting the ripple or moving the focal. Default false.
   */
  pointerBurst?: boolean;
  /**
   * How fast the focal eases toward the pointer under `pointerFocus`, per frame
   * (0–1). Lower = slower, subtler drift. Default 0.12.
   */
  pointerEase?: number;
  /**
   * Under `pointerFocus`, the fraction of the pointer's offset-from-center the
   * focal adopts: 1 lets it ride all the way to the cursor, while a small value
   * (e.g. 0.15) keeps it near center and only tilts slightly toward the pointer
   * — a parallax lean rather than a follow. Default 1.
   */
  pointerParallax?: number;
  /**
   * Which light-mode palette to paint (see lib/relay-palettes.ts). Only affects
   * light contexts; dark contexts read the live theme tokens unless `darkPalette`
   * is set. Defaults to the catalog default ('gray'); this is the seam for future
   * user theming.
   */
  lightPalette?: RelayLightPaletteKey;
  /**
   * An explicit DARK-mode palette (oklch/color strings) that overrides the live
   * lime-dominant tokens dark normally reads — for a field that must key to a
   * different accent than the app's `--primary`, e.g. the honey relay behind
   * Beacon's working block. Light contexts still use `lightPalette`. Pass a
   * STABLE array (a module constant): it is an effect dependency, so a fresh
   * array each render would re-initialise the field.
   */
  darkPalette?: readonly string[];
}

interface Cell {
  x: number;
  y: number;
  /** Grid-space center (column + 0.5, row + 0.5) — kept so a moving focal can
   *  recompute distance/phase per frame without touching pixel positions. */
  gx: number;
  gy: number;
  /** Normalized distance to the static (focalX/focalY) focal, and the phase
   *  derived from it. Used whenever the field is NOT pointer-driven. */
  d0: number;
  phase0: number;
  /** Per-tile phase jitter (0.09 * hash), reused when phase is recomputed live. */
  jitter: number;
  max: number;
  ci: number;
}

/** Deterministic per-tile pseudo-random (fract of a big sine), matching source. */
function hash(i: number, seed: number): number {
  const r = 43758.5453 * Math.sin((i + 1) * 12.9898 + 78.233 * seed);
  return r - Math.floor(r);
}

/** Inject an alpha into an oklch() string via the `/ a` syntax. */
function withAlpha(color: string, a: number): string {
  return color.startsWith('oklch(') ? color.replace(')', ` / ${a})`) : color;
}

/** Trace a rounded square of `size`, centered in the 64px sprite. */
function roundRect(ctx: CanvasRenderingContext2D, size: number, radius: number): void {
  const x = 32 - size / 2;
  const y = 32 - size / 2;
  const r = Math.min(radius, size / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + size, y, x + size, y + size, r);
  ctx.arcTo(x + size, y + size, x, y + size, r);
  ctx.arcTo(x, y + size, x, y, r);
  ctx.arcTo(x, y, x + size, y, r);
  ctx.closePath();
}

/** Bake one tile sprite (glow + nested rounded squares) for a color + theme. */
export function buildSprite(color: string, dark: boolean): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (!g) return c;
  if (!dark) {
    // Light mode = ink tile: no halo (can't add light to paper). Near-neutral
    // cool-gray nested rounded squares; the pulse's rising alpha then deepens
    // them toward gray on the paper — subtractive tonal texture, not a bloom.
    g.fillStyle = withAlpha(color, 0.6);
    roundRect(g, 46, 10);
    g.fill();
    g.fillStyle = withAlpha(color, 1);
    roundRect(g, 30, 7);
    g.fill();
    return c;
  }
  // Dark mode = additive glow: a wide translucent halo blooms on the navy.
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, withAlpha(color, 0.28));
  grad.addColorStop(0.55, withAlpha(color, 0.08));
  grad.addColorStop(1, withAlpha(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = withAlpha(color, 0.16);
  roundRect(g, 32, 5.76);
  g.fill();
  g.fillStyle = withAlpha(color, 0.9);
  roundRect(g, 17.92, 4.6592);
  g.fill();
  return c;
}

/**
 * Per-theme palette. Dark reads the live lime-dominant tokens — under additive
 * blending on navy they pop as-is. Light can't reuse those tokens and instead
 * pulls from the RELAY_LIGHT_PALETTES catalog (see lib/relay-palettes.ts);
 * `lightKey` selects one (default 'gray'). Those are painted source-over so the
 * alpha envelope deepens tiles toward the color at the ripple crest — the
 * light-mode, subtractive mirror of the dark additive bloom.
 */
export function readPalette(
  dark: boolean,
  el: Element,
  lightKey: RelayLightPaletteKey,
  darkOverride?: readonly string[]
): string[] {
  if (dark) {
    // An explicit dark palette (e.g. the honey field behind Beacon) wins over
    // the live lime-dominant tokens; light contexts still read the catalog.
    if (darkOverride && darkOverride.length > 0) return [...darkOverride];
    const cs = getComputedStyle(el);
    const read = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    const primary = read('--primary', 'oklch(0.84 0.15 125)');
    return [
      primary,
      primary,
      primary, // lime dominant
      read('--accent-8', 'oklch(0.76 0.13 125)'), // lime
      read('--afternoon', 'oklch(0.66 0.1 55)'), // orange
      read('--accent-6', 'oklch(0.72 0.1 85)'), // honey
      read('--accent-2', 'oklch(0.66 0.09 190)'), // teal
      read('--accent-3', 'oklch(0.64 0.11 265)'), // indigo
      read('--accent-1', 'oklch(0.66 0.1 140)'), // moss
    ];
  }
  return relayLightColors(lightKey);
}

/**
 * True when the element sits in a dark context — read from its OWN computed
 * --background, not the document's. This lets a field inside a locally-dark
 * island (e.g. the dock capsule marked `.dark` while the app is in light mode)
 * glow additively, matching that island rather than the page.
 */
export function isDarkContext(el: Element): boolean {
  const bg = getComputedStyle(el).getPropertyValue('--background').trim();
  // Lightness is oklch()'s first component, but its SERIALISATION is not
  // stable: the authored token is a 0–1 number (`oklch(0.173 …)`) and the
  // production build's minifier rewrites it as a percentage
  // (`oklch(17.3% …)`). Parsing the number without checking for the '%' makes
  // 17.3 fail a `< 0.5` test, so every field quietly fell back to its LIGHT
  // palette in a prod dark theme while looking correct in dev.
  const m = bg.match(/oklch\(\s*([\d.]+)(%?)/);
  if (m) return parseFloat(m[1]) / (m[2] ? 100 : 1) < 0.5;
  return !!el.closest('.dark');
}

/** Farthest-corner distance from a focal, in grid units (min 1 to avoid /0). */
function cornerMaxD(fx: number, fy: number, cols: number, rows: number): number {
  let m = 1;
  for (const [x, y] of [[0, 0], [cols, 0], [0, rows], [cols, rows]]) {
    m = Math.max(m, Math.hypot(x - fx, y - fy));
  }
  return m;
}

/** Pulse envelope: quick bloom → decay → dim floor, phase-shifted per tile. */
function pulse(phase: number, max: number, t: number, period: number): number {
  const r = t / period - phase - Math.floor(t / period - phase);
  if (r < 0.12) return 0.05 + (max - 0.05) * (r / 0.12);
  if (r < 0.36) return max - (max - 0.05) * ((r - 0.12) / 0.24);
  return 0.05;
}

export function RelayField({
  className,
  mask,
  focalY = 0.42,
  focalX = 0.5,
  pitch = 40,
  period = 3.6,
  active = false,
  idleIntensity = 0.6,
  idleIntensityLight,
  activeIntensity = 1,
  activeIntensityLight,
  burst = 0,
  burstBoost = 1.6,
  burstDecay = 0.9,
  radialGain = 1,
  pointerFocus = false,
  pointerBurst = false,
  pointerEase = 0.12,
  pointerParallax = 1,
  lightPalette = DEFAULT_LIGHT_PALETTE,
  darkPalette,
}: RelayFieldProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Mutable knobs the RAF loop reads without forcing a re-init on change.
  const knobs = useRef({
    active,
    idleIntensity,
    idleIntensityLight,
    activeIntensity,
    activeIntensityLight,
    period,
    burst,
    burstBoost,
    burstDecay,
    radialGain,
    pointerEase,
    pointerParallax,
  });
  useEffect(() => {
    knobs.current = {
      active,
      idleIntensity,
      idleIntensityLight,
      activeIntensity,
      activeIntensityLight,
      period,
      burst,
      burstBoost,
      burstDecay,
      radialGain,
      pointerEase,
      pointerParallax,
    };
  });

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let dark = isDarkContext(container);
    let palette = readPalette(dark, container, lightPalette, darkPalette);
    let sprites = palette.map((c) => buildSprite(c, dark));
    let cells: Cell[] = [];
    let gridPitch = pitch;
    // Grid geometry, kept around for pointer→grid mapping and the moving focal.
    let gridCols = 0;
    let gridRows = 0;
    let yOffset = 0;
    let staticMaxD = 1;
    // The resting focal (grid units) parallax leans away from.
    let staticFx = 0;
    let staticFy = 0;
    // Live ripple focal (grid units) and the target it eases toward. Anchored to
    // the static focalX/focalY focal until the pointer takes over.
    //
    // Named liveFx/liveFy, NOT focalX/focalY: those are the props, and a local
    // of the same name shadows them everywhere inside this effect — including
    // in layout(), where `fx` is derived from the focalX PROP. That shadowing
    // type-checks and lints clean while quietly making the resting focal
    // circular (fx from the live focal, live focal from fx).
    let liveFx = 0;
    let liveFy = 0;
    let targetX = 0;
    let targetY = 0;
    let pointerActive = false;
    let flash = false; // a click brightness flash is pending
    // Only pointerFocus needs the per-frame moving-focal path; a burst-only
    // field keeps its baked static distances and just flares on click.
    const dynamicFocal = pointerFocus;
    // In a light context, a defined *Light override wins for that state.
    const activeFor = (k: typeof knobs.current) =>
      !dark && k.activeIntensityLight != null ? k.activeIntensityLight : k.activeIntensity;
    const idleFor = (k: typeof knobs.current) =>
      !dark && k.idleIntensityLight != null ? k.idleIntensityLight : k.idleIntensity;
    let curIntensity = knobs.current.active
      ? activeFor(knobs.current)
      : idleFor(knobs.current);

    let rafId = 0;
    let startTs = 0;
    let visible = false;
    // Seeded from the CURRENT token so a field that mounts with a non-zero
    // burst (a remount mid-session) doesn't fire one on its first frame.
    let lastBurst = knobs.current.burst;
    // Time origin for the ripple. A burst moves it to "now", which is what
    // restarts the wave from the focal point. `flareT0` runs the brightness
    // flare that rides along with it.
    let phaseT0 = 0;
    let flareT0 = -1;

    const draw = (t: number) => {
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      // Mosaic tiles sit tighter (less overlap) than the wide glow sprites.
      const size = (dark ? 1.9 : 1.3) * gridPitch;
      const k = knobs.current;
      const target = k.active ? activeFor(k) : idleFor(k);
      curIntensity += (target - curIntensity) * 0.08;

      // A burst re-strikes the pond: the ripple's origin moves to now, so the
      // same wave the field always runs starts over from the focal point, and a
      // flare rides on top. Nothing extra is painted — `flare` only scales the
      // tiles the restarted wave is already lighting.
      if (k.burst !== lastBurst) {
        lastBurst = k.burst;
        phaseT0 = t;
        flareT0 = t;
      }
      // A click flashes the field brighter in place — flare only, no wave
      // restart (phaseT0 untouched), so the ripple keeps its rhythm.
      if (flash) {
        flash = false;
        flareT0 = t;
      }
      let flare = 1;
      if (flareT0 >= 0) {
        const u = (t - flareT0) / Math.max(0.05, k.burstDecay);
        if (u >= 1) flareT0 = -1;
        // Squared falloff: a sharp strike that tails off, rather than a linear
        // ramp that reads as the whole field being dimmed on a slider.
        else flare = 1 + (k.burstBoost - 1) * (1 - u) * (1 - u);
      }

      // Chase the pointer: the focal eases toward its target each frame so the
      // ring re-centers smoothly rather than snapping, and maxD tracks the
      // moving focal so the outward ramp stays normalized.
      let liveMaxD = staticMaxD;
      if (dynamicFocal) {
        liveFx += (targetX - liveFx) * k.pointerEase;
        liveFy += (targetY - liveFy) * k.pointerEase;
        liveMaxD = cornerMaxD(liveFx, liveFy, gridCols, gridRows);
      }
      const rg = k.radialGain;

      ctx.clearRect(0, 0, w, h);
      // Dark adds light (lighter); light lays down ink (source-over) — higher
      // alpha = a deeper ink tile on the paper, so the pulse darkens toward the
      // crest rather than brightening.
      ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
      for (const cell of cells) {
        // Distance/phase are recomputed per frame while the focal moves, else
        // the baked statics.
        const d = dynamicFocal
          ? Math.min(1, Math.hypot(cell.gx - liveFx, cell.gy - liveFy) / liveMaxD)
          : cell.d0;
        const phase = dynamicFocal ? (2.4 * d + cell.jitter) % 1 : cell.phase0;
        const env = reduced ? 0.5 * cell.max : pulse(phase, cell.max, t - phaseT0, k.period);
        // Center-calm → edge-hot ramp; a no-op (1) at the default radialGain 1.
        const radial = rg + (1 - rg) * d;
        const a = Math.min(1, env * curIntensity * flare * radial);
        if (a <= 0.02) continue;
        ctx.globalAlpha = a;
        ctx.drawImage(sprites[cell.ci], cell.x - size / 2, cell.y - size / 2, size, size);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    };

    const loop = (ts: number) => {
      if (!startTs) startTs = ts;
      draw((ts - startTs) / 1000);
      rafId = requestAnimationFrame(loop);
    };
    const start = () => {
      if (!rafId && visible && !reduced) rafId = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    };

    const layout = () => {
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      if (cw === 0 || ch === 0) return;
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      canvas.style.width = `${cw}px`;
      canvas.style.height = `${ch}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const cols = Math.max(6, Math.round(cw / pitch));
      const cell = cw / cols;
      const rows = Math.ceil(ch / cell) + 1;
      const yOff = (ch - rows * cell) / 2;
      const fx = cols * focalX;
      const fy = rows * focalY;
      staticMaxD = cornerMaxD(fx, fy, cols, rows);
      const next: Cell[] = [];
      for (let ry = 0; ry < rows; ry++) {
        for (let rx = 0; rx < cols; rx++) {
          const idx = ry * cols + rx;
          const gx = rx + 0.5;
          const gy = ry + 0.5;
          const jitter = 0.09 * hash(idx, 4);
          const d = Math.min(1, Math.hypot(gx - fx, gy - fy) / staticMaxD);
          next.push({
            x: rx * cell + cell / 2,
            y: yOff + ry * cell + cell / 2,
            gx,
            gy,
            d0: d,
            phase0: (2.4 * d + jitter) % 1,
            jitter,
            max: 0.45 + 0.35 * hash(idx, 5),
            ci: Math.floor(hash(idx, 1) * palette.length),
          });
        }
      }
      cells = next;
      gridPitch = cell;
      gridCols = cols;
      gridRows = rows;
      yOffset = yOff;
      staticFx = fx;
      staticFy = fy;
      // Re-anchor the live focal to the static one on (re)layout — grid units
      // change meaning with cell size — but never yank it away from the pointer.
      if (!pointerActive) {
        liveFx = targetX = fx;
        liveFy = targetY = fy;
      }
      if (reduced) draw(0);
    };

    const rebuildForTheme = () => {
      const nowDark = isDarkContext(container);
      if (nowDark === dark) return;
      dark = nowDark;
      palette = readPalette(dark, container, lightPalette, darkPalette);
      sprites = palette.map((c) => buildSprite(c, dark));
      if (reduced) draw(0);
    };

    const ro = new ResizeObserver(layout);
    ro.observe(container);
    layout();

    const io = new IntersectionObserver(
      ([e]) => {
        visible = e.isIntersecting;
        if (visible) start();
        else stop();
      },
      { threshold: 0 }
    );
    io.observe(container);

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Pointer interaction (opt-in). The field is pointer-events-none, so we
    // listen on the window and map clientX/Y into the container's box.
    const toGrid = (clientX: number, clientY: number) => {
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return {
        x: (clientX - rect.left) / gridPitch,
        y: (clientY - rect.top - yOffset) / gridPitch,
      };
    };
    const onPointerMove = (e: PointerEvent) => {
      const g = toGrid(e.clientX, e.clientY);
      if (!g) return;
      pointerActive = true;
      // Lean only a fraction of the way from center to the pointer, so the focal
      // tilts off-center rather than chasing the cursor outright.
      const p = knobs.current.pointerParallax;
      targetX = staticFx + (g.x - staticFx) * p;
      targetY = staticFy + (g.y - staticFy) * p;
    };
    const onPointerDown = () => {
      // Brightness flash only — no focal move, no ripple restart.
      flash = true;
    };
    if (pointerFocus) window.addEventListener('pointermove', onPointerMove, { passive: true });
    if (pointerBurst) window.addEventListener('pointerdown', onPointerDown, { passive: true });

    // Re-bake sprites/palette when the theme toggles (class or inline style on <html>).
    const themeObserver = new MutationObserver(rebuildForTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme'],
    });

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      themeObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [focalY, focalX, pitch, lightPalette, darkPalette, pointerFocus, pointerBurst]);

  return (
    <div
      ref={containerRef}
      aria-hidden
      className={cn('pointer-events-none overflow-hidden', className)}
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
}
