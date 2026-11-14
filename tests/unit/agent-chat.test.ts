import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Talking to an agent from Ask (memory/plans/agent-chat.md, step 2): the To
 * pick (lib/ask-to-store.ts), the send that saves the question and then hands
 * it to the agent's inbox (lib/agent-chat.ts, conversations-store
 * `sendToAgent`), and the answers saved back into the conversation as the
 * agent's replies (`landAgentReply`, `deliverAgentReplies`).
 */

vi.mock('@/lib/ai-context', () => ({
  buildDsulContextParts: () => ({ today: '## dsul Context', beyond: '' }),
}));

import { configureConversations, conversationsSettled, clearChatState, useConversationsStore } from '@/lib/conversations-store';
import { sendFrom } from '@/lib/open-chat';
import { askToFor, useAskToStore } from '@/lib/ask-to-store';
import { deliverAgentReplies, syncConversation } from '@/lib/agent-chat';
import { usePlannerStore } from '@/lib/planner-store';
import { CONNECTED_MODEL, SEED_USER_ID, seedAI } from './helpers/ai-fixtures';
import { fakeApi, fakeTransport, flush, summary, type FakeApi, type FakeTransport } from './helpers/conversations-fakes';

let api: FakeApi;
let tx: FakeTransport;
let unseed: () => void = () => {};
let posts: { url: string; body: unknown }[];
let inbox: Record<string, unknown>[];
let sendOk: boolean;

beforeEach(() => {
  api = fakeApi();
  tx = fakeTransport();
  configureConversations({ api: api.api, transport: tx.transport });
  clearChatState();
  unseed = seedAI(CONNECTED_MODEL);
  usePlannerStore.setState({ userId: SEED_USER_ID, isLoading: false, error: null });
  useConversationsStore.setState({ saving: 'on' });
  posts = [];
  inbox = [];
  sendOk = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      posts.push({ url, body });
      // As the route: `pending=1` is answered and not yet delivered.
      if (url === '/api/ai/agent-messages?pending=1')
        return Response.json({ messages: inbox.filter((m) => m.status === 'answered' && !m.delivered) });
      if (url.startsWith('/api/ai/agent-messages?')) return Response.json({ messages: inbox });
      if (url === '/api/ai/agent-messages') return sendOk ? Response.json({ message: {}, woken: true }) : new Response('{}', { status: 503 });
      if (url === '/api/ai/agent-messages/delivered') return Response.json({ marked: body?.ids?.length ?? 0 });
      return new Response('{}', { status: 404 });
    })
  );
});

afterEach(async () => {
  await conversationsSettled();
  unseed();
  vi.unstubAllGlobals();
  usePlannerStore.setState({ userId: null, items: [] });
});

describe('askToFor', () => {
  it("is home's pick with no conversation, a conversation's own pick, else who it last talked to", () => {
    useAskToStore.getState().setHome('Claude');
    expect(askToFor(null)).toBe('Claude');
    expect(askToFor('c1')).toBeNull();
    const said = [
      { id: 'u1', role: 'user' as const, answerer: null },
      { id: 'r1', role: 'assistant' as const, answerer: 'agent:Claude' },
    ];
    expect(askToFor('c1', said)).toBe('Claude');
    expect(askToFor('c1', [...said, { id: 'r2', role: 'assistant', answerer: 'model' }])).toBeNull();
    useAskToStore.getState().markWaiting('u9', { threadId: 'c2', agent: 'Cursor' });
    expect(askToFor('c2', [{ id: 'u9', role: 'user', answerer: null }])).toBe('Cursor');
    // An explicit "your model" outranks what the transcript suggests.
    useAskToStore.getState().setFor('c1', null);
    expect(askToFor('c1', said)).toBeNull();
  });
});

describe('sending to an agent from Ask home', () => {
  it('saves the question, hands it to the inbox by ids, and never asks the model', async () => {
    useAskToStore.getState().setHome('Claude');
    expect(await sendFrom({ kind: 'home' }, 'Which gym fits Tue/Thu?')).toBe(true);
    await flush();

    expect(tx.inputs).toHaveLength(0);
    expect(api.turns).toHaveLength(1);
    const turn = api.turns[0];
    expect(turn.body.messages).toHaveLength(1);
    expect(turn.body.messages[0]).toMatchObject({ role: 'user', content: 'Which gym fits Tue/Thu?' });
    const send = posts.find((p) => p.url === '/api/ai/agent-messages');
    expect(send?.body).toMatchObject({ conversationId: turn.id, messageId: turn.body.messages[0].id, agent: 'Claude' });
    // Ids only: the server copies the text from the saved message.
    expect(send?.body).not.toHaveProperty('content');
    // The conversation keeps writing to Claude, and the message waits.
    expect(useAskToStore.getState().byThread[turn.id]).toBe('Claude');
    expect(useAskToStore.getState().waiting[turn.body.messages[0].id]).toEqual({ threadId: turn.id, agent: 'Claude' });
  });

  it('marks the message not sent when the inbox refuses it', async () => {
    sendOk = false;
    useAskToStore.getState().setHome('Claude');
    await sendFrom({ kind: 'home' }, 'Hello');
    await flush();
    const id = api.turns[0].body.messages[0].id;
    expect(useAskToStore.getState().unsent[id]).toBe('Claude');
    expect(useAskToStore.getState().waiting[id]).toBeUndefined();
  });

  it('asks the model as before when nothing is picked', async () => {
    await sendFrom({ kind: 'home' }, 'Plan my day');
    await flush();
    expect(tx.inputs).toHaveLength(1);
    expect(posts.some((p) => p.url === '/api/ai/agent-messages')).toBe(false);
  });

  it('writes nothing while saving is off: the agent could not read an unsaved message', () => {
    useConversationsStore.setState({ saving: 'off' });
    const id = useConversationsStore.getState().newDraft();
    expect(useConversationsStore.getState().sendToAgent(id, 'Hi', 'Claude', () => {})).toBe(false);
    expect(useConversationsStore.getState().threads[id].messages).toHaveLength(0);
  });
});

describe('answers coming back', () => {
  const row = (o: Record<string, unknown>) => ({
    id: '11111111-1111-4111-8111-111111111111',
    conversationId: 'c1',
    messageId: 'u1',
    agent: 'Claude',
    status: 'answered',
    reply: 'The first one has a Tue 7pm class.',
    answeredAt: '2026-11-14T10:00:00Z',
    delivered: false,
    createdAt: '2026-11-14T09:59:00Z',
    ...o,
  });

  it('saves an answer into a conversation held here, as the agent, and stamps it delivered', async () => {
    api.rows.set('c1', summary({ id: 'c1', messageCount: 1 }));
    const thread = useConversationsStore.getState().newDraft();
    // Held as saved, with its question.
    useConversationsStore.setState((s) => ({
      threads: {
        ...s.threads,
        c1: {
          ...s.threads[thread],
          id: 'c1',
          saved: true,
          load: 'loaded',
          messages: [
            { id: 'u1', role: 'user', content: 'Which gym?', status: 'complete', errorCode: null, replyTo: null, answerer: null, model: null, createdAt: 1, pos: 1, sync: 'saved' },
          ],
        },
      },
    }));
    useAskToStore.getState().markWaiting('u1', { threadId: 'c1', agent: 'Claude' });
    inbox = [row({})];

    await deliverAgentReplies();
    await flush();

    const reply = useConversationsStore.getState().threads.c1.messages.at(-1);
    expect(reply).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111',
      role: 'assistant',
      replyTo: 'u1',
      answerer: 'agent:Claude',
      content: 'The first one has a Tue 7pm class.',
    });
    expect(api.turns.at(-1)?.body.messages[0]).toMatchObject({ id: '11111111-1111-4111-8111-111111111111', role: 'assistant', answerer: 'agent:Claude' });
    expect(posts.find((p) => p.url === '/api/ai/agent-messages/delivered')?.body).toEqual({ ids: ['11111111-1111-4111-8111-111111111111'] });
    expect(useAskToStore.getState().waiting.u1).toBeUndefined();
  });

  it('saves an answer to a conversation this browser does not hold straight into it', async () => {
    api.rows.set('c2', summary({ id: 'c2', messageCount: 1 }));
    inbox = [row({ conversationId: 'c2' })];
    await deliverAgentReplies();
    expect(api.turns).toEqual([
      {
        id: 'c2',
        body: { ownerId: SEED_USER_ID, messages: [expect.objectContaining({ role: 'assistant', replyTo: 'u1', answerer: 'agent:Claude' })] },
      },
    ]);
    expect(useConversationsStore.getState().threads.c2).toBeUndefined();
  });

  it('shows what still waits when a conversation is opened, and leaves it unstamped', async () => {
    inbox = [row({ status: 'waiting', reply: null, answeredAt: null })];
    await syncConversation('c1');
    expect(useAskToStore.getState().waiting.u1).toEqual({ threadId: 'c1', agent: 'Claude' });
    expect(posts.some((p) => p.url === '/api/ai/agent-messages/delivered')).toBe(false);
  });

  it('stops waiting when another device already landed the answer', async () => {
    useAskToStore.getState().markWaiting('u1', { threadId: 'c1', agent: 'Claude' });
    // Not pending any more (delivered elsewhere), so only the conversation's own read finds it.
    inbox = [row({ delivered: true })];
    await deliverAgentReplies();
    expect(useAskToStore.getState().waiting.u1).toBeUndefined();
    expect(posts.some((p) => p.url === '/api/ai/agent-messages?conversationId=c1')).toBe(true);
  });
});
