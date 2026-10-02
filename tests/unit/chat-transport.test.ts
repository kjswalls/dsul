import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The chat transport, on the gate.
 *
 * `send` asks the gate (lib/ai-connection-store.ts) who can answer at the
 * moment of sending, and nothing else: no key, model, provider or system
 * prompt rides in a body any more, because all four live server-side. These
 * cases pin what a body may carry, what reaches the transcript when nothing
 * can answer (nothing), how a refusal reads, and the plugin path's lazy,
 * per-account cache of its URL and key.
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

import { createChatStore, resetPluginTransport, type ChatMessage } from '@/lib/chat-store';
import { useAIConnectionStore } from '@/lib/ai-connection-store';
import { useAISettingsStore } from '@/lib/ai-settings-store';
import {
  seedAI,
  CONNECTED_MODEL,
  NOTHING_CONNECTED,
  OPENCLAW_PLUGIN,
} from './helpers/ai-fixtures';

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
const lastContent = (store: ReturnType<typeof createChatStore>) =>
  store.getState().messages.at(-1)?.content;

let unseed: () => void = () => {};
let store: ReturnType<typeof createChatStore>;

beforeEach(() => {
  plannerContext.text = '## dsul Context';
  localStorage.clear();
  resetPluginTransport();
  store = createChatStore({ historyKey: 'test-history', sessionKey: 'test-session' });
});

afterEach(() => {
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

    await store.getState().send('plan my day');

    expect(store.getState().messages).toEqual([]);
    expect(store.getState().isLoading).toBe(false);
    expect(localStorage.getItem('test-history')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('the model path (/api/chat)', () => {
  it('posts exactly the new keys: a target, never a key, model or prompt', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    useAISettingsStore.setState({ systemPrompt: 'Keep it short.' });
    const calls = stubFetch(() => ({ ok: true, body: sse({ content: 'Sure.' }) }));

    await store.getState().send('  plan my day  ');

    expect(calls.map((c) => c.url)).toEqual(['/api/chat']);
    const body = bodyOf(calls[0]);
    expect(Object.keys(body).sort()).toEqual(
      ['context', 'customInstructions', 'messages', 'target', 'threadItemId', 'typeNouns'].sort()
    );
    expect(body).toMatchObject({
      target: 'model',
      context: '## dsul Context',
      customInstructions: 'Keep it short.',
      typeNouns: ['errands'],
      threadItemId: null,
      messages: [{ role: 'user', content: 'plan my day' }],
    });
    expect(JSON.stringify(body)).not.toMatch(/apiKey|"model":|provider|systemPrompt/);
    expect(lastContent(store)).toBe('Sure.');
  });

  it('names the thread on an item thread, never a session key', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    const calls = stubFetch(() => ({ ok: true, body: sse({ content: 'ok' }) }));
    const thread = createChatStore({
      historyKey: 'dsul-item-chat-i1',
      sessionKey: 'dsul-item-i1',
      focusItemId: 'i1',
    });

    await thread.getState().send('what is next here?');

    expect(bodyOf(calls[0]).threadItemId).toBe('i1');
    expect(JSON.stringify(bodyOf(calls[0]))).not.toContain('dsul-item-i1');
  });

  it('sends an OpenClaw gateway user through /api/chat with target openclaw', async () => {
    unseed = seedAI({ ...OPENCLAW_PLUGIN, openclaw: { gateway: true, agent: true } });
    const calls = stubFetch(() => ({ ok: true, body: sse({ content: 'ok' }) }));

    await store.getState().send('hello');

    expect(calls.map((c) => c.url)).toEqual(['/api/chat']);
    expect(bodyOf(calls[0]).target).toBe('openclaw');
  });

  it('trims the outgoing transcript to the newest 40 turns, and keeps the stored history', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    const history: ChatMessage[] = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn ${i}`,
    }));
    store.setState({ messages: history });
    const calls = stubFetch(() => ({ ok: true, body: sse({ content: 'ok' }) }));

    await store.getState().send('the newest');

    const sent = bodyOf(calls[0]).messages as ChatMessage[];
    expect(sent).toHaveLength(40);
    expect(sent.at(-1)).toEqual({ role: 'user', content: 'the newest' });
    expect(sent[0].content).toBe('turn 11');
    // The transcript itself is not trimmed by the request.
    expect(store.getState().messages).toHaveLength(52);
  });

  it('clips each outgoing turn and the context, so one huge paste does not lock the thread', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    // A heavy account's planner context, past the server's 60k clip.
    plannerContext.text = 'c'.repeat(200_000);
    const calls = stubFetch((url) =>
      url === '/api/chat' ? { ok: true, body: sse({ content: 'ok' }) } : new Promise(() => {})
    );

    await store.getState().send('x'.repeat(2_100_000));
    await store.getState().send('hi');

    const MAX_BODY_BYTES = 2_000_000; // app/api/chat/route.ts
    const sizes = calls
      .filter((c) => c.url === '/api/chat')
      .map((c) => new TextEncoder().encode(c.init.body as string).length);
    expect(sizes).toHaveLength(2);
    for (const size of sizes) expect(size).toBeLessThan(MAX_BODY_BYTES);

    const sent = bodyOf(calls.filter((c) => c.url === '/api/chat')[1]).messages as ChatMessage[];
    expect(sent.map((m) => m.content.length)).toEqual([8_000, 2, 2]);
    expect(sent.at(-1)).toEqual({ role: 'user', content: 'hi' });
    expect(bodyOf(calls.filter((c) => c.url === '/api/chat')[1]).context).toHaveLength(60_000);
    // The transcript itself keeps what the user typed.
    expect(store.getState().messages[0].content).toHaveLength(2_100_000);
  });

  it("shows the route's own copy on a refusal and tells the gate why", async () => {
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

    await store.getState().send('hello');

    expect(lastContent(store)).toBe('Your provider rejected the key.');
    // noteCallFailure('auth'): the key reads as failing at once, and the gate re-asks.
    expect(useAIConnectionStore.getState().model?.status).toBe('failing');
    expect(calls.map((c) => c.url)).toContain('/api/ai/connection');
    expect(store.getState().isLoading).toBe(false);
  });

  it('falls back to our own copy when a refusal has no body', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    stubFetch(() => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    }));

    await store.getState().send('hello');

    expect(lastContent(store)).toBe('Something went wrong. Try again.');
  });

  it('puts an error frame in the empty bubble, and tells the gate', async () => {
    unseed = seedAI(CONNECTED_MODEL);
    const calls = stubFetch((url) =>
      url === '/api/chat'
        ? { ok: true, body: sse({ error: 'Connect a model in Settings to chat.', code: 'not_connected' }) }
        : new Promise(() => {})
    );

    await store.getState().send('hello');

    expect(store.getState().messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(lastContent(store)).toBe('Connect a model in Settings to chat.');
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

    await store.getState().send('hello');

    expect(lastContent(store)).toBe('Here is the start\n\nThe model took too long to answer.');
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
            dsulApiKey: 'dsul-plugin-key',
          }),
        }
      : { ok: true, json: async () => ({ content: 'From OpenClaw.' }) };

  it('posts exactly {message, sessionKey, context} to the plugin, with the bearer', async () => {
    unseed = seedAI(OPENCLAW_PLUGIN);
    const calls = stubFetch(pluginRoute);

    await store.getState().send('  how am I doing  ');

    expect(calls.map((c) => c.url)).toEqual([
      '/api/agent/chat-url',
      'https://claw.example/plugins/dsul/chat',
    ]);
    const post = calls[1];
    expect(bodyOf(post)).toEqual({
      message: 'how am I doing',
      sessionKey: 'test-session',
      context: '## dsul Context',
    });
    expect((post.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer dsul-plugin-key'
    );
    expect(lastContent(store)).toBe('From OpenClaw.');
  });

  it("puts the user's own instructions in the context, not a new field", async () => {
    unseed = seedAI(OPENCLAW_PLUGIN);
    useAISettingsStore.setState({ systemPrompt: '  Call me Kirby.  ' });
    const calls = stubFetch(pluginRoute);

    await store.getState().send('hi');

    const body = bodyOf(calls[1]);
    expect(Object.keys(body).sort()).toEqual(['context', 'message', 'sessionKey']);
    expect(body.context).toBe(
      "## dsul Context\n\n## The user's own instructions\nCall me Kirby."
    );
  });

  it('reads the chat URL once per account, shared by every thread', async () => {
    unseed = seedAI(OPENCLAW_PLUGIN);
    const calls = stubFetch(pluginRoute);
    const thread = createChatStore({
      historyKey: 'dsul-item-chat-i1',
      sessionKey: 'dsul-item-i1',
      focusItemId: 'i1',
    });

    await store.getState().send('one');
    await store.getState().send('two');
    await thread.getState().send('three');
    expect(calls.filter((c) => c.url === '/api/agent/chat-url')).toHaveLength(1);

    // Another account on this browser never reuses the last one's key.
    useAIConnectionStore.setState({ hydratedUserId: 'someone-else' });
    await store.getState().send('four');
    expect(calls.filter((c) => c.url === '/api/agent/chat-url')).toHaveLength(2);
  });

  it('does not cache a failed read', async () => {
    unseed = seedAI(OPENCLAW_PLUGIN);
    let fail = true;
    const calls = stubFetch((url) =>
      url === '/api/agent/chat-url' && fail ? { ok: false, status: 500, json: async () => ({}) } : pluginRoute(url)
    );

    await store.getState().send('one');
    // The gate already knows a chat URL is registered, so a failed READ is
    // "can't reach", never the setup instructions.
    expect(lastContent(store)).toBe("Couldn't reach OpenClaw. Check that it is running.");
    expect(store.getState().isLoading).toBe(false);

    fail = false;
    await store.getState().send('two');
    expect(calls.filter((c) => c.url === '/api/agent/chat-url')).toHaveLength(2);
    expect(lastContent(store)).toBe('From OpenClaw.');
  });

  it('shows the setup copy only for a read that succeeds with no URL, and re-reads next time', async () => {
    unseed = seedAI(OPENCLAW_PLUGIN);
    let registered = false;
    const calls = stubFetch((url) =>
      url === '/api/agent/chat-url' && !registered
        ? { ok: true, json: async () => ({ chatUrl: null, agentId: null, dsulApiKey: 'dsul-plugin-key' }) }
        : pluginRoute(url)
    );

    await store.getState().send('one');
    expect(lastContent(store)).toBe(
      "OpenClaw isn't reachable yet. Run `openclaw dsul-context setup` and set publicUrl in openclaw.json."
    );
    expect(calls.map((c) => c.url)).toEqual(['/api/agent/chat-url']);

    registered = true;
    await store.getState().send('two');
    expect(calls.filter((c) => c.url === '/api/agent/chat-url')).toHaveLength(2);
    expect(lastContent(store)).toBe('From OpenClaw.');
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

    const sending = store.getState().send('one');
    await Promise.resolve();
    store.getState().stop();
    failRead(new TypeError('Failed to fetch'));
    await sending;

    expect(store.getState().messages.map((m) => m.role)).toEqual(['user']);
    expect(store.getState().isLoading).toBe(false);
  });

  it("says what to check when the plugin can't be reached, never the browser's error", async () => {
    unseed = seedAI(OPENCLAW_PLUGIN);
    stubFetch((url) => {
      if (url === '/api/agent/chat-url') return pluginRoute(url);
      throw new TypeError('Failed to fetch: ECONNREFUSED 10.0.0.5');
    });

    await store.getState().send('hi');

    expect(lastContent(store)).toBe("Couldn't reach OpenClaw. Check that it is running.");
    expect(lastContent(store)).not.toContain('ECONNREFUSED');
    expect(store.getState().isLoading).toBe(false);
  });

  it('never touches /api/chat or the old readiness endpoints', async () => {
    unseed = seedAI(OPENCLAW_PLUGIN);
    const calls = stubFetch(pluginRoute);

    await store.getState().send('hi');

    const urls = calls.map((c) => c.url);
    expect(urls).not.toContain('/api/chat');
    expect(urls).not.toContain('/api/agent/gateway');
  });
});
