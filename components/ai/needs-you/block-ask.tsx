'use client';

import type { PointerEvent, SyntheticEvent } from 'react';
import { cn } from '@/lib/utils';
import { assigneeLabel } from '@/lib/chat-utils';
import { useAgentQuestion } from '@/hooks/use-agent-question';
import { useIsMobile } from '@/hooks/use-mobile';
import { usePlannerLoaded } from '@/lib/planner-ready';
import { openItemFromAsk } from '@/lib/open-chat';
import { choiceLetter } from '@/lib/needs-you';
import { useNeedsYouStore } from '@/lib/needs-you-store';
import { openNeedsYou } from '@/lib/needs-you-door';
import type { AgentItem } from '@/lib/ask-home';

/** Choices a block draws at most; the inbox has the rest. */
const BLOCK_CHOICES = 3;

/** Whether an item carries an agent's open question. */
export function hasOpenQuestion(item: { assignee?: string; aiStatus?: string }): boolean {
  return !!item.assignee && item.aiStatus === 'blocked';
}

/**
 * The short Needs-you card in an item's block on the grid
 * (memory/plans/power-mode.md, build order 4): "◐ OpenClaw: Tue or Thu?",
 * and, where the block is tall enough, its first lettered choices. A choice
 * answers at once, held for Undo like the inbox's (lib/needs-you-store.ts);
 * the question opens the inbox on this item (or Ask, when nothing drawn
 * holds the inbox: lib/needs-you-door.ts), or the item itself on the phone.
 *
 * The block is a drag handle and a click target of its own, so every control
 * here stops the press from reaching it.
 */
export function BlockAsk({ item, choices }: { item: AgentItem; choices: boolean }) {
  const loaded = usePlannerLoaded();
  const isMobile = useIsMobile();
  const held = useNeedsYouStore((s) => s.pending[item.id]);
  const answer = useNeedsYouStore((s) => s.answer);
  const undo = useNeedsYouStore((s) => s.undo);
  const { options } = useAgentQuestion(item);
  // Answering is a write: not over the look-only preview (ask-home.tsx has why).
  if (!loaded) return null;
  const who = assigneeLabel(item.assignee);
  const question = item.aiResult?.trim();

  return (
    <div data-testid="block-ask" data-item-id={item.id} className="flex min-w-0 flex-col gap-1 pt-0.5">
      {held ? (
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="min-w-0 truncate">Answered “{held.text}”</span>
          <button
            type="button"
            data-testid="block-ask-undo"
            onPointerDown={stopDrag}
            onKeyDown={stopOpen}
            onClick={(e) => {
              stopOpen(e);
              undo(item.id);
            }}
            className="pointer-events-auto shrink-0 rounded px-1 font-medium hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            Undo
          </button>
        </span>
      ) : (
        <>
          <button
            type="button"
            data-testid="block-ask-question"
            onPointerDown={stopDrag}
            onKeyDown={stopOpen}
            onClick={(e) => {
              stopOpen(e);
              if (isMobile) openItemFromAsk(item);
              else openNeedsYou(item.id);
            }}
            className="pointer-events-auto flex min-w-0 items-center gap-1 self-start rounded-sm text-left text-[11px] text-warning-text hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <span aria-hidden>◐</span>
            <span className="min-w-0 truncate">
              {who}
              {question ? `: ${question}` : ' needs you'}
            </span>
          </button>
          {choices && options.length > 0 && (
            <span className="flex min-w-0 flex-wrap gap-1">
              {options.slice(0, BLOCK_CHOICES).map((option, i) => (
                <button
                  key={`${option}-${i}`}
                  type="button"
                  data-testid="block-ask-option"
                  onPointerDown={stopDrag}
            onKeyDown={stopOpen}
                  onClick={(e) => {
                    stopOpen(e);
                    answer(item, option);
                  }}
                  className={cn(
                    'pointer-events-auto inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-background/70 px-1.5 py-px text-[11px] text-foreground transition-colors hover:bg-secondary'
                  )}
                >
                  <span aria-hidden className="text-2xs text-muted-foreground">
                    {choiceLetter(i)}
                  </span>
                  <span className="min-w-0 truncate">{option}</span>
                </button>
              ))}
            </span>
          )}
        </>
      )}
    </div>
  );
}

const stopDrag = (e: PointerEvent) => e.stopPropagation();
const stopOpen = (e: SyntheticEvent) => e.stopPropagation();
