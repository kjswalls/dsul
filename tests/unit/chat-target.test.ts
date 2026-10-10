import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Changing who answers deletes nothing.
 *
 * It used to wipe every transcript (the global thread and every item thread,
 * in memory and on disk). Conversations are the account's now, kept until the
 * user's own Delete, so `chooseChatTarget` (lib/chat-target.ts) only sets the
 * choice, drops the cached plugin transport and takes both Ask stacks home:
 * the next ask is a new conversation with the new answerer, and the old one is
 * still there to continue.
 *
 * It stays the ONE road: rehydrating the stored choice, a raw setState and
 * clearUserScopedState never act at all (they used to wipe transcripts nobody
 * asked to lose, back when a subscriber did this).
 */

vi.mock('@/lib/planner-store', () => ({
  usePlannerStore: {
    getState: () => ({
      items: [],
      projects: [],
      itemTypes: [],
      routines: [],
      seasons: [],
      goals: [],
      userTimezone: 'UTC',
    }),
  },
}));

vi.mock('@/lib/ai-context', () => ({ buildDsulContext: () => '## dsul Context' }));

import { chatTransport, resetPluginTransport } from '@/lib/chat-transport';
import { chooseChatTarget } from '@/lib/chat-target';
import { clearChatState, configureConversations, conversationsSettled, useConversationsStore } from '@/lib/conversations-store';
import { useRailStore } from '@/lib/rail-store';
import { useAISettingsStore } from '@/lib/ai-settings-store';
import { seedAI, CONNECTED_MODEL, OPENCLAW_PLUGIN } from './helpers/ai-fixtures';
import { fakeApi, fakeTransport, flush, type FakeApi } from './helpers/conversations-fakes';

const store = () => useConversationsStore.getState();
const rail = () => useRailStore.getState();

let api: FakeApi;
let unseed: () => void = () => {};

beforeEach(() => {
  api = fakeApi();
  configureConversations({ api: api.api, transport: fakeTransport().transport });
  clearChatState();
  resetPluginTransport();
  useAISettingsStore.setState({ chatTarget: 'model' });
});

afterEach(async () => {
  await conversationsSettled();
  unseed();
  unseed = () => {};
  vi.unstubAllGlobals();
  configureConversations({ transport: chatTransport });
});

/** Two saved conversations, one shown on each surface's stack. */
async function seedConversations() {
  unseed = seedAI(CONNECTED_MODEL);
  const a = store().newDraft();
  const b = store().newDraft();
  await store().send(a, 'first');
  await store().send(b, 'second');
  await conversationsSettled();
  rail().push('desktop', { kind: 'history' });
  rail().push('desktop', { kind: 'conversation', id: a });
  rail().push('phone', { kind: 'conversation', id: b });
  return { a, b };
}

function expectKept(a: string, b: string) {
  expect(api.removes).toEqual([]);
  expect(store().threads[a]?.messages.map((m) => m.content)).toEqual(['first', 'Sure.']);
  expect(store().threads[b]?.messages.map((m) => m.content)).toEqual(['second', 'Sure.']);
  expect(store().summaries[a]).toBeDefined();
  expect(store().summaries[b]).toBeDefined();
}

describe('roads that must NOT act', () => {
  it('(a) a rehydrate that brings back a different stored target', async () => {
    const { a, b } = await seedConversations();
    localStorage.setItem(
      'dsul-ai-settings',
      JSON.stringify({
        state: { chatTarget: 'openclaw', assistantName: 'Beacon', systemPrompt: '', legacyNotice: false },
        version: 1,
      })
    );

    await useAISettingsStore.persist.rehydrate();

    expect(useAISettingsStore.getState().chatTarget).toBe('openclaw');
    expectKept(a, b);
    expect(rail().stacks.desktop).toHaveLength(2);
    expect(rail().stacks.phone).toHaveLength(1);
  });

  it('(b) a raw setState of the target', async () => {
    const { a, b } = await seedConversations();
    useAISettingsStore.setState({ chatTarget: 'none' });
    expectKept(a, b);
    expect(rail().stacks.desktop).toHaveLength(2);
    expect(rail().stacks.phone).toHaveLength(1);
  });

  it('(b) clearUserScopedState', async () => {
    const { a, b } = await seedConversations();
    useAISettingsStore.setState({ chatTarget: 'openclaw' });
    useAISettingsStore.getState().clearUserScopedState();
    expect(useAISettingsStore.getState().chatTarget).toBe('model');
    expectKept(a, b);
    expect(rail().stacks.phone).toHaveLength(1);
  });
});

describe('chooseChatTarget', () => {
  /** A plugin-path fetch that counts the chat-url reads. */
  function stubPlugin() {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return url === '/api/agent/chat-url'
          ? {
              ok: true,
              json: async () => ({ chatUrl: 'https://claw.example/chat', agentId: null, chatToken: 'k' }),
            }
          : { ok: true, json: async () => ({ content: 'ok' }) };
      })
    );
    return () => urls.filter((u) => u === '/api/agent/chat-url').length;
  }

  it('(c) deletes nothing: no API delete, no thread or summary dropped', async () => {
    const { a, b } = await seedConversations();
    chooseChatTarget('openclaw');
    expect(useAISettingsStore.getState().chatTarget).toBe('openclaw');
    await flush();
    expectKept(a, b);
  });

  it('(c) takes both Ask stacks home, so the next ask is a new conversation', async () => {
    await seedConversations();
    chooseChatTarget('openclaw');
    expect(rail().stacks).toEqual({ desktop: [], phone: [] });
  });

  it('(c) resets the plugin transport cache', async () => {
    unseed = seedAI(OPENCLAW_PLUGIN);
    configureConversations({ transport: chatTransport });
    const chatUrlReads = stubPlugin();
    const id = store().newDraft();

    await store().send(id, 'one');
    await store().send(id, 'two');
    expect(chatUrlReads()).toBe(1);

    // A real change of answerer. With no model connected the effective target
    // is still the plugin, so the next send shows whether the cache survived.
    chooseChatTarget('model');
    await store().send(id, 'three');
    expect(chatUrlReads()).toBe(2);
    // ...and the conversation it was said in is still whole.
    expect(store().threads[id]?.messages.map((m) => m.content)).toEqual(['one', 'ok', 'two', 'ok', 'three', 'ok']);
  });

  it('(d) the same value is a no-op: stacks and cache kept', async () => {
    unseed = seedAI(OPENCLAW_PLUGIN);
    configureConversations({ transport: chatTransport });
    const chatUrlReads = stubPlugin();
    const id = store().newDraft();
    await store().send(id, 'one');
    expect(chatUrlReads()).toBe(1);

    rail().push('desktop', { kind: 'conversation', id });
    rail().push('phone', { kind: 'conversation', id });
    chooseChatTarget('openclaw');

    expect(rail().stacks.desktop).toEqual([{ kind: 'conversation', id }]);
    expect(rail().stacks.phone).toEqual([{ kind: 'conversation', id }]);
    await store().send(id, 'two');
    expect(chatUrlReads()).toBe(1);
    expect(api.removes).toEqual([]);
  });
});
