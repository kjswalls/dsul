import { describe, expect, it } from 'vitest';
import { HOVER_Z, LANE_CAP_Z, NOW_MARKER_Z, WEEK_GUTTER_Z, WEEK_HEAD_Z } from '@/lib/schedule-constants';
import {
  CANVAS_PAD_PX,
  MAX_COL_PX,
  MAX_WEEK_DAYS,
  MIN_WEEK_DAYS,
  TARGET_COL_PX,
  TARGET_TOLERANCE_PX,
  WEEK_DAY_STOPS,
  WEEK_GEOMETRY,
  clampWeekDays,
  defaultWeekDays,
  forgetWeekCanvas,
  isScalableLayout,
  noteWeekCanvas,
  resolveWeekDays,
  resolveWeekDaysFromLastCanvas,
  stepWeekDays,
  stepWeekDaysFromLastCanvas,
  stepWeekRung,
  visibleDays,
  weekColumnPx,
  weekRungIndex,
  weekRungs,
  weekStops,
} from '@/lib/week-columns';

/**
 * The whole point of pulling this out of the views is that the arithmetic is
 * testable without a DOM. CI gates on `pnpm test:unit` and runs e2e with
 * continue-on-error, so every invariant that matters lives here.
 *
 * The viewport widths below are real, measured against the desktop shell:
 * a 1280px window leaves an 836px scrollport (the Playwright default), a 1440px
 * window leaves 996px, and a 1920px window leaves 1476px.
 */

const SCHEDULE = WEEK_GEOMETRY.schedule;
const BUCKETS = WEEK_GEOMETRY.buckets;

const VP_1280 = 836;
const VP_1440 = 996;
const VP_1920 = 1476;

describe('clampWeekDays', () => {
  it('keeps every value on the ladder', () => {
    for (const days of WEEK_DAY_STOPS) expect(clampWeekDays(days)).toBe(days);
  });

  it('falls back to the default for anything that is not a number', () => {
    for (const junk of [undefined, null, NaN, Infinity, '5', {}, []]) {
      expect(clampWeekDays(junk)).toBe(MAX_WEEK_DAYS);
    }
  });

  it('clamps out-of-range values rather than rejecting them', () => {
    expect(clampWeekDays(0)).toBe(MIN_WEEK_DAYS);
    expect(clampWeekDays(1)).toBe(MIN_WEEK_DAYS);
    expect(clampWeekDays(-4)).toBe(MIN_WEEK_DAYS);
    expect(clampWeekDays(8)).toBe(MAX_WEEK_DAYS);
    expect(clampWeekDays(1000)).toBe(MAX_WEEK_DAYS);
  });

  it('is idempotent', () => {
    for (const v of [-1, 0, 2.4, 4, 6.6, 9]) {
      expect(clampWeekDays(clampWeekDays(v))).toBe(clampWeekDays(v));
    }
  });
});

describe('stepWeekDays', () => {
  it('treats +1 as one step WIDER, which is one day fewer', () => {
    expect(stepWeekDays(7, 1)).toBe(6);
    expect(stepWeekDays(3, 1)).toBe(2);
  });

  it('treats -1 as one step narrower', () => {
    expect(stepWeekDays(2, -1)).toBe(3);
    expect(stepWeekDays(6, -1)).toBe(7);
  });

  it('saturates at both ends instead of wrapping', () => {
    expect(stepWeekDays(MIN_WEEK_DAYS, 1)).toBe(MIN_WEEK_DAYS);
    expect(stepWeekDays(MAX_WEEK_DAYS, -1)).toBe(MAX_WEEK_DAYS);
    // Holding the key down is a stream of steps, not one big one.
    expect(stepWeekDays(7, 99)).toBe(MIN_WEEK_DAYS);
    expect(stepWeekDays(2, -99)).toBe(MAX_WEEK_DAYS);
  });

  it('sanitises a garbage current value the same way clamp does', () => {
    expect(stepWeekDays(undefined, 1)).toBe(MAX_WEEK_DAYS - 1);
  });
});

describe('weekColumnPx', () => {
  it('solves for the width that fits exactly N columns beside the gutter', () => {
    // Seven columns on a 1920px window: 1476 − 64 padding − 68 gutter − 7×8 gap
    // = 1288, over seven columns = 184.
    expect(weekColumnPx(7, VP_1920, SCHEDULE)).toBe(184);
    expect(weekColumnPx(5, VP_1920, SCHEDULE)).toBe(260);
    expect(weekColumnPx(4, VP_1920, SCHEDULE)).toBe(328);
  });

  it('lands on the floor at seven days on the canvases that used to cap out', () => {
    // This is the contract that makes the change invisible until you move the
    // control: at the default, both of these render exactly what the view
    // rendered when its columns were a hardcoded 140px min-width.
    expect(weekColumnPx(MAX_WEEK_DAYS, VP_1280, SCHEDULE)).toBe(SCHEDULE.minColPx);
    expect(weekColumnPx(MAX_WEEK_DAYS, VP_1440, SCHEDULE)).toBe(SCHEDULE.minColPx);
  });

  it('never returns less than the layout floor', () => {
    for (const vp of [200, 400, VP_1280, VP_1440, VP_1920, 3000]) {
      for (const days of WEEK_DAY_STOPS) {
        expect(weekColumnPx(days, vp, SCHEDULE)).toBeGreaterThanOrEqual(SCHEDULE.minColPx);
        expect(weekColumnPx(days, vp, BUCKETS)).toBeGreaterThanOrEqual(BUCKETS.minColPx);
      }
    }
  });

  it('never returns more than MAX_COL_PX, however wide the canvas', () => {
    expect(weekColumnPx(2, 5000, SCHEDULE)).toBe(MAX_COL_PX);
    expect(weekColumnPx(2, 5000, BUCKETS)).toBe(MAX_COL_PX);
  });

  it('is monotonic: fewer days is never a narrower column', () => {
    for (const vp of [VP_1280, VP_1440, VP_1920, 2400]) {
      const widths = WEEK_DAY_STOPS.map((d) => weekColumnPx(d, vp, SCHEDULE));
      for (let i = 1; i < widths.length; i++) {
        expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1]);
      }
    }
  });

  it('floors rather than rounds, so a fitting stop never overflows by a pixel', () => {
    // overflowX is hard-set to `scroll` on the Radix viewport, so a 1px overflow
    // does not clip — it leaves the grid permanently nudgeable, which reads as a
    // bug on a stop whose promise is "this fits".
    for (const vp of [VP_1280, 900, 997, VP_1440, 1101, VP_1920, 1477]) {
      for (const days of WEEK_DAY_STOPS) {
        const colPx = weekColumnPx(days, vp, SCHEDULE);
        if (colPx === SCHEDULE.minColPx || colPx === MAX_COL_PX) continue; // clamped, expected to overflow
        const used = 2 * CANVAS_PAD_PX + SCHEDULE.gutterPx + days * SCHEDULE.gapPx + days * colPx;
        expect(used).toBeLessThanOrEqual(vp);
      }
    }
  });

  it('sanitises the day count before using it', () => {
    expect(weekColumnPx(undefined, VP_1920, SCHEDULE)).toBe(weekColumnPx(7, VP_1920, SCHEDULE));
    expect(weekColumnPx(99, VP_1920, SCHEDULE)).toBe(weekColumnPx(MAX_WEEK_DAYS, VP_1920, SCHEDULE));
  });
});

describe('week-buckets geometry', () => {
  it('pays for one gap fewer than schedule, having no gutter child to space off', () => {
    // The bug this replaced: buckets charged N gaps for its N columns, discarding
    // 28px of canvas and making every stop ~4px narrower than it had to be. A row
    // of N boxes has N − 1 gaps; schedule's gutter is the extra box that makes its
    // count N.
    //
    // Stated as the invariant rather than as a number: at a stop that fits, the
    // columns and their gaps consume the canvas to within a pixel per column —
    // which is the flooring, and nothing else.
    for (const vp of [VP_1280, VP_1440, 1256, VP_1920, 2400]) {
      for (const days of WEEK_DAY_STOPS) {
        const colPx = weekColumnPx(days, vp, BUCKETS);
        if (colPx === BUCKETS.minColPx || colPx === MAX_COL_PX) continue; // clamped
        const used = 2 * CANVAS_PAD_PX + (days - 1) * BUCKETS.gapPx + days * colPx;
        expect(used).toBeLessThanOrEqual(vp);
        expect(vp - used).toBeLessThan(days);
      }
    }
  });

  it('keeps the derived default at the old fixed w-60 or wider', () => {
    // The floor came down from 240 (the view's old `w-60`) to 200 so the ladder
    // would separate — see WEEK_GEOMETRY. The compensating promise is that 200 is
    // somewhere you can only GO: on every canvas from a 13" laptop up, the
    // default is at least as wide as the column that shipped.
    for (const vp of [VP_1280, VP_1440, 1256, 1700, VP_1920, 2400]) {
      const colPx = weekColumnPx(defaultWeekDays(vp, BUCKETS), vp, BUCKETS);
      expect(colPx).toBeGreaterThanOrEqual(238);
    }
  });

  it('separates the stops a 240px floor used to collapse', () => {
    // The reported bug, as arithmetic. At 240 a 1440px window resolved seven,
    // six, five AND four days to exactly 240 — two thirds of the slider's travel
    // changed nothing. Every stop that fits is now a distinct width.
    const widths = WEEK_DAY_STOPS.map((d) => weekColumnPx(d, VP_1440, BUCKETS));
    const distinct = new Set(widths.filter((w) => w !== BUCKETS.minColPx));
    expect(distinct.size).toBe(widths.filter((w) => w !== BUCKETS.minColPx).length);
    // …and the stops that don't fit are honestly reported as not fitting rather
    // than silently rendering as their neighbour.
    expect(weekStops(VP_1440, BUCKETS).filter((s) => s.fits).length).toBeGreaterThanOrEqual(3);
  });

  it('widens on the stops that clear the floor', () => {
    expect(weekColumnPx(4, VP_1920, BUCKETS)).toBe(332);
    expect(weekColumnPx(3, VP_1920, BUCKETS)).toBe(452);
  });
});

describe('weekRungs', () => {
  it('is one rung per distinct width, narrowest first', () => {
    for (const vp of [VP_1280, VP_1440, 1256, VP_1920, 2400]) {
      for (const geo of [SCHEDULE, BUCKETS]) {
        const widths = weekRungs(vp, geo).map((r) => r.colPx);
        expect(new Set(widths).size).toBe(widths.length);
        for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThan(widths[i - 1]);
      }
    }
  });

  it('is the whole ladder when every stop resolves to its own width', () => {
    // Schedule on a 1700px window: 152/179/216/273/366/480, all distinct.
    expect(weekRungs(1256, SCHEDULE).map((r) => r.days)).toEqual([...WEEK_DAY_STOPS]);
  });

  it('collapses the stops that share a width, keeping the most days', () => {
    // Buckets on a 1440px window: seven, six and five days all clamp to the 200px
    // floor and render identically, so they are ONE position on the control — the
    // one labelled seven, because at the floor "as many days as fit" is the honest
    // promise. This is the dead-notch bug, stated as arithmetic.
    expect(weekStops(VP_1440, BUCKETS).map((s) => s.colPx)).toEqual([200, 200, 200, 212, 292, 452]);
    expect(weekRungs(VP_1440, BUCKETS).map((r) => r.days)).toEqual([7, 4, 3, 2]);
  });

  it('never offers a rung the canvas cannot render, and always offers at least one', () => {
    for (const vp of [200, 300, 700, VP_1280, 1256, VP_1920, 3200]) {
      for (const geo of [SCHEDULE, BUCKETS]) {
        const rungs = weekRungs(vp, geo);
        expect(rungs.length).toBeGreaterThanOrEqual(1);
        expect(rungs.length).toBeLessThanOrEqual(WEEK_DAY_STOPS.length);
        // At most one rung is a non-fitting one — the floor — and if there is one
        // it is the narrowest.
        const notFitting = rungs.filter((r) => !r.fits);
        expect(notFitting.length).toBeLessThanOrEqual(1);
        if (notFitting.length === 1) expect(rungs[0].fits).toBe(false);
      }
    }
  });

  it('collapses to a single rung on a canvas that holds no width at all', () => {
    // Sidebar plus item panel on a small laptop: every stop is the floor, so the
    // control has one position and nothing to choose. The component reads this to
    // go inert rather than offering travel that does nothing.
    expect(weekRungs(300, SCHEDULE)).toHaveLength(1);
    expect(weekRungs(300, SCHEDULE)[0].colPx).toBe(SCHEDULE.minColPx);
  });
});

describe('weekRungIndex', () => {
  it('finds a stored day count by the width it resolves to, not by its label', () => {
    // Choose five days on a wide canvas, then shrink the window until five clamps
    // to the floor: the rung at that width is labelled SEVEN, and the thumb has to
    // land on it rather than nowhere.
    expect(weekColumnPx(5, VP_1440, BUCKETS)).toBe(BUCKETS.minColPx);
    expect(weekRungIndex(5, VP_1440, BUCKETS)).toBe(0);
    expect(weekRungs(VP_1440, BUCKETS)[0].days).toBe(7);
  });

  it('agrees with the ladder for a count that is its own rung', () => {
    for (const vp of [VP_1280, VP_1440, 1256, VP_1920]) {
      for (const geo of [SCHEDULE, BUCKETS]) {
        weekRungs(vp, geo).forEach((rung, i) => {
          expect(weekRungIndex(rung.days, vp, geo)).toBe(i);
        });
      }
    }
  });
});

describe('stepWeekRung', () => {
  it('changes the column width on every single step', () => {
    // The whole reason rungs exist. Walking the ladder end to end must never
    // produce the same width twice in a row, on any canvas or layout.
    for (const vp of [VP_1280, VP_1440, 1256, VP_1920, 2400]) {
      for (const geo of [SCHEDULE, BUCKETS]) {
        // Annotated, because MAX_WEEK_DAYS is the literal type 7 off a const array.
        let days: number = MAX_WEEK_DAYS;
        let last = weekColumnPx(days, vp, geo);
        for (let i = 0; i < WEEK_DAY_STOPS.length; i++) {
          const next = stepWeekRung(days, 1, vp, geo);
          const width = weekColumnPx(next, vp, geo);
          if (next === days) break; // saturated at the wide end
          expect(width).toBeGreaterThan(last);
          days = next;
          last = width;
        }
      }
    }
  });

  it('can move the stored count by more than one day, and never by nothing', () => {
    // Buckets at 996: the rungs are 7 → 4 → 3 → 2, so one step wider from the
    // floor skips two stops that would have rendered identically.
    expect(stepWeekRung(7, 1, VP_1440, BUCKETS)).toBe(4);
    expect(stepWeekRung(4, -1, VP_1440, BUCKETS)).toBe(7);
  });

  it('saturates at both ends instead of wrapping', () => {
    const rungs = weekRungs(VP_1440, BUCKETS);
    const narrowest = rungs[0].days;
    const widest = rungs[rungs.length - 1].days;
    expect(stepWeekRung(narrowest, -1, VP_1440, BUCKETS)).toBe(narrowest);
    expect(stepWeekRung(widest, 1, VP_1440, BUCKETS)).toBe(widest);
    // An oversized delta lands on the end rather than running off it — the same
    // contract stepWeekDays has. (Holding the shortcut down is a stream of ±1s.)
    expect(stepWeekRung(narrowest, 99, VP_1440, BUCKETS)).toBe(widest);
    expect(stepWeekRung(widest, -99, VP_1440, BUCKETS)).toBe(narrowest);
  });

  it('sanitises a garbage stored value the way clamp does', () => {
    expect(stepWeekRung(undefined, 0, 1256, SCHEDULE)).toBe(MAX_WEEK_DAYS);
    expect(stepWeekRung(999, 0, 1256, SCHEDULE)).toBe(MAX_WEEK_DAYS);
  });
});

describe('weekStops', () => {
  it('reports one entry per ladder position, in ladder order', () => {
    const stops = weekStops(VP_1920, SCHEDULE);
    expect(stops.map((s) => s.days)).toEqual([...WEEK_DAY_STOPS]);
  });

  it('marks a stop that had to be clamped as not fitting', () => {
    // 1440px window, seven days: the arithmetic wants 115px, the floor is 140.
    const stops = weekStops(VP_1440, SCHEDULE);
    const seven = stops.find((s) => s.days === 7)!;
    expect(seven.fits).toBe(false);
    expect(seven.colPx).toBe(SCHEDULE.minColPx);

    const four = stops.find((s) => s.days === 4)!;
    expect(four.fits).toBe(true);
  });

  it('marks every stop as fitting once the canvas is big enough', () => {
    expect(weekStops(VP_1920, SCHEDULE).every((s) => s.fits)).toBe(true);
  });

  it('agrees with weekColumnPx', () => {
    for (const stop of weekStops(VP_1440, BUCKETS)) {
      expect(stop.colPx).toBe(weekColumnPx(stop.days, VP_1440, BUCKETS));
    }
  });
});

describe('visibleDays', () => {
  it('returns the requested count when the stop actually fits', () => {
    const colPx = weekColumnPx(5, VP_1920, SCHEDULE);
    expect(visibleDays(colPx, VP_1920, SCHEDULE)).toBeGreaterThanOrEqual(5);
    expect(visibleDays(colPx, VP_1920, SCHEDULE)).toBeLessThan(6);
  });

  it('tells the truth when a stop was clamped', () => {
    // Seven days at 1440px is really about six.
    const colPx = weekColumnPx(7, VP_1440, SCHEDULE);
    const visible = visibleDays(colPx, VP_1440, SCHEDULE);
    expect(visible).toBeGreaterThan(5);
    expect(visible).toBeLessThan(7);
  });

  it('never goes negative on an absurdly small canvas', () => {
    expect(visibleDays(140, 40, SCHEDULE)).toBe(0);
  });
});

describe('the width-derived default', () => {
  /** The candidate set the default actually chooses from: the stops that fit. */
  const fittingStops = (vp: number, geo: typeof SCHEDULE) =>
    weekStops(vp, geo).filter((s) => s.fits);

  it('never picks a stop further than the tolerance from the best available', () => {
    for (const vp of [VP_1280, VP_1440, VP_1920, 2400]) {
      const deltas = fittingStops(vp, SCHEDULE).map((s) => Math.abs(s.colPx - TARGET_COL_PX));
      const chosenDelta = Math.abs(weekColumnPx(defaultWeekDays(vp, SCHEDULE), vp, SCHEDULE) - TARGET_COL_PX);
      expect(chosenDelta).toBeLessThanOrEqual(Math.min(...deltas) + TARGET_TOLERANCE_PX);
    }
  });

  it('prefers more days whenever two stops are within the tolerance of each other', () => {
    for (const vp of [VP_1280, VP_1440, VP_1920, 2400]) {
      const chosen = defaultWeekDays(vp, SCHEDULE);
      const fitting = fittingStops(vp, SCHEDULE);
      const best = Math.min(...fitting.map((s) => Math.abs(s.colPx - TARGET_COL_PX)));
      // Nothing with MORE days was also in contention — if it had been, it
      // should have won. Stops that don't fit are not in contention at all, which
      // is a separate invariant with its own test below.
      for (const stop of fitting) {
        if (stop.days <= chosen) continue;
        expect(Math.abs(stop.colPx - TARGET_COL_PX)).toBeGreaterThan(best + TARGET_TOLERANCE_PX);
      }
    }
  });

  it('keeps a small laptop on a real week instead of two days', () => {
    // The case the tolerance exists for. On an 836px scrollport three days is
    // 226px (61 under target) and two days is 344px (57 over) — nearest-wins
    // hands it to TWO columns by four pixels, which is not a week view.
    expect(weekColumnPx(3, VP_1280, SCHEDULE)).toBe(226);
    expect(weekColumnPx(2, VP_1280, SCHEDULE)).toBe(344);
    expect(defaultWeekDays(VP_1280, SCHEDULE)).toBe(3);
  });

  it('still lets a clear winner win — the tolerance is not a thumb on the scale', () => {
    // 1256px: four days is 14px off, five days is 71px off. Nowhere near a tie,
    // so the extra day does NOT get to claim it.
    const vp = 1256;
    expect(weekColumnPx(4, vp, SCHEDULE)).toBe(273);
    expect(weekColumnPx(5, vp, SCHEDULE)).toBe(216);
    expect(defaultWeekDays(vp, SCHEDULE)).toBe(4);
    // …and 1476px keeps five days at 260 over four at 328.
    expect(defaultWeekDays(VP_1920, SCHEDULE)).toBe(5);
  });

  it('opens a big monitor and a laptop at a comparable column, not a comparable day count', () => {
    // The point of a width-derived default: the same apparent density, whatever
    // the screen. The day counts differ; the column widths do not, much.
    const wide = defaultWeekDays(VP_1920, SCHEDULE);
    const narrow = defaultWeekDays(VP_1280, SCHEDULE);
    expect(wide).not.toBe(narrow);
    for (const [days, vp] of [
      [wide, VP_1920],
      [narrow, VP_1280],
    ] as const) {
      expect(Math.abs(weekColumnPx(days, vp, SCHEDULE) - TARGET_COL_PX)).toBeLessThan(80);
    }
  });

  it('never hands out a stop that does not fit', () => {
    // The bug that made the week scale look broken in Week × Buckets: with a
    // 240px floor, four of its six stops clamped to the same width, so they all
    // sat the same distance from the target and the prefer-more-days tie-break
    // handed the default to seven — which showed five columns and scrolled.
    for (const vp of [700, VP_1280, VP_1440, 1256, VP_1920, 2400, 3200]) {
      for (const geo of [SCHEDULE, BUCKETS]) {
        const chosen = defaultWeekDays(vp, geo);
        const stop = weekStops(vp, geo).find((s) => s.days === chosen)!;
        // …unless nothing fits at all, where every stop is the floor and only the
        // label differs. The most days is the honest label for that.
        if (weekStops(vp, geo).some((s) => s.fits)) expect(stop.fits).toBe(true);
        else expect(chosen).toBe(MAX_WEEK_DAYS);
      }
    }
  });

  it('falls back to the whole week when the canvas holds no stop at all', () => {
    // A laptop with the sidebar and the item panel open. Every stop renders at
    // the floor and scrolls, so they are pixel-identical and the day count is
    // only a label — MAX_WEEK_DAYS is what both views showed before this control
    // existed.
    expect(weekStops(300, SCHEDULE).some((s) => s.fits)).toBe(false);
    expect(defaultWeekDays(300, SCHEDULE)).toBe(MAX_WEEK_DAYS);
    expect(defaultWeekDays(300, BUCKETS)).toBe(MAX_WEEK_DAYS);
  });

  it('opens both week layouts at a comparable column on the same canvas', () => {
    // Not a coincidence worth asserting for its own sake — it is the check that
    // the two geometries are being driven by the same target rather than by their
    // own accumulated history. Switching layout should not change the density.
    for (const vp of [VP_1280, VP_1440, 1256, VP_1920, 2400]) {
      const s = weekColumnPx(defaultWeekDays(vp, SCHEDULE), vp, SCHEDULE);
      const b = weekColumnPx(defaultWeekDays(vp, BUCKETS), vp, BUCKETS);
      expect(Math.abs(s - b)).toBeLessThan(TARGET_TOLERANCE_PX);
    }
  });

  it('breaks an exact tie toward more days', () => {
    // Geometry solved so four days and three days are EXACTLY equidistant from
    // the target: a 984px field gives 246px and 328px, both 41px away.
    const geo = { gutterPx: 0, gapPx: 0, minColPx: 1 };
    const vp = 984 + 2 * CANVAS_PAD_PX;
    expect(weekColumnPx(4, vp, geo)).toBe(TARGET_COL_PX - 41);
    expect(weekColumnPx(3, vp, geo)).toBe(TARGET_COL_PX + 41);
    expect(defaultWeekDays(vp, geo)).toBe(4);
  });
});

describe('resolveWeekDays', () => {
  it('uses the derived default only while nothing is stored', () => {
    expect(resolveWeekDays(null, VP_1920, SCHEDULE)).toBe(defaultWeekDays(VP_1920, SCHEDULE));
    expect(resolveWeekDays(undefined, VP_1920, SCHEDULE)).toBe(defaultWeekDays(VP_1920, SCHEDULE));
  });

  it('honours a stored choice even when it is not what the canvas would pick', () => {
    const auto = defaultWeekDays(VP_1920, SCHEDULE);
    const other = auto === MAX_WEEK_DAYS ? MIN_WEEK_DAYS : MAX_WEEK_DAYS;
    expect(resolveWeekDays(other, VP_1920, SCHEDULE)).toBe(other);
  });

  it('still sanitises a stored value', () => {
    expect(resolveWeekDays(99, VP_1920, SCHEDULE)).toBe(MAX_WEEK_DAYS);
    expect(resolveWeekDays(0, VP_1920, SCHEDULE)).toBe(MIN_WEEK_DAYS);
  });

  it('re-derives as the canvas changes, which a stored choice must not', () => {
    const small = resolveWeekDays(null, VP_1280, SCHEDULE);
    const large = resolveWeekDays(null, VP_1920, SCHEDULE);
    expect(small).not.toBe(large);
    // …whereas a chosen 3 is 3 on any screen.
    expect(resolveWeekDays(3, VP_1280, SCHEDULE)).toBe(3);
    expect(resolveWeekDays(3, VP_1920, SCHEDULE)).toBe(3);
  });
});

describe('the last-measured-canvas cache', () => {
  it('falls back to the narrow end when nothing has measured yet', () => {
    forgetWeekCanvas();
    expect(resolveWeekDaysFromLastCanvas(null)).toBe(MAX_WEEK_DAYS);
  });

  it('resolves the default against whatever the view last measured', () => {
    forgetWeekCanvas();
    noteWeekCanvas(VP_1920, SCHEDULE);
    expect(resolveWeekDaysFromLastCanvas(null)).toBe(defaultWeekDays(VP_1920, SCHEDULE));
    noteWeekCanvas(VP_1280, SCHEDULE);
    expect(resolveWeekDaysFromLastCanvas(null)).toBe(defaultWeekDays(VP_1280, SCHEDULE));
  });

  it('never consults the cache when a choice is stored', () => {
    forgetWeekCanvas();
    noteWeekCanvas(VP_1920, SCHEDULE);
    expect(resolveWeekDaysFromLastCanvas(4)).toBe(4);
    forgetWeekCanvas();
    expect(resolveWeekDaysFromLastCanvas(4)).toBe(4);
  });

  it('steps on RUNGS against the measured canvas, so ⌘− never no-ops', () => {
    // The keyboard shortcuts run from a keydown handler with no DOM to measure, so
    // they resolve against the canvas the view last recorded — and must land on the
    // same rung the slider would have.
    forgetWeekCanvas();
    noteWeekCanvas(VP_1440, BUCKETS);
    expect(stepWeekDaysFromLastCanvas(7, 1)).toBe(4);
    expect(stepWeekDaysFromLastCanvas(4, -1)).toBe(7);
    // Stepping from null starts at the derived default, not at the ladder's end.
    expect(stepWeekDaysFromLastCanvas(null, -1)).toBe(
      stepWeekRung(defaultWeekDays(VP_1440, BUCKETS), -1, VP_1440, BUCKETS)
    );
  });

  it('falls back to a raw stop step when nothing has measured', () => {
    // Unreachable from the shortcuts, which are gated on a mounted week view. A
    // step still has to be a step.
    forgetWeekCanvas();
    expect(stepWeekDaysFromLastCanvas(5, 1)).toBe(4);
    expect(stepWeekDaysFromLastCanvas(null, 1)).toBe(MAX_WEEK_DAYS - 1);
  });
});

describe('the pinned hour gutter', () => {
  it('outranks the now-marker, or a column scrolling under it paints over the labels', () => {
    // The selected column creates no stacking context (no opacity, no
    // transform), so its now-marker's z escapes into the root layer and
    // competes with the gutter's. This one comparison is the whole reason
    // WEEK_GUTTER_Z is not just "10".
    expect(WEEK_GUTTER_Z).toBeGreaterThan(NOW_MARKER_Z);
    expect(WEEK_GUTTER_Z).toBeGreaterThan(HOVER_Z);
  });

  it('stacks the pinned column heads between the grid and the gutter', () => {
    // Vertically the hour grid (now-marker, hovered blocks) scrolls under the
    // heads; sideways the heads scroll under the gutter; the lane caps sit on
    // top of everything.
    expect(WEEK_HEAD_Z).toBeGreaterThan(NOW_MARKER_Z);
    expect(WEEK_HEAD_Z).toBeGreaterThan(HOVER_Z);
    expect(WEEK_GUTTER_Z).toBeGreaterThan(WEEK_HEAD_Z);
    expect(LANE_CAP_Z).toBeGreaterThan(WEEK_GUTTER_Z);
  });

  it('leaves the row geometry untouched: the pin is a margin trick, not a resize', () => {
    // The gutter's BOX grows by the canvas padding and is pulled back by the
    // same amount, so its contribution to the row's width — and therefore every
    // "does N days fit" answer — is still exactly DAY_FIELD_LEFT.
    const boxWidth = WEEK_GEOMETRY.schedule.gutterPx + CANVAS_PAD_PX;
    const netContribution = boxWidth - CANVAS_PAD_PX;
    expect(netContribution).toBe(WEEK_GEOMETRY.schedule.gutterPx);
  });
});

describe('isScalableLayout', () => {
  it('covers exactly the layouts that have day columns', () => {
    expect(isScalableLayout('schedule')).toBe(true);
    expect(isScalableLayout('buckets')).toBe(true);
    // Week × List is a stack of rows — there is nothing to scale.
    expect(isScalableLayout('list')).toBe(false);
  });

  it('has geometry for every layout it claims is scalable', () => {
    for (const layout of ['schedule', 'buckets'] as const) {
      expect(isScalableLayout(layout)).toBe(true);
      expect(WEEK_GEOMETRY[layout]).toBeDefined();
    }
  });
});
