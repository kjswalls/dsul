import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The transcript wipe fires only when a PERSON changes who answers.
 *
 * It used to be a store subscriber on the stored choice, so it also fired when
 * the persisted settings REHYDRATED, when a reset ran, and on any raw
 * `setState`, each time wiping a transcript nobody asked to lose. Now the one
 * road is `chooseChatTarget` (lib/chat-target.ts), and these cases hold every
 * other road shut, and that one open: global and item threads, in memory and
 * on disk, plus the cached plugin transport.
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

import { useChatStore, itemChatStore, resetPluginTransport } from '@/lib/chat-store';
import { chooseChatTarget } from '@/lib/chat-target';
import { useAISettingsStore } from '@/lib/ai-settings-store';
import { seedAI, OPENCLAW_PLUGIN } from './helpers/ai-fixtures';

const GLOBAL_KEY = 'dsul-chat-history';
const OPEN_ITEM_KEY = 'dsul-item-chat-open-1';
/** A thread never opened this session: it exists only on disk. */
const DISK_ONLY_KEY = 'dsul-item-chat-closed-2';

const turn = (content: string) => ({ role: 'user' as const, content, timestamp: 1 });
const onDisk = (messages: unknown[]) => JSON.stringify({ messages, savedAt: Date.now() });

/** Transcripts in memory AND on disk, for the global thread and two item threads. */
function seedTranscripts() {
  useChatStore.setState({ messages: [turn('global')] });
  itemChatStore('open-1').setState({ messages: [turn('item')] });
  localStorage.setItem(GLOBAL_KEY, onDisk([turn('global')]));
  localStorage.setItem(OPEN_ITEM_KEY, onDisk([turn('item')]));
  localStorage.setItem(DISK_ONLY_KEY, onDisk([turn('closed')]));
}

function expectTranscriptsIntact() {
  expect(useChatStore.getState().messages).toHaveLength(1);
  expect(itemChatStore('open-1').getState().messages).toHaveLength(1);
  expect(localStorage.getItem(GLOBAL_KEY)).not.toBeNull();
  expect(localStorage.getItem(OPEN_ITEM_KEY)).not.toBeNull();
  expect(localStorage.getItem(DISK_ONLY_KEY)).not.toBeNull();
}

function expectTranscriptsWiped() {
  expect(useChatStore.getState().messages).toEqual([]);
  expect(itemChatStore('open-1').getState().messages).toEqual([]);
  expect(localStorage.getItem(GLOBAL_KEY)).toBeNull();
  expect(localStorage.getItem(OPEN_ITEM_KEY)).toBeNull();
  expect(localStorage.getItem(DISK_ONLY_KEY)).toBeNull();
}

let unseed: () => void = () => {};

beforeEach(() => {
  localStorage.clear();
  resetPluginTransport();
  useChatStore.setState({ messages: [], isLoading: false });
  itemChatStore('open-1').setState({ messages: [], isLoading: false });
  useAISettingsStore.setState({ chatTarget: 'model' });
});

afterEach(() => {
  unseed();
  unseed = () => {};
  vi.unstubAllGlobals();
});

describe('roads that must NOT wipe', () => {
  it('(a) a rehydrate that brings back a different stored target', async () => {
    seedTranscripts();
    localStorage.setItem(
      'dsul-ai-settings',
      JSON.stringify({
        state: { chatTarget: 'openclaw', assistantName: 'Beacon', systemPrompt: '', legacyNotice: false },
        version: 1,
      })
    );

    await useAISettingsStore.persist.rehydrate();

    expect(useAISettingsStore.getState().chatTarget).toBe('openclaw');
    expectTranscriptsIntact();
  });

  it('(b) a raw setState of the target', () => {
    seedTranscripts();
    useAISettingsStore.setState({ chatTarget: 'none' });
    expectTranscriptsIntact();
  });

  it('(b) clearUserScopedState', () => {
    seedTranscripts();
    useAISettingsStore.setState({ chatTarget: 'openclaw' });
    useAISettingsStore.getState().clearUserScopedState();
    expect(useAISettingsStore.getState().chatTarget).toBe('model');
    expectTranscriptsIntact();
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
              json: async () => ({ chatUrl: 'https://claw.example/chat', agentId: null, dsulApiKey: 'k' }),
            }
          : { ok: true, json: async () => ({ content: 'ok' }) };
      })
    );
    return () => urls.filter((u) => u === '/api/agent/chat-url').length;
  }

  it('(c) wipes the global and item threads, in memory and on disk', () => {
    seedTranscripts();
    chooseChatTarget('openclaw');
    expect(useAISettingsStore.getState().chatTarget).toBe('openclaw');
    expectTranscriptsWiped();
  });

  it('(c) resets the plugin transport cache', async () => {
    unseed = seedAI(OPENCLAW_PLUGIN);
    const chatUrlReads = stubPlugin();

    await useChatStore.getState().send('one');
    await useChatStore.getState().send('two');
    expect(chatUrlReads()).toBe(1);

    // A real change of answerer. With no model connected the effective target
    // is still the plugin, so the next send shows whether the cache survived.
    chooseChatTarget('model');
    await useChatStore.getState().send('three');
    expect(chatUrlReads()).toBe(2);
  });

  it('(d) the same value is a no-op: nothing wiped, cache kept', async () => {
    unseed = seedAI(OPENCLAW_PLUGIN);
    const chatUrlReads = stubPlugin();
    await useChatStore.getState().send('one');
    expect(chatUrlReads()).toBe(1);

    seedTranscripts();
    chooseChatTarget('openclaw');

    expectTranscriptsIntact();
    await useChatStore.getState().send('two');
    expect(chatUrlReads()).toBe(1);
  });
});
