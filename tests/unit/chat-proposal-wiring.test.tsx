import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, cleanup } from '@testing-library/react';
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
 * be testing the mock. So is the conversation: the real conversations store,
 * with its HTTP API and its transport faked (configureConversations), and the
 * transcript seeded as a loaded thread.
 *
 * C5 retired the old chat panel (chat-conversation.tsx) with the phone's
 * general conversation, so these run against the view both shells now show a
 * conversation in: Ask's ConversationView over ChatTranscript.
 */

/** OpenClaw through the user's own gateway: chats AND proposes. */
const OPENCLAW_GATEWAY: SeedAI = {
  phase: 'ready',
  available: true,
  model: null,
  openclaw: { gateway: true, agent: true, agentId: 'kirby-1' },
  choice: 'openclaw',
};

const requestProposal = vi.fn();

let proposalStatus = 'idle';
let proposalSurface = 'chat';

vi.mock('@/lib/planner-store', () => {
  const state = {
    items: [],
    projects: [],
    itemTypes: [],
    routines: [],
    seasons: [],
    goals: [],
    userTimezone: 'UTC',
  };
  // A selector hook for the components, and getState for the store's send.
  return { usePlannerStore: Object.assign((sel: (s: unknown) => unknown) => sel(state), { getState: () => state }) };
});

vi.mock('@/lib/ai-context', () => ({ buildDsulContext: () => '## dsul Context' }));

vi.mock('@/lib/proposal-store', () => {
  const state = () => ({
    request: requestProposal,
    status: proposalStatus,
    // Which surface owns the pending request. The chat button disables only
    // for its OWN — a breakdown loading inside an item panel used to grey
    // this out with no spinner visible anywhere on screen.
    lastRequest: { surface: proposalSurface },
    dismiss: vi.fn(),
    // What a ProposalCard mount reads before its idle return.
    proposal: null,
    error: null,
    emptyMessage: null,
    refused: null,
    accept: vi.fn(),
    retry: vi.fn(),
    selection: { proposalId: null, dropped: new Set<number>() },
    toggleDropped: vi.fn(),
  });
  return {
    useProposalStore: Object.assign((sel: (s: unknown) => unknown) => sel(state()), { getState: state }),
  };
});

vi.mock('@/lib/supabase', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }),
}));

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => {} }));

import { ConversationView } from '@/components/ai/ask/conversation-view';
import {
  clearChatState,
  configureConversations,
  conversationsSettled,
  useConversationsStore,
  type ChatMessage,
} from '@/lib/conversations-store';
import { chatTransport } from '@/lib/chat-transport';
import { chatErrorCopy } from '@/lib/chat-errors';
import { buildPlanPrompt } from '@/lib/plan-prompt';
import { useRailStore } from '@/lib/rail-store';
import { useAIConnectionStore } from '@/lib/ai-connection-store';
import { fakeApi, fakeTransport, flush, hangs, type FakeTransport } from './helpers/conversations-fakes';

const PLAN_BUTTON = 'chat-make-plan';
/** The saved conversation every case renders. */
const CONV = '6f1e2d3c-4b5a-4968-8776-655443322110';

let unseed: () => void = () => {};
const seed = (o: SeedAI) => {
  unseed();
  unseed = seedAI(o);
};

let transport: FakeTransport;
let seq = 0;

/** A transcript line as the store holds a saved one. */
function msg(role: 'user' | 'assistant', content: string, o: Partial<ChatMessage> = {}): ChatMessage {
  seq += 1;
  return {
    id: `m-${seq}`,
    role,
    content,
    status: 'complete',
    errorCode: null,
    replyTo: null,
    answerer: role === 'assistant' ? 'model' : null,
    model: null,
    createdAt: 1_759_400_000_000,
    pos: seq,
    sync: 'saved',
    ...o,
  };
}

/** The conversation as the store would hold it after a load (or mid-stream). */
function setThread(messages: ChatMessage[], o: { streaming?: boolean } = {}) {
  useConversationsStore.setState((s) => ({
    threads: {
      ...s.threads,
      [CONV]: {
        id: CONV,
        itemId: null,
        draftTitle: null,
        saved: true,
        messages,
        load: 'loaded',
        hasEarlier: false,
        streaming: !!o.streaming,
        typing: false,
        fetchedAt: Date.now(),
      },
    },
  }));
}

beforeEach(() => {
  requestProposal.mockClear();
  transport = fakeTransport();
  configureConversations({ api: fakeApi().api, transport: transport.transport });
  clearChatState();
  seed(CONNECTED_MODEL);
  proposalStatus = 'idle';
  proposalSurface = 'chat';
});

afterEach(async () => {
  cleanup();
  await conversationsSettled();
  unseed();
  unseed = () => {};
  configureConversations({ transport: chatTransport });
});

const renderChat = () => render(<ConversationView id={CONV} />);

describe('conversation openers', () => {
  it('offers something to say when the transcript is empty', async () => {
    renderChat();
    const openers = await screen.findByTestId('chat-openers');
    expect(openers.querySelectorAll('button').length).toBeGreaterThan(0);
  });

  it('sends the full prompt, not the short chip label, as a new conversation titled with the label', async () => {
    // The chip has to fit a narrow column; the prompt does not, and the
    // difference is most of what makes the answer good.
    renderChat();
    const first = (await screen.findByTestId('chat-openers')).querySelector('button')!;
    const label = first.textContent ?? '';
    fireEvent.click(first);
    await flush();

    expect(transport.inputs).toHaveLength(1);
    const sent = transport.inputs[0].message;
    expect(sent.length).toBeGreaterThan(label.length);
    // Always a fresh conversation (askNew), pushed on the rail and named by
    // the chip, never by its long prompt.
    const id = transport.inputs[0].conversationId;
    expect(id).not.toBe(CONV);
    expect(useRailStore.getState().stacks.desktop.at(-1)).toEqual({ kind: 'conversation', id });
    expect(useConversationsStore.getState().threads[id]?.draftTitle).toBe(label);
    expect(useConversationsStore.getState().threads[id]?.messages[0]?.content).toBe(sent);
  });

  it('disappears once there is a conversation to look at', () => {
    setThread([msg('user', 'hi')]);
    renderChat();
    expect(screen.queryByTestId('chat-openers')).toBeNull();
  });

  it('sends nothing when nothing can answer', async () => {
    // The view mounts only behind the gate (the rail and the Ask tab hide while
    // nothing answers: rail-desktop and ai-gating-mobile-item tests), so this
    // is the floor under that: a chip on screen as the gate closes leads
    // nowhere rather than into a conversation nobody can answer.
    renderChat();
    const first = (await screen.findByTestId('chat-openers')).querySelector('button')!;
    seed(NOTHING_CONNECTED);
    fireEvent.click(first);
    await flush();
    expect(transport.inputs).toHaveLength(0);
    expect(useRailStore.getState().stacks.desktop).toEqual([]);
  });

  it('shows for OpenClaw plugin chat, which can answer but not propose', async () => {
    // An opener is a plain send(), so it needs chat, not a proposal transport.
    // Gating it on proposing stripped the openers from plugin users.
    seed(OPENCLAW_PLUGIN);
    renderChat();
    expect((await screen.findByTestId('chat-openers')).querySelectorAll('button').length).toBeGreaterThan(0);
  });
});

describe('the empty state', () => {
  it('invites a question when a model answers, and never asks for a key', () => {
    renderChat();
    expect(screen.getByText('How can I help?')).toBeInTheDocument();
    expect(screen.queryByText(/API key/i)).toBeNull();
    expect(screen.getByPlaceholderText('Ask anything…')).toBeInTheDocument();
  });

  it('names OpenClaw in the box when OpenClaw answers', () => {
    seed(OPENCLAW_PLUGIN);
    renderChat();
    expect(screen.getByText('How can I help?')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Message OpenClaw…')).toBeInTheDocument();
  });
});

describe('turning a conversation into a plan', () => {
  it('offers the plan button under an assistant reply', () => {
    setThread([
      msg('user', 'what should I do about this week?'),
      msg('assistant', 'Push the two writing tasks to Thursday.'),
    ]);
    renderChat();
    expect(screen.getByTestId(PLAN_BUTTON)).toBeTruthy();
  });

  it('offers it once, on the latest reply only', () => {
    setThread([
      msg('user', 'a'),
      msg('assistant', 'first answer'),
      msg('user', 'b'),
      msg('assistant', 'second answer'),
    ]);
    renderChat();
    expect(screen.getAllByTestId(PLAN_BUTTON)).toHaveLength(1);
  });

  it('sends the exchange, not just the question, on this conversation’s own surface', () => {
    // What makes a plan worth proposing usually lives in the reply. A
    // proposer handed only the question has to re-derive the answer and will
    // land somewhere else.
    const messages = [
      msg('user', 'what should I do about this week?'),
      msg('assistant', 'Push the two writing tasks to Thursday.'),
    ];
    setThread(messages);
    renderChat();
    fireEvent.click(screen.getByTestId(PLAN_BUTTON));

    expect(requestProposal).toHaveBeenCalledTimes(1);
    const [intent, prompt, itemId, o] = requestProposal.mock.calls[0];
    expect(intent).toBe('ask');
    expect(prompt).toContain('what should I do about this week?');
    expect(prompt).toContain('Push the two writing tasks to Thursday.');
    expect(prompt).toBe(buildPlanPrompt(messages, messages[1].id));
    // The card answers on `conv:<id>`, and what it changes counts on this conversation.
    expect(itemId).toBeUndefined();
    expect(o).toEqual({ conversationId: CONV });
  });

  it('reaches back past intervening turns for the question that prompted the reply', () => {
    setThread([
      msg('user', 'the original ask'),
      msg('assistant', 'an answer'),
      msg('assistant', 'a follow-up thought'),
    ]);
    renderChat();
    fireEvent.click(screen.getByTestId(PLAN_BUTTON));
    expect(requestProposal.mock.calls[0][1]).toContain('the original ask');
  });

  it('is absent under a user message', () => {
    setThread([msg('user', 'hi')]);
    renderChat();
    expect(screen.queryByTestId(PLAN_BUTTON)).toBeNull();
  });

  it('is absent when nothing can propose', () => {
    // resolveAICapabilities is the single question. A button that silently does
    // nothing is worse than no button (lib/ai-registry.ts).
    seed(NOTHING_CONNECTED);
    setThread([msg('user', 'a'), msg('assistant', 'b')]);
    renderChat();
    expect(screen.queryByTestId(PLAN_BUTTON)).toBeNull();
  });

  it('is absent on OpenClaw plugin chat, which has no proposal transport', () => {
    // The propose route never reroutes an OpenClaw user's planner to a model
    // they did not pick, and the plugin path cannot carry a proposal.
    seed(OPENCLAW_PLUGIN);
    setThread([msg('user', 'a'), msg('assistant', 'b')]);
    renderChat();
    expect(screen.queryByTestId(PLAN_BUTTON)).toBeNull();
  });

  it('is offered on the agent tier, which proposes through the user own gateway', () => {
    seed(OPENCLAW_GATEWAY);
    setThread([msg('user', 'a'), msg('assistant', 'b', { answerer: 'openclaw' })]);
    renderChat();
    expect(screen.getByTestId(PLAN_BUTTON)).toBeTruthy();
  });

  it('will not fire a second request while one is in flight', () => {
    // Each click costs a model call. The card says "Thinking it through…", but
    // that is above the transcript and easy to miss from down here.
    proposalStatus = 'loading';
    proposalSurface = `conv:${CONV}`;
    setThread([msg('user', 'a'), msg('assistant', 'b')]);
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
    for (const surface of ['item:abc', 'chat', 'conv:another-conversation']) {
      proposalSurface = surface;
      setThread([msg('user', 'a'), msg('assistant', 'b')]);
      renderChat();
      expect((screen.getByTestId(PLAN_BUTTON) as HTMLButtonElement).disabled).toBe(false);
      cleanup();
    }
  });

  it('clips a long reply from the front, keeping the conclusion', () => {
    // The whole planner already travels with the request; an unbounded reply on
    // top of it is what starts pushing the item list out of the prompt.
    const long = 'x'.repeat(5000) + 'THE ACTUAL CONCLUSION';
    setThread([msg('user', 'the ask'), msg('assistant', long)]);
    renderChat();
    fireEvent.click(screen.getByTestId(PLAN_BUTTON));

    const prompt = requestProposal.mock.calls[0][1] as string;
    expect(prompt).toContain('THE ACTUAL CONCLUSION');
    expect(prompt).toContain('the ask');
    expect(prompt.length).toBeLessThan(long.length);
  });

  it('is absent while a reply is still empty', () => {
    setThread([msg('user', 'a'), msg('assistant', '', { status: 'streaming', sync: 'pending', pos: null })], {
      streaming: true,
    });
    renderChat();
    expect(screen.queryByTestId(PLAN_BUTTON)).toBeNull();
  });

  it('is absent under a failed reply, whose words are ours and never a model’s', () => {
    // Error copy is not content: it is never handed back to a model, here
    // as a plan's "You answered:" or anywhere else.
    setThread([msg('user', 'a'), msg('assistant', 'Half', { status: 'error', errorCode: 'rate_limit' })]);
    renderChat();
    expect(screen.queryByTestId(PLAN_BUTTON)).toBeNull();
  });
});

describe('how a saved turn reads', () => {
  it('a failed reply shows what arrived, then our words for its code', () => {
    setThread([msg('user', 'a'), msg('assistant', 'Half an answer', { status: 'error', errorCode: 'rate_limit' })]);
    renderChat();
    expect(screen.getByText('Half an answer')).toBeInTheDocument();
    expect(screen.getByTestId('chat-error-note').textContent).toBe(chatErrorCopy('rate_limit', 'model'));
  });

  it("a daily limit says when it lifts, on the planner's clock, while the connection says one holds", () => {
    seed({ ...CONNECTED_MODEL, model: { ...CONNECTED_MODEL.model, limitedUntil: '2099-01-01T07:00:00.000Z' } });
    setThread([msg('user', 'a'), msg('assistant', '', { status: 'error', errorCode: 'daily_limit' })]);
    renderChat();
    // The planner's zone here is UTC, its format the 12-hour default.
    expect(screen.getByTestId('chat-error-note').textContent).toBe(
      "That's today's free limit. AI is back when it resets at 7 am."
    );

    // The limit lifted (the next status read carries none): the line keeps no stale time.
    act(() =>
      useAIConnectionStore.setState((st) => ({ model: st.model ? { ...st.model, limitedUntil: null } : null }))
    );
    expect(screen.getByTestId('chat-error-note').textContent).toBe(chatErrorCopy('daily_limit', 'model'));
  });

  it('a daily limit with no time to give is the time-free line', () => {
    setThread([msg('user', 'a'), msg('assistant', '', { status: 'error', errorCode: 'daily_limit' })]);
    renderChat();
    expect(screen.getByTestId('chat-error-note').textContent).toBe(
      "That's today's free limit. AI is back when it resets."
    );
  });

  it('a failed reply with nothing in it is only the note, worded for who was asked', () => {
    setThread([
      msg('user', 'a'),
      msg('assistant', '', { status: 'error', errorCode: 'not_connected', answerer: 'openclaw' }),
    ]);
    renderChat();
    expect(screen.getByTestId('chat-error-note').textContent).toBe(
      'Connect your OpenClaw gateway in Settings to chat.'
    );
  });

  it('a turn the account will never hold says "Not saved", once', () => {
    const q = msg('user', 'a', { sync: 'unsaved', pos: null });
    setThread([q, msg('assistant', 'b', { sync: 'unsaved', pos: null, replyTo: q.id })]);
    renderChat();
    expect(screen.getAllByTestId('chat-not-saved')).toHaveLength(1);
    expect(screen.getByText('Not saved')).toBeInTheDocument();
  });

  it('a question stopped before any reply carries the line itself', () => {
    setThread([msg('user', 'a', { sync: 'unsaved', pos: null })]);
    renderChat();
    expect(screen.getAllByTestId('chat-not-saved')).toHaveLength(1);
  });

  it('a saved or still-saving turn says nothing about it', () => {
    const q = msg('user', 'a', { sync: 'pending', pos: null });
    setThread([msg('user', 'old'), msg('assistant', 'older'), q, msg('assistant', 'b', { sync: 'pending', replyTo: q.id })]);
    renderChat();
    expect(screen.queryByTestId('chat-not-saved')).toBeNull();
  });
});

describe('interrupting a reply', () => {
  /**
   * The store could always abort, and a stopped turn ends either way — there
   * was simply no way to ask. The send button is disabled while streaming, so
   * this occupies a dead slot.
   */
  it('offers a stop button while a reply is streaming, and it stops THIS conversation', async () => {
    const turn = hangs('partial');
    transport.next = turn.run;
    // A new chat: its box is the one the first turn is sent from.
    renderChat();
    const input = screen.getByPlaceholderText('Ask anything…');
    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await flush();

    fireEvent.click(screen.getByTestId('chat-stop'));
    await flush();

    const messages = useConversationsStore.getState().threads[CONV]!.messages;
    expect(messages.map((m) => [m.content, m.status])).toEqual([
      ['a', 'complete'],
      ['partial', 'stopped'],
    ]);
    expect(screen.queryByTestId('chat-stop')).toBeNull();
  });

  it('is absent when nothing is streaming', () => {
    setThread([msg('user', 'a')]);
    renderChat();
    expect(screen.queryByTestId('chat-stop')).toBeNull();
  });

  it('does not offer a plan while the reply is still arriving', () => {
    // Half an answer is not something to turn into planner changes.
    setThread([msg('user', 'a'), msg('assistant', 'half an ans', { status: 'streaming', sync: 'pending', pos: null })], {
      streaming: true,
    });
    renderChat();
    expect(screen.queryByTestId(PLAN_BUTTON)).toBeNull();
  });
});
