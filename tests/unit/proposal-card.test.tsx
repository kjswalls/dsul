import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useSyncExternalStore } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Proposal } from '@/lib/planner-types';

/**
 * The card is the one place the AI's suggestion becomes a change to the user's
 * planner, so the things worth pinning are the ones that decide WHAT gets
 * written: which lines are in, and that the button never promises more than
 * the ticked ones.
 *
 * "Not now" used to be the only exit that was not all-or-nothing, and it left
 * the user exactly where they started. The two escapes added here — drop a
 * line, ask for something else — are the difference between a card you can
 * negotiate with and one you can only obey or close.
 */

const accept = vi.fn();
const retry = vi.fn();
const dismiss = vi.fn();

let proposal: Proposal | null = null;
let status = 'ready';
let intent: string | null = 'ask';
let surface = 'chat';
let refused: { count: number; reasons: string[] } = { count: 0, reasons: [] };

/**
 * The dropped lines live in the store (lib/proposal-store.ts `selection`),
 * so the stand-in keeps them as the real one does: tagged with the proposal
 * they were dropped from, and announced to the card when they change.
 */
let selection: { proposalId: string | null; dropped: ReadonlySet<number> } = { proposalId: null, dropped: new Set() };
let version = 0;
const listeners = new Set<() => void>();
const toggleDropped = (index: number) => {
  const proposalId = proposal?.id ?? null;
  const next = new Set(selection.proposalId === proposalId ? selection.dropped : []);
  if (!next.delete(index)) next.add(index);
  selection = { proposalId, dropped: next };
  version += 1;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const storeState = () => ({
  proposal,
  status,
  error: null,
  emptyMessage: null,
  accept,
  retry,
  dismiss,
  lastRequest: intent ? { intent, surface } : null,
  refused,
  selection,
  toggleDropped,
});

vi.mock('@/lib/proposal-store', () => {
  // Also callable as `useProposalStore.getState()` — the card reads the store
  // imperatively in its unmount cleanup, so the cleanup sees the state at
  // UNMOUNT rather than whatever was captured when the effect ran.
  const useProposalStore = (sel: (s: unknown) => unknown) => {
    useSyncExternalStore(subscribe, () => version);
    return sel(storeState());
  };
  useProposalStore.getState = () => storeState();
  return { useProposalStore };
});

/**
 * The planner as the card reads it: rows for the line text, and where its load
 * is (accept waits for it). Loaded unless a test says otherwise.
 */
const LOADED = { userId: 'u1', isLoading: false, isPreview: false, error: null, loadFailedUserId: null };
const planner = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('@/lib/planner-store', () => ({
  usePlannerStore: (sel: (s: unknown) => unknown) => sel({ items: [], itemTypes: [], ...planner.state }),
}));

// The card's job here is selection, not phrasing — one stable line per op keeps
// the assertions about which operations survive rather than how they read.
vi.mock('@/lib/proposal', () => ({
  describeOperation: (op: { title?: string }) => op.title ?? 'a change',
  isDestructive: (op: { kind: string }) => op.kind === 'delete' || op.kind === 'resetStreak',
}));

import { ProposalCard } from '@/components/ai/proposal-card';
import {
  seedAI,
  CONNECTED_MODEL,
  NOTHING_CONNECTED,
  OPENCLAW_PLUGIN,
  type SeedAI,
} from './helpers/ai-fixtures';

const op = (title: string) => ({ kind: 'create' as const, itemType: 'task', title });

const makeProposal = (...titles: string[]): Proposal =>
  ({
    id: 'p1',
    createdAt: '2026-08-26T00:00:00.000Z',
    summary: 'A plan',
    rationale: 'because',
    operations: titles.map(op),
  }) as unknown as Proposal;

beforeEach(() => {
  accept.mockClear();
  retry.mockClear();
  dismiss.mockClear();
  planner.state = { ...LOADED };
  status = 'ready';
  intent = 'ask';
  surface = 'chat';
  refused = { count: 0, reasons: [] };
  selection = { proposalId: null, dropped: new Set() };
  proposal = makeProposal('one', 'two', 'three');
  // The gate is real (the shared fixture seeds both of its stores). Retry is
  // offered only while something can answer it, so every test below that is
  // not about the gate runs with a working model.
  seed(CONNECTED_MODEL);
});

let unseed: () => void = () => {};
const seed = (o?: SeedAI) => {
  unseed();
  unseed = seedAI(o);
};

afterEach(() => {
  unseed();
  unseed = () => {};
});

const acceptButton = () => screen.getByTestId('proposal-accept') as HTMLButtonElement;
const lines = () => screen.getAllByTestId('proposal-line');

describe('dropping individual lines', () => {
  it('starts with every line in — the card is an offer, not a form', () => {
    render(<ProposalCard />);
    expect(lines()).toHaveLength(3);
    for (const line of lines()) expect(line.getAttribute('aria-pressed')).toBe('true');
    expect(acceptButton().textContent).toContain('Do all of it');
  });

  it('accepts only the lines still ticked', () => {
    render(<ProposalCard />);
    fireEvent.click(lines()[1]);
    fireEvent.click(acceptButton());

    expect(accept).toHaveBeenCalledTimes(1);
    const passed = accept.mock.calls[0][0] as Array<{ title: string }>;
    expect(passed.map((o) => o.title)).toEqual(['one', 'three']);
  });

  it('is a toggle — a line put back comes back', () => {
    render(<ProposalCard />);
    fireEvent.click(lines()[0]);
    expect(lines()[0].getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(lines()[0]);
    expect(lines()[0].getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(acceptButton());
    expect((accept.mock.calls[0][0] as unknown[]).length).toBe(3);
  });

  it('never promises more than what is ticked', () => {
    render(<ProposalCard />);
    fireEvent.click(lines()[0]);
    expect(acceptButton().textContent).toContain('Do these 2');
    fireEvent.click(lines()[1]);
    expect(acceptButton().textContent).toContain('Do just that one');
  });

  it('will not accept an empty selection', () => {
    render(<ProposalCard />);
    for (const line of lines()) fireEvent.click(line);
    expect(acceptButton().disabled).toBe(true);
    fireEvent.click(acceptButton());
    expect(accept).not.toHaveBeenCalled();
  });

  it('reads "Do it" for a single-line plan', () => {
    proposal = makeProposal('only one');
    render(<ProposalCard />);
    expect(acceptButton().textContent).toContain('Do it');
  });

  it('says what a delete or a streak reset does on its button', () => {
    proposal = { ...makeProposal('x'), operations: [{ kind: 'delete', what: 'item', id: 'gone' }] } as Proposal;
    const { rerender } = render(<ProposalCard />);
    expect(acceptButton().textContent).toBe('Delete');
    proposal = { ...makeProposal('x'), id: 'p3', operations: [{ kind: 'resetStreak', itemId: 'h' }] } as Proposal;
    rerender(<ProposalCard />);
    expect(acceptButton().textContent).toBe('Reset streak');
  });

  it('clears the selection when a new proposal arrives', () => {
    // Indices are positional. Carrying them across cards would silently drop
    // whichever line happened to land where a dropped one used to be.
    const { rerender } = render(<ProposalCard />);
    fireEvent.click(lines()[0]);
    expect(acceptButton().textContent).toContain('Do these 2');

    proposal = { ...makeProposal('a', 'b', 'c'), id: 'p2' } as Proposal;
    rerender(<ProposalCard />);
    expect(acceptButton().textContent).toContain('Do all of it');
  });
});

describe('accept waits for the planner to load', () => {
  // The store's accept refuses before the planner has loaded and keeps the
  // card (lib/proposal-store.ts). On its own that was a button that did
  // nothing; the card says why instead, and only says "Syncing…" while a load
  // is actually in flight.
  const reason = () => screen.queryByTestId('proposal-accept-reason');

  it('is disabled with "Syncing…" while the load is in flight (the preview included)', () => {
    planner.state = { ...LOADED, isLoading: true, isPreview: true };
    render(<ProposalCard />);

    expect(acceptButton().disabled).toBe(true);
    expect(reason()).toHaveTextContent('Syncing…');
    expect(acceptButton().getAttribute('aria-describedby')).toBe(reason()!.id);
    // Still says what it would do.
    expect(acceptButton().textContent).toContain('Do all of it');
    fireEvent.click(acceptButton());
    expect(accept).not.toHaveBeenCalled();
  });

  it('after a FAILED load, is disabled with a reason that is not "Syncing…"', () => {
    planner.state = { ...LOADED, error: 'Failed to load data', loadFailedUserId: 'u1' };
    render(<ProposalCard />);

    expect(acceptButton().disabled).toBe(true);
    expect(reason()).toHaveTextContent('Can’t apply until your data loads');
    expect(reason()).not.toHaveTextContent('Syncing');
    fireEvent.click(acceptButton());
    expect(accept).not.toHaveBeenCalled();
    // The way out stays open.
    expect(screen.getByRole('button', { name: 'Not now' })).not.toBeDisabled();
  });

  it('is live, with no reason, once loaded', () => {
    render(<ProposalCard />);

    expect(acceptButton().disabled).toBe(false);
    expect(reason()).toBeNull();
    expect(acceptButton().hasAttribute('aria-describedby')).toBe(false);
    fireEvent.click(acceptButton());
    expect(accept).toHaveBeenCalledTimes(1);
  });
});

describe('asking for something else', () => {
  it('offers a retry on a model-backed ask', () => {
    render(<ProposalCard />);
    fireEvent.click(screen.getByTestId('proposal-retry'));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('hides it on catch-up, which would return the same answer', () => {
    // buildCatchUpProposal is a pure function of the planner. A retry that
    // cannot differ is a button that lies.
    intent = 'catch-up';
    render(<ProposalCard />);
    expect(screen.queryByTestId('proposal-retry')).toBeNull();
  });

  it('hides it when nothing produced this card', () => {
    intent = null;
    render(<ProposalCard />);
    expect(screen.queryByTestId('proposal-retry')).toBeNull();
  });

  it('leaves "Not now" as a real exit alongside it', () => {
    render(<ProposalCard />);
    fireEvent.click(screen.getByText('Not now'));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});

describe('which mount answers', () => {
  /**
   * One store, several mounts. A breakdown asked for inside an item's dialog
   * must not answer into the sidebar behind it — the user would be looking at
   * the button they just pressed with nothing visibly happening.
   */
  it('renders the card on the surface that asked for it', () => {
    surface = 'item:abc';
    render(<ProposalCard surface="item:abc" />);
    expect(screen.getByTestId('proposal-card')).toBeTruthy();
  });

  it('stays silent on every other surface', () => {
    surface = 'item:abc';
    render(<ProposalCard surface="chat" />);
    expect(screen.queryByTestId('proposal-card')).toBeNull();
  });

  it('defaults to the chat surface, so existing mounts are unchanged', () => {
    surface = 'chat';
    render(<ProposalCard />);
    expect(screen.getByTestId('proposal-card')).toBeTruthy();
  });

  it('hides the loading state on the wrong surface too', () => {
    // Otherwise a spinner appears in the sidebar for work asked for elsewhere.
    surface = 'item:abc';
    status = 'loading';
    render(<ProposalCard surface="chat" />);
    expect(screen.queryByTestId('proposal-card')).toBeNull();
  });

  it('offers a retry on a breakdown, which can genuinely differ', () => {
    intent = 'breakdown';
    surface = 'item:abc';
    render(<ProposalCard surface="item:abc" />);
    expect(screen.getByTestId('proposal-retry')).toBeTruthy();
  });
});

describe('a card whose surface goes away', () => {
  /**
   * "Break it down" lives inside a panel the user can close. If the reply lands
   * on a surface nothing mounts there is no card, no toast, and no trace the
   * button did anything — recoverable only by reopening that exact item, which
   * nothing tells them. Closing the panel drops the request instead.
   */
  it('dismisses the request it owns when it unmounts', () => {
    surface = 'item:abc';
    const { unmount } = render(<ProposalCard surface="item:abc" />);
    unmount();
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('leaves a request belonging to another surface alone', () => {
    surface = 'chat';
    const { unmount } = render(<ProposalCard surface="item:abc" />);
    unmount();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('never dismisses on behalf of the chat mount, which is always there', () => {
    // The sidebar card unmounts every time the panel collapses; cancelling the
    // user's request for that would be its own bug.
    surface = 'chat';
    const { unmount } = render(<ProposalCard />);
    unmount();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("never dismisses a conversation's plan on unmount: leaving the conversation is the close", () => {
    // A tab switch, an item opened over it or a closed rail unmounts the
    // conversation's view without closing it, and the plan cost a model call.
    // rail-store drops the card once the conversation leaves both Ask stacks.
    surface = 'conv:abc';
    const { unmount } = render(<ProposalCard surface="conv:abc" />);
    expect(screen.getByTestId('proposal-card')).toBeTruthy();
    unmount();
    expect(dismiss).not.toHaveBeenCalled();
  });
});

describe('states with a way out', () => {
  it('lets the user cancel while it is thinking', () => {
    // Every other state had an exit; this one did not, and it is the state that
    // lasts longest and greys out the AI buttons on its own surface.
    status = 'loading';
    render(<ProposalCard />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('offers a retry from the error state, where trying again is the obvious move', () => {
    status = 'error';
    render(<ProposalCard />);
    fireEvent.click(screen.getByTestId('proposal-retry'));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('announces itself, since the card can appear without the user looking', () => {
    render(<ProposalCard />);
    expect(screen.getByTestId('proposal-card').getAttribute('role')).toBe('status');
  });
});

describe('suggestions that could not be made', () => {
  /**
   * Validation drops individual operations rather than failing the whole plan —
   * right, but it was SILENT. Ask for five things back in the Braindump, have
   * three turn out to be repeating items, and the card rendered two with no
   * explanation, which reads as the assistant ignoring most of what you said.
   * The reasons were already computed and thrown away at the one point where
   * somebody could read them.
   */
  it('says how many were left out, and why', () => {
    refused = { count: 2, reasons: ['a repeating item cannot be moved to the Braindump'] };
    render(<ProposalCard />);
    const note = screen.getByTestId('proposal-refused').textContent ?? '';
    expect(note).toContain('2 other changes');
    expect(note).toContain('repeating item');
  });

  it('reads naturally for a single one', () => {
    refused = { count: 1, reasons: ['a goal milestone keeps its target date'] };
    render(<ProposalCard />);
    expect(screen.getByTestId('proposal-refused').textContent).toContain('One other change');
  });

  it('says nothing when everything went through', () => {
    render(<ProposalCard />);
    expect(screen.queryByTestId('proposal-refused')).toBeNull();
  });

  it('offers a retry from the empty card, where asking differently is the move', () => {
    // "None of those would work here" was the one state that could not retry.
    status = 'empty';
    refused = { count: 3, reasons: ['a repeating item cannot be moved to the Braindump'] };
    render(<ProposalCard />);
    fireEvent.click(screen.getByTestId('proposal-retry'));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('explains an empty card, where it is the only account there is', () => {
    // Every operation refused. "No changes to suggest" alone would be a lie
    // about a reply that suggested plenty.
    status = 'empty';
    refused = { count: 3, reasons: ['a repeating item cannot be moved to the Braindump'] };
    render(<ProposalCard />);
    expect(screen.getByTestId('proposal-refused').textContent).toContain('repeating item');
  });

  it('blames the app, never the user', () => {
    refused = { count: 2, reasons: ['a goal milestone keeps its target date'] };
    render(<ProposalCard />);
    const note = screen.getByTestId('proposal-refused').textContent ?? '';
    expect(note).not.toMatch(/you |your |invalid|error|failed/i);
    expect(note).toMatch(/couldn.t be made/i);
  });
});

describe('retry needs something to answer it', () => {
  /** Every way the gate can close on a card that is already on screen. */
  const CLOSED: Array<[string, SeedAI | undefined]> = [
    [
      'the key was turned down mid-ask',
      {
        ...CONNECTED_MODEL,
        model: { provider: 'openai', model: 'gpt-4o-mini', status: 'failing', problem: 'key_rejected' },
      },
    ],
    ['"Who answers" is Off', { ...CONNECTED_MODEL, choice: 'none' }],
    ['the model was disconnected', NOTHING_CONNECTED],
    // Plugin-path OpenClaw chats but cannot propose (no structured transport).
    ['only plugin-path OpenClaw is left', OPENCLAW_PLUGIN],
    ['the status read failed', { phase: 'error' }],
  ];

  it.each(CLOSED)('hides "Try again" when %s, on every card state', (_label, state) => {
    seed(state);
    for (const s of ['ready', 'empty', 'error']) {
      status = s;
      for (const i of ['ask', 'breakdown']) {
        intent = i;
        const { unmount } = render(<ProposalCard />);
        // The card itself stays (it can still be accepted or closed)…
        expect(screen.getByTestId('proposal-card')).toBeInTheDocument();
        // …but nothing offers a model call that nothing will make.
        expect(screen.queryByTestId('proposal-retry'), `${s} × ${i}`).toBeNull();
        unmount();
      }
    }
  });

  it('offers it again with OpenClaw on its gateway, which can propose', () => {
    seed({ ...OPENCLAW_PLUGIN, openclaw: { gateway: true, agent: true, agentId: 'kirby-1' } });
    status = 'error';
    render(<ProposalCard />);
    fireEvent.click(screen.getByTestId('proposal-retry'));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
