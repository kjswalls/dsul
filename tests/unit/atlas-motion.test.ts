import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ATLAS_EASE_IN_OUT,
  ATLAS_EASE_OUT,
  ATLAS_EASE_SPRING,
  ATLAS_FLY_TOTAL_MS,
  ATLAS_FOLLOW_MS,
  ATLAS_GLIDE,
  ATLAS_MOTION,
  ATLAS_SHEET_RISE_DELAYS,
  ATLAS_SHEET_RISE_TOTAL_MS,
  armPinSettle,
  atlasPop,
  drawInDash,
  flightPoint,
  flourishAt,
  foldScale,
  glideDelay,
  glideTransition,
  strandDelay,
  sweepAt,
  takePinSettle,
  tileFlight,
  underLayer,
} from '@/lib/atlas-motion';
import { FLIGHT_EXTRA, planFlights, stripGeometry } from '@/components/views/atlas/atlas-handoff-canvas';
import { ATLAS_TILE_CAP } from '@/lib/atlas-model';
import { buildRelayGrid } from '@/lib/atlas-relay-grid';
import type { FarCluster } from '@/components/views/atlas/atlas-far-canvas';

/**
 * Atlas's motion module (round 2, part B): one place for every duration and
 * curve, the handoff's math, and the rules that keep it honest (the app's own
 * curves, short moments, nothing faded by an element's opacity).
 */

const ROOT = join(__dirname, '..', '..');
const css = readFileSync(join(ROOT, 'app/globals.css'), 'utf8');
const token = (name: string) => css.match(new RegExp(`${name}:\\s*(cubic-bezier\\([^)]*\\))`))?.[1];

describe('the curves and durations', () => {
  it("are the app's own curves, never new ones", () => {
    expect(ATLAS_EASE_OUT).toBe(token('--ease-out-soft'));
    expect(ATLAS_EASE_SPRING).toBe(token('--ease-spring'));
    expect(ATLAS_EASE_IN_OUT).toMatch(/^cubic-bezier\(/);
  });

  it('keeps every moment under about 300ms, except the glide and the handoff', () => {
    const exempt = new Set(['glideMs', 'flyMs', 'flourishMs', 'flourishDelayMs', 'sheetOpenMs']);
    for (const [k, v] of Object.entries(ATLAS_MOTION)) {
      if (exempt.has(k)) continue;
      expect(v, k).toBeLessThanOrEqual(300);
    }
    // The sheet's grow is a geometry change across the screen, a touch longer.
    expect(ATLAS_MOTION.sheetOpenMs).toBeLessThanOrEqual(360);
    expect(ATLAS_MOTION.sheetCloseMs).toBeLessThan(ATLAS_MOTION.sheetOpenMs);
    // The whole fly-in stays under a second.
    expect(ATLAS_FLY_TOTAL_MS).toBeLessThan(1000);
  });

  it('lets the strands follow the whole glide, cascade included', () => {
    expect(ATLAS_FOLLOW_MS).toBeGreaterThan(ATLAS_MOTION.glideMs + ATLAS_MOTION.glideStaggerMs);
  });

  it('glides on transform only, with a delay only when one is asked', () => {
    expect(ATLAS_GLIDE).toBe(`transform ${ATLAS_MOTION.glideMs}ms ${ATLAS_EASE_OUT}`);
    expect(glideTransition(0)).toBe(ATLAS_GLIDE);
    expect(glideTransition(40)).toBe(`${ATLAS_GLIDE} 40ms`);
    expect(ATLAS_GLIDE).not.toMatch(/opacity|all/);
  });

  it('cascades a layout switch left to right, finite for anything', () => {
    expect(glideDelay(0, 0, 1000)).toBe(0);
    expect(glideDelay(1000, 0, 1000)).toBe(ATLAS_MOTION.glideStaggerMs);
    expect(glideDelay(500, 0, 1000)).toBe(Math.round(ATLAS_MOTION.glideStaggerMs / 2));
    expect(glideDelay(5, 5, 5)).toBe(0);
    expect(glideDelay(NaN, 0, 10)).toBe(0);
    expect(glideDelay(3, Infinity, -Infinity)).toBe(0);
  });
});

describe('the handoff', () => {
  it('folds a card flat first, then narrows it, whole at 0', () => {
    expect(foldScale(0)).toEqual({ sx: 1, sy: 1 });
    const mid = foldScale(0.5);
    expect(mid.sy).toBeLessThan(mid.sx);
    const end = foldScale(1);
    expect(end.sy).toBeCloseTo(0.04);
    expect(end.sx).toBeCloseTo(0.08);
    // Monotonic: a pinch back runs the same frames backwards.
    let prev = foldScale(0);
    for (let e = 0.05; e <= 1; e += 0.05) {
      const f = foldScale(e);
      expect(f.sx).toBeLessThanOrEqual(prev.sx + 1e-9);
      expect(f.sy).toBeLessThanOrEqual(prev.sy + 1e-9);
      prev = f;
    }
    expect(sweepAt(0)).toBe(0);
    expect(sweepAt(0.6)).toBe(1);
  });

  it('streams tiles one after another, none gone at the start, all landed at the end', () => {
    const n = 8;
    for (let k = 0; k < n; k++) {
      expect(tileFlight(0, k, n)).toBe(0);
      expect(tileFlight(0.05, k, n)).toBe(0);
      expect(tileFlight(1, k, n)).toBe(1);
    }
    // The first tile is further along than the last mid-way.
    expect(tileFlight(0.4, 0, n)).toBeGreaterThan(tileFlight(0.4, n - 1, n));
    expect(tileFlight(0.4, 0, 1)).toBeGreaterThan(0);
  });

  it('flies from the strip to the cell, bowed between', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 0 };
    expect(flightPoint(a, b, 0, 0)).toEqual({ x: 0, y: 0 });
    const end = flightPoint(a, b, 1, 0);
    expect(end.x).toBeCloseTo(100);
    expect(end.y).toBeCloseTo(0);
    // Alternate tiles bow opposite ways.
    expect(Math.sign(flightPoint(a, b, 0.5, 0).y)).toBe(-Math.sign(flightPoint(a, b, 0.5, 1).y));
    expect(flightPoint(a, a, 0.5, 0)).toEqual({ x: 0, y: 0 });
  });

  it('brings the constellation up in order, and is a plain swap under reduced motion', () => {
    expect(underLayer(0, false)).toEqual({ links: 0, aura: 0, labels: 0, tiles: false });
    const mid = underLayer(0.5, false);
    expect(mid.links).toBe(0.5);
    expect(mid.aura).toBeGreaterThan(mid.labels);
    expect(mid.tiles).toBe(false);
    expect(underLayer(1, false)).toEqual({ links: 1, aura: 1, labels: 1, tiles: true });
    // Reduced: nothing until 0.5, then everything; no in-between alpha at all.
    for (const e of [0, 0.3, 0.9, 0.999]) expect(underLayer(e, true)).toEqual({ links: 0, aura: 0, labels: 0, tiles: false });
    expect(underLayer(1, true)).toEqual({ links: 1, aura: 1, labels: 1, tiles: true });
  });

  it('holds the flourish on the grid, then assembles to whole cards', () => {
    expect(flourishAt(0)).toBe(1);
    expect(flourishAt(ATLAS_MOTION.flourishDelayMs)).toBe(1);
    expect(flourishAt(ATLAS_MOTION.flourishDelayMs + ATLAS_MOTION.flourishMs / 2)).toBeCloseTo(0.5);
    expect(flourishAt(ATLAS_FLY_TOTAL_MS)).toBe(0);
  });

  it('pairs lit strip tiles with lit cells, open with open, and the rest from the chip', () => {
    const grid = buildRelayGrid([{ key: 'k', x: 0, y: 0, tiles: 5, lit: 2 }]);
    const cells = (grid.byCluster.get('k') ?? []).filter((c) => c.role === 'tile');
    const geom = {
      tiles: [
        { x: 10, y: 46, state: 'open' },
        { x: 20, y: 46, state: 'lit' },
        { x: 30, y: 46, state: 'lit' },
      ],
      more: { x: 60, y: 46 },
      measured: true,
    };
    const { list: flights, settle } = planFlights(geom, cells);
    expect(flights).toHaveLength(5);
    expect(settle).toHaveLength(0);
    const litCells = new Set(cells.filter((c) => c.lit).map((c) => `${c.x},${c.y}`));
    for (const f of flights) {
      expect(f.dst).not.toBeNull();
      expect(litCells.has(`${f.dst!.x},${f.dst!.y}`)).toBe(f.state === 'lit');
    }
    // Past the strip, from the "+n" chip.
    expect(flights.slice(3).every((f) => f.off.x === 60)).toBe(true);
    expect(flights.map((f) => f.k)).toEqual([0, 1, 2, 3, 4]);
    // They never sat on the strip, so they grow from nothing (no stack of
    // squares over the chip on the band's first frame); the strip's own don't.
    expect(flights.slice(3).every((f) => f.extra)).toBe(true);
    expect(flights.slice(0, 3).some((f) => f.extra)).toBe(false);
  });

  it('flies the strip and a few more, and settles the rest of a big container in place', () => {
    const grid = buildRelayGrid([{ key: 'k', x: 0, y: 0, tiles: 120, lit: 40 }]);
    const cells = (grid.byCluster.get('k') ?? []).filter((c) => c.role === 'tile');
    expect(cells.length).toBeGreaterThan(ATLAS_TILE_CAP + FLIGHT_EXTRA);
    const tiles = Array.from({ length: ATLAS_TILE_CAP }, (_, i) => ({
      x: 10 + (i % 23) * 10,
      y: 46 + Math.floor(i / 23) * 10,
      state: i < 10 ? 'lit' : 'open',
    }));
    const { list, settle } = planFlights({ tiles, more: { x: 200, y: 66 }, measured: true }, cells);
    expect(list).toHaveLength(ATLAS_TILE_CAP + FLIGHT_EXTRA);
    expect(list.length + settle.length).toBe(cells.length);
    // Every cell is someone's, once.
    const ends = new Set([...list.map((f) => `${f.dst!.x},${f.dst!.y}`), ...settle.map((c) => `${c.x},${c.y}`)]);
    expect(ends.size).toBe(cells.length);
    // A goal's card has no strip: only the extra budget flies, from nothing.
    const goal = planFlights({ tiles: [], more: null, measured: true }, cells);
    expect(goal.list).toHaveLength(FLIGHT_EXTRA);
    expect(goal.list.every((f) => f.extra)).toBe(true);
  });

  it('estimates a strip for a card not on screen yet', () => {
    const c = { key: 'project:x', tiles: 3, lit: 1 } as FarCluster;
    const g = stripGeometry(null, c);
    expect(g.measured).toBe(false);
    expect(g.tiles.map((t) => t.state)).toEqual(['lit', 'open', 'open']);
  });
});

describe('strands drawing in', () => {
  it('ends on exactly the dash it rests with, and starts hidden', () => {
    const d = drawInDash(100, [3, 5])!;
    const list = d.dasharray.split(' ').map(Number);
    expect(list.slice(0, 4)).toEqual([3, 5, 3, 5]);
    // The pattern covers more than the strand, then a gap longer than it.
    expect(d.from).toBeGreaterThan(100);
    expect(list[list.length - 1]).toBeGreaterThan(100);
    expect(drawInDash(100, null)).toEqual({ dasharray: expect.stringMatching(/^\d+ \d+$/), from: expect.any(Number) });
    expect(drawInDash(0, [3, 5])).toBeNull();
    expect(drawInDash(NaN, [3, 5])).toBeNull();
    // A very long strand draws in solid rather than build a huge list.
    expect(drawInDash(100_000, [3, 5])!.dasharray.split(' ')).toHaveLength(2);
  });

  it('staggers strands appearing together, up to a cap', () => {
    expect(strandDelay(0)).toBe(0);
    expect(strandDelay(1)).toBe(ATLAS_MOTION.strandStaggerMs);
    expect(strandDelay(1000)).toBe(ATLAS_MOTION.strandStaggerCapMs);
  });
});

describe('a pin made here', () => {
  it('arms a settle once, for two seconds, and never for a pin nobody armed', () => {
    expect(takePinSettle('project:none', 1000)).toBe(false);
    armPinSettle('project:a', 1000);
    expect(takePinSettle('project:a', 1500)).toBe(true);
    expect(takePinSettle('project:a', 1500)).toBe(false);
    armPinSettle('project:b', 1000);
    expect(takePinSettle('project:b', 3500)).toBe(false);
  });
});

describe('the focus sheet rise', () => {
  it('spells the same timing in the stylesheet as in the motion module, and only while opening', () => {
    expect(css).toMatch(new RegExp(`\\.atlas-sheet-body\\[data-rising\\] > \\* \\{\\s*animation: atlas-sheet-rise ${ATLAS_MOTION.sheetRiseMs}ms `));
    ATLAS_SHEET_RISE_DELAYS.slice(1, 5).forEach((d, i) => {
      expect(css).toContain(`.atlas-sheet-body[data-rising] > :nth-child(${i + 2}) { animation-delay: ${d}ms; }`);
    });
    const last = ATLAS_SHEET_RISE_DELAYS[ATLAS_SHEET_RISE_DELAYS.length - 1];
    expect(css).toContain(`.atlas-sheet-body[data-rising] > :nth-child(n + 6) { animation-delay: ${last}ms; }`);
    // No rule animates the body's blocks without the opening's attribute.
    expect(css).not.toMatch(/\.atlas-sheet-body > \*/);
    expect(ATLAS_SHEET_RISE_TOTAL_MS).toBe(ATLAS_MOTION.sheetRiseMs + last);
    expect(ATLAS_MOTION.sheetRiseMs).toBeLessThanOrEqual(300);
  });
});

describe('atlasPop', () => {
  it('plays nothing under reduced motion, or where the browser cannot', () => {
    let calls = 0;
    const el = { animate: () => { calls += 1; return {} as Animation; } } as unknown as Element;
    expect(atlasPop(el, [], {}, true)).toBeNull();
    expect(calls).toBe(0);
    expect(atlasPop(el, [], {}, false)).not.toBeNull();
    expect(calls).toBe(1);
    expect(atlasPop({} as Element, [], {}, false)).toBeNull();
    expect(atlasPop(null, [], {}, false)).toBeNull();
    const throws = { animate: () => { throw new Error('no add'); } } as unknown as Element;
    expect(atlasPop(throws, [], {}, false)).toBeNull();
  });
});

/**
 * Does this source fade an element by opacity, in any of the forms it takes:
 * a style or keyframe key, a utility (with any variant prefix, such as
 * `hover:` or `group-hover:`), an inline write or a setProperty. Canvas
 * `globalAlpha` is drawing, not an element's opacity, and is allowed.
 */
function fadesByOpacity(src: string): string | null {
  const forms: [string, RegExp][] = [
    ['opacity style key', /\bopacity\s*:/],
    ['quoted opacity key', /['"`]opacity['"`]\s*:/],
    ['opacity utility', /(?:^|[^\w-])!?opacity-(?:\d|\[|\()/m],
    ['opacity keyframe', /\{\s*opacity\b/],
    ['inline opacity write', /\.style\.opacity\s*=/],
    ['opacity setProperty', /setProperty\(\s*['"`]opacity['"`]/],
    ['Tailwind fade arbitrary', /\[opacity:/],
  ];
  for (const [name, re] of forms) if (re.test(src)) return name;
  return null;
}

describe('nothing in Atlas fades by opacity', () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const dir = join(ROOT, 'components/views/atlas');
  const files = [
    ...readdirSync(dir)
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => join('components/views/atlas', f)),
    ...readdirSync(join(ROOT, 'lib'))
      .filter((f) => /^atlas-.*\.tsx?$/.test(f))
      .map((f) => join('lib', f)),
  ];

  it('catches every form of an opacity fade, prefixed utilities included', () => {
    for (const bad of [
      'className="hover:opacity-50"',
      "cn('group-hover:opacity-0')",
      'className="opacity-60"',
      "cn(x && 'data-[s=a]:opacity-[.4]')",
      'style={{ opacity: 0.5 }}',
      "{ 'opacity': 1 }",
      'el.style.opacity = "0"',
      "el.style.setProperty('opacity', '0')",
      "[{ opacity: 0 }, { opacity: 1 }]",
    ])
      expect(fadesByOpacity(bad), bad).not.toBeNull();
    for (const fine of ['ctx.globalAlpha = 0.5', 'const layerOpacity = 1', "'--day-recede'", 'backdrop-blur-[2px]'])
      expect(fadesByOpacity(fine), fine).toBeNull();
  });

  it.each(files)('%s sets no opacity on an element', (f) => {
    const src = strip(readFileSync(join(ROOT, f), 'utf8'));
    expect(fadesByOpacity(src)).toBeNull();
  });

  it("keeps the stylesheet's Atlas rules free of opacity", () => {
    const blocks = strip(css)
      .split('}')
      .filter((b) => /atlas/.test(b.split('{')[0] ?? ''));
    expect(blocks.length).toBeGreaterThan(3);
    for (const b of blocks) expect(b, b.slice(0, 120)).not.toMatch(/\bopacity\s*:/);
  });

  it('animates the motion module on transform, stroke and canvas only', () => {
    const src = strip(readFileSync(join(ROOT, 'lib/atlas-motion.ts'), 'utf8'));
    expect(src).not.toMatch(/\bopacity\b/);
  });
});
