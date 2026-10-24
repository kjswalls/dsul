'use client';

import { Fragment, useEffect, useMemo } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { usePlannerStore } from '@/lib/planner-store';
import { usePlannerLoaded } from '@/lib/planner-ready';
import { needsYou, type AgentItem } from '@/lib/ask-home';
import { askers, badgeLine, type Asker } from '@/lib/needs-you';
import { useNeedsYouStore } from '@/lib/needs-you-store';
import { AskerAvatar, AskerCard } from './asker-card';
import { PrepAskerAvatar, PrepAskerCard, usePrepQuestions } from './prep-asker-card';

/** Avatars before the stack stops growing. */
const MAX_AVATARS = 3;

/** What an agent is waiting on the user for, once the planner's data is fresh. */
function useWaiting(): AgentItem[] {
  const items = usePlannerStore((s) => s.items);
  const loaded = usePlannerLoaded();
  return useMemo(() => (loaded ? needsYou(items) : []), [loaded, items]);
}

/** Your AI's prep questions, once the planner's data is fresh (prep-asker-card.tsx). */
function usePrepWaiting() {
  const loaded = usePlannerLoaded();
  const prep = usePrepQuestions();
  return loaded ? prep : [];
}

/**
 * Everything waiting on the user: the agents' questions by asker, your AI's
 * prep questions, and how many are still open (an answer held for Undo is
 * not). The Ask key's count, the phone's Ask tab and the header pill all read
 * this one number.
 */
export function useNeedsYouCount(): { open: number; groups: Asker[]; prep: number } {
  const waiting = useWaiting();
  const prep = usePrepWaiting().length;
  const pending = useNeedsYouStore((s) => s.pending);
  const groups = useMemo(() => askers(waiting), [waiting]);
  const open = waiting.filter((i) => !pending[i.id]).length + prep;
  return { open, groups, prep };
}

/**
 * Whether the header pill is in the header row: the row's far end moves to
 * it. Only without Ask (`canChat`), whose key carries the count instead.
 */
export function useNeedsYouShown(): boolean {
  const { canChat } = useAICapabilities();
  const { groups, prep } = useNeedsYouCount();
  return !canChat && (groups.length > 0 || prep > 0);
}

/**
 * The inbox: one options card per asker, your AI first, each bare and parted
 * by a hairline, since whatever holds it (a popover) is the one frame
 * (Kirby, 2026-10-24: no card inside a card). Closes itself once the last
 * answer has gone, or the next question would spring it open unasked.
 */
export function NeedsYouInbox() {
  const { groups, prep } = useNeedsYouCount();
  const inbox = useNeedsYouStore((s) => s.inbox);
  const closeInbox = useNeedsYouStore((s) => s.closeInbox);
  const none = groups.length === 0 && prep === 0;
  useEffect(() => {
    if (none && inbox.open) closeInbox();
  }, [none, inbox.open, closeInbox]);

  return (
    <>
      {prep > 0 && <PrepAskerCard frame="bare" />}
      {groups.map((g, i) => (
        <Fragment key={`${g.assignee}:${inbox.focus ?? ''}`}>
          {(prep > 0 || i > 0) && <div aria-hidden className="h-px shrink-0 bg-border" />}
          <AskerCard
            // Keyed on the focus too: a block opening the inbox on its own item
            // turns an open card to that page.
            asker={g}
            frame="bare"
            focusItemId={g.items.some((it) => it.id === inbox.focus) ? inbox.focus : null}
          />
        </Fragment>
      ))}
    </>
  );
}

/** The inbox's popover surface, shared by the Ask key's count and the header pill. */
export const INBOX_SURFACE =
  'flex max-h-[min(70vh,640px)] w-[380px] flex-col overflow-y-auto rounded-xl p-0 shadow-[var(--shadow-elev-lg)]';

/**
 * Needs you, in the canvas's header row (memory/plans/power-mode.md, build
 * order 4): the askers' avatars and "3 to answer", opening the inbox.
 *
 * Only without Ask (Kirby's pick, 2026-10-24). With Ask, the count is a
 * bubble on the Ask key (components/ai/rail/ask-opener.tsx) that opens the
 * same inbox, and Ask home's Needs you lists every question. This pill is
 * left for an account whose agent asks while no model answers, which has no
 * Ask key to wear the count.
 *
 * Quiet until used: nothing renders while nothing waits on the user, and it
 * waits for fresh data (lib/planner-ready.ts) for the reason Ask home's own
 * Needs you does: answering is a write, and the look-only preview would
 * offer a question already answered elsewhere.
 *
 * A grid block's short card opens the same inbox on its own item
 * (`openNeedsYou(itemId)`, lib/needs-you-door.ts), so the popover's open
 * state lives in lib/needs-you-store.ts rather than here.
 */
export function NeedsYouBadge({ className }: { className?: string }) {
  const shown = useNeedsYouShown();
  const { open, groups, prep } = useNeedsYouCount();
  const inbox = useNeedsYouStore((s) => s.inbox);
  const openInbox = useNeedsYouStore((s) => s.openInbox);
  const closeInbox = useNeedsYouStore((s) => s.closeInbox);
  const hostInbox = useNeedsYouStore((s) => s.hostInbox);
  useEffect(() => (shown ? hostInbox() : undefined), [shown, hostInbox]);

  if (!shown) return null;
  const label = `Needs you: ${badgeLine(open)}`;

  return (
    <Popover open={inbox.open} onOpenChange={(next) => (next ? openInbox() : closeInbox())}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="needs-you-badge"
          aria-label={label}
          className={cn(
            'titlebar-hole mt-2 inline-flex h-8 shrink-0 items-center gap-2 rounded-full border border-border bg-card pr-3 pl-1.5 text-xs transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            className
          )}
        >
          <span className="flex -space-x-1.5" aria-hidden>
            {prep > 0 && <PrepAskerAvatar />}
            {groups.slice(0, MAX_AVATARS - (prep > 0 ? 1 : 0)).map((g) => (
              <AskerAvatar key={g.assignee} asker={g} />
            ))}
          </span>
          <span className={cn('tabular-nums', open > 0 ? 'text-warning-text' : 'text-muted-foreground')}>
            {badgeLine(open)}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        data-testid="needs-you-inbox"
        aria-label="Needs you"
        className={INBOX_SURFACE}
      >
        <NeedsYouInbox />
      </PopoverContent>
    </Popover>
  );
}
