'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronRight } from 'lucide-react';

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
  clampSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useSidebarStore,
} from '@/lib/sidebar-store';
import { cn } from '@/lib/utils';

/** Arrow-key step on the focused handle, and its shift-held coarse step. */
const NUDGE_PX = 8;
const NUDGE_COARSE_PX = 48;

/** Never fires — `mounted` below only needs the server-vs-client snapshot split. */
const noopSubscribe = () => () => {};

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
 * is also the only thing that touches localStorage.
 */
export function Sidebar() {
  const {
    leftSidebarOpen,
    leftSidebarHovered,
    leftSidebarHoverEnabled,
    setLeftSidebarHovered,
    leftSidebarWidth,
    setLeftSidebarWidth,
    toggleLeftSidebar,
  } = useSidebarStore();
  const isVisible = leftSidebarOpen || (leftSidebarHoverEnabled && leftSidebarHovered);

  const columnRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startWidth: number; onButton: boolean } | null>(null);
  /** Set once a drag actually moves the column, so a press that never went
   *  anywhere can still be read as a click on the collapse button. */
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
   * ceiling included. The keyboard steps from THIS rather than from `measured`
   * precisely because the column animates — two arrow presses inside the 300ms
   * ease would otherwise both read a half-finished box and land somewhere
   * between one step and two, so a held key crawled instead of stepping.
   *
   * Read straight off the store rather than from the render's closure, so a key
   * repeat that outruns a commit still steps from the newest value.
   */
  const settled = useCallback(
    () => clampSidebarWidth(useSidebarStore.getState().leftSidebarWidth, window.innerWidth),
    []
  );

  // Store → CSS var, on mount, on commit, and whenever the window resizes.
  // The viewport clamp is applied to what gets PUBLISHED and deliberately not
  // written back to the store: shrink the window and the column yields, grow it
  // again and the width you chose comes back rather than staying where the
  // small window pinned it.
  useEffect(() => {
    const apply = () => {
      if (dragRef.current) return; // a live drag owns the variable
      publish(clampSidebarWidth(leftSidebarWidth, window.innerWidth));
    };
    apply();
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, [leftSidebarWidth, publish]);

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    publish(pendingRef.current); // flush a move that never got its frame
    setResizing(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    // A press on the collapse button that never moved is a click. This is
    // resolved here rather than with an onClick on the button because the sash
    // takes pointer capture on the way down: pointerup retargets to the sash,
    // so the browser's click lands on the sash, not on the button inside it.
    // Deciding from the pointerdown target and whether the column actually
    // moved is the only reading that survives that.
    if (drag.onButton && !movedRef.current) {
      toggleLeftSidebar();
      return;
    }
    setLeftSidebarWidth(pendingRef.current);
  }, [publish, setLeftSidebarWidth, toggleLeftSidebar]);

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

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startWidth: measured(),
      // Pressing the collapse button still ARMS a drag rather than blocking
      // one — the button sits in the middle of the sash, which is where a hand
      // naturally lands, and a 22px dead zone for dragging would be a worse
      // trade than resolving the ambiguity on release.
      onButton: !!(e.target as Element | null)?.closest('[data-sash-collapse]'),
    };
    movedRef.current = false;
    pendingRef.current = clampSidebarWidth(dragRef.current.startWidth, window.innerWidth);
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
    const next = clampSidebarWidth(drag.startWidth + (e.clientX - drag.startX), window.innerWidth);
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
    const step = e.shiftKey ? NUDGE_COARSE_PX : NUDGE_PX;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = settled() - step;
    else if (e.key === 'ArrowRight') next = settled() + step;
    else if (e.key === 'Home') next = SIDEBAR_MIN_WIDTH;
    else if (e.key === 'End') next = SIDEBAR_MAX_WIDTH;
    else if (e.key === 'Enter') next = SIDEBAR_DEFAULT_WIDTH;
    if (next === null) return;
    e.preventDefault();
    setLeftSidebarWidth(clampSidebarWidth(next, window.innerWidth));
  };

  return (
    <div
      data-tour="left-sidebar"
      className="relative flex h-full"
      onMouseLeave={() => leftSidebarHovered && setLeftSidebarHovered(false)}
    >
      <div
        ref={columnRef}
        data-testid="sidebar-column"
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
          leftSidebarHovered && !leftSidebarOpen && 'absolute left-0 top-0 bottom-0 z-20 rounded-card bg-surface-0 shadow-soft-lg'
        )}
      >
        {/* The wordmark lives IN the top padding, not in the flow. pt-[31px] is
            what lines the Braindump capsule up with the canvas's date capsule,
            and a mark in flow would push the header down by its own height
            plus the column's gap — so it is drawn over that band instead, and
            the one number keeps guaranteeing the line-up. The 25px inset is
            the capsule's 10px plus the pill's 15px, so the bolt stands over
            the count's first figure. Out of the braindump <section> on purpose:
            it names the app, not the list, and stays out of that section's
            testid scope. No opacity on it or any parent — the bolt is lime. */}
        <Wordmark
          className="pointer-events-none absolute inset-x-0 top-0 h-[31px] px-[25px] text-foreground select-none"
          data-testid="sidebar-wordmark"
        />
        <Braindump />
        <SidebarDock />
      </div>

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
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
              aria-valuenow={Math.round(leftSidebarWidth)}
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
              className="group absolute left-full top-0 z-30 h-full w-3 cursor-col-resize touch-none focus-visible:outline-none"
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
              <span className="font-num text-xs text-foreground">
                {Math.round(leftSidebarWidth)}px
              </span>
              {Math.round(leftSidebarWidth) === SIDEBAR_DEFAULT_WIDTH && (
                <span className="text-2xs text-muted-foreground">default</span>
              )}
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
              aria-label="Expand sidebar"
              onClick={toggleLeftSidebar}
              // Takes over the hover-peek trigger that used to be its own strip
              // inside <main> (desktop-shell.tsx). This zone covers those pixels
              // now, so leaving both would mean the strip simply never fired —
              // one edge, one owner.
              onMouseEnter={() => leftSidebarHoverEnabled && setLeftSidebarHovered(true)}
              className={cn(
                'group absolute -left-3 top-0 z-50 h-full w-8 cursor-pointer',
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
}
