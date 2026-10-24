import {
  BAND_COMFORT,
  COL_GAP,
  HOVER_Z,
  LANE_PX,
  LINE_H,
  MAX_DEPTH_DAY,
  MIN_CHANNEL_PX,
  NEST_PX,
  NEST_RIGHT_PX,
  PANE_MIN_H,
  PANE_OFFSET,
  PANE_TRIM,
  SHINGLE_PX,
} from '@/lib/schedule-constants';

/**
 * Overlapping schedule blocks — "Pocket & Channel".
 *
 * Until this pass existed, `ScheduleBlock` was `absolute left-0 right-1` with no
 * overlap handling at all: DOM order was paint order, so a later-derived block
 * simply painted over an earlier, longer one and took its title, its time range
 * and its bottom resize edge with it.
 *
 * ── The idea ──────────────────────────────────────────────────────────────
 * Three overlap topologies, three silhouettes, and each one is an EXISTING mark
 * transformed rather than new chrome:
 *
 *   NESTED (a 7h session containing a 3h task) — the rail moves INWARD. The
 *     container keeps its exact extent, full width and full rail; it drops its
 *     emission wash to ambient and sinks a POCKET where each child sits, with one
 *     6px branch tick in its lane at the child's start. The child is a normal
 *     block inset NEST_PX left and flush right, on a SOLID fill. Containment is
 *     something you read, not damage.
 *
 *   CROSSING (10–12 and 11–13) — the rail DUPLICATES. Greedy first-fit columns
 *     with COL_GAP of visible grid between plates; each column carries its own
 *     complete lane, so the accent still has real extent on the grid.
 *
 *   DOUBLE-BOOKED (two things at 09:00) — the members TILE and each keeps its
 *     own lane. All members share ONE band, but every tile carries its own
 *     LANE_PX gutter, so member k's rail and bead sit just left of member k's
 *     OWN pane rather than bunching against member 0's at the shared left edge.
 *     The residual "these begin together" signal is a single faint hairline —
 *     `startTie`, drawn once by the unit's first member — running along the
 *     shared start line from the first bead to the last. Still the whole conflict
 *     signal: no badge, no warning colour, no dotted border.
 *
 * ── Two extents, and why ──────────────────────────────────────────────────
 * A pane is floored at PANE_MIN_H, so a short block COVERS MORE TIME THAN IT
 * OWNS: at hourPx 40 a 15-minute item paints 57 minutes of grid. Clustering,
 * column packing and free-band subtraction therefore run on the PAINTED extent,
 * while classification and every drawn mark use the TRUE one. Getting this
 * backwards means two consecutive items read as a conflict.
 *
 * ── Invariance ────────────────────────────────────────────────────────────
 * The containment gate is measured in MINUTES, never pixels. `useFitHourPx`
 * rescales on every window resize, so a pixel gate would flip a nested pair into
 * a double-booking and back as you drag the window edge. Rendering may degrade
 * with hourPx; topology may not.
 *
 * The pass is pure. An entry with no overlap is absent from the returned map, and
 * the renderer then emits today's markup byte-for-byte — an uncrowded day pays
 * nothing for this file existing.
 *
 * ── Two answers, one pass ─────────────────────────────────────────────────
 * `planOverlaps` is the pass itself, and answers in numbers: every horizontal
 * length is a percentage plus px (`BandLength`). `layoutOverlaps` is that plan
 * written as the CSS lengths the web's renderer sets. The iPhone ports the
 * numeric pass (ios/DsulCore ScheduleOverlap.swift, pinned by
 * tests/fixtures/day/overlap.json) and draws `pct / 100 × width + px`, so a
 * phone and a browser lay the same day out from one rule.
 */

/** Minutes, for a gate that must not depend on hourPx. */
export const MIN_HOST_FREE_MIN = 30;
export const MIN_HOST_FREE_FRAC = 0.15;

/** A double-booking is a genuine one: anything looser is a crossing and takes
 *  columns. 2 minutes absorbs nothing but rounding. */
export const IDENTICAL_TOL = 2;

export type OverlapEntry = {
  id: string;
  startMin: number;
  duration: number;
  /**
   * Project-block members carry the PROJECT's start and duration, not their own
   * (see deriveTimedEntries), so every task in a block is exactly superimposed
   * on its siblings. Today that means N-1 of them are not half-covered but
   * COMPLETELY INVISIBLE — a worse instance of this bug than a covered title.
   * Grouping them by project turns the pile into one conflict unit.
   */
  projectBlock?: string | null;
};

/** A sunk well inside a container's pane, one per child. Pane-space px. */
export type Pocket = { top: number; height: number };

export type BlockLayout = {
  depth: number;
  /** Wrapper band. CSS lengths — percentages resolve against the events layer. */
  left: string;
  right: string;
  /** Pane margins inside that band. Only a conflict member sets these apart. */
  paneLeft: string;
  paneRight: string;
  /**
   * Where this block's 2px swell and 6px bead sit within its own wrapper, as CSS
   * lengths. A solo/crossing/nested block is `'5px'`/`'3px'`, exactly as before;
   * a tiled conflict member offsets both by its tile's left fraction so the rail
   * lands beside its own pane (`calc(50% + 5px)`, …) instead of at the shared
   * left edge.
   */
  railX: string;
  beadX: string;
  /**
   * The "same-start" cue for a genuine double-booking: a faint hairline along the
   * shared start line, from the first member's bead to the last. Set only on the
   * FIRST member of a conflict unit of >1 (the one whose wrapper still spans the
   * whole band); the CSS `right` inset that stops it under the last bead. null on
   * every other block — a solo, a crossing column, a nested child, and every
   * non-leader member of the unit.
   */
  startTie: string | null;
  z: number;
  /** Containers dim their wash so the plate reads as a field, not a lamp. */
  wash: 'full' | 'field';
  /** A nested plate is not glass — there is nothing informative behind it, and
   *  94%-over-80% is 0.00003 L apart on white. Depth >= 1 goes solid. */
  solid: boolean;
  /**
   * Where this block goes while hovered.
   *
   * A leaf jumps clear of every resting plate (HOVER_Z) so its crop marks and
   * calipers survive a flush neighbour. A block WITH DESCENDANTS gets `z + 1` and
   * no more — one step is enough to beat its siblings, and anything more would put
   * a container above its own contents, at which point the contents can never be
   * hovered or clicked again: the pointer crosses the parent going in, the parent
   * latches :hover, and it is then topmost at every point of the child.
   */
  zHover: number;
  pockets: Pocket[];
  /** Wrapper-relative y for each child's branch tick in this block's lane. */
  branchTicks: number[];
  /** The bead is punched out of the parent's plate, not the canvas. */
  beadOnPocket: boolean;
  /** Content re-anchored into its topmost usable free band. null = centre in the
   *  whole pane, exactly as today. */
  contentTop: number | null;
  contentHeight: number | null;
  /** A flush shared edge moves the PARENT's resize handle into its own lane —
   *  a 20px grabber where no child reaches — rather than trimming the child and
   *  lying about a start time. */
  handleTopLane: boolean;
  handleBottomLane: boolean;
  /**
   * This pane's width as a fraction of the field, which is the one number both
   * callers need and neither can get any other way:
   *
   *   day  — `fieldWidth * widthFraction < PANE_WRAP_PX` decides whether the
   *          block wraps its title instead of truncating it.
   *   week — `MIN_CHANNEL_PX / min(widthFraction)` is how wide the column has to
   *          be for its narrowest pane to clear the floor. Week does not cap;
   *          it widens, and the grid scrolls, which it is already built to do.
   *
   * A fraction rather than a pixel width because the bands are percentages; the
   * handful of px terms (gaps, insets) are small enough not to move a threshold.
   */
  widthFraction: number;
};

export type OverlapLayout = Map<string, BlockLayout>;

/**
 * A horizontal length as the pass computes it: `pct` percent of the box it
 * resolves against, plus `px`. `left` and `right` resolve against the field
 * (the events layer); `paneLeft`, `paneRight`, `railX`, `beadX` and `startTie`
 * against the block's own band, as their CSS does. `band()` writes one as CSS.
 */
export type BandLength = { pct: number; px: number };

/**
 * `BlockLayout` in numbers, the pass's own answer. Every field means what the
 * `BlockLayout` field of the same name means; each CSS length is a
 * `BandLength` here.
 */
export type OverlapPlan = Omit<
  BlockLayout,
  'left' | 'right' | 'paneLeft' | 'paneRight' | 'railX' | 'beadX' | 'startTie'
> & {
  left: BandLength;
  right: BandLength;
  paneLeft: BandLength;
  paneRight: BandLength;
  railX: BandLength;
  beadX: BandLength;
  startTie: BandLength | null;
};

export type OverlapPlans = Map<string, OverlapPlan>;

type Band = { leftPct: number; leftPx: number; rightPct: number; rightPx: number };

type Node = {
  e: OverlapEntry;
  /** true extent, minutes */
  s: number;
  t: number;
  /** painted extent, minutes */
  ps: number;
  pt: number;
  /** conflict-unit key: superimposed entries share one */
  unit: string;
  parent: Node | null;
  children: Node[];
  depth: number;
  /** index in the caller's array, which IS the renderer's DOM order */
  dom: number;
};

/** Everything a block needs before the occlusion pass decides its title band. */
type Placed = Omit<OverlapPlan, 'contentTop' | 'contentHeight'> & {
  node: Node;
  numericBand: Band;
  paneTop: number;
  paneHeight: number;
  paintedTop: number;
  paintedBottom: number;
};

/**
 * Paint order, as a single comparable integer.
 *
 * A depth comparison alone is NOT enough to know who covers whom: DOM order in
 * the renderer comes from `deriveTimedEntries`, which sorts on `startMin` only
 * and emits habits before tasks, so it disagrees with this pass's duration-DESC
 * ordering. Two blocks at equal z are therefore resolved by DOM order, and that
 * is what has to be modelled here or a block goes looking for its title band
 * while blind to the thing actually sitting on top of it.
 */
function paintRank(p: Placed): number {
  return p.z * 4096 + p.node.dom;
}

/** Nominal field width for horizontal-intersection tests. Column boundaries are
 *  percentages of this, so the comparison is exact for any realistic field. */
export const NOMINAL_FIELD = { day: 800, week: 140 } as const;

function edges(b: Band, w: number): { l: number; r: number } {
  return {
    l: (b.leftPct / 100) * w + b.leftPx,
    r: w - ((b.rightPct / 100) * w + b.rightPx),
  };
}

function overlapsHorizontally(a: Band, b: Band, w: number): boolean {
  const ea = edges(a, w);
  const eb = edges(b, w);
  return ea.l < eb.r - 0.01 && eb.l < ea.r - 0.01;
}

function paintedMinutes(duration: number, hourPx: number): number {
  return Math.max(duration, ((PANE_MIN_H + PANE_TRIM) / hourPx) * 60);
}

function contains(p: Node, c: Node): boolean {
  return p.s <= c.s && c.t <= p.t && (p.s < c.s || c.t < p.t);
}

function identical(a: Node, b: Node): boolean {
  return Math.abs(a.s - b.s) <= IDENTICAL_TOL && Math.abs(a.t - b.t) <= IDENTICAL_TOL;
}

/** `calc()` of a percentage plus a pixel offset, with the sign folded into the
 *  operator — `calc(50% + -3px)` is legal but reads as a typo. */
function band(pct: number, px: number): string {
  const p = Math.round(px * 100) / 100;
  if (Math.abs(pct) < 1e-9) return `${p}px`;
  const q = Math.round(pct * 1000) / 1000;
  return `calc(${q}% ${p < 0 ? `- ${Math.abs(p)}` : `+ ${p}`}px)`;
}

const len = (pct: number, px: number): BandLength => ({ pct, px });
const css = (l: BandLength): string => band(l.pct, l.px);

/** A plan written as the CSS lengths the renderer sets. */
function layoutOf(p: OverlapPlan): BlockLayout {
  return {
    depth: p.depth,
    left: css(p.left),
    right: css(p.right),
    paneLeft: css(p.paneLeft),
    paneRight: css(p.paneRight),
    railX: css(p.railX),
    beadX: css(p.beadX),
    startTie: p.startTie ? css(p.startTie) : null,
    z: p.z,
    zHover: p.zHover,
    wash: p.wash,
    solid: p.solid,
    pockets: p.pockets,
    branchTicks: p.branchTicks,
    beadOnPocket: p.beadOnPocket,
    contentTop: p.contentTop,
    contentHeight: p.contentHeight,
    handleTopLane: p.handleTopLane,
    handleBottomLane: p.handleBottomLane,
    widthFraction: p.widthFraction,
  };
}

/**
 * Subtract covered y-ranges from [0, paneH] and pick where the content goes.
 *
 * A THRESHOLD, not a maximum: take the topmost band that clears BAND_COMFORT,
 * else the topmost that clears one line, else give up and centre in the whole
 * pane. A "tallest band" rule would make the title HOP between bands as
 * useFitHourPx rescales the grid, which is worse than a slightly lower title.
 */
export function pickContentBand(
  paneH: number,
  covers: { top: number; bottom: number }[]
): { top: number; height: number } | null {
  let free: { top: number; bottom: number }[] = [{ top: 0, bottom: paneH }];
  for (const c of covers) {
    const next: { top: number; bottom: number }[] = [];
    for (const f of free) {
      if (c.bottom <= f.top || c.top >= f.bottom) {
        next.push(f);
        continue;
      }
      if (c.top > f.top) next.push({ top: f.top, bottom: Math.min(c.top, f.bottom) });
      if (c.bottom < f.bottom) next.push({ top: Math.max(c.bottom, f.top), bottom: f.bottom });
    }
    free = next;
  }
  if (!free.length) return null;
  const comfortable = free.find((f) => f.bottom - f.top >= BAND_COMFORT);
  const usable = comfortable ?? free.find((f) => f.bottom - f.top >= LINE_H);
  if (!usable) return null;
  // A band spanning the whole pane is not a re-anchor — say so with null so the
  // renderer keeps today's markup.
  if (usable.top === 0 && usable.bottom >= paneH) return null;
  return { top: usable.top, height: usable.bottom - usable.top };
}

/** Pane top/height in field space, matching day-schedule's own arithmetic. */
function paneRect(startMin: number, minutes: number, gridStartMin: number, hourPx: number) {
  const startY = ((startMin - gridStartMin) / 60) * hourPx;
  const spanH = (minutes / 60) * hourPx;
  return {
    startY,
    top: startY + PANE_OFFSET,
    height: Math.max(spanH - PANE_TRIM, PANE_MIN_H),
  };
}

export type LayoutOptions = {
  hourPx: number;
  gridStartMin: number;
  variant?: 'day' | 'week';
  /**
   * Measured width of the events layer, in px. Day passes it and gets as many
   * channels as fit at MIN_CHANNEL_PX; anything past that steps into the inset
   * cascade. Omit it — as week does — and the pass never caps, because week
   * answers a crowded column by growing rather than by dividing.
   *
   * This makes the column COUNT width-dependent, which is fine and deliberate.
   * TOPOLOGY stays width- and hourPx-invariant: what is nested, what is crossing
   * and what is double-booked is decided in minutes, above, and no measurement
   * can change it.
   */
  fieldWidth?: number | null;
  /** Hard override, for tests and for a caller that knows better than the width. */
  maxCols?: number;
  /**
   * The band the root cluster is placed into, as percentages of the field.
   * Omitted, it is the whole field, which is every pre-5b caller.
   *
   * This is the whole of the lanes mechanism. `placeSiblings` already derives its
   * channel budget from the `area` it is handed rather than from the field, so a
   * lane's band substituted at the root makes column packing, containment, the
   * inset cascade and the content-band pass all run inside a lane exactly as they
   * ran inside the field. Callers run the pass once per lane over that lane's
   * entries and merge, which also keeps CLUSTERING per lane — two blocks in
   * different lanes share a time but not a column, so they are not a conflict.
   *
   * Passing it changes one other thing, deliberately: every entry gets a layout,
   * including one with nothing overlapping it. Without a root band the absence of
   * a layout MEANS "the whole field", which is exactly the wrong default once the
   * block belongs to a lane.
   */
  root?: { leftPct: number; rightPct: number };
};

/**
 * A layout stripped to its x half — the band, the pane margins and the rail —
 * with everything derived from the block's EXTENTS cleared.
 *
 * For a block being resized. `preview` moves a start and a duration, so the
 * pockets, branch ticks, chosen content band and flush-edge handles all go
 * stale the instant the gesture begins; the lane it sits in does not. Dropping
 * the whole layout takes the band with it, which since lanes landed means the
 * block jumps to the field's left edge and spans every lane until pointer-up.
 *
 * Returns undefined for undefined, so an un-laid-out block on an ungrouped grid
 * still resizes against `left-0 right-1` exactly as it always has.
 */
export function bandOnly(layout: BlockLayout | undefined): BlockLayout | undefined {
  if (!layout) return undefined;
  return {
    ...layout,
    // A conflict unit's tiling is an extent question — its mate's pane is about
    // to be the wrong shape — but the LANE is not, so paneLeft/paneRight stay.
    pockets: [],
    branchTicks: [],
    // The start-tie is a cross-member mark like the branch ticks: a member being
    // resized may be leaving the unit, so drop it rather than draw it stale.
    startTie: null,
    contentTop: null,
    contentHeight: null,
    handleTopLane: false,
    handleBottomLane: false,
    wash: 'full',
  };
}

/** The band-only layout an un-overlapped block gets inside a lane. */
function soloPlan(leftPct: number, rightPct: number): OverlapPlan {
  return {
    depth: 0,
    left: len(leftPct, 0),
    right: len(rightPct, 4),
    paneLeft: len(0, LANE_PX),
    paneRight: len(0, 0),
    railX: len(0, 5),
    beadX: len(0, 3),
    startTie: null,
    z: 2,
    zHover: HOVER_Z,
    wash: 'full',
    solid: false,
    pockets: [],
    branchTicks: [],
    beadOnPocket: false,
    contentTop: null,
    contentHeight: null,
    handleTopLane: false,
    handleBottomLane: false,
    widthFraction: (100 - leftPct - rightPct) / 100,
  };
}

/**
 * Where overlapping blocks go, as CSS lengths: `planOverlaps`, written for the
 * web's renderer. Same keys, same order, and every length is the plan's
 * `pct` and `px` through `band()`.
 */
export function layoutOverlaps(entries: OverlapEntry[], options: LayoutOptions): OverlapLayout {
  const out: OverlapLayout = new Map();
  for (const [id, plan] of planOverlaps(entries, options)) out.set(id, layoutOf(plan));
  return out;
}

/**
 * The overlap pass, in numbers. Everything in the file header and on
 * `LayoutOptions` holds here; `layoutOverlaps` is this, written as CSS.
 */
export function planOverlaps(
  entries: OverlapEntry[],
  { hourPx, gridStartMin, variant = 'day', fieldWidth, maxCols, root }: LayoutOptions
): OverlapPlans {
  const out: OverlapPlans = new Map();
  // A lone entry in a lane still needs its band; a lone entry on the open field
  // is already where it belongs.
  if (entries.length < 2) {
    if (root) for (const e of entries) out.set(e.id, soloPlan(root.leftPct, root.rightPct));
    return out;
  }

  const isWeek = variant === 'week';
  const maxDepth = isWeek ? 0 : MAX_DEPTH_DAY;

  /**
   * How many channels fit in `availPx` at the floor. An explicit `maxCols` wins;
   * with neither a width nor an override the answer is "as many as wanted", which
   * is what week relies on.
   */
  const channelsThatFit = (availPx: number, wanted: number) => {
    if (maxCols != null) return Math.max(1, Math.min(wanted, maxCols));
    if (fieldWidth == null || !Number.isFinite(availPx) || availPx <= 0) return wanted;
    return Math.max(1, Math.min(wanted, Math.floor(availPx / MIN_CHANNEL_PX)));
  };

  // ── Nodes, with both extents ─────────────────────────────────────────────
  const nodes: Node[] = entries.map((e, i) => ({
    e,
    s: e.startMin,
    t: e.startMin + e.duration,
    ps: e.startMin,
    pt: e.startMin + paintedMinutes(e.duration, hourPx),
    unit: '',
    parent: null,
    children: [],
    depth: 0,
    dom: i,
  }));

  // duration DESC puts a container before its contents; id ASC makes it stable.
  nodes.sort((a, b) => a.s - b.s || b.t - b.s - (a.t - a.s) || (a.e.id < b.e.id ? -1 : 1));

  // ── Conflict units. Project-block members are superimposed by construction,
  //    so they group by project; everything else groups by identity of extent.
  for (const n of nodes) {
    if (n.unit) continue;
    if (n.e.projectBlock) {
      const key = `pb:${n.e.projectBlock}`;
      nodes.forEach((o) => {
        if (!o.unit && o.e.projectBlock === n.e.projectBlock) o.unit = key;
      });
      continue;
    }
    const key = `id:${n.e.id}`;
    nodes.forEach((o) => {
      if (!o.unit && !o.e.projectBlock && identical(o, n)) o.unit = key;
    });
  }

  const unitSize = new Map<string, number>();
  nodes.forEach((n) => unitSize.set(n.unit, (unitSize.get(n.unit) ?? 0) + 1));

  // ── Cluster on PAINTED extents ───────────────────────────────────────────
  const clusters: Node[][] = [];
  let run: Node[] = [];
  let runEnd = -Infinity;
  for (const n of nodes) {
    if (run.length && n.ps >= runEnd) {
      clusters.push(run);
      run = [];
      runEnd = -Infinity;
    }
    run.push(n);
    runEnd = Math.max(runEnd, n.pt);
  }
  if (run.length) clusters.push(run);

  const placed: Placed[] = [];

  /** A conflict unit shares ONE band; its panes tile and each keeps its own lane. */
  function placeUnit(unit: Node[], b: Band, depth: number, cascade: number) {
    const n = unit.length;
    const ordered = unit.slice().sort((x, y) => (x.e.id < y.e.id ? -1 : 1));
    // What each member's pane is worth as a fraction of the field: the band's
    // own share, split n ways by the tiling.
    const widthFraction = ((100 - b.leftPct - b.rightPct) / 100) / n;

    ordered.forEach((node, k) => {
      const rect = paneRect(node.s, node.t - node.s, gridStartMin, hourPx);
      const painted = paneRect(
        node.s,
        paintedMinutes(node.t - node.s, hourPx),
        gridStartMin,
        hourPx
      );

      // Pane margins tile the band in n equal parts, written as percentages so
      // they resolve against the wrapper — which IS the band. No measurement
      // anywhere. Each tile reserves its OWN LANE_PX gutter at its left, so the
      // rail and bead (below) land beside that tile's pane rather than bunching
      // at the shared left edge — the fat-rail signal is gone, the start-tie
      // carries the clash instead. n === 1 (a crossing column, a nested child, a
      // lone member) resolves to the byte-identical `12px`/`0px` it always had.
      const fL = k / n;
      const fR = (n - 1 - k) / n;
      const paneLeft = len(fL * 100, LANE_PX);
      const paneRight = len(fR * 100, 0);

      // Pockets + branch ticks for this node's own children, on PAINTED extents
      // (a floored pane covers more grid than it owns).
      const pockets: Pocket[] = [];
      const ticks: number[] = [];
      for (const kid of node.children) {
        const kr = paneRect(kid.s, paintedMinutes(kid.t - kid.s, hourPx), gridStartMin, hourPx);
        pockets.push({ top: kr.top - rect.top, height: kr.height });
        ticks.push(kr.startY - rect.top);
      }

      const flushTop = node.children.some((kid) => Math.abs(kid.s - node.s) < 1);
      const flushBottom = node.children.some((kid) => Math.abs(kid.t - node.t) < 1);
      const stepped = depth >= 1 || cascade > 0;

      placed.push({
        node,
        numericBand: b,
        paneTop: rect.top,
        paneHeight: rect.height,
        paintedTop: painted.top,
        paintedBottom: painted.top + painted.height,
        depth,
        left: len(b.leftPct, b.leftPx),
        right: len(b.rightPct, b.rightPx),
        paneLeft,
        paneRight,
        // Rail and bead sit in this tile's own lane, at the tile's left + the
        // same 5px/3px a solo block uses. For n === 1 (fL === 0) that is the
        // literal '5px'/'3px'; a tiled member offsets by its tile fraction, so
        // its rail rides just left of its own pane.
        railX: len(fL * 100, 5),
        beadX: len(fL * 100, 3),
        // The clash cue: the FIRST member of a real conflict unit (>1) draws a
        // hairline from its bead across to the last member's bead. `100 / n`
        // lands its right edge under the last bead centre (band(…, 6)); the −6px
        // trims back to that centre. null for a lone member and every follower.
        startTie: n > 1 && k === 0 ? len(100 / n, -6) : null,
        /*
         * Two per level, not one, so a container's hover lift (`z + 1`) still
         * lands BELOW its own children. With a step of one there is no room
         * between a parent and its child, and lifting the parent on hover makes
         * the child permanently unreachable.
         *
         * Within a conflict unit the panes TILE rather than overlap, and each now
         * keeps its own lane, so member order needs no z of its own — nothing of
         * one member paints over another.
         */
        z: 2 + (depth + cascade) * 2,
        zHover: node.children.length ? 2 + (depth + cascade) * 2 + 1 : HOVER_Z,
        wash: node.children.length ? 'field' : 'full',
        solid: stepped,
        pockets,
        branchTicks: ticks,
        beadOnPocket: stepped,
        handleTopLane: flushTop,
        handleBottomLane: flushBottom,
        widthFraction,
      });

      // Children get the parent's band inset NEST_PX left, flush right, so the
      // two 1px borders coincide as a single hairline.
      if (node.children.length) {
        placeSiblings(
          node.children,
          { ...b, leftPx: b.leftPx + NEST_PX, rightPx: b.rightPx + NEST_RIGHT_PX },
          depth + 1
        );
      }
    });
  }

  function placeSiblings(sibs: Node[], area: Band, depth: number) {
    if (!sibs.length) return;

    // Group into conflict units; a unit occupies one column as a whole.
    const units = new Map<string, Node[]>();
    for (const n of sibs) {
      const arr = units.get(n.unit);
      if (arr) arr.push(n);
      else units.set(n.unit, [n]);
    }
    const groups = [...units.values()].sort(
      (a, b) => Math.min(...a.map((n) => n.ps)) - Math.min(...b.map((n) => n.ps))
    );

    // Greedy first-fit column packing on painted extents.
    const colEnds: number[] = [];
    const colOf = new Map<string, number>();
    for (const g of groups) {
      const gs = Math.min(...g.map((n) => n.ps));
      const gt = Math.max(...g.map((n) => n.pt));
      let c = colEnds.findIndex((end) => end <= gs);
      if (c === -1) {
        c = colEnds.length;
        colEnds.push(gt);
      } else {
        colEnds[c] = Math.max(colEnds[c], gt);
      }
      colOf.set(g[0].unit, c);
    }

    // How many channels this AREA can carry — not the whole field. A nested
    // sub-cluster is packing inside its parent's band, so it gets the parent's
    // width to spend, not the grid's.
    const availPx =
      fieldWidth == null
        ? Number.NaN
        : (fieldWidth * (100 - area.leftPct - area.rightPct)) / 100 - area.leftPx - area.rightPx;
    const cols = channelsThatFit(availPx, colEnds.length);

    for (const g of groups) {
      const rawCol = colOf.get(g[0].unit) ?? 0;
      // Past the cap the overflow falls to the INSET CASCADE inside the last
      // column, never to a titleless folded rail: a stepped plate whose title
      // the content-band pass keeps clear is strictly more readable than a
      // 12px stripe.
      const col = Math.min(rawCol, cols - 1);
      const cascade = Math.max(0, rawCol - col);

      const span = 100 - area.leftPct - area.rightPct;
      const w = span / cols;
      placeUnit(
        g,
        {
          leftPct: area.leftPct + col * w,
          leftPx: area.leftPx + (col > 0 ? COL_GAP : 0) + cascade * NEST_PX,
          rightPct: area.rightPct + (cols - 1 - col) * w,
          rightPx: area.rightPx,
        },
        depth,
        cascade
      );
    }
  }

  for (const cluster of clusters) {
    if (cluster.length < 2) continue;

    /*
     * ── Week ────────────────────────────────────────────────────────────────
     * Week has no containment vocabulary — a column is too narrow to carry the
     * pocket — so overlaps SHINGLE: right-flush, stepped, z ascending. Crossing
     * and nesting both survive that, because their extents are offset and each
     * plate still has a free band the other does not cover.
     *
     * A DOUBLE-BOOKING does not. Two identical extents have no free band to give
     * each other, so shingling leaves the lower plate as a 10px sliver with its
     * title underneath the upper one — the one topology week genuinely got wrong.
     * Those tile instead, exactly as day does, and the column widens to keep each
     * channel at MIN_CHANNEL_PX (see `widthFraction`). Week answers a crowded
     * column by growing, not by dividing, and the grid already scrolls.
     */
    if (isWeek) {
      const units = new Map<string, Node[]>();
      for (const n of cluster) {
        const arr = units.get(n.unit);
        if (arr) arr.push(n);
        else units.set(n.unit, [n]);
      }
      [...units.values()]
        .sort((a, b) => Math.min(...a.map((n) => n.ps)) - Math.min(...b.map((n) => n.ps)))
        .forEach((g, i) => {
          const step = Math.min(i, 2);
          placeUnit(
            g,
            { leftPct: 0, leftPx: step * SHINGLE_PX, rightPct: 0, rightPx: 4 },
            step,
            0
          );
        });
      continue;
    }

    // ── Containment forest. Gate in MINUTES so topology is hourPx-invariant.
    for (const c of cluster) {
      let host: Node | null = null;
      for (const p of cluster) {
        if (p === c || p.unit === c.unit) continue;
        // A member of a real double-booking may not host: its band is shared
        // with its tile-mate, so a child placed against that band would land on
        // top of the mate's pane. The child becomes a sibling instead.
        if ((unitSize.get(p.unit) ?? 1) > 1) continue;
        if (!contains(p, c)) continue;
        // Hosting must leave the parent a readable band of its own, or it is not
        // a container — it is a double-booking wearing a longer duration.
        const span = p.t - p.s;
        const largestFree = Math.max(c.s - p.s, p.t - c.t);
        if (largestFree < Math.max(MIN_HOST_FREE_MIN, span * MIN_HOST_FREE_FRAC)) continue;
        // Innermost eligible host wins.
        if (!host || p.t - p.s < host.t - host.s) host = p;
      }
      c.parent = host;
    }

    // Depth by chain walk; demote anything past maxDepth to its host's level.
    for (const c of cluster) {
      let d = 0;
      let cur = c.parent;
      while (cur) {
        d += 1;
        cur = cur.parent;
      }
      while (d > maxDepth && c.parent) {
        c.parent = c.parent.parent;
        d -= 1;
      }
      c.depth = d;
    }
    for (const c of cluster) {
      if (c.parent) c.parent.children.push(c);
    }

    placeSiblings(
      cluster.filter((c) => !c.parent),
      { leftPct: root?.leftPct ?? 0, leftPx: 0, rightPct: root?.rightPct ?? 0, rightPx: 4 },
      0
    );
  }

  // Everything the clustering skipped — a lone block, or a cluster of one. Under
  // a root band its absence would read as "the whole field"; see LayoutOptions.
  if (root) {
    const laidOut = new Set(placed.map((p) => p.node.e.id));
    for (const e of entries) {
      if (!laidOut.has(e.id)) out.set(e.id, soloPlan(root.leftPct, root.rightPct));
    }
  }

  /*
   * ── Occlusion truth, then title bands ──────────────────────────────────
   * A block's coverers are everything that PAINTS ABOVE IT and actually lands on
   * it — not just its own children. Two cases the children-only version misses:
   * a conflict unit's tile-mate, and an overflow member cascaded into an
   * already-occupied column, which steps NEST_PX off its column-mate and covers
   * it. Both leave a title sitting under a neighbour's pane.
   *
   * Coverage is tested on the coverer's PAINTED extent, because a pane floored at
   * PANE_MIN_H covers grid it does not own.
   */
  const nominal = NOMINAL_FIELD[isWeek ? 'week' : 'day'];
  for (const p of placed) {
    const rank = paintRank(p);
    const paneBottom = p.paneTop + p.paneHeight;
    const covers = placed
      .filter(
        (q) =>
          q !== p &&
          paintRank(q) > rank &&
          overlapsHorizontally(p.numericBand, q.numericBand, nominal) &&
          q.paintedTop < paneBottom &&
          p.paneTop < q.paintedBottom
      )
      .map((q) => ({ top: q.paintedTop - p.paneTop, bottom: q.paintedBottom - p.paneTop }));

    const chosen = pickContentBand(p.paneHeight, covers);
    out.set(p.node.e.id, {
      depth: p.depth,
      left: p.left,
      right: p.right,
      paneLeft: p.paneLeft,
      paneRight: p.paneRight,
      railX: p.railX,
      beadX: p.beadX,
      startTie: p.startTie,
      z: p.z,
      zHover: p.zHover,
      wash: p.wash,
      solid: p.solid,
      pockets: p.pockets,
      branchTicks: p.branchTicks,
      beadOnPocket: p.beadOnPocket,
      contentTop: chosen ? chosen.top : null,
      contentHeight: chosen ? chosen.height : null,
      handleTopLane: p.handleTopLane,
      handleBottomLane: p.handleBottomLane,
      widthFraction: p.widthFraction,
    });
  }

  return out;
}
