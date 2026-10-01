'use client';

import { useCallback, useRef, useState } from 'react';
import { ChatPanel } from '@/components/sidebar/chat-panel';
import { DockNotices } from '@/components/sidebar/dock-notices';
import { UndoStrip } from '@/components/notices/undo-strip';
import { UserCard } from '@/components/sidebar/user-card';
import { Omnibar } from '@/components/sidebar/omnibar';
import { RelayField } from '@/components/primitives/relay-field';
import { useToastAnchor } from '@/hooks/use-toast-anchor';
import { RELAY } from '@/lib/relay-config';
import { useSidebarStore } from '@/lib/sidebar-store';
import { cn } from '@/lib/utils';

/**
 * The sidebar dock ("menu dock" in Figma): one flat gray capsule holding the
 * user menu + session history on top and the omnibar (white pill) below.
 * Exact dims from the Figma file (6ZFClj80tMQOCYUhzyuWFL): gray 406×137 r10;
 * top row at y21; omnibar pill 385×48 r10 at y72. Chat has no bar of its own
 * — when summoned from the omnibar (`?` / Ask Beacon / ⌘]) it mounts above the
 * user row and the capsule grows upward, shrinking the Braindump.
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
 * else changes — same notices, same undo strip, same chat (given a fixed share
 * of the height, since there is no column above it to grow into) — so every
 * capture path, the toast anchor and the onboarding tour's target come along.
 */
export function SidebarDock({ placement = 'sidebar' }: { placement?: 'sidebar' | 'bottom' } = {}) {
  const chatExpanded = useSidebarStore((s) => s.chatExpanded);
  const bottom = placement === 'bottom';
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Relay wakes up while the omnibar input is focused. Driven by the omnibar's
  // own focus (via onFocusChange) rather than the dock's focus-within: the
  // latter sticks lit when a menu returns focus to its trigger or the chat
  // input unmounts, since neither fires a focusout that leaves the container.
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
  // with the notices at all; it moves with chat, and nothing else.
  useToastAnchor(wrapperRef);

  if (bottom) {
    return (
      <div
        ref={wrapperRef}
        data-testid="dock-bottom"
        className="relative flex flex-shrink-0 flex-col border-t border-border"
      >
        <div className="px-4 empty:hidden [&>*]:mt-1.5">
          <DockNotices alwaysVisible />
        </div>
        <UndoStrip className="absolute inset-x-4 bottom-full z-20 mb-1.5 bg-canvas" />
        <div data-tour="right-sidebar" data-dock-surface className="relative flex flex-col">
          {chatExpanded && (
            <div className="flex h-[42vh] min-h-0 flex-col border-b border-border px-4 pt-3 pb-2">
              <ChatPanel focusSignal={1} />
            </div>
          )}
          {/* pr-16 keeps the user row clear of the help button, which is
              fixed to the window's bottom-right corner (help-menu.tsx). */}
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
      className={cn('relative flex min-h-0 flex-col', chatExpanded && 'flex-1')}
    >
      {/* THE STRIP: the app's notices, above the capsule instead of inside it.
          Both children render null when they have nothing to say, so the resting
          column is unchanged.

          The notice rows are in FLOW, and at the resting state (chat closed)
          that costs nothing measurable — the capsule's bottom is pinned by the
          column and the braindump's flex-1 absorbs the row, at every viewport
          height down to 360px.

          The undo row is NOT in flow, and that difference is measured rather
          than reasoned. It appears and vanishes on a 5s timer the instant after
          the user acts, so it is the one row whose arrival lands under a moving
          cursor; and with chat expanded in a short window the column has no
          slack left to absorb it. `absolute bottom-full` takes it out of the
          squeeze budget entirely, at the cost of needing an opaque ground since
          it now overlays the braindump's last row. */}
      <DockNotices />
      <UndoStrip className="absolute inset-x-0 bottom-full z-20 mb-1.5 bg-surface-0" />

      <div
        data-tour="right-sidebar"
        // The focus handoff target when a notice dismisses itself out from under
        // the keyboard: the capsule outlives every row in it and closes over the
        // gap the row leaves. See useDismissWithFocus in components/ai/morning-check.tsx.
        data-dock-surface
        // No overflow-hidden here: the omnibar's suggestion panel grows upward
        // out of the dock, so clipping the capsule would cut it off. The relay
        // clips itself instead (its own rounded overflow-hidden, below).
        className={cn(
          'relative flex min-h-0 flex-col rounded-[10px] bg-surface-3 px-[10px] pt-[18px] pb-[14px] shadow-[var(--shadow-elev-bar)]',
          chatExpanded && 'flex-1'
        )}
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
        {chatExpanded && (
          <div className="relative z-10 mb-4 flex min-h-0 flex-1 flex-col">
            <ChatPanel focusSignal={1} />
          </div>
        )}
        <div className="relative z-10">
          <UserCard />
        </div>
        <div className="relative z-10 mt-5">
          <Omnibar variant="dock" onFocusChange={setFocused} onPulse={pulse} />
        </div>
      </div>
    </div>
  );
}
