import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * `?` in the command bar (lib/open-chat.ts askFromCommandBar), in D10's form:
 * the docked omnibar, Console's prompt and Notepad's caret read the item in
 * the slot; the ⌘K launcher, which took the slot when it opened, reads the id
 * it displaced. What is "on screen" is read BEFORE the reveal makes it true.
 */

const planner = vi.hoisted(() => ({
  items: [] as { id: string; type: string; title: string }[],
}));
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

import { askFromCommandBar, generalThreadId, resetGeneralThread } from '@/lib/open-chat';
import {
  clearChatState,
  configureConversations,
  conversationsSettled,
  useConversationsStore,
} from '@/lib/conversations-store';
import { PANEL_OVERLAY_QUERY, useRailStore, type AskView } from '@/lib/rail-store';
import { useSidebarStore } from '@/lib/sidebar-store';
import { useMobileNavStore } from '@/lib/mobile-nav-store';
import { registerItemPanelClose, registerItemPanelFlush, useUIStore } from '@/lib/ui-store';
import { useViewStore } from '@/lib/view-store';
import { CONNECTED_MODEL, NOTHING_CONNECTED, seedAI } from './helpers/ai-fixtures';
import { fakeApi, fakeTransport, hangs, type FakeApi, type FakeTransport } from './helpers/conversations-fakes';

const rail = () => useRailStore.getState();
const ui = () => useUIStore.getState();
const DENTIST = { id: 'i1', type: 'task', title: 'Book the dentist' };

let api: FakeApi;
let tx: FakeTransport;
let unseed: () => void = () => {};
let calls: string[] = [];
let offs: (() => void)[] = [];
const realMatchMedia = window.matchMedia;

/** The item a row click leaves in the slot (openEditFor's shape). */
function openItem() {
  ui().openDialog({ type: 'edit-item', item: { ...DENTIST } as never });
}

async function settle() {
  await new Promise((r) => setTimeout(r, 0));
  await conversationsSettled();
}

const top = () => rail().stacks.desktop.at(-1) as Extract<AskView, { kind: 'conversation' }> | undefined;

beforeEach(() => {
  api = fakeApi();
  tx = fakeTransport();
  configureConversations({ api: api.api, transport: tx.transport });
  unseed = seedAI(CONNECTED_MODEL);
  clearChatState();
  resetGeneralThread();
  planner.items = [DENTIST];
  useSidebarStore.setState({ askOpen: true });
  useMobileNavStore.getState().setActiveTab('today');
  useUIStore.setState({ activeDialog: null, displacedItemId: null });
  useViewStore.setState({ zenOpen: false, zenMoving: false });
  // The shell's two registrations, as DesktopShell and an open panel make them.
  calls = [];
  offs = [
    registerItemPanelFlush(() => calls.push('flush')),
    registerItemPanelClose(() => {
      calls.push('close');
      ui().closeDialog();
    }),
  ];
});

afterEach(async () => {
  await conversationsSettled();
  offs.forEach((off) => off());
  unseed();
  unseed = () => {};
  window.matchMedia = realMatchMedia;
});

describe('an empty ask', () => {
  it('only opens Ask, as it always has', async () => {
    useSidebarStore.setState({ askOpen: false });
    askFromCommandBar('   ', false);
    expect(useSidebarStore.getState().askOpen).toBe(true);
    expect(rail().summoned).toBe(true);
    await settle();
    expect(tx.inputs).toHaveLength(0);
    expect(rail().stacks.desktop).toEqual([]);
  });

  it('leaves an open item open', () => {
    openItem();
    askFromCommandBar('', false);
    expect(ui().activeDialog?.type).toBe('edit-item');
    expect(calls).toEqual([]);
  });
});

describe('never throws the item away', () => {
  it('the docked omnibar, item in the slot: flush and close it, ask in a new conversation that goes back to it', async () => {
    openItem();
    askFromCommandBar('can it be earlier?', false);
    expect(calls).toEqual(['flush', 'close']);
    expect(ui().activeDialog).toBeNull();
    await settle();

    const view = top()!;
    expect(view).toMatchObject({ kind: 'conversation', returnTo: { itemId: 'i1' } });
    expect(tx.inputs[0]).toMatchObject({ conversationId: view.id, message: 'can it be earlier?' });
    expect(rail().pendingFocus).toEqual({ target: 'composer', binding: { kind: 'conversation', id: view.id } });

    // "‹ Book the dentist": Back returns to the item.
    rail().back('desktop');
    expect(ui().activeDialog).toMatchObject({ type: 'edit-item', item: { id: 'i1' } });
  });

  it('the ⌘K launcher, which displaced the item when it opened: the same, through the id it kept', async () => {
    openItem();
    ui().openDialog({ type: 'launcher' });
    expect(ui().displacedItemId).toBe('i1');

    askFromCommandBar('can it be earlier?', false);
    // The launcher's own close comes after (omnibar.tsx); nothing here closes
    // an item that is no longer in the slot.
    expect(calls).toEqual([]);
    expect(ui().activeDialog?.type).toBe('launcher');
    await settle();
    expect(top()).toMatchObject({ kind: 'conversation', returnTo: { itemId: 'i1' } });

    ui().closeDialog();
    expect(ui().displacedItemId).toBeNull();
    rail().back('desktop');
    expect(ui().activeDialog).toMatchObject({ type: 'edit-item', item: { id: 'i1' } });
  });

  it('a new item asked over even while a conversation is on screen', async () => {
    rail().push('desktop', { kind: 'conversation', id: 'c-old' });
    openItem();
    askFromCommandBar('and this one?', false);
    await settle();
    expect(top()!.id).not.toBe('c-old');
    expect(top()).toMatchObject({ returnTo: { itemId: 'i1' } });
  });
});

describe('a conversation on screen is continued', () => {
  it('Ask showing it: the next ask goes into it, nothing is pushed', async () => {
    askFromCommandBar('plan my day', false);
    await settle();
    const first = top()!.id;

    askFromCommandBar('make it lighter', false);
    expect(rail().pendingFocus).toEqual({ target: 'composer', binding: { kind: 'conversation', id: first } });
    await settle();
    expect(rail().stacks.desktop).toEqual([{ kind: 'conversation', id: first }]);
    expect(tx.inputs.map((t) => t.conversationId)).toEqual([first, first]);
  });

  it('while it is still answering, the text waits in its box rather than being dropped', async () => {
    const turn = hangs('Su');
    tx.next = turn.run;
    askFromCommandBar('plan my day', false);
    await settle();
    const first = top()!.id;
    expect(useConversationsStore.getState().threads[first]?.streaming).toBe(true);

    askFromCommandBar('make it lighter', false);
    askFromCommandBar('and skip the gym', false);
    // Nothing sent over the reply, nothing pushed: the text is in the box the
    // user is looking at, focused, under anything already typed there.
    expect(tx.inputs).toHaveLength(1);
    expect(rail().stacks.desktop).toEqual([{ kind: 'conversation', id: first }]);
    expect(rail().drafts[`conv:${first}`]).toBe('make it lighter\nand skip the gym');
    expect(rail().pendingFocus).toEqual({ target: 'composer', binding: { kind: 'conversation', id: first } });

    turn.release('re.');
    await settle();
    // Once it is done, the next ask goes in as before.
    tx.next = fakeTransport().next;
    askFromCommandBar('thanks', false);
    await settle();
    expect(tx.inputs.map((t) => t.message)).toEqual(['plan my day', 'thanks']);
  });

  it('but not one that was deleted elsewhere: a new one, pushed', async () => {
    askFromCommandBar('plan my day', false);
    await settle();
    const first = top()!.id;
    useConversationsStore.setState((s) => ({ threads: { ...s.threads, [first]: { ...s.threads[first], load: 'gone' } } }));

    askFromCommandBar('again', false);
    await settle();
    expect(top()!.id).not.toBe(first);
  });
});

describe('wasShowing: a conversation that is not on screen is never silently continued', () => {
  it('the rail closed: a new conversation, even with one left on the stack', async () => {
    askFromCommandBar('plan my day', false);
    await settle();
    const first = top()!.id;
    rail().closeRail();

    askFromCommandBar('what is next?', false);
    await settle();
    expect(top()!.id).not.toBe(first);
    expect(tx.inputs.map((t) => t.conversationId)).toEqual([first, top()!.id]);
    expect(useSidebarStore.getState().askOpen).toBe(true);
  });

  it('at or below 1180px, Ask kept open but not summoned is not showing', async () => {
    rail().push('desktop', { kind: 'conversation', id: 'c-old' });
    window.matchMedia = ((query: string) =>
      ({ matches: query === PANEL_OVERLAY_QUERY, addEventListener() {}, removeEventListener() {} }) as never) as never;
    askFromCommandBar('what is next?', false);
    await settle();
    expect(top()!.id).not.toBe('c-old');
    // …and the ask itself summoned it, so it shows as an overlay now.
    expect(rail().summoned).toBe(true);
  });

  it('in Zen: leaves Zen and starts a new conversation', async () => {
    rail().push('desktop', { kind: 'conversation', id: 'c-old' });
    useViewStore.setState({ zenOpen: true });
    askFromCommandBar('what is next?', false);
    expect(useViewStore.getState().zenOpen).toBe(false);
    await settle();
    expect(top()!.id).not.toBe('c-old');
  });
});

describe('otherwise', () => {
  it('a new conversation, pushed, its box asked for', async () => {
    useSidebarStore.setState({ askOpen: false });
    askFromCommandBar('what is next?', false);
    await settle();
    const view = top()!;
    expect(view).toEqual({ kind: 'conversation', id: view.id });
    expect(tx.inputs[0]).toMatchObject({ conversationId: view.id, message: 'what is next?' });
    expect(api.turns[0]).toMatchObject({ id: view.id, body: { create: { itemId: null } } });
    expect(rail().pendingFocus).toEqual({ target: 'composer', binding: { kind: 'conversation', id: view.id } });
  });

  it('with nothing to answer: nothing opens, nothing closes, nothing is sent', async () => {
    unseed();
    unseed = seedAI(NOTHING_CONNECTED);
    useSidebarStore.setState({ askOpen: false });
    openItem();
    askFromCommandBar('hello', false);
    await settle();
    expect(calls).toEqual([]);
    expect(ui().activeDialog?.type).toBe('edit-item');
    expect(useSidebarStore.getState().askOpen).toBe(false);
    expect(tx.inputs).toHaveLength(0);
  });
});

describe('the phone (until C5)', () => {
  it('opens the chat tab and continues the conversation it shows', async () => {
    askFromCommandBar('how is my week?', true);
    expect(useMobileNavStore.getState().activeTab).toBe('chat');
    await settle();
    expect(tx.inputs[0]).toMatchObject({ conversationId: generalThreadId(), message: 'how is my week?' });
    expect(rail().stacks).toEqual({ desktop: [], phone: [] });
  });
});
