'use client';

import { useEffect, useRef, useState } from 'react';
import { ChatComposer } from '@/components/ai/chat-composer';
import { ProposalCard } from '@/components/ai/proposal-card';
import { Omnibar } from '@/components/sidebar/omnibar';
import { DockNoticesMobile } from '@/components/sidebar/dock-notices';
import { UndoStrip } from '@/components/notices/undo-strip';
import { ModeSwitcherSheet } from '@/components/mobile/mode-switcher-sheet';
import { useToastAnchor } from '@/hooks/use-toast-anchor';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { useMobileNavStore } from '@/lib/mobile-nav-store';
import { revealChat, useChatCardSurface, useChatHostCard, useGeneralThreadId } from '@/lib/open-chat';
import { cn } from '@/lib/utils';

/**
 * Mobile bottom dock — the desktop sidebar-dock recipe, at phone width: one
 * surface-3 well (radius 10, `--shadow-elev-bar`, inset 10px) holding a single
 * row — the 44px mode card, then a white pill — with the app's notice strip
 * ABOVE it rather than inside it. Owns the bottom safe area. NOT overflow-hidden
 * — the omnibar's results panel opens upward out of it.
 *
 * The pill is the omnibar everywhere except the chat tab, where it is the chat
 * composer instead. One bar, one address for typing, whichever surface you are
 * on — which is the same argument that keeps the notice stack mounted here on
 * every tab.
 *
 * The soft radius-24 pill this replaces was the last surface still wearing the
 * old mobile chrome, and the three-tab bar under the omnibar went with it: the
 * mode card + its sheet (components/mobile/mode-switcher-sheet.tsx) are the way
 * between surfaces now, which is what let the well shrink from ~130px to 68px —
 * 88px counting this box's own 8px top gap and 12px bottom floor, and more only
 * where the safe-area inset exceeds that floor.
 *
 * The notice stack is capped at ONE row, the same as the desktop now that most
 * notices render on the thing they are about — anything past the first folds
 * into a "+N more" row that expands in place. See
 * memory/plans/notices-in-place.md.
 */
export function MobileBottomDock() {
  const activeTab = useMobileNavStore((s) => s.activeTab);
  const dockRef = useRef<HTMLDivElement>(null);
  const [chatFocusSignal, setChatFocusSignal] = useState(0);

  const { canChat } = useAICapabilities();
  /**
   * The chat tab, and only while something can answer. The shell shows Today
   * for a chat tab that cannot (components/shell/mobile-shell.tsx), so a
   * composer here would be a field that sends nowhere under the wrong surface.
   */
  const chatBar = activeTab === 'chat' && canChat;
  // The conversation the chat tab shows, and so the one this bar sends into.
  const generalThreadId = useGeneralThreadId();
  /**
   * The catch-up host. "Pick things back up" is local and needs no model
   * (lib/commands/registry.ts), and its card answers on the chat surface — so
   * when there is no chat tab to show it, it shows here, above the bar. No
   * `known` term: the gate is closed while its read is pending or failed, and
   * catch-up is the feature that must still work on that day. Mounted only
   * while the card has something to show, so a resting dock is unchanged.
   */
  const hostCard = useChatHostCard();
  // The catch-up card's surface, or the chat tab's conversation's plan.
  const hostSurface = useChatCardSurface();
  /**
   * Latched once it shows, as on the desktop (components/sidebar/sidebar-dock.tsx
   * says why): when the gate opens mid-review, the card's new home would be a
   * chat tab the user is not on, so unlatched it would vanish from Today and
   * come back with every dropped line ticked again. It stays until it is done
   * or the user goes to the chat tab, which then carries it (`!chatBar`, so it
   * never renders twice).
   */
  const [hosting, setHosting] = useState(false);
  const catchUpHost = hostCard && !chatBar && (!canChat || hosting);
  if (catchUpHost !== hosting) setHosting(catchUpHost);

  // Arriving on the chat tab puts the caret in the composer, exactly as it did
  // when the composer lived in the panel — the field moved down here, the
  // behaviour did not move with it on its own.
  useEffect(() => {
    if (chatBar) setChatFocusSignal((n) => n + 1);
  }, [chatBar]);

  // Measured, not estimated: app/globals.css pins the mobile toast at
  // `--toast-bottom`, and this dock's height moves with the notice stack, the
  // safe-area inset and the chat composer's wrapping. The ref sits on the
  // OUTERMOST box so every one of those is inside what the ResizeObserver
  // watches; the published value is `dock height + 8`, so it is correct at any
  // height rather than tuned to one.
  useToastAnchor(dockRef);

  return (
    <div
      ref={dockRef}
      data-testid="mobile-dock"
      // `max(12px, inset)` rather than `pb-safe`: the well still owns the safe
      // area, but both artboards draw an unconditional 12px under it and a bare
      // `env(safe-area-inset-bottom)` resolves to 0 on every device that reports
      // no inset — Android, iPhone SE, devtools emulation, the @mobile
      // Playwright project. The well would sit flush against the viewport edge
      // with its bottom corners and the downward half of `--shadow-elev-bar`
      // clipped off, while still showing its 10px gap left and right.
      className="px-[10px] pt-2 pb-[max(12px,env(safe-area-inset-bottom,0px))]"
    >
      {/* THE STRIP, above the well rather than inside it.
          This is a placement change here, not a geometry fix — the phone never
          had the problem. This dock is the last child of a fixed-height flex
          column, so it grows upward and the well's bottom edge (and the omnibar
          in it) measured 0px of movement in every configuration, notices inside
          the well or above it. What the move buys is one shape across both
          shells: the app's rows read as the app's rows, on the dock rather than
          in it.

          Mounted on every tab, chat included. The point of one voice with one
          address is that going quiet on the tab where the user is talking to
          the AI would put the two halves of the same conversation on different
          screens. */}
      <DockNoticesMobile />
      <UndoStrip className="mb-1.5" />

      {/* A plain overflow box, not ScrollArea: the Radix wrapper drops max-h.
          The margin lives on the box, which exists only while the card shows. */}
      {catchUpHost && (
        <div className="mb-1.5 max-h-[50vh] overflow-y-auto" data-testid="mobile-catch-up-host">
          <ProposalCard surface={hostSurface} />
        </div>
      )}

      <div
        className="rounded-[10px] bg-surface-3 p-[10px] shadow-[var(--shadow-elev-bar)]"
        // Focus handoff target for a self-dismissing notice — see
        // useDismissWithFocus in components/ai/morning-check.tsx.
        data-dock-surface
      >
        {/* items-end only where the bar can grow: the chat composer wraps
            upward and the mode card has to stay on the well's floor beside it
            rather than drift to the middle of a three-line bar. The omnibar is a
            fixed 48px, and there the artboards centre the 44px card in it. */}
        <div className={cn('flex gap-2', chatBar ? 'items-end' : 'items-center')}>
          <ModeSwitcherSheet />
          <div className="min-w-0 flex-1">
            {/* Both wear the same pill — 48px, radius 10, px-[22px], the
                key-rest shadow — so the dock leaves the skin to them and only
                says where it sits. Which one is mounted is the ONLY thing that
                changes between tabs; swapping the pill for an empty well was
                the phase-2 regression this closes. */}
            {chatBar ? (
              <ChatComposer
                variant="dock"
                binding={{ kind: 'conversation', id: generalThreadId }}
                focusSignal={chatFocusSignal}
              />
            ) : (
              // captureRelay: the radial relay
              // (components/primitives/relay-field.tsx) lives INSIDE this pill on
              // the phone and is struck once, when an item files itself. The
              // field cannot go behind the well — the mode card and the bar
              // cover it to its 10px padding, and a ripple in a picture-frame is
              // a ripple nobody sees — and the bar is where the verb happens
              // anyway. See the prop's docs in components/sidebar/omnibar.tsx.
              // variant="dock" is explicit for the same reason both desktop
              // mounts spell it out: the launcher (⌘K) mounts the same component
              // as variant="launcher", and the e2e helpers select a shell by
              // data-omnibar-variant. The phone has no launcher — its ⌘K path
              // focuses this bar — so this mount is always the dock.
              <Omnibar
                variant="dock"
                captureRelay
                onAskBeacon={() => revealChat(true)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
