'use client';

import { create } from 'zustand';
import { format } from 'date-fns';
import { getHistoryInfo, usePlannerStore } from './planner-store';
import { isPlannerLoaded, isPlannerPreviewing, whenPreviewEnds } from './planner-ready';
import { inactiveItemIdsOn } from './active';
import { milestoneItemIds } from './goals';
import { useAISettingsStore } from './ai-settings-store';
import { getAICapabilities, useAIConnectionStore } from './ai-connection-store';
import type { ChatErrorCode } from './ai-types';
import { buildCatchUpProposal, buildProposalContext, validateProposal } from './proposal';
import { noteOpenclawAsked, useConversationsStore } from './conversations-store';
import { tallyOperations } from './conversation-summary';
import { useChatReceipts } from './chat-receipts';
import type { Proposal, ProposalDraft, ProposalOperation } from './planner-types';

/**
 * proposal-store.ts — the AI's pending suggestion, and the user's one tap.
 *
 * Deliberately ephemeral: a proposal is a moment's suggestion about a plan that
 * is already changing underneath it, and a stale card resurrected on next
 * launch ("move these 5 things to last Tuesday") is worse than no card. The
 * planner is the durable thing; this is not. Persisting proposals would need a
 * table, a staleness policy, and cross-device reconciliation — see
 * memory/plans/ai-vision.md.
 */

/**
 * 'offer' is a card chat's own model drew mid-reply (propose_changes,
 * lib/ai-server/chat-changes.ts): there is no ask to send again, so it has no
 * retry; the user says what to change in the conversation instead.
 */
export type ProposalIntent = 'catch-up' | 'ask' | 'breakdown' | 'offer';

/**
 * Where a card belongs.
 *
 * One store, several mounts. A breakdown asked for inside an item's detail
 * dialog must not answer into the sidebar behind it — the card would be
 * literally invisible, and the user would be looking at the button they just
 * pressed with nothing happening. So each request records the surface it came
 * from and each `<ProposalCard>` renders only its own.
 *
 *   'chat'         the catch-up card (no conversation of its own)
 *   `item:<id>`    asked from an item: a breakdown
 *   `conv:<id>`    asked from a saved conversation ("Turn this into a plan");
 *                  what it changes is counted on that conversation's History
 *                  row (lib/conversations-store.ts, `noteChanges`)
 */
export type ProposalSurface = 'chat' | `item:${string}` | `conv:${string}`;
export type ProposalStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

interface ProposalStore {
  proposal: Proposal | null;
  status: ProposalStatus;
  /** Set when status is 'error' — shown on the card, never thrown. */
  error: string | null;
  /** Copy for the 'empty' state, which is good news and should read like it. */
  emptyMessage: string | null;
  /**
   * What produced the current card, so it can be asked again — the ORIGINAL
   * ask, never the retry-decorated one, or each retry would compound the last.
   */
  lastRequest: {
    intent: ProposalIntent;
    prompt?: string;
    /** The item being broken down; absent on every other intent. */
    itemId?: string;
    surface: ProposalSurface;
  } | null;
  /** Summaries offered and turned down this round, newest last. */
  rejected: string[];
  /**
   * How many suggestions VALIDATION refused before the card was drawn, and
   * why. Distinct from the lines the USER drops on the card — different actor,
   * different meaning, so a different word.
   *
   * Validation silently discarded these. Ask for five things back in the
   * Braindump, have three of them turn out to be repeating items, and the card
   * rendered two with no explanation — the user reads that as the assistant
   * ignoring most of what they said. The reasons are already computed; they
   * were being thrown away at the one point where somebody could read them.
   */
  refused: { count: number; reasons: string[] };
  /**
   * The lines the USER has ticked off the card, by index, tagged with the
   * proposal they belong to (ProposalCard has why the id travels with them).
   *
   * Here rather than in the card because the card remounts while the user is
   * still reviewing it: a catch-up host hands it to Ask home when the gate
   * opens mid-review, an item opened over a conversation and Back remount its
   * view, and Ask kept mounted under an overlay holds a second copy of the
   * catch-up card beside the dock's. Local state would come back all-ticked
   * in each of those, and Accept would then apply the very lines the user had
   * dropped.
   */
  selection: { proposalId: string | null; dropped: ReadonlySet<number> };

  /** Tick a line off the current card, or back on. */
  toggleDropped: (index: number) => void;
  /**
   * `itemId` asks about that item (a breakdown); `conversationId` says which
   * conversation asked, so the card answers there and what it changes is
   * counted on that conversation. Neither: the catch-up card's 'chat'.
   */
  request: (
    intent: ProposalIntent,
    prompt?: string,
    itemId?: string,
    o?: { conversationId?: string }
  ) => Promise<void>;
  /**
   * Show a card the AI offered in a conversation's reply, validated against
   * the planner as it is now. It replaces whatever card was up, as a new ask
   * would.
   */
  offer: (draft: ProposalDraft, conversationId: string) => void;
  /**
   * Ask again, telling the model what it already offered.
   *
   * "Not now" is a dead end — it closes the card and leaves the user exactly
   * where they started. Most of the time the plan is not wrong, it is not
   * quite right, and the cheapest fix is another go.
   */
  retry: () => Promise<void>;
  /**
   * Apply through the planner store (one set, one undo) and clear the card.
   *
   * `operations` narrows to a subset the user ticked: a plan is easier to say
   * yes to when four of its five lines are right and the fifth can just be
   * dropped, rather than costing the whole card.
   */
  accept: (operations?: Proposal['operations']) => number;
  dismiss: () => void;
}

/**
 * The context a breakdown needs: the one item, in full.
 *
 * Deliberately NOT `buildProposalContext` — sixty other items is noise when the
 * question is "what are the steps inside this one", and the model would use
 * them, proposing subtasks that duplicate work already sitting elsewhere in the
 * planner. Existing children ARE included: asked twice, the second answer
 * should continue the list rather than repeat it.
 */
function describeForBreakdown(ctx: ReturnType<typeof plannerContext>, itemId: string): string {
  const item = ctx.items.find((i) => i.id === itemId);
  if (!item) return '(that item no longer exists)';

  const lines = [
    '## The item to break down',
    `- id: ${itemId}`,
    `- title: ${item.title}`,
  ];
  if (item.notes) lines.push(`- notes: ${item.notes}`);
  if ('startDate' in item && item.startDate) lines.push(`- due: ${item.startDate}`);

  const children = ctx.items.filter(
    (i) => 'parentItemId' in i && i.parentItemId === itemId
  );
  if (children.length > 0) {
    lines.push('', 'Steps it already has — do not repeat these:');
    for (const child of children) lines.push(`- ${child.title}`);
  }
  return lines.join('\n');
}

/** Enough for the model to see the pattern; not enough to crowd out the ask. */
const MAX_REJECTED_CARRIED = 3;

/** What each intent asks for when the user did not phrase the question. */
const DEFAULT_ASK = {
  plan: 'Suggest a realistic plan for today.',
  breakdown: 'Break this into a few concrete steps.',
} as const;

/** The ask, plus whatever has already been turned down. */
function withRejections(
  prompt: string | undefined,
  rejected: string[],
  fallback: string = DEFAULT_ASK.plan
): string {
  const base = prompt?.trim() || fallback;
  if (rejected.length === 0) return base;
  return [
    base,
    '',
    'Already suggested and turned down — offer something meaningfully different, not a reworded version of these:',
    ...rejected.slice(-MAX_REJECTED_CARRIED).map((summary) => `- ${summary}`),
  ].join('\n');
}

const todayStr = () => format(new Date(), 'yyyy-MM-dd');

function plannerContext() {
  const state = usePlannerStore.getState();
  const today = todayStr();
  // Same fallback the store uses everywhere it needs a zone.
  const tz = state.userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    items: state.items,
    customTypeNames: state.itemTypes.map((t) => t.name),
    todayStr: today,
    // With the day, a tick, skip or pause on the card asks its own gate.
    tz,
    // Work a routine or season has paused today is not "waiting on you" — the
    // same rule the auto-age sweep and the past-due bar obey.
    // Every bulk date verb subtracts these; a proposal that clears a date is
    // one. See the note on ProposalContext.
    milestoneIds: milestoneItemIds(state.goals),
    inactiveIds: inactiveItemIdsOn(state.items, today, {
      userTimezone: tz,
      routines: state.routines,
      seasons: state.seasons,
    }),
  };
}

function stamp(draft: { summary: string; rationale?: string; operations: Proposal['operations'] }): Proposal {
  return { ...draft, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
}

/**
 * Cleared card, cleared retry history — where `dismiss` and `accept` land.
 *
 * A function, not a constant: it hands back a fresh `rejected` array each time
 * rather than sharing one across every reset.
 */
const cleared = (): Partial<ProposalStore> => ({
  proposal: null,
  status: 'idle',
  error: null,
  emptyMessage: null,
  lastRequest: null,
  rejected: [],
  refused: NOTHING_REFUSED,
  selection: NO_SELECTION,
});

const NOTHING_REFUSED = { count: 0, reasons: [] as string[] };

/** Every line in: the card is an offer, and a new one starts all-ticked. */
const NO_SELECTION: ProposalStore['selection'] = { proposalId: null, dropped: new Set<number>() };

/**
 * The conversation an accepted card counts against: the `conv:` card's own,
 * or the item's one conversation for an `item:` card. None (the catch-up card,
 * or an item nobody has chatted about) means there is no row to count on.
 */
function conversationFor(surface: ProposalSurface | undefined): string | null {
  if (!surface || surface === 'chat') return null;
  const conversations = useConversationsStore.getState();
  const id = surface.startsWith('conv:')
    ? surface.slice('conv:'.length)
    : conversations.itemIndex[surface.slice('item:'.length)];
  return typeof id === 'string' && id ? id : null;
}

function noteAccepted(surface: ProposalSurface | undefined, accepted: readonly ProposalOperation[]): void {
  const id = conversationFor(surface);
  if (id) useConversationsStore.getState().noteChanges(id, tallyOperations(accepted));
}

/**
 * The accept's receipt, in the conversation that asked (lib/chat-receipts.ts):
 * what the planner actually took, and the history entry it wrote, which is the
 * newest one the moment applyProposal returns.
 */
function receiptFor(surface: ProposalSurface | undefined, accepted: readonly ProposalOperation[]): void {
  const id = conversationFor(surface);
  if (!id || accepted.length === 0) return;
  const actionId = getHistoryInfo().actionLog[0]?.id;
  if (!actionId) return;
  const messages = useConversationsStore.getState().threads[id]?.messages;
  useChatReceipts.getState().add(id, {
    actionId,
    afterMessageId: messages?.at(-1)?.id ?? null,
    tally: tallyOperations(accepted),
    undone: false,
  });
}

/**
 * Deduped and capped: three identical "a repeating item cannot be moved to the
 * Braindump" lines say no more than one, and the note is a footnote, not a
 * report.
 */
function summariseRefused(
  rejected: ReadonlyArray<{ reason: string }>
): { count: number; reasons: string[] } {
  if (rejected.length === 0) return NOTHING_REFUSED;
  return {
    count: rejected.length,
    reasons: [...new Set(rejected.map((r) => r.reason))].slice(0, 3),
  };
}

export const useProposalStore = create<ProposalStore>()((set, get) => {
  /**
   * Which request the store is currently listening to.
   *
   * Every terminal write goes through `settle`, which drops anything from a
   * superseded request. Without this the last fetch to RETURN wins rather than
   * the last one ASKED, and the two do not have to be the same: `request`
   * ('catch-up') resolves synchronously, so a slow breakdown can land after a
   * catch-up card is already on screen and silently replace it — leaving
   * breakdown lines under a `lastRequest` that says catch-up, on a surface
   * whose panel is closed, with the retry button hidden because the intent no
   * longer matches. Accepting or dismissing bumps it too, so a reply in flight
   * cannot resurrect a card the user has already dealt with.
   */
  let generation = 0;
  /** The ask waiting out a look-only preview, if any: a newer claim ends its wait. */
  let waiting: AbortController | null = null;
  const claim = () => {
    waiting?.abort();
    waiting = null;
    return ++generation;
  };
  const settle = (token: number, patch: Partial<ProposalStore>) => {
    if (token === generation) set(patch);
  };

  /**
   * Everything from the tier check to the validated card.
   *
   * Shared by `request('ask')` and `retry()` so the two cannot drift — and so
   * retry is genuinely the same call with a different prompt, rather than a
   * second copy of the fetch that will one day be updated alone.
   */
  async function askModel(promptForModel: string, itemId: string | undefined, token: number): Promise<void> {
    // Nothing goes out on cached rows, as with Ask's send
    // (lib/conversations-store.ts): during the look-only preview the ask
    // waits for the load to settle, then reads the gate and builds its context
    // from the fresh rows. The card shows its spinner meanwhile. Asked before
    // awaiting, so an ordinary ask still reaches fetch in its caller's tick.
    if (isPlannerPreviewing()) {
      const wait = new AbortController();
      waiting = wait;
      await whenPreviewEnds(wait.signal);
      if (waiting === wait) waiting = null;
      if (token !== generation) return;
    }

    // Who proposes is the gate's call (lib/ai-registry.ts): the connected
    // model, or an OpenClaw GATEWAY. The plugin path has no structured
    // proposals, and the route never reroutes an OpenClaw user's planner to a
    // model they did not pick, so there it is null too.
    const { proposeTarget } = getAICapabilities();
    if (!proposeTarget) {
      settle(token, {
        status: 'error',
        error: 'Connect a model in Settings to ask for a plan.',
      });
      return;
    }

    try {
      // Inside the try: this reads three stores and walks every item, and a
      // throw out here would park `status` at 'loading' forever — a spinner
      // with no exit that also greys out every other AI button.
      const ctx = plannerContext();

      // A plan asked from a conversation carries an excerpt of it (both
      // sides): asked of an OpenClaw gateway, OpenClaw now holds that much of
      // it, which the conversation's delete confirm must say.
      const surface = get().lastRequest?.surface;
      if (proposeTarget === 'openclaw' && surface?.startsWith('conv:')) noteOpenclawAsked(surface.slice('conv:'.length));

      const res = await fetch('/api/ai/propose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // A target and the user's own words. The key, the model and the
        // system prompt are the server's; this body never carries them.
        body: JSON.stringify({
          prompt: promptForModel,
          target: proposeTarget,
          // Breakdown gets its own system prompt: "propose a plan across the
          // week" and "propose the steps inside this one thing" want opposite
          // instincts, and one prompt trying to do both does neither well.
          mode: itemId ? 'breakdown' : 'plan',
          itemContext: itemId ? describeForBreakdown(ctx, itemId) : buildProposalContext(ctx),
          todayStr: ctx.todayStr,
          // Appended server-side to the built-in prompt, never in place of it.
          customInstructions: useAISettingsStore.getState().systemPrompt,
        }),
      });
      // A 500 with no body — a crashed or platform-killed function — makes
      // res.json() throw, and an unhandled SyntaxError would reach the card as
      // "Unexpected end of JSON input".
      const data = await res.json().catch(() => ({}) as Record<string, unknown>);
      if (!res.ok || data.error) {
        // The code says WHY (a rejected key, a connection gone); the gate
        // re-checks on the ones that change what can answer.
        if (typeof data.code === 'string' && data.code) {
          useAIConnectionStore.getState().noteCallFailure(data.code as ChatErrorCode);
        }
        // `error` is the route's own copy, never a provider's text.
        throw new Error(
          typeof data.error === 'string' && data.error ? data.error : `HTTP ${res.status}`
        );
      }
      if (!data.proposal) {
        settle(token, {
          status: 'empty',
          emptyMessage: (data.message as string) ?? 'No changes to suggest.',
        });
        return;
      }

      // Validate against the CURRENT planner, not the one the request was built
      // from — the user may have edited things while the model was thinking.
      const { proposal, rejected } = validateProposal(stamp(data.proposal), plannerContext());
      const refused = summariseRefused(rejected);
      settle(
        token,
        proposal.operations.length
          ? { proposal, refused, status: 'ready' }
          : {
              status: 'empty',
              refused,
              // Every operation was refused. Saying "no changes to suggest"
              // would be a lie about a reply that suggested plenty.
              emptyMessage: rejected.length
                ? "None of those would work here. See why below."
                : 'Those suggestions no longer apply.',
            }
      );
    } catch (err) {
      settle(token, {
        status: 'error',
        error: err instanceof Error ? err.message : 'Could not reach the assistant.',
      });
    }
  }

  return {
    proposal: null,
    status: 'idle',
    error: null,
    emptyMessage: null,
    lastRequest: null,
    rejected: [],
    refused: NOTHING_REFUSED,
    selection: NO_SELECTION,

    toggleDropped: (index) => {
      const { proposal, selection } = get();
      const proposalId = proposal?.id ?? null;
      const next = new Set(selection.proposalId === proposalId ? selection.dropped : NO_SELECTION.dropped);
      if (!next.delete(index)) next.add(index);
      set({ selection: { proposalId, dropped: next } });
    },

    request: async (intent, prompt, itemId, o) => {
      const token = claim();
      const surface: ProposalSurface = itemId
        ? `item:${itemId}`
        : o?.conversationId
          ? `conv:${o.conversationId}`
          : 'chat';
      set({
        status: 'loading',
        error: null,
        emptyMessage: null,
        proposal: null,
        refused: NOTHING_REFUSED,
        selection: NO_SELECTION,
        // The original ask, kept verbatim so retries decorate it rather than
        // stacking on each other's decoration.
        lastRequest: { intent, prompt, itemId, surface },
        rejected: [],
      });

      // Catch-up is computed locally: it works with no key, no gateway and no
      // network, which is the whole point — the feature that matters most on the
      // worst day should not depend on a provider being reachable.
      if (intent === 'catch-up') {
        const ctx = plannerContext();
        const draft = buildCatchUpProposal(ctx);
        if (!draft) {
          settle(token, { status: 'empty', emptyMessage: "Nothing's waiting on you. Enjoy it." });
          return;
        }
        const { proposal, rejected } = validateProposal(stamp(draft), ctx);
        settle(token, {
          proposal,
          refused: summariseRefused(rejected),
          status: proposal.operations.length ? 'ready' : 'empty',
        });
        return;
      }

      await askModel(
        withRejections(prompt, [], itemId ? DEFAULT_ASK.breakdown : DEFAULT_ASK.plan),
        itemId,
        token
      );
    },

    offer: (draft, conversationId) => {
      const token = claim();
      const { proposal, rejected } = validateProposal(stamp(draft), plannerContext());
      const refused = summariseRefused(rejected);
      settle(token, {
        ...cleared(),
        lastRequest: { intent: 'offer', surface: `conv:${conversationId}` },
        refused,
        ...(proposal.operations.length
          ? { proposal, status: 'ready' as const }
          : {
              status: 'empty' as const,
              emptyMessage: rejected.length ? 'None of those would work here. See why below.' : 'Those suggestions no longer apply.',
            }),
      });
    },

    retry: async () => {
      const { proposal, lastRequest, rejected } = get();
      // Catch-up is a pure function of the planner: asking it again returns the
      // same items in the same order. Only a model-backed ask has a different
      // answer in it, so only that one may offer a retry.
      // Catch-up is the one intent with nothing to gain: it is a pure function
      // of the planner, so a second call returns the same items in the same
      // order. Ask and breakdown both go to a model and can genuinely differ.
      // An offer drawn mid-reply has no ask of its own to send again.
      if (!lastRequest || lastRequest.intent === 'catch-up' || lastRequest.intent === 'offer') return;
      // Nothing can propose any more (the model was disconnected, or chat moved
      // to OpenClaw's plugin, which has no structured proposals). A retry would
      // only swap the card being read for "Connect a model" and spend the
      // rejection it would have carried, so the card stays exactly as it is.
      if (!getAICapabilities().proposeTarget) return;

      const summary = proposal?.summary?.trim();
      // Deduped: a model that keeps offering the same plan would otherwise fill
      // all three carried slots with one repeated line, crowding out the two
      // genuinely different alternatives it had already been told about.
      const nextRejected =
        summary && !rejected.includes(summary) ? [...rejected, summary] : rejected;

      const token = claim();
      set({
        status: 'loading',
        error: null,
        emptyMessage: null,
        proposal: null,
        refused: NOTHING_REFUSED,
        selection: NO_SELECTION,
        rejected: nextRejected,
      });
      await askModel(
        withRejections(
          lastRequest.prompt,
          nextRejected,
          lastRequest.itemId ? DEFAULT_ASK.breakdown : DEFAULT_ASK.plan
        ),
        lastRequest.itemId,
        token
      );
    },

    accept: (operations) => {
      // Before claim(), so the card stays: applyProposal re-validates against
      // the CURRENT planner, which before landing is empty or the look-only
      // preview, and a 0 from there would close it as "those items have changed".
      if (!isPlannerLoaded()) return 0;
      const { proposal, lastRequest } = get();
      if (!proposal) return 0;
      const chosen = operations ?? proposal.operations;
      // Ticking every line off is a dismissal, not an acceptance of nothing.
      if (chosen.length === 0) return 0;
      // What the planner actually took (it re-validates), counted on the
      // conversation that asked: History's second line.
      const surface = lastRequest?.surface;
      let took: readonly ProposalOperation[] = [];
      const applied = usePlannerStore.getState().applyProposal({ ...proposal, operations: chosen }, (accepted) => {
        took = accepted;
        noteAccepted(surface, accepted);
      });
      if (applied > 0) receiptFor(surface, took);

      claim();
      if (applied === 0) {
        // applyProposal re-validates against the CURRENT planner, so every
        // operation can be dropped — the items were deleted while the card sat
        // there. Closing silently would mean the user taps "Do all of it",
        // sees the card vanish, and nothing happens: no change, and no undo
        // entry either, because applyProposal returns before arming one.
        set({
          ...cleared(),
          status: 'empty',
          emptyMessage: 'Those items have changed, so there is nothing left to apply.',
        });
        return 0;
      }
      set(cleared());
      return applied;
    },

    // Bumps the generation too: a reply still in flight must not re-open a card
    // the user has already closed.
    dismiss: () => {
      claim();
      set(cleared());
    },
  };
});
