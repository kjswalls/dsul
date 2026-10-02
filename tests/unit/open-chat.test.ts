import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

/**
 * lib/open-chat.ts: the one place that decides where a composer's text goes,
 * and how Ask is opened. C2: Ask lives in the right rail on desktop (revealChat
 * summons it, Ctrl+J toggles it, a fresh conversation is pushed on its stack).
 * The phone's chat tab is still the general conversation until C5.
 * The command bar's routing is tests/unit/command-bar-ask.test.ts.
 */

const planner = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock('@/lib/planner-store', () => ({
  usePlannerStore: {
    getState: () => ({
      items: planner.items,
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
  askNew,
  bindingKey,
  generalThreadId,
  newChat,
  openConversation,
  openHistory,
  resetGeneralThread,
  resolveSendTarget,
  revealChat,
  sendFrom,
  toggleRail,
  useAskHomeShown,
  useChatCardHomeShown,
  useChatCardSurface,
  useChatHostCard,
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
import { registerItemPanelClose, registerItemPanelFlush, useUIStore } from '@/lib/ui-store';
import { useViewStore } from '@/lib/view-store';
import { useProposalStore } from '@/lib/proposal-store';
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
  useSidebarStore.setState({ askOpen: false });
  useMobileNavStore.getState().setActiveTab('today');
  useUIStore.setState({ activeDialog: null, displacedItemId: null });
  useViewStore.setState({ zenOpen: false, zenMoving: false });
  planner.items = [];
});

afterEach(async () => {
  await conversationsSettled();
  unseed();
  unseed = () => {};
});

/** An item in the slot, as a row click leaves it. */
function openItem(id = 'i1') {
  useUIStore.setState({ activeDialog: { type: 'edit-item', item: { id, title: 'Book the dentist' } as never } });
}

describe('revealChat', () => {
  it('summons Ask on desktop: kept open, summoned, and its box asked for', () => {
    expect(revealChat(false)).toBe(true);
    expect(useSidebarStore.getState().askOpen).toBe(true);
    expect(rail().summoned).toBe(true);
    expect(rail().pendingFocus).toEqual({ target: 'composer' });
    expect(useMobileNavStore.getState().activeTab).toBe('today');
  });

  it('opens the chat tab on the phone, and touches no rail', () => {
    expect(revealChat(true)).toBe(true);
    expect(useMobileNavStore.getState().activeTab).toBe('chat');
    expect(useSidebarStore.getState().askOpen).toBe(false);
    expect(rail().summoned).toBe(false);
  });

  it('leaves Zen first: the rail is the desktop shell, which Zen replaces', () => {
    useViewStore.setState({ zenOpen: true });
    revealChat(false);
    expect(useViewStore.getState().zenOpen).toBe(false);
  });

  it('leaves an item on top where it is, with Ask under it', () => {
    openItem();
    revealChat(false);
    expect(useUIStore.getState().activeDialog?.type).toBe('edit-item');
  });

  it('opens nothing when nothing can answer', () => {
    unseed();
    unseed = seedAI(NOTHING_CONNECTED);
    expect(revealChat(false)).toBe(false);
    expect(revealChat(true)).toBe(false);
    expect(useSidebarStore.getState().askOpen).toBe(false);
    expect(rail().summoned).toBe(false);
    expect(useMobileNavStore.getState().activeTab).toBe('today');
  });
});

describe('toggleRail (Ctrl+J)', () => {
  it('opens a hidden rail with its box focused, and closes a shown one', () => {
    toggleRail();
    expect(useSidebarStore.getState().askOpen).toBe(true);
    expect(rail().pendingFocus).toEqual({ target: 'composer' });

    toggleRail();
    expect(useSidebarStore.getState().askOpen).toBe(false);
    expect(rail().summoned).toBe(false);
  });

  it('closes Ask that rests open from a previous session (never summoned in this one)', () => {
    useSidebarStore.setState({ askOpen: true });
    toggleRail();
    expect(useSidebarStore.getState().askOpen).toBe(false);
  });

  it('with an item on top: the one flushing close, then the rail', () => {
    const calls: string[] = [];
    const offFlush = registerItemPanelFlush(() => calls.push('flush'));
    const offClose = registerItemPanelClose(() => {
      calls.push('close');
      useUIStore.getState().closeDialog();
    });
    useSidebarStore.setState({ askOpen: true });
    openItem();
    toggleRail();
    expect(calls).toEqual(['flush', 'close']);
    expect(useUIStore.getState().activeDialog).toBeNull();
    expect(useSidebarStore.getState().askOpen).toBe(false);
    offFlush();
    offClose();
  });

  it('an item open while Ask is closed: Ctrl+J closes the item (the column is showing)', () => {
    openItem();
    toggleRail();
    expect(useUIStore.getState().activeDialog).toBeNull();
    expect(useSidebarStore.getState().askOpen).toBe(false);
  });

  it('in Zen: leaves Zen and opens Ask, whatever the stores say', () => {
    useSidebarStore.setState({ askOpen: true });
    useViewStore.setState({ zenOpen: true });
    toggleRail();
    expect(useViewStore.getState().zenOpen).toBe(false);
    expect(useSidebarStore.getState().askOpen).toBe(true);
    expect(rail().summoned).toBe(true);
  });

  it('is inert with nothing to answer', () => {
    unseed();
    unseed = seedAI(NOTHING_CONNECTED);
    openItem();
    toggleRail();
    expect(useUIStore.getState().activeDialog?.type).toBe('edit-item');
    expect(useSidebarStore.getState().askOpen).toBe(false);
    expect(rail().summoned).toBe(false);
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

  describe("a push hands focus to the new conversation's box", () => {
    function railWithBox() {
      const column = document.createElement('div');
      column.setAttribute('data-rail', '');
      const box = document.createElement('textarea');
      column.appendChild(box);
      const outside = document.createElement('button');
      document.body.append(column, outside);
      return { box, outside, done: () => { column.remove(); outside.remove(); } };
    }
    const pushedId = () => (rail().stacks.desktop.at(-1) as { id: string }).id;

    it('when the box that sent is in the rail', async () => {
      const { box, done } = railWithBox();
      box.focus();
      await sendFrom({ kind: 'home' }, 'hello');
      expect(rail().pendingFocus).toEqual({ target: 'composer', binding: { kind: 'conversation', id: pushedId() } });
      done();
    });

    it('when a summon asked for the box and nothing took it yet', async () => {
      const { outside, done } = railWithBox();
      outside.focus();
      rail().focusComposer();
      await sendFrom({ kind: 'home' }, 'hello');
      expect(rail().pendingFocus).toEqual({ target: 'composer', binding: { kind: 'conversation', id: pushedId() } });
      done();
    });

    it('when asked outright (the command bar), even after a box took the summon', async () => {
      const { outside, done } = railWithBox();
      outside.focus();
      await sendFrom({ kind: 'home' }, 'hello', { focus: true });
      expect(rail().pendingFocus).toEqual({ target: 'composer', binding: { kind: 'conversation', id: pushedId() } });
      done();
    });

    it('never from a control outside the rail that did not ask', async () => {
      const { outside, done } = railWithBox();
      outside.focus();
      await sendFrom({ kind: 'home' }, 'hello');
      expect(rail().pendingFocus).toBeNull();
      done();
    });
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

describe('askNew', () => {
  it('desktop: a fresh, titled conversation, pushed on the rail with its box asked for', async () => {
    const before = generalThreadId();
    askNew('Plan my day', { title: 'Plan my day', isMobile: false });
    const top = rail().stacks.desktop.at(-1) as { kind: string; id: string };
    expect(top.kind).toBe('conversation');
    expect(rail().pendingFocus).toEqual({ target: 'composer', binding: { kind: 'draft', id: top.id } });
    expect(useSidebarStore.getState().askOpen).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    await conversationsSettled();

    expect(tx.inputs[0]).toMatchObject({ conversationId: top.id, message: 'Plan my day' });
    expect(api.turns[0].body.create).toEqual({ itemId: null, title: 'Plan my day' });
    // The rail's conversation, not the phone's general one.
    expect(generalThreadId()).toBe(before);

    // Always fresh: a second ask replaces it at its level.
    askNew('Plan my day', { title: 'Plan my day', isMobile: false });
    const next = rail().stacks.desktop.at(-1) as { id: string };
    expect(next.id).not.toBe(top.id);
    expect(rail().stacks.desktop).toHaveLength(1);
  });

  it('desktop: closes an item on top through the one flushing close, so the answer is seen', () => {
    const calls: string[] = [];
    const off = registerItemPanelFlush(() => calls.push('flush'));
    openItem();
    askNew('Plan my day', { title: 'Plan my day', isMobile: false });
    expect(calls).toEqual(['flush']);
    expect(useUIStore.getState().activeDialog).toBeNull();
    off();
  });

  it('phone (until C5): the fresh conversation becomes the one the chat tab shows', async () => {
    const before = generalThreadId();
    askNew('Plan my day', { title: 'Plan my day', isMobile: true });
    await new Promise((r) => setTimeout(r, 0));
    await conversationsSettled();
    const id = generalThreadId();
    expect(id).not.toBe(before);
    expect(useMobileNavStore.getState().activeTab).toBe('chat');
    expect(rail().stacks).toEqual({ desktop: [], phone: [] });
    expect(tx.inputs[0]).toMatchObject({ conversationId: id, message: 'Plan my day' });
  });

  it('does nothing with nothing to answer', () => {
    unseed();
    unseed = seedAI(NOTHING_CONNECTED);
    askNew('Plan my day', { title: 'Plan my day', isMobile: false });
    expect(tx.inputs).toHaveLength(0);
    expect(Object.keys(store().threads)).toEqual([]);
  });
});

describe("chat's card and where it is hosted", () => {
  function card(surface: string | null, status = 'ready') {
    useProposalStore.setState({
      status: status as never,
      lastRequest: surface === null ? null : ({ intent: 'ask', surface } as never),
    });
  }
  afterEach(() => useProposalStore.setState({ status: 'idle', lastRequest: null }));

  it('the catch-up card and every conversation plan are chat-hosted; an item card never is', () => {
    const host = () => renderHook(() => [useChatHostCard(), useChatCardSurface()] as const).result.current;
    card('chat');
    expect(host()).toEqual([true, 'chat']);
    card('conv:abc');
    expect(host()).toEqual([true, 'conv:abc']);
    card('item:i1');
    expect(host()).toEqual([false, 'chat']);
    // "Nothing left to apply": no request to match, shown once, on 'chat'.
    card(null, 'empty');
    expect(host()).toEqual([true, 'chat']);
    card('conv:abc', 'idle');
    expect(host()[0]).toBe(false);
  });

  describe('desktop', () => {
    it('Ask home is shown while the rail shows Ask with nothing pushed', () => {
      useSidebarStore.setState({ askOpen: true });
      const { result } = renderHook(() => useAskHomeShown('desktop'));
      expect(result.current).toBe(true);
      act(() => rail().push('desktop', { kind: 'history' }));
      expect(result.current).toBe(false);
      act(() => rail().popToHome('desktop'));
      act(() => openItem());
      expect(result.current).toBe(false);
    });

    it("the catch-up card's home is Ask home; a plan's home is its conversation, on top", () => {
      useSidebarStore.setState({ askOpen: true });
      const { result } = renderHook(() => useChatCardHomeShown('desktop'));
      card('chat');
      expect(result.current).toBe(true);

      act(() => card('conv:c1'));
      expect(result.current).toBe(false);
      act(() => rail().push('desktop', { kind: 'conversation', id: 'c1' }));
      expect(result.current).toBe(true);
      // Another conversation on top is not this card's home.
      act(() => rail().push('desktop', { kind: 'conversation', id: 'c2' }));
      expect(result.current).toBe(false);
    });

    it('nothing is ever "home" while the gate is closed, so the dock keeps either card', () => {
      useSidebarStore.setState({ askOpen: true });
      rail().push('desktop', { kind: 'conversation', id: 'c1' });
      card('conv:c1');
      const { result } = renderHook(() => [useChatCardHomeShown('desktop'), useChatHostCard()] as const);
      expect(result.current).toEqual([true, true]);
      act(() => {
        unseed();
        unseed = seedAI(NOTHING_CONNECTED);
      });
      expect(result.current).toEqual([false, true]);
      act(() => card('chat'));
      expect(result.current).toEqual([false, true]);
    });
  });

  describe('phone', () => {
    it('Ask home is the chat tab, at home, while something answers', () => {
      const { result } = renderHook(() => [useAskHomeShown('phone'), useChatCardHomeShown('phone')] as const);
      card('chat');
      expect(result.current).toEqual([false, false]);
      act(() => useMobileNavStore.getState().setActiveTab('chat'));
      expect(result.current).toEqual([true, true]);
      // The shell shows Today for a chat tab that cannot answer: no home then.
      act(() => {
        unseed();
        unseed = seedAI(NOTHING_CONNECTED);
      });
      expect(result.current).toEqual([false, false]);
    });

    it('(until C5) the chat tab carries a conversation plan too', () => {
      useMobileNavStore.getState().setActiveTab('chat');
      card(`conv:${generalThreadId()}`);
      const { result } = renderHook(() => useChatCardHomeShown('phone'));
      expect(result.current).toBe(true);
    });
  });
});

describe('newChat (C4)', () => {
  it("pushes a draft over Ask in place, its box asked for, Back's focus named", () => {
    const id = newChat(false, { returnFocus: 'new-chat' });
    expect(id).not.toBeNull();
    expect(rail().stacks.desktop).toEqual([{ kind: 'conversation', id, returnFocus: 'new-chat' }]);
    expect(rail().pendingFocus).toEqual({ target: 'composer', binding: { kind: 'draft', id } });
    // A draft only: no row, nothing sent, until its first turn.
    expect(store().threads[id as string]).toMatchObject({ saved: false, messages: [] });
    expect(api.turns).toEqual([]);
    // In place: the "+" is on screen, so nothing is revealed.
    expect(rail().summoned).toBe(false);
  });

  it('replaces a conversation at its level, and keeps History beneath', () => {
    rail().push('desktop', { kind: 'history' });
    rail().push('desktop', { kind: 'conversation', id: 'c1' });
    const id = newChat(false);
    expect(rail().stacks.desktop).toEqual([{ kind: 'history' }, { kind: 'conversation', id }]);
  });

  it('from the palette: shows Ask first, closing an item on top through the one flushing close', () => {
    const calls: string[] = [];
    const off = registerItemPanelFlush(() => calls.push('flush'));
    openItem();
    const id = newChat(false, { reveal: true });
    expect(calls).toEqual(['flush']);
    expect(useUIStore.getState().activeDialog).toBeNull();
    expect(useSidebarStore.getState().askOpen).toBe(true);
    expect(rail().summoned).toBe(true);
    expect(rail().pendingFocus).toEqual({ target: 'composer', binding: { kind: 'draft', id } });
    off();
  });

  it('does nothing with nothing to answer', () => {
    unseed();
    unseed = seedAI(NOTHING_CONNECTED);
    expect(newChat(false)).toBeNull();
    expect(newChat(false, { reveal: true })).toBeNull();
    expect(rail().stacks.desktop).toEqual([]);
    expect(store().threads).toEqual({});
  });
});

describe('openHistory (C4)', () => {
  it('pushes History in place, asking for no field', () => {
    openHistory(false, { returnFocus: 'history' });
    expect(rail().stacks.desktop).toEqual([{ kind: 'history', returnFocus: 'history' }]);
    expect(rail().pendingFocus).toBeNull();
  });

  it('replaces a new chat (the level rule), so Back goes home and the draft leaves nothing', () => {
    const id = newChat(false) as string;
    openHistory(false);
    expect(rail().stacks.desktop).toEqual([{ kind: 'history' }]);
    rail().back('desktop');
    expect(rail().stacks.desktop).toEqual([]);
    expect(api.turns).toEqual([]);
    expect(store().summaries[id]).toBeUndefined();
  });

  it('from the palette: shows Ask and asks for the search field, not the box', () => {
    openHistory(false, { reveal: true, focusSearch: true });
    expect(useSidebarStore.getState().askOpen).toBe(true);
    expect(rail().summoned).toBe(true);
    expect(rail().pendingFocus).toEqual({ target: 'history-search' });
    expect(rail().stacks.desktop).toEqual([{ kind: 'history' }]);
  });

  it('does nothing with nothing to answer', () => {
    unseed();
    unseed = seedAI(NOTHING_CONNECTED);
    openHistory(false, { reveal: true, focusSearch: true });
    openHistory(false);
    expect(rail().stacks.desktop).toEqual([]);
    expect(rail().pendingFocus).toBeNull();
  });
});

describe('openConversation (C4)', () => {
  const seedSummaries = (...rows: ReturnType<typeof summary>[]) =>
    useConversationsStore.setState((s) => ({
      summaries: { ...s.summaries, ...Object.fromEntries(rows.map((r) => [r.id, r])) },
    }));

  it('pushes a general conversation, naming the row that opened it', () => {
    seedSummaries(summary({ id: 'c1' }));
    rail().push('desktop', { kind: 'history' });
    openConversation('c1', false, { returnFocus: 'conv:c1' });
    expect(rail().stacks.desktop).toEqual([{ kind: 'history' }, { kind: 'conversation', id: 'c1', returnFocus: 'conv:c1' }]);
    expect(useUIStore.getState().activeDialog).toBeNull();
  });

  it("opens an item's conversation as its item, on the Conversation section", () => {
    planner.items = [{ id: 'i1', type: 'task', title: 'Book the dentist', status: 'pending' }];
    seedSummaries(summary({ id: 'c2', itemId: 'i1' }));
    rail().push('desktop', { kind: 'history' });
    openConversation('c2', false, { returnFocus: 'conv:c2' });
    expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'edit-item', item: { id: 'i1', type: 'task' } });
    expect(rail().pendingReveal).toEqual({ itemId: 'i1' });
    // History stays beneath: Back from the item returns to it.
    expect(rail().stacks.desktop).toEqual([{ kind: 'history' }]);
  });

  it("opens a habit's as a habit", () => {
    planner.items = [{ id: 'h1', type: 'habit', title: 'Stretch' }];
    seedSummaries(summary({ id: 'c3', itemId: 'h1' }));
    openConversation('c3', false);
    expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'edit-item', item: { id: 'h1', type: 'habit' } });
  });

  it("pushes an item's conversation whose item is gone, like any other", () => {
    seedSummaries(summary({ id: 'c4', itemId: 'gone' }));
    openConversation('c4', false);
    expect(useUIStore.getState().activeDialog).toBeNull();
    expect(rail().pendingReveal).toBeNull();
    expect(rail().stacks.desktop).toEqual([{ kind: 'conversation', id: 'c4' }]);
  });

  it("on the phone, until C5: becomes the chat tab's conversation (nothing shows the phone stack yet)", () => {
    seedSummaries(summary({ id: 'c5' }));
    openConversation('c5', true, { returnFocus: 'conv:c5' });
    expect(useMobileNavStore.getState().activeTab).toBe('chat');
    expect(generalThreadId()).toBe('c5');
    expect(rail().stacks.phone).toEqual([]);
    expect(rail().stacks.desktop).toEqual([]);
  });

  it('from anywhere on desktop: closes an item on top, shows Ask, and pushes', () => {
    seedSummaries(summary({ id: 'c7' }));
    openItem();
    openConversation('c7', false, { returnFocus: 'conv:c7' });
    expect(useUIStore.getState().activeDialog).toBeNull();
    expect(rail().summoned).toBe(true);
    expect(rail().stacks.desktop).toEqual([{ kind: 'conversation', id: 'c7', returnFocus: 'conv:c7' }]);
    // A row is not a request to type.
    expect(rail().pendingFocus).toBeNull();
  });

  it('does nothing with nothing to answer', () => {
    seedSummaries(summary({ id: 'c6' }));
    unseed();
    unseed = seedAI(NOTHING_CONNECTED);
    openConversation('c6', false);
    expect(rail().stacks.desktop).toEqual([]);
  });
});
