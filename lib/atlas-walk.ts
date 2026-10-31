import { ATLAS_COPY } from './atlas-copy';
import { formatDay } from './active';
import { canCompleteStep, canPutOnToday } from './atlas-verbs';
import { ATLAS_HANDOFF_ZOOM, clampZoom, type AtlasCamera, type Point, type Rect, type Viewport } from './atlas-camera';
import { isRecurring } from './recurrence';
import type { AtlasCard } from './atlas-model';
import type { AtlasLayout } from './view-store';

/**
 * Walk Atlas, the pure half (components/views/atlas/atlas-walk.tsx draws it):
 * the order the camera visits the cards in, the one gentle question asked at
 * each, which existing verbs it offers, and where the camera stands.
 *
 * It is a calm look, not a review that grades: every question can be answered
 * with Next, and resting is always fine (design rule 13).
 */

/**
 * The reading order Atlas's Tab follows (atlas-view.tsx): Momentum column by
 * column, the other computed layouts row by row, and Your map in the cards'
 * own order (a free map's DOM order is not moved on every drag). A card with
 * no place goes last.
 */
export function atlasReadingOrder(
  layout: AtlasLayout,
  cards: readonly Pick<AtlasCard, 'key'>[],
  positions: ReadonlyMap<string, Point>
): string[] {
  if (layout === 'map') return cards.map((c) => c.key);
  const byCols = layout === 'momentum';
  return [...cards]
    .map((c) => ({ key: c.key, p: positions.get(c.key) }))
    .sort((a, b) => {
      if (!a.p || !b.p) return a.p ? -1 : b.p ? 1 : 0;
      return byCols ? a.p.x - b.p.x || a.p.y - b.p.y : a.p.y - b.p.y || a.p.x - b.p.x;
    })
    .map((c) => c.key);
}

/**
 * Two cards on Your map whose tops are within this many world pixels read as
 * one row, so a card nudged a little lower is not visited after the whole
 * row beside it.
 */
export const WALK_ROW_SLACK = 96;

/**
 * The cards the walk visits, in the layout's reading order: only cards that
 * are drawn (a filter's hidden cards are skipped). On Your map, where Tab
 * keeps the cards' own order, the walk reads the map as it is drawn instead:
 * rows from the top, each left to right, so the camera never zig-zags.
 */
export function atlasWalkOrder(
  layout: AtlasLayout,
  cards: readonly Pick<AtlasCard, 'key'>[],
  positions: ReadonlyMap<string, Point>
): string[] {
  const drawn = cards.filter((c) => positions.has(c.key));
  if (layout !== 'map') return atlasReadingOrder(layout, drawn, positions);
  const byY = drawn
    .map((c, i) => ({ key: c.key, p: positions.get(c.key)!, i }))
    .sort((a, b) => a.p.y - b.p.y || a.p.x - b.p.x || a.i - b.i);
  const out: string[] = [];
  let row: typeof byY = [];
  const flush = () => {
    row.sort((a, b) => a.p.x - b.p.x || a.i - b.i);
    out.push(...row.map((r) => r.key));
    row = [];
  };
  for (const c of byY) {
    if (row.length > 0 && c.p.y - row[0].p.y > WALK_ROW_SLACK) flush();
    row.push(c);
  }
  flush();
  return out;
}

/** What kind of stop a card is, which picks its question. */
export type WalkStopKind = 'next' | 'goal' | 'empty' | 'resting' | 'ended';

/** A button the walk offers at a stop, beside its own Back, Next and Done. */
export type WalkActionId = 'today' | 'complete' | 'organize';

export interface WalkAction {
  id: WalkActionId;
  label: string;
}

export interface WalkStop {
  kind: WalkStopKind;
  question: string;
  detail: string | null;
  actions: WalkAction[];
}

/**
 * The stop for one card. The question follows the card's state:
 *
 * - finished as a container (an achieved goal, a season past its days): no
 *   question at all, "All wrapped up", and only Next;
 * - resting (a known old touch or a pause): "Still want this?", and waking it
 *   is putting its next step on Today when that verb may run;
 * - nothing open: "What's the next step?", with Organize to add one;
 * - a goal with a target day: "Still aiming for <day>?";
 * - otherwise: "Still the right next step?", naming it, with Put on Today and
 *   Mark the step done when their gates allow.
 *
 * Every verb is gated as the focus sheet gates it (lib/atlas-verbs.ts): no
 * Put on Today for a milestone or a recurring step, ever.
 */
export function walkStopOf(card: AtlasCard, todayStr: string, milestoneIds: ReadonlySet<string>): WalkStop {
  const next = card.next;
  const today =
    !!next && card.nextOffersToday && canPutOnToday(next, todayStr, milestoneIds) ? next : null;
  const complete = !!next && canCompleteStep(next, todayStr, milestoneIds) ? next : null;
  const completeLabel =
    complete && isRecurring(complete.item as { repeatFrequency?: string })
      ? ATLAS_COPY.walkCompleteToday
      : ATLAS_COPY.walkComplete;
  const organize: WalkAction = { id: 'organize', label: ATLAS_COPY.openInOrganize };

  if (card.touch.kind === 'ended') {
    return { kind: 'ended', question: ATLAS_COPY.walkEndedQuestion, detail: ATLAS_COPY.walkEndedDetail, actions: [] };
  }

  if (card.resting) {
    const t = card.touch;
    const detail =
      t.kind === 'resting'
        ? ATLAS_COPY.walkRestingSince(formatDay(t.since))
        : t.kind === 'paused'
          ? t.until
            ? ATLAS_COPY.walkPausedTill(formatDay(t.until))
            : ATLAS_COPY.walkPaused
          : null;
    const actions: WalkAction[] = [];
    if (today) actions.push({ id: 'today', label: ATLAS_COPY.walkWake });
    if (!next) actions.push(organize);
    return { kind: 'resting', question: ATLAS_COPY.walkRestingQuestion, detail, actions };
  }

  if (!next) {
    return {
      kind: 'empty',
      question: ATLAS_COPY.walkEmptyQuestion,
      detail: card.allDone ? ATLAS_COPY.walkEmptyAllDone : card.members.length === 0 ? ATLAS_COPY.walkEmptyNothing : null,
      actions: [organize],
    };
  }

  const actions: WalkAction[] = [];
  if (today) actions.push({ id: 'today', label: ATLAS_COPY.walkPutOnToday });
  if (complete) actions.push({ id: 'complete', label: completeLabel });

  if (card.kind === 'goal' && card.targetOn) {
    return {
      kind: 'goal',
      question: ATLAS_COPY.walkGoalQuestion(formatDay(card.targetOn)),
      detail: ATLAS_COPY.walkGoalDetail(next.item.title),
      actions,
    };
  }

  return {
    kind: 'next',
    question: ATLAS_COPY.walkNextQuestion,
    detail: ATLAS_COPY.walkNextDetail(next.item.title),
    actions,
  };
}

/** The lowest zoom a stop shows a card at: above the handoff band, so it is a card. */
export const WALK_MIN_ZOOM = Math.max(0.7, ATLAS_HANDOFF_ZOOM + 0.05);
/** The highest: a card is shown at a comfortable size, never blown up. */
export const WALK_MAX_ZOOM = 1.1;
/** Screen room kept clear at the bottom for the walk's panel. */
export const WALK_PANEL_ROOM = 200;

/**
 * Where the camera stands for a stop: the card centred in the room above the
 * panel, at a readable zoom. A card taller than that room is aligned to its
 * top. Hands back `fallback` for a zero-size viewport (jsdom).
 */
export function walkCamera(
  rect: Rect,
  viewport: Viewport,
  fallback: AtlasCamera,
  panelRoom = WALK_PANEL_ROOM,
  pad = 32
): AtlasCamera {
  if (viewport.w <= 0 || viewport.h <= 0) return fallback;
  const availW = Math.max(1, viewport.w - pad * 2);
  const availH = Math.max(1, viewport.h - panelRoom - pad * 2);
  const fit = Math.min(WALK_MAX_ZOOM, availW / Math.max(1, rect.w), availH / Math.max(1, rect.h));
  const z = clampZoom(Math.max(WALK_MIN_ZOOM, fit));
  const x = viewport.w / 2 - (rect.x + rect.w / 2) * z;
  const y =
    rect.h * z > availH ? pad - rect.y * z : pad + availH / 2 - (rect.y + rect.h / 2) * z;
  return { x, y, z };
}

/** The camera's flight between stops should play the far zoom handoff when it starts zoomed out. */
export function walkFlightFlourishes(from: AtlasCamera): boolean {
  return from.z < ATLAS_HANDOFF_ZOOM;
}

/**
 * The cut-out's path: the whole board, with a rounded hole around one screen
 * rect. Drawn with fill-rule evenodd, so the hole is unpainted and a press in
 * it reaches the card below.
 */
export function walkScrimPath(hole: Rect | null, radius: number): string {
  const outer = 'M-20000 -20000H40000V40000H-20000Z';
  if (!hole || !(hole.w > 0) || !(hole.h > 0)) return outer;
  const r = Math.max(0, Math.min(radius, hole.w / 2, hole.h / 2));
  const { x, y, w, h } = hole;
  const f = (n: number) => Math.round(n * 10) / 10;
  return (
    `${outer}M${f(x + r)} ${f(y)}H${f(x + w - r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + w)} ${f(y + r)}` +
    `V${f(y + h - r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + w - r)} ${f(y + h)}` +
    `H${f(x + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x)} ${f(y + h - r)}` +
    `V${f(y + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x + r)} ${f(y)}Z`
  );
}

/** A linear blend of two rects, for the cut-out's move between cards. */
export function lerpRect(a: Rect, b: Rect, t: number): Rect {
  const k = Math.max(0, Math.min(1, t));
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k };
}

/**
 * The walk's route, kept for the length of one walk (atlas-walk.tsx), so
 * Next never skips or repeats a card when the board changes under it: a verb
 * that re-sorts Momentum, a drag on Your map, a Realtime catch-up.
 *
 * - The first route is the reading order as the walk starts.
 * - After that, a card that has gone is dropped where it stood, and a card
 *   that shows up (a new one, a filter turned off) joins at the end, in the
 *   reading order.
 * - A layout switch (`relayout`) keeps the cards already seen in front, in the
 *   order they were seen, then the card the walk stands on, then everything
 *   still to come in the new layout's reading order, so the camera does not
 *   zig-zag across the new arrangement and still visits each card once.
 *
 * Hands back `route` itself when nothing changed.
 */
export function reconcileWalkRoute(
  route: readonly string[],
  live: readonly string[],
  current: string | null,
  relayout = false
): readonly string[] {
  if (route.length === 0) return live.slice();
  const liveSet = new Set(live);
  const at = relayout && current !== null && liveSet.has(current) ? route.indexOf(current) : -1;
  let next: string[];
  if (at >= 0) {
    const head = route.slice(0, at).filter((k) => liveSet.has(k));
    head.push(current as string);
    const headSet = new Set(head);
    next = [...head, ...live.filter((k) => !headSet.has(k))];
  } else {
    const kept = route.filter((k) => liveSet.has(k));
    const keptSet = new Set(kept);
    next = [...kept, ...live.filter((k) => !keptSet.has(k))];
  }
  return next.length === route.length && next.every((k, i) => k === route[i]) ? route : next;
}

/** World pixels above a card that its hover bar (Focus, Open) takes (atlas-card.tsx: -top-8, plus its gap). */
export const WALK_HOVERBAR_ROOM = 36;

/**
 * The cut-out on screen for a card's world rect: `pad` screen pixels all
 * round, and room above for the card's hover bar, so Focus and Open stay
 * bright and reachable during a walk.
 */
export function walkHoleRect(world: Rect, cam: AtlasCamera, pad: number, topRoom = WALK_HOVERBAR_ROOM): Rect {
  const top = topRoom * cam.z;
  return {
    x: world.x * cam.z + cam.x - pad,
    y: world.y * cam.z + cam.y - pad - top,
    w: world.w * cam.z + pad * 2,
    h: world.h * cam.z + pad * 2 + top,
  };
}
