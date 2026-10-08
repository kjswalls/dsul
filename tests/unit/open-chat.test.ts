import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

/**
 * lib/open-chat.ts: the one place that decides where a composer's text goes,
 * and how Ask is opened. C2: Ask lives in the right rail on desktop (revealChat
 * summons it, Ctrl+J toggles it, a fresh conversation is pushed on its stack).
 * C5: the phone's Ask tab shows the same stack (`stacks.phone`), so every open
 * pushes there too. The command bar's routing is
 * tests/unit/command-bar-ask.test.ts; the tab itself, tests/unit/ask-tab.test.tsx.
 */

/** `preview`: the look-only preview's cached rows, still loading (lib/planner-ready.ts). */
const planner = vi.hoisted(() => ({ items: [] as unknown[], preview: false }));
vi.mock('@/lib/planner-store', () => ({
  usePlannerStore: {
    getState: () => ({
      userId: 'u1',
      isLoading: planner.preview,
      isPreview: planner.preview,
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
/** A context build that throws: the store's send finishes before it returns. */
const context = vi.hoisted(() => ({ throws: false }));
vi.mock('@/lib/ai-context', () => ({
  buildDsulContext: () => {
    if (context.throws) throw new RangeError('Invalid time zone specified: Mars/Olympus');
    return '## dsul Context';
  },
}));

import {
  askAboutItem,
  askKeptQuestion,
  askNew,
  bindingKey,
  breakDownItem,
  newChat,
  openConversation,
  openHistory,
  openSetup,
  proposeForItem,
  resolveSendTarget,
  revealChat,
  sendFrom,
  toggleRail,
  useAskHomeShown,
  useChatCardHomeShown,
  useChatCardSurface,
  useChatHostCard,
  usePhoneComposerBinding,
} from '@/lib/open-chat';
import {
  clearChatState,
  configureConversations,
  conversationsSettled,
  useConversationsStore,
} from '@/lib/conversations-store';
import { railModeNow, useRailStore } from '@/lib/rail-store';
import { useAIConnectionStore } from '@/lib/ai-connection-store';
import { useSidebarStore } from '@/lib/sidebar-store';
import { useMobileNavStore } from '@/lib/mobile-nav-store';
import { registerItemPanelClose, registerItemPanelFlush, useUIStore } from '@/lib/ui-store';
import { useViewStore } from '@/lib/view-store';
import { useProposalStore } from '@/lib/proposal-store';
import {
  AI_HIDDEN,
  CONNECTED_MODEL,
  KEY_TURNED_DOWN,
  NOTHING_CONNECTED,
  OPENCLAW_PLUGIN,
  capsFor,
  seedAI,
} from './helpers/ai-fixtures';
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
  useSidebarStore.setState({ askOpen: false });
  useMobileNavStore.getState().setActiveTab('today');
  useUIStore.setState({ activeDialog: null, displacedItemId: null });
  useViewStore.setState({ zenOpen: false, zenMoving: false });
  planner.items = [];
  planner.preview = false;
  context.throws = false;
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

  it("opens the Ask tab on the phone with the dock's box asked for, and touches no rail", () => {
    expect(revealChat(true)).toBe(true);
    expect(useMobileNavStore.getState().activeTab).toBe('chat');
    expect(rail().pendingFocus).toEqual({ target: 'composer' });
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

  it('is inert with nothing offered', () => {
    for (const nothing of [AI_HIDDEN, { ...KEY_TURNED_DOWN, aiHidden: true }, { ...NOTHING_CONNECTED, choice: 'none' as const }]) {
      unseed();
      unseed = seedAI(nothing);
      openItem();
      toggleRail();
      expect(useUIStore.getState().activeDialog?.type).toBe('edit-item');
      expect(useSidebarStore.getState().askOpen).toBe(false);
      expect(rail().summoned).toBe(false);
    }
  });

  // Nothing answers, but the gate offers setup or a fix: the same toggle
  // opens and shuts the setup column. Never kept open, never a box asked for,
  // and a kept-open Ask's preference is left as it was.
  describe.each([
    ['setup', NOTHING_CONNECTED],
    ['the fix', KEY_TURNED_DOWN],
  ])('with %s offered', (_label, offered) => {
    beforeEach(() => {
      unseed();
      unseed = seedAI(offered);
    });

    it('summons the setup column with no box asked for and nothing kept, then parks it', () => {
      for (const askOpen of [false, true]) {
        useSidebarStore.setState({ askOpen });
        toggleRail();
        expect(rail().summoned).toBe(true);
        expect(railModeNow()).toBe('setup');
        expect(rail().pendingFocus).toBeNull();
        expect(useSidebarStore.getState().askOpen).toBe(askOpen);
        toggleRail();
        expect(rail().summoned).toBe(false);
        expect(railModeNow()).toBe('hidden');
        expect(useSidebarStore.getState().askOpen).toBe(askOpen);
      }
    });

    it('in Zen: leaves Zen and opens the setup column', () => {
      useViewStore.setState({ zenOpen: true });
      toggleRail();
      expect(useViewStore.getState().zenOpen).toBe(false);
      expect(railModeNow()).toBe('setup');
    });

    it('an item open on top: closes the item, as it does over Ask, and shows nothing', () => {
      openItem();
      toggleRail();
      expect(useUIStore.getState().activeDialog).toBeNull();
      expect(rail().summoned).toBe(false);
      expect(railModeNow()).toBe('hidden');
      // The setup column under an item: one press closes both.
      toggleRail();
      expect(railModeNow()).toBe('setup');
      openItem();
      toggleRail();
      expect(useUIStore.getState().activeDialog).toBeNull();
      expect(railModeNow()).toBe('hidden');
    });

    it('opens nothing through revealChat: that is Ask, which nothing can answer', () => {
      expect(revealChat(false)).toBe(false);
      expect(rail().summoned).toBe(false);
    });
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
      await sendFrom({ kind: 'conversation', id: store().newDraft() }, 'hello');
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

describe('askNew', () => {
  it('desktop: a fresh, titled conversation, pushed on the rail with its box asked for', async () => {
    askNew('Plan my day', { title: 'Plan my day', isMobile: false });
    const top = rail().stacks.desktop.at(-1) as { kind: string; id: string };
    expect(top.kind).toBe('conversation');
    expect(rail().pendingFocus).toEqual({ target: 'composer', binding: { kind: 'draft', id: top.id } });
    expect(useSidebarStore.getState().askOpen).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    await conversationsSettled();

    expect(tx.inputs[0]).toMatchObject({ conversationId: top.id, message: 'Plan my day' });
    expect(api.turns[0].body.create).toEqual({ itemId: null, title: 'Plan my day' });
    expect(rail().stacks.phone).toEqual([]);

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

  it("phone: the same, on the Ask tab's stack, replacing an item pushed there (the level rule)", async () => {
    const calls: string[] = [];
    const off = registerItemPanelFlush(() => calls.push('flush'));
    rail().push('phone', { kind: 'item', itemId: 'i1' });
    askNew('Plan my day', { title: 'Plan my day', isMobile: true });
    const top = rail().stacks.phone.at(-1) as { kind: string; id: string };
    expect(rail().stacks.phone).toEqual([{ kind: 'conversation', id: top.id }]);
    expect(rail().pendingFocus).toEqual({ target: 'composer', binding: { kind: 'draft', id: top.id } });
    expect(useMobileNavStore.getState().activeTab).toBe('chat');
    // The drawer is the desktop's: nothing to close on the phone, no rail touched.
    expect(calls).toEqual([]);
    expect(rail().stacks.desktop).toEqual([]);
    expect(useSidebarStore.getState().askOpen).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    await conversationsSettled();
    expect(tx.inputs[0]).toMatchObject({ conversationId: top.id, message: 'Plan my day' });
    expect(api.turns[0].body.create).toEqual({ itemId: null, title: 'Plan my day' });
    off();
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

    it("a plan's home is its conversation, on top of the phone's stack, on the Ask tab", () => {
      card('conv:c1');
      const { result } = renderHook(() => useChatCardHomeShown('phone'));
      act(() => rail().push('phone', { kind: 'conversation', id: 'c1' }));
      expect(result.current).toBe(false);
      act(() => useMobileNavStore.getState().setActiveTab('chat'));
      expect(result.current).toBe(true);
      // An item over it is not its home; nor is the desktop's stack.
      act(() => rail().push('phone', { kind: 'item', itemId: 'i1' }));
      expect(result.current).toBe(false);
      act(() => {
        rail().back('phone');
        rail().push('desktop', { kind: 'conversation', id: 'c2' });
      });
      expect(result.current).toBe(true);
    });
  });
});

describe("usePhoneComposerBinding (C5): the dock's box follows the phone's stack", () => {
  it('home and History start a conversation; a conversation replies once something is said; an item asks about it', () => {
    const { result } = renderHook(() => usePhoneComposerBinding());
    expect(result.current).toEqual({ binding: { kind: 'home' }, placeholder: 'Ask anything…' });
    const home = result.current;
    act(() => rail().push('phone', { kind: 'history' }));
    expect(result.current).toBe(home);

    // A new chat's draft has nothing to reply to yet.
    let id = '';
    act(() => {
      id = store().newDraft();
      rail().push('phone', { kind: 'conversation', id });
    });
    expect(result.current).toEqual({ binding: { kind: 'conversation', id }, placeholder: 'Ask anything…' });
    act(() => useConversationsStore.setState((s) => ({ summaries: { ...s.summaries, [id]: summary({ id }) } })));
    expect(result.current).toEqual({ binding: { kind: 'conversation', id }, placeholder: 'Reply…' });

    act(() => rail().push('phone', { kind: 'item', itemId: 'i1' }));
    expect(result.current).toEqual({ binding: { kind: 'item', itemId: 'i1' }, placeholder: 'Ask about this item…' });
    // The desktop's stack is not the phone's box.
    act(() => rail().push('desktop', { kind: 'conversation', id: 'c9' }));
    expect(result.current.binding).toEqual({ kind: 'item', itemId: 'i1' });
  });

  it('a conversation deleted elsewhere sends to a new one, as home does', () => {
    useConversationsStore.setState((s) => ({
      threads: { ...s.threads, c1: { ...s.threads.c1, load: 'gone', messages: [] } as never },
    }));
    rail().push('phone', { kind: 'conversation', id: 'c1' });
    const { result } = renderHook(() => usePhoneComposerBinding());
    expect(result.current).toEqual({ binding: { kind: 'home' }, placeholder: 'Ask anything…' });
  });

  it("says OpenClaw's name when OpenClaw answers", () => {
    unseed();
    unseed = seedAI(OPENCLAW_PLUGIN);
    const { result } = renderHook(() => usePhoneComposerBinding());
    expect(result.current.placeholder).toBe('Message OpenClaw…');
    act(() => rail().push('phone', { kind: 'item', itemId: 'i1' }));
    expect(result.current.placeholder).toBe('Ask OpenClaw about this item…');
  });

  it('is one object per view, so the box never re-binds for an unrelated render', () => {
    const { result, rerender } = renderHook(() => usePhoneComposerBinding());
    act(() => rail().push('phone', { kind: 'item', itemId: 'i1' }));
    const first = result.current;
    rerender();
    act(() => rail().setDraft('item:i1', 'half typed'));
    expect(result.current).toBe(first);
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

  it("on the phone: pushes on the Ask tab's stack, and opens it with nothing asked of the box", () => {
    seedSummaries(summary({ id: 'c5' }));
    rail().push('phone', { kind: 'history' });
    openConversation('c5', true, { returnFocus: 'conv:c5' });
    expect(useMobileNavStore.getState().activeTab).toBe('chat');
    expect(rail().stacks.phone).toEqual([{ kind: 'history' }, { kind: 'conversation', id: 'c5', returnFocus: 'conv:c5' }]);
    expect(rail().stacks.desktop).toEqual([]);
    expect(rail().pendingFocus).toBeNull();
    expect(useUIStore.getState().activeDialog).toBeNull();
  });

  it("on the phone: an item's conversation pushes its item, revealed on the Conversation section, never the drawer", () => {
    planner.items = [{ id: 'i1', type: 'task', title: 'Book the dentist', status: 'pending' }];
    seedSummaries(summary({ id: 'c6', itemId: 'i1' }));
    rail().push('phone', { kind: 'history' });
    openConversation('c6', true, { returnFocus: 'conv:c6' });
    expect(rail().stacks.phone).toEqual([{ kind: 'history' }, { kind: 'item', itemId: 'i1', returnFocus: 'conv:c6' }]);
    expect(rail().pendingReveal).toEqual({ itemId: 'i1' });
    expect(useUIStore.getState().activeDialog).toBeNull();
  });

  // The preview's rows are cached: they cannot say whether the item exists now.
  // So the item is pushed either way, and the view (ask-tab.test.tsx) resolves
  // it on fresh rows, falling back to the conversation if it is gone.
  it.each([
    ['in the cache', [{ id: 'i1', type: 'task', title: 'Cached title', status: 'pending' }]],
    ['missing from the cache', []],
  ])('on the phone, over the preview: an item %s is pushed as its item, with the conversation to fall back to', (_what, items) => {
    planner.preview = true;
    planner.items = items;
    seedSummaries(summary({ id: 'c8', itemId: 'i1' }));
    rail().push('phone', { kind: 'history' });
    openConversation('c8', true, { returnFocus: 'conv:c8' });
    expect(rail().stacks.phone).toEqual([
      { kind: 'history' },
      { kind: 'item', itemId: 'i1', fallbackConversation: 'c8', returnFocus: 'conv:c8' },
    ]);
    expect(rail().pendingReveal).toEqual({ itemId: 'i1' });
    expect(useUIStore.getState().activeDialog).toBeNull();
  });

  it('on the phone, over the preview: a general conversation is pushed as it is', () => {
    planner.preview = true;
    seedSummaries(summary({ id: 'c9' }));
    openConversation('c9', true);
    expect(rail().stacks.phone).toEqual([{ kind: 'conversation', id: 'c9' }]);
    expect(rail().pendingReveal).toBeNull();
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
    useAIConnectionStore.getState().setFlowResult('denied');
    openConversation('c6', false);
    expect(rail().stacks.desktop).toEqual([]);
    // The setup column's sign-in result is its own to spend.
    expect(useAIConnectionStore.getState().flowResult).toBe('denied');
  });

  it.each([
    ['desktop', false],
    ['the phone', true],
  ] as const)(
    "on %s, an item's conversation spends Ask home's \"It works.\" and the sign-in's note, though no conversation is pushed",
    (_, phone) => {
      planner.items = [{ id: 'i1', type: 'task', title: 'Book the dentist', status: 'pending' }];
      seedSummaries(summary({ id: 'c8', itemId: 'i1' }));
      const ai = useAIConnectionStore.getState();
      ai.setJustConnected({ provider: 'openai', model: 'gpt-4o-mini', freeTier: false, at: Date.now() });
      ai.setFlowResult('saved');
      openConversation('c8', phone);
      // The item branch, not a pushed conversation.
      if (phone) expect(rail().stacks.phone.at(-1)).toMatchObject({ kind: 'item', itemId: 'i1' });
      else expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'edit-item', item: { id: 'i1' } });
      expect(useAIConnectionStore.getState().justConnected).toBeNull();
      expect(useAIConnectionStore.getState().flowResult).toBeNull();
    }
  );
});

describe("asked from an item's own menu (the item right-click menu's Ask AI)", () => {
  /**
   * A one-off and a habit as the planner holds them. Typed loosely, as
   * openConversation's own items are above: the functions read only id, type
   * and title.
   */
  const task = { id: 'i1', type: 'task', title: 'Book the dentist', status: 'pending' } as never;
  const habit = { id: 'h1', type: 'habit', title: 'Stretch' } as never;
  const PROMPT =
    'Find a good time for "Book the dentist" [i1] in the next few days, around what\'s already planned. ' +
    'Only schedule this one item; leave everything else where it is.';
  const ITEM_BINDING = { kind: 'item', itemId: 'i1' } as const;

  const realRequest = useProposalStore.getState().request;
  let request: ReturnType<typeof vi.fn<typeof realRequest>>;
  let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
  let offs: (() => void)[] = [];

  /** The body the proposal store POSTed to /api/ai/propose. */
  const proposeBody = (call = 0) => {
    const [url, init] = fetchMock.mock.calls[call];
    expect(url).toBe('/api/ai/propose');
    return JSON.parse(String(init?.body)) as { mode: string; prompt: string; target: string };
  };

  beforeEach(() => {
    planner.items = [task, habit];
    // The real request runs (its surface and lastRequest are what the cards
    // read), but its one network call is answered here: nothing to suggest.
    fetchMock = vi.fn(async () => Response.json({ message: 'No changes to suggest.' }));
    vi.stubGlobal('fetch', fetchMock);
    request = vi.fn(realRequest);
    useProposalStore.setState({ request });
  });

  afterEach(async () => {
    for (const off of offs) off();
    offs = [];
    await flush();
    useProposalStore.getState().dismiss();
    useProposalStore.setState({ request: realRequest });
    vi.unstubAllGlobals();
  });

  it('the fixtures this block leans on: OpenClaw over its plugin chats but cannot propose', () => {
    expect(capsFor(OPENCLAW_PLUGIN)).toMatchObject({ canChat: true, canPropose: false });
    expect(capsFor(CONNECTED_MODEL)).toMatchObject({ canChat: true, canPropose: true });
  });

  describe('askAboutItem', () => {
    it('desktop, compose: opens the item in the slot with its box asked for, and sends nothing', async () => {
      askAboutItem(task, { isMobile: false });
      expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'edit-item', item: { id: 'i1', type: 'task' } });
      expect(rail().pendingFocus).toEqual({ target: 'composer', binding: ITEM_BINDING });
      // Not known to have none (the index is filled from History's first page,
      // which may not have been read): revealed, which costs nothing if there
      // turns out to be nothing to show.
      expect(rail().pendingReveal).toEqual({ itemId: 'i1' });
      // The item is in the slot, never pushed on the rail's stack.
      expect(rail().stacks.desktop).toEqual([]);
      expect(rail().stacks.phone).toEqual([]);
      expect(useMobileNavStore.getState().activeTab).toBe('today');
      await flush();
      await conversationsSettled();
      expect(tx.inputs).toHaveLength(0);
      expect(api.api.forItem).not.toHaveBeenCalled();
      expect(api.turns).toEqual([]);
      expect(store().sending).toEqual({});
    });

    it('opens a habit as a habit', () => {
      askAboutItem(habit, { isMobile: false });
      expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'edit-item', item: { id: 'h1', type: 'habit' } });
      expect(rail().pendingFocus).toEqual({ target: 'composer', binding: { kind: 'item', itemId: 'h1' } });
    });

    it('reveals the conversation on arrival unless the item is known to have none', () => {
      // Looked up and found to have none: no reveal.
      useConversationsStore.setState((s) => ({ itemIndex: { ...s.itemIndex, i1: null } }));
      askAboutItem(task, { isMobile: false });
      expect(rail().pendingReveal).toBeNull();

      useUIStore.setState({ activeDialog: null });
      useConversationsStore.setState((s) => ({ itemIndex: { ...s.itemIndex, i1: 'c1' } }));
      askAboutItem(task, { isMobile: false });
      expect(rail().pendingReveal).toEqual({ itemId: 'i1' });
      expect(tx.inputs).toHaveLength(0);
    });

    it('a blank text is a compose, not a send', async () => {
      askAboutItem(task, { isMobile: false, text: '   ' });
      expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'edit-item', item: { id: 'i1' } });
      expect(rail().pendingFocus).toEqual({ target: 'composer', binding: ITEM_BINDING });
      await flush();
      await conversationsSettled();
      expect(tx.inputs).toHaveLength(0);
      expect(store().sending).toEqual({});
    });

    it('never re-opens the item already in the slot (the panel would only re-seed)', () => {
      openItem('i1');
      const open = useUIStore.getState().activeDialog;
      useConversationsStore.setState((s) => ({ itemIndex: { ...s.itemIndex, i1: 'c1' } }));
      askAboutItem(task, { isMobile: false });
      expect(useUIStore.getState().activeDialog).toBe(open);
      expect(rail().pendingFocus).toEqual({ target: 'composer', binding: ITEM_BINDING });
      // No reveal for an item already showing: its conversation took the last
      // one as it mounted, and this one would wait to scroll its NEXT open.
      expect(rail().pendingReveal).toBeNull();
    });

    it('retargets the slot when another item is open', () => {
      openItem('i2');
      askAboutItem(task, { isMobile: false });
      expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'edit-item', item: { id: 'i1', type: 'task' } });
    });

    it('leaves Zen: the item panel is the desktop shell, which Zen replaces', () => {
      useViewStore.setState({ zenOpen: true });
      askAboutItem(task, { isMobile: false });
      expect(useViewStore.getState().zenOpen).toBe(false);
      expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'edit-item', item: { id: 'i1' } });
    });

    it("desktop, send: through sendFrom into the item's one conversation, nothing pushed", async () => {
      const text = "Help me get started on this. What's the smallest first step I could take?";
      askAboutItem(task, { isMobile: false, text });
      // sendFrom's mark, at once: the item's box shows Stop.
      expect(store().sending[bindingKey(ITEM_BINDING)]).toBe(true);
      expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'edit-item', item: { id: 'i1' } });
      // A send's own first turn scrolls into view; it needs no reveal.
      expect(rail().pendingReveal).toBeNull();
      expect(rail().pendingFocus).toEqual({ target: 'composer', binding: ITEM_BINDING });

      await flush();
      await conversationsSettled();
      expect(api.api.forItem).toHaveBeenCalledWith('i1');
      expect(tx.inputs).toHaveLength(1);
      const id = tx.inputs[0].conversationId;
      expect(tx.inputs[0]).toMatchObject({ message: text });
      expect(store().threads[id]).toMatchObject({ itemId: 'i1' });
      expect(store().threads[id].messages.map((m) => [m.role, m.content])).toEqual([
        ['user', text],
        ['assistant', 'Sure.'],
      ]);
      expect(api.turns[0]).toMatchObject({ id, body: { create: { itemId: 'i1' } } });
      // The item's conversation shows inside the item: no conversation view is pushed.
      expect(rail().stacks.desktop).toEqual([]);
      expect(store().sending).toEqual({});
    });

    it("desktop, send: continues the item's saved conversation, read first", async () => {
      useConversationsStore.setState((s) => ({ itemIndex: { ...s.itemIndex, i1: 'c1' } }));
      api.rows.set('c1', summary({ id: 'c1', itemId: 'i1', messageCount: 0 }));
      api.answer.forItem = () => ({ ok: true, value: summary({ id: 'c1', itemId: 'i1', messageCount: 0 }) });
      api.answer.thread = (id) => ({
        ok: true,
        value: { conversation: summary({ id, itemId: 'i1' }), messages: [], hasEarlier: false },
      });
      askAboutItem(task, { isMobile: false, text: 'Help me start' });
      await flush();
      await conversationsSettled();
      expect(tx.inputs[0]).toMatchObject({ conversationId: 'c1', message: 'Help me start' });
      expect(rail().pendingReveal).toBeNull();
    });

    it("a send while the item is still answering waits in the item's box, as the command bar's does", async () => {
      const h = hangs('');
      tx.next = h.run;
      askAboutItem(task, { isMobile: false, text: 'first' });
      await flush();
      expect(tx.inputs).toHaveLength(1);
      // Under anything already typed there.
      rail().setDraft(bindingKey(ITEM_BINDING), 'half a thought');
      askAboutItem(task, { isMobile: false, text: 'Help me start' });
      await flush();
      expect(tx.inputs).toHaveLength(1);
      expect(rail().drafts[bindingKey(ITEM_BINDING)]).toBe('half a thought\nHelp me start');
      expect(rail().pendingFocus).toEqual({ target: 'composer', binding: ITEM_BINDING });
      h.release('done');
      await flush();
      await conversationsSettled();
      expect(store().threads[tx.inputs[0].conversationId].messages.map((m) => m.content)).toEqual(['first', 'done']);
    });

    describe('page: the surface sends the item to /item/[id] itself', () => {
      it('compose: touches neither the slot nor the rail, and sends nothing', async () => {
        askAboutItem(task, { isMobile: false, page: true });
        expect(useUIStore.getState().activeDialog).toBeNull();
        expect(rail().pendingFocus).toBeNull();
        expect(rail().pendingReveal).toBeNull();
        expect(rail().stacks).toEqual({ desktop: [], phone: [] });
        expect(rail().summoned).toBe(false);
        await flush();
        await conversationsSettled();
        expect(tx.inputs).toHaveLength(0);
      });

      it("send: still sends into the item's conversation, with no slot armed", async () => {
        askAboutItem(task, { isMobile: false, page: true, text: 'Help me start' });
        expect(useUIStore.getState().activeDialog).toBeNull();
        expect(rail().pendingFocus).toBeNull();
        expect(rail().pendingReveal).toBeNull();
        await flush();
        await conversationsSettled();
        expect(tx.inputs).toHaveLength(1);
        expect(tx.inputs[0]).toMatchObject({ message: 'Help me start' });
        expect(store().threads[tx.inputs[0].conversationId]).toMatchObject({ itemId: 'i1' });
        expect(useUIStore.getState().activeDialog).toBeNull();
        expect(rail().stacks).toEqual({ desktop: [], phone: [] });
      });

      it("a send while the item is still answering waits in the item's box, which its page shows too", async () => {
        const h = hangs('');
        tx.next = h.run;
        askAboutItem(task, { isMobile: false, page: true, text: 'first' });
        await flush();
        expect(tx.inputs).toHaveLength(1);
        askAboutItem(task, { isMobile: false, page: true, text: 'Help me start' });
        await flush();
        expect(tx.inputs).toHaveLength(1);
        // The key the page's inline box reads (components/ai/item-conversation.tsx).
        expect(rail().drafts[bindingKey(ITEM_BINDING)]).toBe('Help me start');
        expect(rail().pendingFocus).toBeNull();
        h.release('done');
        await flush();
        await conversationsSettled();
      });

      it("on the phone too: no push, and the Ask tab is left alone", async () => {
        askAboutItem(task, { isMobile: true, page: true, text: 'Help me start' });
        expect(rail().stacks.phone).toEqual([]);
        expect(useMobileNavStore.getState().activeTab).toBe('today');
        await flush();
        await conversationsSettled();
        expect(tx.inputs).toHaveLength(1);
      });
    });

    describe('phone', () => {
      it("compose: pushes the item over the Ask tab, once, with the dock's box asked for", () => {
        rail().push('phone', { kind: 'history' });
        askAboutItem(task, { isMobile: true });
        expect(useMobileNavStore.getState().activeTab).toBe('chat');
        expect(rail().stacks.phone).toEqual([{ kind: 'history' }, { kind: 'item', itemId: 'i1' }]);
        // The dock's one box follows the pushed item, so the request names no binding.
        expect(rail().pendingFocus).toEqual({ target: 'composer' });
        // Not known to have none: revealed as it is pushed.
        expect(rail().pendingReveal).toEqual({ itemId: 'i1' });
        // Never the drawer, and never the desktop rail.
        expect(useUIStore.getState().activeDialog).toBeNull();
        expect(rail().stacks.desktop).toEqual([]);
        expect(rail().summoned).toBe(false);
        expect(useSidebarStore.getState().askOpen).toBe(false);

        // Already on top: not pushed again, and no reveal re-armed (the item's
        // conversation took the first as it mounted).
        expect(rail().consumeReveal('i1')).toBe(true);
        const stack = rail().stacks.phone;
        askAboutItem(task, { isMobile: true });
        expect(rail().stacks.phone).toBe(stack);
        expect(rail().pendingReveal).toBeNull();
      });

      it('replaces another item on top (the level rule)', () => {
        rail().push('phone', { kind: 'item', itemId: 'i2' });
        askAboutItem(task, { isMobile: true });
        expect(rail().stacks.phone).toEqual([{ kind: 'item', itemId: 'i1' }]);
      });

      it("send: pushed, the text sent into the item's conversation", async () => {
        askAboutItem(task, { isMobile: true, text: 'Help me start' });
        expect(useMobileNavStore.getState().activeTab).toBe('chat');
        expect(rail().stacks.phone).toEqual([{ kind: 'item', itemId: 'i1' }]);
        expect(rail().pendingReveal).toBeNull();
        await flush();
        await conversationsSettled();
        expect(tx.inputs).toHaveLength(1);
        expect(store().threads[tx.inputs[0].conversationId]).toMatchObject({ itemId: 'i1' });
        expect(rail().stacks.phone).toEqual([{ kind: 'item', itemId: 'i1' }]);
      });
    });

    it('does nothing when nothing can answer', async () => {
      unseed();
      unseed = seedAI(NOTHING_CONNECTED);
      askAboutItem(task, { isMobile: false });
      askAboutItem(task, { isMobile: false, text: 'Help me start' });
      askAboutItem(task, { isMobile: true, text: 'Help me start' });
      askAboutItem(task, { isMobile: false, page: true, text: 'Help me start' });
      expect(useUIStore.getState().activeDialog).toBeNull();
      expect(rail().pendingFocus).toBeNull();
      expect(rail().pendingReveal).toBeNull();
      expect(rail().stacks).toEqual({ desktop: [], phone: [] });
      expect(useMobileNavStore.getState().activeTab).toBe('today');
      await flush();
      await conversationsSettled();
      expect(tx.inputs).toHaveLength(0);
      expect(api.api.forItem).not.toHaveBeenCalled();
      expect(store().sending).toEqual({});
    });
  });

  describe('breakDownItem', () => {
    it("desktop: opens the item, then asks for the item's own breakdown card (item:<id>)", async () => {
      breakDownItem(task, { isMobile: false });
      expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'edit-item', item: { id: 'i1', type: 'task' } });
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith('breakdown', undefined, 'i1');
      expect(useProposalStore.getState()).toMatchObject({
        status: 'loading',
        lastRequest: { intent: 'breakdown', itemId: 'i1', surface: 'item:i1' },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(proposeBody()).toMatchObject({ mode: 'breakdown', target: 'model' });
      // The card answers inside the item: no reveal, no box, nothing sent.
      expect(rail().pendingReveal).toBeNull();
      expect(rail().pendingFocus).toBeNull();
      expect(rail().stacks.desktop).toEqual([]);
      await flush();
      expect(tx.inputs).toHaveLength(0);
      expect(useProposalStore.getState().status).toBe('empty');
    });

    it('never re-opens the item already in the slot, and leaves Zen', () => {
      openItem('i1');
      const open = useUIStore.getState().activeDialog;
      useViewStore.setState({ zenOpen: true });
      breakDownItem(task, { isMobile: false });
      expect(useUIStore.getState().activeDialog).toBe(open);
      expect(useViewStore.getState().zenOpen).toBe(false);
      expect(request).toHaveBeenCalledWith('breakdown', undefined, 'i1');
    });

    it('page: asks for the card, which the item page shows, and arms no slot', () => {
      breakDownItem(task, { isMobile: false, page: true });
      expect(useUIStore.getState().activeDialog).toBeNull();
      expect(rail().stacks).toEqual({ desktop: [], phone: [] });
      expect(rail().pendingReveal).toBeNull();
      expect(request).toHaveBeenCalledWith('breakdown', undefined, 'i1');
      expect(useProposalStore.getState().lastRequest?.surface).toBe('item:i1');
    });

    it('phone: pushes the item over the Ask tab, then asks', () => {
      breakDownItem(task, { isMobile: true });
      expect(useMobileNavStore.getState().activeTab).toBe('chat');
      expect(rail().stacks.phone).toEqual([{ kind: 'item', itemId: 'i1' }]);
      expect(useUIStore.getState().activeDialog).toBeNull();
      expect(rail().pendingReveal).toBeNull();
      expect(request).toHaveBeenCalledWith('breakdown', undefined, 'i1');
    });

    it('does nothing when nothing can propose, even with chat (OpenClaw over its plugin)', () => {
      unseed();
      unseed = seedAI(OPENCLAW_PLUGIN);
      breakDownItem(task, { isMobile: false });
      breakDownItem(task, { isMobile: true });
      breakDownItem(task, { isMobile: false, page: true });
      expect(useUIStore.getState().activeDialog).toBeNull();
      expect(rail().stacks).toEqual({ desktop: [], phone: [] });
      expect(useMobileNavStore.getState().activeTab).toBe('today');
      expect(request).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(useProposalStore.getState().status).toBe('idle');
    });

    it('does nothing when nothing can answer', () => {
      unseed();
      unseed = seedAI(NOTHING_CONNECTED);
      breakDownItem(task, { isMobile: false });
      expect(useUIStore.getState().activeDialog).toBeNull();
      expect(request).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('proposeForItem', () => {
    it('desktop: closes the item through the one flushing close, shows Ask home, and asks for a plan card there', () => {
      const flushPanel = vi.fn();
      const closePanel = vi.fn(() => useUIStore.getState().closeDialog());
      offs.push(registerItemPanelFlush(flushPanel), registerItemPanelClose(closePanel));
      rail().push('desktop', { kind: 'history' });
      rail().push('desktop', { kind: 'conversation', id: 'c1' });
      openItem('i1');

      proposeForItem(PROMPT, false);
      expect(flushPanel).toHaveBeenCalledTimes(1);
      expect(closePanel).toHaveBeenCalledTimes(1);
      expect(useUIStore.getState().activeDialog).toBeNull();
      // Flushed BEFORE the ask: a title typed a moment ago is in the plan's context.
      expect(flushPanel.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[0]);
      // Ask summoned, at home, its box asked for.
      expect(useSidebarStore.getState().askOpen).toBe(true);
      expect(rail().summoned).toBe(true);
      expect(rail().stacks.desktop).toEqual([]);
      expect(rail().pendingFocus).toEqual({ target: 'composer' });
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith('ask', PROMPT);
      expect(useProposalStore.getState()).toMatchObject({
        status: 'loading',
        lastRequest: { intent: 'ask', prompt: PROMPT, surface: 'chat' },
      });
      expect(useProposalStore.getState().lastRequest?.itemId).toBeUndefined();
      expect(proposeBody()).toMatchObject({ mode: 'plan', prompt: PROMPT, target: 'model' });
      // A card, not a conversation: nothing sent to chat.
      expect(tx.inputs).toHaveLength(0);
      expect(useMobileNavStore.getState().activeTab).toBe('today');
    });

    it('with no item open: shows Ask home and asks, closing nothing', () => {
      const flushPanel = vi.fn();
      offs.push(registerItemPanelFlush(flushPanel));
      proposeForItem(PROMPT, false);
      expect(flushPanel).not.toHaveBeenCalled();
      expect(rail().summoned).toBe(true);
      expect(request).toHaveBeenCalledWith('ask', PROMPT);
    });

    it('leaves Zen', () => {
      useViewStore.setState({ zenOpen: true });
      proposeForItem(PROMPT, false);
      expect(useViewStore.getState().zenOpen).toBe(false);
      expect(rail().summoned).toBe(true);
    });

    it("with History on top, pops home before summoning: the focus request is home's box, not History's search", () => {
      // A 'history-search' request computed before the pop would wait for the
      // next History and take the caret there unasked.
      rail().push('desktop', { kind: 'history' });
      proposeForItem(PROMPT, false);
      expect(rail().stacks.desktop).toEqual([]);
      expect(rail().pendingFocus).toEqual({ target: 'composer' });
    });

    it("phone: the Ask tab at home with no box asked for (the card's buttons are to tap)", () => {
      rail().push('phone', { kind: 'conversation', id: 'c1' });
      rail().push('phone', { kind: 'item', itemId: 'i1' });
      rail().push('desktop', { kind: 'history' });
      proposeForItem(PROMPT, true);
      expect(useMobileNavStore.getState().activeTab).toBe('chat');
      expect(rail().stacks.phone).toEqual([]);
      expect(rail().pendingFocus).toBeNull();
      // The desktop rail is not the phone's.
      expect(rail().stacks.desktop).toEqual([{ kind: 'history' }]);
      expect(rail().summoned).toBe(false);
      expect(useSidebarStore.getState().askOpen).toBe(false);
      expect(request).toHaveBeenCalledWith('ask', PROMPT);
      expect(useProposalStore.getState().lastRequest?.surface).toBe('chat');
    });

    it('does nothing when nothing can propose, even with chat (OpenClaw over its plugin)', () => {
      unseed();
      unseed = seedAI(OPENCLAW_PLUGIN);
      const flushPanel = vi.fn();
      offs.push(registerItemPanelFlush(flushPanel));
      rail().push('desktop', { kind: 'history' });
      openItem('i1');
      const open = useUIStore.getState().activeDialog;

      proposeForItem(PROMPT, false);
      proposeForItem(PROMPT, true);
      // The item is left exactly as it was: not flushed, not closed.
      expect(flushPanel).not.toHaveBeenCalled();
      expect(useUIStore.getState().activeDialog).toBe(open);
      expect(rail().summoned).toBe(false);
      expect(useSidebarStore.getState().askOpen).toBe(false);
      expect(rail().stacks.desktop).toEqual([{ kind: 'history' }]);
      expect(useMobileNavStore.getState().activeTab).toBe('today');
      expect(request).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(useProposalStore.getState().status).toBe('idle');
    });

    it('does nothing when nothing can answer', () => {
      unseed();
      unseed = seedAI(NOTHING_CONNECTED);
      openItem('i1');
      proposeForItem(PROMPT, false);
      expect(useUIStore.getState().activeDialog?.type).toBe('edit-item');
      expect(rail().summoned).toBe(false);
      expect(request).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

// What a send reports back: a caller that must not lose the text (the kept
// question, lib/ask-pending.ts) puts it back on a refusal.
describe('sendFrom says whether the send took the text', () => {
  it('true once the store took it and the thread is answering', async () => {
    expect(await sendFrom({ kind: 'home' }, 'what is next?', { surface: 'desktop' })).toBe(true);
    expect(tx.inputs).toHaveLength(1);
  });

  it('true when the store took it and finished before returning (its context build threw)', async () => {
    context.throws = true;
    expect(await sendFrom({ kind: 'home' }, 'what is next?', { surface: 'desktop' })).toBe(true);
    await conversationsSettled();
    const id = (rail().stacks.desktop.at(-1) as { id: string }).id;
    expect(store().threads[id].streaming).toBe(false);
    expect(store().threads[id].messages.map((m) => [m.role, m.status])).toEqual([
      ['user', 'complete'],
      ['assistant', 'error'],
    ]);
    expect(tx.inputs).toHaveLength(0);
    expect(api.turns).toHaveLength(1);
  });

  it('false with nothing to answer', async () => {
    unseed();
    unseed = seedAI(NOTHING_CONNECTED);
    expect(await sendFrom({ kind: 'home' }, 'hello')).toBe(false);
    expect(await sendFrom({ kind: 'home' }, '   ')).toBe(false);
  });

  it('false while the binding is already sending', async () => {
    const h = hangs('');
    tx.next = h.run;
    const first = sendFrom({ kind: 'item', itemId: 'i1' }, 'one');
    expect(await sendFrom({ kind: 'item', itemId: 'i1' }, 'two')).toBe(false);
    await flush();
    expect(tx.inputs).toHaveLength(1);
    h.release('done');
    expect(await first).toBe(true);
  });

  it('false while the thread is still answering', async () => {
    const h = hangs('');
    tx.next = h.run;
    const id = store().newDraft();
    const first = sendFrom({ kind: 'draft', id }, 'one');
    await flush(1);
    expect(store().threads[id].streaming).toBe(true);
    expect(await sendFrom({ kind: 'conversation', id }, 'two')).toBe(false);
    h.release('done');
    expect(await first).toBe(true);
    expect(tx.inputs).toHaveLength(1);
  });

  it("false when the store's own re-check of the gate refuses after sendFrom's", async () => {
    const sending = sendFrom({ kind: 'home' }, 'hello');
    // The gate closes between sendFrom's check and the store's own.
    unseed();
    unseed = seedAI(NOTHING_CONNECTED);
    expect(await sending).toBe(false);
    expect(tx.inputs).toHaveLength(0);
  });
});

describe('askKeptQuestion', () => {
  it('desktop: closes an item through the flushing close, leaves Zen, and asks in a new conversation without keeping Ask open', async () => {
    const calls: string[] = [];
    const offFlush = registerItemPanelFlush(() => calls.push('flush'));
    const offClose = registerItemPanelClose(() => {
      calls.push('close');
      useUIStore.getState().closeDialog();
    });
    openItem();
    useViewStore.setState({ zenOpen: true });
    try {
      expect(await askKeptQuestion('what should I do first', false)).toBe(true);
    } finally {
      offFlush();
      offClose();
    }
    await conversationsSettled();
    expect(calls).toEqual(['flush', 'close']);
    expect(useViewStore.getState().zenOpen).toBe(false);
    expect(rail().summoned).toBe(true);
    // For this session only: an Ask the setup door opened is never kept open.
    expect(useSidebarStore.getState().askOpen).toBe(false);
    expect(railModeNow()).toBe('ask');
    const top = rail().stacks.desktop.at(-1) as { kind: string; id: string };
    expect(top.kind).toBe('conversation');
    expect(rail().pendingFocus).toEqual({ target: 'composer', binding: { kind: 'conversation', id: top.id } });
    expect(tx.inputs[0].conversationId).toBe(top.id);
    expect(store().threads[top.id].messages[0].content).toBe('what should I do first');
    // Nothing on the phone.
    expect(rail().stacks.phone).toEqual([]);
    expect(useMobileNavStore.getState().activeTab).toBe('today');
  });

  it('phone: the Ask tab and its own stack, never a summon', async () => {
    expect(await askKeptQuestion('what should I do first', true)).toBe(true);
    await conversationsSettled();
    expect(useMobileNavStore.getState().activeTab).toBe('chat');
    const top = rail().stacks.phone.at(-1) as { kind: string; id: string };
    expect(top.kind).toBe('conversation');
    expect(tx.inputs[0].conversationId).toBe(top.id);
    expect(rail().summoned).toBe(false);
    expect(useSidebarStore.getState().askOpen).toBe(false);
    expect(rail().stacks.desktop).toEqual([]);
  });

  it('with nothing to answer: false, and nothing opens, closes or is sent', async () => {
    unseed();
    unseed = seedAI(NOTHING_CONNECTED);
    openItem();
    expect(await askKeptQuestion('hello', false)).toBe(false);
    expect(await askKeptQuestion('hello', true)).toBe(false);
    expect(useUIStore.getState().activeDialog?.type).toBe('edit-item');
    expect(rail().summoned).toBe(false);
    expect(useMobileNavStore.getState().activeTab).toBe('today');
    expect(tx.inputs).toHaveLength(0);
  });
});

describe('openSetup', () => {
  describe.each([
    ['setup', NOTHING_CONNECTED],
    ['the fix', KEY_TURNED_DOWN],
  ])('with %s offered', (_label, offered) => {
    beforeEach(() => {
      unseed();
      unseed = seedAI(offered);
    });

    it('desktop: the setup column, with no box asked for and nothing kept, and a second press leaves it open', () => {
      expect(openSetup(false)).toBe(true);
      expect(railModeNow()).toBe('setup');
      expect(rail().pendingFocus).toBeNull();
      expect(useSidebarStore.getState().askOpen).toBe(false);
      // Open only, never a toggle.
      expect(openSetup(false)).toBe(true);
      expect(railModeNow()).toBe('setup');
      expect(useMobileNavStore.getState().activeTab).toBe('today');
    });

    it('desktop: an item on top closes through the flushing close and setup shows, out of Zen', () => {
      const calls: string[] = [];
      const offFlush = registerItemPanelFlush(() => calls.push('flush'));
      const offClose = registerItemPanelClose(() => {
        calls.push('close');
        useUIStore.getState().closeDialog();
      });
      openItem();
      useViewStore.setState({ zenOpen: true });
      try {
        expect(openSetup(false)).toBe(true);
      } finally {
        offFlush();
        offClose();
      }
      expect(calls).toEqual(['flush', 'close']);
      expect(useViewStore.getState().zenOpen).toBe(false);
      expect(railModeNow()).toBe('setup');
    });

    it('phone: the Ask tab, which shows the setup page, and never a summon', () => {
      expect(openSetup(true)).toBe(true);
      expect(useMobileNavStore.getState().activeTab).toBe('chat');
      expect(rail().summoned).toBe(false);
      expect(useSidebarStore.getState().askOpen).toBe(false);
    });
  });

  it('false, and nothing moves, with neither setup nor a fix on offer', () => {
    for (const nothing of [AI_HIDDEN, CONNECTED_MODEL, OPENCLAW_PLUGIN, { ...NOTHING_CONNECTED, choice: 'none' as const }, {}]) {
      unseed();
      unseed = seedAI(nothing);
      openItem();
      expect(openSetup(false)).toBe(false);
      expect(openSetup(true)).toBe(false);
      expect(useUIStore.getState().activeDialog?.type).toBe('edit-item');
      expect(rail().summoned).toBe(false);
      expect(useMobileNavStore.getState().activeTab).toBe('today');
    }
  });
});
