'use client';

import { useEffect, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { useAgentExchange } from '@/hooks/use-agent-exchange';
import { useAgentQuestion } from '@/hooks/use-agent-question';
import { answerAgentQuestion, awaitsAnswer, useAgentAnswers } from '@/lib/agent-question';
import { agentStatusView } from '@/lib/agent-status';
import { assigneeLabel } from '@/lib/chat-utils';
import { usePlannerStore } from '@/lib/planner-store';
import type { AgentExchange, ExchangeEntry } from '@/lib/agent-exchange';
import type { Item } from '@/lib/planner-types';
import { cn } from '@/lib/utils';

const clock = (at: number) =>
  at ? new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';

/** The agent's initial, on the dark disc the timeline gives an agent. */
function AgentAvatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="bg-foreground text-background grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold"
    >
      {name === 'OpenClaw' ? 'OC' : (name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

/**
 * An agent's exchange with the user about an item, drawn like the item's chat
 * (lib/agent-exchange.ts): the hand-off as a divider, the agent's questions
 * and results as its messages, the user's answers as their bubbles, and, while
 * a question is open, its tappable options under it. Kirby, 2026-10-15: the
 * question had been a truncated Activity line and a block easy to scroll past.
 *
 * `withAnswerBox`: a box of its own for the answer, where the host has none
 * (no AI connected, so no item box). Where the item's box is on screen, that
 * box answers the agent while its question is open (lib/open-chat.ts
 * `sendFrom`), and this draws none.
 *
 * Quiet until something has been said: a hand-off the agent has not answered
 * yet shows only on its chip.
 */
export function AgentExchangeFor({
  item,
  withAnswerBox = false,
  className,
}: {
  item: Item;
  withAnswerBox?: boolean;
  className?: string;
}) {
  const exchange = useAgentExchange(item as HeldItem);
  return <AgentExchangeView item={item} exchange={exchange} withAnswerBox={withAnswerBox} className={className} />;
}

type HeldItem = Item & { assignee?: string; aiStatus?: string; aiResult?: string; aiStatusAt?: string };

/** The exchange already read (useAgentExchange), for a host that also needs to know whether there is one. */
export function AgentExchangeView({
  item,
  exchange,
  withAnswerBox = false,
  className,
}: {
  item: Item;
  exchange: AgentExchange | null;
  withAnswerBox?: boolean;
  className?: string;
}) {
  const { options, clear } = useAgentQuestion(item as HeldItem);
  const [text, setText] = useState('');
  if (!exchange) return null;

  const answer = (value: string) => {
    if (!answerAgentQuestion(item, value)) return;
    setText('');
    clear();
  };
  const lastQuestion = exchange.openQuestion ? exchange.entries[exchange.entries.length - 1]?.key : null;

  return (
    <section
      data-testid="agent-exchange"
      aria-label={`${exchange.agent} on this item`}
      className={cn('flex flex-col gap-3', className)}
    >
      {exchange.entries.map((entry) => (
        <Entry
          key={entry.key}
          entry={entry}
          agent={exchange.agent}
          open={entry.key === lastQuestion}
          options={entry.key === lastQuestion ? options : []}
          onOption={answer}
        />
      ))}
      {exchange.working && <WorkingLine item={item as HeldItem} agent={exchange.agent} />}
      {withAnswerBox && exchange.openQuestion && (
        <form
          className="field flex items-center gap-1.5 border px-2 py-1"
          data-sub-input
          onSubmit={(e) => {
            e.preventDefault();
            answer(text);
          }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`Answer ${exchange.agent}…`}
            aria-label={`Answer ${exchange.agent}`}
            data-testid="agent-reply-input"
            className="placeholder:text-muted-foreground -mx-1 min-w-0 flex-1 bg-transparent px-1 text-xs outline-none"
          />
          <button
            type="submit"
            disabled={!text.trim()}
            aria-label="Send answer"
            data-testid="agent-reply-send"
            className="text-muted-foreground hover:text-foreground grid size-6 place-items-center rounded disabled:opacity-40"
          >
            <ArrowUp className="size-3.5" />
          </button>
        </form>
      )}
    </section>
  );
}

/**
 * Where the agent is, after the last thing said: its real state, read the way
 * the row's chip reads it (lib/agent-status.ts), so the light runs only while
 * the agent is actually at it. Waiting to be picked up rests; a pick-up that
 * never came, or a run gone quiet, goes unlit and says so. Kirby, 2026-10-15:
 * this line spun "Claude is on it" for a day over an answer no run ever read.
 */
function WorkingLine({ item, agent }: { item: HeldItem; agent: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const view = agentStatusView(item, now);
  if (!view) return null;
  const queued = item.aiStatus === 'queued';
  const text = view.stalled
    ? queued
      ? `${agent} hasn't picked this up`
      : `${agent} has gone quiet`
    : queued
      ? `Waiting for ${agent} to pick it up`
      : `${agent} is on it`;
  return (
    <div className="flex items-center gap-2" data-testid="agent-exchange-working">
      <AgentAvatar name={agent} />
      <span
        data-agent-chip=""
        data-agent-state={item.aiStatus}
        data-agent-stalled={view.stalled || undefined}
        title={view.detail}
      >
        <span data-agent-chip-dot="" aria-hidden />
        {text}
        {view.stalled && view.elapsed && <span className="text-muted-foreground tabular-nums">{view.elapsed}</span>}
      </span>
    </div>
  );
}

function Entry({
  entry,
  agent,
  open,
  options,
  onOption,
}: {
  entry: ExchangeEntry;
  agent: string;
  open: boolean;
  options: string[];
  onOption: (value: string) => void;
}) {
  if (entry.kind === 'handoff') {
    return (
      <div role="separator" aria-label={`Handed to ${entry.to}`} className="flex items-center gap-3 py-0.5">
        <span className="bg-border h-px flex-1" aria-hidden />
        <span className="text-muted-foreground text-2xs">
          You handed it to {entry.to}
          {entry.at ? ` · ${clock(entry.at)}` : ''}
        </span>
        <span className="bg-border h-px flex-1" aria-hidden />
      </div>
    );
  }
  if (entry.kind === 'you') {
    return (
      <div data-agent-exchange-role="you" className="flex flex-col items-end gap-1">
        <div className="bg-secondary text-foreground max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap">
          {entry.text}
        </div>
      </div>
    );
  }
  return (
    <div data-agent-exchange-role="agent" data-open={open || undefined} className="flex items-start gap-2.5">
      <AgentAvatar name={agent} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-semibold">{agent}</span>
          {open && (
            <span data-agent-chip="" data-agent-state="blocked">
              <span data-agent-chip-dot="" aria-hidden />
              Needs you
            </span>
          )}
          {entry.failed && <span className="text-muted-foreground">Couldn&apos;t finish</span>}
          <span className="text-muted-foreground text-2xs tabular-nums">{clock(entry.at)}</span>
        </div>
        <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{entry.text}</p>
        {options.length > 0 && (
          <div className="flex flex-col items-start gap-1.5" data-testid="agent-options">
            {options.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => onOption(option)}
                className="border-border bg-surface-2 text-foreground hover:bg-muted rounded-full border px-3 py-1 text-left text-xs transition-colors"
              >
                {option}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Under the item's box while an agent's question is open: who the box is
 * talking to, and the one tap that turns it the other way. The box answers the
 * agent by default (lib/agent-question.ts `boxAnswersAgent`); "Ask your model
 * instead" points it back at the user's model for this item, and back again.
 * Null when no question is open, so the host shows its usual model label.
 */
export function AgentRouteLine({ itemId, className }: { itemId: string; className?: string }) {
  const item = usePlannerStore((s) => s.items.find((i) => i.id === itemId));
  const toModel = useAgentAnswers((s) => !!s.toModel[itemId]);
  if (!awaitsAnswer(item)) return null;
  const name = assigneeLabel(item.assignee);
  const flip = () => useAgentAnswers.getState().setToModel(itemId, !toModel);
  return (
    <p data-testid="agent-route-line" className={cn('text-muted-foreground flex items-center gap-1.5 text-[11px]', className)}>
      <span className="truncate">{toModel ? 'Asking your model' : `Answering ${name}`}</span>
      <span aria-hidden>·</span>
      <button type="button" onClick={flip} className="text-foreground shrink-0 font-medium underline-offset-2 hover:underline">
        {toModel ? `Answer ${name} instead` : 'Ask your model instead'}
      </button>
    </p>
  );
}
