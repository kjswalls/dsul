'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import { toast } from 'sonner';
import { AtlasSurface } from '@/components/views/atlas/atlas-surface';
import { AtlasCard, ATLAS_GLIDE_MS, ATLAS_LEAVE_MS, ATLAS_TICK_HOLD_MS } from '@/components/views/atlas/atlas-card';
import { AtlasLanes } from '@/components/views/atlas/atlas-lanes';
import { useAtlasActivity } from '@/components/views/atlas/use-atlas-activity';
import { AtlasFocusSheet } from '@/components/views/atlas/atlas-focus-sheet';
import { AtlasFarCanvas, type FarCluster, type FarScene } from '@/components/views/atlas/atlas-far-canvas';
import { AtlasHandoffCanvas } from '@/components/views/atlas/atlas-handoff-canvas';
import { AtlasMinimap } from '@/components/views/atlas/atlas-minimap';
import { AtlasStrands } from '@/components/views/atlas/atlas-strands';
import { strandPolicy, type AtlasFrameSpec, type AtlasStrandLink } from '@/lib/atlas-strands';
import { AtlasDropRemeasure } from '@/components/views/atlas/atlas-card-drop';
import { useAtlasColors, useAtlasLightContext } from '@/components/views/atlas/use-atlas-colors';
import { useLookStore } from '@/lib/look-store';
import { ATLAS_GRID_PITCH, buildRelayGrid, liveness } from '@/lib/atlas-relay-grid';
import {
  ATLAS_FLY_TOTAL_MS,
  ATLAS_MOTION,
  armPinSettle,
  easeInOutCubic,
  flourishAt,
  glideDelay,
} from '@/lib/atlas-motion';
import { ATLAS_DUSK_GROUND } from '@/lib/atlas-tones';
import { cn } from '@/lib/utils';
import { useAtlasCards } from '@/components/views/atlas/use-atlas-cards';
import { useAtlasUiStore } from '@/lib/atlas-ui-store';
import { useAtlasStore } from '@/lib/atlas-store';
import type { AtlasPlace } from '@/lib/atlas-positions';
import { usePlannerStore } from '@/lib/planner-store';
import {
  ATLAS_FAR_ZOOM,
  ATLAS_FIT_FLOOR,
  ATLAS_FLY_ZOOM,
  ATLAS_HANDOFF_ZOOM,
  centerOn,
  handoffProgress,
  centerOnPoint,
  ensureVisible,
  fitBounds,
  flyCamera,
  type AtlasCamera,
  type Point,
  type Rect,
  type Viewport,
} from '@/lib/atlas-camera';
import { usePlannerPreviewing, usePlannerSettled } from '@/lib/planner-ready';
import { ATLAS_CARD_H, ATLAS_CARD_W, seedPlaces } from '@/lib/atlas-seed';
import { ATLAS_COPY } from '@/lib/atlas-copy';
import type { AtlasCard as AtlasCardModel } from '@/lib/atlas-model';
import type { AtlasBand } from '@/lib/atlas-positions';
import { useViewStore } from '@/lib/view-store';
import { effectiveAtlasLayout } from '@/lib/view-options';
import { bandLabel, momentumBand, type MomentumResult } from '@/lib/atlas-momentum';
import { feedsOf, laneFor } from '@/lib/atlas-by-goal';
import {
  filterCards,
  laneAt,
  createPositionSharer,
  layoutPositions,
  type AtlasLayoutResult,
} from '@/lib/atlas-layouts';
import { timelinePlace } from '@/lib/atlas-timeline';
import { dropCard, goalDayAtClamped } from '@/lib/atlas-drop';
import { formatDay } from '@/lib/active';
import { useAtlasReducedMotion } from '@/components/views/atlas/use-atlas-reduced-motion';

/**
 * The viewport seeding lays a grid out against. Fixed rather than measured, so
 * opening the item rail (which narrows <main> by 432px) never reshuffles where
 * new cards land.
 */
const SEED_VIEWPORT: Viewport = { w: 1600, h: 900 };

/** A click on a far cluster flies in over this long (instant under reduced motion). */
const ATLAS_FLY_MS = ATLAS_MOTION.flyMs;

/** The ground's paper-to-slate change under Dusk. */
const ATLAS_GROUND_MS = 400;

/**
 * Atlas: the user's projects, routines, seasons and goals as cards on a map
 * (design PR1a). The third ViewScope, desktop only.
 *
 * Positions (PR1b) come from lib/atlas-store.ts: the account's rows in
 * `atlas_positions`, or this device's blob until 087 is applied. The store
 * loads on the first mount once the planner has settled and is not a cached
 * preview, and the cards wait for its answer, so a stored place never jumps
 * in over a seeded one. A card with no place is seeded (`seedPlaces()`) and
 * that seed is written once, so "Your map is never overwritten" holds: a new
 * container lands beside its goal or season the first time Atlas sees it.
 * With no account (a test) or a read that threw, seeds stay in memory and
 * nothing is written. Nothing is written while previewing or before settled.
 *
 * The root is focusable (`tabIndex={-1}`) and `overflow: clip`, not hidden:
 * a hidden box is a scroll container, and a focused off-screen card would
 * scroll it out of step with the camera. There is no canvas-container inside
 * (design D7): the header row goes wide through useCanvasWide instead.
 */
export function AtlasView({ activeId }: { activeId?: string | null }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { cards, todayStr, tz, milestoneIds, collectionsShown, goalsShown, goals, seasons } = useAtlasCards();
  const layoutPref = useViewStore((s) => s.atlasLayout);
  const hideFinished = useViewStore((s) => s.atlasHideFinished);
  const hideResting = useViewStore((s) => s.atlasHideResting);
  // A remembered By goal reads as Your map while Goals is off.
  const layout = effectiveAtlasLayout(layoutPref, goalsShown);
  const reduced = useAtlasReducedMotion();
  const settled = usePlannerSettled();
  const previewing = usePlannerPreviewing();
  // A press inside the map focuses what it lands on; that focus must not pan
  // (the card would move out from under the press). Only keyboard focus pans.
  const pointerDown = useRef(false);
  const userId = usePlannerStore((s) => s.userId);
  const atlasUser = useAtlasStore((s) => s.userId);
  const atlasLoaded = useAtlasStore((s) => s.loaded);
  const atlasFailed = useAtlasStore((s) => s.failed);
  const atlasMode = useAtlasStore((s) => s.mode);
  const stored = useAtlasStore((s) => s.places);
  const expanded = useAtlasUiStore((s) => s.expanded);
  const fitToken = useAtlasUiStore((s) => s.fitToken);
  const seeded = useAtlasUiStore((s) => s.seeded);
  const sheetOpen = useAtlasUiStore((s) => s.sheet !== null);
  // The far zoom (PR3): below 0.5 the cards give way to the canvas; from 0.6
  // down to 0.5 both are drawn and the cards shrink toward their clusters.
  const far = useAtlasUiStore((s) => s.camera.z < ATLAS_FAR_ZOOM);
  // The zoom's own band (Dusk's latch reads only this), and the handoff
  // drawn: the band, or a fly-in's flourish playing past it.
  const zoomBand = useAtlasUiStore((s) => s.camera.z < ATLAS_HANDOFF_ZOOM);
  const inBand = useAtlasUiStore((s) => s.camera.z < ATLAS_HANDOFF_ZOOM || s.flourish !== null);
  const flourishing = useAtlasUiStore((s) => s.flourish !== null);
  // The overlay of tiles in flight is drawn only where the handoff can be
  // strictly between its ends: the band itself, or a fly-in's flourish. At
  // the far zoom (0.5 and down) every tile is the constellation canvas's, so
  // a pan there clears no full-screen canvas.
  const handoffLive = useAtlasUiStore(
    (s) => s.flourish !== null || (s.camera.z < ATLAS_HANDOFF_ZOOM && s.camera.z > ATLAS_FAR_ZOOM)
  );
  const farPaper = useLookStore((s) => s.atlasFarPaper);
  const islandRef = useRef<HTMLDivElement>(null);
  // Read from the root, outside the island, so Dusk's own `.dark` never
  // answers the question that turns it on.
  const lightContext = useAtlasLightContext(rootRef);
  // Dusk latches on below 0.5 and lets go only at 0.6 (design 3.3), so a
  // pinch that hovers at 0.5 doesn't flip the board back and forth. The cards
  // in the band on the way back in sit on the slate, inside `.dark`.
  const [duskZoom, setDuskZoom] = useState(far);
  // A fly-in leaves the band in about 30ms while its flourish is still
  // assembling the cards, so the latch holds through the flourish too:
  // nothing recolours mid-flourish.
  const nextDuskZoom = far ? true : zoomBand || flourishing ? duskZoom : false;
  if (nextDuskZoom !== duskZoom) setDuskZoom(nextDuskZoom);
  const dusk = nextDuskZoom && lightContext && farPaper === 'dusk';
  // The ground fades to slate over ATLAS_GROUND_MS; the island takes `.dark`
  // (and the canvas its glow and pale labels) only once it has, so nothing
  // glows on paper. Going back, both let go at once.
  const [duskInk, setDuskInk] = useState(false);
  if (!dusk && duskInk) setDuskInk(false);
  if (dusk && reduced && !duskInk) setDuskInk(true);
  useEffect(() => {
    if (!dusk || duskInk) return;
    const t = setTimeout(() => setDuskInk(true), ATLAS_GROUND_MS);
    return () => clearTimeout(t);
  }, [dusk, duskInk]);
  const duskDark = dusk && duskInk;
  const [viewport, setViewport] = useState<Viewport>({ w: 0, h: 0 });
  // The latest viewport for the callbacks below, written where it is measured
  // (never during render), so a resize never re-renders a card.
  const viewportRef = useRef(viewport);

  // The cards wait for the store's first answer (with no account there is
  // none to wait for), so a stored place never replaces a seeded one on screen.
  const ready = !userId || (atlasUser === userId && atlasLoaded);
  // Places may be written: an account whose places have answered, settled,
  // not a preview, and not after a read that threw (a seed written then could
  // land over a place the server has and this tab has not seen).
  const writable =
    !!userId && ready && settled && !previewing && !atlasFailed && (atlasMode === 'account' || atlasMode === 'device');

  const storedXY = useMemo(() => {
    const out: Record<string, Point> = {};
    for (const [key, p] of Object.entries(stored)) {
      if (p.x !== null && p.y !== null) out[key] = { x: p.x, y: p.y };
    }
    return out;
  }, [stored]);
  const places = useMemo(() => ({ ...seeded, ...storedXY }), [seeded, storedXY]);

  // Momentum's band per card (and Hide resting's, in every layout). The
  // activity side channel reads only while a layout or filter needs it.
  const activity = useAtlasActivity(cards, {
    enabled: (layout === 'momentum' || hideResting) && !!userId && settled && !previewing,
    todayStr,
    tz,
  });
  const bands = useMemo(() => {
    const out = new Map<string, MomentumResult>();
    for (const c of cards) {
      out.set(c.key, momentumBand(c, activity.get(c.key), todayStr, stored[c.key]?.band ?? null, milestoneIds));
    }
    return out;
  }, [cards, activity, todayStr, stored, milestoneIds]);
  const visible = useMemo(
    () => filterCards(cards, { hideFinished, hideResting }, bands),
    [cards, hideFinished, hideResting, bands]
  );
  const lanes = useMemo(
    () => (layout === 'goal' ? new Map(cards.map((c) => [c.key, laneFor(c, goals)])) : undefined),
    [layout, cards, goals]
  );
  const goalCards = useMemo(() => cards.filter((c) => c.kind === 'goal'), [cards]);
  const [sharePositions] = useState(createPositionSharer);
  const computed: AtlasLayoutResult = useMemo(() => {
    const r = layoutPositions(layout, visible, { places, bands, lanes, goalCards, seasons, todayStr });
    return { ...r, positions: sharePositions(r.positions) };
  }, [sharePositions, layout, visible, places, bands, lanes, goalCards, seasons, todayStr]);

  // A tick in a computed layout can re-sort the card (Soon to Now, a next
  // step moving on the Timeline, Hide finished taking it away). The layout
  // drawn before the tick is held, as each card holds its ticked row, until
  // ATLAS_TICK_HOLD_MS has passed and the pointer is off every card, so a
  // second click never lands on another card's row. A drop or a layout switch
  // lets go at once. Your map never re-sorts, so it never holds.
  const [hold, setHold] = useState<{ layout: string; result: AtlasLayoutResult } | null>(null);
  const result = hold && hold.layout === layout && layout !== 'map' ? hold.result : computed;
  const positions = result.positions;
  // Where the cards rest, for the world's fold (it writes only to cards in view).
  const positionsRef = useRef(positions);
  useLayoutEffect(() => {
    positionsRef.current = positions;
  }, [positions]);
  const lastDrawn = useRef<{ layout: string; result: AtlasLayoutResult }>({ layout, result });
  useLayoutEffect(() => {
    lastDrawn.current = { layout, result };
  });
  const overCard = useRef(false);
  const holdTimeUp = useRef(true);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
  }, []);
  const releaseHold = useCallback(() => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
    holdTimeUp.current = true;
    setHold(null);
  }, []);
  const onTick = useCallback(() => {
    const drawn = lastDrawn.current;
    if (drawn.layout === 'map') return;
    setHold((h) => (h && h.layout === drawn.layout ? h : drawn));
    holdTimeUp.current = false;
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null;
      holdTimeUp.current = true;
      if (!overCard.current) setHold(null);
    }, ATLAS_TICK_HOLD_MS);
  }, []);
  const onPointerOver = (e: { target: EventTarget }) => {
    overCard.current = !!(e.target as Element).closest?.('[data-atlas-card]');
    if (!overCard.current && holdTimeUp.current && hold) setHold(null);
  };
  const onPointerLeave = () => {
    overCard.current = false;
    if (holdTimeUp.current && hold) setHold(null);
  };

  // Tab order follows the layout shown: cards render in reading order
  // (Momentum column by column, the others row by row). The DOM is reordered
  // only once a glide has finished, since moving a node mid-transition would
  // cut its glide short.
  const readingOrder = useMemo(() => {
    if (layout === 'map') return cards.map((c) => c.key).join('\n');
    const byCols = layout === 'momentum';
    return [...cards]
      .map((c) => ({ key: c.key, p: positions.get(c.key) }))
      .sort((a, b) => {
        if (!a.p || !b.p) return a.p ? -1 : b.p ? 1 : 0;
        return byCols ? a.p.x - b.p.x || a.p.y - b.p.y : a.p.y - b.p.y || a.p.x - b.p.x;
      })
      .map((c) => c.key)
      .join('\n');
  }, [layout, cards, positions]);
  const [domOrder, setDomOrder] = useState(readingOrder);
  useEffect(() => {
    if (domOrder === readingOrder) return;
    const t = setTimeout(
      () => setDomOrder(readingOrder),
      reduced ? 0 : ATLAS_GLIDE_MS + ATLAS_MOTION.glideStaggerMs + 50
    );
    return () => clearTimeout(t);
  }, [domOrder, readingOrder, reduced]);
  const orderedCards = useMemo(() => {
    const rank = new Map(domOrder.split('\n').map((k, i) => [k, i]));
    const at = (k: string) => rank.get(k) ?? Number.MAX_SAFE_INTEGER;
    return [...cards].sort((a, b) => at(a.key) - at(b.key));
  }, [cards, domOrder]);

  // A layout switch cascades: each card's glide starts a little later the
  // further right it lands (lib/atlas-motion.ts glideDelay), so columns and
  // months arrive in reading order. Only the switch's own glide: the delays
  // are dropped once it has played, so a drop's spring back never waits.
  const [cascade, setCascade] = useState<string | null>(null);
  const [cascadeFrom, setCascadeFrom] = useState(layout);
  if (cascadeFrom !== layout) {
    setCascadeFrom(layout);
    if (!reduced) setCascade(layout);
  }
  useEffect(() => {
    if (cascade === null) return;
    const t = setTimeout(() => setCascade(null), ATLAS_GLIDE_MS + ATLAS_MOTION.glideStaggerMs + 50);
    return () => clearTimeout(t);
  }, [cascade]);
  const delays = useMemo(() => {
    const out = new Map<string, number>();
    if (cascade === null || cascade !== layout) return out;
    let minX = Infinity;
    let maxX = -Infinity;
    for (const p of positions.values()) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
    }
    for (const [k, p] of positions) out.set(k, glideDelay(p.x, minX, maxX));
    return out;
  }, [cascade, layout, positions]);

  // Each card's lane, said to a screen reader (the lanes layer is aria-hidden).
  const laneLabels = useMemo(() => {
    const out = new Map<string, string>();
    if (layout === 'map') return out;
    const label = new Map(result.lanes.map((l) => [l.id, l.label]));
    for (const [key, id] of result.cardLane) {
      const name = label.get(id);
      if (name) out.set(key, name);
    }
    return out;
  }, [layout, result]);

  // The "why" line per card, in every layout but Your map.
  const reasons = useMemo(() => {
    const out = new Map<string, string | null>();
    if (layout === 'map') return out;
    const seasonsById = new Map(seasons.map((x) => [x.id, x]));
    const goalName = new Map(goals.map((g) => [g.id, g.name]));
    for (const c of cards) {
      if (layout === 'momentum') out.set(c.key, bands.get(c.key)?.reason ?? null);
      else if (layout === 'goal') {
        if (c.kind === 'goal') continue;
        const feeds = feedsOf(c, goals);
        out.set(
          c.key,
          feeds.length === 0
            ? ATLAS_COPY.notFeedingReason
            : feeds.length === 1
              ? ATLAS_COPY.feedsGoal(goalName.get(feeds[0]) ?? '')
              : ATLAS_COPY.feedsGoals(feeds.length)
        );
      } else {
        const p = timelinePlace(c, todayStr, seasonsById);
        if (p.lane === 'repeats') out.set(c.key, ATLAS_COPY.repeats);
        else if (p.lane === 'goals') out.set(c.key, ATLAS_COPY.targetReason(formatDay(p.day)));
        else if (p.lane === 'dated' && p.what === 'season') {
          const s0 = seasonsById.get(c.id);
          const from = s0?.startsOn ? formatDay(s0.startsOn) : undefined;
          const to = s0?.endsOn ? formatDay(s0.endsOn) : undefined;
          out.set(c.key, from && to ? ATLAS_COPY.seasonRange(from, to) : from ? ATLAS_COPY.seasonFrom(from) : ATLAS_COPY.seasonUntil(to!));
        } else if (p.lane === 'dated') out.set(c.key, ATLAS_COPY.nextStepDated(formatDay(p.day)));
        else out.set(c.key, ATLAS_COPY.noDates);
      }
    }
    return out;
  }, [layout, cards, bands, goals, seasons, todayStr]);

  // The far zoom's clusters: each drawn card at its centre, a tile per item.
  const clusters = useMemo((): FarCluster[] => {
    const out: FarCluster[] = [];
    for (const c of visible) {
      const p = positions.get(c.key);
      if (!p) continue;
      const tiles = Math.max(c.total, c.tiles.length + c.moreTiles);
      out.push({
        key: c.key,
        kind: c.kind,
        id: c.id,
        name: c.name,
        kindLabel: c.kindLabel,
        color: c.color,
        x: p.x + ATLAS_CARD_W / 2,
        y: p.y + ATLAS_CARD_H / 2,
        tiles,
        lit: Math.min(c.lit, tiles),
        resting: c.resting,
        live: liveness(c.touch, c.resting),
        allDone: c.allDone,
        nextTitle: c.next?.item.title ?? null,
        restingSince: c.touch.kind === 'resting' ? formatDay(c.touch.since) : undefined,
      });
    }
    return out;
  }, [visible, positions]);
  // What feeds what, computed ONCE for both zooms: each drawn card to the
  // goal holding most of its items (laneFor), and each season to its drawn
  // routines. The far canvas draws them as threads and rings, the card layer
  // as strands and frames (atlas-strands.tsx), so the two never disagree.
  const links = useMemo(() => {
    const shown = new Set(clusters.map((c) => c.key));
    const threads: AtlasStrandLink[] = [];
    if (goals.length > 0) {
      for (const c of visible) {
        if (c.kind === 'goal' || !shown.has(c.key)) continue;
        const g = laneFor(c, goals);
        if (g && shown.has(`goal:${g}`)) threads.push({ from: `goal:${g}`, to: c.key });
      }
    }
    const seasonGroups = visible
      .filter((c) => c.kind === 'season' && shown.has(c.key) && (c.routineIds?.length ?? 0) > 0)
      .map((c) => ({
        card: c,
        members: [c.key, ...(c.routineIds ?? []).map((id) => `routine:${id}`).filter((k) => shown.has(k))],
      }));
    return { threads, seasonGroups };
  }, [clusters, visible, goals]);
  const farScene = useMemo(
    (): FarScene => ({
      clusters,
      threads: links.threads.map((t): [string, string] => [t.from, t.to]),
      seasons: links.seasonGroups.map(({ card, members }) => ({
        key: card.key,
        label: ATLAS_COPY.farSeason(card.name, card.kindLabel),
        members,
      })),
    }),
    [clusters, links]
  );
  // The Relay grid, built once for the constellation canvas and the handoff's overlay.
  const farGrid = useMemo(
    () =>
      buildRelayGrid(
        clusters.map((c) => ({ key: c.key, x: c.x, y: c.y, tiles: c.tiles, lit: c.lit })),
        ATLAS_GRID_PITCH
      ),
    [clusters]
  );
  const policy = strandPolicy(layout);
  const strandLinks = useMemo(() => (policy.strands ? links.threads : []), [policy.strands, links]);
  const frames = useMemo((): AtlasFrameSpec[] => {
    if (!policy.frames) return [];
    const byId = new Map(seasons.map((x) => [x.id, x]));
    return links.seasonGroups
      // A season with none of its routines drawn has nothing to frame.
      .filter(({ members }) => members.length > 1)
      .map(({ card, members }) => {
        const s0 = byId.get(card.id);
        const from = s0?.startsOn ? formatDay(s0.startsOn) : null;
        const to = s0?.endsOn ? formatDay(s0.endsOn) : null;
        const dates =
          from && to ? ATLAS_COPY.seasonRange(from, to) : from ? ATLAS_COPY.seasonFrom(from) : to ? ATLAS_COPY.seasonUntil(to) : null;
        return { key: card.key, color: card.color, kind: card.kindLabel, name: card.name, dates, members };
      });
  }, [policy.frames, links, seasons]);
  const colors = useAtlasColors(
    islandRef,
    useMemo(() => visible.map((c) => c.color), [visible]),
    duskDark
  );
  // What the minimap frames: every drawn card, and the lanes in a computed layout.
  const content = useMemo(
    (): Rect[] => [
      ...visible.flatMap((c) => {
        const p = positions.get(c.key);
        return p ? [{ x: p.x, y: p.y, w: ATLAS_CARD_W, h: ATLAS_CARD_H }] : [];
      }),
      ...result.lanes.filter((l) => l.kind !== 'timeline').map((l) => l.rect),
    ],
    [visible, positions, result.lanes]
  );
  const minimapLayout = layout === 'map' || layout === 'momentum' || layout === 'timeline';

  // A click on a far cluster flies in to it, at zoom 1. A pan or zoom during
  // the flight takes the camera back at once.
  const reducedRef = useRef(reduced);
  useEffect(() => {
    reducedRef.current = reduced;
  }, [reduced]);
  const flight = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (flight.current !== null) cancelAnimationFrame(flight.current);
    },
    []
  );
  const flyTo = useCallback((target: AtlasCamera, onLand?: () => void, flourish = false) => {
    const ui = useAtlasUiStore.getState();
    if (flight.current !== null) cancelAnimationFrame(flight.current);
    flight.current = null;
    if (reducedRef.current || typeof requestAnimationFrame === 'undefined') {
      ui.setCamera(target);
      if (onLand) setTimeout(onLand, 0);
      return;
    }
    const from = ui.camera;
    const vp = viewportRef.current;
    let last = from;
    let t0: number | null = null;
    let landed = false;
    const total = flourish ? ATLAS_FLY_TOTAL_MS : ATLAS_FLY_MS;
    const step = (now: number) => {
      const store = useAtlasUiStore.getState();
      // A pan, a pinch or a fit took the camera (and ended any flourish).
      if (store.camera !== last) {
        flight.current = null;
        return;
      }
      t0 ??= now;
      const elapsed = now - t0;
      const t = Math.min(1, elapsed / ATLAS_FLY_MS);
      last = flyCamera(from, target, vp, easeInOutCubic(t));
      // The flourish: the handoff shown is the larger of the zoom's and the
      // timed assembly's, so the cards form at a pace you can see.
      const shown = flourish && elapsed < total ? Math.max(handoffProgress(last.z), flourishAt(elapsed)) : null;
      store.setFlight(last, shown);
      flight.current = elapsed < total ? requestAnimationFrame(step) : null;
      // Landed: once the cards have mounted (and a flourish has finished, so
      // a focus that pans the camera never cuts the assembly short), hand
      // focus on.
      if (elapsed >= total && !landed) {
        landed = true;
        if (onLand) requestAnimationFrame(onLand);
      }
    };
    flight.current = requestAnimationFrame(step);
  }, []);
  // A flourish never outlives the view.
  useEffect(() => () => useAtlasUiStore.setState({ flourish: null }), []);
  const clustersRef = useRef(clusters);
  useLayoutEffect(() => {
    clustersRef.current = clusters;
  });
  const onFly = useCallback(
    (key: string) => {
      const c = clustersRef.current.find((x) => x.key === key);
      if (!c) return;
      const cam = useAtlasUiStore.getState().camera;
      // Focus was on the cluster (gone now) or fell back to the root: it
      // lands on that container's card, so Tab and Enter carry on from there.
      const land = () => {
        const root = rootRef.current;
        const active = document.activeElement;
        if (!root || (active !== root && active !== document.body)) return;
        root.querySelector<HTMLElement>(`[data-atlas-card="${key}"]`)?.focus({ preventScroll: true });
      };
      flyTo(centerOnPoint(cam, { x: c.x, y: c.y }, viewportRef.current, ATLAS_FLY_ZOOM), land, true);
    },
    [flyTo]
  );

  // Cards unmount below 0.5 and the cluster buttons above it, so whichever
  // held focus drops it on <body>: it goes back to the root either way, so
  // the map's keys keep working.
  useLayoutEffect(() => {
    if (document.activeElement === document.body) rootRef.current?.focus({ preventScroll: true });
  }, [far]);

  // A card a filter hides scales down, then unmounts (D8: never a fade). Its
  // place and pin are untouched; it just stops being drawn. Worked out while
  // rendering, from the previous render's places (React's "previous props"
  // pattern), and cleared by a timer.
  const [leaving, setLeaving] = useState<Record<string, Point>>({});
  const [drawnBefore, setDrawnBefore] = useState(positions);
  if (drawnBefore !== positions) {
    setDrawnBefore(positions);
    if (!reduced) {
      const live = new Set(cards.map((c) => c.key));
      const gone: Record<string, Point> = {};
      for (const [k, p] of drawnBefore) if (!positions.has(k) && live.has(k)) gone[k] = p;
      if (Object.keys(gone).length > 0) setLeaving((prev) => ({ ...prev, ...gone }));
    }
  }
  const leaveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    for (const k of Object.keys(leaving)) {
      if (leaveTimers.current.has(k)) continue;
      leaveTimers.current.set(
        k,
        setTimeout(() => {
          leaveTimers.current.delete(k);
          setLeaving((prev) => {
            if (!(k in prev)) return prev;
            const next = { ...prev };
            delete next[k];
            return next;
          });
        }, ATLAS_LEAVE_MS)
      );
    }
  }, [leaving]);
  useEffect(() => {
    const timers = leaveTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  // Load the account's places: on the first mount once settled and not a
  // preview, memoised per account by the store.
  useEffect(() => {
    if (!userId || !settled || previewing) return;
    void useAtlasStore.getState().load(userId);
  }, [userId, settled, previewing]);

  // Retry on focus, only after a read that threw. Device mode, once latched,
  // holds for the session (a retry would only find the table missing again).
  useEffect(() => {
    if (!userId) return;
    const onWindowFocus = () => {
      const s = useAtlasStore.getState();
      if (s.userId === userId && s.failed && s.mode !== 'device') void s.load(userId);
    };
    window.addEventListener('focus', onWindowFocus);
    return () => window.removeEventListener('focus', onWindowFocus);
  }, [userId]);

  // Seed the cards that have no place yet, once each, before paint: a card is
  // seeded the first time Atlas sees it, so ticking a row or dragging another
  // card never moves it. Once places may be written, every card with no
  // stored place is written once, at the place it is drawn.
  useLayoutEffect(() => {
    if (!ready) return;
    const fresh = seedPlaces(cards, places, SEED_VIEWPORT);
    useAtlasUiStore.getState().addSeeded(fresh);
    if (!writable) return;
    const drawn = { ...places, ...fresh };
    const missing: AtlasPlace[] = [];
    for (const c of cards) {
      const at = drawn[c.key];
      if (!storedXY[c.key] && at) missing.push({ kind: c.kind, id: c.id, x: at.x, y: at.y, band: null });
    }
    if (missing.length > 0) useAtlasStore.getState().placeMany(missing);
  }, [cards, places, storedXY, ready, writable]);

  // What a fit frames: every drawn card, and in a computed layout its lanes
  // (so the column and lane headings show).
  const rects = useCallback(
    (list: readonly AtlasCardModel[]): Rect[] => [
      ...list.flatMap((c) => {
        const p = positions.get(c.key);
        return p ? [{ x: p.x, y: p.y, w: ATLAS_CARD_W, h: measuredHeight(rootRef.current, c.key) }] : [];
      }),
      ...result.lanes.filter((l) => l.kind !== 'timeline').map((l) => l.rect),
    ],
    [positions, result.lanes]
  );

  // The viewport, from a ResizeObserver. A resize (the rail docking) updates
  // it and never re-fits or re-centres.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      const next = { w: el.clientWidth, h: el.clientHeight };
      viewportRef.current = next;
      setViewport(next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The layout the camera last framed (a switch re-frames, below).
  const lastLayout = useRef(layout);

  // First mount: fit to the cards, once per session, on the settled load (a
  // cached preview's cards would set `fitted` before the real ones arrive).
  // Never below a readable zoom: a big map opens at its top-left corner,
  // where the goals sit, instead of as a field of unreadable cards. The
  // toolbar's Fit keeps the full range.
  useEffect(() => {
    const ui = useAtlasUiStore.getState();
    if (!settled || previewing || !ready) return;
    if (ui.fitted || viewport.w <= 0 || viewport.h <= 0 || visible.length === 0) return;
    // Every card drawn first: a fit to half the map would mark it fitted.
    if (visible.some((c) => !positions.has(c.key))) return;
    ui.setCamera(fitBounds(rects(visible), viewport, 48, ui.camera, ATLAS_FIT_FLOOR));
    ui.markFitted();
    lastLayout.current = layout;
  }, [viewport, visible, rects, positions, settled, previewing, ready, layout]);

  // A layout switch frames the new arrangement (the camera only: switching
  // never edits). An open item stays open; nothing here touches ui-store.
  useEffect(() => {
    if (lastLayout.current === layout) return;
    releaseHold();
    const ui = useAtlasUiStore.getState();
    if (!ui.fitted || viewportRef.current.w <= 0) return;
    lastLayout.current = layout;
    useAtlasUiStore.getState().setHotLane(null);
    ui.setCamera(fitBounds(rects(visible), viewportRef.current, 48, ui.camera, ATLAS_FIT_FLOOR));
  }, [layout, rects, visible, releaseHold]);

  // The toolbar's Fit.
  const lastFit = useRef(fitToken);
  useEffect(() => {
    if (fitToken === lastFit.current) return;
    lastFit.current = fitToken;
    const ui = useAtlasUiStore.getState();
    ui.setCamera(fitBounds(rects(visible), viewportRef.current, 48, ui.camera));
  }, [fitToken, visible, rects]);

  // A drop is one write, on pointerup. view-root is inert while previewing, so
  // no drag starts then; the ref is the belt to that.
  const previewingRef = useRef(previewing);
  useEffect(() => {
    previewingRef.current = previewing;
  }, [previewing]);
  // What a drop means is the layout's (lib/atlas-drop.ts); the callbacks are
  // stable for memo(AtlasCard), so they read the latest layout from a ref.
  const dropCtx = useRef({ layout, result, bands, lanes, goals, goalsShown, places, cards });
  useLayoutEffect(() => {
    dropCtx.current = { layout, result, bands, lanes, goals, goalsShown, places, cards };
  });
  const onMove = useCallback((key: string, to: Point) => {
    if (previewingRef.current) return;
    const ctx = dropCtx.current;
    const card = ctx.cards.find((c) => c.key === key);
    if (!card) return;
    // The lane the card is DRAWN in, so the drop's "from" is what the screen shows.
    const drawnLane = ctx.result.cardLane.get(key);
    // A drop into a Momentum column may pin the card: its settle may play.
    if (ctx.layout === 'momentum') armPinSettle(key);
    const out = dropCard({
      layout: ctx.layout,
      card,
      to,
      from: ctx.result.positions.get(key),
      result: ctx.result,
      band: ctx.bands.get(key),
      mapAt: ctx.places[key],
      lane: drawnLane && drawnLane !== 'none' ? drawnLane : null,
      goals: ctx.goals,
      goalsShown: ctx.goalsShown,
    });
    releaseHold();
    if (out.message) toast(out.message);
  }, [releaseHold]);
  const onDrag = useCallback((key: string, pos: Point | null) => {
    const ctx = dropCtx.current;
    const ui = useAtlasUiStore.getState();
    if (!pos || (ctx.layout !== 'momentum' && ctx.layout !== 'goal')) {
      ui.setHotLane(null);
      return;
    }
    // A goal card heads its lane and never moves; nothing lights for it.
    if (ctx.layout === 'goal' && key.startsWith('goal:')) return;
    // The card's own column or lane means nothing as a drop, so it never lights.
    const id = laneAt(ctx.result, ctx.layout, pos)?.id ?? null;
    ui.setHotLane(id !== null && id === ctx.result.cardLane.get(key) ? null : id);
  }, []);
  const onPin = useCallback((key: string, band: AtlasBand | null) => {
    if (previewingRef.current) return;
    const ctx = dropCtx.current;
    const card = ctx.cards.find((c) => c.key === key);
    if (!card) return;
    if (band) armPinSettle(key);
    useAtlasStore.getState().pin(card.kind, card.id, band, ctx.places[key]);
    toast(band ? ATLAS_COPY.pinned(card.name, bandLabel(band)) : ATLAS_COPY.unpinned(card.name));
  }, []);
  const dayAt = useCallback((x: number) => goalDayAtClamped(dropCtx.current.result, x), []);
  const onToggleExpanded = useCallback((key: string) => {
    useAtlasUiStore.getState().toggleExpanded(key);
  }, []);
  const onCenter = useCallback((rect: Rect) => {
    const ui = useAtlasUiStore.getState();
    ui.setCamera(centerOn(ui.camera, rect, viewportRef.current));
  }, []);

  // Grow a card into the focus sheet, from where it is drawn now (root
  // coordinates, so the sheet starts exactly on top of it).
  const onOpenSheet = useCallback((key: string, el: HTMLElement) => {
    const root = rootRef.current;
    const at = key.indexOf(':');
    if (!root || at <= 0) return;
    const r = el.getBoundingClientRect();
    const o = root.getBoundingClientRect();
    useAtlasUiStore
      .getState()
      .openSheet(key.slice(0, at) as AtlasCardModel['kind'], key.slice(at + 1), {
        x: r.left - o.left,
        y: r.top - o.top,
        width: r.width,
        height: r.height,
      });
  }, []);

  // The sheet is this view's: leaving Atlas (a scope switch, a page) closes
  // it, so it never springs open on the next visit.
  useEffect(() => () => useAtlasUiStore.getState().closeSheet(), []);

  // The root's two keys (rule 18: not global shortcuts, so not commands).
  // Escape closes the sheet, and claims the key (preventDefault) so the item
  // panel's window listener leaves an open item alone; with no sheet it does
  // nothing and the panel keeps its own Escape. Enter on a focused card grows
  // it into the sheet (a row's Enter is the row's, and stops there). Neither
  // acts from a text field, from a key someone else already took (a Radix
  // menu claims Escape at the document), or from a portal outside the root.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey) return;
    const t = e.target as HTMLElement;
    if (!rootRef.current?.contains(t)) return;
    if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (e.key === 'Escape') {
      if (!useAtlasUiStore.getState().sheet) return;
      e.preventDefault();
      useAtlasUiStore.getState().closeSheet();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && t.matches('[data-atlas-card]')) {
      const key = t.getAttribute('data-atlas-card');
      if (!key) return;
      e.preventDefault();
      onOpenSheet(key, t);
    }
  };

  // A card (or a row in it) taking focus pans it on screen, as Tab walks the map.
  const onFocus = (e: FocusEvent) => {
    if (pointerDown.current) return;
    // A far cluster taking focus (Tab at far zoom) pans it on screen too. Its
    // hit box is in world units, in the camera-scaled layer.
    const hit = (e.target as Element).closest?.('[data-atlas-far-cluster]') as HTMLElement | null;
    if (hit) {
      const ui = useAtlasUiStore.getState();
      const rect = {
        x: parseFloat(hit.style.left) || 0,
        y: parseFloat(hit.style.top) || 0,
        w: parseFloat(hit.style.width) || 0,
        h: parseFloat(hit.style.height) || 0,
      };
      const next = ensureVisible(ui.camera, rect, viewportRef.current);
      if (next !== ui.camera) ui.setCamera(next);
      return;
    }
    const card = (e.target as Element).closest?.('[data-atlas-card]');
    const key = card?.getAttribute('data-atlas-card');
    const p = key ? positions.get(key) : undefined;
    if (!key || !p) return;
    const ui = useAtlasUiStore.getState();
    const rect = { x: p.x, y: p.y, w: ATLAS_CARD_W, h: (card as HTMLElement).offsetHeight || ATLAS_CARD_H };
    const next = ensureVisible(ui.camera, rect, viewportRef.current);
    if (next !== ui.camera) ui.setCamera(next);
  };

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-atlas-root=""
      data-testid="atlas-view"
      data-atlas-layout={layout}
      // Whether a dnd-kit drag is in flight (a braindump row, or a row from
      // a card). Each card is its own drop target (atlas-card-drop.tsx); the
      // marker is for tests.
      data-drag-active={activeId ? 'true' : undefined}
      role="region"
      aria-label={ATLAS_COPY.canvasLabel}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onPointerDownCapture={() => {
        pointerDown.current = true;
      }}
      onPointerUpCapture={() => {
        pointerDown.current = false;
      }}
      onPointerCancelCapture={() => {
        pointerDown.current = false;
      }}
      onPointerOver={onPointerOver}
      onPointerLeave={onPointerLeave}
      className="relative min-h-0 flex-1 outline-none"
      style={{ overflow: 'clip' }}
    >
      {/* The island: under Dusk, zoomed out on a light theme, it alone turns
          `.dark` (base dark tokens, so the canvas and the minimap read dark
          values from inside it). It carries no dark: classes of its own,
          since Tailwind's dark variant matches descendants only. */}
      <div
        ref={islandRef}
        data-testid="atlas-island"
        data-atlas-dusk={dusk ? 'true' : undefined}
        className={cn('atlas-island absolute inset-0', duskDark && 'dark')}
      >
        {/* The ground: transparent (the theme's own background) or Dusk's slate,
            by a background-color change; nothing is dimmed. */}
        <div
          aria-hidden
          data-testid="atlas-ground"
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundColor: dusk ? ATLAS_DUSK_GROUND : 'transparent',
            transition: reduced ? undefined : `background-color ${ATLAS_GROUND_MS}ms ease-out`,
          }}
        />
        {/* A camera move mid-drag re-measures the cards' drop rects (PR4). */}
        <AtlasDropRemeasure />
        <AtlasSurface
          rootRef={rootRef}
          inert={sheetOpen}
          fold={!reduced}
          cardsAt={positionsRef}
          farOver={
            handoffLive && !reduced && cards.length > 0 ? (
              <AtlasHandoffCanvas scene={farScene} grid={farGrid} colors={colors} />
            ) : null
          }
          far={
            inBand && cards.length > 0 ? (
              <AtlasFarCanvas
                scene={farScene}
                grid={farGrid}
                colors={colors}
                reduced={reduced}
                interactive={far}
                width={viewport.w}
                onFly={onFly}
              />
            ) : null
          }
        >
          {layout !== 'map' && <AtlasLanes lanes={result.lanes} timeline={result.timeline} />}
          {/* Strands and season frames, under the cards. Off from the handoff
              band down, where the far canvas draws the same links. */}
          {ready && !inBand && (strandLinks.length > 0 || frames.length > 0) && (
            <AtlasStrands
              links={strandLinks}
              frames={frames}
              positions={positions}
              expanded={expanded}
              reduced={reduced}
            />
          )}
          {!far && orderedCards.map((card) => {
            const drawn = ready ? positions.get(card.key) : undefined;
            const gone = !drawn && ready ? leaving[card.key] : undefined;
            const at = drawn ?? gone;
            if (!at) return null;
            const band = layout === 'momentum' ? bands.get(card.key) : undefined;
            const timelineGoal = layout === 'timeline' && card.kind === 'goal';
            return (
              <AtlasCard
                key={card.key}
                card={card}
                at={at}
                expanded={!!expanded[card.key]}
                todayStr={todayStr}
                milestoneIds={milestoneIds}
                onMove={onMove}
                onToggleExpanded={onToggleExpanded}
                onCenter={onCenter}
                onOpenSheet={onOpenSheet}
                glide={!reduced}
                leaving={!!gone}
                reason={layout === 'map' ? undefined : reasons.get(card.key)}
                momentumBand={band?.band}
                momentumAppBand={band?.appBand}
                pinned={band?.pinned}
                onPin={band ? onPin : undefined}
                onDrag={layout === 'momentum' || layout === 'goal' ? onDrag : undefined}
                axis={timelineGoal && card.targetOn ? 'x' : null}
                diamond={timelineGoal && !!card.targetOn}
                dayAt={timelineGoal ? dayAt : undefined}
                laneLabel={laneLabels.get(card.key)}
                onTick={layout === 'map' ? undefined : onTick}
                handoff={inBand && !reduced}
                glideDelay={delays.get(card.key)}
              />
            );
          })}
        </AtlasSurface>
        {minimapLayout && (
          <AtlasMinimap content={content} clusters={clusters} viewport={viewport} colors={colors} reduced={reduced} />
        )}
      </div>
      <AtlasFocusSheet
        cards={cards}
        viewport={viewport}
        todayStr={todayStr}
        milestoneIds={milestoneIds}
        rootRef={rootRef}
      />
      {cards.length === 0 && (
        <p
          data-testid="atlas-empty"
          className="pointer-events-none absolute inset-x-0 top-1/3 mx-auto max-w-sm px-4 text-center text-sm text-muted-foreground"
        >
          {ATLAS_COPY.empty(collectionsShown, goalsShown)}
        </p>
      )}
    </div>
  );
}

/** A card's drawn height, or the seeding estimate before it has one. */
function measuredHeight(root: HTMLElement | null, key: string): number {
  const el = root?.querySelector<HTMLElement>(`[data-atlas-card="${key}"]`);
  return el?.offsetHeight || ATLAS_CARD_H;
}
