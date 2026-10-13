'use client';

import { memo, useEffect, useRef, useState, type UIEvent } from 'react';
import { useSwipeable, type SwipeEventData } from 'react-swipeable';

import { UserProfileDropdown } from '@/components/planner/user-profile-dropdown';
import { MobileHeader } from '@/components/mobile/mobile-header';
import { MobileBottomDock } from '@/components/mobile/mobile-bottom-dock';
import { MobileViewRouter } from '@/components/mobile/mobile-view-router';
import { AskTab } from '@/components/mobile/ask-tab';
import { SetupTab } from '@/components/mobile/setup-tab';
import { ScheduleSheet } from '@/components/mobile/schedule-sheet';
import { BraindumpSheet } from '@/components/mobile/braindump-sheet';
import { ModSheet } from '@/components/mods/mod-sheet';
import { setModSheetHost } from '@/lib/mods/ui/open-panel';
import { PlannerSyncLine } from '@/components/shell/planner-sync-line';
import {
  chatOffered,
  setupPageShown,
  shownMobileTab,
  useMobileNavStore,
} from '@/lib/mobile-nav-store';
import { useUIStore } from '@/lib/ui-store';
import { useViewStore } from '@/lib/view-store';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { useRailStore } from '@/lib/rail-store';
import { rowSwipeActive, closeAllRowSwipes } from '@/lib/row-swipe';
import { SectionBoundary } from '@/components/primitives/section-boundary';
import { cn } from '@/lib/utils';

/**
 * The shell's height while a soft keyboard is up.
 *
 * `100dvh` is the LAYOUT viewport, which the keyboard does not shrink on iOS and
 * shrinks only under `interactive-widget=resizes-content` on Android — so a
 * bottom-docked input is the first thing the keyboard covers, and a shell that
 * cannot scroll has no way to bring it back. Clamping the column to the VISUAL
 * viewport lands the dock on top of the keyboard instead, for the omnibar and
 * the chat composer alike.
 *
 * The 120px floor is what separates a keyboard from a URL bar: Safari's chrome
 * costs the visual viewport ~60–90px whenever it is expanded, and reacting to
 * that would resize the shell every time the page is scrolled up.
 *
 * The occlusion is measured against `vv.height * vv.scale`, not `vv.height`:
 * pinch-zoom shrinks the visual viewport by the scale factor for a reason that
 * has nothing to do with anything covering it, and iOS Safari has ignored
 * `maximum-scale` for pinch since iOS 10 (app/layout.tsx asks anyway). Raw
 * heights made a 1.2× pinch read as a 133px keyboard and collapsed the whole
 * column — header, content and dock — into the top half of the screen, taking
 * DaySchedule's derived hour height down with it.
 */
function useKeyboardSafeHeight(): number | null {
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () =>
      setHeight(window.innerHeight - vv.height * vv.scale > 120 ? vv.height : null);
    sync();
    vv.addEventListener('resize', sync);
    return () => vv.removeEventListener('resize', sync);
  }, []);

  return height;
}

/**
 * Whether a swipe began inside something that scrolls sideways (a reply's
 * code block: chat-transcript.tsx's `[&_pre]:overflow-x-auto`). That drag is
 * the box's own scroll, and is not also Back or a tab change: swiping a long
 * line back into view must not pop the conversation it is in. Read off the
 * box as laid out, so one that fits its content takes the swipe as usual.
 */
function startedInSideScroller(e: SwipeEventData | undefined): boolean {
  let el = e?.event.target instanceof Element ? e.event.target : null;
  while (el && el !== document.body) {
    if (el.scrollWidth > el.clientWidth) {
      const x = getComputedStyle(el).overflowX;
      if (x === 'auto' || x === 'scroll') return true;
    }
    el = el.parentElement;
  }
  return false;
}

/** How far a view must scroll in one direction before the dock folds or unfolds. */
const FOLD_DELTA_PX = 12;
/** Scrolled less than this from the top, the dock is always unfolded. */
const FOLD_TOP_PX = 40;
/**
 * After a fold or an unfold, scroll events are ignored this long: the dock's
 * height change resizes the view under it, and the scroll that resize causes
 * is not the person's.
 */
const FOLD_SETTLE_MS = 300;

/**
 * Mobile layout: the iPhone app's chrome around the web's own views (mobile
 * web round 3, memory/handoffs/mobile-web.md, picked 2026-10-13). The top row
 * (date, layout capsule, avatar) on Today, the surface, and the dock: the
 * capture bar, the Today · Ask · Organize tab pill and Search. Braindump is a
 * sheet over Today (components/mobile/braindump-sheet.tsx), opened from the
 * capture bar's count, not a tab.
 *
 * Ask is there while the AI gate offers it (lib/ai-registry.ts): Ask while
 * something answers, and in its place the setup page or the fix home
 * (components/mobile/setup-tab.tsx) while the gate invites or offers the fix.
 * Surfaces reuse the desktop primitives (DayBuckets/DayList/DaySchedule via
 * MobileViewRouter, the rail's Ask views via AskTab, the setup column's
 * pieces via SetupTab, the shared Braindump in the sheet). Rendered under the
 * shell's single DndContext, so items stay draggable, braindump to hour
 * included.
 *
 * There is no swipe between tabs any more: it fought the browser's own edge
 * swipe and the rows' swipe actions. Inside Ask a swipe right is still Back.
 *
 * Content sits directly on the paper backdrop; the keyed cross-fade box below
 * carries the layout duties (min-h-0 / flex-1 / overflow-hidden, so each
 * view's own full-height ScrollArea has something to be full-height OF).
 */
export const MobileShell = memo(function MobileShell() {
  const storedTab = useMobileNavStore((s) => s.activeTab);
  const openDialog = useUIStore((s) => s.openDialog);
  const shellHeight = useKeyboardSafeHeight();
  const density = useViewStore((s) => s.phoneDensity);
  const caps = useAICapabilities();
  const { known, canChat } = caps;
  const offered = chatOffered(caps);
  // Offered and nothing answers: the chat tab hosts the setup page (or the
  // fix home), which is not Ask and wears none of Ask's markers.
  const setupShown = setupPageShown(caps);

  /**
   * The chat tab exists only while the gate offers it: Ask, or the setup page
   * or the fix home in Ask's place. A key that stops working therefore keeps
   * the tab, and the conversation on it turns into the fix home in place, its
   * stack and draft kept for when the fix lands. A tab the user was on when
   * nothing is offered any more (No AI chosen, chat turned off here, a sign-in
   * as someone without AI) renders as Today in the SAME frame — this value —
   * and the effect below moves the stored tab there once the gate has
   * actually answered. Not while it is unknown: a session start is not news
   * that chat went away, and the store's tab is the user's place.
   */
  const activeTab = shownMobileTab(storedTab, offered);
  useEffect(() => {
    if (known && !offered && storedTab === 'chat') {
      useMobileNavStore.getState().setActiveTab('today');
    }
  }, [known, offered, storedTab]);

  // Close any open row swipe-actions when switching tabs.
  useEffect(() => closeAllRowSwipes(), [activeTab]);

  // A mod's panel opens in this shell's sheet while it is mounted, never in
  // the desktop rail (lib/mods/ui/open-panel.ts).
  useEffect(() => setModSheetHost(), []);

  // Inside Ask, a swipe right is Back: a conversation or an item pops to what
  // it was opened from (the iOS edge-swipe, and the one gesture the capsule's
  // ‹ answers on a screen with no hardware back). Only while Ask is what
  // shows: on the setup page or the fix home the stack is under a page that
  // has no Back. Tabs are no longer a swipe apart.
  const swipeHandlers = useSwipeable({
    onSwipedRight: (e?: SwipeEventData) => {
      if (rowSwipeActive.current || startedInSideScroller(e)) return;
      const rail = useRailStore.getState();
      if (activeTab === 'chat' && canChat && rail.stacks.phone.length > 0) rail.back('phone');
    },
    trackMouse: false,
    delta: 50,
    preventScrollOnSwipe: false,
  });

  /**
   * The dock's fold (round 3's minimized dock): scrolling Today's view down
   * folds it into one row, scrolling up or reaching the top unfolds it. Read
   * off the scroll of whichever box scrolled (scroll does not bubble, but it
   * is captured), keyed per box, so a view's inner scrollers each count from
   * their own position.
   */
  const lastScroll = useRef(new WeakMap<EventTarget, number>());
  const foldSettledAt = useRef(0);
  const onContentScroll = (e: UIEvent<HTMLDivElement>) => {
    if (activeTab !== 'today') return;
    const el = e.target as HTMLElement;
    // The braindump sheet scrolls its own list, which is not the day's.
    if (el.closest?.('[data-testid="braindump-sheet"]')) return;
    const top = el.scrollTop;
    const prev = lastScroll.current.get(el);
    lastScroll.current.set(el, top);
    if (prev === undefined || performance.now() - foldSettledAt.current < FOLD_SETTLE_MS) return;
    const nav = useMobileNavStore.getState();
    // Never while the capture bar is in use: folding would move it under the
    // thumb, and its placeholder would change mid-thought.
    if (document.activeElement?.closest('[data-testid="mobile-dock"]')) return;
    const fold =
      top < FOLD_TOP_PX ? false : top - prev > FOLD_DELTA_PX ? true : prev - top > FOLD_DELTA_PX ? false : null;
    if (fold === null || fold === nav.dockMinimized) return;
    foldSettledAt.current = performance.now();
    nav.setDockMinimized(fold);
  };

  /**
   * The one user menu for Ask, or the setup page in its place, whose header is
   * a capsule rather than Today's top row. MobileHeader mounts its own on
   * Today, so exactly one is in the tree at a time — which is also the
   * contract `waitForAppReady` leans on when it looks up "User menu" without
   * disambiguating.
   */
  const userMenu = (
    // The avatar is sized down to 24px for the capsule, which is 13px shorter
    // than the Today card: the shared trigger's 32px leaves 2.5px of clearance
    // in a 37px pill and its hover ring eats even that, where both artboards
    // (BraindumpTab.dc.html, ChatTab.dc.html) draw 24. The BUTTON stays at 28,
    // so the drawn size matches the artboard and the touch target matches its
    // row-mates: braindump.tsx grew the display menu, the organize button and
    // the add button to 28px for this row precisely because it is aimed at with
    // a thumb, and this is the only route to Settings on either tab. Done from
    // the mount, as the header's DisplayMenu wrapper is, so the desktop trigger
    // and the Today card's copy keep the default.
    <span className="flex [&>button]:size-7 [&_[data-slot=avatar]]:size-6">
      <UserProfileDropdown
        settingsHref="/settings/day"
        onOpenBugReport={() => openDialog({ type: 'bug-report' })}
      />
    </span>
  );

  return (
    <div
      // mobile-ground: the CSS half of the --canvas alias below. A token whose
      // value was already color-mixed on <html> cannot see an inline override
      // here, so the two --bkt-tray* tokens are re-cut against this element in
      // app/globals.css instead. Class, not inline style, because they only
      // move in dark mode.
      className="mobile-ground relative flex flex-col bg-background md:hidden"
      // Compact rows (app/globals.css), the layout capsule's menu's choice.
      data-density={density}
      style={{
        height: shellHeight ? `${shellHeight}px` : '100dvh',
        // `--canvas` means "the surface the views are painted on", and with the
        // panel gone that surface IS the paper backdrop here. It is not a
        // cosmetic alias: a dozen marks under this tree paint a 1px halo or an
        // opaque cover in it so they read as sitting ON the view — the
        // schedule's beads and lane caps, the swipe-row's sliding face. In
        // light mode canvas and paper are within 0.01 L and nothing showed;
        // dark mode puts them 0.04 apart, which is a visible lighter ring
        // around every bead and a lighter strip behind every swiped row. Scoped
        // to this shell, so the desktop canvas keeps its own value.
        //
        // It is not the answer for Buckets, and no alias could be: rows there
        // sit on a bucket CARD (`--bkt-card` = surface-2), which is a different
        // colour again. SwipeRow stopped naming a ground for that reason — its
        // face is transparent now and reads whatever is under it — so nothing
        // below this line depends on --canvas being the right colour for every
        // surface in the shell at once.
        ['--canvas' as string]: 'var(--background)',
      }}
    >
      <MobileHeader
        settingsHref="/settings/day"
        onOpenBugReport={() => openDialog({ type: 'bug-report' })}
      />

      {/* The past-due pill used to sit here, mounted on Today only — which is
          also what made it a per-tab surface with a single global open flag, and
          the source of a drawer that could open on a tab it wasn't rendered on.
          It is a line in the bottom dock now
          (components/sidebar/dock-notices.tsx), which is mounted on every tab
          except Chat, so Braindump and Chat gained a voice they never had and
          Today got its 38px of content back. morning-check.tsx still owns both
          halves of the open-flag fix, because the desktop⇄mobile shell swap can
          still strand a tray. */}

      <div
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
        {...swipeHandlers}
        onScrollCapture={onContentScroll}
      >
        {/* The braindump sheet, over Today's view and above the dock, so
            the capture bar, its count and the tabs stay in reach while it is
            open (components/mobile/braindump-sheet.tsx). */}
        <BraindumpSheet />

        {/* The look-only preview's sync line (planner-sync-line.tsx), along the
            content's top edge under the header card. Here, outside the keyed
            tab below, so a tab change neither remounts it nor fades it. */}
        <PlannerSyncLine className="absolute inset-x-6 top-0 z-[5]" />

        {/* Keyed on activeTab → a soft cross-fade on tab change (auto-disabled
            under [data-reduce-motion]). Not into Ask: its home carries the lime
            accent (a run come back), which never fades through a parent's
            opacity (CLAUDE.md), and AskTab slides its own views instead. The
            setup page in Ask's place has nothing lime, so it fades as the
            others do; when it turns into Ask the key holds (`chat` either way),
            nothing remounts, and the class is gone in the same commit that
            mounts Ask. */}
        <div
          key={activeTab}
          className={cn(
            'flex min-h-0 flex-1 flex-col overflow-hidden',
            (activeTab !== 'chat' || setupShown) && 'animate-in fade-in-0 duration-200'
          )}
        >
          {/* One boundary per tab body (#74): this div is keyed by the tab, so
              switching tabs remounts it and clears a caught error. The dock
              below stays up either way. */}
          <SectionBoundary label={activeTab === 'chat' ? 'chat' : 'day'}>
          {activeTab === 'chat' && canChat && <AskTab headerAccessory={userMenu} />}
          {activeTab === 'chat' && setupShown && <SetupTab headerAccessory={userMenu} />}

          {/* Straight onto the paper. `canvas-container` already narrows its
              2rem desktop gutter to the artboards' 14px under 768px, so the
              views need nothing from the shell but height. */}
          {activeTab === 'today' && <MobileViewRouter />}
          </SectionBoundary>
        </div>
      </div>

      <MobileBottomDock />

      <ScheduleSheet />
      <ModSheet />
    </div>
  );
});
