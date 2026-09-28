'use client';

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { ZenSurface } from '@/components/zen/zen-room';
import { buildSprite, isDarkContext, readPalette } from '@/components/primitives/relay-field';
import { RELAY_LIGHT_PALETTES } from '@/lib/relay-palettes';
import { useViewStore } from '@/lib/view-store';
import { usePlannerStore } from '@/lib/planner-store';
import { setHoveredItemRef } from '@/lib/hovered-item';
import { toDateStr } from '@/lib/recurrence';
import {
  ZEN_BAND_FRAC,
  ZEN_WAVE_MS,
  farthestCorner,
  traceAt,
  prefersReducedMotion,
  revealRadius,
  tilePhase,
  waveFront,
} from '@/lib/zen-transition';

/**
 * The desktop's planner-or-Zen slot, and the move between them (Relay Lift).
 *
 * At rest exactly one surface is mounted, which is the rule app-shell has
 * always kept: Zen REPLACES the desktop shell rather than covering it. Only
 * for the ~1s of a switch are both mounted — the outgoing one where it already
 * was, the incoming one pinned over it in a fixed layer that a circle clip
 * reveals from the focal point outward while a single RelayField wave rides
 * the seam, with a band of frosted glass just ahead of it. The item Zen puts
 * in its hero is carried by its OUTLINE, not its words: a lime outline leaves
 * the item's block and glides to frame the hero, where the title fades up
 * inside it (and back to the block on the way out). An earlier cut flew and
 * scaled the title itself, which read as a slideshow effect.
 *
 * Each surface keeps the SAME wrapper element whether it is at rest
 * (`display: contents`, so layout is untouched) or moving (the fixed layer), so
 * the outgoing shell is never remounted mid-switch: the planner keeps its
 * scroll position and its measured hour height.
 *
 * `zenOpen` is still the only state anyone writes. This component merely
 * trails it by one animation: `settled` is the surface fully on screen, and
 * whenever it differs from `zenOpen` a switch is in flight. Flipping the flag
 * back mid-switch makes them agree again, which drops the animation and lands
 * on the original surface at once — Z or Esc pressed twice never queues two
 * waves.
 */

const LAYER = 'fixed inset-0 z-[35] overflow-hidden bg-surface-0';
/** Painted on the incoming layer's first frame, before the wave has run. */
const CLOSED = { clipPath: 'circle(0px at 50% 50%)' };

export function ZenStage({ planner }: { planner: ReactNode }) {
  const zenOpen = useViewStore((s) => s.zenOpen);
  const [settled, setSettled] = useState(zenOpen);
  // Reduced motion takes the instant path: no both-mounted frame at all.
  // Adjusting own state during render is React's sanctioned pattern for
  // "state that trails a prop"; it re-renders before anything paints.
  if (settled !== zenOpen && prefersReducedMotion()) setSettled(zenOpen);

  const moving = settled !== zenOpen;
  const plannerRef = useRef<HTMLDivElement>(null);
  const zenRef = useRef<HTMLDivElement>(null);
  // Reads the flag at the END of the flight rather than closing over the value
  // it started with, so a stable callback can never settle on a stale target.
  const finish = useCallback(() => {
    setSettled(useViewStore.getState().zenOpen);
    useViewStore.setState({ zenMoving: false });
    // The room clears lib/hovered-item.ts when it mounts, but it mounts at the
    // START of the wave, and nothing a row writes afterwards is undone by the
    // row unmounting (no mouseleave fires). Clear it again as the room lands so
    // `e` and `⌫` in here never act on a planner row nobody can see.
    setHoveredItemRef(null, null);
  }, []);
  // `zenOpen` and `zenMoving` flip together (lib/view-store.ts), so this only
  // repairs a mismatch nothing should produce — but a stuck `zenMoving` would
  // hide the help bubble for good, so it is not left to chance.
  useLayoutEffect(() => {
    if (!moving && useViewStore.getState().zenMoving) useViewStore.setState({ zenMoving: false });
  }, [moving]);

  const plannerIncoming = moving && !zenOpen;
  const zenIncoming = moving && zenOpen;

  return (
    <>
      {(!settled || moving) && (
        <div
          ref={plannerRef}
          data-zen-layer="planner"
          className={plannerIncoming ? LAYER : 'contents'}
          style={plannerIncoming ? CLOSED : undefined}
          // The outgoing surface stays visible around the wave but is on its
          // way out: nothing in it takes a hover, a click or focus meanwhile.
          inert={zenIncoming}
        >
          {planner}
        </div>
      )}
      {(settled || moving) && (
        <div
          ref={zenRef}
          data-zen-layer="zen"
          className={zenIncoming ? LAYER : 'contents'}
          style={zenIncoming ? CLOSED : undefined}
          inert={plannerIncoming}
        >
          <ZenSurface />
        </div>
      )}
      {moving && (
        <RelayLift
          key={zenOpen ? 'enter' : 'leave'}
          dir={zenOpen ? 'enter' : 'leave'}
          plannerRef={plannerRef}
          zenRef={zenRef}
          onDone={finish}
        />
      )}
    </>
  );
}

type Rect = { x: number; y: number; w: number; h: number };

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

function onScreen(r: Rect): boolean {
  return (
    r.w > 0 && r.h > 0 && r.x + r.w > 0 && r.y + r.h > 0 && r.x < innerWidth && r.y < innerHeight
  );
}

/**
 * The hero's own title somewhere in the planner canvas: the text leaf under a
 * `[data-item-id]` whose whole text is the title. The sidebar is left out (a
 * braindump row is not where the day keeps this item), and the same item can
 * render once per day column, so a copy inside today's column
 * (`[data-date]`) wins over the first one on screen. None at all means the
 * ring runs without a flight.
 */
function findSourceTitle(planner: HTMLElement, id: string, title: string): HTMLElement | null {
  const canvas = planner.querySelector('main') ?? planner;
  const tz =
    usePlannerStore.getState().userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = toDateStr(new Date(), tz);
  let fallback: HTMLElement | null = null;
  for (const host of canvas.querySelectorAll<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`)) {
    if (!onScreen(rectOf(host))) continue;
    let leaf: HTMLElement | null = null;
    for (const el of host.querySelectorAll<HTMLElement>('*')) {
      if (el.children.length === 0 && el.textContent?.trim() === title) {
        leaf = el;
        break;
      }
    }
    if (!leaf || !onScreen(rectOf(leaf))) continue;
    const day = host.closest<HTMLElement>('[data-date]')?.dataset.date;
    if (day === today) return leaf;
    fallback ??= leaf;
  }
  return fallback;
}

/** Dark reads RelayField's full live palette (additive on navy); light takes
 *  Meadow, the lime → teal arc — lime alone deepens toward olive on paper. */
function tileColors(dark: boolean): string[] {
  if (!dark) return RELAY_LIGHT_PALETTES.meadow.colors;
  // Lime-dominant, with its orange, honey, teal, indigo and moss, so the wave
  // reads as the same field the login page and the streak badge run.
  return readPalette(true, document.documentElement, 'gray');
}

function RelayLift({
  dir,
  plannerRef,
  zenRef,
  onDone,
}: {
  dir: 'enter' | 'leave';
  plannerRef: RefObject<HTMLDivElement | null>;
  zenRef: RefObject<HTMLDivElement | null>;
  onDone: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const traceRef = useRef<HTMLDivElement>(null);
  const frostRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const trace = traceRef.current;
    const frost = frostRef.current;
    const planner = plannerRef.current;
    const zen = zenRef.current;
    const incoming = dir === 'enter' ? zen : planner;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !trace || !frost || !planner || !zen || !incoming || !ctx) {
      onDone();
      return;
    }

    const W = innerWidth;
    const H = innerHeight;

    // ── the trace: the item's outline, from its block to the hero and back ──
    const hero = zen.querySelector<HTMLElement>('[data-zen-hero]');
    const title = hero?.textContent?.trim() ?? '';
    const sourceTitle =
      hero && title ? findSourceTitle(planner, hero.dataset.zenHero ?? '', title) : null;
    // The card the user sees: a schedule block's [data-item-id] wrapper is its
    // whole band (rail, bead, and on a double-booking its siblings' panes too),
    // so the pane inside it is the item's own pixels. Rows have no pane.
    const block =
      sourceTitle?.closest<HTMLElement>('[data-slot="pane"]') ??
      sourceTitle?.closest<HTMLElement>('[data-item-id]') ??
      null;
    const tracing = hero && sourceTitle && block ? { hero, sourceTitle, block } : null;
    // The words never travel: the outgoing title fades where it sits and the
    // incoming one fades up inside the outline once it has arrived.
    const leaving = tracing ? (dir === 'enter' ? tracing.sourceTitle : tracing.hero) : null;
    const arriving = tracing ? (dir === 'enter' ? tracing.hero : tracing.sourceTitle) : null;
    // Fades scale from each title's resting opacity: a completed item's title
    // sits at 60% by class, and an inline 1 would flash it bright.
    const restOf = (el: HTMLElement | null) => (el ? parseFloat(getComputedStyle(el).opacity) : 1);
    const leavingRest = restOf(leaving);
    const arrivingRest = restOf(arriving);
    if (arriving) arriving.style.opacity = '0';
    const radius = block ? parseFloat(getComputedStyle(block).borderTopLeftRadius) : NaN;
    const blockRadius = Number.isNaN(radius) ? 8 : radius;

    // ── the focal: where the thing you're looking at starts ──
    const origin =
      (dir === 'enter' ? tracing?.block : tracing?.hero) ??
      (dir === 'enter' ? planner.querySelector('[data-zen-toggle]') : hero) ??
      null;
    const o = origin ? rectOf(origin) : null;
    const fx = o && onScreen(o) ? o.x + o.w / 2 : W / 2;
    const fy = o && onScreen(o) ? o.y + o.h / 2 : H / 2;
    const reach = farthestCorner(fx, fy, W, H);
    const band = reach * ZEN_BAND_FRAC;

    // ── the tiles ──
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const dark = isDarkContext(document.body);
    const sprites = tileColors(dark).map((c) => buildSprite(c, dark));
    const ground =
      getComputedStyle(document.documentElement).getPropertyValue('--surface-0').trim() || 'white';
    const pitch = Math.max(26, Math.min(W, H) / 22);
    const tiles: { x: number; y: number; d: number; s: number }[] = [];
    for (let y = pitch / 2; y < H + pitch; y += pitch) {
      for (let x = pitch / 2; x < W + pitch; x += pitch) {
        const d = Math.hypot(x - fx, y - fy) + (Math.random() - 0.5) * pitch * 0.6;
        tiles.push({ x, y, d, s: Math.floor(Math.random() * sprites.length) });
      }
    }

    const last = tracing ? { hero: rectOf(tracing.hero), block: rectOf(tracing.block) } : null;
    let raf = 0;
    const start = performance.now();
    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / ZEN_WAVE_MS);
      const front = waveFront(t, reach, band);
      const reveal = revealRadius(front, band);
      incoming.style.clipPath = `circle(${reveal}px at ${fx}px ${fy}px)`;

      // The frost: a band of frosted glass just ahead of the ring, so the
      // outgoing surface softens a beat before the tiles reach it. Nothing
      // inside the reveal is frosted — the arriving surface lands sharp.
      const mask = `radial-gradient(circle at ${fx}px ${fy}px, transparent ${reveal}px, #000 ${front}px, #000 ${front + band * 0.3}px, transparent ${front + band * 1.3}px)`;
      frost.style.maskImage = mask;
      frost.style.setProperty('-webkit-mask-image', mask);

      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = ground;
      const lit: [number, number, number, number][] = [];
      for (const tile of tiles) {
        const u = tilePhase(front, tile.d, band);
        if (u === null) continue;
        const env = Math.sin(Math.PI * u);
        // At the ring's centre line (u = 0.5) a ground tile is a hair larger
        // than the pitch, so neighbours overlap and the reveal edge under them
        // is fully covered; either side they shrink apart into loose tiles.
        const size = pitch * (0.3 + 0.78 * env);
        ctx.globalAlpha = env;
        ctx.fillRect(tile.x - size / 2, tile.y - size / 2, size, size);
        lit.push([tile.x, tile.y, env, tile.s]);
      }
      ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
      const spriteSize = pitch * (dark ? 1.6 : 1.1);
      for (const [x, y, env, s] of lit) {
        ctx.globalAlpha = env * (dark ? 1 : 0.85);
        ctx.drawImage(sprites[s], x - spriteSize / 2, y - spriteSize / 2, spriteSize, spriteSize);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;

      if (tracing && last && leaving && arriving) {
        // Measured live every frame: the incoming planner can still be settling
        // (the grid fits its hour height after mount). A node that left the DOM
        // measures as 0,0 — hold its last real place instead.
        if (tracing.hero.isConnected) last.hero = rectOf(tracing.hero);
        if (tracing.block.isConnected) last.block = rectOf(tracing.block);
        const heroBox = padRect(last.hero, 14);
        const [a, b, ra, rb] =
          dir === 'enter'
            ? [last.block, heroBox, blockRadius, 12]
            : [heroBox, last.block, 12, blockRadius];
        const p = traceAt(t);
        trace.style.transform = `translate(${a.x + (b.x - a.x) * p.travel}px, ${a.y + (b.y - a.y) * p.travel}px)`;
        trace.style.width = `${a.w + (b.w - a.w) * p.travel}px`;
        trace.style.height = `${a.h + (b.h - a.h) * p.travel}px`;
        trace.style.borderRadius = `${ra + (rb - ra) * p.travel}px`;
        // The outline leaves by being wiped away left to right, never by
        // fading: a lime stroke at partial alpha composites to olive (the
        // accent rule). The inset overshoots by the glow's reach so the glow
        // goes with the line.
        const wiped = (1 - p.stroke) * 100;
        trace.style.clipPath = `inset(-24px -24px -24px calc(${wiped}% - 24px))`;
        trace.style.visibility = 'visible';
        leaving.style.opacity = String(leavingRest * (1 - p.out));
        arriving.style.opacity = String(arrivingRest * p.in);
      }

      if (t < 1) raf = requestAnimationFrame(frame);
      else onDone();
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      incoming.style.clipPath = '';
      if (leaving) leaving.style.opacity = '';
      if (arriving) arriving.style.opacity = '';
    };
  }, [dir, plannerRef, zenRef, onDone]);

  return (
    <>
      <div
        ref={frostRef}
        aria-hidden="true"
        className="zen-transition-frost pointer-events-none fixed inset-0 z-[36]"
      />
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-[37] h-full w-full"
      />
      <div
        ref={traceRef}
        aria-hidden="true"
        className="zen-trace pointer-events-none invisible fixed left-0 top-0 z-[38]"
      />
    </>
  );
}

function padRect(r: Rect, pad: number): Rect {
  return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
}
