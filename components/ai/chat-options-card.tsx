'use client';

import { useId, useMemo, useState } from 'react';
import { ArrowUp, ChevronDown, ChevronUp, SkipForward } from 'lucide-react';
import { cn } from '@/lib/utils';
import { sendFrom } from '@/lib/open-chat';
import type { ComposerBinding } from '@/lib/rail-store';
import { composeAnswers, type OptionQuestion, type QuestionState } from '@/lib/chat-options';

/**
 * A reply's question with choices, drawn as buttons (lib/chat-options.ts, the
 * ClawBoy convention). One question answers with one tap, or with typed
 * words; several page through ("1 of 3"), each tap moving on, and go back as
 * ONE message with Send, any of them skippable.
 *
 * Live only under the latest reply while chat can send (`via`); once the next
 * message is in, each question shows what it got: the picked choice filled,
 * typed words quoted, or "Skipped". The user can always ignore the card and
 * write in the box instead.
 */
export function ChatOptionsCard({
  questions,
  states,
  via,
}: {
  questions: readonly OptionQuestion[];
  states: Record<string, QuestionState>;
  /** Where the answer goes; absent when the card cannot be answered. */
  via?: ComposerBinding;
}) {
  const answered = questions.some((q) => states[q.id]?.answered);
  const live = !!via && !answered;
  const [at, setAt] = useState(0);
  const [picked, setPicked] = useState<Record<string, string | null>>({});
  const [typed, setTyped] = useState('');
  const [sending, setSending] = useState(false);
  const multi = questions.length > 1;
  const q = questions[Math.min(at, questions.length - 1)];
  const inputId = useId();

  const send = async (answers: Record<string, string | null>) => {
    if (!via || sending) return;
    setSending(true);
    try {
      await sendFrom(via, composeAnswers(questions, answers));
    } finally {
      setSending(false);
    }
  };

  const next = (from: number) => {
    for (let i = 1; i <= questions.length; i++) {
      const j = (from + i) % questions.length;
      if (!(questions[j].id in picked) || picked[questions[j].id] === null) return j;
    }
    return from;
  };

  const choose = (value: string) => {
    if (!live) return;
    if (!multi) return void send({ [q.id]: value });
    const nextPicked = { ...picked, [q.id]: picked[q.id] === value ? null : value };
    setPicked(nextPicked);
    if (nextPicked[q.id] !== null && at < questions.length - 1) setAt(at + 1);
  };

  const submitTyped = () => {
    const words = typed.trim();
    if (!live || !words) return;
    setTyped('');
    if (!multi) return void send({ [q.id]: words });
    setPicked({ ...picked, [q.id]: words });
    if (at < questions.length - 1) setAt(at + 1);
  };

  const state = states[q.id];
  const chosen = live ? (picked[q.id] ?? undefined) : state?.answered ? state.value : undefined;
  const typedAnswer = live
    ? picked[q.id] && !q.choices.some((c) => c.value === picked[q.id])
      ? (picked[q.id] as string)
      : undefined
    : state?.answered
      ? state.freeText
      : undefined;
  const skipped = !live && state?.answered && !state.value && !state.freeText;
  const anyPicked = useMemo(() => Object.values(picked).some((v) => v !== null && v !== undefined), [picked]);

  return (
    <div
      data-testid="chat-options"
      data-live={live ? 'true' : 'false'}
      className="flex flex-col gap-2 rounded-xl border border-border bg-card px-3 py-2.5"
    >
      {multi && (
        <div className="flex items-center justify-between">
          <span className="text-2xs tabular-nums text-muted-foreground" data-testid="chat-options-page">
            {at + 1} of {questions.length}
          </span>
          <span className="flex items-center">
            <button
              type="button"
              aria-label="Previous question"
              disabled={at === 0}
              onClick={() => setAt(at - 1)}
              className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              <ChevronUp className="size-3.5" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Next question"
              disabled={at === questions.length - 1}
              onClick={() => setAt(at + 1)}
              className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              <ChevronDown className="size-3.5" aria-hidden />
            </button>
          </span>
        </div>
      )}
      {q.prompt && <p className="text-sm font-medium text-foreground">{q.prompt}</p>}
      <ul className="flex flex-col gap-1" aria-label={q.prompt ?? 'Choices'}>
        {q.choices.map((c, i) => {
          const on = chosen === c.value;
          return (
            <li key={`${c.value}-${i}`}>
              <button
                type="button"
                data-testid="chat-option"
                aria-pressed={on}
                disabled={!live || sending}
                onClick={() => choose(c.value)}
                className={cn(
                  'flex w-full items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left text-sm transition-colors',
                  on
                    ? 'border-transparent bg-primary text-primary-foreground'
                    : live
                      ? 'border-border text-foreground hover:bg-secondary'
                      : 'border-border text-muted-foreground'
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'mt-px grid size-4.5 shrink-0 place-items-center rounded border text-2xs font-medium',
                    on ? 'border-primary-foreground/30' : 'border-border text-muted-foreground'
                  )}
                >
                  {String.fromCharCode(65 + i)}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="break-words">{c.label}</span>
                  {c.hint && <span className={cn('text-2xs', on ? '' : 'text-muted-foreground')}>{c.hint}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {typedAnswer && (
        <p data-testid="chat-option-typed" className="rounded-lg bg-secondary px-2.5 py-1.5 text-sm text-foreground">
          “{typedAnswer}”
        </p>
      )}
      {skipped && <p className="text-2xs text-muted-foreground">Skipped</p>}
      {live && q.allowFreeText && (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            submitTyped();
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            Your own answer
          </label>
          <input
            id={inputId}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={q.freeTextPlaceholder ?? 'Or type your own…'}
            data-testid="chat-option-input"
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
          />
          <button
            type="submit"
            aria-label="Use this answer"
            disabled={!typed.trim() || sending}
            className="grid size-7 place-items-center rounded-full text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            <ArrowUp className="size-3.5" aria-hidden />
          </button>
        </form>
      )}
      {live && multi && (
        <div className="flex items-center justify-between pt-0.5">
          <button
            type="button"
            data-testid="chat-options-skip"
            onClick={() => {
              setPicked({ ...picked, [q.id]: null });
              setAt(next(at));
            }}
            className="inline-flex items-center gap-1 rounded px-1 text-2xs text-muted-foreground hover:text-foreground"
          >
            <SkipForward className="size-3" aria-hidden />
            Skip
          </button>
          <span className="flex items-center gap-1" aria-hidden>
            {questions.map((x, i) => (
              <span
                key={x.id}
                className={cn(
                  'size-1.5 rounded-full',
                  picked[x.id] ? 'bg-primary' : i === at ? 'bg-muted-foreground' : 'border border-border'
                )}
              />
            ))}
          </span>
          <button
            type="button"
            data-testid="chat-options-send"
            disabled={!anyPicked || sending}
            onClick={() => void send(picked)}
            className="inline-flex h-7 items-center gap-1 rounded-full bg-primary px-3 text-xs font-medium text-primary-foreground disabled:bg-secondary disabled:text-muted-foreground"
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}
