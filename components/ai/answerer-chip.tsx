'use client';

import { ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AskMark } from '@/components/ai/ask-mark';
import { useAIConnectionStore } from '@/lib/ai-connection-store';
import { modelName } from '@/lib/ai-model-names';
import { useAgentAnswers, useItemAgent } from '@/lib/agent-question';
import { usePlannerStore } from '@/lib/planner-store';
import type { ChatTarget } from '@/lib/ai-types';
import { cn } from '@/lib/utils';

/**
 * Who the item's box talks to, at its right edge (Kirby, 2026-11-14: face and
 * name on the right, a frosted list under it). Drawn only on a box bound to an
 * item an agent holds: there the box talks to the agent by default
 * (lib/agent-question.ts `boxAnswersAgent`), and this is the one tap that
 * points it at the user's own answerer instead, and back. The choice is per
 * item and memory only (`useAgentAnswers.setToModel`).
 *
 * Every other box keeps its model chip (components/settings/model-picker.tsx),
 * which the composer draws in this same spot.
 */
export function AnswererChip({
  itemId,
  target,
  disabled,
}: {
  itemId: string;
  /** Who answers chat on this device (the AI gate's `target`). */
  target: ChatTarget;
  disabled?: boolean;
}) {
  const agent = useItemAgent(itemId);
  const toModel = useAgentAnswers((s) => !!s.toModel[itemId]);
  const assignee = usePlannerStore((s) => (s.items.find((i) => i.id === itemId) as { assignee?: string } | undefined)?.assignee);
  const model = useAIConnectionStore((s) => s.model);
  if (!agent) return null;

  // The other answerer: the user's connected model, or OpenClaw when it answers chat.
  const other = target === 'model' ? 'model' : target === 'openclaw' ? 'openclaw' : null;
  const otherName =
    other === 'model'
      ? model?.model
        ? modelName(model.provider, model.model, model.modelLabel).name
        : 'Your model'
      : 'OpenClaw';
  const toAgent = !other || !toModel;
  const agentHint = assignee === 'openclaw' ? 'Hears it in seconds' : 'Gets it when it next runs';

  const face = toAgent ? <AgentFace name={agent} /> : <ModelFace />;
  const label = toAgent ? agent : otherName;

  if (!other) {
    return (
      <span data-testid="answerer-chip" className="text-foreground flex min-w-0 items-center gap-1.5 px-1.5 text-xs font-medium">
        {face}
        <span className="truncate">{label}</span>
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        data-testid="answerer-chip"
        aria-label={`Talking to ${label}. Change who reads this`}
        className={cn(
          'text-foreground hover:bg-muted data-[state=open]:bg-muted flex h-8 max-w-[13rem] min-w-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium transition-colors',
          'disabled:opacity-50'
        )}
      >
        {face}
        <span className="truncate">{label}</span>
        <ChevronDown className="text-muted-foreground size-3 shrink-0" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-60 rounded-xl p-1" data-testid="answerer-menu">
        <DropdownMenuRadioGroup
          value={toAgent ? 'agent' : 'other'}
          onValueChange={(v) => useAgentAnswers.getState().setToModel(itemId, v === 'other')}
        >
          <DropdownMenuRadioItem value="agent" className="items-start gap-2 py-2" data-testid="answerer-agent">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium">{agent}</span>
              <span className="text-muted-foreground text-[11px]">Has this item · {agentHint}</span>
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="other" className="items-start gap-2 py-2" data-testid="answerer-other">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">{other === 'model' ? 'Your model' : 'OpenClaw'}</span>
              <span className="text-muted-foreground truncate text-[11px]">
                {other === 'model' ? `${otherName} · answers now, sees what ${agent} found` : 'Answers now'}
              </span>
            </span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The agent's initial on the dark disc the timeline gives an agent. */
export function AgentFace({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'bg-foreground text-background grid shrink-0 place-items-center rounded-full font-semibold',
        size === 'sm' ? 'size-4 text-[9px]' : 'size-5 text-[10px]'
      )}
    >
      {name.trim().charAt(0).toUpperCase() || 'A'}
    </span>
  );
}

/** The user's own answerer: the Ask mark on a quiet disc. */
function ModelFace() {
  return (
    <span aria-hidden className="bg-muted border-border grid size-5 shrink-0 place-items-center rounded-full border">
      <AskMark className="size-3" />
    </span>
  );
}
