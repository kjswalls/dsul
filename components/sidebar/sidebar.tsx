'use client';

import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronRight } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

/**
 * The grip shared by both states: a rounded rectangle exactly as wide as the
 * shell's 12px gutter (gap-3), so it stops at the two cards' facing edges and
 * touches neither. That width is the whole constraint — a round chip big
 * enough to hold a glyph cannot fit in 12px, which is why this shape replaced
 * one. Anything that widens the box (`ring-*`, which draws OUTSIDE it, or px-*)
 * puts it back over the cards; `border` is safe because border-box counts it
 * inward, leaving 10px of content.
 *
 * rounded-[3px] rather than a full capsule: at 12×32 a pill is all shoulder and
 * reads as a bead threaded onto the track, where a rectangle reads as a part
 * you can take hold of. 3 and not 4 — a quarter of the width still shows a
 * corner; much past that and the shoulders take over again.
 */
const GRIP_CLASS =
  'flex h-8 w-3 items-center justify-center rounded-[3px] border border-border ' +
  'bg-surface-2 text-muted-foreground shadow-[var(--shadow-elev-sm)] ' +
  'transition-opacity duration-150';

/**
 * The drag glyph: a 2×3 grid of 2px squares, the universal "take hold of this"
 * mark. Squares rather than lucide's GripVertical, whose dots are circles —
 * this palette spends round marks on values and square ones on identity and
 * chrome (see the schedule block's HandleGrip, same 1px-radius square).
 *
 * 2px squares on a 1.5px gap, and those two numbers are coupled: take the
 * squares to 2.5 and the gap no longer separates them — each row fuses into a
 * short bar and the grid stops reading as a grid. 5.5px wide inside a 10px
 * content box, so it clears the borders without the grip growing past the
 * gutter.
 */
function GripDots() {
  return (
    <span aria-hidden className="grid grid-cols-2 gap-[1.5px]">
      {Array.from({ length: 6 }, (_, i) => (
        <span key={i} className="h-[2px] w-[2px] rounded-[0.5px] bg-current" />
      ))}
    </span>
  );
}
import { Braindump } from '@/components/sidebar/braindump';
import { SidebarDock } from '@/components/sidebar/sidebar-dock';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Wordmark } from '@/components/primitives/wordmark';
import {
  clampSidebarGrowth,
  clampSidebarWidth,
  renderedSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useSidebarStore,
} from '@/lib/sidebar-store';
import { useRailStore } from '@/lib/rail-store';
import { prefersReducedMotion } from '@/lib/zen-transition';
import { cn } from '@/lib/utils';
import { useLayoutDef } from '@/lib/look-store';

/**
 * What a docked right rail holds back (lib/rail-store.ts), read when it is
 * needed rather than subscribed in render: the column yields to it
 * (renderedSidebarWidth, published below), and the drag and the nudges cap
 * their growth with it (clampSidebarGrowth). The stored width never hears of
 * it, so the braindump goes back to the user's width when the rail closes.
 */
const railReserve = () => useRailStore.getState().reservePx;

/** What the column renders at right now: the stored width, yielded beside a docked rail. */
const renderedNow = () =>
  renderedSidebarWidth(useSidebarStore.getState().leftSidebarWidth, window.innerWidth, railReserve());

/** Arrow-key step on the focused handle, and its shift-held coarse step. */
const NUDGE_PX = 8;
const NUDGE_COARSE_PX = 48;

/**
 * How far the pointer travels before a press on the sash becomes a drag. A
 * hand's tremor on a press moved the column a pixel or two and committed it:
 * on the grip that ate the click (a moved press is a drag, not a collapse),
 * and beside a docked rail it stored the yielded width less a pixel, so the
 * braindump never went back to the user's width when the rail closed.
 */
const DRAG_SLOP_PX = 3;

/** How long the pointer rests on the collapsed edge before the column peeks. */
const PEEK_DELAY_MS = 150;

/** Never fires — `mounted` below only needs the server-vs-client snapshot split. */
const noopSubscribe = () => () => {};

/**
 * The sash tooltip's px readout. Its own component so it reads the width the
 * column renders at when the tooltip opens (Radix mounts the content then) and
 * whenever the stored width changes under it (a key nudge with the tooltip up
 * re-renders the column), without the column holding that width in state.
 */
function RenderedWidth() {
  const px = Math.round(renderedNow());
  return (
    <>
      <span className="font-num text-xs text-foreground">{px}px</span>
      {px === SIDEBAR_DEFAULT_WIDTH && <span className="text-2xs text-muted-foreground">default</span>}
    </>
  );
}

/**
 * Desktop sidebar v2: the Braindump on the warm backdrop (header card + list
 * on paper) over the SidebarDock — one card holding identity, session
 * history, and the omnibar. Chat has no bar of its own; it grows out of the
 * dock when summoned from the omnibar.
 *
 * The column is drag-resizable from a sash in the 12px gutter between it and
 * the body panel. The width travels as the `--sidebar-w` CSS variable rather
 * than a React style value, and a drag writes that variable directly on
 * <html> — so the column tracks the pointer without re-rendering the braindump
 * list, the dock, and the relay canvases on every move. React only hears about
 * it twice per drag (start and end); the store commit happens on release, which
 * is also the only thing that touches localStorage. The same holds for a window
 * resize and for the right rail docking or leaving: both move the variable,
 * and neither renders anything here.
 *
 * memo'd, with no props, and it reads only the sidebar-store fields it draws
 * from: DesktopShell re-renders for the right column's overlay, and Ask's
 * `askOpen` lives in the same store, so a whole-store read re-rendered the
 * braindump on every Ctrl+J.
 */
export const Sidebar = memo(function Sidebar() {
  const edgeTab = useLayoutDef().slots.edge === 'tab';
  const {
    leftSidebarOpen,
    leftSidebarHovered,
    leftSidebarHoverEnabled,
    setLeftSidebarHovered,
    setLeftSidebarOpen,
    leftSidebarWidth,
    setLeftSidebarWidth,
    toggleLeftSidebar,
  } = useSidebarStore(
    useShallow((s) => ({
      leftSidebarOpen: s.leftSidebarOpen,
      leftSidebarHovered: s.leftSidebarHovered,
      leftSidebarHoverEnabled: s.leftSidebarHoverEnabled,
      setLeftSidebarHovered: s.setLeftSidebarHovered,
      setLeftSidebarOpen: s.setLeftSidebarOpen,
      leftSidebarWidth: s.leftSidebarWidth,
      setLeftSidebarWidth: s.setLeftSidebarWidth,
      toggleLeftSidebar: s.toggleLeftSidebar,
    }))
  );
  const peeking = leftSidebarHoverEnabled && leftSidebarHovered && !leftSidebarOpen;
  const isVisible = leftSidebarOpen || peeking;

  const columnRef = useRef<HTMLDivElement>(null);
  const sashRef = useRef<HTMLDivElement | null>(null);
  /**
   * `startPending` is the width the gesture starts from, as `pendingRef` is
   * seeded with it: a drag that ends back on it chose nothing (endDrag).
   */
  const dragRef = useRef<{
    startX: number;
    startWidth: number;
    startPending: number;
    onButton: boolean;
  } | null>(null);
  /** Set once a drag actually moves the column (past DRAG_SLOP_PX), so a
   *  press that never went anywhere can still be read as a click on the
   *  collapse button. */
  const movedRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const pendingRef = useRef(leftSidebarWidth);
  const [resizing, setResizing] = useState(false);
  // The handle mounts after hydration. The server renders the default width
  // while the rehydrated store renders the persisted one, so a handle carrying
  // aria-valuenow would be a guaranteed attribute mismatch on every session
  // that ever resized. Same trick and same reason as hooks/use-media-query.ts:
  // the server snapshot is false, so the server branch always renders first and
  // hydration can't disagree. Deferring one commit costs nothing visible.
  const mounted = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  );
  // navigator.platform to match omnibar.tsx and app-shell.tsx's KbdHint rather
  // than introduce a second way of asking; read through the same server-false
  // snapshot as `mounted` so it can't mismatch on hydration either.
  const isMac = useSyncExternalStore(
    noopSubscribe,
    () => /Mac|iPhone|iPad|iPod/.test(navigator.platform),
    () => false
  );
  const collapseHint = isMac ? '⌘[' : 'Ctrl+[';

  const publish = useCallback((px: number) => {
    document.documentElement.style.setProperty('--sidebar-w', `${px}px`);
  }, []);

  /**
   * The same, landing at once rather than over the column's 300ms ease: the
   * yield that comes with the rail's own instant first reveal at boot (so a
   * launch with Ask resting open never slides the braindump), the yield the
   * column mounts beside (mountingRef, below), and every yield under reduced
   * motion. Never a change of the stored width after that: a nudge, a reset
   * or a drag's commit eases beside a docked rail exactly as it does without
   * one. The transition is held off for exactly this one style change: the
   * forced read lays the new width out with it off, and clearing it again
   * starts nothing, because the width is already there.
   */
  const publishInstant = useCallback(
    (px: number) => {
      const el = columnRef.current;
      if (!el) return publish(px);
      el.style.transition = 'none';
      publish(px);
      void el.offsetWidth;
      el.style.transition = '';
    },
    [publish]
  );

  /**
   * The width the sash reports (aria-valuenow; its tooltip reads the same,
   * RenderedWidth): the one on screen, which beside a docked rail is the
   * yielded width and not the stored one. The keys step from it, so it is the
   * number they change. Written onto the sash rather than held in state: it
   * moves on every window resize while the viewport or a docked rail binds,
   * and a state here re-rendered the whole braindump and the dock for each.
   */
  const showRendered = useCallback((px: number) => {
    sashRef.current?.setAttribute('aria-valuenow', String(Math.round(px)));
  }, []);
  /** The sash mounts after hydration and on every reopen: it reports at once. */
  const attachSash = useCallback((el: HTMLDivElement | null) => {
    sashRef.current = el;
    if (el) el.setAttribute('aria-valuenow', String(Math.round(renderedNow())));
  }, []);

  /**
   * True for the column's first frame. The yield it mounts beside lands at
   * once (the column's first paint is globals.css's default, and easing from
   * it would slide the braindump on every launch with an item open), and so
   * does a second publish in that same frame: the persisted width arriving
   * with hydration, a commit behind zustand's server snapshot. After it, a
   * change of the stored width eases (publishInstant).
   */
  const mountingRef = useRef(true);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      mountingRef.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  /**
   * The width as actually laid out. Only the drag wants this: grabbing the sash
   * has to start from where the column visually IS, which is not the stored
   * width if flex shrank it or the viewport ceiling capped it — or if it is
   * still mid-transition from a collapse.
   */
  const measured = useCallback(
    () => columnRef.current?.getBoundingClientRect().width ?? leftSidebarWidth,
    [leftSidebarWidth]
  );

  /**
   * What the column is resting at: the stored width as published, viewport
   * ceiling and a docked rail's yield included (renderedNow). The keyboard
   * steps from THIS rather than from `measured` precisely because the column
   * animates — two arrow presses inside the 300ms ease would otherwise both
   * read a half-finished box and land somewhere between one step and two, so a
   * held key crawled instead of stepping.
   *
   * Read straight off the stores rather than from the render's closure, so a
   * key repeat that outruns a commit still steps from the newest value.
   */
  const settled = useCallback(() => renderedNow(), []);

  // Store → CSS var, on mount, on commit, whenever the window resizes, and
  // whenever the right rail docks or leaves. The viewport ceiling and the
  // rail's yield are applied to what gets PUBLISHED and deliberately not
  // written back to the store: shrink the window, or dock the rail, and the
  // column yields; grow it again, or close the rail, and the width you chose
  // comes back rather than staying where the squeeze pinned it.
  //
  // The rail is heard through a subscription, not a render: the column's
  // RailColumn publishes its reserve in a layout effect, and this writes the
  // variable inside that same notification, so the rail and the yield land
  // in one frame and nothing here re-renders the braindump for it.
  useEffect(() => {
    const apply = (instant = false) => {
      if (dragRef.current) return; // a live drag owns the variable
      const px = renderedSidebarWidth(leftSidebarWidth, window.innerWidth, railReserve());
      if (instant) publishInstant(px);
      else publish(px);
      showRendered(px);
    };
    // Mounting beside a rail that is already docked (an item open at boot)
    // lands on the yield at once (mountingRef). Every later run is a change
    // of the stored width, which eases.
    apply(mountingRef.current && railReserve() > 0);
    const onResize = () => apply();
    window.addEventListener('resize', onResize);
    const unsubscribe = useRailStore.subscribe((rail, prev) => {
      if (rail.reservePx === prev.reservePx) return;
      apply(rail.reserveInstant || prefersReducedMotion());
    });
    return () => {
      window.removeEventListener('resize', onResize);
      unsubscribe();
    };
  }, [leftSidebarWidth, publish, publishInstant, showRendered]);

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    setResizing(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    // A press that never moved chose no width, so it writes none, and nor
    // does a drag that came back to where it began (a wobble, or a shrink
    // dragged back out into the growth cap, which while the column is
    // yielded IS where it began). The stored width stays the user's: beside a
    // docked rail the column is laid out at its yielded width, and committing
    // either would have made the yield permanent. The variable goes back to
    // what the column renders at, in case the rail moved while the gesture
    // held it.
    if (!movedRef.current || pendingRef.current === drag.startPending) {
      const px = renderedNow();
      publish(px);
      showRendered(px);
      // A press on the collapse button that never moved is a click. This is
      // resolved here rather than with an onClick on the button because the
      // sash takes pointer capture on the way down: pointerup retargets to the
      // sash, so the browser's click lands on the sash, not on the button
      // inside it. Deciding from the pointerdown target and whether the column
      // actually moved is the only reading that survives that. A drag out and
      // back on the grip moved, so it never collapses.
      if (drag.onButton && !movedRef.current) toggleLeftSidebar();
      return;
    }
    // Commit, then publish what the column renders for it: the move's last
    // frame may not have landed, and a rail that docked mid-drag (when the
    // live drag held the variable) is yielded to now. Both are settled here
    // rather than left to the store-change effect, which does not run when
    // the drag ends on the width it started from.
    setLeftSidebarWidth(pendingRef.current);
    const px = renderedNow();
    publish(px);
    showRendered(px);
  }, [publish, setLeftSidebarWidth, showRendered, toggleLeftSidebar]);

  // A drag that outlives the component (route change, shell swap) would leave
  // the body stuck in col-resize with text unselectable.
  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (dragRef.current) {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    },
    []
  );

  // Hover intent on the expand zone. A peek that opened the instant the
  // pointer arrived would swap the zone for the peeked column before a click
  // could land, so throwing the mouse at the edge and clicking — the obvious
  // way to reopen — only ever peeked. A pointer that clicks within this window
  // docks the column; one that rests on the edge peeks (PEEK_DELAY_MS).
  const peekTimerRef = useRef<number | null>(null);
  const cancelPeek = () => {
    if (peekTimerRef.current !== null) window.clearTimeout(peekTimerRef.current);
    peekTimerRef.current = null;
  };
  useEffect(() => cancelPeek, []);
  // The zone unmounts when anything else shows the column (⌘[, a command),
  // and an unmounted zone hears no mouseleave — so a pending peek would land
  // on a docked column and outlive the next collapse.
  useEffect(() => {
    if (isVisible) cancelPeek();
  }, [isVisible]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const startWidth = measured();
    // From where the column IS (beside a docked rail, its yielded width); a
    // press that never moves, or a drag that ends back here, commits nothing
    // at all (endDrag).
    const startPending = clampSidebarWidth(startWidth, window.innerWidth);
    dragRef.current = {
      startX: e.clientX,
      startWidth,
      startPending,
      // Pressing the collapse button still ARMS a drag rather than blocking
      // one — the button sits in the middle of the sash, which is where a hand
      // naturally lands, and a 22px dead zone for dragging would be a worse
      // trade than resolving the ambiguity on release.
      onButton: !!(e.target as Element | null)?.closest('[data-sash-collapse]'),
    };
    movedRef.current = false;
    pendingRef.current = startPending;
    setResizing(true);
    // Held on the body, not the handle: pointer capture routes the events here
    // but the cursor still resolves against whatever is under the pointer, so
    // without this the arrow flickers back to text/pointer over the canvas.
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // Still a press until the pointer has really travelled (DRAG_SLOP_PX).
    if (!movedRef.current && Math.abs(e.clientX - drag.startX) < DRAG_SLOP_PX) return;
    const next = clampSidebarGrowth(
      drag.startWidth + (e.clientX - drag.startX),
      drag.startWidth,
      window.innerWidth,
      railReserve()
    );
    if (next === pendingRef.current) return;
    movedRef.current = true;
    pendingRef.current = next;
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      publish(pendingRef.current);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Enter is the double-click's reset, and like it sets the stored width:
    // beside a docked rail the column keeps its yield until the rail closes.
    if (e.key === 'Enter') {
      e.preventDefault();
      setLeftSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
      return;
    }
    const step = e.shiftKey ? NUDGE_COARSE_PX : NUDGE_PX;
    const from = settled();
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = from - step;
    else if (e.key === 'ArrowRight') next = from + step;
    else if (e.key === 'Home') next = SIDEBAR_MIN_WIDTH;
    else if (e.key === 'End') next = SIDEBAR_MAX_WIDTH;
    if (next === null) return;
    e.preventDefault();
    const target = clampSidebarGrowth(next, from, window.innerWidth, railReserve());
    // A step that cannot move the column (growth while it is yielded, or at a
    // bound) writes nothing, so it cannot trade the stored width for the
    // squeezed one.
    if (target !== from) setLeftSidebarWidth(target);
  };

  return (
    <div
      data-tour="left-sidebar"
      className="relative flex h-full"
      onMouseLeave={() => {
        cancelPeek();
        if (leftSidebarHovered) setLeftSidebarHovered(false);
      }}
    >
      <div
        ref={columnRef}
        data-testid="sidebar-column"
        // Read by layouts that dress the column (app/globals.css, [data-book]):
        // padding on a w-0 box would hold it open, and the peek keeps its shadow.
        data-column-state={peeking ? 'peek' : isVisible ? 'open' : 'closed'}
        className={cn(
          // pt-[31px] matches the canvas header so the Braindump title row lines
          // up vertically with the date selector (both 43px from window top per
          // Figma). pb-[16px] lifts the bottom dock capsule 28px off the window.
          'relative flex h-full flex-col gap-3 overflow-hidden pt-[31px] pb-[16px] transition-all duration-300',
          isVisible ? 'w-[var(--sidebar-w)]' : 'w-0',
          // The 300ms ease is what makes the collapse read as a fold. On a drag
          // it reads as lag, so the column goes to direct manipulation for the
          // duration and picks the transition back up on release.
          resizing && 'transition-none',
          // titlebar-hole: in the desktop app the band over this column's top would
          // otherwise read as the pointer leaving, and end the peek.
          peeking && 'titlebar-hole absolute left-0 top-0 bottom-0 z-[24] rounded-card bg-surface-0 shadow-soft-lg'
        )}
      >
        {/* The wordmark lives IN the top padding, not in the flow. pt-[31px] is
            what lines the Braindump capsule up with the canvas's date capsule,
            and a mark in flow would push the header down by its own height
            plus the column's gap — so it is drawn over that band instead, and
            the one number keeps guaranteeing the line-up. The 25px inset is
            the capsule's 10px plus the pill's 15px, so the word starts over
            the count's first figure. Out of the braindump <section> on purpose:
            it names the app, not the list, and stays out of that section's
            testid scope. No opacity on it or any parent — its dot is lime.

            In the macOS desktop app the traffic lights take the word's place at x 37
            and the word starts 14px past them: env(titlebar-area-x) is the lights'
            right edge plus their own 37px inset, and this column starts at 12, so
            37 - 14 + 12 = 35 (electron/lib/window-chrome.cjs; a test pins both).
            Everywhere else the env() is undefined and the inset stays 25px. The word
            is a hole in the window-drag band (so its hover still fires) only while
            the column shows: a collapsed column clips it, but its box would still
            punch an undraggable patch beside the lights. */}
        <Wordmark
          className={cn(
            'pointer-events-none absolute inset-x-0 top-0 h-[31px] pr-[25px] pl-[max(25px,calc(env(titlebar-area-x,0px)_-_35px))] text-foreground select-none',
            isVisible && 'titlebar-hole-word'
          )}
          data-testid="sidebar-wordmark"
        />
        <Braindump />
        <SidebarDock />
      </div>

      {/* The peek's footprint, claimed the instant the peek starts. The column
          eases its width in over 300ms, and a pointer thrown at the pin below
          outruns that growing edge: it lands on <main>, the wrapper hears a
          mouseleave, and the peek shuts before the pin is reached. This
          transparent layer spans the column's FINAL width under the column
          (just under it), so everything between the edge and the pin
          is inside the wrapper from the first frame. It only ever covers
          pixels the column is about to cover anyway.

          The peek's three layers sit at 23–25, not 10–30, because <main> makes
          no stacking context: its children's z-indexes compete with these in
          the root layer, and Week × Schedule's pinned hour gutter
          (WEEK_GUTTER_Z = 22) would otherwise paint over the peeked card and
          catch the pointer on its way to the pin, ending the peek. */}
      {mounted && peeking && (
        <div
          aria-hidden
          data-testid="sidebar-peek-footprint"
          // A hole in the desktop app's drag band for the same reason as the column.
          className="titlebar-hole absolute left-0 top-0 z-[23] h-full w-[var(--sidebar-w)]"
        />
      )}

      {/* Keep open — the peek's own way to become permanent. Hovering the
          edge unmounts the expand zone (see below) and the peeked column
          covers its pixels, so without this the only route from a peek to a
          docked column was ⌘[. It sits on the peeked card's right edge at the
          collapse grip's height, with its chevron: the same object in the same
          place as its two twins.

          The hit box is deliberately lopsided: 18px over the column, 6px past
          its edge. Docking moves the edge 12px right (the gutter reappears),
          and the collapse grip lands centred there, starting 6px past where
          this edge was — so nothing here overlaps it, and an impatient second
          click can't dock and then collapse in one gesture. 48px tall rather
          than full-height, so it takes no clicks from the list's right edge.

          It fades in over the column's own 300ms rather than sitting at its
          final x ahead of the card. The fade is on the zone and nothing in it
          carries a transform: tw-animate-css's enter keyframe animates
          transform too, and would slide a translated grip in from its offset.
          It is a descendant of the wrapper, so reaching it keeps the peek. */}
      {mounted && peeking && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid="sidebar-peek-pin"
              aria-label="Keep sidebar open"
              onClick={() => setLeftSidebarOpen(true)}
              className={cn(
                'group absolute left-[calc(var(--sidebar-w)-18px)] top-[calc(50%-24px)] z-[25] flex h-12 w-6 cursor-pointer items-center pl-3',
                'animate-in fade-in duration-300 focus-visible:outline-none'
              )}
            >
              <span
                aria-hidden
                data-testid="sidebar-peek-pin-grip"
                className={cn(
                  GRIP_CLASS,
                  'group-hover:text-foreground group-hover:shadow-[var(--shadow-elev-md)]',
                  'group-focus-visible:text-foreground group-focus-visible:border-primary'
                )}
              >
                <ChevronRight className="h-2.5 w-2.5 shrink-0" />
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" align="center">
            <div className="px-0.5 text-2xs font-medium text-muted-foreground">Sidebar</div>
            <div className="mt-0.5 px-0.5 text-xs text-foreground">Keep open ({collapseHint})</div>
          </TooltipContent>
        </Tooltip>
      )}

      {/* The sash. It occupies the shell's 12px gutter exactly (left-full w-3),
          overlapping neither the sidebar's contents nor the body panel's
          rounded edge, so there is no click it can steal. Docked-open only: in
          hover-peek the column is absolutely positioned and the wrapper has
          collapsed to zero width, which would strand this at x=0 on top of the
          peeked card. */}
      {mounted && leftSidebarOpen && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              ref={attachSash}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
              // aria-valuenow is written by showRendered / attachSash, not
              // rendered: it is the width on screen, which moves with the
              // window and the rail without a render.
              aria-valuemin={SIDEBAR_MIN_WIDTH}
              aria-valuemax={SIDEBAR_MAX_WIDTH}
              tabIndex={0}
              data-testid="sidebar-resize-handle"
              data-resizing={resizing ? 'true' : 'false'}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onLostPointerCapture={endDrag}
              onKeyDown={onKeyDown}
              onDoubleClick={() => setLeftSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
              // outline-none because the bar below IS the focus indicator — a
              // ring drawn around a transparent gutter strip reads as a stray
              // rectangle floating between two cards.
              className="titlebar-hole group absolute left-full top-0 z-30 h-full w-3 cursor-col-resize touch-none focus-visible:outline-none"
            >
              {/* Rest is a transparent bar rather than a faded one: every state
                  change here is background-color, so the accent is only ever
                  drawn at full strength (CLAUDE.md — the lime doesn't dim).
                  inset-y-8 keeps both ends clear of the body panel's 30px
                  corner radius.

                  muted-foreground, NOT border, for the hover state: --border is
                  a hairline token and resolves to oklch(1 0 0 / 10%) in dark
                  mode, so a 3px bar drawn in it disappears against the dark
                  backdrop entirely. This has to read in both themes, and
                  muted-foreground is re-pointed per theme where the alpha
                  hairline isn't.

                  left-full, not left-1/2: the track is centred on the PANEL's
                  edge (the sash's right edge), not on the gutter, so it stays
                  concentric with the grip below. Leave this at the gutter's
                  centre and the two sit 6px apart — the grip reads as hanging
                  off the line instead of threaded onto it. */}
              <span
                aria-hidden
                className={cn(
                  'absolute inset-y-8 left-full w-[3px] -translate-x-1/2 rounded-full transition-colors duration-150',
                  resizing
                    ? 'bg-primary'
                    : 'bg-transparent group-hover:bg-muted-foreground/50 group-focus-visible:bg-primary'
                )}
              />

              {/* Collapse, on the sash's midpoint. It lives here rather than in
                  the braindump header because both of the things that act on
                  the column as an object — how wide it is, whether it's there
                  at all — now sit on the column's own edge, and centred so it
                  reads as the seam's own control rather than as something the
                  header lost.

                  left-full puts it on the PANEL's edge rather than in the
                  middle of the gutter, matching the collapsed-state grip
                  exactly: one control, one line, whichever state you are in, so
                  collapsing and reopening never look like two different objects
                  in two different places. It overhangs the panel by 6px and
                  clears the braindump column entirely — which is the difference
                  from the 22px chip this replaced, and why it no longer reads as
                  debris wedged between two cards.

                  Centring costs one thing, and it is a deliberate trade:
                  double-click-to-reset no longer works ON the grip, because a
                  press here answers before the reset can and the first click
                  has already collapsed by the time a second would arrive. There
                  is no arbitrating that on the way down without delaying
                  collapse behind a dblclick timer, which would make the primary
                  action feel broken to save a recovery one. So reset stays on
                  the rest of the track — 656 of the sash's 696px — and the
                  tooltip names the two zones rather than saying "the sash".

                  It is a <span>, not a <button>: the sash owns pointer capture,
                  so a real button's click never fires (see endDrag) and a
                  nested focusable would put a second, mute tab stop in the
                  gutter. role + aria-label give assistive tech the button. */}
              <span
                data-sash-collapse
                role="button"
                aria-label="Collapse sidebar"
                className={cn(
                  GRIP_CLASS,
                  'absolute left-full top-1/2 -translate-x-1/2 -translate-y-1/2',
                  // Full strength at rest, same as its collapsed-state twin.
                  // The opacity ramp it used to have made the one mouse route
                  // to collapsing quietest exactly when you had not yet found
                  // it, and there is nothing on this seam for it to compete
                  // with anyway.
                  'opacity-100',
                  resizing
                    // Must not brighten mid-drag: pointer capture latches
                    // :hover onto the sash for the whole gesture, so the grip
                    // would sit lit under a cursor that is doing something else.
                    ? 'pointer-events-none'
                    // Feedback moves to colour and elevation now that opacity is
                    // spent — the same two channels the expand grip uses, so
                    // both answer a pointer identically.
                    : 'group-hover:text-foreground group-hover:shadow-[var(--shadow-elev-md)] group-focus-visible:text-foreground group-focus-visible:border-primary'
                )}
              >
                {/* Dots, not a chevron. This grip's PRIMARY gesture is the
                    drag — the click-to-collapse is the secondary one the
                    tooltip explains — so the glyph names the thing you can do
                    to it anywhere along the track, not the one action it
                    happens to fire on release. The collapsed-state grip keeps a
                    chevron for the opposite reason: nothing is draggable then. */}
                <GripDots />
              </span>
            </div>
          </TooltipTrigger>

          {/* The sash's only documentation. A bare col-resize cursor says
              "drag" and nothing else, so the two affordances that aren't in the
              cursor — the reset and the arrow keys — have nowhere else to live.
              Radix opens this on FOCUS as well as hover, which is the half that
              matters: the keyboard controls announce themselves the moment a
              keyboard user lands here, instead of being a thing you had to
              already know about. ⌘K then Tab is the whole path: the omnibar is
              the tab stop immediately before this one.

              Radix closes a tooltip on pointerdown and won't reopen it until
              the pointer leaves and returns, which is why nothing pops up over
              the canvas mid-drag or the instant you let go. The px readout is
              therefore what you see on the way IN to a resize, not a live
              counter — the column itself is the live feedback. */}
          <TooltipContent side="right" align="center">
            <div className="px-0.5 text-2xs font-medium text-muted-foreground">Sidebar width</div>
            <div className="mt-0.5 flex items-baseline gap-1.5 px-0.5">
              <RenderedWidth />
            </div>
            <div className="mt-1.5 space-y-0.5 border-t border-border px-0.5 pt-1.5 text-2xs text-muted-foreground">
              <div>Click the grip to collapse ({collapseHint})</div>
              {/* "the track", not "the sash": the grip owns the middle of it
                  and answers a click before a reset can land, so naming the
                  whole thing here would document a gesture that fails on the
                  one spot the eye goes to. */}
              <div>Double-click the track to reset</div>
              <div>
                <span className="font-num">←</span> <span className="font-num">→</span> to nudge ·{' '}
                <span className="font-num">⇧</span> for bigger steps
              </div>
            </div>
          </TooltipContent>
        </Tooltip>
      )}

      {/* Expand — the collapse grip's mirror: same shape, same vertical centre,
          chevron flipped. Collapsing and reopening therefore happen at one
          fixed height on screen instead of the control jumping to the panel's
          top-left corner, which is where it used to live (desktop-shell.tsx).

          It does NOT sit in the gutter the way its twin does — it straddles the
          panel's left edge, half over the canvas. The twin has to stay clear of
          both cards because it lives ON the resize track between two surfaces
          that are both present; this one has nothing to its left but 24px of
          empty backdrop, so hiding in that margin only makes the single control
          on an otherwise bare edge harder to spot. Overlapping the panel is
          what gives it a surface to cast its shadow onto and read as sitting on
          top of something.

          The 12px grip is only the MARK. The button is a full-height 32px zone
          running the length of the panel's left edge, so reopening is a throw
          of the mouse at that side rather than a hunt for a 12×32 target — the
          grip tells you where, the zone forgives you for missing.

          32px = the 24px of bare backdrop left of the panel, plus 8px over it.
          That 8px is the ceiling, not a taste call: canvas-container carries
          32px of padding and stops centring once <main> is narrower than its
          1100px cap, so on a small window real content begins 32px inside the
          panel (40px in the day grid, which adds pl-2). Widening this zone past
          that starts eating clicks meant for the view.

          A real <button>: no sash, no pointer capture, so a plain click works
          and its own tab stop is the only keyboard route to reopening.

          Gated on !isVisible rather than !leftSidebarOpen, so it also stands
          down during a hover-peek: the column is on screen then, overlaying
          this exact spot, and a control inviting you to "expand" on top of the
          panel you are already reading is noise. Unmounting it out from under a
          stationary pointer is safe — the wrapper closes a peek on its own
          onMouseLeave and this zone is one of its descendants, but Chrome does
          not re-fire enter/leave for a stationary pointer when the element
          under it is replaced by an ancestor's own subtree, and the peeked
          column covers these pixels within a frame regardless. Verified, not
          assumed: tests/e2e/sidebar-resize.spec.ts holds a peek open under a
          parked pointer and re-checks it 1.5s later. */}
      {mounted && !isVisible && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid="sidebar-expand-zone"
              // A layout that draws the zone as a labelled `braindump` tab names
              // it that way too, so the visible word is in the accessible name.
              aria-label={edgeTab ? 'Expand braindump' : 'Expand sidebar'}
              onClick={() => {
                cancelPeek();
                toggleLeftSidebar();
              }}
              // Takes over the hover-peek trigger that used to be its own strip
              // inside <main> (desktop-shell.tsx). This zone covers those pixels
              // now, so leaving both would mean the strip simply never fired —
              // one edge, one owner. Delayed by PEEK_DELAY_MS so a click can
              // still land on it.
              onMouseEnter={() => {
                if (!leftSidebarHoverEnabled) return;
                cancelPeek();
                peekTimerRef.current = window.setTimeout(() => {
                  peekTimerRef.current = null;
                  // Live state, not this render's: the setting or the column
                  // may have changed in the last 150ms.
                  const s = useSidebarStore.getState();
                  if (!s.leftSidebarOpen && s.leftSidebarHoverEnabled) setLeftSidebarHovered(true);
                }, PEEK_DELAY_MS);
              }}
              onMouseLeave={cancelPeek}
              className={cn(
                'titlebar-hole group absolute -left-3 top-0 z-50 h-full w-8 cursor-pointer',
                'focus-visible:outline-none'
              )}
            >
              <span
                aria-hidden
                data-testid="sidebar-expand-grip"
                className={cn(
                  GRIP_CLASS,
                  // left-6 is the shell's own geometry: 12px p-3 + 12px gap-3
                  // puts the panel edge 24px from this zone's left edge, and
                  // the -50% centres the 12px grip on it.
                  'absolute left-6 top-1/2 -translate-x-1/2 -translate-y-1/2',
                  // Full strength, always. It is the only affordance on an
                  // otherwise empty edge, with nothing nearby to compete with,
                  // so the resting fade its twin needs would just make the one
                  // thing there harder to see.
                  'opacity-100',
                  // Feedback lands on the grip rather than as a wash over the
                  // zone: a 32px full-height rectangle lighting up beside the
                  // panel reads as a rendering fault, where the mark you are
                  // aiming at sharpening reads as an answer.
                  'group-hover:text-foreground group-hover:shadow-[var(--shadow-elev-md)]',
                  'group-focus-visible:text-foreground group-focus-visible:border-primary'
                )}
              >
                <ChevronRight className="h-2.5 w-2.5 shrink-0" />
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" align="center">
            <div className="px-0.5 text-2xs font-medium text-muted-foreground">Sidebar</div>
            <div className="mt-0.5 px-0.5 text-xs text-foreground">
              Expand ({collapseHint})
            </div>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
});
