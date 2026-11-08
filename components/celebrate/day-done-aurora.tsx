'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { buildSprite, isDarkContext } from '@/components/primitives/relay-field';
import {
  claimDayDone,
  DAY_DONE_HINT,
  DAY_DONE_HINT_TOUCH,
  dayDoneCountLine,
  pickDayDoneHeadline,
  readTodayDone,
} from '@/lib/day-done-moment';
import { subscribeModEvents } from '@/lib/mod-events';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';

/**
 * The day done aurora (Kirby's pick D, 2026-11-07; mocks in
 * /mnt/project-files/day-done/): when the person ticks the last open thing on
 * today, a lime to teal band of relay tiles rises up the whole screen behind a
 * frosted pane, with one line of copy on top. About five seconds, then it
 * closes by itself; any click, tap or key closes it sooner.
 *
 * Rules it keeps:
 * - The trigger is the day done sound's (components/providers/sound-cues.tsx):
 *   a tick of the person's own on today (the mod event bus raises only those)
 *   after which lib/day-done.ts calls today cleared. Same moment, same check
 *   as the Lime tab icon, starting on the sound's beat.
 * - Once a day on this device (claimDayDone): untick and tick again, or
 *   reload, and only the header's "perfect" chip comes back.
 * - It never takes focus and never moves the planner. A key that closes it is
 *   swallowed, so it cannot also fire a shortcut underneath.
 * - Reduced motion (the OS, or Animations off in Look): no rising band. The
 *   field fades in lit and still, the line shows, and it fades away.
 * - The lime never dims through a parent: the canvas draws its own brightness,
 *   and the copy is revealed with a clip, never an opacity.
 * - Off with Settings, Look, "Celebrate a finished day" (view-store, device-local).
 */

const DELAY_MS = 280; // the sound's own delay after the tick, so the two land together
const DURATION = 4.8; // seconds, start to gone
const OUT = 0.75; // the frost and copy start leaving this long before the end

/** Lime into mint into teal: the crest on the Aurora app icon. */
const AURORA_DARK_TAIL = ['oklch(0.84 0.16 140)', 'oklch(0.8 0.13 165)', 'oklch(0.74 0.11 190)'];
const AURORA_LIGHT = [
  'oklch(0.8 0.2 128)',
  'oklch(0.8 0.2 128)',
  'oklch(0.74 0.16 145)',
  'oklch(0.68 0.12 170)',
  'oklch(0.62 0.1 195)',
];

interface Showing {
  headline: string;
  count: number;
  reduced: boolean;
}

export function DayDoneAurora() {
  const on = useViewStore((s) => s.celebrateDayDone);
  const [showing, setShowing] = useState<Showing | null>(null);

  useEffect(() => {
    if (!on) return;
    let timer: number | undefined;
    const off = subscribeModEvents((e) => {
      if (e.kind !== 'item.completed') return;
      // Re-checked against live state: an undo can land between the tick and
      // this dispatch (lib/mod-events.ts).
      const { today, count } = readTodayDone();
      if (e.date !== today || count === null) return;
      if (!claimDayDone(today)) return;
      const reduced =
        !usePlannerStore.getState().animationsEnabled ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setShowing({ headline: pickDayDoneHeadline(), count, reduced }), DELAY_MS);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, [on]);

  if (!showing) return null;
  return <AuroraOverlay {...showing} onGone={() => setShowing(null)} />;
}

const gauss = (x: number) => Math.exp(-x * x);
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function AuroraOverlay({ headline, count, reduced, onGone }: Showing & { onGone: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const startRef = useRef(0);
  // The parent hands a fresh callback each render; the animation must not restart for it.
  const goneRef = useRef(onGone);
  useEffect(() => {
    goneRef.current = onGone;
  });
  const [phase, setPhase] = useState<'start' | 'in' | 'out'>('start');
  const [copyIn, setCopyIn] = useState(false);
  const [touch] = useState(() => window.matchMedia('(pointer: coarse)').matches);

  // Close sooner: jump the clock to the last moments, so the band, the frost
  // and the copy all leave together on their own fade.
  const dismiss = useCallback(() => {
    const now = performance.now();
    const t = (now - startRef.current) / 1000;
    const jumpTo = DURATION - 0.45;
    if (t < jumpTo) startRef.current = now - jumpTo * 1000;
    setPhase('out');
    // The frame loop ends it on its own; this is the backstop for a page whose
    // canvas never drew (no 2D context), so nothing is ever left over the planner.
    window.setTimeout(() => goneRef.current(), 600);
  }, []);

  // The same backstop for the whole run.
  useEffect(() => {
    const timer = window.setTimeout(() => goneRef.current(), (DURATION + 0.5) * 1000);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const dark = isDarkContext(canvas);
    const lime = getComputedStyle(canvas).getPropertyValue('--primary').trim() || 'oklch(0.87 0.19 125)';
    const palette = dark ? [lime, lime, ...AURORA_DARK_TAIL] : AURORA_LIGHT;
    const sprites = palette.map((c) => buildSprite(c, dark));
    const pitch = Math.max(30, w / 36);
    const cols = Math.ceil(w / pitch) + 1;
    const rows = Math.ceil(h / pitch) + 1;
    const offX = (w - (cols - 1) * pitch) / 2;
    const offY = (h - (rows - 1) * pitch) / 2;
    const cells: { x: number; y: number; ci: number; j: number; max: number }[] = [];
    for (let r = 0, k = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++, k++) {
        const hsh = (s: number) => {
          const v = 43758.5453 * Math.sin((k + 1) * 12.9898 + 78.233 * s);
          return v - Math.floor(v);
        };
        cells.push({ x: offX + c * pitch, y: offY + r * pitch, ci: Math.floor(hsh(1) * palette.length), j: hsh(2), max: 0.7 + 0.3 * hsh(3) });
      }
    }
    // Seen through the frost, the tiles need about twice the strength to read.
    const gain = (dark ? 1 : 1.15) * 1.9;
    const base = pitch * (dark ? 1.7 : 1.05);

    const level = (cx: number, cy: number, j: number, t: number): [number, number] => {
      if (reduced) {
        const crest = h * 0.55 + Math.sin(cx * 0.008) * h * 0.06;
        const y = (cy - crest) / (h * 0.12);
        return [y < 0 ? 0.9 * gauss(y) : 0.9 * Math.exp(-y * 0.9) * 0.6 + 0.05, 1];
      }
      const crest = h * 1.1 - smooth(0, 3.2, t) * h * 1.25 + Math.sin(cx * 0.008 + t * 1.3) * h * 0.07;
      const y = (cy - crest) / (h * 0.11);
      const band = y < 0 ? gauss(y) : Math.exp(-y * 0.8) * 0.55;
      return [band * (0.85 + 0.15 * Math.sin(t * 3 + j * 6)), 1 + 0.25 * gauss(y)];
    };

    let raf = 0;
    let leaving = false;
    startRef.current = performance.now();
    const frame = (now: number) => {
      const t = (now - startRef.current) / 1000;
      const env = Math.min(1, t / (reduced ? 0.35 : 0.25)) * (1 - smooth(DURATION - 0.9, DURATION, t));
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
      for (const c of cells) {
        const [a, scale] = level(c.x, c.y, c.j, t);
        const alpha = Math.min(1, env * gain * a * c.max);
        if (alpha < 0.012) continue;
        ctx.globalAlpha = alpha;
        const s = base * scale;
        ctx.drawImage(sprites[c.ci], c.x - s / 2, c.y - s / 2, s, s);
      }
      ctx.globalAlpha = 1;
      if (!leaving && t > DURATION - OUT) {
        leaving = true;
        setPhase('out');
      }
      if (t >= DURATION) {
        goneRef.current();
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    // The frost and copy come in on the next frame, so their transitions run.
    const inRaf = requestAnimationFrame(() => setPhase((p) => (p === 'start' ? 'in' : p)));
    const copyTimer = window.setTimeout(() => setCopyIn(true), reduced ? 200 : 650);
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(inRaf);
      window.clearTimeout(copyTimer);
    };
  }, [reduced]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
      e.stopPropagation();
      // Browser keys with a modifier (reload, close tab) still work.
      if (!e.metaKey && !e.ctrlKey) e.preventDefault();
      dismiss();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dismiss]);

  return (
    <div
      data-day-done=""
      data-phase={phase}
      data-copy={copyIn && phase !== 'out' ? 'in' : undefined}
      onPointerDown={(e) => {
        e.preventDefault();
        dismiss();
      }}
    >
      <canvas ref={canvasRef} aria-hidden="true" />
      <div data-day-done-frost="" aria-hidden="true" />
      <div data-day-done-copy="" role="status" aria-live="polite">
        <p data-day-done-headline="">{headline}</p>
        <p data-day-done-count="">
          <i aria-hidden="true" />
          {dayDoneCountLine(count)}
        </p>
      </div>
      <p data-day-done-hint="" aria-hidden="true">
        {touch ? DAY_DONE_HINT_TOUCH : DAY_DONE_HINT}
      </p>
    </div>
  );
}
