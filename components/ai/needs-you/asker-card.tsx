'use client';

import { useId, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';
import { OWN_WORDS_ROW, optionKeyClass, optionRowClass } from '@/components/ai/option-rows';
import { useAgentQuestion } from '@/hooks/use-agent-question';
import { openItemFromAsk } from '@/lib/open-chat';
import { askerInitial, choiceLetter, type Asker } from '@/lib/needs-you';
import { useNeedsYouStore } from '@/lib/needs-you-store';
import type { AgentItem } from '@/lib/ask-home';

/**
 * One asker's questions, as an options card in the ClawBoy convention chat
 * already draws (components/ai/chat-options-card.tsx): who asked and about
 * which item, the question, lettered choices, a pencil row for the user's own
 * words, Clear and Submit. An asker with several open questions pages through
 * them ("1 of 2"). A submitted answer folds to one line with Undo, and goes
 * to the agent when the undo window closes (lib/needs-you-store.ts).
 *
 * Keys, while focus is in the card and not in the field: A to H pick a
 * choice, ← → page, Enter submits.
 */
/**
 * How a card is framed: 'card' is its own bordered surface (Ask home's Needs
 * you, which sits on a panel); 'bare' leaves the frame to whatever holds it
 * (the Ask key's peek, where the popover is the card), so there is never a
 * card inside a card.
 */
export type QuestionFrame = 'card' | 'bare';
export const QUESTION_FRAME: Record<QuestionFrame, string> = {
  card: 'rounded-xl border border-border bg-card px-3 py-2.5',
  bare: 'px-5 py-4',
};

export function AskerCard({
  asker,
  focusItemId,
  frame = 'card',
}: {
  asker: Asker;
  focusItemId?: string | null;
  frame?: QuestionFrame;
}) {
  const pending = useNeedsYouStore((s) => s.pending);
  const undo = useNeedsYouStore((s) => s.undo);
  const open = asker.items.filter((i) => !pending[i.id]);
  const held = asker.items.filter((i) => pending[i.id]);
  const [atId, setAtId] = useState<string | null>(focusItemId ?? null);
  const index = Math.max(
    0,
    open.findIndex((i) => i.id === atId)
  );
  const current = open[index] ?? null;
  const page = (to: number) => setAtId(open[(to + open.length) % open.length]?.id ?? null);

  return (
    <div
      data-testid="asker-card"
      data-asker={asker.assignee}
      className={cn('flex flex-col gap-2', QUESTION_FRAME[frame])}
    >
      <div className="flex items-center gap-2">
        <AskerAvatar asker={asker} />
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{asker.label}</span>
          {current && (
            <>
              {' · about '}
              <button
                type="button"
                data-testid="asker-card-item"
                onClick={() => openItemFromAsk(current)}
                className="rounded-sm text-foreground underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {current.title}
              </button>
            </>
          )}
        </p>
        {open.length > 1 && (
          <span className="flex shrink-0 items-center gap-0.5">
            <span className="text-2xs tabular-nums text-muted-foreground" data-testid="asker-card-page">
              {index + 1} of {open.length}
            </span>
            <button
              type="button"
              aria-label="Previous question"
              onClick={() => page(index - 1)}
              className="rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="size-3.5" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Next question"
              onClick={() => page(index + 1)}
              className="rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <ChevronRight className="size-3.5" aria-hidden />
            </button>
          </span>
        )}
      </div>

      {held.map((item) => (
        <div
          key={item.id}
          data-testid="asker-card-answered"
          data-item-id={item.id}
          className="flex items-center gap-2 rounded-lg bg-secondary px-2.5 py-1.5 text-sm"
        >
          <Check className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-foreground">
            “{pending[item.id]?.text}”
            {held.length + open.length > 1 && <span className="text-muted-foreground"> · {item.title}</span>}
          </span>
          <button
            type="button"
            data-testid="asker-card-undo"
            onClick={() => {
              undo(item.id);
              setAtId(item.id);
            }}
            className="shrink-0 rounded px-1 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            Undo
          </button>
        </div>
      ))}

      {current && (
        <Question
          key={`${current.id}\u0000${current.aiResult ?? ''}`}
          item={current}
          onPage={open.length > 1 ? (d) => page(index + d) : undefined}
        />
      )}
    </div>
  );
}

/** The asker's mark: their initial in a ring, AI-toned. */
export function AskerAvatar({ asker, className }: { asker: Pick<Asker, 'label'>; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-5 shrink-0 place-items-center rounded-full bg-ai/15 text-[10px] font-semibold text-ai ring-2 ring-card',
        className
      )}
    >
      {askerInitial(asker)}
    </span>
  );
}

function Question({ item, onPage }: { item: AgentItem; onPage?: (delta: number) => void }) {
  const answer = useNeedsYouStore((s) => s.answer);
  const { options } = useAgentQuestion(item);
  const [picked, setPicked] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const fieldId = useId();
  const fieldRef = useRef<HTMLInputElement>(null);
  const question = item.aiResult?.trim();
  const value = typed.trim() || picked || '';

  const submit = () => {
    if (!value) return;
    answer(item, value);
  };
  const clear = () => {
    setPicked(null);
    setTyped('');
  };

  return (
    <div
      className="flex flex-col gap-2"
      data-testid="asker-card-question"
      data-item-id={item.id}
      onKeyDown={(e) => {
        if (e.metaKey || e.ctrlKey || e.altKey || e.nativeEvent.isComposing) return;
        const inField = e.target instanceof HTMLInputElement;
        if (e.key === 'Enter' && value && !(e.target instanceof HTMLButtonElement)) {
          e.preventDefault();
          submit();
          return;
        }
        if (inField) return;
        if (onPage && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          e.preventDefault();
          onPage(e.key === 'ArrowLeft' ? -1 : 1);
          return;
        }
        const at = e.key.length === 1 ? e.key.toUpperCase().charCodeAt(0) - 65 : -1;
        if (at >= 0 && at < options.length) {
          e.preventDefault();
          setTyped('');
          setPicked(options[at]);
        }
      }}
    >
      {question && <p className="text-sm font-medium text-foreground">{question}</p>}
      {options.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label={question ?? 'Choices'}>
          {options.map((option, i) => {
            const on = picked === option && !typed.trim();
            return (
              <li key={`${option}-${i}`}>
                <button
                  type="button"
                  data-testid="asker-card-option"
                  aria-pressed={on}
                  onClick={() => {
                    setTyped('');
                    setPicked(on ? null : option);
                  }}
                  className={optionRowClass(on)}
                >
                  <span aria-hidden className={optionKeyClass(on)}>
                    {choiceLetter(i)}
                  </span>
                  <span className="min-w-0 break-words">{option}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className={OWN_WORDS_ROW}>
        <Pencil className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <label htmlFor={fieldId} className="sr-only">
          Your own words
        </label>
        <input
          ref={fieldRef}
          id={fieldId}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && typed) {
              // Consumed, so the popover's own Escape does not close it and lose the words.
              e.preventDefault();
              e.stopPropagation();
              setTyped('');
            }
          }}
          placeholder="Your own words…"
          data-testid="asker-card-input"
          className="h-8 min-w-0 flex-1 bg-transparent px-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          data-testid="asker-card-clear"
          disabled={!picked && !typed}
          onClick={() => {
            clear();
            fieldRef.current?.focus({ preventScroll: true });
          }}
          className="h-7 rounded-full px-3 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          Clear
        </button>
        <button
          type="button"
          data-testid="asker-card-submit"
          disabled={!value}
          onClick={submit}
          className="inline-flex h-7 items-center rounded-full bg-primary px-3 text-xs font-medium text-primary-foreground disabled:bg-secondary disabled:text-muted-foreground"
        >
          Submit
        </button>
      </div>
    </div>
  );
}
