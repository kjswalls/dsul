'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent } from 'react';
import { AtlasSurface } from '@/components/views/atlas/atlas-surface';
import { AtlasCard } from '@/components/views/atlas/atlas-card';
import { useAtlasCards } from '@/components/views/atlas/use-atlas-cards';
import { useAtlasUiStore } from '@/lib/atlas-ui-store';
import {
  ATLAS_FIT_FLOOR,
  centerOn,
  ensureVisible,
  fitBounds,
  type Point,
  type Rect,
  type Viewport,
} from '@/lib/atlas-camera';
import { usePlannerPreviewing, usePlannerSettled } from '@/lib/planner-ready';
import { ATLAS_CARD_H, ATLAS_CARD_W, seedPlaces } from '@/lib/atlas-seed';
import { ATLAS_COPY } from '@/lib/atlas-copy';
import type { AtlasCard as AtlasCardModel } from '@/lib/atlas-model';

/**
 * The viewport seeding lays a grid out against. Fixed rather than measured, so
 * opening the item rail (which narrows <main> by 432px) never reshuffles where
 * new cards land.
 */
const SEED_VIEWPORT: Viewport = { w: 1600, h: 900 };

/**
 * Atlas: the user's projects, routines, seasons and goals as cards on a map
 * (design PR1a). The third ViewScope, desktop only.
 *
 * Positions come from `seedPlaces()` and live in memory: a card dragged this
 * session keeps its place until reload (lib/atlas-ui-store.ts `moved`). PR1b
 * gives them the positions table.
 *
 * The root is focusable (`tabIndex={-1}`) and `overflow: clip`, not hidden:
 * a hidden box is a scroll container, and a focused off-screen card would
 * scroll it out of step with the camera. There is no canvas-container inside
 * (design D7): the header row goes wide through useCanvasWide instead.
 */
export function AtlasView({ activeId }: { activeId?: string | null }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { cards, todayStr, milestoneIds, collectionsShown, goalsShown } = useAtlasCards();
  const settled = usePlannerSettled();
  const previewing = usePlannerPreviewing();
  // A press inside the map focuses what it lands on; that focus must not pan
  // (the card would move out from under the press). Only keyboard focus pans.
  const pointerDown = useRef(false);
  const moved = useAtlasUiStore((s) => s.moved);
  const expanded = useAtlasUiStore((s) => s.expanded);
  const fitToken = useAtlasUiStore((s) => s.fitToken);
  const seeded = useAtlasUiStore((s) => s.seeded);
  const [viewport, setViewport] = useState<Viewport>({ w: 0, h: 0 });
  // The latest viewport for the callbacks below, written where it is measured
  // (never during render), so a resize never re-renders a card.
  const viewportRef = useRef(viewport);

  const places = useMemo(() => ({ ...seeded, ...moved }), [seeded, moved]);

  // Seed the cards that have no place yet, once each, before paint: a card is
  // seeded the first time Atlas sees it, so ticking a row or dragging another
  // card never moves it.
  useLayoutEffect(() => {
    const fresh = seedPlaces(cards, places, SEED_VIEWPORT);
    useAtlasUiStore.getState().addSeeded(fresh);
  }, [cards, places]);

  const rects = useCallback(
    (list: readonly AtlasCardModel[]): Rect[] =>
      list.flatMap((c) => {
        const p = places[c.key];
        return p ? [{ x: p.x, y: p.y, w: ATLAS_CARD_W, h: measuredHeight(rootRef.current, c.key) }] : [];
      }),
    [places]
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

  // First mount: fit to the cards, once per session, on the settled load (a
  // cached preview's cards would set `fitted` before the real ones arrive).
  // Never below a readable zoom: a big map opens at its top-left corner,
  // where the goals sit, instead of as a field of unreadable cards. The
  // toolbar's Fit keeps the full range.
  useEffect(() => {
    const ui = useAtlasUiStore.getState();
    if (!settled || previewing) return;
    if (ui.fitted || viewport.w <= 0 || viewport.h <= 0 || cards.length === 0) return;
    ui.setCamera(fitBounds(rects(cards), viewport, 48, ui.camera, ATLAS_FIT_FLOOR));
    ui.markFitted();
  }, [viewport, cards, rects, settled, previewing]);

  // The toolbar's Fit.
  const lastFit = useRef(fitToken);
  useEffect(() => {
    if (fitToken === lastFit.current) return;
    lastFit.current = fitToken;
    const ui = useAtlasUiStore.getState();
    ui.setCamera(fitBounds(rects(cards), viewportRef.current, 48, ui.camera));
  }, [fitToken, cards, rects]);

  const onMove = useCallback((key: string, to: Point) => {
    useAtlasUiStore.getState().moveCard(key, to);
  }, []);
  const onToggleExpanded = useCallback((key: string) => {
    useAtlasUiStore.getState().toggleExpanded(key);
  }, []);
  const onCenter = useCallback((rect: Rect) => {
    const ui = useAtlasUiStore.getState();
    ui.setCamera(centerOn(ui.camera, rect, viewportRef.current));
  }, []);

  // A card (or a row in it) taking focus pans it on screen, as Tab walks the map.
  const onFocus = (e: FocusEvent) => {
    if (pointerDown.current) return;
    const card = (e.target as Element).closest?.('[data-atlas-card]');
    const key = card?.getAttribute('data-atlas-card');
    const p = key ? places[key] : undefined;
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
      // Whether a dnd-kit drag is in flight elsewhere (the braindump). Atlas
      // takes no drop until PR4; the marker is for tests.
      data-drag-active={activeId ? 'true' : undefined}
      role="region"
      aria-label={ATLAS_COPY.canvasLabel}
      onFocus={onFocus}
      onPointerDownCapture={() => {
        pointerDown.current = true;
      }}
      onPointerUpCapture={() => {
        pointerDown.current = false;
      }}
      onPointerCancelCapture={() => {
        pointerDown.current = false;
      }}
      className="relative min-h-0 flex-1 outline-none"
      style={{ overflow: 'clip' }}
    >
      <AtlasSurface rootRef={rootRef}>
        {cards.map((card) => {
          const at = places[card.key];
          if (!at) return null;
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
            />
          );
        })}
      </AtlasSurface>
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
