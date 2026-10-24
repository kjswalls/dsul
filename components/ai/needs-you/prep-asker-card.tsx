'use client';

import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { AskMark } from '@/components/ai/ask-mark';
import { QuestionBody, dismissWithUndo } from '@/components/sidebar/prep-pack';
import { questionsWaiting } from '@/components/sidebar/question-round';
import { usePlannerStore } from '@/lib/planner-store';
import { usePrepPacksStore } from '@/lib/prep-packs-store';
import { packQuestions } from '@/lib/prep-packs';
import { openEditFor } from '@/lib/ui-store';
import type { Task } from '@/lib/planner-types';
import { cn } from '@/lib/utils';

/** The open items your AI has a question on, oldest first (question-round.tsx's rule). */
export function usePrepQuestions() {
  const items = usePlannerStore((s) => s.items);
  const packs = usePrepPacksStore((s) => s.packs);
  return useMemo(
    () => questionsWaiting(items as unknown as { id: string; title: string; status?: string }[], packs),
    [items, packs]
  );
}

/** Your AI's mark where an asker's initial goes (AskerAvatar's ring and size). */
export function PrepAskerAvatar({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('grid size-5 shrink-0 place-items-center rounded-full bg-secondary ring-2 ring-card', className)}
    >
      <AskMark className="size-3" />
    </span>
  );
}

/**
 * Your AI as one more asker in the Needs you inbox (Kirby's pick, 2026-10-24):
 * the questions it has before it can get things ready, on the same options
 * card as an agent's (asker-card.tsx), paged "1 of 2" with ← →. They used to
 * open from a line above the dock; the header's badge counts them now, so
 * there is one count and one inbox for everything waiting on you.
 *
 * An answer goes into the item's notes and the AI tries again
 * (prep-packs-store's `answer`), which takes the question out of here; the
 * next one takes its place. Nothing waits on these: Do stuff works the same
 * with them unanswered.
 */
export function PrepAskerCard() {
  const waiting = usePrepQuestions();
  const [atId, setAtId] = useState<string | null>(null);
  const count = waiting.length;
  if (count === 0) return null;
  const index = Math.max(
    0,
    waiting.findIndex((q) => q.itemId === atId)
  );
  const current = waiting[index];
  const page = (to: number) => setAtId(waiting[(to + count) % count]?.itemId ?? null);
  const openItem = () => {
    const item = usePlannerStore.getState().items.find((i) => i.id === current.itemId);
    if (item) openEditFor(item as Task, 'task');
  };

  return (
    <div
      data-testid="prep-asker-card"
      className="flex flex-col gap-2 rounded-xl border border-border bg-card px-3 py-2.5"
      onKeyDown={(e) => {
        if (count < 2 || e.target instanceof HTMLInputElement) return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          page(index + (e.key === 'ArrowLeft' ? -1 : 1));
        }
      }}
    >
      <div className="flex items-center gap-2">
        <PrepAskerAvatar />
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Your AI</span>
          {' · about '}
          <button
            type="button"
            data-testid="prep-asker-item"
            onClick={openItem}
            className="rounded-sm text-foreground underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {current.title}
          </button>
        </p>
        {count > 1 && (
          <span className="flex shrink-0 items-center gap-0.5">
            <span className="text-2xs tabular-nums text-muted-foreground" data-testid="prep-asker-page">
              {index + 1} of {count}
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
      <QuestionBody
        key={`${current.itemId}:${current.stored.updatedAt}`}
        itemId={current.itemId}
        questions={current.stored.pack.kind === 'question' ? packQuestions(current.stored.pack) : []}
        onSkip={count > 1 ? () => page(index + 1) : undefined}
        onDiscard={() => dismissWithUndo(current.itemId)}
      />
    </div>
  );
}
