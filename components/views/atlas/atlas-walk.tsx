'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { toast } from 'sonner';
import { useAtlasUiStore, type AtlasWalk as AtlasWalkState } from '@/lib/atlas-ui-store';
import { ATLAS_COPY } from '@/lib/atlas-copy';
import { completeStep, putNextOnToday } from '@/lib/atlas-verbs';
import {
  lerpRect,
  reconcileWalkRoute,
  walkCamera,
  walkHoleRect,
  walkFlightFlourishes,
  walkScrimPath,
  walkStopOf,
  type WalkAction,
} from '@/lib/atlas-walk';
import { ATLAS_CARD_H, ATLAS_CARD_W } from '@/lib/atlas-seed';
import { ATLAS_EASE_EXIT, ATLAS_EASE_OUT, ATLAS_MOTION, easeInOutCubic } from '@/lib/atlas-motion';
import { useOpenConsole } from '@/lib/console-door';
import { CONSOLE_SECTION } from '@/components/views/atlas/atlas-focus-sheet';
import { panBy, type AtlasCamera, type Point, type Rect, type Viewport } from '@/lib/atlas-camera';
import type { AtlasCard } from '@/lib/atlas-model';
import type { AtlasLayout } from '@/lib/view-store';
import { atlasWheel } from '@/components/views/atlas/atlas-surface';
import { cn } from '@/lib/utils';

/** Screen pixels of room between a card's edge and the cut-out's (and room above for its hover bar). */
const HOLE_PAD = 10;
/** The card's own corner radius, in world pixels (atlas-card.tsx). */
const CARD_RADIUS = 16;

/**
 * The veil over the board while a walk is on: the theme's own ground, mostly
 * opaque. A colour over the other cards, never their opacity (design D8), so
 * the lime under it is covered, not faded, and the card in the cut-out keeps
 * full strength.
 */
const WALK_VEIL = 'color-mix(in oklch, var(--background) 72%, transparent)';

type FlyTo = (target: AtlasCamera, onLand?: () => void, flourish?: boolean) => void;

interface WalkProps {
  /** The cards drawn (filters applied), so a stop can name its card. */
  cards: readonly AtlasCard[];
  layout: AtlasLayout;
  /**
   * The drawn cards in the layout's reading order as it is now
   * (lib/atlas-walk.ts). The walk keeps its own route from it
   * (reconcileWalkRoute), so a re-sort never skips or repeats a card.
   */
  liveOrder: readonly string[];
  /** Holds the drawn layout after a walk verb, until the walk steps. */
  onHold: () => void;
  positions: ReadonlyMap<string, Point>;
  viewport: Viewport;
  todayStr: string;
  milestoneIds: ReadonlySet<string>;
  flyTo: FlyTo;
  rootRef: RefObject<HTMLDivElement | null>;
  reduced: boolean;
  previewing: boolean;
}

/**
 * Walk Atlas (design PR4, round 2 part C): a calm look at one card at a time.
 * The camera flies card to card in the layout's reading order, a veil with a
 * cut-out keeps the eye on the card (the card itself is never dimmed, and it
 * stays live: its rows tick and open as ever), and a small panel asks one
 * gentle question with the existing verbs as buttons, plus Back, Next and
 * Done. Next is always an answer.
 *
 * Its state is atlas-ui-store's `walk` (memory only). Escape, Done or the
 * toolbar's Walk end it and fly the camera back to where it started; reduced
 * motion jumps instead of flying, and nothing here fades by opacity.
 */
export function AtlasWalk(props: WalkProps) {
  const walk = useAtlasUiStore((s) => s.walk);
  const { reduced } = props;
  // A walk that ends settles away for a moment before it unmounts; `seq`
  // counts walks, so a new one starts fresh.
  const [shown, setShown] = useState<{ walk: AtlasWalkState; leaving: boolean; seq: number } | null>(null);
  if (walk && (shown?.walk !== walk || shown.leaving)) {
    setShown({ walk, leaving: false, seq: shown && !shown.leaving ? shown.seq : (shown?.seq ?? 0) + 1 });
  } else if (!walk && shown && !shown.leaving) {
    setShown(reduced ? null : { ...shown, leaving: true });
  }
  const leaving = !!shown?.leaving;
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(
      () => setShown((s) => (s && s.leaving ? null : s)),
      Math.max(ATLAS_MOTION.walkPanelMs, ATLAS_MOTION.walkScrimMs)
    );
    return () => clearTimeout(t);
  }, [leaving]);
  if (!shown) return null;
  return <WalkOn key={shown.seq} {...props} walk={shown.walk} leaving={shown.leaving} />;
}

function WalkOn({
  walk,
  leaving,
  cards,
  layout,
  liveOrder,
  onHold,
  positions,
  viewport,
  todayStr,
  milestoneIds,
  flyTo,
  rootRef,
  reduced,
  previewing,
}: WalkProps & { walk: AtlasWalkState; leaving: boolean }) {
  const sheetOpen = useAtlasUiStore((s) => s.sheet !== null);
  const openConsole = useOpenConsole();
  const titleId = useId();
  const questionId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const viewportRef = useRef(viewport);
  useLayoutEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  // The walk's route: the reading order as it started, then kept (cards gone
  // are dropped, new ones join at the end, a layout switch re-reads what is
  // still to come). Never while leaving, when the view stops sorting.
  const [route, setRoute] = useState(() => ({ order: liveOrder.slice() as readonly string[], live: liveOrder, layout }));
  if (!leaving && (route.live !== liveOrder || route.layout !== layout)) {
    setRoute({
      order: reconcileWalkRoute(route.order, liveOrder, walk.key, route.layout !== layout),
      live: liveOrder,
      layout,
    });
  }
  const order = route.order;

  // Where the walk stands. The card it was on wins (a layout switch or a
  // filter mid-walk keeps it there); else its step; past the last card, the
  // closing stop.
  const total = order.length;
  const keyed = walk.key !== null && order.includes(walk.key) ? walk.key : null;
  const finished = keyed === null && walk.step >= total;
  const key = finished ? null : (keyed ?? order[Math.max(0, walk.step)] ?? null);
  const index = key ? order.indexOf(key) : total;
  const card = useMemo(() => (key ? (cards.find((c) => c.key === key) ?? null) : null), [cards, key]);
  const stop = useMemo(() => (card ? walkStopOf(card, todayStr, milestoneIds) : null), [card, todayStr, milestoneIds]);
  const at = key ? positions.get(key) : undefined;

  // Keep the store on the card the walk resolved to.
  useEffect(() => {
    if (leaving || finished || !key) return;
    if (walk.key !== key || walk.step !== index) useAtlasUiStore.getState().walkTo(index, key);
  }, [leaving, finished, key, index, walk.key, walk.step]);

  // Nothing drawn to walk: say so, gently, and stop.
  useEffect(() => {
    if (leaving || total > 0) return;
    toast(ATLAS_COPY.walkNothing);
    useAtlasUiStore.getState().endWalk(false);
  }, [leaving, total]);

  // The camera flies to each stop (it jumps under reduced motion: flyTo
  // asks). From far out, the flight plays the handoff as the cards form. The
  // closing stop flies back to where the walk started.
  const hasViewport = viewport.w > 0 && viewport.h > 0;
  const totalRef = useRef(total);
  useLayoutEffect(() => {
    totalRef.current = total;
  }, [total]);
  const atX = at?.x;
  const atY = at?.y;
  useEffect(() => {
    if (leaving) return;
    const cam = useAtlasUiStore.getState().camera;
    if (finished) {
      if (totalRef.current > 0) flyTo(walk.returnTo);
      return;
    }
    if (!key || atX === undefined || atY === undefined) return;
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-atlas-card="${key}"]`);
    const rect: Rect = { x: atX, y: atY, w: ATLAS_CARD_W, h: el?.offsetHeight || ATLAS_CARD_H };
    flyTo(walkCamera(rect, viewportRef.current, cam), undefined, walkFlightFlourishes(cam));
    // Not on the card count: a Realtime change or a filter mid-walk must not
    // fly back over a pan the person made. returnTo moves only on a layout
    // switch (the closing stop then flies to the new frame).
  }, [leaving, finished, key, atX, atY, hasViewport, flyTo, rootRef, walk.returnTo]);

  const next = useCallback(() => {
    const ui = useAtlasUiStore.getState();
    if (finished) return;
    const to = index + 1;
    ui.walkTo(to, order[to] ?? null);
  }, [finished, index, order]);
  const back = useCallback(() => {
    const ui = useAtlasUiStore.getState();
    const to = finished ? total - 1 : index - 1;
    if (to < 0) return;
    ui.walkTo(to, order[to] ?? null);
  }, [finished, index, total, order]);
  const end = useCallback(() => useAtlasUiStore.getState().endWalk(true), []);

  const act = (a: WalkAction) => {
    if (previewing || !card) return;
    const n = card.next;
    // The card stays put (a held layout) until the walk steps on.
    if (a.id !== 'organize') onHold();
    if (a.id === 'today' && n) putNextOnToday(n.item.id, todayStr, milestoneIds);
    else if (a.id === 'complete' && n) completeStep(n.item.id, todayStr, milestoneIds, n.todayState);
    else if (a.id === 'organize') {
      // Organize opens over everything; the walk steps aside and leaves the
      // camera on this card, so closing the console comes back to it.
      useAtlasUiStore.getState().endWalk(false);
      openConsole({ section: CONSOLE_SECTION[card.kind], focusId: card.id });
    }
  };

  // Focus moves into the panel as the walk starts, onto Next.
  useEffect(() => {
    if (leaving) return;
    nextRef.current?.focus({ preventScroll: true });
    // Once per walk.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A button that goes away under focus (Put on Today once it has run, Back
  // on the first card) drops focus to <body>: put it back on Next.
  const focusInside = useRef(false);
  const onPanelFocus = () => {
    focusInside.current = true;
  };
  const onPanelBlur = (e: FocusEvent<HTMLElement>) => {
    const to = e.relatedTarget as Node | null;
    if (to) {
      focusInside.current = !!panelRef.current?.contains(to);
      return;
    }
    const from = e.target as HTMLElement;
    queueMicrotask(() => {
      if (from.isConnected) focusInside.current = false;
      else refocus();
    });
  };
  const refocus = () => {
    const active = document.activeElement;
    if (!focusInside.current || (active && active !== document.body)) return;
    (nextRef.current ?? panelRef.current)?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    refocus();
  });

  // Escape ends the walk and takes the camera back, from the panel, the card
  // in the cut-out, the bare map or <body>. Capture phase, and it claims the
  // key, so an open item's panel leaves the item alone; it yields to the
  // focus sheet (whose Escape is the root's), to an open menu, to a text
  // field, and to focus anywhere outside Atlas (the item rail's own keys).
  useEffect(() => {
    if (leaving) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (useAtlasUiStore.getState().sheet) return;
      if (document.querySelector('[data-radix-popper-content-wrapper]')) return;
      const active = document.activeElement as HTMLElement | null;
      const root = rootRef.current;
      const inAtlas = !active || active === document.body || (!!root && root.contains(active));
      if (!inAtlas) return;
      if (active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return;
      e.preventDefault();
      useAtlasUiStore.getState().endWalk(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [leaving, rootRef]);

  // The panel's keys: arrows step, Enter on the panel itself is Next (a
  // button's Enter is the button's), and Tab stays politely inside.
  const onPanelKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey) return;
    if (e.key === 'Tab') {
      const list = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]') ?? []
      );
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panelRef.current)) {
        e.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus({ preventScroll: true });
      }
      return;
    }
    if (e.shiftKey) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || (e.key === 'Enter' && e.target === panelRef.current)) {
      e.preventDefault();
      next();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      back();
    }
  };

  // The veil comes up a frame after it mounts (a colour change, so it has
  // something to ease from) and lifts on the closing stop and as it leaves.
  const [veilUp, setVeilUp] = useState(reduced);
  useEffect(() => {
    if (reduced) return;
    const raf = requestAnimationFrame(() => setVeilUp(true));
    return () => cancelAnimationFrame(raf);
  }, [reduced]);
  const veil = veilUp && !leaving && !finished && total > 0;

  const question = finished ? ATLAS_COPY.walkFinishedQuestion : (stop?.question ?? '');
  const detail = finished ? ATLAS_COPY.walkFinishedDetail : (stop?.detail ?? null);
  const announce = finished
    ? ATLAS_COPY.walkAnnounceFinished
    : card && stop
      ? ATLAS_COPY.walkAnnounce(index + 1, total, card.name, card.kindLabel, question)
      : '';
  // The live region mounts empty and takes each stop's words a frame later,
  // so the first stop is announced too (a region born full often is not).
  const [spoken, setSpoken] = useState('');
  useEffect(() => {
    if (typeof requestAnimationFrame === 'undefined') return;
    const raf = requestAnimationFrame(() => setSpoken(leaving ? '' : announce));
    return () => cancelAnimationFrame(raf);
  }, [announce, leaving]);
  // While the focus sheet is up (a double-click on the card in the cut-out),
  // the walk waits under it, unseen, and comes back as the sheet closes.
  const hidden = sheetOpen;

  return (
    <>
      <WalkVeil
        holeKey={finished ? null : key}
        at={at ?? null}
        up={veil}
        hidden={hidden}
        reduced={reduced}
        rootRef={rootRef}
      />
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={questionId}
        tabIndex={-1}
        inert={leaving || undefined}
        onKeyDown={onPanelKeyDown}
        onFocus={onPanelFocus}
        onBlur={onPanelBlur}
        data-testid="atlas-walk"
        data-walk-stop={finished ? 'finished' : (stop?.kind ?? undefined)}
        data-walk-card={key ?? undefined}
        data-phase={leaving ? 'leaving' : 'on'}
        data-click-away-ignore=""
        className={cn(
          'atlas-walk-panel absolute inset-x-0 bottom-4 z-[22] mx-auto flex w-[min(480px,calc(100%-28px))] flex-col gap-2.5',
          'rounded-[20px] border border-border bg-card px-4 pb-3.5 pt-3 text-card-foreground shadow-[var(--shadow-elev-panel)] outline-none'
        )}
        style={{
          visibility: hidden ? 'hidden' : undefined,
          transform: leaving ? 'translateY(14px) scale(0.98)' : undefined,
          transition: reduced ? 'none' : `transform ${ATLAS_MOTION.walkPanelMs}ms ${leaving ? ATLAS_EASE_EXIT : ATLAS_EASE_OUT}`,
          pointerEvents: leaving ? 'none' : undefined,
        }}
      >
        <h2 id={titleId} className="sr-only">
          {ATLAS_COPY.walk}
        </h2>
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span data-testid="atlas-walk-step" className="tabular-nums">
            {ATLAS_COPY.walkStep(Math.min(index + 1, total), total)}
          </span>
          <span>{ATLAS_COPY.walkCalm}</span>
        </div>
        {/* Progress, by a transform on one line: where the walk is, never a score. */}
        <div aria-hidden className="h-0.5 overflow-hidden rounded-full bg-muted">
          <div
            data-testid="atlas-walk-progress"
            className="h-full origin-left rounded-full bg-foreground/50"
            style={{
              transform: `scaleX(${total > 0 ? Math.min(1, (finished ? total : index + 1) / total) : 0})`,
              transition: reduced ? 'none' : `transform ${ATLAS_MOTION.walkProgressMs}ms ${ATLAS_EASE_OUT}`,
            }}
          />
        </div>
        <div key={finished ? 'finished' : (key ?? '')} className="atlas-walk-rise flex flex-col gap-1">
          {card && !finished && (
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <span
                aria-hidden
                className="size-2.5 flex-none rounded-[3px]"
                style={
                  card.resting
                    ? { boxShadow: `inset 0 0 0 1.5px ${card.color}`, background: 'var(--card)' }
                    : { background: card.color }
                }
              />
              <span className="truncate font-medium text-foreground">{card.name}</span>
              <span aria-hidden>·</span>
              <span className="flex-none">{card.kindLabel}</span>
            </div>
          )}
          <p id={questionId} data-testid="atlas-walk-question" className="m-0 text-[15px] font-semibold">
            {question}
          </p>
          {detail && (
            <p data-testid="atlas-walk-detail" className="m-0 truncate text-xs text-muted-foreground">
              {detail}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5" data-testid="atlas-walk-actions">
          {!finished &&
            stop?.actions.map((a) => (
              <button
                key={a.id}
                type="button"
                data-testid={`atlas-walk-${a.id}`}
                onClick={() => act(a)}
                className={WALK_BUTTON}
              >
                {a.label}
              </button>
            ))}
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              data-testid="atlas-walk-back"
              onClick={back}
              disabled={!finished && index <= 0}
              aria-keyshortcuts="ArrowLeft"
              className={cn(WALK_BUTTON, 'disabled:pointer-events-none disabled:text-muted-foreground')}
            >
              {ATLAS_COPY.walkBack}
            </button>
            {finished ? (
              <button
                ref={nextRef}
                type="button"
                data-testid="atlas-walk-done"
                onClick={end}
                aria-keyshortcuts="Escape"
                className={WALK_MAIN}
              >
                {ATLAS_COPY.walkDone}
                <kbd aria-hidden className="rounded-[5px] border border-background/30 px-1 font-mono text-[10px] font-semibold">
                  {ATLAS_COPY.escKey}
                </kbd>
              </button>
            ) : (
              <>
                <button
                  type="button"
                  data-testid="atlas-walk-done"
                  onClick={end}
                  aria-keyshortcuts="Escape"
                  className={WALK_BUTTON}
                >
                  {ATLAS_COPY.walkDone}
                </button>
                <button
                  ref={nextRef}
                  type="button"
                  data-testid="atlas-walk-next"
                  onClick={next}
                  aria-keyshortcuts="ArrowRight Enter"
                  className={WALK_MAIN}
                >
                  {ATLAS_COPY.walkNext}
                  {/* Lime at full strength, on its own element: nothing above it is faded. */}
                  <kbd
                    aria-hidden
                    className="rounded-[5px] bg-primary px-1 font-mono text-[10px] font-semibold text-[var(--lime-ink)]"
                  >
                    {ATLAS_COPY.walkEnterKey}
                  </kbd>
                </button>
              </>
            )}
          </div>
        </div>
        <p className="sr-only" aria-live="polite" aria-atomic="true" data-testid="atlas-walk-announce">
          {leaving ? '' : spoken}
        </p>
      </section>
    </>
  );
}

const WALK_BUTTON =
  'inline-flex items-center gap-1.5 rounded-[9px] bg-muted px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring';
const WALK_MAIN =
  'inline-flex items-center gap-1.5 rounded-[9px] bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:bg-foreground/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/**
 * The veil with its cut-out: one SVG path over the board, the whole board
 * with a rounded hole around the walk's card, filled with a colour (never an
 * opacity) and drawn with fill-rule evenodd, so the hole is unpainted and a
 * press in it reaches the card. A press on the veil does nothing (and keeps
 * focus where it is).
 *
 * It follows the camera by writing the path directly, from a store
 * subscription and, while the hole moves between cards, its own frames, so a
 * flight re-renders no card and not even this component. The hole slides
 * from card to card on the camera's curve and time; reduced motion jumps.
 */
function WalkVeil({
  holeKey,
  at,
  up,
  hidden,
  reduced,
  rootRef,
}: {
  holeKey: string | null;
  at: Point | null;
  up: boolean;
  hidden: boolean;
  reduced: boolean;
  rootRef: RefObject<HTMLDivElement | null>;
}) {
  const pathRef = useRef<SVGPathElement>(null);
  const target = useRef<Rect | null>(null);
  const drawn = useRef<Rect | null>(null);
  const slide = useRef<{ from: Rect; t0: number | null } | null>(null);
  const raf = useRef<number | null>(null);
  const cardEl = useRef<HTMLElement | null>(null);
  const height = useRef(ATLAS_CARD_H);
  const ro = useRef<ResizeObserver | null>(null);

  const draw = useCallback(() => {
    const path = pathRef.current;
    if (!path) return;
    const to = target.current;
    let world = to;
    const s = slide.current;
    if (to && s) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      s.t0 ??= now;
      const t = Math.min(1, (now - s.t0) / ATLAS_MOTION.flyMs);
      world = lerpRect(s.from, to, easeInOutCubic(t));
      if (t >= 1) slide.current = null;
    }
    drawn.current = world;
    const cam = useAtlasUiStore.getState().camera;
    const hole = world ? walkHoleRect(world, cam, HOLE_PAD) : null;
    path.setAttribute('d', walkScrimPath(hole, CARD_RADIUS * cam.z + HOLE_PAD));
  }, []);

  // The card's drawn height (an expanded card is taller), watched, so the
  // hole fits it. The card may mount later than the stop (a walk started far out).
  const watchCard = useCallback(
    (key: string | null) => {
      const el = key ? (rootRef.current?.querySelector<HTMLElement>(`[data-atlas-card="${key}"]`) ?? null) : null;
      if (el === cardEl.current) return;
      ro.current?.disconnect();
      cardEl.current = el;
      if (!el) return;
      height.current = el.offsetHeight || ATLAS_CARD_H;
      if (typeof ResizeObserver === 'undefined') return;
      ro.current = new ResizeObserver(() => {
        height.current = el.offsetHeight || ATLAS_CARD_H;
        if (target.current) target.current = { ...target.current, h: height.current };
        draw();
      });
      ro.current.observe(el);
    },
    [rootRef, draw]
  );
  useEffect(() => () => ro.current?.disconnect(), []);

  // A new stop: the hole slides from where it is drawn to the new card.
  const atX = at?.x;
  const atY = at?.y;
  useLayoutEffect(() => {
    watchCard(holeKey);
    const next = holeKey && atX !== undefined && atY !== undefined ? { x: atX, y: atY, w: ATLAS_CARD_W, h: height.current } : null;
    const from = drawn.current;
    target.current = next;
    slide.current = !reduced && from && next ? { from, t0: null } : null;
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    draw();
    if (!slide.current || typeof requestAnimationFrame === 'undefined') return;
    // While the camera moves (the walk's own flight), its subscription below
    // already draws each frame: the slide's frame draws only on a frame the
    // camera stood still, so the path is written once a frame, not twice.
    let camSeen = useAtlasUiStore.getState().camera;
    const step = () => {
      const cam = useAtlasUiStore.getState().camera;
      if (cam === camSeen) draw();
      camSeen = cam;
      raf.current = slide.current ? requestAnimationFrame(step) : null;
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
    };
  }, [holeKey, atX, atY, reduced, draw, watchCard]);

  // Every camera move (the walk's flight, a pan or a pinch mid-walk) redraws
  // the path, and only the path.
  useEffect(
    () =>
      useAtlasUiStore.subscribe((s, prev) => {
        if (s.camera === prev.camera) return;
        if (!cardEl.current?.isConnected) watchCard(target.current ? holeKey : null);
        draw();
      }),
    [draw, watchCard, holeKey]
  );

  // The veil sits beside the board's surface, not in it, so it takes the
  // board's wheel itself (as the minimap's corner does): a wheel pans and a
  // pinch or Ctrl+wheel zooms Atlas, never the page.
  useEffect(() => {
    const path = pathRef.current;
    if (!path) return;
    const onWheel = (e: WheelEvent) => {
      const surface = rootRef.current?.querySelector<HTMLElement>('[data-testid="atlas-surface"]');
      atlasWheel(e, surface ?? (path.ownerSVGElement as unknown as HTMLElement));
    };
    path.addEventListener('wheel', onWheel, { passive: false });
    return () => path.removeEventListener('wheel', onWheel);
  }, [rootRef]);

  // A drag on the veil pans the board, as a drag on the bare board does. A
  // press that does not move does nothing (and keeps focus where it is).
  const pan = useRef<{ id: number; x: number; y: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<SVGPathElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    pan.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointers can't always capture; panning still follows moves.
    }
  };
  const onPointerMove = (e: ReactPointerEvent<SVGPathElement>) => {
    const p = pan.current;
    if (!p || p.id !== e.pointerId) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (dx === 0 && dy === 0) return;
    p.x = e.clientX;
    p.y = e.clientY;
    const ui = useAtlasUiStore.getState();
    ui.setCamera(panBy(ui.camera, dx, dy));
  };
  const endPan = (e: ReactPointerEvent<SVGPathElement>) => {
    if (pan.current?.id === e.pointerId) pan.current = null;
  };

  // z-[18]: over the board and its cards, under the walk's panel (z-[22])
  // and, on purpose, under the minimap (z-20): the minimap is wayfinding, and
  // panning with it mid-walk is as welcome as panning on the veil.
  return (
    <svg
      aria-hidden
      data-testid="atlas-walk-scrim"
      data-click-away-ignore=""
      className="pointer-events-none absolute inset-0 z-[18] size-full overflow-visible"
      style={{ visibility: hidden ? 'hidden' : undefined }}
    >
      <path
        ref={pathRef}
        data-testid="atlas-walk-veil"
        data-up={up ? 'true' : undefined}
        fillRule="evenodd"
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        style={{
          fill: up ? WALK_VEIL : 'transparent',
          pointerEvents: up ? 'auto' : 'none',
          touchAction: 'none',
          transition: reduced ? 'none' : `fill ${ATLAS_MOTION.walkScrimMs}ms ${ATLAS_EASE_OUT}`,
        }}
      />
    </svg>
  );
}
