'use client';

import { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { answerAgentQuestion } from '@/lib/agent-question';
import { useAgentQuestion } from '@/hooks/use-agent-question';
import { assigneeLabel } from '@/lib/chat-utils';
import { openEditFor } from '@/lib/ui-store';
import type { AgentItem } from '@/lib/ask-home';
import type { Task } from '@/lib/planner-types';

/** Cards before "Show N more": enough to see the shape of what is waiting. */
export const NEEDS_YOU_SHOWN = 3;

/**
 * Ask home's "Needs you": every item an agent is waiting on the user for
 * (lib/ask-home.ts `needsYou`, longest-waiting first), as cards to answer in
 * place. Three show, then "Show 2 more" opens the rest where they are.
 *
 * Answering is the same act as the item's own AgentReply, through the same two
 * pieces (lib/agent-question.ts, hooks/use-agent-question.ts): the reply goes
 * on the item's trail and the item flips back to `queued`, which takes it out
 * of here and puts it under "With AI activity", spinning.
 */
export function NeedsYou({ items }: { items: readonly AgentItem[] }) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const shown = expanded ? items : items.slice(0, NEEDS_YOU_SHOWN);
  const rest = items.length - shown.length;

  return (
    <section aria-label="Needs you" data-testid="needs-you" className="flex flex-col gap-2">
      {shown.map((item) => (
        <NeedsYouCard key={item.id} item={item} />
      ))}
      {rest > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          data-testid="needs-you-more"
          className="self-start rounded-sm px-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Show {rest} more
        </button>
      )}
    </section>
  );
}

/**
 * One question, as the approved mock draws it:
 *
 *   ◐ OpenClaw needs you
 *   Book the dentist: Tue 3pm or Thu 10am?
 *   [Tue 3pm] [Thu 10am] [Other…]
 *
 * The title opens the item (on the desktop it pushes over Ask, and closing it
 * hands focus back here: `data-ask-focus`). "Other…" opens a field for an
 * answer in the user's own words and moves the caret into it; with no options
 * to tap, the field is simply there, as the item's own reply box is. Enter
 * sends; Escape with text clears it and is consumed, so the rail's own Escape
 * does not also go back or park and lose the answer.
 */
function NeedsYouCard({ item }: { item: AgentItem }) {
  const { options, clear } = useAgentQuestion(item);
  const [other, setOther] = useState(false);
  const [text, setText] = useState('');
  const fieldRef = useRef<HTMLInputElement>(null);
  const question = item.aiResult?.trim();
  const showField = other || options.length === 0;

  // Only a tap on "Other…" moves the caret: a field that is simply there
  // (no options) never takes focus because it mounted.
  useEffect(() => {
    if (other) fieldRef.current?.focus({ preventScroll: true });
  }, [other]);

  const answer = (value: string) => {
    if (!answerAgentQuestion(item, value)) return;
    setText('');
    clear();
  };

  return (
    <div
      data-testid="needs-you-card"
      data-item-id={item.id}
      className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-2 px-3 py-2.5"
    >
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span aria-hidden className="text-ai">
          ◐
        </span>
        {assigneeLabel(item.assignee)} needs you
      </p>
      <p className="text-sm leading-snug text-foreground">
        <button
          type="button"
          data-ask-focus={`needs:${item.id}`}
          data-testid="needs-you-title"
          onClick={() => openEditFor(item as unknown as Task, 'task')}
          className="rounded-sm text-left font-medium underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {item.title}
        </button>
        {question && <span>: {question}</span>}
      </p>

      {options.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              data-testid="needs-you-option"
              onClick={() => answer(option)}
              className="rounded-full border border-border bg-background px-2.5 py-1 text-xs text-foreground transition-colors hover:border-ai/40 hover:bg-muted"
            >
              {option}
            </button>
          ))}
          {!other && (
            <button
              type="button"
              data-testid="needs-you-other"
              onClick={() => setOther(true)}
              className="rounded-full border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-ai/40 hover:text-foreground"
            >
              Other…
            </button>
          )}
        </div>
      )}

      {showField && (
        <Input
          ref={fieldRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              answer(text);
            } else if (e.key === 'Escape' && text) {
              e.preventDefault();
              setText('');
            }
          }}
          placeholder="Answer…"
          aria-label={`Answer ${assigneeLabel(item.assignee)} about ${item.title}`}
          data-testid="needs-you-answer"
          className="h-8 text-xs md:text-xs"
        />
      )}
    </div>
  );
}
