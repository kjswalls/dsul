import type { Season } from './planner-types';
import type { AtlasCard } from './atlas-model';
import type { AtlasBand } from './atlas-positions';
import type { AtlasLayout } from './view-store';
import type { Point, Rect } from './atlas-camera';
import { ATLAS_CARD_H, ATLAS_CARD_W } from './atlas-seed';
import { MOMENTUM_BANDS, bandHint, bandLabel, type MomentumResult } from './atlas-momentum';
import { ATLAS_COPY } from './atlas-copy';
import {
  TIMELINE_DAY_PX,
  goalTargetSpan,
  latestTimelineDate,
  timelinePlace,
  timelineWidth,
  timelineWindow,
  xForDate,
  type TimelinePlace,
  type TimelineWindow,
} from './atlas-timeline';

/**
 * Where every card sits in each Atlas layout (design PR2). Pure.
 *
 * Your map returns the stored places. Momentum, By goal and Timeline are
 * computed on every render and never stored (only Momentum's pins are, in
 * atlas_positions.pinned_band): a layout is a lens, so switching never edits.
 *
 * The same filters apply in every layout: Hide finished and Hide resting.
 */

/** A card's slot height in the computed layouts (the seeding estimate plus a gap). */
export const ATLAS_SLOT_H = ATLAS_CARD_H + 20;
const GAP = 22;

export interface AtlasFilters {
  hideFinished: boolean;
  hideResting: boolean;
}

export interface AtlasLane {
  /** 'now' | 'soon' | 'resting', a goal id, 'none', or a 'tl:' Timeline row. */
  id: string;
  kind: 'band' | 'goal' | 'none' | 'timeline';
  label: string;
  hint?: string;
  count: number;
  rect: Rect;
  /** The goal's colour, for the lane's square. */
  color?: string;
  /** A drag can end here and mean something. */
  drop: boolean;
}

export interface AtlasSeasonBar {
  key: string;
  label: string;
  color: string;
  x: number;
  y: number;
  w: number;
}

export interface AtlasTimelineDecor {
  window: TimelineWindow;
  months: { start: string; label: string; x: number; w: number }[];
  seasonBars: AtlasSeasonBar[];
  todayX: number;
  height: number;
  width: number;
  /** Where "No dates" begins: a goal dropped above it takes a date. */
  noDatesY: number;
}

export interface AtlasLayoutResult {
  positions: Map<string, Point>;
  lanes: AtlasLane[];
  timeline: AtlasTimelineDecor | null;
  /**
   * The lane each card is DRAWN in (an AtlasLane id), in the computed
   * layouts. A drop reads its "from" here, never re-derives it, so what a
   * drag means always matches what the screen shows.
   */
  cardLane: Map<string, string>;
}

export interface AtlasLayoutCtx {
  /** Your map's places (stored, else seeded). */
  places: Readonly<Record<string, Point>>;
  /** Momentum's answer per card key. */
  bands: ReadonlyMap<string, MomentumResult>;
  /** By goal's lane per card key (a goal id, or null). */
  lanes?: ReadonlyMap<string, string | null>;
  /**
   * By goal: every goal card, filtered or not. A goal a filter hides still
   * gets a lane (a heading, no head card) while a visible card feeds it, so a
   * card is never drawn under "Not feeding a goal" while it feeds one.
   */
  goalCards?: readonly AtlasCard[];
  seasons?: readonly Season[];
  todayStr: string;
}

/** Finished: an ended container, or one whose every member is done today. */
export function isFinished(card: AtlasCard): boolean {
  if (card.touch.kind === 'ended') return true;
  return card.members.length > 0 && card.members.every((m) => m.state === 'lit');
}

export function hiddenBy(filters: AtlasFilters, card: AtlasCard, band: AtlasBand | undefined): boolean {
  if (filters.hideFinished && isFinished(card)) return true;
  if (filters.hideResting && band === 'resting') return true;
  return false;
}

export function filterCards(
  cards: readonly AtlasCard[],
  filters: AtlasFilters,
  bands: ReadonlyMap<string, MomentumResult>,
): AtlasCard[] {
  if (!filters.hideFinished && !filters.hideResting) return cards as AtlasCard[];
  return cards.filter((c) => !hiddenBy(filters, c, bands.get(c.key)?.band));
}

export function layoutPositions(
  layout: AtlasLayout,
  cards: readonly AtlasCard[],
  ctx: AtlasLayoutCtx,
): AtlasLayoutResult {
  if (layout === 'momentum') return momentumLayout(cards, ctx);
  if (layout === 'goal') return goalLayout(cards, ctx);
  if (layout === 'timeline') return timelineLayout(cards, ctx);
  const positions = new Map<string, Point>();
  for (const c of cards) {
    const p = ctx.places[c.key];
    if (p) positions.set(c.key, p);
  }
  return { positions, lanes: [], timeline: null, cardLane: new Map() };
}

/* ── Momentum: three columns ───────────────────────────────────────────── */

const COL_W = ATLAS_CARD_W + 40;
const COL_GAP = 32;
const COL_HEAD = 64;

function momentumLayout(cards: readonly AtlasCard[], ctx: AtlasLayoutCtx): AtlasLayoutResult {
  const positions = new Map<string, Point>();
  const cardLane = new Map<string, string>();
  const by: Record<AtlasBand, AtlasCard[]> = { now: [], soon: [], resting: [] };
  for (const c of cards) {
    const band = ctx.bands.get(c.key)?.band ?? 'soon';
    by[band].push(c);
    cardLane.set(c.key, band);
  }
  const tallest = Math.max(...MOMENTUM_BANDS.map((b) => by[b].length), 1);
  const h = Math.max(480, COL_HEAD + tallest * ATLAS_SLOT_H + 12);
  const lanes = MOMENTUM_BANDS.map((band, i): AtlasLane => {
    const x = i * (COL_W + COL_GAP);
    by[band].forEach((c, j) => positions.set(c.key, { x: x + 20, y: COL_HEAD + j * ATLAS_SLOT_H }));
    return {
      id: band,
      kind: 'band',
      label: bandLabel(band),
      hint: bandHint(band),
      count: by[band].length,
      rect: { x, y: 0, w: COL_W, h },
      drop: true,
    };
  });
  return { positions, lanes, timeline: null, cardLane };
}

/* ── By goal: a lane per goal, then "Not feeding a goal" ───────────────── */

const LANE_HEAD = 52;
const LANE_GAP = 18;
const PER_ROW = 4;
const LANE_PAD = 24;
const GOAL_SLOT = ATLAS_CARD_W + 60;
const LANE_W = LANE_PAD * 2 + GOAL_SLOT + PER_ROW * (ATLAS_CARD_W + GAP) - GAP;

function goalLayout(cards: readonly AtlasCard[], ctx: AtlasLayoutCtx): AtlasLayoutResult {
  const positions = new Map<string, Point>();
  const cardLane = new Map<string, string>();
  const shown = new Set(cards.filter((c) => c.kind === 'goal').map((c) => c.key));
  const heads = ctx.goalCards ?? cards.filter((c) => c.kind === 'goal');
  const feeders = new Map<string | null, AtlasCard[]>([[null, []]]);
  for (const g of heads) feeders.set(g.id, []);
  for (const c of cards) {
    if (c.kind === 'goal') continue;
    let lane = ctx.lanes?.get(c.key) ?? null;
    if (!feeders.has(lane)) lane = null;
    feeders.get(lane)!.push(c);
    cardLane.set(c.key, lane ?? 'none');
  }
  const lanes: AtlasLane[] = [];
  let y = 0;
  // `head` names the lane; `drawHead` is false for a goal a filter hides,
  // whose lane keeps its heading and its feeders but draws no head card.
  const lay = (head: AtlasCard | null, list: AtlasCard[], drawHead: boolean) => {
    const top = y;
    const x0 = head ? LANE_PAD + GOAL_SLOT : LANE_PAD;
    const perRow = head ? PER_ROW : PER_ROW + 1;
    if (head && drawHead) {
      positions.set(head.key, { x: LANE_PAD, y: top + LANE_HEAD });
      cardLane.set(head.key, head.id);
    }
    list.forEach((c, i) => {
      positions.set(c.key, {
        x: x0 + (i % perRow) * (ATLAS_CARD_W + GAP),
        y: top + LANE_HEAD + Math.floor(i / perRow) * ATLAS_SLOT_H,
      });
    });
    const rows = Math.max(1, Math.ceil(list.length / perRow));
    const h = LANE_HEAD + rows * ATLAS_SLOT_H + 4;
    lanes.push({
      id: head ? head.id : 'none',
      kind: head ? 'goal' : 'none',
      label: head ? head.name : ATLAS_COPY.notFeeding,
      hint: head ? ATLAS_COPY.laneHintLink : ATLAS_COPY.laneHintUnlink,
      count: list.length,
      rect: { x: 0, y: top, w: LANE_W, h },
      color: head?.color,
      drop: true,
    });
    y = top + h + LANE_GAP;
  };
  for (const g of heads) {
    const list = feeders.get(g.id) ?? [];
    const drawHead = shown.has(g.key);
    if (drawHead || list.length > 0) lay(g, list, drawHead);
  }
  lay(null, feeders.get(null) ?? [], false);
  return { positions, lanes, timeline: null, cardLane };
}

/* ── Timeline: months, season bars, rows ───────────────────────────────── */

const MONTH_HEAD = 28;
const BAR_PITCH = 28;
const ROW_HEAD = 26;
const DIAMOND_ROOM = 18;
const NO_DATES_PER_ROW = 5;

/** First row whose last card ends left of `x`; grows the rows as needed. */
function packRow(rows: number[], x: number, w: number): number {
  let r = 0;
  while (rows[r] !== undefined && rows[r] > x - GAP) r += 1;
  rows[r] = x + w;
  return r;
}

function timelineLayout(cards: readonly AtlasCard[], ctx: AtlasLayoutCtx): AtlasLayoutResult {
  const positions = new Map<string, Point>();
  const cardLane = new Map<string, string>();
  const seasonsById = new Map((ctx.seasons ?? []).map((s) => [s.id, s]));
  const placed = cards.map((c) => [c, timelinePlace(c, ctx.todayStr, seasonsById)] as const);
  const places = placed.map(([, p]) => p);
  const win = timelineWindow(ctx.todayStr, latestTimelineDate(places), goalTargetSpan(places));
  const width = timelineWidth(win);
  const clampX = (x: number, w = 0) => Math.max(0, Math.min(width - w, x));
  const todayX = xForDate(win, ctx.todayStr);

  // Season bars, packed into rows under the month heads.
  const seasonBars: AtlasSeasonBar[] = [];
  const barRows: number[] = [];
  for (const [c, p] of placed) {
    if (c.kind !== 'season' || p.lane !== 'dated') continue;
    const x = clampX(xForDate(win, p.day));
    const end = p.until ? clampX(xForDate(win, p.until) + TIMELINE_DAY_PX) : width;
    const w = Math.max(TIMELINE_DAY_PX * 3, end - x);
    const r = packRow(barRows, x, w);
    seasonBars.push({ key: c.key, label: c.name, color: c.color, x, w, y: MONTH_HEAD + 8 + r * BAR_PITCH });
  }
  const barsBottom = MONTH_HEAD + 8 + barRows.length * BAR_PITCH;

  const lanes: AtlasLane[] = [];
  let y = barsBottom + 12;
  const row = (id: string, label: string, list: (readonly [AtlasCard, TimelinePlace])[], place: (list: (readonly [AtlasCard, TimelinePlace])[], top: number) => number) => {
    const top = y;
    for (const [c] of list) cardLane.set(c.key, id);
    const used = place(list, top + ROW_HEAD);
    const h = ROW_HEAD + Math.max(1, used) * ATLAS_SLOT_H;
    lanes.push({ id, kind: 'timeline', label, count: list.length, rect: { x: 0, y: top, w: width, h }, drop: false });
    y = top + h + 12;
  };

  // Routines: a strip from today, left to right.
  row('tl:repeats', ATLAS_COPY.laneRepeats, placed.filter(([, p]) => p.lane === 'repeats'), (list, top) => {
    list.forEach(([c], i) => positions.set(c.key, { x: clampX(todayX + i * (ATLAS_CARD_W + GAP), ATLAS_CARD_W), y: top }));
    return 1;
  });

  // Goals: each hangs below its diamond, centred on its target day.
  row('tl:goals', ATLAS_COPY.laneGoals, placed.filter(([, p]) => p.lane === 'goals'), (list, top) => {
    const rows: number[] = [];
    const sorted = [...list].sort((a, b) => ((a[1] as { day: string }).day < (b[1] as { day: string }).day ? -1 : 1));
    for (const [c, p] of sorted) {
      const day = (p as { day: string }).day;
      const x = xForDate(win, day) + TIMELINE_DAY_PX / 2 - ATLAS_CARD_W / 2;
      const r = packRow(rows, x, ATLAS_CARD_W);
      positions.set(c.key, { x, y: top + DIAMOND_ROOM + r * ATLAS_SLOT_H });
    }
    return Math.max(1, rows.length);
  });

  // Dated: projects at their next dated step, seasons at their start.
  row('tl:dated', ATLAS_COPY.laneDated, placed.filter(([, p]) => p.lane === 'dated'), (list, top) => {
    const rows: number[] = [];
    const sorted = [...list].sort((a, b) => ((a[1] as { day: string }).day < (b[1] as { day: string }).day ? -1 : 1));
    for (const [c, p] of sorted) {
      const x = clampX(xForDate(win, (p as { day: string }).day), ATLAS_CARD_W);
      const r = packRow(rows, x, ATLAS_CARD_W);
      positions.set(c.key, { x, y: top + r * ATLAS_SLOT_H });
    }
    return Math.max(1, rows.length);
  });

  // No dates: a grid from today.
  const noDatesY = y;
  row('tl:none', ATLAS_COPY.laneNoDates, placed.filter(([, p]) => p.lane === 'none'), (list, top) => {
    const left = clampX(todayX, NO_DATES_PER_ROW * (ATLAS_CARD_W + GAP));
    list.forEach(([c], i) =>
      positions.set(c.key, {
        x: left + (i % NO_DATES_PER_ROW) * (ATLAS_CARD_W + GAP),
        y: top + Math.floor(i / NO_DATES_PER_ROW) * ATLAS_SLOT_H,
      }),
    );
    return Math.ceil(list.length / NO_DATES_PER_ROW);
  });

  return {
    positions,
    lanes,
    timeline: {
      window: win,
      months: win.months,
      seasonBars,
      todayX,
      height: y,
      width,
      noDatesY,
    },
    cardLane,
  };
}

/* ── hit testing ───────────────────────────────────────────────────────── */

/**
 * The lane a card dropped at `topLeft` lands in: by the card's centre line,
 * x for Momentum's columns, y for By goal's lanes. Null outside every lane.
 */
export function laneAt(result: AtlasLayoutResult, layout: AtlasLayout, topLeft: Point): AtlasLane | null {
  const cx = topLeft.x + ATLAS_CARD_W / 2;
  const cy = topLeft.y + 40;
  for (const lane of result.lanes) {
    if (!lane.drop) continue;
    const r = lane.rect;
    if (layout === 'momentum' && cx >= r.x && cx <= r.x + r.w) return lane;
    if (layout === 'goal' && cy >= r.y && cy <= r.y + r.h && cx >= r.x - 200 && cx <= r.x + r.w + 200) return lane;
  }
  return null;
}

/**
 * A function that hands back the previous Point for every card whose place
 * did not change, so memo(AtlasCard) skips it: a tick that re-sorts nothing
 * re-renders one card. One per mounted Atlas (kept in state).
 */
export function createPositionSharer(): (next: Map<string, Point>) => Map<string, Point> {
  let last: Map<string, Point> | null = null;
  return (next) => {
    last = stablePositions(last, next);
    return last;
  };
}

/** {@link createPositionSharer}'s step, for one previous map. */
export function stablePositions(
  prev: ReadonlyMap<string, Point> | null,
  next: Map<string, Point>,
): Map<string, Point> {
  if (!prev) return next;
  for (const [k, p] of next) {
    const old = prev.get(k);
    if (old && old.x === p.x && old.y === p.y) next.set(k, old);
  }
  return next;
}
