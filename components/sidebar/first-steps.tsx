'use client';

import { useEffect, useRef, useState } from 'react';
import { Bot } from 'lucide-react';
import { Button, ButtonKey } from '@/components/ui/button';
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal';
import { useDoStuffStore } from '@/lib/do-stuff';
import { usePlannerStore } from '@/lib/planner-store';
import { useProposalStore } from '@/lib/proposal-store';
import { getAICapabilities, useAICapabilities } from '@/lib/ai-connection-store';
import { useHandOffTargets } from '@/lib/agents-store';
import { sameAssignee } from '@/lib/agent-assignees';
import { canBreakDown } from '@/lib/item-asks';
import { handOffItem } from '@/lib/agent-handoff';
import { openEditFor } from '@/lib/ui-store';
import type { Item } from '@/lib/planner-types';
import { cn } from '@/lib/utils';

/**
 * First steps (Kirby's pick S1, 2026-10-13; memory/plans/power-mode.md, round
 * 5): two screens over one item. The first asks one thing ("Anything I should
 * know first?"); the second shows the few steps "Break it down" proposes
 * (lib/proposal-store.ts, `item:<id>`, the same card the item panel asks for),
 * step 1 lit. Both offer "do it for me", which hands the whole item to the
 * agent instead, and once there are steps any one of them can be handed off
 * on its own. Saving makes them subtasks in one undo (applyProposal).
 *
 * Opened from the up-next card, the F key while doing stuff, and the item's
 * "AI ▸" menu; offered only where Break it down is (`canBreakDown`).
 */
export function FirstSteps() {
  const id = useDoStuffStore((s) => s.firstSteps);
  const item = usePlannerStore((s) => (id ? s.items.find((i) => i.id === id) : undefined));
  const close = () => useDoStuffStore.setState({ firstSteps: null });
  return (
    <ResponsiveModal open={!!item} onOpenChange={(open) => !open && close()}>
      {item && <FirstStepsCard key={item.id} item={item} close={close} />}
    </ResponsiveModal>
  );
}

/**
 * Open first steps for an item, where the AI can break it down; false (and
 * nothing opens) where it can't, so a key that asks can let the press go.
 */
export function openFirstSteps(id: string): boolean {
  const item = usePlannerStore.getState().items.find((i) => i.id === id);
  if (!item || !canBreakDown(item, getAICapabilities().canPropose)) return false;
  useDoStuffStore.setState({ firstSteps: id });
  return true;
}

function FirstStepsCard({ item, close }: { item: Item; close: () => void }) {
  const surface = `item:${item.id}`;
  const [answer, setAnswer] = useState('');
  const [asked, setAsked] = useState(false);
  const mine = useProposalStore((s) => s.lastRequest?.surface === surface);
  const status = useProposalStore((s) => s.status);
  const proposal = useProposalStore((s) => s.proposal);
  const emptyMessage = useProposalStore((s) => s.emptyMessage);
  const error = useProposalStore((s) => s.error);
  const targets = useHandOffTargets();
  const handTo = useDoStuffStore((s) => s.handTo);
  const target = targets.find((t) => sameAssignee(t.assignee, handTo)) ?? targets[0] ?? null;
  const free = !('assignee' in item && item.assignee);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  // Like ProposalCard's item-surface cleanup (components/ai/proposal-card.tsx):
  // a proposal this dialog asked for never outlives it, or the item panel's
  // card (the same `item:<id>` surface) would show it later, unasked.
  useEffect(
    () => () => {
      const store = useProposalStore.getState();
      if (store.lastRequest?.surface === surface) store.dismiss();
    },
    [surface]
  );

  const steps =
    asked && mine && status === 'ready' && proposal
      ? proposal.operations.flatMap((op) => (op.kind === 'create' ? [op.title] : []))
      : [];

  const ask = () => {
    const known = answer.trim();
    setAsked(true);
    void useProposalStore
      .getState()
      .request(
        'breakdown',
        known ? `Break this into a few concrete steps. Something to know first: ${known}` : undefined,
        item.id
      );
  };

  /** Save the steps as subtasks, in one undo; the new rows, in order. */
  const save = (): Item[] => {
    useProposalStore.getState().accept();
    const kids = usePlannerStore
      .getState()
      .items.filter((i) => 'parentItemId' in i && i.parentItemId === item.id);
    return steps.map((t) => kids.find((k) => k.title === t)).filter((k): k is Item => !!k);
  };

  const doItForMe = () => {
    if (!target) return;
    handOffItem(item, target.assignee);
    close();
  };

  const handOffStep = (index: number) => {
    if (!target) return;
    const step = save()[index];
    if (step) handOffItem(step, target.assignee);
    close();
  };

  const forMe = target && free && (
    <Button
      variant="ghost"
      size="sm"
      onClick={doItForMe}
      data-testid="first-steps-do-it-for-me"
      className="gap-1.5 text-muted-foreground"
    >
      <span aria-hidden className="size-[7px] rounded-full bg-[var(--size-fuzzy)]" />
      do it for me
      <span className="text-[11px]">{target.name}</span>
    </Button>
  );

  return (
    <ResponsiveModalContent className="sm:max-w-[440px]" data-testid="first-steps">
      <ResponsiveModalTitle className="text-base">First steps</ResponsiveModalTitle>
      <ResponsiveModalDescription className="truncate">{item.title}</ResponsiveModalDescription>

      {!asked ? (
        <div className="flex flex-col gap-3 pt-1" data-testid="first-steps-ask">
          <label htmlFor="first-steps-answer" className="text-sm font-medium">
            Anything I should know first?
          </label>
          <textarea
            id="first-steps-answer"
            ref={inputRef}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                ask();
              }
            }}
            rows={2}
            placeholder="optional: what's in the way, what you've tried"
            data-testid="first-steps-answer"
            className="min-h-[60px] resize-none rounded-[8px] border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex items-center justify-between gap-2">
            {forMe || <span />}
            <Button size="sm" onClick={ask} data-testid="first-steps-get">
              Get first steps
              <ButtonKey>↵</ButtonKey>
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 pt-1" data-testid="first-steps-steps">
          {(!mine || status === 'loading') && (
            <p className="text-sm text-muted-foreground" data-testid="first-steps-loading">
              Finding a first step…
            </p>
          )}
          {mine && status === 'empty' && (
            <p className="text-sm" data-testid="first-steps-empty">
              {emptyMessage || 'This one is small enough to just do.'}
            </p>
          )}
          {mine && status === 'error' && (
            <div className="flex items-center gap-2 text-sm" data-testid="first-steps-error">
              <span className="min-w-0 flex-1 text-muted-foreground">{error || "Couldn't get steps."}</span>
              <Button size="sm" variant="ghost" onClick={ask}>
                Try again
              </Button>
            </div>
          )}
          {steps.length > 0 && (
            <ol className="flex flex-col gap-1.5">
              {steps.map((title, i) => (
                <li
                  key={`${i}-${title}`}
                  data-testid="first-steps-step"
                  data-first={i === 0 ? 'true' : undefined}
                  className={cn(
                    'group flex items-start gap-2.5 rounded-[8px] border px-3 py-2 text-sm',
                    i === 0 ? 'border-[var(--lime-solid)] bg-surface-2 font-medium' : 'border-border text-muted-foreground'
                  )}
                >
                  <span className="font-num w-3 shrink-0 text-xs leading-5">{i + 1}</span>
                  <span className="min-w-0 flex-1 leading-5">{title}</span>
                  {target && (
                    <button
                      type="button"
                      onClick={() => handOffStep(i)}
                      data-testid="first-steps-hand-off-step"
                      aria-label={`Hand step ${i + 1} to ${target.name}`}
                      className="flex shrink-0 items-center gap-1 rounded-[6px] px-1.5 text-[11.5px] leading-5 font-normal text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground [@media(hover:none)]:opacity-100"
                    >
                      <Bot aria-hidden className="size-3" />
                      hand off
                    </button>
                  )}
                </li>
              ))}
            </ol>
          )}
          <div className="flex items-center justify-between gap-2">
            {forMe || <span />}
            {steps.length > 0 && (
              <span className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    save();
                    close();
                  }}
                  data-testid="first-steps-save"
                >
                  save as subtasks
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    save();
                    close();
                    const task = usePlannerStore.getState().tasks.find((t) => t.id === item.id);
                    if (task) openEditFor(task, 'task');
                  }}
                  data-testid="first-steps-start"
                >
                  Start step 1
                </Button>
              </span>
            )}
          </div>
        </div>
      )}
    </ResponsiveModalContent>
  );
}

/** May first steps be offered on this item? The same rule as Break it down. */
export function useCanFirstSteps(id: string | undefined): boolean {
  const { canPropose } = useAICapabilities();
  const item = usePlannerStore((s) => (id ? s.items.find((i) => i.id === id) : undefined));
  return !!item && canBreakDown(item, canPropose);
}
