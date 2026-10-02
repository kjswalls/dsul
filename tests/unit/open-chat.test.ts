import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

/**
 * lib/open-chat.ts: the one place that decides where a composer's text goes.
 * C1 form: the old single-thread panels bind to `generalThreadId()`, and the
 * command bar and "Plan my day" send into it.
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

import {
  askFromCommandBar,
  askNew,
  bindingKey,
  generalThreadId,
  resetGeneralThread,
  resolveSendTarget,
  revealChat,
  sendFrom,
  useGeneralThreadId,
} from '@/lib/open-chat';
import {
  clearChatState,
  configureConversations,
  conversationsSettled,
  useConversationsStore,
} from '@/lib/conversations-store';
import { useRailStore } from '@/lib/rail-store';
import { useSidebarStore } from '@/lib/sidebar-store';
import { useMobileNavStore } from '@/lib/mobile-nav-store';
import { CONNECTED_MODEL, NOTHING_CONNECTED, seedAI } from './helpers/ai-fixtures';
import { fakeApi, fakeTransport, flush, hangs, summary, type FakeApi, type FakeTransport } from './helpers/conversations-fakes';

const store = () => useConversationsStore.getState();
const rail = () => useRailStore.getState();

let api: FakeApi;
let tx: FakeTransport;
let unseed: () => void = () => {};

beforeEach(() => {
  api = fakeApi();
  tx = fakeTransport();
  configureConversations({ api: api.api, transport: tx.transport });
  unseed = seedAI(CONNECTED_MODEL);
  clearChatState();
  resetGeneralThread();
  useSidebarStore.getState().setChatExpanded(false);
  useMobileNavStore.getState().setActiveTab('today');
});

afterEach(async () => {
  await conversationsSettled();
  unseed();
  unseed = () => {};
});

describe('revealChat', () => {
  it('opens chat only when something can answer', () => {
    expect(revealChat(false)).toBe(true);
    expect(useSidebarStore.getState().chatExpanded).toBe(true);
    expect(revealChat(true)).toBe(true);
    expect(useMobileNavStore.getState().activeTab).toBe('chat');

    unseed();
    unseed = seedAI(NOTHING_CONNECTED);
    useSidebarStore.getState().setChatExpanded(false);
    expect(revealChat(false)).toBe(false);
    expect(useSidebarStore.getState().chatExpanded).toBe(false);
  });
});

describe('resolveSendTarget', () => {
  it('home: a new draft, pushed, carrying returnTo', async () => {
    const plain = await resolveSendTarget({ kind: 'home' }, 'desktop');
    expect(store().threads[plain.threadId]).toMatchObject({ saved: false, itemId: null });
    expect(plain.push).toEqual({ kind: 'conversation', id: plain.threadId });

    const over = await resolveSendTarget({ kind: 'home' }, 'desktop', { itemId: 'i1' });
    expect(over.threadId).not.toBe(plain.threadId);
    expect(over.push).toEqual({ kind: 'conversation', id: over.threadId, returnTo: { itemId: 'i1' } });
  });

  it('draft and conversation: that id, no push', async () => {
    expect(await resolveSendTarget({ kind: 'draft', id: 'd1' }, 'phone')).toEqual({ threadId: 'd1' });
    expect(await resolveSendTarget({ kind: 'conversation', id: 'c1' }, 'phone')).toEqual({ threadId: 'c1' });
  });

  it("item: the item's one conversation, asked for, no push", async () => {
    const first = await resolveSendTarget({ kind: 'item', itemId: 'i1' }, 'desktop');
    expect(api.api.forItem).toHaveBeenCalledWith('i1');
    expect(first.push).toBeUndefined();
    // The same draft until its first save lands: never a duplicate.
    expect((await resolveSendTarget({ kind: 'item', itemId: 'i1' }, 'desktop')).threadId).toBe(first.threadId);
  });
});

describe('sendFrom', () => {
  it('from home: pushes the new conversation on the surface and sends into it', async () => {
    await sendFrom({ kind: 'home' }, 'what is next?', { surface: 'phone', returnTo: { itemId: 'i1' } });
    await conversationsSettled();
    const top = rail().stacks.phone.at(-1);
    expect(top).toMatchObject({ kind: 'conversation', returnTo: { itemId: 'i1' } });
    expect(rail().stacks.desktop).toEqual([]);
    const id = (top as { id: string }).id;
    expect(tx.inputs[0].conversationId).toBe(id);
    expect(api.turns[0]).toMatchObject({ id, body: { create: { itemId: null, title: 'what is next?' } } });
  });

  it('marks the binding sending at once, so a second send in the same tick is a no-op', async () => {
    const h = hangs('');
    tx.next = h.run;
    const a = sendFrom({ kind: 'item', itemId: 'i1' }, 'one');
    expect(store().sending[bindingKey({ kind: 'item', itemId: 'i1' })]).toBe(true);
    const b = sendFrom({ kind: 'item', itemId: 'i1' }, 'two');
    await b;
    await new Promise((r) => setTimeout(r, 0));
    expect(tx.inputs).toHaveLength(1);
    // The thread's own streaming state has taken over.
    expect(store().sending).toEqual({});
    const id = tx.inputs[0].conversationId;
    expect(store().threads[id].streaming).toBe(true);
    h.release('done');
    await a;
  });

  describe("an item's saved conversation is read before the send", () => {
    /** The server's copy of i1's conversation: one earlier turn, its read held until `release`. */
    function savedItemConversation() {
      let release: () => void = () => {};
      const held = new Promise<void>((r) => {
        release = r;
      });
      api.rows.set('c1', summary({ id: 'c1', itemId: 'i1', messageCount: 2 }));
      api.answer.forItem = () => ({ ok: true, value: summary({ id: 'c1', itemId: 'i1', messageCount: 2 }) });
      api.answer.thread = async (id) => {
        await held;
        const at = (pos: number, role: 'user' | 'assistant', content: string) => ({
          id: `m${pos}`,
          pos,
          role,
          content,
          status: 'complete' as const,
          errorCode: null,
          replyTo: role === 'assistant' ? `m${pos - 1}` : null,
          answerer: role === 'assistant' ? ('model' as const) : null,
          model: role === 'assistant' ? 'gpt-4o-mini' : null,
          createdAt: '2026-10-02T09:00:00.000Z',
        });
        return {
          ok: true,
          value: {
            conversation: summary({ id, itemId: 'i1', messageCount: 2 }),
            messages: [at(1, 'user', 'earlier q'), at(2, 'assistant', 'earlier a')],
            hasEarlier: false,
          },
        };
      };
      return () => release();
    }

    it("joins the read ItemThread's mount started, so the model hears what was said", async () => {
      const release = savedItemConversation();
      // ItemThread's mount: find the item's conversation, then read it.
      void store()
        .resolveItemThread('i1')
        .then((id) => store().openThread(id));
      const sending = sendFrom({ kind: 'item', itemId: 'i1' }, 'new q');
      await flush();
      // Still busy, and nothing sent while the transcript is on its way.
      expect(tx.inputs).toHaveLength(0);
      expect(store().sending['item:i1']).toBe(true);
      expect(api.api.thread).toHaveBeenCalledTimes(1);

      release();
      await sending;
      await conversationsSettled();
      expect(api.api.thread).toHaveBeenCalledTimes(1);
      expect(tx.inputs[0].turns).toEqual([
        { role: 'user', content: 'earlier q' },
        { role: 'assistant', content: 'earlier a' },
        { role: 'user', content: 'new q' },
      ]);
      expect(store().threads.c1.messages.map((m) => m.content)).toEqual(['earlier q', 'earlier a', 'new q', 'Sure.']);
    });

    it('reads it itself when nothing has', async () => {
      const release = savedItemConversation();
      release();
      await sendFrom({ kind: 'item', itemId: 'i1' }, 'new q');
      await conversationsSettled();
      expect(tx.inputs[0].turns.map((t) => t.content)).toEqual(['earlier q', 'earlier a', 'new q']);
    });

    it('never reads a conversation that has no row yet', async () => {
      await sendFrom({ kind: 'conversation', id: generalThreadId() }, 'hello');
      await conversationsSettled();
      expect(api.api.thread).not.toHaveBeenCalled();
      expect(tx.inputs).toHaveLength(1);
    });
  });

  it('with nothing to answer, sends nothing and pushes nothing', async () => {
    unseed();
    unseed = seedAI(NOTHING_CONNECTED);
    await sendFrom({ kind: 'home' }, 'hello', { surface: 'desktop' });
    expect(rail().stacks.desktop).toEqual([]);
    expect(tx.inputs).toHaveLength(0);
    expect(store().sending).toEqual({});
  });
});

describe('generalThreadId (C1–C4)', () => {
  it('is one id until something ends it, and its first send creates it', async () => {
    const id = generalThreadId();
    expect(generalThreadId()).toBe(id);
    // Read without a store write: a render may call it.
    expect(store().threads[id]).toBeUndefined();

    await sendFrom({ kind: 'conversation', id }, 'hello');
    await conversationsSettled();
    expect(api.turns[0]).toMatchObject({ id, body: { create: { itemId: null, title: 'hello' } } });
    expect(generalThreadId()).toBe(id);
  });

  it('is re-minted by a reset (sign-out, account switch), a delete, a 404, and resetGeneralThread', async () => {
    const seen = new Set<string>();
    const next = () => {
      const id = generalThreadId();
      expect(seen.has(id)).toBe(false);
      seen.add(id);
      return id;
    };

    next();
    clearChatState();

    let id = next();
    await sendFrom({ kind: 'conversation', id }, 'one');
    await conversationsSettled();
    await store().remove(id);

    id = next();
    await sendFrom({ kind: 'conversation', id }, 'two');
    await conversationsSettled();
    api.rows.delete(id);
    await sendFrom({ kind: 'conversation', id }, 'three');
    await conversationsSettled();
    expect(store().threads[id].load).toBe('gone');

    // The next send, the 404's "send creates": into the fresh one.
    id = next();
    await sendFrom({ kind: 'conversation', id }, 'four');
    await conversationsSettled();
    expect(api.turns.at(-1)).toMatchObject({ id, body: { create: { title: 'four' } } });

    resetGeneralThread();
    next();
  });

  it('re-renders a reader when it is re-minted', () => {
    const { result } = renderHook(() => useGeneralThreadId());
    const first = result.current;
    expect(first).toBe(generalThreadId());
    act(() => resetGeneralThread());
    expect(result.current).not.toBe(first);
    expect(result.current).toBe(generalThreadId());
  });
});

describe('askNew (C1)', () => {
  it('starts a fresh, titled conversation and makes it the one the panel shows', async () => {
    const before = generalThreadId();
    askNew('Plan my day', { title: 'Plan my day', isMobile: false });
    await new Promise((r) => setTimeout(r, 0));
    await conversationsSettled();

    const id = generalThreadId();
    expect(id).not.toBe(before);
    expect(useSidebarStore.getState().chatExpanded).toBe(true);
    expect(tx.inputs[0]).toMatchObject({ conversationId: id, message: 'Plan my day' });
    expect(api.turns[0].body.create).toEqual({ itemId: null, title: 'Plan my day' });

    askNew('Plan my day', { title: 'Plan my day', isMobile: false });
    expect(generalThreadId()).not.toBe(id);
  });

  it('does nothing with nothing to answer', () => {
    unseed();
    unseed = seedAI(NOTHING_CONNECTED);
    askNew('Plan my day', { title: 'Plan my day', isMobile: false });
    expect(tx.inputs).toHaveLength(0);
    expect(Object.keys(store().threads)).toEqual([]);
  });
});

describe('askFromCommandBar (C1)', () => {
  it('an empty ask only opens chat', () => {
    askFromCommandBar('   ', false);
    expect(useSidebarStore.getState().chatExpanded).toBe(true);
    expect(tx.inputs).toHaveLength(0);
  });

  it('opens chat as today, then sends into the general conversation', async () => {
    askFromCommandBar('how is my week?', true);
    expect(useMobileNavStore.getState().activeTab).toBe('chat');
    await new Promise((r) => setTimeout(r, 0));
    await conversationsSettled();
    expect(tx.inputs[0]).toMatchObject({ conversationId: generalThreadId(), message: 'how is my week?' });
  });

  it('with nothing to answer, opens nothing and sends nothing', () => {
    unseed();
    unseed = seedAI(NOTHING_CONNECTED);
    askFromCommandBar('hello', false);
    expect(useSidebarStore.getState().chatExpanded).toBe(false);
    expect(tx.inputs).toHaveLength(0);
  });
});
