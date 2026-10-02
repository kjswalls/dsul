'use client';

import { useMemo } from 'react';
import { ProposalCard } from '@/components/ai/proposal-card';
import { BoundComposer } from '@/components/ai/bound-composer';
import { usePlannerStore } from '@/lib/planner-store';
import { buildChatOpeners } from '@/lib/ai-openers';
import { inactiveItemIdsOn } from '@/lib/active';
import { toDateStr } from '@/lib/recurrence';
import { askNew } from '@/lib/open-chat';
import type { ComposerBinding } from '@/lib/rail-store';

/** Ask home's box: a send starts a new conversation and pushes it (lib/open-chat.ts). */
const HOME: ComposerBinding = { kind: 'home' };

/**
 * Ask home, the rail's resting view: what Ask shows with nothing pushed.
 *
 * From the top: the catch-up card when one is up, then today's chips and the
 * box at the foot. The card's surface is 'chat', and this is its one home
 * whenever it is on screen; the docks' catch-up hosts yield to it
 * (lib/open-chat.ts useChatCardHomeShown), so it never renders twice.
 *
 * The greeting, the load line, Needs you and the AI activity are still to come,
 * between the card and the chips. Each will render only when it has something
 * to say, so this is already the shape a brand-new account sees.
 *
 * A chip starts a FRESH conversation titled with its label, not its long
 * prompt (`askNew`), and pushes it; the box does the same with what was typed.
 */
export function AskHome() {
  const items = usePlannerStore((s) => s.items);
  const routines = usePlannerStore((s) => s.routines);
  const seasons = usePlannerStore((s) => s.seasons);
  const userTimezone = usePlannerStore((s) => s.userTimezone);

  // Derived from the planner, not a static list (lib/ai-openers.ts has why, and
  // the copy rule every label keeps).
  const openers = useMemo(() => {
    const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const todayStr = toDateStr(new Date(), tz);
    return buildChatOpeners({
      items,
      todayStr,
      userTimezone: tz,
      inactiveIds: inactiveItemIdsOn(items, todayStr, { userTimezone: tz, routines, seasons }),
    });
  }, [items, routines, seasons, userTimezone]);

  return (
    <div data-ask-home="" className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-3">
        <ProposalCard surface="chat" />
      </div>
      <div className="flex shrink-0 flex-col gap-2 px-3 pb-3">
        {openers.length > 0 && (
          <div data-testid="chat-openers" className="flex flex-wrap gap-1.5 px-2">
            {openers.map((opener) => (
              <button
                key={opener.id}
                type="button"
                onClick={() => askNew(opener.prompt, { title: opener.label, isMobile: false })}
                className="rounded-full border border-border bg-surface-2 px-3 py-1.5 text-xs text-foreground transition-colors hover:border-ai/40 hover:bg-muted"
              >
                {opener.label}
              </button>
            ))}
          </div>
        )}
        <BoundComposer binding={HOME} />
      </div>
    </div>
  );
}
