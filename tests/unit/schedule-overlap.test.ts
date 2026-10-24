import { describe, it, expect } from 'vitest';
import {
  layoutOverlaps,
  pickContentBand,
  planOverlaps,
  type BandLength,
  type BlockLayout,
  type LayoutOptions,
  type OverlapEntry,
} from '@/lib/schedule-overlap';
import {
  BAND_COMFORT,
  HOVER_Z,
  LANE_PX,
  MIN_CHANNEL_PX,
  NEST_PX,
  NEST_RIGHT_PX,
  NOW_MARKER_Z,
  PANE_MIN_H,
  PANE_OFFSET,
  PANE_TRIM,
} from '@/lib/schedule-constants';

const HM = (h: number, m = 0) => h * 60 + m;

function entry(id: string, startMin: number, duration: number, projectBlock?: string): OverlapEntry {
  return { id, startMin, duration, projectBlock };
}

/** The day view's own arithmetic, so the tests assert against the renderer. */
function paneTop(startMin: number, gridStartMin: number, hourPx: number) {
  return ((startMin - gridStartMin) / 60) * hourPx + PANE_OFFSET;
}
function paneH(duration: number, hourPx: number) {
  return Math.max((duration / 60) * hourPx - PANE_TRIM, PANE_MIN_H);
}

const DAY = { hourPx: 52, gridStartMin: HM(9), variant: 'day' as const };

describe('layoutOverlaps — nothing to do', () => {
  it('returns an empty map for a single entry', () => {
    expect(layoutOverlaps([entry('a', HM(10), 60)], DAY).size).toBe(0);
  });

  it('leaves non-overlapping entries alone, so they render as they do today', () => {
    // 10:00-11:00 and 13:00-14:00 — far enough apart that even the painted
    // extent (PANE_MIN_H floor) cannot make them collide.
    const out = layoutOverlaps([entry('a', HM(10), 60), entry('b', HM(13), 60)], DAY);
    expect(out.size).toBe(0);
  });

  it('does not cluster two consecutive short items that only TOUCH', () => {
    // 09:00-09:30 and 09:30-10:00 at hourPx 52: each paints 43.8 minutes, so
    // a's painted end is 09:43 — which DOES reach into b. That is a real pane
    // collision and must be laid out; what must NOT happen is it being called a
    // double-booking (see the topology test below).
    const out = layoutOverlaps([entry('a', HM(9), 30), entry('b', HM(9, 30), 30)], DAY);
    const a = out.get('a')!;
    const b = out.get('b')!;
    expect(a).toBeTruthy();
    // Distinct columns, not a shared lane — their rails stay at the default x.
    expect(a.railX).toBe('5px');
    expect(b.railX).toBe('5px');
    // Two separate columns are not a conflict unit, so neither draws a tie.
    expect(a.startTie).toBeNull();
    expect(b.startTie).toBeNull();
  });
});

describe('layoutOverlaps — NESTED (the screenshot)', () => {
  const items = [
    entry('span', HM(10), 420), // 10:00-17:00, the 7h container
    entry('task', HM(14), 180), // 14:00-17:00, wholly inside it
  ];

  it('keeps the container at full width and full extent', () => {
    const out = layoutOverlaps(items, DAY);
    const span = out.get('span')!;
    expect(span.depth).toBe(0);
    expect(span.left).toBe('0px');
    expect(span.right).toBe('4px');
    expect(span.paneLeft).toBe(`${LANE_PX}px`);
  });

  it('dims the container wash to a field and sinks one pocket per child', () => {
    const out = layoutOverlaps(items, DAY);
    const span = out.get('span')!;
    expect(span.wash).toBe('field');
    expect(span.pockets).toHaveLength(1);

    const expectedTop = paneTop(HM(14), HM(9), 52) - paneTop(HM(10), HM(9), 52);
    expect(span.pockets[0].top).toBeCloseTo(expectedTop, 5);
    expect(span.pockets[0].height).toBeCloseTo(paneH(180, 52), 5);
  });

  it('forks the lane exactly once, at the child true start', () => {
    const out = layoutOverlaps(items, DAY);
    const span = out.get('span')!;
    expect(span.branchTicks).toHaveLength(1);
    // The tick sits on the TRUE start, i.e. PANE_OFFSET above the child's pane.
    expect(span.branchTicks[0]).toBeCloseTo(
      paneTop(HM(14), HM(9), 52) - PANE_OFFSET - paneTop(HM(10), HM(9), 52),
      5
    );
  });

  it('insets the child on BOTH edges so the pocket frames it, on a solid fill', () => {
    const out = layoutOverlaps(items, DAY);
    const task = out.get('task')!;
    expect(task.depth).toBe(1);
    expect(task.left).toBe(`${NEST_PX}px`);
    // The child used to be flush right so the two borders coincided; on screen
    // that read as bursting out of the plate it sits inside, and left the pocket
    // showing only under the child's lane.
    expect(task.right).toBe(`${4 + NEST_RIGHT_PX}px`);
    expect(task.solid).toBe(true);
    expect(task.beadOnPocket).toBe(true);
    expect(task.z).toBeGreaterThan(out.get('span')!.z);
  });

  it('never lets the hovered container rise above its own child', () => {
    // The bug this guards: hover used to lift every block to a flat z-7, so a
    // hovered parent sat on top of its child. Since the pointer must cross the
    // parent to reach the child, the parent latched :hover and the child could
    // not be hovered or clicked at all.
    const out = layoutOverlaps(items, DAY);
    const span = out.get('span')!;
    const task = out.get('task')!;
    expect(span.zHover).toBeLessThan(task.z);
    // …while still clearing its own resting plate, so its crop marks survive.
    expect(span.zHover).toBeGreaterThan(span.z);
    // A leaf has nothing nested inside it, so it lifts clear of everything.
    expect(task.zHover).toBe(HOVER_Z);
  });

  it("re-anchors the container's title into the band above its child", () => {
    const out = layoutOverlaps(items, DAY);
    const span = out.get('span')!;
    expect(span.contentTop).toBe(0);
    expect(span.contentHeight).toBeCloseTo(span.pockets[0].top, 5);
    // And that band is genuinely usable — this is the whole point.
    expect(span.contentHeight!).toBeGreaterThanOrEqual(BAND_COMFORT);
  });

  it('moves the parent handle into its lane only on a flush edge', () => {
    const out = layoutOverlaps(items, DAY);
    const span = out.get('span')!;
    expect(span.handleTopLane).toBe(false); // 10:00 vs 14:00
    expect(span.handleBottomLane).toBe(true); // both end 17:00
  });
});

describe('layoutOverlaps — CROSSING', () => {
  const items = [entry('a', HM(10), 120), entry('b', HM(11), 120)]; // 10-12, 11-13

  it('gives each side its own column and its own complete lane', () => {
    const out = layoutOverlaps(items, DAY);
    const a = out.get('a')!;
    const b = out.get('b')!;
    expect(a.depth).toBe(0);
    expect(b.depth).toBe(0);
    // Neither is nested, so neither has pockets and neither goes solid.
    expect(a.pockets).toHaveLength(0);
    expect(b.pockets).toHaveLength(0);
    expect(a.solid).toBe(false);
    expect(b.solid).toBe(false);
    // Each keeps the default lane geometry inside its own band.
    expect(a.railX).toBe('5px');
    expect(b.railX).toBe('5px');
    expect(a.paneLeft).toBe(`${LANE_PX}px`);
    expect(b.paneLeft).toBe(`${LANE_PX}px`);
    // A crossing is two columns, not one clash — no start-tie on either.
    expect(a.startTie).toBeNull();
    expect(b.startTie).toBeNull();
  });

  it('leaves visible grid between the two plates', () => {
    const out = layoutOverlaps(items, DAY);
    const a = out.get('a')!;
    const b = out.get('b')!;
    // Two columns: a occupies the left half, b the right half offset by COL_GAP.
    expect(a.left).toBe('0px');
    expect(a.right).toContain('50%');
    expect(b.left).toContain('50%');
    expect(b.right).toBe('4px');
  });
});

describe('layoutOverlaps — DOUBLE-BOOKED', () => {
  const items = [entry('standup', HM(9), 60), entry('dentist', HM(9), 60)];

  it('shares one band and one lane, tiling only the panes', () => {
    const out = layoutOverlaps(items, { ...DAY, gridStartMin: HM(8) });
    const d = out.get('dentist')!;
    const s = out.get('standup')!;
    // Same wrapper band — the lane is not relocated.
    expect(d.left).toBe(s.left);
    expect(d.right).toBe(s.right);
    // Panes tile: member 0 keeps the lane inset, member 1 starts at mid.
    expect(d.paneLeft).toBe(`${LANE_PX}px`);
    expect(s.paneLeft).toContain('50%');
  });

  it('seats each member rail+bead beside its own tiled pane', () => {
    const out = layoutOverlaps(items, { ...DAY, gridStartMin: HM(8) });
    // id ASC: dentist is member 0, standup member 1. Member 0 keeps the literal
    // lane; member 1's rail rides its own tile, not the shared left edge.
    expect(out.get('dentist')!.railX).toBe('5px');
    expect(out.get('standup')!.railX).toBe('calc(50% + 5px)');
    expect(out.get('dentist')!.beadX).toBe('3px');
    expect(out.get('standup')!.beadX).toBe('calc(50% + 3px)');
  });

  it('ties the two members together at the shared start, from first bead to last', () => {
    const out = layoutOverlaps(items, { ...DAY, gridStartMin: HM(8) });
    // Only the FIRST member draws the tie; its right inset stops under the last
    // bead's centre (band(50, 6)), which is band(100 / 2, -6).
    expect(out.get('dentist')!.startTie).toBe('calc(50% - 6px)');
    expect(out.get('standup')!.startTie).toBeNull();
  });

  it('gives tiled members the same z, because each keeps its own lane', () => {
    // The panes TILE rather than overlap and each member now has its own lane,
    // so nothing of one member paints over another and member order needs no z
    // of its own. Paying for it would push the top member to z-5+, which is the
    // now-marker's layer, and the lime stub must stay above the glass.
    const out = layoutOverlaps(items, { ...DAY, gridStartMin: HM(8) });
    expect(out.get('dentist')!.z).toBe(out.get('standup')!.z);
    expect(out.get('dentist')!.z).toBeLessThan(5);
  });

  it('tiles the panes without overlapping them, a lane gutter between', () => {
    const out = layoutOverlaps(items, { ...DAY, gridStartMin: HM(8) });
    // Member 0's pane ends at the tile boundary (50%, written by band() as a
    // zero-px calc); member 1's starts a full LANE_PX past it, and member 1's
    // own rail+bead live in that gutter. So the panes cannot paint over each
    // other and each rail sits beside its pane.
    expect(out.get('dentist')!.paneRight).toBe('calc(50% + 0px)');
    expect(out.get('standup')!.paneLeft).toBe(`calc(50% + ${LANE_PX}px)`);
  });

  it('renders every member — an item may be compressed, never absent', () => {
    const three = [
      entry('a', HM(9), 60),
      entry('b', HM(9), 60),
      entry('c', HM(9), 60),
    ];
    const out = layoutOverlaps(three, { ...DAY, gridStartMin: HM(8) });
    expect(out.size).toBe(3);
    // One rail per tile, offset by its tile fraction — distinct, none bunched.
    expect(new Set([...out.values()].map((v) => v.railX))).toEqual(
      new Set(['5px', 'calc(33.333% + 5px)', 'calc(66.667% + 5px)'])
    );
    // The tie reaches from the first bead to the third: right inset band(100/3, -6).
    expect(out.get('a')!.startTie).toBe('calc(33.333% - 6px)');
    expect(out.get('b')!.startTie).toBeNull();
    expect(out.get('c')!.startTie).toBeNull();
  });

  it('does NOT treat a merely-crossing pair as a double-booking', () => {
    // 15 minutes apart is a crossing, not a conflict: tolerance is 2 minutes.
    const out = layoutOverlaps([entry('a', HM(9), 60), entry('b', HM(9, 15), 60)], {
      ...DAY,
      gridStartMin: HM(8),
    });
    expect(out.get('a')!.railX).toBe('5px');
    expect(out.get('b')!.railX).toBe('5px'); // its own lane, in its own column
    // A crossing is not a clash, so no tie is drawn.
    expect(out.get('a')!.startTie).toBeNull();
    expect(out.get('b')!.startTie).toBeNull();
  });
});

describe('layoutOverlaps — project blocks', () => {
  it('groups superimposed project-block tasks into one conflict unit', () => {
    // deriveTimedEntries gives every task in a block the PROJECT's extent, so
    // today N-1 of these are completely invisible.
    const items = [
      entry('t1', HM(10), 60, 'Ship it'),
      entry('t2', HM(10), 60, 'Ship it'),
      entry('t3', HM(10), 60, 'Ship it'),
    ];
    const out = layoutOverlaps(items, { ...DAY, gridStartMin: HM(9) });
    expect(out.size).toBe(3);
    // One shared band, three tiled panes, each with its own lane beside it.
    const bands = new Set([...out.values()].map((v) => v.left));
    expect(bands.size).toBe(1);
    expect(new Set([...out.values()].map((v) => v.railX))).toEqual(
      new Set(['5px', 'calc(33.333% + 5px)', 'calc(66.667% + 5px)'])
    );
  });

  it('keeps two different projects in different columns', () => {
    const items = [
      entry('a1', HM(10), 60, 'Alpha'),
      entry('b1', HM(10), 60, 'Beta'),
    ];
    const out = layoutOverlaps(items, { ...DAY, gridStartMin: HM(9) });
    // Different units at identical extents → still one conflict-style band each
    // side by side, but crucially both are placed and neither is hidden.
    expect(out.size).toBe(2);
  });
});

describe('layoutOverlaps — invariance and degradation', () => {
  const nested = [entry('span', HM(10), 420), entry('task', HM(14), 180)];

  it('does not change topology when hourPx changes', () => {
    // useFitHourPx rescales on every window resize; a pixel gate would flip a
    // nested pair into a double-booking as the window edge is dragged.
    for (const hourPx of [40, 45, 52, 60, 68, 75]) {
      const out = layoutOverlaps(nested, { ...DAY, hourPx });
      expect(out.get('task')!.depth, `hourPx ${hourPx}`).toBe(1);
      expect(out.get('span')!.wash, `hourPx ${hourPx}`).toBe('field');
      expect(out.get('span')!.pockets, `hourPx ${hourPx}`).toHaveLength(1);
    }
  });

  it('refuses to nest when the parent would keep no readable band', () => {
    // 10:00-11:00 containing 10:00-10:55 — the host has 5 minutes left, which is
    // not a container, it is a double-booking wearing a longer duration.
    const out = layoutOverlaps([entry('p', HM(10), 60), entry('c', HM(10), 55)], DAY);
    expect(out.get('c')!.depth).toBe(0);
    expect(out.get('p')!.pockets).toHaveLength(0);
  });

  it('caps columns and cascades the overflow instead of folding it away', () => {
    // Three mutually crossing items with a cap of 2: nothing may vanish.
    const items = [
      entry('a', HM(10), 180),
      entry('b', HM(10, 30), 180),
      entry('c', HM(11), 180),
    ];
    const out = layoutOverlaps(items, { ...DAY, maxCols: 2 });
    expect(out.size).toBe(3);
    // The overflow member steps off its column-mate rather than folding to a
    // titleless rail, and goes solid so the step reads in light mode too.
    const c = out.get('c')!;
    expect(c.solid).toBe(true);
    expect(c.z).toBeGreaterThan(out.get('b')!.z);
  });
});

describe('layoutOverlaps — occlusion truth', () => {
  it('moves a title out from under a CASCADE sibling, not just under a child', () => {
    // Cap 2 with three crossers: c cascades into b's column and covers b's lower
    // half. b has no children, so a children-only band pass would leave b's title
    // centred under c's pane — the original bug, one level down.
    const out = layoutOverlaps(
      [entry('a', HM(10), 180), entry('b', HM(10, 30), 180), entry('c', HM(11), 180)],
      { ...DAY, maxCols: 2 }
    );
    const b = out.get('b')!;
    expect(b.pockets).toHaveLength(0); // definitely not a container
    expect(b.contentTop).toBe(0); // …and yet its content was re-anchored
    expect(b.contentHeight).not.toBeNull();
    expect(b.contentHeight!).toBeLessThan(paneH(180, 52));
  });

  it('keeps every plate below the now-marker, hovered or not', () => {
    // The marker's stub crosses a pane and is legible only because it paints on
    // top; lime under 80% glass composites to olive, and lime never dims.
    const busy = [
      entry('span', HM(10), 420),
      entry('mid', HM(11), 240),
      entry('x', HM(12), 60),
      entry('y', HM(12), 60),
    ];
    for (const v of layoutOverlaps(busy, DAY).values()) {
      expect(v.z).toBeGreaterThanOrEqual(2);
      expect(v.z).toBeLessThan(NOW_MARKER_Z);
      expect(v.zHover).toBeLessThan(NOW_MARKER_Z);
    }
  });

  it('leaves every ancestor below its descendants, at rest and on hover', () => {
    // The general form of the latching bug, over a three-level pile.
    const pile = [
      entry('outer', HM(9), 480),
      entry('mid', HM(10), 240),
      entry('inner', HM(11), 60),
    ];
    const out = layoutOverlaps(pile, { ...DAY, gridStartMin: HM(8) });
    const byDepth = [...out.values()].sort((a, b) => a.depth - b.depth);
    for (let i = 0; i < byDepth.length - 1; i++) {
      const parent = byDepth[i];
      const child = byDepth[i + 1];
      if (child.depth !== parent.depth + 1) continue;
      expect(parent.z).toBeLessThan(child.z);
      expect(parent.zHover).toBeLessThan(child.z);
    }
  });
});

describe('layoutOverlaps — channel width policy', () => {
  /** Five mutually-crossing items: wants five channels, gets what fits. */
  const five = [0, 1, 2, 3, 4].map((i) => entry(`c${i}`, HM(10) + i * 15, 180));

  it('gives a wide desktop field every channel it asked for', () => {
    const out = layoutOverlaps(five, { ...DAY, fieldWidth: 900 });
    // 900 / 140 = 6 available, 5 wanted.
    for (const v of out.values()) expect(v.widthFraction).toBeCloseTo(1 / 5, 5);
  });

  it('gives a mobile-width field only the channels that fit at the floor', () => {
    // The mobile shell renders this same component into ~294px.
    const out = layoutOverlaps(five, { ...DAY, fieldWidth: 294 });
    // floor(294 / 140) = 2 channels; the other three cascade.
    for (const v of out.values()) expect(v.widthFraction).toBeCloseTo(1 / 2, 5);
    expect(out.size).toBe(5); // and nothing vanished
  });

  it('never emits a channel under the floor, falling to one column if it must', () => {
    const out = layoutOverlaps(five, { ...DAY, fieldWidth: 200 });
    for (const v of out.values()) {
      expect(200 * v.widthFraction).toBeGreaterThanOrEqual(MIN_CHANNEL_PX * 0.999);
    }
    expect(out.size).toBe(5);
  });

  it('spends the parent’s width, not the grid’s, on a nested sub-cluster', () => {
    // A container with two children that cross each other: the children split the
    // PARENT's band, so the floor has to be measured against that band.
    const out = layoutOverlaps(
      [entry('span', HM(9), 240), entry('k1', HM(10), 60), entry('k2', HM(10, 30), 60)],
      { ...DAY, gridStartMin: HM(8), fieldWidth: 900 }
    );
    expect(out.get('span')!.widthFraction).toBeCloseTo(1, 5);
    // Two children sharing the parent's full-width band.
    expect(out.get('k1')!.widthFraction).toBeCloseTo(0.5, 5);
    expect(out.get('k2')!.widthFraction).toBeCloseTo(0.5, 5);
  });

  it('is unmeasured-safe: no width means no cap, which is what week relies on', () => {
    const out = layoutOverlaps(five, DAY);
    for (const v of out.values()) expect(v.widthFraction).toBeCloseTo(1 / 5, 5);
  });

  it('does not let width change TOPOLOGY, only the channel count', () => {
    const nested = [entry('span', HM(10), 420), entry('task', HM(14), 180)];
    for (const fieldWidth of [140, 294, 500, 900, 1600]) {
      const out = layoutOverlaps(nested, { ...DAY, fieldWidth });
      expect(out.get('task')!.depth, `field ${fieldWidth}`).toBe(1);
      expect(out.get('span')!.pockets, `field ${fieldWidth}`).toHaveLength(1);
    }
  });
});

describe('layoutOverlaps — week', () => {
  it('shingles instead of nesting, and never splits width', () => {
    const out = layoutOverlaps([entry('span', HM(10), 420), entry('task', HM(14), 180)], {
      hourPx: 52,
      gridStartMin: HM(9),
      variant: 'week',
    });
    const span = out.get('span')!;
    const task = out.get('task')!;
    expect(span.left).toBe('0px');
    expect(task.left).toBe('10px');
    expect(span.right).toBe('4px');
    expect(task.right).toBe('4px');
    // No containment vocabulary in week at all.
    expect(span.pockets).toHaveLength(0);
    expect(span.branchTicks).toHaveLength(0);
    expect(span.wash).toBe('full');
    // Every pane keeps its full remaining width — no percentage split.
    expect(task.paneLeft).toBe(`${LANE_PX}px`);
    expect(span.widthFraction).toBeCloseTo(1, 5);
    expect(task.widthFraction).toBeCloseTo(1, 5);
  });

  it('TILES a double-booking instead of shingling it, and asks for a wider column', () => {
    // The one topology shingling could never carry: identical extents leave each
    // other no free band, so the lower plate was a 10px sliver with its title
    // underneath. Now they tile, and the column grows to keep both readable.
    const out = layoutOverlaps([entry('standup', HM(9), 60), entry('dentist', HM(9), 60)], {
      hourPx: 52,
      gridStartMin: HM(8),
      variant: 'week',
    });
    const a = out.get('dentist')!;
    const b = out.get('standup')!;
    expect(a.left).toBe(b.left); // one band, panes tile inside it
    expect(a.paneLeft).toBe(`${LANE_PX}px`);
    expect(b.paneLeft).toContain('50%');
    expect(a.railX).toBe('5px');
    expect(b.railX).toBe('calc(50% + 5px)'); // beside its own tile, not bunched
    expect(a.startTie).toBe('calc(50% - 6px)'); // tied at the shared start
    expect(b.startTie).toBeNull();
    // Half a channel each → the column needs two channels' worth of width.
    expect(a.widthFraction).toBeCloseTo(0.5, 5);
    expect(MIN_CHANNEL_PX / a.widthFraction).toBeCloseTo(280, 5);
  });

  it('still shingles a crossing, which has free bands to spare', () => {
    const out = layoutOverlaps([entry('a', HM(10), 120), entry('b', HM(11), 120)], {
      hourPx: 52,
      gridStartMin: HM(9),
      variant: 'week',
    });
    expect(out.get('a')!.left).toBe('0px');
    expect(out.get('b')!.left).toBe('10px');
    // No width demanded beyond the standard column.
    expect(out.get('a')!.widthFraction).toBeCloseTo(1, 5);
    expect(out.get('b')!.widthFraction).toBeCloseTo(1, 5);
  });
});

describe('pickContentBand', () => {
  it('returns null when nothing covers the pane, so markup is unchanged', () => {
    expect(pickContentBand(200, [])).toBeNull();
  });

  it('takes the top band when it is comfortable', () => {
    const b = pickContentBand(200, [{ top: 120, bottom: 200 }]);
    expect(b).toEqual({ top: 0, height: 120 });
  });

  it('falls to a lower band when the top one cannot hold a line', () => {
    const b = pickContentBand(200, [{ top: 10, bottom: 100 }]);
    expect(b).toEqual({ top: 100, height: 100 });
  });

  it('is a threshold, not a maximum — it does not hop to a taller lower band', () => {
    // Top band 40px (comfortable), lower band 120px (taller). A "tallest band"
    // rule would pick the lower one and then move the title every time
    // useFitHourPx rescaled the grid.
    const b = pickContentBand(200, [{ top: 40, bottom: 80 }]);
    expect(b!.top).toBe(0);
    expect(b!.height).toBe(40);
  });

  it('gives up rather than printing a clipped half-line', () => {
    expect(pickContentBand(40, [{ top: 8, bottom: 40 }])).toBeNull();
  });
});

/**
 * `layoutOverlaps` is `planOverlaps` written as CSS, and the iPhone ports the
 * numbers (tests/fixtures/day/overlap.json). Over every input this file asks
 * of `layoutOverlaps`, plus the lanes' root band, the two answers carry the
 * same ids in the same order, the same non-length fields, and every CSS length
 * reads back as the plan's percentage and px.
 */
describe('planOverlaps: the numbers layoutOverlaps writes', () => {
  const WEEK = { hourPx: 52, variant: 'week' as const };
  const five = [0, 1, 2, 3, 4].map((i) => entry(`c${i}`, HM(10) + i * 15, 180));
  const nestedPair = [entry('span', HM(10), 420), entry('task', HM(14), 180)];
  const crossing = [entry('a', HM(10), 120), entry('b', HM(11), 120)];
  const doubled = [entry('standup', HM(9), 60), entry('dentist', HM(9), 60)];
  const cases: [string, OverlapEntry[], LayoutOptions][] = [
    ['one entry', [entry('a', HM(10), 60)], DAY],
    ['far apart', [entry('a', HM(10), 60), entry('b', HM(13), 60)], DAY],
    ['touching short items', [entry('a', HM(9), 30), entry('b', HM(9, 30), 30)], DAY],
    ['nested', nestedPair, DAY],
    ['crossing', crossing, DAY],
    ['double-booked', doubled, { ...DAY, gridStartMin: HM(8) }],
    ['three at once', [entry('a', HM(9), 60), entry('b', HM(9), 60), entry('c', HM(9), 60)], { ...DAY, gridStartMin: HM(8) }],
    ['a quarter apart', [entry('a', HM(9), 60), entry('b', HM(9, 15), 60)], { ...DAY, gridStartMin: HM(8) }],
    ['one project block', [entry('t1', HM(10), 60, 'Ship it'), entry('t2', HM(10), 60, 'Ship it'), entry('t3', HM(10), 60, 'Ship it')], DAY],
    ['two project blocks', [entry('a1', HM(10), 60, 'Alpha'), entry('b1', HM(10), 60, 'Beta')], DAY],
    ...[40, 45, 52, 60, 68, 75].map((hourPx): [string, OverlapEntry[], LayoutOptions] => [`nested at ${hourPx}`, nestedPair, { ...DAY, hourPx }]),
    ['five minutes short', [entry('p', HM(10), 60), entry('c', HM(10), 55)], DAY],
    ['capped at two', [entry('a', HM(10), 180), entry('b', HM(10, 30), 180), entry('c', HM(11), 180)], { ...DAY, maxCols: 2 }],
    ['busy', [entry('span', HM(10), 420), entry('mid', HM(11), 240), entry('x', HM(12), 60), entry('y', HM(12), 60)], DAY],
    ['a pile', [entry('outer', HM(9), 480), entry('mid', HM(10), 240), entry('inner', HM(11), 60)], { ...DAY, gridStartMin: HM(8) }],
    ...[900, 294, 200].map((fieldWidth): [string, OverlapEntry[], LayoutOptions] => [`five in ${fieldWidth}`, five, { ...DAY, fieldWidth }]),
    ['five uncapped', five, DAY],
    ['two children', [entry('span', HM(9), 240), entry('k1', HM(10), 60), entry('k2', HM(10, 30), 60)], { ...DAY, gridStartMin: HM(8), fieldWidth: 900 }],
    ...[140, 294, 500, 900, 1600].map((fieldWidth): [string, OverlapEntry[], LayoutOptions] => [`nested in ${fieldWidth}`, nestedPair, { ...DAY, fieldWidth }]),
    ['week nested', nestedPair, { ...WEEK, gridStartMin: HM(9) }],
    ['week double-booked', doubled, { ...WEEK, gridStartMin: HM(8) }],
    ['week crossing', crossing, { ...WEEK, gridStartMin: HM(9) }],
    ['a lane, alone', [entry('a', HM(10), 60)], { ...DAY, root: { leftPct: 50, rightPct: 0 } }],
    ['a lane, crossing', crossing, { ...DAY, fieldWidth: 900, root: { leftPct: 100 / 3, rightPct: 100 / 3 } }],
    ['a lane, doubled', doubled, { ...DAY, root: { leftPct: 0, rightPct: 50 } }],
  ];

  /** A length as `band()` writes it, read back. */
  function readLength(css: string): BandLength {
    const px = /^(-?[\d.]+)px$/.exec(css);
    if (px) return { pct: 0, px: Number(px[1]) };
    const calc = /^calc\((-?[\d.]+)% ([+-]) ([\d.]+)px\)$/.exec(css);
    expect(calc, css).not.toBeNull();
    const [, pct, sign, abs] = calc as RegExpExecArray;
    return { pct: Number(pct), px: (sign === '-' ? -1 : 1) * Number(abs) };
  }

  const LENGTHS = ['left', 'right', 'paneLeft', 'paneRight', 'railX', 'beadX'] as const;

  it.each(cases)('%s', (_name, entries, options) => {
    const plans = planOverlaps(entries, options);
    const layout = layoutOverlaps(entries, options);
    expect([...layout.keys()]).toEqual([...plans.keys()]);
    for (const [id, plan] of plans) {
      const css = layout.get(id) as BlockLayout;
      const lengths: [string, string | null, BandLength | null][] = [
        ...LENGTHS.map((k): [string, string, BandLength] => [k, css[k], plan[k]]),
        ['startTie', css.startTie, plan.startTie],
      ];
      for (const [key, written, planned] of lengths) {
        if (planned === null || written === null) {
          expect(written, `${id}.${key}`).toBe(planned);
          continue;
        }
        const read = readLength(written);
        // band() rounds a percentage to 0.001 and px to 0.01, and drops a zero
        // percentage altogether.
        expect(Math.abs(read.pct - planned.pct), `${id}.${key} ${written}`).toBeLessThanOrEqual(0.0005);
        expect(Math.abs(read.px - planned.px), `${id}.${key} ${written}`).toBeLessThanOrEqual(0.005);
        if (Math.abs(planned.pct) < 1e-9) expect(written, `${id}.${key}`).toMatch(/^-?[\d.]+px$/);
      }
      const rest = (l: object) =>
        Object.fromEntries(
          Object.entries(l).filter(([k]) => !(LENGTHS as readonly string[]).includes(k) && k !== 'startTie')
        );
      expect(rest(css), id).toEqual(rest(plan));
    }
  });
});
