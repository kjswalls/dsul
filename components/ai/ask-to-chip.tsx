'use client';

import { useEffect } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AskMark } from '@/components/ai/ask-mark';
import { useAIConnectionStore } from '@/lib/ai-connection-store';
import { modelName } from '@/lib/ai-model-names';
import { useAgentsStore } from '@/lib/agents-store';
import { askToFor, useAskToStore } from '@/lib/ask-to-store';
import { useConversationsStore } from '@/lib/conversations-store';
import type { ChatTarget } from '@/lib/ai-types';
import { cn } from '@/lib/utils';

/** The menu's value for the user's own answerer (an agent's is its name). */
const OWN = '\u0000own';

/**
 * Who Ask's box writes to, at its right edge (memory/plans/agent-chat.md, step
 * 2; Kirby's round 3 pick: face and name on the right, a compact frosted list
 * with each answerer's speed). Your model or OpenClaw answers now; a connected
 * app (Claude, Cursor) gets the message in its inbox and answers when it next
 * runs, in about a minute when it has a wake.
 *
 * Drawn only once there is an app to write to; until then the box keeps its
 * model chip. `threadId` null is Ask home (and the dock's and Ctrl+K's `?`,
 * which start there): the pick carries onto the conversation the first
 * message starts. Memory only.
 */
export function AskToChip({
  threadId,
  target,
  disabled,
}: {
  threadId: string | null;
  target: ChatTarget;
  disabled?: boolean;
}) {
  const agents = useAgentsStore((s) => s.agents);
  const loaded = useAgentsStore((s) => s.loaded);
  useEffect(() => {
    if (!loaded) void useAgentsStore.getState().load();
  }, [loaded]);
  const model = useAIConnectionStore((s) => s.model);
  // Subscribed to what askToFor reads, so the chip follows a pick, a send and an answer.
  useAskToStore((s) => (threadId === null ? s.home : s.byThread[threadId]));
  useAskToStore((s) => s.waiting);
  const messages = useConversationsStore((s) => (threadId ? s.threads[threadId]?.messages : undefined));
  const to = askToFor(threadId, messages ?? []);
  if (agents.length === 0) return null;

  const ownName =
    target === 'openclaw'
      ? 'OpenClaw'
      : model?.model
        ? modelName(model.provider, model.model, model.modelLabel).name
        : 'Your model';
  const ownRow = target === 'openclaw' ? 'OpenClaw' : 'Your model';
  const current = to ? agents.find((a) => a.assignee.toLowerCase() === to.toLowerCase()) : undefined;
  const label = to ? (current?.name ?? to) : ownName;

  const pick = (value: string) => {
    const agent = value === OWN ? null : value;
    const ask = useAskToStore.getState();
    if (threadId === null) ask.setHome(agent);
    else ask.setFor(threadId, agent);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        data-testid="ask-to-chip"
        aria-label={`Talking to ${label}. Change who reads this`}
        className={cn(
          'text-foreground hover:bg-muted data-[state=open]:bg-muted flex h-8 max-w-[13rem] min-w-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium transition-colors',
          'disabled:opacity-50'
        )}
      >
        {to ? <AgentFace name={label} /> : <OwnFace />}
        <span className="truncate">{label}</span>
        <ChevronDown className="text-muted-foreground size-3 shrink-0" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-60 rounded-xl p-1" data-testid="ask-to-menu">
        <DropdownMenuRadioGroup value={to ?? OWN} onValueChange={pick}>
          <DropdownMenuRadioItem value={OWN} className="gap-2 py-1.5" data-testid="ask-to-own">
            <span className="min-w-0 flex-1 truncate">{ownRow}</span>
            <span className="text-muted-foreground ml-auto text-[11px]">now</span>
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {agents.map((a) => (
            <DropdownMenuRadioItem
              key={a.assignee}
              value={a.assignee}
              className="gap-2 py-1.5"
              data-testid="ask-to-agent"
              data-agent={a.assignee}
            >
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
              <span className="text-muted-foreground ml-auto text-[11px]">{a.wake ? '~1 min' : 'when opened'}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The agent's initial on the dark disc the timeline gives an agent. */
function AgentFace({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="bg-foreground text-background grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold"
    >
      {name.trim().charAt(0).toUpperCase() || 'A'}
    </span>
  );
}

/** The user's own answerer: the Ask mark on a quiet disc. */
function OwnFace() {
  return (
    <span aria-hidden className="bg-muted border-border grid size-5 shrink-0 place-items-center rounded-full border">
      <AskMark className="size-3" />
    </span>
  );
}
