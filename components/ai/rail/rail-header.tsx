'use client';

import { useMemo } from 'react';
import { ChevronLeft, Sparkles, X } from 'lucide-react';
import { RelayField } from '@/components/primitives/relay-field';
import { usePlannerStore } from '@/lib/planner-store';
import { resolveConversationId, useConversationsStore, type ConversationsState } from '@/lib/conversations-store';
import { deriveTitle } from '@/lib/conversation-types';
import { backLabel, type AskView } from '@/lib/rail-store';
import { useShortcutKeys } from '@/lib/keyboard-shortcuts-store';
import { chordLabel, isApplePlatform } from '@/lib/commands/keys';
import { useLayoutDef } from '@/lib/look-store';
import { canvasHeaderPad, railHeaderRowOffset } from '@/lib/layout-themes';
import { RELAY } from '@/lib/relay-config';
import { cn } from '@/lib/utils';

/**
 * A conversation's name as this browser knows it: its saved title, else the
 * title it will be saved with (a chip's label), else what its first message
 * would make of it. Null for one with nothing said yet, which reads as a new
 * chat wherever it is named.
 */
function conversationTitleIn(s: ConversationsState, id: string): string | null {
  const rid = resolveConversationId(id);
  const saved = s.summaries[rid]?.title;
  if (saved) return saved;
  const thread = s.threads[rid];
  if (!thread) return null;
  if (thread.draftTitle) return thread.draftTitle;
  const first = thread.messages.find((m) => m.role === 'user')?.content;
  return first ? deriveTitle(first) : null;
}

/** A conversation's live title (a rename shows at once), or null. */
export function useConversationTitle(id: string | null | undefined): string | null {
  return useConversationsStore((s) => (id ? conversationTitleIn(s, id) : null));
}

/**
 * The label a back control shows, from the live stores: lib/rail-store.ts
 * `backLabel` over the planner's items and the conversations' titles. Both
 * selectors return strings, so a planner write re-renders the header only
 * when the label itself changes (an item renamed or deleted).
 */
export function useBackLabel(view: AskView | null, beneath: AskView | undefined): string {
  const beneathTitle = useConversationTitle(beneath?.kind === 'conversation' ? beneath.id : null);
  return usePlannerStore((s) => backLabel(view, beneath, s.items, () => beneathTitle));
}

/**
 * The rail's header row, the same for every view, the item included:
 * "‹ <the view beneath>", the view's heading, then ✕.
 *
 *  - It sits on the date's row (`canvasHeaderPad`, shared with the canvas
 *    header, then `railHeaderRowOffset` for the header's own inset: the
 *    capsule's p-2, or none for the masthead and plain headers), so in the
 *    desktop app it lands inside the column's titlebar hole, clickable.
 *  - ✕ closes the rail (closeRail, and the item first when one is open), and
 *    its title names the CURRENT binding for that ("Close (Ctrl+J)", "⌘J" on a
 *    Mac), never a hard-coded key.
 *  - The heading is a real heading that takes focus on request (tabIndex -1),
 *    which is where focus goes when a push removes what held it.
 *  - At Ask home the ground is the relay field, waking while any conversation
 *    streams (it was the old chat panel's; layouts with the relay off hide it).
 *  - `data-sub-input`: the item panel's Enter-to-submit covers its whole
 *    aside, and this row is inside it.
 */
export function RailHeader({
  back,
  title,
  home = false,
  onClose,
  closeTestId = 'rail-close',
}: {
  back?: { label: string; onBack: () => void };
  title?: string;
  /** Ask home: the ✦, and the relay ground. */
  home?: boolean;
  onClose: () => void;
  closeTestId?: string;
}) {
  const { slots } = useLayoutDef();
  const keys = useShortcutKeys('toggle_right_sidebar');
  const isMac = useMemo(() => isApplePlatform(), []);
  const streaming = useConversationsStore((s) => Object.values(s.threads).some((t) => t.streaming));

  return (
    <div
      data-sub-input
      data-rail-header=""
      className={cn('relative isolate shrink-0 px-5 pb-2', canvasHeaderPad(slots))}
    >
      {home && RELAY.beacon && (
        <RelayField
          className="absolute inset-0 -z-10"
          focalY={0.6}
          pitch={30}
          period={3.0}
          idleIntensity={0}
          activeIntensity={0.5}
          active={streaming}
          mask="linear-gradient(to right, transparent, black 15%, black 85%, transparent)"
        />
      )}
      <div data-rail-header-row="" className={cn('flex h-8 items-center gap-2', railHeaderRowOffset(slots))}>
        {back && (
          <button
            type="button"
            onClick={back.onBack}
            data-testid="rail-back"
            aria-label={`Back to ${back.label}`}
            className="-ml-1.5 flex min-w-0 items-center gap-0.5 rounded-md py-1 pr-2 pl-0.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronLeft className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{back.label}</span>
          </button>
        )}
        {title && (
          <h2
            tabIndex={-1}
            data-ask-heading=""
            className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium text-foreground outline-none"
          >
            {home && <Sparkles className="size-4 shrink-0 text-ai" aria-hidden />}
            <span className="truncate">{title}</span>
          </h2>
        )}
        <button
          type="button"
          onClick={onClose}
          data-testid={closeTestId}
          aria-label="Close"
          title={`Close (${chordLabel(keys, isMac)})`}
          className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
