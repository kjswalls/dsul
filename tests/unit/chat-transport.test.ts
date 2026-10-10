import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The chat transport, on the gate.
 *
 * `send` asks the gate (lib/ai-connection-store.ts) who can answer at the
 * moment of sending, and nothing else: no key, model, provider or system
 * prompt rides in a body any more, because all four live server-side. These
 * cases pin what a body may carry, what reaches the transcript when nothing
 * can answer (nothing), how a refusal reads (a CODE, its words in
 * lib/chat-errors.ts), and the plugin path's lazy, per-account cache of its
 * URL and key.
 *
 * The conversations API is a fake (configureConversations), so the only
 * fetches here are the transport's own: `calls.map(c => c.url)` is exactly
 * what a turn costs on the wire.
 */

vi.mock('@/lib/planner-store', () => ({
  usePlannerStore: {
    getState: () => ({
      items: [],
      projects: [],
      itemTypes: [{ labelPlural: 'Errands' }],
      routines: [],
      seasons: [],
      goals: [],
      userTimezone: 'UTC',
    }),
  },
}));

const plannerContext = vi.hoisted(() => ({ text: '## dsul Context' }));
vi.mock('@/lib/ai-context', () => ({ buildDsulContext: () => plannerContext.text }));

import {
  clearChatState,
  configureConversations,
  conversationsSettled,
  useConversationsStore,
  type ChatMessage,
} from '@/lib/conversations-store';
import { chatTransport, outgoingTurns, pluginSessionKey, resetPluginTransport } from '@/lib/chat-transport';
import { chatErrorCopy } from '@/lib/chat-errors';
import { useAIConnectionStore } from '@/lib/ai-connection-store';
import { useAISettingsStore } from '@/lib/ai-settings-store';
import { seedAI, CONNECTED_MODEL, NOTHING_CONNECTED, OPENCLAW_PLUGIN } from './helpers/ai-fixtures';
import { fakeApi, type FakeApi } from './helpers/conversations-fakes';

type Call = { url: string; init: RequestInit };

/** An SSE body made of these frames, then [DONE]. */
function sse(...frames: object[]): ReadableStream<Uint8Array> {
  const text = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

/** A fetch that records every call and answers by URL. */
function stubFetch(route: (url: string, init: RequestInit) => unknown) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return route(url, init);
    })
  );
  return calls;
}

const bodyOf = (c: Call) => JSON.parse(c.init.body as string) as Record<string, unknown>;
const store = () => useConversationsStore.getState();
const messagesOf = (id: string) => store().threads[id]?.messages ?? [];
const last = (id: string) => messagesOf(id).at(-1);
/** What the transcript shows for the last reply: its text, then its error's copy. */
const shown = (id: string) => {
  const m = last(id);
  if (!m) return undefined;
  return m.status === 'error' ? [m.content, chatErrorCopy(m.errorCode, m.answerer)].filter(Boolean).join('\n\n') : m.content;
};

let unseed: () => void = () => {};
let api: FakeApi;
let id: string;

beforeEach(() => {
  plannerContext.text = '## dsul Context';
  api = fakeApi();
  configureConversations({ api: api.api, transport: chatTransport });
  clearChatState();
  resetPluginTransport();
  id = store().newDraft();
});

afterEach(async () => {
  await conversationsSettled();
  unseed();
  unseed = () => {};
  vi.unstubAllGlobals();
});

describe('nothing can answer', () => {
  it.each([
    ['unknown (the gate has not answered)', undefined],
    ['error (the gate read failed)', { phase: 'error' as const }],
    ['nothing connected', NOTHING_CONNECTED],
    ['a failing key', { ...CONNECTED_MODEL, model: { status: 'failing' as const } }],
  ])('%s: send writes nothing and fetches nothing', async (_label, seed) => {
    unseed = seedAI(seed);
    const calls = stubFetch(() => ({ ok: true, body: sse({ content: 'hi' }) }));

    await store().send(id, 'plan my day');

    expect(messagesOf(id)).toEqual([]);
    expect(store().threads[id]?.streaming ?? false).toBe(false);
    expect(calls).toHaveLength(0);
    expect(api.turns).toHaveLength(0);
  });
});

describe('the model path (/api/chat)', () => {
  it('posts exactly the six keys: a target and the conversation, never a key, model or prompt', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    useAISettingsStore.setState({ systemPrompt: 'Keep it short.' });
    const calls = stubFetch(() => ({ ok: true, body: sse({ content: 'Sure.' }) }));

    await store().send(id, '  plan my day  ');

    expect(calls.map((c) => c.url)).toEqual(['/api/chat']);
    const body = bodyOf(calls[0]);
    expect(Object.keys(body).sort()).toEqual(
      ['context', 'conversationId', 'customInstructions', 'messages', 'target', 'typeNouns'].sort()
    );
    expect(body).toMatchObject({
      target: 'model',
      context: '## dsul Context',
      customInstructions: 'Keep it short.',
      typeNouns: ['errands'],
      conversationId: id,
      messages: [{ role: 'user', content: 'plan my day' }],
    });
    expect(JSON.stringify(body)).not.toMatch(/apiKey|"model":|provider|systemPrompt|threadItemId/);
    expect(last(id)).toMatchObject({ content: 'Sure.', status: 'complete', model: 'gpt-4o-mini', answerer: 'model' });
  });

  it('names an item conversation by its own id, never the item or a session key', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    const calls = stubFetch(() => ({ ok: true, body: sse({ content: 'ok' }) }));
    const thread = await store().resolveItemThread('i1');

    await store().send(thread, 'what is next here?');

    expect(bodyOf(calls[0]).conversationId).toBe(thread);
    expect(JSON.stringify(bodyOf(calls[0]))).not.toMatch(/"i1"|dsul-item|dsul-chat/);
  });

  it('sends an OpenClaw gateway user through /api/chat with target openclaw', async () => {
    unseed = seedAI({ ...OPENCLAW_PLUGIN, openclaw: { gateway: true, agent: true } });
    const calls = stubFetch(() => ({ ok: true, body: sse({ content: 'ok' }) }));

    await store().send(id, 'hello');

    expect(calls.map((c) => c.url)).toEqual(['/api/chat']);
    expect(bodyOf(calls[0]).target).toBe('openclaw');
    expect(last(id)).toMatchObject({ answerer: 'openclaw', model: null });
  });

  it('trims the outgoing transcript to the newest 40 turns, and keeps the stored history', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    const history: ChatMessage[] = Array.from({ length: 50 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn ${i}`,
      status: 'complete',
      errorCode: null,
      replyTo: i % 2 === 0 ? null : `m${i - 1}`,
      answerer: i % 2 === 0 ? null : 'model',
      model: null,
      createdAt: Date.now(),
      pos: i + 1,
      sync: 'saved',
    }));
    useConversationsStore.setState((s) => ({ threads: { ...s.threads, [id]: { ...s.threads[id], saved: true, messages: history } } }));
    const calls = stubFetch(() => ({ ok: true, body: sse({ content: 'ok' }) }));

    await store().send(id, 'the newest');

    const sent = bodyOf(calls[0]).messages as { role: string; content: string }[];
    expect(sent).toHaveLength(40);
    expect(sent.at(-1)).toEqual({ role: 'user', content: 'the newest' });
    expect(sent[0].content).toBe('turn 11');
    // The transcript itself is not trimmed by the request.
    expect(messagesOf(id)).toHaveLength(52);
  });

  it('clips the paste once, for every copy, and the context to the route limit', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    // A heavy account's planner context, past the server's 60k clip.
    plannerContext.text = 'c'.repeat(200_000);
    const calls = stubFetch((url) =>
      url === '/api/chat' ? { ok: true, body: sse({ content: 'ok' }) } : new Promise(() => {})
    );

    await store().send(id, 'x'.repeat(2_100_000));
    await store().send(id, 'hi');

    const MAX_BODY_BYTES = 2_000_000; // app/api/chat/route.ts
    const chats = calls.filter((c) => c.url === '/api/chat');
    expect(chats).toHaveLength(2);
    for (const c of chats) expect(new TextEncoder().encode(c.init.body as string).length).toBeLessThan(MAX_BODY_BYTES);

    const sent = bodyOf(chats[1]).messages as { role: string; content: string }[];
    expect(sent.map((m) => m.content.length)).toEqual([8_000, 2, 2]);
    expect(sent.at(-1)).toEqual({ role: 'user', content: 'hi' });
    expect(bodyOf(chats[1]).context).toHaveLength(60_000);
    // The transcript holds what was sent and saved, not more.
    expect(messagesOf(id)[0].content).toHaveLength(8_000);
  });

  it('keeps the code of a refusal, not its words, and tells the gate why', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    const calls = stubFetch((url) =>
      url === '/api/chat'
        ? {
            ok: false,
            status: 502,
            json: async () => ({ error: 'Your provider rejected the key.', code: 'auth' }),
          }
        : new Promise(() => {}) // the gate's re-check, left in flight
    );

    await store().send(id, 'hello');

    expect(last(id)).toMatchObject({ role: 'assistant', status: 'error', errorCode: 'auth', content: '' });
    expect(shown(id)).toBe('Your AI key stopped working. Reconnect it in Settings.');
    // noteCallFailure('auth'): the key reads as failing at once, and the gate re-asks.
    expect(useAIConnectionStore.getState().model?.status).toBe('failing');
    expect(calls.map((c) => c.url)).toContain('/api/ai/connection');
    expect(store().threads[id].streaming).toBe(false);
  });

  it('falls back to the generic code when a refusal has no body', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    stubFetch(() => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    }));

    await store().send(id, 'hello');

    expect(last(id)).toMatchObject({ status: 'error', errorCode: 'client' });
    expect(shown(id)).toBe('Something went wrong. Try again.');
  });

  it('an error frame in an empty reply is the error, and the gate hears it', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    const calls = stubFetch((url) =>
      url === '/api/chat'
        ? { ok: true, body: sse({ error: 'Connect a model in Settings to chat.', code: 'not_connected' }) }
        : new Promise(() => {})
    );

    await store().send(id, 'hello');

    expect(messagesOf(id).map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(last(id)).toMatchObject({ status: 'error', errorCode: 'not_connected', content: '' });
    expect(shown(id)).toBe('Connect a model in Settings to chat.');
    expect(calls.map((c) => c.url)).toContain('/api/ai/connection');
  });

  it('keeps text that arrived before an error frame, and stops reading after it', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    stubFetch(() => ({
      ok: true,
      body: sse(
        { content: 'Here is the start' },
        { error: 'The model took too long to answer.', code: 'timeout' },
        { content: ' and something after' }
      ),
    }));

    await store().send(id, 'hello');

    expect(last(id)).toMatchObject({ content: 'Here is the start', status: 'error', errorCode: 'timeout' });
    expect(shown(id)).toBe('Here is the start\n\nYour provider took too long to answer. Try again.');
  });

  it('a stream that closes with nothing in it is no response', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    stubFetch(() => ({ ok: true, body: sse() }));
    await store().send(id, 'hello');
    expect(last(id)).toMatchObject({ status: 'error', errorCode: 'no_response' });
  });
});

describe('the plugin path (OpenClaw with no gateway)', () => {
  const pluginRoute = (url: string) =>
    url === '/api/agent/chat-url'
      ? {
          ok: true,
          json: async () => ({
            chatUrl: 'https://claw.example/plugins/dsul/chat',
            agentId: 'kirby-1',
            chatToken: 'dsulchat_plugin-token',
          }),
        }
      : { ok: true, json: async () => ({ content: 'From OpenClaw.' }) };

  it('posts exactly {message, sessionKey, context} to the plugin, with the bearer', async () => {
    unseed = seedAI(OPENCLAW_PLUGIN);
    const calls = stubFetch(pluginRoute);

    await store().send(id, '  how am I doing  ');

    expect(calls.map((c) => c.url)).toEqual(['/api/agent/chat-url', 'https://claw.example/plugins/dsul/chat']);
    const post = calls[1];
    expect(bodyOf(post)).toEqual({
      message: 'how am I doing',
      sessionKey: `dsul-chat-${id}`,
      context: '## dsul Context',
    });
    expect(pluginSessionKey(id)).toBe(`dsul-chat-${id}`);
    expect((post.init.headers as Record<string, string>).Authorization).toBe('Bearer dsulchat_plugin-token');
    expect(last(id)).toMatchObject({ content: 'From OpenClaw.', answerer: 'openclaw', model: null });
  });

  it('sends the message already clipped to the user cap', async () => {
    unseed = seedAI(OPENCLAW_PLUGIN);
    const calls = stubFetch(pluginRoute);
    await store().send(id, 'z'.repeat(9_000));
    expect((bodyOf(calls[1]).message as string).length).toBe(8_000);
  });

  it("puts the user's own instructions in the context, not a new field", async () => {
    unseed = seedAI(OPENCLAW_PLUGIN);
    useAISettingsStore.setState({ systemPrompt: '  Call me Kirby.  ' });
    const calls = stubFetch(pluginRoute);

    await store().send(id, 'hi');

    const body = bodyOf(calls[1]);
    expect(Object.keys(body).sort()).toEqual(['context', 'message', 'sessionKey']);
    expect(body.context).toBe("## dsul Context\n\n## The user's own instructions\nCall me Kirby.");
  });

  it('reads the chat URL once per account, shared by every conversation', async () => {
    unseed = seedAI(OPENCLAW_PLUGIN);
    const calls = stubFetch(pluginRoute);
    const other = await store().resolveItemThread('i1');

    await store().send(id, 'one');
    await store().send(id, 'two');
    await store().send(other, 'three');
    expect(calls.filter((c) => c.url === '/api/agent/chat-url')).toHaveLength(1);
    // One OpenClaw session per conversation.
    const keys = calls.filter((c) => c.url !== '/api/agent/chat-url').map((c) => bodyOf(c).sessionKey);
    expect(keys).toEqual([`dsul-chat-${id}`, `dsul-chat-${id}`, `dsul-chat-${other}`]);

    // Another account on this browser never reuses the last one's key.
    useAIConnectionStore.setState({ hydratedUserId: 'someone-else' });
    await store().send(store().newDraft(), 'four');
    expect(calls.filter((c) => c.url === '/api/agent/chat-url')).toHaveLength(2);
  });

  it('does not cache a failed read', async () => {
    unseed = seedAI(OPENCLAW_PLUGIN);
    let fail = true;
    const calls = stubFetch((url) =>
      url === '/api/agent/chat-url' && fail ? { ok: false, status: 500, json: async () => ({}) } : pluginRoute(url)
    );

    await store().send(id, 'one');
    // The gate already knows a chat URL is registered, so a failed READ is
    // "can't reach", never the setup instructions.
    expect(last(id)).toMatchObject({ status: 'error', errorCode: 'plugin_unreachable' });
    expect(shown(id)).toBe("Couldn't reach OpenClaw. Check that it is running.");
    expect(store().threads[id].streaming).toBe(false);

    fail = false;
    await store().send(id, 'two');
    expect(calls.filter((c) => c.url === '/api/agent/chat-url')).toHaveLength(2);
    expect(last(id)).toMatchObject({ content: 'From OpenClaw.', status: 'complete' });
  });

  it('shows the setup copy only for a read that succeeds with no URL, and re-reads next time', async () => {
    unseed = seedAI(OPENCLAW_PLUGIN);
    let registered = false;
    const calls = stubFetch((url) =>
      url === '/api/agent/chat-url' && !registered
        ? { ok: true, json: async () => ({ chatUrl: null, agentId: null, chatToken: 'dsulchat_plugin-token' }) }
        : pluginRoute(url)
    );

    await store().send(id, 'one');
    expect(last(id)).toMatchObject({ errorCode: 'plugin_setup' });
    expect(shown(id)).toBe(
      "OpenClaw isn't reachable yet. Run `openclaw dsul-context setup` and set publicUrl in openclaw.json."
    );
    expect(calls.map((c) => c.url)).toEqual(['/api/agent/chat-url']);

    registered = true;
    await store().send(id, 'two');
    expect(calls.filter((c) => c.url === '/api/agent/chat-url')).toHaveLength(2);
    expect(last(id)).toMatchObject({ content: 'From OpenClaw.' });
  });

  it('a stop during the URL read leaves no bubble behind, even when the read then fails', async () => {
    unseed = seedAI(OPENCLAW_PLUGIN);
    let failRead: (e: Error) => void = () => {};
    stubFetch((url) =>
      url === '/api/agent/chat-url'
        ? new Promise((_, reject) => {
            failRead = reject;
          })
        : pluginRoute(url)
    );

    const sending = store().send(id, 'one');
    await Promise.resolve();
    store().stop(id);
    failRead(new TypeError('Failed to fetch'));
    await sending;

    expect(messagesOf(id).map((m) => m.role)).toEqual(['user']);
    expect(store().threads[id].streaming).toBe(false);
  });

  it("says what to check when the plugin can't be reached, never the browser's error", async () => {
    unseed = seedAI(OPENCLAW_PLUGIN);
    stubFetch((url) => {
      if (url === '/api/agent/chat-url') return pluginRoute(url);
      throw new TypeError('Failed to fetch: ECONNREFUSED 10.0.0.5');
    });

    await store().send(id, 'hi');

    expect(shown(id)).toBe("Couldn't reach OpenClaw. Check that it is running.");
    expect(JSON.stringify(store().threads[id])).not.toContain('ECONNREFUSED');
    expect(store().threads[id].streaming).toBe(false);
  });

  it("never keeps the plugin's own error text", async () => {
    unseed = seedAI(OPENCLAW_PLUGIN);
    stubFetch((url) =>
      url === '/api/agent/chat-url' ? pluginRoute(url) : { ok: true, json: async () => ({ error: 'agent kirby-1 crashed at /srv' }) }
    );
    await store().send(id, 'hi');
    expect(last(id)).toMatchObject({ errorCode: 'plugin_error', content: '' });
    expect(JSON.stringify(store().threads[id])).not.toContain('/srv');
  });

  it('never touches /api/chat or the old readiness endpoints', async () => {
    unseed = seedAI(OPENCLAW_PLUGIN);
    const calls = stubFetch(pluginRoute);

    await store().send(id, 'hi');

    const urls = calls.map((c) => c.url);
    expect(urls).not.toContain('/api/chat');
    expect(urls).not.toContain('/api/agent/gateway');
  });
});

describe('outgoingTurns', () => {
  const m = (id: string, role: 'user' | 'assistant', content: string, status = 'complete', replyTo: string | null = null) => ({
    id,
    role,
    content,
    status,
    replyTo,
  });

  it('drops a failed exchange whole, and an empty or streaming reply', () => {
    expect(
      outgoingTurns([
        m('u1', 'user', 'one'),
        m('a1', 'assistant', '', 'error', 'u1'),
        m('u2', 'user', 'two'),
        m('a2', 'assistant', 'partial', 'error', 'u2'),
        m('u3', 'user', 'three'),
        m('a3', 'assistant', '', 'stopped', 'u3'),
        m('u4', 'user', 'four'),
        m('a4', 'assistant', 'yes', 'complete', 'u4'),
        m('u5', 'user', 'five'),
        m('a5', 'assistant', 'typing…', 'streaming', 'u5'),
      ])
    ).toEqual([
      { role: 'user', content: 'four' },
      { role: 'assistant', content: 'yes' },
      { role: 'user', content: 'five' },
    ]);
  });

  it('keeps strict alternation, and never starts on a reply', () => {
    expect(
      outgoingTurns([
        m('a0', 'assistant', 'orphan'),
        m('u1', 'user', 'first'),
        m('u2', 'user', 'second'),
        m('a2', 'assistant', 'ok', 'complete', 'u2'),
      ])
    ).toEqual([
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'ok' },
    ]);
  });
});
