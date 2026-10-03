'use client';

import { useCallback, useRef, useState } from 'react';
import { ProposalCard } from '@/components/ai/proposal-card';
import { DockNotices } from '@/components/sidebar/dock-notices';
import { UndoStrip } from '@/components/notices/undo-strip';
import { UserCard } from '@/components/sidebar/user-card';
import { Omnibar } from '@/components/sidebar/omnibar';
import { RelayField } from '@/components/primitives/relay-field';
import { useToastAnchor } from '@/hooks/use-toast-anchor';
import { RELAY } from '@/lib/relay-config';
import { useLayoutDef } from '@/lib/look-store';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { useChatCardHomeShown, useChatCardSurface, useChatHostCard } from '@/lib/open-chat';

/**
 * The sidebar dock ("menu dock" in Figma): one flat gray capsule holding the
 * user menu + session history on top and the omnibar (white pill) below.
 * Exact dims from the Figma file (6ZFClj80tMQOCYUhzyuWFL): gray 406×137 r10;
 * top row at y21; omnibar pill 385×48 r10 at y72. Chat is not here any more:
 * the omnibar's `?` asks into Ask, in the right column (components/ai/rail),
 * and the dock never grows for it.
 *
 * The same slot hosts the catch-up card whenever Ask home cannot. "Pick
 * things back up" is computed locally and must work with no AI at all, and its
 * card renders on the 'chat' surface, whose home is Ask home; with no Ask on
 * screen to carry it, the dock does, inside a plain capped box (ScrollArea
 * ignores max-h). The box mounts only while the card has something to show,
 * so the resting capsule is unchanged.
 *
 * It is also where the app SPEAKS — but from a STRIP above the capsule, not
 * from inside it. That is a placement decision (notices are not part of the
 * dock), and it is worth being precise about what it did and did not fix: at the
 * resting state the omnibar never moved for a notice, on either structure, at
 * any viewport height down to 360px — the capsule's bottom is pinned by the
 * column, so a row grows it upward into the braindump. What DID jump was the
 * undo toast, measured off this capsule's top edge; it is a strip row now and
 * measures nothing.
 *
 * The conversation still shares an edge — you type into the pill, the app
 * answers one row above it — and a notice tray still grows upward out of its row
 * into the same airspace as the omnibar's suggestion panel, one occupant at a
 * time. See components/sidebar/dock-notices.tsx and
 * memory/plans/notices-in-place.md.
 *
 * `placement="bottom"` is the layout slot `capture: 'prompt-bottom'`
 * (lib/layout-themes.ts): the same dock laid across the foot of the shell, the
 * omnibar a `>` prompt with the user row beside it rather than above. Nothing
 * else changes — same notices, same undo strip, same catch-up host (given a
 * fixed share of the height, since there is no column above it to grow into) —
 * so every capture path, the toast anchor and the onboarding tour's target come
 * along.
 */
export function SidebarDock({ placement = 'sidebar' }: { placement?: 'sidebar' | 'bottom' } = {}) {
  const { canChat } = useAICapabilities();
  // No `known` term, deliberately: while the gate is unknown or its read has
  // failed every capability is off, and catch-up must still have somewhere to
  // land. Mutually exclusive with the card's own home on screen (`!homeShown`:
  // Ask home, or the conversation it belongs to), so the card never renders
  // twice.
  //
  // LATCHED once it shows. The gate can open while the card is up: the first
  // status read answers, or a failed read is retried on the next tab return
  // (Supabase re-emits SIGNED_IN, and 'error' has no dedupe window), and that
  // can happen at any point in the review. The card's home would then be Ask,
  // and while Ask is not on screen (closed with Ctrl+J, or hidden at an
  // overlay width) the card would otherwise vanish mid-review. Latched, it
  // stays where it is until it is done (accepted, dismissed) or its home
  // shows, which then carries it. With Ask open (the user's choice; it
  // starts closed, ASK_OPEN_DEFAULT) its home shows the moment the gate
  // opens and the card moves there at once; otherwise it stays latched here
  // until it is done or Ask home shows. The lines the user dropped go with it, because they live in the proposal
  // store (`selection`), not in the card that remounts.
  const hostCard = useChatHostCard();
  // The catch-up card, or a conversation's plan when that is what the gate
  // closed under: both are chat's, and both outlive it.
  const hostSurface = useChatCardSurface();
  const homeShown = useChatCardHomeShown('desktop');
  const [hosting, setHosting] = useState(false);
  const showCatchUpHost = hostCard && !homeShown && (!canChat || hosting);
  // State that trails what is on screen, adjusted during render (React's
  // sanctioned pattern, as in components/zen/zen-stage.tsx), so the flip render
  // already sees the latch and the card never unmounts for a frame.
  if (showCatchUpHost !== hosting) setHosting(showCatchUpHost);
  const bottom = placement === 'bottom';
  // `capture: 'page-foot'` / `'caret'`: the same dock at the foot of the
  // braindump's page, its capsule and pill drawn as a bare ruled line or as an
  // editor's caret (app/globals.css, [data-dock-page]). Same omnibar, so every
  // mode and shortcut still works.
  const capture = useLayoutDef().slots.capture;
  const pageFoot = capture === 'page-foot' || capture === 'caret';
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Relay wakes up while the omnibar input is focused. Driven by the omnibar's
  // own focus (via onFocusChange) rather than the dock's focus-within: the
  // latter sticks lit when a menu returns focus to its trigger or a focused
  // input inside it unmounts, since neither fires a focusout that leaves the
  // container.
  const [focused, setFocused] = useState(false);
  // Bumped by the omnibar the moment focus lands: the relay's ripple restarts
  // from the focal point and flares. Separate from `focused` on purpose — that
  // drives a sustained brightness the field holds for as long as you're in the
  // input, this marks the instant you arrived.
  const [burst, setBurst] = useState(0);
  const pulse = useCallback(() => setBurst((n) => n + 1), []);

  // What sonner's remaining toasts (item dialog, bug report, store errors) sit
  // above. The ref is on the WRAPPER, not the capsule, so it clears the strip
  // too — a toast that floated through the notice rows would be the old
  // stacking problem in a new place. The capsule's own height no longer moves
  // with the notices at all; it moves with the catch-up card, and nothing else.
  useToastAnchor(wrapperRef);

  if (bottom) {
    return (
      <div
        ref={wrapperRef}
        data-testid="dock-bottom"
        className="relative flex flex-shrink-0 flex-col border-t border-border"
      >
        {/* Out of flow, notices and undo alike: everything above this dock
            is the canvas, whose height the schedule grid fits its hours to
            (lib/use-fit-hour-px.ts), so a row arriving here must not take
            height from it. z-[31] clears the item panel, which overlays the
            row at z-30 below 1180px. */}
        <div className="absolute inset-x-4 bottom-full z-[31] mb-1.5 flex flex-col gap-1.5 [&>*]:bg-canvas">
          <DockNotices alwaysVisible />
          <UndoStrip />
        </div>
        <div data-tour="dock" data-dock-surface className="relative flex flex-col">
          {/* The catch-up card's host when Ask home cannot carry it, as in
              the column below; capped at a fixed share of the height. */}
          {showCatchUpHost && (
            <div
              data-testid="dock-catch-up-host"
              className="max-h-[42vh] overflow-y-auto border-b border-border px-4 pt-3 pb-2"
            >
              <ProposalCard surface={hostSurface} />
            </div>
          )}
          {/* pr-16 once kept the user row clear of a help button fixed to the
              window's corner; the button is inside <main> now (help-menu.tsx),
              above this band, and the inset is kept as it was. */}
          <div className="flex items-center gap-3 py-2 pr-16 pl-4">
            <span aria-hidden className="flex-none font-mono text-sm text-success-text">
              &gt;
            </span>
            <div className="min-w-0 max-w-3xl flex-1">
              <Omnibar variant="dock" onFocusChange={setFocused} onPulse={pulse} />
            </div>
            <div className="ml-auto flex-none">
              <UserCard />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={wrapperRef}
      className="relative flex min-h-0 flex-col"
    >
      {/* THE STRIP: the app's notices, above the capsule instead of inside it.
          Both children render null when they have nothing to say, so the resting
          column is unchanged.

          The notice rows are in FLOW, and at the resting state that costs
          nothing measurable — the capsule's bottom is pinned by the
          column and the braindump's flex-1 absorbs the row, at every viewport
          height down to 360px.

          The undo row is NOT in flow, and that difference is measured rather
          than reasoned. It appears and vanishes on a 5s timer the instant after
          the user acts, so it is the one row whose arrival lands under a moving
          cursor; and with the catch-up card up in a short window the column
          has no slack left to absorb it. `absolute bottom-full` takes it out of the
          squeeze budget entirely, at the cost of needing an opaque ground since
          it now overlays the braindump's last row. */}
      <DockNotices />
      <UndoStrip className="absolute inset-x-0 bottom-full z-20 mb-1.5 bg-surface-0" />

      <div
        data-tour="dock"
        // The focus handoff target when a notice dismisses itself out from under
        // the keyboard: the capsule outlives every row in it and closes over the
        // gap the row leaves. See useDismissWithFocus in components/ai/morning-check.tsx.
        data-dock-surface
        data-dock-page={pageFoot ? capture : undefined}
        // No overflow-hidden here: the omnibar's suggestion panel grows upward
        // out of the dock, so clipping the capsule would cut it off. The relay
        // clips itself instead (its own rounded overflow-hidden, below).
        className="relative flex min-h-0 flex-col rounded-[10px] bg-surface-3 px-[10px] pt-[18px] pb-[14px] shadow-[var(--shadow-elev-bar)]"
      >
        {RELAY.dock && (
          <RelayField
            className="absolute inset-0 z-0 rounded-[10px]"
            tone="quiet"
            focalY={0.7}
            pitch={20}
            idleIntensity={0.2}
            activeIntensity={0.6}
            activeIntensityLight={0.4}
            active={focused}
            burst={burst}
            mask="radial-gradient(135% 120% at 50% 62%, black 30%, transparent 100%)"
          />
        )}
        {showCatchUpHost && (
          <div
            data-testid="dock-catch-up-host"
            className="relative z-10 mb-3 max-h-[50vh] overflow-y-auto"
          >
            <ProposalCard surface={hostSurface} />
          </div>
        )}
        <div className="relative z-10">
          <UserCard />
        </div>
        <div className="relative z-10 mt-5">
          <Omnibar
            variant="dock"
            onFocusChange={setFocused}
            onPulse={pulse}
            placeholder={pageFoot ? 'write a line…' : undefined}
          />
        </div>
      </div>
    </div>
  );
}
