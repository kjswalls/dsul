'use client';

import { useEffect, type ReactNode } from 'react';
import { ArrowRight, CalendarClock, ChevronDown, Sprout, Split } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AgentFace } from '@/components/ai/answerer-chip';
import { useStepDraftsShowing } from '@/components/planner/drafted-steps';
import { useIsMobile } from '@/hooks/use-mobile';
import { inactiveItemIdsOn } from '@/lib/active';
import { canHandOff, handOffItem } from '@/lib/agent-handoff';
import { useAgentsStore, useHandOffTargets } from '@/lib/agents-store';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { useAwayStore } from '@/lib/away-store';
import { useToday } from '@/lib/collections';
import { useConversationsStore } from '@/lib/conversations-store';
import { milestoneItemIds } from '@/lib/goals';
import { itemAsksFor, type ItemAsk, type ItemAskContext, type ItemAskId } from '@/lib/item-asks';
import { askAboutItem, proposeForItem } from '@/lib/open-chat';
import { usePlannerStore } from '@/lib/planner-store';
import { useProposalStore } from '@/lib/proposal-store';
import type { Item } from '@/lib/planner-types';
import { ChipLabel, quietChip } from '@/components/ai/quiet-chip';

/**
 * WHAT TO SAY FIRST, over the item's pinned box: at most three chips, picked
 * for this item, then nothing once the talking has started (Kirby,
 * 2026-11-15, look A "Quiet").
 *
 * Which asks is lib/item-asks.ts, the list right-click › AI reads, so the two
 * can never disagree (minus "Ask about this…": the box under the chips is
 * that ask). The hand-off is lib/agent-handoff.ts `canHandOff`, the agent's
 * own queue filter, to whoever can take it (`useHandOffTargets`: OpenClaw
 * while paired, then each connected app), never a hardcoded OpenClaw.
 *
 * They are starters, so the row is gone once the item has a conversation,
 * while an agent holds it, and on a finished one-off (no ask is eligible).
 * Everything stays under right-click › AI.
 *
 * Quiet: ink text, no border and no colour at rest; a thin dashed underline
 * under the words when pointed at or focused (`ChipLabel`). The lit rim is the Ask key's, so none here.
 */

/** The asks a chip may carry, in order. 'ask' is the box itself. */
const CHIP_ASKS: readonly ItemAskId[] = ['breakdown', 'start', 'findTime', 'keep'];
const MAX_CHIPS = 3;

const ICON: Record<ItemAskId, ReactNode> = {
  ask: null,
  breakdown: <Split className="size-3" aria-hidden />,
  start: <ArrowRight className="size-3" aria-hidden />,
  findTime: <CalendarClock className="size-3" aria-hidden />,
  keep: <Sprout className="size-3" aria-hidden />,
};

const LABEL: Partial<Record<ItemAskId, string>> = {
  // Shorter than the menu's "Find a time for this": the chip sits on the item.
  findTime: 'Find a time',
};

export function ItemBoxAsks({ item }: { item: Item }) {
  const live = usePlannerStore((s) => s.items.find((i) => i.id === item.id)) ?? item;
  const routines = usePlannerStore((s) => s.routines);
  const seasons = usePlannerStore((s) => s.seasons);
  const goals = usePlannerStore((s) => s.goals);
  const away = useAwayStore((s) => s.periods);
  const { todayStr, tz } = useToday();
  const isMobile = useIsMobile();
  const { canChat, canPropose } = useAICapabilities();
  const hasConversation = useConversationsStore((s) => typeof s.itemIndex[item.id] === 'string');
  const requestProposal = useProposalStore((s) => s.request);
  const proposalBusy = useProposalStore(
    (s) => s.status === 'loading' && s.lastRequest?.surface === `item:${item.id}`
  );
  const drafts = useStepDraftsShowing(item.id, item.title);
  const targets = useHandOffTargets();
  const agentsLoaded = useAgentsStore((s) => s.loaded);
  useEffect(() => {
    if (!agentsLoaded) void useAgentsStore.getState().load();
  }, [agentsLoaded]);

  const held = 'assignee' in live && !!live.assignee;
  if (hasConversation || held) return null;

  const inactiveIds = inactiveItemIdsOn([live], todayStr, { userTimezone: tz, routines, seasons, away });
  const ctx: ItemAskContext = {
    todayStr,
    inactiveIds,
    milestoneIds: milestoneItemIds(goals ?? []),
    hasConversation,
    canChat,
    canPropose,
  };
  const asks = itemAsksFor(live, ctx)
    .filter((a) => CHIP_ASKS.includes(a.id))
    // Drafted steps on screen are the breakdown's answer already.
    .filter((a) => !(a.id === 'breakdown' && drafts));
  const handOff = targets.length > 0 && canHandOff(live, { canDelegate: true, todayStr, inactiveIds });
  const shown = asks.slice(0, handOff ? MAX_CHIPS - 1 : MAX_CHIPS);
  if (shown.length === 0 && !handOff) return null;

  const run = (ask: ItemAsk) => {
    switch (ask.kind) {
      case 'breakdown':
        void requestProposal('breakdown', undefined, item.id);
        return;
      case 'send':
        askAboutItem(live, { isMobile, text: ask.prompt!(live, ctx) });
        return;
      case 'propose':
        proposeForItem(ask.prompt!(live, ctx), isMobile);
        return;
      case 'compose':
        askAboutItem(live, { isMobile });
        return;
    }
  };

  return (
    <div className="-ml-2 flex flex-wrap gap-0.5" data-sub-input data-testid="item-box-asks">
      {shown.map((ask) => (
        <button
          key={ask.id}
          type="button"
          onClick={() => run(ask)}
          disabled={ask.kind === 'breakdown' && proposalBusy}
          data-testid={ask.id === 'breakdown' ? 'break-it-down' : `item-box-ask-${ask.id}`}
          className={quietChip}
        >
          {ICON[ask.id]}
          <ChipLabel>{LABEL[ask.id] ?? ask.label(live, ctx)}</ChipLabel>
        </button>
      ))}
      {handOff &&
        (targets.length === 1 ? (
          <button
            type="button"
            onClick={() => handOffItem(live, targets[0].assignee)}
            data-testid="assign-agent"
            className={quietChip}
          >
            <AgentFace name={targets[0].name} size="sm" />
            <ChipLabel>Hand off to {targets[0].name}</ChipLabel>
          </button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger data-testid="assign-agent" className={quietChip}>
              <ChipLabel>Hand off</ChipLabel>
              <ChevronDown className="size-2.5" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-40">
              {targets.map((t) => (
                <DropdownMenuItem
                  key={t.assignee}
                  data-testid={`assign-agent-${t.assignee}`}
                  onSelect={() => handOffItem(live, t.assignee)}
                  className="gap-2 text-xs"
                >
                  <AgentFace name={t.name} size="sm" />
                  {t.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ))}
    </div>
  );
}
