'use client';

import { memo, useEffect, useState } from 'react';
import { useSwipeable, type SwipeEventData } from 'react-swipeable';

import { UserProfileDropdown } from '@/components/planner/user-profile-dropdown';
import { MobileHeader } from '@/components/mobile/mobile-header';
import { MobileBottomDock } from '@/components/mobile/mobile-bottom-dock';
import { MobileViewRouter } from '@/components/mobile/mobile-view-router';
import { AskTab } from '@/components/mobile/ask-tab';
import { ScheduleSheet } from '@/components/mobile/schedule-sheet';
import { Braindump } from '@/components/sidebar/braindump';
import { useMobileNavStore, mobileTabOrder, shownMobileTab } from '@/lib/mobile-nav-store';
import { useUIStore } from '@/lib/ui-store';
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

/**
 * Mobile layout: the header card (date row, plus the week strip on Today), the
 * active surface, and the bottom dock. The three-tab bar is gone — the dock's
 * mode card shows which surface you are on and opens the switcher sheet
 * (components/mobile/mode-switcher-sheet.tsx) to leave it; a swipe still walks
 * mobileTabOrder, Braindump · Today · Ask, and Ask only while something can
 * answer (lib/ai-registry.ts). Surfaces reuse the desktop primitives (shared
 * Braindump, DayBuckets/DayList via MobileViewRouter, the rail's Ask views via
 * AskTab) rather than the old bespoke panels. Rendered under the shell's
 * single DndContext, so items stay draggable.
 *
 * Content sits directly on the paper backdrop. The rounded `bg-canvas` panel it
 * used to float in — the mobile echo of the desktop canvas — is gone; on paper
 * that near-identical fill bought a hairline and a shadow and nothing else, and
 * it was the third bordered surface on a screen the redesign cut to two. Its
 * layout duties (min-h-0 / flex-1 / overflow-hidden, so each view's own
 * full-height ScrollArea has something to be full-height OF) were already
 * duplicated by the keyed cross-fade box below, which now carries them alone.
 */
export const MobileShell = memo(function MobileShell() {
  const storedTab = useMobileNavStore((s) => s.activeTab);
  const openDialog = useUIStore((s) => s.openDialog);
  const shellHeight = useKeyboardSafeHeight();
  const { known, canChat } = useAICapabilities();

  /**
   * The chat tab exists only while something can answer. A tab the user was on
   * when the capability dropped (a key revoked, OpenClaw unpaired, a sign-in
   * as someone without AI) renders as Today in the SAME frame — this value —
   * and the effect below moves the stored tab there once the gate has
   * actually answered. Not while it is unknown: a session start is not news
   * that chat went away, and the store's tab is the user's place.
   */
  const activeTab = shownMobileTab(storedTab, canChat);
  useEffect(() => {
    if (known && !canChat && storedTab === 'chat') {
      useMobileNavStore.getState().setActiveTab('today');
    }
  }, [known, canChat, storedTab]);

  // Close any open row swipe-actions when switching tabs.
  useEffect(() => closeAllRowSwipes(), [activeTab]);

  const swipeHandlers = useSwipeable({
    onSwipedLeft: (e?: SwipeEventData) => {
      if (rowSwipeActive.current) return; // a row swipe is in progress, not a tab swipe
      if (startedInSideScroller(e)) return;
      const order = mobileTabOrder(canChat);
      const idx = order.indexOf(activeTab);
      if (idx < order.length - 1) {
        useMobileNavStore.getState().setActiveTab(order[idx + 1]);
      }
    },
    onSwipedRight: (e?: SwipeEventData) => {
      if (rowSwipeActive.current || startedInSideScroller(e)) return;
      // Inside Ask, a swipe right is back before it is a tab change: a
      // conversation or an item pops to what it was opened from, and only Ask
      // home walks left to Today — the iOS edge-swipe, and the one gesture the
      // capsule's ‹ answers on a screen with no hardware back.
      const rail = useRailStore.getState();
      if (activeTab === 'chat' && rail.stacks.phone.length > 0) {
        rail.back('phone');
        return;
      }
      const order = mobileTabOrder(canChat);
      const idx = order.indexOf(activeTab);
      if (idx > 0) useMobileNavStore.getState().setActiveTab(order[idx - 1]);
    },
    trackMouse: false,
    delta: 50,
    preventScrollOnSwipe: false,
  });

  /**
   * The one user menu, for the two tabs whose header is a capsule rather than
   * the dated card. MobileHeader mounts its own on Today, so exactly one is in
   * the tree at a time — which is also the contract `waitForAppReady` leans on
   * when it looks up "User menu" without disambiguating.
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
      className="mobile-ground flex flex-col bg-background md:hidden"
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
      {/* One card, not two: the week strip is a row inside the header now, so
          the shell no longer mounts a day-strip beside it. */}
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

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden" {...swipeHandlers}>
        {/* Keyed on activeTab → a soft cross-fade on tab change (auto-disabled
            under [data-reduce-motion]). Not into Ask: its home carries the lime
            accent (a run come back), which never fades through a parent's
            opacity (CLAUDE.md), and AskTab slides its own views instead. */}
        <div
          key={activeTab}
          className={cn(
            'flex min-h-0 flex-1 flex-col overflow-hidden',
            activeTab !== 'chat' && 'animate-in fade-in-0 duration-200'
          )}
        >
          {/* One boundary per tab body (#74): this div is keyed by the tab, so
              switching tabs remounts it and clears a caught error. The dock
              below stays up either way. */}
          <SectionBoundary label={activeTab === 'chat' ? 'chat' : activeTab === 'braindump' ? 'braindump' : 'day'}>
          {activeTab === 'chat' && canChat && <AskTab headerAccessory={userMenu} />}

          {/* No Scope Rail under it any more — the rail is retired (#229) and
              its two jobs live on the group headers' pause switch and in the
              Display menu's "Paused scopes" list, both of which the mobile
              braindump already renders. Nothing takes its strip: the wrapper
              that held it carried `pt-2` and no `pb`, so the 8px under the
              quick-add well was always the dock's own `pt-2` and it is still
              there. (Main restored a `pb-2` for this on the floating canvas
              panel, whose rounded bottom corner was the thing it cleared —
              that panel is gone here, so the clearance has nothing to buy.) */}
          {activeTab === 'braindump' && (
            <Braindump variant="mobile" headerAccessory={userMenu} />
          )}

          {/* Straight onto the paper. `canvas-container` already narrows its
              2rem desktop gutter to the artboards' 14px under 768px, so the
              views need nothing from the shell but height. */}
          {activeTab === 'today' && <MobileViewRouter />}
          </SectionBoundary>
        </div>
      </div>

      <MobileBottomDock />

      <ScheduleSheet />
    </div>
  );
});
