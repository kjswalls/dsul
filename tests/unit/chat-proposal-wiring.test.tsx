import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  seedAI,
  CONNECTED_MODEL,
  NOTHING_CONNECTED,
  OPENCLAW_PLUGIN,
  type SeedAI,
} from './helpers/ai-fixtures';

/**
 * The two affordances that turn chat from a place you talk into a place work
 * gets done: an opener instead of a blank box, and a way for a conversation to
 * end in a card you tap rather than in changes you then go and make by hand.
 *
 * Worth pinning because both are easy to break invisibly — the plan button
 * silently attaching to the wrong message, or surviving onto a transport that
 * cannot propose, would both still render fine.
 *
 * The AI gate is the REAL one (lib/ai-connection-store.ts + ai-settings-store),
 * seeded per case through the shared fixture: the component asks
 * `useAICapabilities()` and nothing else, so a mock of either store here would
 * be testing the mock.
 */

/** OpenClaw through the user's own gateway: chats AND proposes. */
const OPENCLAW_GATEWAY: SeedAI = {
  phase: 'ready',
  available: true,
  model: null,
  openclaw: { gateway: true, agent: true, agentId: 'kirby-1' },
  choice: 'openclaw',
};

const send = vi.fn();
const stop = vi.fn();
const requestProposal = vi.fn();

let messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
let proposalStatus = 'idle';
let proposalSurface = 'chat';
let isLoading = false;

// Selector-aware: ChatConversation destructures the whole store, but
// ChatComposer — which owns the field and the stop button now — subscribes to
// one slice at a time. A mock that ignored the selector handed the composer the
// entire state object where it expected `send`, and React refused the listener.
vi.mock('@/lib/chat-store', () => {
  const state = () => ({
    messages,
    isLoading,
    isTyping: false,
    send,
    stop,
    hydrate: vi.fn(),
  });
  return {
    useChatStore: (sel?: (s: unknown) => unknown) => (sel ? sel(state()) : state()),
  };
});

vi.mock('@/lib/planner-store', () => ({
  usePlannerStore: (sel: (s: unknown) => unknown) =>
    sel({ items: [], routines: [], seasons: [], userTimezone: 'UTC' }),
}));

vi.mock('@/lib/proposal-store', () => ({
  useProposalStore: (sel: (s: unknown) => unknown) =>
    sel({
      request: requestProposal,
      status: proposalStatus,
      // Which surface owns the pending request. The chat button disables only
      // for its OWN — a breakdown loading inside an item panel used to grey
      // this out with no spinner visible anywhere on screen.
      lastRequest: { surface: proposalSurface },
    }),
}));

vi.mock('@/lib/use-time-format', () => ({ useTimeFormat: () => 'HH:mm' }));

vi.mock('@/lib/supabase', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }),
}));

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => {} }));

import { ChatConversation } from '@/components/ai/chat-conversation';

const PLAN_BUTTON = 'chat-make-plan';

let unseed: () => void = () => {};
const seed = (o: SeedAI) => {
  unseed();
  unseed = seedAI(o);
};

beforeEach(() => {
  send.mockClear();
  stop.mockClear();
  requestProposal.mockClear();
  isLoading = false;
  messages = [];
  seed(CONNECTED_MODEL);
  proposalStatus = 'idle';
  proposalSurface = 'chat';
});

afterEach(() => {
  cleanup();
  unseed();
  unseed = () => {};
});

const renderChat = () => render(<ChatConversation variant="desktop" />);

describe('conversation openers', () => {
  it('offers something to say when the transcript is empty', () => {
    renderChat();
    const openers = screen.getByTestId('chat-openers');
    expect(openers.querySelectorAll('button').length).toBeGreaterThan(0);
  });

  it('sends the full prompt, not the short chip label', () => {
    // The chip has to fit a narrow sidebar; the prompt does not, and the
    // difference is most of what makes the answer good.
    renderChat();
    const first = screen.getByTestId('chat-openers').querySelector('button')!;
    const label = first.textContent ?? '';
    fireEvent.click(first);

    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0][0] as string;
    expect(sent.length).toBeGreaterThan(label.length);
  });

  it('disappears once there is a conversation to look at', () => {
    messages = [{ role: 'user', content: 'hi' }];
    renderChat();
    expect(screen.queryByTestId('chat-openers')).toBeNull();
  });

  it('stays hidden when nothing can answer', () => {
    // An opener whose answer leads nowhere is worse than a blank box.
    seed(NOTHING_CONNECTED);
    renderChat();
    expect(screen.queryByTestId('chat-openers')).toBeNull();
  });

  it('shows for OpenClaw plugin chat, which can answer but not propose', () => {
    // An opener is a plain send(), so it needs chat, not a proposal transport.
    // Gating it on proposing stripped the openers from plugin users.
    seed(OPENCLAW_PLUGIN);
    renderChat();
    expect(screen.getByTestId('chat-openers').querySelectorAll('button').length).toBeGreaterThan(0);
  });
});

describe('the empty state', () => {
  it('invites a question when a model answers, and never asks for a key', () => {
    renderChat();
    expect(screen.getByText('Ask anything')).toBeInTheDocument();
    expect(screen.queryByText(/API key/i)).toBeNull();
    expect(screen.getByPlaceholderText('Ask anything…')).toBeInTheDocument();
  });

  it('names OpenClaw when OpenClaw answers', () => {
    seed(OPENCLAW_PLUGIN);
    renderChat();
    expect(screen.getByText('OpenClaw is ready')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Message OpenClaw…')).toBeInTheDocument();
  });
});

describe('turning a conversation into a plan', () => {
  it('offers the plan button under an assistant reply', () => {
    messages = [
      { role: 'user', content: 'what should I do about this week?' },
      { role: 'assistant', content: 'Push the two writing tasks to Thursday.' },
    ];
    renderChat();
    expect(screen.getByTestId(PLAN_BUTTON)).toBeTruthy();
  });

  it('offers it once, on the latest reply only', () => {
    messages = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'second answer' },
    ];
    renderChat();
    expect(screen.getAllByTestId(PLAN_BUTTON)).toHaveLength(1);
  });

  it('sends the exchange, not just the question', () => {
    // What makes a plan worth proposing usually lives in the reply. A
    // proposer handed only the question has to re-derive the answer and will
    // land somewhere else.
    messages = [
      { role: 'user', content: 'what should I do about this week?' },
      { role: 'assistant', content: 'Push the two writing tasks to Thursday.' },
    ];
    renderChat();
    fireEvent.click(screen.getByTestId(PLAN_BUTTON));

    expect(requestProposal).toHaveBeenCalledTimes(1);
    const [intent, prompt] = requestProposal.mock.calls[0];
    expect(intent).toBe('ask');
    expect(prompt).toContain('what should I do about this week?');
    expect(prompt).toContain('Push the two writing tasks to Thursday.');
  });

  it('reaches back past intervening turns for the question that prompted the reply', () => {
    messages = [
      { role: 'user', content: 'the original ask' },
      { role: 'assistant', content: 'an answer' },
      { role: 'assistant', content: 'a follow-up thought' },
    ];
    renderChat();
    fireEvent.click(screen.getByTestId(PLAN_BUTTON));
    expect(requestProposal.mock.calls[0][1]).toContain('the original ask');
  });

  it('is absent under a user message', () => {
    messages = [{ role: 'user', content: 'hi' }];
    renderChat();
    expect(screen.queryByTestId(PLAN_BUTTON)).toBeNull();
  });

  it('is absent when nothing can propose', () => {
    // resolveAICapabilities is the single question. A button that silently does
    // nothing is worse than no button (lib/ai-registry.ts).
    seed(NOTHING_CONNECTED);
    messages = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ];
    renderChat();
    expect(screen.queryByTestId(PLAN_BUTTON)).toBeNull();
  });

  it('is absent on OpenClaw plugin chat, which has no proposal transport', () => {
    // The propose route never reroutes an OpenClaw user's planner to a model
    // they did not pick, and the plugin path cannot carry a proposal.
    seed(OPENCLAW_PLUGIN);
    messages = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ];
    renderChat();
    expect(screen.queryByTestId(PLAN_BUTTON)).toBeNull();
  });

  it('is offered on the agent tier, which proposes through the user own gateway', () => {
    seed(OPENCLAW_GATEWAY);
    messages = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ];
    renderChat();
    expect(screen.getByTestId(PLAN_BUTTON)).toBeTruthy();
  });

  it('will not fire a second request while one is in flight', () => {
    // Each click costs a model call. The card says "Thinking it through…", but
    // that is above the transcript and easy to miss from down here.
    proposalStatus = 'loading';
    messages = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ];
    renderChat();
    const button = screen.getByTestId(PLAN_BUTTON) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(requestProposal).not.toHaveBeenCalled();
  });

  it('stays live while another surface is thinking', () => {
    // A breakdown loading in an item panel renders its spinner THERE. Greying
    // out this button too leaves a dead control with no explanation — and
    // superseding is safe now, because the store drops a superseded reply.
    proposalStatus = 'loading';
    proposalSurface = 'item:abc';
    messages = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ];
    renderChat();
    expect((screen.getByTestId(PLAN_BUTTON) as HTMLButtonElement).disabled).toBe(false);
  });

  it('clips a long reply from the front, keeping the conclusion', () => {
    // The whole planner already travels with the request; an unbounded reply on
    // top of it is what starts pushing the item list out of the prompt.
    const long = 'x'.repeat(5000) + 'THE ACTUAL CONCLUSION';
    messages = [
      { role: 'user', content: 'the ask' },
      { role: 'assistant', content: long },
    ];
    renderChat();
    fireEvent.click(screen.getByTestId(PLAN_BUTTON));

    const prompt = requestProposal.mock.calls[0][1] as string;
    expect(prompt).toContain('THE ACTUAL CONCLUSION');
    expect(prompt).toContain('the ask');
    expect(prompt.length).toBeLessThan(long.length);
  });

  it('is absent while a reply is still empty', () => {
    messages = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: '' },
    ];
    renderChat();
    expect(screen.queryByTestId(PLAN_BUTTON)).toBeNull();
  });
});

describe('interrupting a reply', () => {
  /**
   * The store could always abort (`abortController.abort()`), and `send`'s
   * finally clears isLoading either way — there was simply no way to ask. The
   * send button is disabled while streaming, so this occupies a dead slot.
   */
  it('offers a stop button while a reply is streaming', () => {
    isLoading = true;
    messages = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'partial' },
    ];
    renderChat();
    fireEvent.click(screen.getByTestId('chat-stop'));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('is absent when nothing is streaming', () => {
    messages = [{ role: 'user', content: 'a' }];
    renderChat();
    expect(screen.queryByTestId('chat-stop')).toBeNull();
  });

  it('does not offer a plan while the reply is still arriving', () => {
    // Half an answer is not something to turn into planner changes.
    isLoading = true;
    messages = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'half an ans' },
    ];
    renderChat();
    expect(screen.queryByTestId(PLAN_BUTTON)).toBeNull();
  });
});
