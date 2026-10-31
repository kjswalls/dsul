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
import { AtlasSurface } from '@/components/views/atlas/atlas-surface';
import { AtlasCard } from '@/components/views/atlas/atlas-card';
import { AtlasFocusSheet } from '@/components/views/atlas/atlas-focus-sheet';
import { useAtlasCards } from '@/components/views/atlas/use-atlas-cards';
import { useAtlasUiStore } from '@/lib/atlas-ui-store';
import { useAtlasStore } from '@/lib/atlas-store';
import type { AtlasPlace } from '@/lib/atlas-positions';
import { usePlannerStore } from '@/lib/planner-store';
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
  const { cards, todayStr, milestoneIds, collectionsShown, goalsShown } = useAtlasCards();
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
    if (!settled || previewing || !ready) return;
    if (ui.fitted || viewport.w <= 0 || viewport.h <= 0 || cards.length === 0) return;
    // Every card drawn first: a fit to half the map would mark it fitted.
    if (cards.some((c) => !places[c.key])) return;
    ui.setCamera(fitBounds(rects(cards), viewport, 48, ui.camera, ATLAS_FIT_FLOOR));
    ui.markFitted();
  }, [viewport, cards, rects, places, settled, previewing, ready]);

  // The toolbar's Fit.
  const lastFit = useRef(fitToken);
  useEffect(() => {
    if (fitToken === lastFit.current) return;
    lastFit.current = fitToken;
    const ui = useAtlasUiStore.getState();
    ui.setCamera(fitBounds(rects(cards), viewportRef.current, 48, ui.camera));
  }, [fitToken, cards, rects]);

  // A drop is one write, on pointerup. view-root is inert while previewing, so
  // no drag starts then; the ref is the belt to that.
  const previewingRef = useRef(previewing);
  useEffect(() => {
    previewingRef.current = previewing;
  }, [previewing]);
  const onMove = useCallback((key: string, to: Point) => {
    if (previewingRef.current) return;
    const at = key.indexOf(':');
    if (at <= 0) return;
    useAtlasStore.getState().place(key.slice(0, at) as AtlasPlace['kind'], key.slice(at + 1), to.x, to.y);
  }, []);
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
      className="relative min-h-0 flex-1 outline-none"
      style={{ overflow: 'clip' }}
    >
      <AtlasSurface rootRef={rootRef} inert={sheetOpen}>
        {cards.map((card) => {
          const at = ready ? places[card.key] : undefined;
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
              onOpenSheet={onOpenSheet}
            />
          );
        })}
      </AtlasSurface>
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
