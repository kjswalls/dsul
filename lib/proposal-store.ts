'use client';

import { create } from 'zustand';
import { format } from 'date-fns';
import { usePlannerStore } from './planner-store';
import { isPlannerLoaded } from './planner-ready';
import { inactiveItemIdsOn } from './active';
import { milestoneItemIds } from './goals';
import { useAISettingsStore } from './ai-settings-store';
import { getAICapabilities, useAIConnectionStore } from './ai-connection-store';
import type { ChatErrorCode } from './ai-types';
import { buildCatchUpProposal, buildProposalContext, validateProposal } from './proposal';
import type { Proposal } from './planner-types';

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

export type ProposalIntent = 'catch-up' | 'ask' | 'breakdown';

/**
 * Where a card belongs.
 *
 * One store, several mounts. A breakdown asked for inside an item's detail
 * dialog must not answer into the sidebar behind it — the card would be
 * literally invisible, and the user would be looking at the button they just
 * pressed with nothing happening. So each request records the surface it came
 * from and each `<ProposalCard>` renders only its own.
 */
export type ProposalSurface = 'chat' | `item:${string}`;
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

  request: (intent: ProposalIntent, prompt?: string, itemId?: string) => Promise<void>;
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
  return {
    items: state.items,
    customTypeNames: state.itemTypes.map((t) => t.name),
    todayStr: today,
    // Work a routine or season has paused today is not "waiting on you" — the
    // same rule the auto-age sweep and the past-due bar obey.
    // Every bulk date verb subtracts these; a proposal that clears a date is
    // one. See the note on ProposalContext.
    milestoneIds: milestoneItemIds(state.goals),
    inactiveIds: inactiveItemIdsOn(state.items, today, {
      // Same fallback the store uses everywhere it needs a zone.
      userTimezone: state.userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
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
});

const NOTHING_REFUSED = { count: 0, reasons: [] as string[] };

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
  const claim = () => ++generation;
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
                ? "None of those would work here — see why below."
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

    request: async (intent, prompt, itemId) => {
      const token = claim();
      set({
        status: 'loading',
        error: null,
        emptyMessage: null,
        proposal: null,
        refused: NOTHING_REFUSED,
        // The original ask, kept verbatim so retries decorate it rather than
        // stacking on each other's decoration.
        lastRequest: { intent, prompt, itemId, surface: itemId ? `item:${itemId}` : 'chat' },
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

    retry: async () => {
      const { proposal, lastRequest, rejected } = get();
      // Catch-up is a pure function of the planner: asking it again returns the
      // same items in the same order. Only a model-backed ask has a different
      // answer in it, so only that one may offer a retry.
      // Catch-up is the one intent with nothing to gain: it is a pure function
      // of the planner, so a second call returns the same items in the same
      // order. Ask and breakdown both go to a model and can genuinely differ.
      if (!lastRequest || lastRequest.intent === 'catch-up') return;
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
      const { proposal } = get();
      if (!proposal) return 0;
      const chosen = operations ?? proposal.operations;
      // Ticking every line off is a dismissal, not an acceptance of nothing.
      if (chosen.length === 0) return 0;
      const applied = usePlannerStore
        .getState()
        .applyProposal({ ...proposal, operations: chosen });

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
          emptyMessage: 'Those items have changed — nothing left to apply.',
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
