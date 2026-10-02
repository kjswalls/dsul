'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { answerAgentQuestion } from '@/lib/agent-question';
import { useAgentQuestion } from '@/hooks/use-agent-question';
import { assigneeLabel } from '@/lib/chat-utils';
import { openItemFromAsk } from '@/lib/open-chat';
import type { AgentItem } from '@/lib/ask-home';

/** Cards before "Show N more": enough to see the shape of what is waiting. */
export const NEEDS_YOU_SHOWN = 3;

/**
 * Ask home's section headings ("NEEDS YOU · 1", "WITH AI ACTIVITY", D8's
 * sketch), in History's group-heading type so Ask's lists read as one system.
 * No inset of their own: each sits on its section's left edge.
 */
export const ASK_SECTION_HEADING = 'text-2xs font-medium tracking-wide text-muted-foreground uppercase';

/**
 * Ask home's "Needs you": every item an agent is waiting on the user for
 * (lib/ask-home.ts `needsYou`, longest-waiting first), as cards to answer in
 * place, under "NEEDS YOU · N" (D8's sketch). Three show, then "Show 2 more"
 * opens the rest where they are.
 *
 * Answering is the same act as the item's own AgentReply, through the same two
 * pieces (lib/agent-question.ts, hooks/use-agent-question.ts): the reply goes
 * on the item's trail and the item flips back to `queued`, which takes it out
 * of here and puts it under "With AI activity", spinning.
 *
 * FOCUS. Answering unmounts the card, and "Show N more" unmounts itself, each
 * taking the control that held focus. Focus moves on rather than dropping to
 * <body>: after an answer, to the item's new activity row (the honest next
 * place: it is still the same item), else the next card's title, else Ask's
 * heading; after "Show N more", to the first card it showed.
 */
export function NeedsYou({ items }: { items: readonly AgentItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const headingId = useId();
  if (items.length === 0) return null;
  const shown = expanded ? items : items.slice(0, NEEDS_YOU_SHOWN);
  const rest = items.length - shown.length;

  /** An answer just landed from a card that held focus: where focus goes once the card is gone. */
  const answered = (itemId: string) => {
    // Read now, before the re-render: the section goes when its last card does.
    const home = sectionRef.current?.closest<HTMLElement>('[data-ask-home]') ?? null;
    const view = home?.closest<HTMLElement>('[data-rail-view]') ?? home;
    setTimeout(() => {
      const row = Array.from(home?.querySelectorAll<HTMLElement>('[data-ask-focus]') ?? []).find(
        (el) => el.dataset.askFocus === `item:${itemId}`
      );
      const next =
        row ??
        home?.querySelector<HTMLElement>('[data-testid="needs-you-title"]') ??
        view?.querySelector<HTMLElement>('[data-ask-heading]');
      next?.focus({ preventScroll: true });
    }, 0);
  };

  return (
    <section ref={sectionRef} aria-labelledby={headingId} data-testid="needs-you" className="flex flex-col gap-2">
      <h3 id={headingId} className={ASK_SECTION_HEADING}>
        Needs you · {items.length}
      </h3>
      {shown.map((item) => (
        <NeedsYouCard key={item.id} item={item} onAnswered={answered} />
      ))}
      {rest > 0 && (
        <button
          type="button"
          onClick={(e) => {
            const keep = e.currentTarget === document.activeElement;
            setExpanded(true);
            if (!keep) return;
            setTimeout(() => {
              sectionRef.current
                ?.querySelectorAll<HTMLElement>('[data-testid="needs-you-title"]')
                [NEEDS_YOU_SHOWN]?.focus({ preventScroll: true });
            }, 0);
          }}
          data-testid="needs-you-more"
          className="self-start rounded-sm px-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
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
function NeedsYouCard({ item, onAnswered }: { item: AgentItem; onAnswered: (itemId: string) => void }) {
  const { options, ready, clear } = useAgentQuestion(item);
  const [other, setOther] = useState(false);
  const [text, setText] = useState('');
  const fieldRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const question = item.aiResult?.trim();
  // The field where no options came, once the trail has said so: not before,
  // or every card would paint the field and then swap it for the chips.
  const showField = other || (ready && options.length === 0);

  // Only a tap on "Other…" moves the caret: a field that is simply there
  // (no options) never takes focus because it mounted.
  useEffect(() => {
    if (other) fieldRef.current?.focus({ preventScroll: true });
  }, [other]);

  const answer = (value: string) => {
    const hadFocus = !!cardRef.current?.contains(document.activeElement);
    if (!answerAgentQuestion(item, value)) return;
    setText('');
    clear();
    if (hadFocus) onAnswered(item.id);
  };

  return (
    <div
      ref={cardRef}
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
          onClick={() => openItemFromAsk(item)}
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
