'use client';

import { useEffect, useId, useMemo } from 'react';
import { Loader2, Check, RotateCcw } from 'lucide-react';
import { AskMark } from '@/components/ai/ask-mark';
import { Button } from '@/components/ui/button';
import { useProposalStore, type ProposalSurface } from '@/lib/proposal-store';
import { usePlannerStore } from '@/lib/planner-store';
import { selectPlannerLoaded, selectPlannerSettled } from '@/lib/planner-ready';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { describeOperation } from '@/lib/proposal';
import { cn } from '@/lib/utils';

/**
 * The proposal card — the core interaction grammar of the whole product: the AI
 * suggests, you accept with one tap (memory/plans/ai-vision.md).
 *
 * Copy contract, same as BarCopy in morning-check.tsx and the "Still waiting"
 * heading in item-registry.ts: nothing here tells the user what they failed to
 * do. Lines say where things land, the dismiss verb is "Not now" (a deferral,
 * not a refusal), and the empty state is good news rather than an absence.
 */
/** Shared empty selection — every card starts here, so it need not be rebuilt. */
const NONE_DROPPED: ReadonlySet<number> = new Set();

export function ProposalCard({
  className,
  surface = 'chat',
}: {
  className?: string;
  /**
   * Which mount this is. One store, several places a card can appear — a
   * breakdown asked for inside an item's dialog must not answer into the
   * sidebar behind it, where the user cannot see it.
   */
  surface?: ProposalSurface;
}) {
  const proposal = useProposalStore((s) => s.proposal);
  const status = useProposalStore((s) => s.status);
  const error = useProposalStore((s) => s.error);
  const emptyMessage = useProposalStore((s) => s.emptyMessage);
  const accept = useProposalStore((s) => s.accept);
  const retry = useProposalStore((s) => s.retry);
  const dismiss = useProposalStore((s) => s.dismiss);
  // Only a model-backed ask has a different answer in it; catch-up is a pure
  // function of the planner and would return the same items.
  const modelBacked = useProposalStore(
    // An offer from chat's reply has no ask to repeat: the conversation is
    // where the user asks for something different.
    (s) => s.lastRequest != null && s.lastRequest.intent !== 'catch-up' && s.lastRequest.intent !== 'offer'
  );
  // And only while something can still answer it. The card outlives the gate:
  // a key turned down mid-ask (the propose route's 'auth', which marks the
  // model failing) or 'Who answers' switched Off leaves it on screen, carried
  // by the dock's host once chat is gone. A retry then reaches no model, and
  // the store would swap the accurate error for "Connect a model in Settings",
  // which is wrong for a model that is connected and failing.
  const { canPropose } = useAICapabilities();
  const canRetry = modelBacked && canPropose;
  const requestSurface = useProposalStore((s) => s.lastRequest?.surface);
  const refused = useProposalStore((s) => s.refused);

  const items = usePlannerStore((s) => s.items);
  const itemTypes = usePlannerStore((s) => s.itemTypes);
  /**
   * Accept writes to the planner, so it waits for the planner's load: the
   * store's accept refuses before then and keeps the card (lib/proposal-store.ts),
   * which on its own read as a button that does nothing. So the button says why
   * it is waiting. "Syncing…" only while a load is in flight (the look-only
   * preview included); after a FAILED load nothing is syncing, and the reason
   * points at the Retry instead. With no account at all there is no load to wait
   * for, and the store's own guard is the whole story.
   */
  const acceptBlocked = usePlannerStore((s): 'syncing' | 'failed' | null =>
    selectPlannerLoaded(s) ? null : selectPlannerSettled(s) ? 'failed' : s.userId ? 'syncing' : null
  );
  // Per mount: a second mount may hold the same card hidden.
  const reasonId = useId();

  /**
   * Lines the user has ticked off, by index, tagged with the proposal they
   * belong to. In the store, not here: this card remounts mid-review (a host
   * handing it to Ask home, a view coming back after an item), and a second
   * mount may hold it hidden, so every mount reads the one selection
   * (lib/proposal-store.ts `selection`).
   *
   * All-in by default: the card is an offer, and making someone opt into each
   * line one at a time would turn one tap into six. Dropping the one line that
   * is wrong is the common case, and it should not cost the whole plan.
   *
   * The id travels WITH the selection so a new card's state is derived during
   * render rather than synchronised by an effect. Indices are positional, so a
   * selection carried across cards would silently drop whichever line landed
   * where a dropped one used to be — and an effect would reset it a render
   * late, after a paint showing the previous card's ticks on the new one.
   */
  const selection = useProposalStore((s) => s.selection);
  const toggle = useProposalStore((s) => s.toggleDropped);

  const dropped = selection.proposalId === (proposal?.id ?? null) ? selection.dropped : NONE_DROPPED;

  /**
   * A card scoped to an item lives inside a panel the user can close.
   *
   * If they close it while it owns the request, the reply lands on a surface
   * nothing mounts: no card, no toast, no trace that the button did anything,
   * and only reopening that exact item would have revealed it — which nothing
   * tells them. Dropping the request is the honest read of the gesture: they
   * closed the thing they asked from. Re-asking is one click.
   *
   * A conversation's card (`conv:`) is exempt, as the catch-up card is: its
   * view unmounts for a tab switch, an item opened over it or a closed rail,
   * none of which is closing the conversation, and the plan cost a model call.
   * rail-store drops it once the conversation has left both Ask stacks, which
   * is the close (lib/rail-store.ts).
   *
   * Reads the store imperatively so the cleanup sees the state at UNMOUNT
   * rather than whatever was captured when the effect ran.
   */
  useEffect(() => {
    if (surface === 'chat' || surface.startsWith('conv:')) return;
    return () => {
      const store = useProposalStore.getState();
      if (store.lastRequest?.surface === surface) store.dismiss();
    };
  }, [surface]);

  const lines = useMemo(() => {
    if (!proposal) return [];
    const ctx = { items, customTypeNames: itemTypes.map((t) => t.name) };
    return proposal.operations.map((operation, index) => ({
      key: `${index}`,
      text: describeOperation(operation, ctx),
    }));
  }, [proposal, items, itemTypes]);

  if (status === 'idle') return null;
  // Not this mount's card. Checked after the hooks and before every visual
  // state, so a loading spinner does not appear in the wrong place either.
  if (requestSurface !== undefined && requestSurface !== surface) return null;

  const shell = cn(
    'rounded-xl border border-border bg-surface-2 p-3 shadow-soft-sm',
    className
  );

  if (status === 'loading') {
    return (
      <div className={shell} data-testid="proposal-card" role="status">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span className="flex-1">Thinking it through…</span>
          {/* Every other state has an exit; this one did not, and it is the
              state that can last longest and that greys out the AI buttons
              everywhere else. Dismissing bumps the store's generation, so the
              reply cannot land after the user has walked away from it. */}
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={dismiss}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  if (status === 'empty') {
    return (
      <div className={shell} data-testid="proposal-card" role="status">
        <div className="flex items-start gap-2">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-foreground">{emptyMessage}</p>
            {/* When EVERYTHING was refused this is the only account the user
                gets of a reply that did suggest things. */}
            {refused.count > 0 && (
              <p
                className="mt-1 text-2xs leading-relaxed text-muted-foreground"
                data-testid="proposal-refused"
              >
                {refused.reasons.join('; ')}.
              </p>
            )}
          </div>
          {/* Retry belongs here most of all: "None of those would work here"
              is precisely the state where asking again differently is the
              right move, and it was the one state that could not. */}
          {canRetry && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => retry()}
              data-testid="proposal-retry"
            >
              <RotateCcw className="h-3 w-3" />
              Try again
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={dismiss}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className={shell} data-testid="proposal-card" role="status">
        <div className="flex items-start gap-2">
          <p className="flex-1 text-sm text-muted-foreground">{error}</p>
          {/* Retry lived only in the `ready` branch, so the one state where
              trying again is the obvious move was the one that could not. */}
          {canRetry && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => retry()}
              data-testid="proposal-retry"
            >
              <RotateCcw className="h-3 w-3" />
              Try again
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={dismiss}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  if (!proposal) return null;

  const keeping = proposal.operations.filter((_, index) => !dropped.has(index));

  /**
   * The label counts what will actually happen, so the button never promises
   * more than the ticked lines. "Do all of it" survives only while all of it is
   * still on the table.
   */
  const acceptLabel =
    keeping.length === 0
      ? 'Nothing selected'
      : keeping.length === proposal.operations.length
        ? keeping.length === 1
          ? 'Do it'
          : 'Do all of it'
        : keeping.length === 1
          ? 'Do just that one'
          : `Do these ${keeping.length}`;

  return (
    <div className={shell} data-testid="proposal-card" role="status">
      <div className="flex items-start gap-2">
        <AskMark className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{proposal.summary}</p>
          {proposal.rationale && (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {proposal.rationale}
            </p>
          )}
        </div>
      </div>

      {/* Plain overflow container, not <ScrollArea> — the Radix wrapper silently
          drops max-h, and this list has to stay capped. */}
      <ul className="mt-2.5 max-h-48 space-y-0.5 overflow-y-auto pl-6">
        {lines.map((line, index) => {
          const isDropped = dropped.has(index);
          return (
            <li key={line.key}>
              <button
                type="button"
                onClick={() => toggle(index)}
                aria-pressed={!isDropped}
                data-testid="proposal-line"
                data-dropped={isDropped || undefined}
                className={cn(
                  'flex w-full gap-1.5 rounded px-1 py-0.5 text-left text-xs transition-colors hover:bg-muted/60',
                  isDropped ? 'text-muted-foreground/60 line-through' : 'text-foreground/90'
                )}
              >
                <span aria-hidden className="select-none text-muted-foreground">
                  {isDropped ? '×' : '•'}
                </span>
                <span className="min-w-0 flex-1">{line.text}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {/* What was asked for and could not be done.
      
          Validation drops individual operations rather than failing the whole
          plan — right, but it was silent: ask for five things and have three
          refused, and the card rendered two with no explanation, which reads as
          the assistant ignoring most of what you said. Phrased as the app's
          limitation, never the user's mistake. */}
      {refused.count > 0 && (
        <p className="mt-2 pl-6 text-2xs leading-relaxed text-muted-foreground" data-testid="proposal-refused">
          {refused.count === 1 ? 'One other change' : `${refused.count} other changes`} couldn&apos;t
          be made here: {refused.reasons.join('; ')}.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 pl-6">
        <Button
          size="sm"
          className="h-7 px-3 text-xs"
          disabled={keeping.length === 0 || acceptBlocked !== null}
          onClick={() => accept(keeping)}
          aria-describedby={acceptBlocked ? reasonId : undefined}
          data-testid="proposal-accept"
        >
          {acceptLabel}
        </Button>
        {acceptBlocked && (
          <span
            id={reasonId}
            className="text-2xs text-muted-foreground"
            data-testid="proposal-accept-reason"
          >
            {acceptBlocked === 'syncing' ? 'Syncing…' : 'Can’t apply until your data loads'}
          </span>
        )}
        {canRetry && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground"
            onClick={() => retry()}
            data-testid="proposal-retry"
          >
            <RotateCcw className="h-3 w-3" />
            Something else
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={dismiss}
        >
          Not now
        </Button>
      </div>
    </div>
  );
}
