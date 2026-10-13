'use client';

import { useEffect, useMemo } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { usePlannerStore } from '@/lib/planner-store';
import { usePlannerLoaded } from '@/lib/planner-ready';
import { needsYou } from '@/lib/ask-home';
import { askers, badgeLine } from '@/lib/needs-you';
import { useNeedsYouStore } from '@/lib/needs-you-store';
import { AskerAvatar, AskerCard } from './asker-card';

/** Avatars before the stack stops growing. */
const MAX_AVATARS = 3;

/** What an agent is waiting on the user for, once the planner's data is fresh. */
function useWaiting() {
  const items = usePlannerStore((s) => s.items);
  const loaded = usePlannerLoaded();
  return useMemo(() => (loaded ? needsYou(items) : []), [loaded, items]);
}

/** Whether the badge is in the header row: the row's far end moves to it. */
export function useNeedsYouShown(): boolean {
  return useWaiting().length > 0;
}

/**
 * Needs you, in the canvas's header row (memory/plans/power-mode.md, build
 * order 4): the askers' avatars and "3 to answer", opening an inbox of one
 * options card per asker (asker-card.tsx).
 *
 * Quiet until used: nothing renders while no agent is waiting on the user,
 * and it waits for fresh data (lib/planner-ready.ts) for the reason Ask home's
 * own Needs you does: answering is a write, and the look-only preview would
 * offer a question already answered elsewhere.
 *
 * A grid block's short card opens the same inbox on its own item
 * (`openInbox(itemId)`), so the popover's open state lives in
 * lib/needs-you-store.ts rather than here.
 */
export function NeedsYouBadge({ className }: { className?: string }) {
  const waiting = useWaiting();
  const groups = useMemo(() => askers(waiting), [waiting]);
  const pending = useNeedsYouStore((s) => s.pending);
  const inbox = useNeedsYouStore((s) => s.inbox);
  const openInbox = useNeedsYouStore((s) => s.openInbox);
  const closeInbox = useNeedsYouStore((s) => s.closeInbox);

  // The last answer went out with the inbox open: close it, or the next
  // question would spring it open unasked.
  const none = groups.length === 0;
  useEffect(() => {
    if (none && inbox.open) closeInbox();
  }, [none, inbox.open, closeInbox]);

  if (none) return null;
  const open = waiting.filter((i) => !pending[i.id]).length;
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
            {groups.slice(0, MAX_AVATARS).map((g) => (
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
        className="flex max-h-[min(70vh,640px)] w-[380px] flex-col gap-2 overflow-y-auto rounded-xl p-2 shadow-[var(--shadow-elev-lg)]"
      >
        {groups.map((g) => (
          <AskerCard
            // Keyed on the focus too: a block opening the inbox on its own item
            // turns an open card to that page.
            key={`${g.assignee}:${inbox.focus ?? ''}`}
            asker={g}
            focusItemId={g.items.some((i) => i.id === inbox.focus) ? inbox.focus : null}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}
