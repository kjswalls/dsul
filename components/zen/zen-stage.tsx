'use client';

import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ZenSurface } from '@/components/zen/zen-room';
import { buildSprite, isDarkContext } from '@/components/primitives/relay-field';
import { RELAY_LIGHT_PALETTES } from '@/lib/relay-palettes';
import { useViewStore } from '@/lib/view-store';
import {
  ZEN_BAND_FRAC,
  ZEN_WAVE_MS,
  farthestCorner,
  flightAt,
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
 * the seam. The item Zen puts in its hero lifts off the grid and flies to its
 * place (or back to its slot on the way out).
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
  const finish = useCallback(() => setSettled(useViewStore.getState().zenOpen), []);

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
  return r.w > 0 && r.h > 0 && r.x + r.w > 0 && r.y + r.h > 0 && r.x < innerWidth && r.y < innerHeight;
}

/**
 * The hero's own title somewhere in the planner: the smallest element under a
 * visible `[data-item-id]` whose whole text is the title. The same item can
 * render more than once (a grid block and a bucket row), so the first one
 * actually on screen wins; none at all means the ring runs without a flight.
 */
function findSourceTitle(planner: HTMLElement, id: string, title: string): HTMLElement | null {
  for (const host of planner.querySelectorAll<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`)) {
    if (!onScreen(rectOf(host))) continue;
    let best: HTMLElement | null = null;
    for (const el of host.querySelectorAll<HTMLElement>('*')) {
      if (el.textContent?.trim() !== title || el.children.length > 0) continue;
      best = el;
      break;
    }
    if (best && onScreen(rectOf(best))) return best;
  }
  return null;
}

/** Dark reads the live lime tokens (additive on navy); light takes Meadow, the
 *  lime → teal arc — lime alone deepens toward olive on paper. */
function tileColors(dark: boolean): string[] {
  if (!dark) return RELAY_LIGHT_PALETTES.meadow.colors;
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const primary = read('--primary', 'oklch(0.87 0.19 125)');
  return [primary, primary, primary, read('--accent-8', 'oklch(0.76 0.13 125)'), read('--accent-2', 'oklch(0.66 0.09 190)')];
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
  const flyerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const flyer = flyerRef.current;
    const planner = plannerRef.current;
    const zen = zenRef.current;
    const incoming = dir === 'enter' ? zen : planner;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !flyer || !planner || !zen || !incoming || !ctx) {
      onDone();
      return;
    }

    const W = innerWidth;
    const H = innerHeight;

    // ── the flight: the hero title and where it lives in the planner ──
    const hero = zen.querySelector<HTMLElement>('[data-zen-hero]');
    const title = hero?.textContent?.trim() ?? '';
    const source = hero && title ? findSourceTitle(planner, hero.dataset.zenHero ?? '', title) : null;
    const flying = hero && source ? { hero, source } : null;
    let clone: HTMLElement | null = null;
    let scaleAtSource = 1;
    if (flying) {
      const heroRect = rectOf(flying.hero);
      clone = flying.hero.cloneNode(true) as HTMLElement;
      clone.removeAttribute('data-zen-hero');
      clone.removeAttribute('id');
      clone.style.margin = '0';
      clone.style.width = `${heroRect.w}px`;
      flyer.appendChild(clone);
      scaleAtSource =
        parseFloat(getComputedStyle(flying.source).fontSize) /
          parseFloat(getComputedStyle(flying.hero).fontSize) || 0.35;
      flying.hero.style.visibility = 'hidden';
      flying.source.style.visibility = 'hidden';
    }

    // ── the focal: where the thing you're looking at starts ──
    const origin =
      (dir === 'enter' ? flying?.source : flying?.hero) ??
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

    let raf = 0;
    const start = performance.now();
    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / ZEN_WAVE_MS);
      const front = waveFront(t, reach, band);
      incoming.style.clipPath = `circle(${revealRadius(front, band)}px at ${fx}px ${fy}px)`;

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

      if (flying) {
        // Measured live every frame: the incoming planner can still be settling
        // (the grid fits its hour height after mount), and a target read once
        // would land the item beside its slot.
        const h = rectOf(flying.hero);
        const s = rectOf(flying.source);
        const [a, b, sa, sb] =
          dir === 'enter' ? [s, h, scaleAtSource, 1] : [h, s, 1, scaleAtSource];
        const { lift, travel } = flightAt(t);
        const x = a.x + (b.x - a.x) * travel;
        const y = a.y + (b.y - a.y) * travel - lift * 6;
        const scale = (sa + (sb - sa) * travel) * (1 + 0.05 * lift);
        flyer.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
      }

      if (t < 1) raf = requestAnimationFrame(frame);
      else onDone();
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      incoming.style.clipPath = '';
      if (flying) {
        flying.hero.style.visibility = '';
        flying.source.style.visibility = '';
      }
      clone?.remove();
    };
  }, [dir, plannerRef, zenRef, onDone]);

  return (
    <>
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-[36] h-full w-full"
      />
      <div
        ref={flyerRef}
        aria-hidden="true"
        className="pointer-events-none fixed left-0 top-0 z-[37] origin-top-left text-foreground"
      />
    </>
  );
}
