'use client';

import { useLayoutEffect, useState } from 'react';
import { ChevronsLeftRight, ChevronsRightLeft } from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import { useViewStore } from '@/lib/view-store';
import {
  MAX_WEEK_DAYS,
  WEEK_GEOMETRY,
  clampWeekDays,
  isScalableLayout,
  resolveWeekDays,
  visibleDays,
  weekRungIndex,
  weekRungs,
  type ScalableLayout,
} from '@/lib/week-columns';
import { cn } from '@/lib/utils';

/**
 * The week scale — how wide a day column is, as a notched slider.
 *
 * Lives on the canvas header row beside the header capsule rather than inside
 * it: the capsule's pill answers "what am I looking at" (layout · scope)
 * and is already at its horizontal budget, while this answers "how big", which
 * is a different question and one that only exists in two of the six views.
 * Sitting at the far end of the same `canvas-container` row puts it on the
 * right edge of the grid it scales, at every window width and in both the
 * capped and full-width canvases.
 *
 * ── What the control says, and what it stores ──
 * It READS OUT A COLUMN WIDTH, and it stores a day count.
 *
 * The readout was the day count for this control's first release, on the
 * argument that the width is what the setting resolves to rather than what it
 * means. The argument had a hole: "5 days" is a claim about the canvas that the
 * view breaks whenever the stop is clamped, and it broke it often — the number
 * said five while six and a half columns were on screen, or while four were and
 * the grid scrolled. A width makes no claim it can fail; it is measurable off the
 * screen at any moment. Days moved to the hover explanation, where the
 * qualification ("about 5 of 7 fit, and the grid scrolls") can travel with them.
 *
 * The stored preference stays a day count, because a stored WIDTH stops meaning
 * the same thing the moment the canvas resizes: open the item panel and a stored
 * 260px is four and a half columns, where "five days" is still five. So the
 * control displays one and remembers the other, which is also why the readout can
 * change without anyone touching it.
 *
 * ── Why the ladder is measured, not fixed ──
 * The slider's value is an index into the RUNG ladder — one rung per distinct
 * column width available on this canvas, which is a subset of WEEK_DAY_STOPS
 * (see weekRungs). Stops that resolve to the same width are one position, so
 * every notch is a visible change. Before that, Week × Buckets on a 13" canvas
 * offered four notches that all rendered identically.
 *
 * Mounted unconditionally and self-hiding, so the header row's layout doesn't
 * have to know about it.
 */

/** Half the slider thumb (`size-3.5`). The thumb's travel is inset by this much
 *  at each end, so a tick rail that spans the full track drifts out of
 *  registration with it — the rail is inset to match. */
const THUMB_HALF_PX = 7;

/** The step buttons, sized off the capsule's ghost icon buttons. */
const STEP_BUTTON =
  'inline-flex h-7 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-25';

function daysLabel(days: number) {
  return days === 1 ? '1 day' : `${days} days`;
}

export function WeekScale({ className }: { className?: string }) {
  const scope = useViewStore((s) => s.scope);
  const layout = useViewStore((s) => s.layout);
  const days = useViewStore((s) => s.weekDaysVisible);
  const setWeekDaysVisible = useViewStore((s) => s.setWeekDaysVisible);

  const visible = scope === 'week' && isScalableLayout(layout);

  // The readout needs the same scrollport width the views derive from, and this
  // control lives outside their <ScrollArea> — so it finds the viewport by role
  // rather than by ref. Measuring <main> instead would be wrong by the panel's
  // own chrome. Null until a week view has mounted one, which is also every
  // case where there is nothing to report.
  const [viewportPx, setViewportPx] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!visible) return;
    // Re-queried on every scope/layout change because the week views mount a
    // fresh <ScrollArea> each time. A stale width is never cleared on the way
    // out — the control is unmounted then anyway, and re-measuring on the way
    // back in is one layout pass.
    const viewport = document.querySelector<HTMLElement>(
      '[data-tour="timeline"] [data-slot="scroll-area-viewport"]'
    );
    if (!viewport) return;
    const measure = () => {
      const w = viewport.clientWidth;
      if (w > 0) setViewportPx((prev) => (prev === w ? prev : w));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(viewport);
    return () => ro.disconnect();
  }, [visible, layout]);

  if (!visible) return null;

  const scalable = layout as ScalableLayout;
  const geo = WEEK_GEOMETRY[scalable];
  const ready = viewportPx !== null;
  // Until a week view has measured, fall back to the ladder's narrow end rather
  // than guessing a default that the very next frame would contradict.
  const current =
    viewportPx === null ? clampWeekDays(days) : resolveWeekDays(days, viewportPx, geo);
  const rungs = viewportPx === null ? null : weekRungs(viewportPx, geo);
  const index = viewportPx === null ? 0 : weekRungIndex(current, viewportPx, geo);
  const stop = rungs?.[index];
  /** Widest rung. Zero when the canvas holds exactly one width — everything
   *  clamped to the floor, which happens on a laptop with the sidebar and the
   *  item panel both open. There is nothing to choose then, and the control goes
   *  inert rather than offering travel that does nothing. */
  const lastIndex = rungs ? rungs.length - 1 : 0;

  const setIndex = (next: number) => {
    if (!rungs) return;
    setWeekDaysVisible(rungs[Math.min(lastIndex, Math.max(0, next))].days);
  };

  // The COLUMN WIDTH — see the header. Before the first measurement there is no
  // width to report, and the em dash is the same "nothing yet" the control's
  // disabled state already says.
  const readout = stop ? `${stop.colPx}px` : '—';

  const explain =
    stop && viewportPx !== null
      ? stop.fits
        ? `${stop.colPx}px per column — ${daysLabel(stop.days)} across the canvas`
        : `${stop.colPx}px is as narrow as a column goes — about ${Math.floor(
            visibleDays(stop.colPx, viewportPx, geo)
          )} of ${MAX_WEEK_DAYS} days fit, and the grid scrolls`
      : undefined;

  return (
    <div
      data-testid="week-scale"
      data-days={current}
      data-col-px={stop?.colPx ?? ''}
      // Whether the stop in force actually fits, or renders at the floor and
      // scrolls. The derived default never picks a non-fitting stop, so this is
      // 'false' only on a stop the user chose — which is what makes it worth
      // asserting on.
      data-fits={stop ? String(stop.fits) : ''}
      // Inert for the sub-frame before the first measurement. Until then the
      // resolved day count is a fallback rather than the derived default, so a
      // step taken in that window would move from the wrong rung — and land
      // somewhere the user did not ask for. Nobody can act inside one frame;
      // this exists so nothing else has to reason about the null case.
      data-measured={viewportPx === null ? 'false' : 'true'}
      className={cn(
        // Same family as the header capsule: gray tray, elevated bar shadow,
        // r10 — one row instead of two, because it carries one control.
        'inline-flex flex-shrink-0 items-center gap-0.5 rounded-[10px] bg-surface-3 px-2 py-1.5 shadow-[var(--shadow-elev-bar)]',
        className
      )}
    >
      <button
        type="button"
        onClick={() => setIndex(index - 1)}
        disabled={!ready || index <= 0}
        aria-label="Narrower day columns"
        title="Narrower columns (⌘−)"
        className={STEP_BUTTON}
      >
        <ChevronsRightLeft className="h-3.5 w-3.5" />
      </button>

      {/* The slider is centred in the row, and the ticks live INSIDE its own
          14px band rather than in a rail below it — a rail underneath is what
          used to push the whole control off-centre. The notches sit just under
          the track, still within the thumb's height, so they cost no layout. */}
      <div className="relative flex h-7 w-[116px] items-center">
        <Slider
          min={0}
          // Never 0: Radix divides by (max − min) to place the thumb, so a
          // one-rung canvas would put NaN in the transform. The control is
          // disabled in that case anyway — this keeps it from drawing wrong.
          max={Math.max(1, lastIndex)}
          step={1}
          value={[index]}
          onValueChange={([v]) => setIndex(v)}
          disabled={!ready || lastIndex === 0}
          aria-label="Day column width"
          aria-valuetext={explain ?? readout}
          className={cn(
            // Above the ticks, so the thumb covers the notch it is parked on —
            // which is what reads as the knob sitting IN a detent rather than
            // beside one.
            'relative z-10 w-full',
            // Finer than the shadcn default: this is view chrome sitting next to
            // hairline borders, and a 6px track with a 16px knob read as a form
            // field parked on the canvas.
            '[&_[data-slot=slider-track]]:h-1',
            '[&_[data-slot=slider-thumb]]:size-3.5 [&_[data-slot=slider-thumb]]:shadow-[var(--shadow-elev-sm)]'
          )}
        />
        {/* A sibling of the Slider, not a child of its Track — the Track is
            `overflow-hidden` (it has to clip the Range), so anything inside is
            cut off at the ends. Inset by half a thumb because the thumb's travel
            is inset by that much at each end; spanning the full track instead
            puts every tick out of registration with the thumb it is supposed to
            mark, by up to 7px at the ends. */}
        <div
          aria-hidden
          className="pointer-events-none absolute top-1/2 mt-[3px] h-[3px]"
          style={{ left: THUMB_HALF_PX, right: THUMB_HALF_PX }}
        >
          {/* One notch per RUNG, so the count changes with the canvas — which is
              the point: every notch drawn is a width you can actually get, and
              the thumb lands on one. A fixed six drawn against a five-rung ladder
              would put the knob between marks.

              Uniform weight, deliberately. Fading the notch whose stop has to
              scroll was tried and dropped: it is always the leftmost, which is
              the end the lime range fill covers whenever the thumb is parked
              right of it, and a 1px mark's contrast against that fill swamps a
              0.15-vs-0.35 opacity step. An invisible signal is worse than none;
              `data-fits` and the hover explanation carry it instead. */}
          {(rungs ?? []).map((rung, i) => (
            <span
              key={rung.days}
              style={{ left: lastIndex === 0 ? '0%' : `${(i / lastIndex) * 100}%` }}
              className="absolute top-0 h-[3px] w-px -translate-x-1/2 rounded-full bg-muted-foreground/35"
            />
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={() => setIndex(index + 1)}
        disabled={!ready || index >= lastIndex}
        aria-label="Wider day columns"
        title="Wider columns (⌘+)"
        className={STEP_BUTTON}
      >
        <ChevronsLeftRight className="h-3.5 w-3.5" />
      </button>

      {/* Fixed width, and never wrapping. The control is right-aligned in the
          header row, so a readout that resized with its value would walk the
          whole capsule left and right as you drag. */}
      <span
        title={explain}
        className="ml-1 w-[46px] shrink-0 whitespace-nowrap text-right font-num text-2xs tabular-nums text-muted-foreground"
      >
        {readout}
      </span>
    </div>
  );
}
