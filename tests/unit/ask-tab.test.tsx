import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * The phone's Ask tab (C5): components/mobile/ask-tab.tsx inside the real
 * MobileShell and MobileBottomDock, over the real stores, so what is asserted
 * is the tab's contract with the shell around it:
 *
 *  - ONE STACK: `stacks.phone`, Ask home under History, a conversation and an
 *    item, under one capsule ("‹ <the view beneath>", no ✕).
 *  - ITEMS PUSH, while the tab is mounted: `openEditFor` from anywhere puts
 *    the item over Ask; Today, which never mounts the tab, keeps the drawer.
 *    The pushed item's payload is a snapshot, so a planner write does not
 *    close its delete confirm.
 *  - SWIPE RIGHT is Back at depth, and a tab change only at Ask home.
 *  - THE DOCK'S BOX is the tab's one box: bound to the top view, worded for
 *    it, with the answerer named under it; arriving puts the caret in it only
 *    at a conversation or an item.
 *  - LEAVING THE TAB keeps the stack, the drafts and a conversation's card.
 *
 * Stubbed: the dated header, the user menu (a bare button), the schedule
 * sheet, the braindump, and Today (one button that opens an item, as a row
 * tap does).
 */

const swipe = vi.hoisted(() => ({
  handlers: null as null | { onSwipedLeft?: () => void; onSwipedRight?: () => void },
}));

// The shell's handlers: a row's (SwipeRow, which tracks its own start) never
// mounts here, but is told apart anyway.
vi.mock('react-swipeable', () => ({
  useSwipeable: (handlers: { onSwipedLeft?: () => void; onSwipedRight?: () => void; onSwipeStart?: unknown }) => {
    if (!handlers.onSwipeStart) swipe.handlers = handlers;
    return {};
  },
}));

vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  fetchRoutines: vi.fn(async () => []),
  fetchSeasons: vi.fn(async () => []),
  fetchGoals: vi.fn(async () => []),
  fetchAgentStates: vi.fn(async () => []),
  fetchTrashedNames: vi.fn(async () => ({ projects: [] })),
  fetchItemEvents: vi.fn(async () => []),
  getItemEventsAvailable: () => false,
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}), flushSettings: vi.fn() }));
vi.mock('sonner', () => ({
  toast: Object.assign(() => 'id', { error: vi.fn(), dismiss: vi.fn(), success: vi.fn() }),
}));
vi.mock('@/lib/supabase', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
  })),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));
// The item's notes editor is a dynamic chunk; what is under test is the view around it.
vi.mock('next/dynamic', () => ({
  default: () =>
    function DynamicStub() {
      return null;
    },
}));

vi.mock('@/components/mobile/mobile-header', () => ({ MobileHeader: () => null }));
vi.mock('@/components/planner/user-profile-dropdown', () => ({
  UserProfileDropdown: () => <button type="button" aria-label="User menu" />,
}));
vi.mock('@/components/mobile/schedule-sheet', () => ({ ScheduleSheet: () => null }));
vi.mock('@/components/sidebar/braindump', () => ({ Braindump: () => <div data-testid="surface-braindump" /> }));
// Today: a row tap, which is openEditFor.
vi.mock('@/components/mobile/mobile-view-router', async () => {
  const { openEditFor } = await import('@/lib/ui-store');
  return {
    MobileViewRouter: () => (
      <button
        type="button"
        data-testid="today-row"
        onClick={() => openEditFor({ id: 'item-1', title: 'Book the dentist' } as never, 'task')}
      >
        Book the dentist
      </button>
    ),
  };
});

import { MobileShell } from '@/components/shell/mobile-shell';
import { AskTab } from '@/components/mobile/ask-tab';
import { chatTransport } from '@/lib/chat-transport';
import { httpConversationsApi } from '@/lib/conversations-api';
import {
  clearChatState,
  configureConversations,
  conversationsSettled,
  useConversationsStore,
  type ChatMessage,
} from '@/lib/conversations-store';
import { useMobileNavStore } from '@/lib/mobile-nav-store';
import { usePlannerStore } from '@/lib/planner-store';
import { useProposalStore } from '@/lib/proposal-store';
import { phoneArrivalFocuses, useRailStore, type AskView } from '@/lib/rail-store';
import { openEditFor, useUIStore } from '@/lib/ui-store';
import type { TaskItem } from '@/lib/planner-types';
import { CONNECTED_MODEL, OPENCLAW_PLUGIN, seedAI } from './helpers/ai-fixtures';
import { fakeApi, fakeTransport, flush, summary, type FakeTransport } from './helpers/conversations-fakes';

beforeAll(() => {
  if (!('PointerEvent' in globalThis)) {
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = MouseEvent;
  }
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

const TASK = {
  type: 'task',
  id: 'item-1',
  title: 'Book the dentist',
  status: 'pending',
  isScheduled: false,
  order: 0,
} as unknown as TaskItem;

const rail = () => useRailStore.getState();
const phone = () => rail().stacks.phone;
const tab = () => useMobileNavStore.getState().activeTab;
const dockInput = () => screen.getByTestId('chat-dock-input') as HTMLTextAreaElement;
const back = () => screen.getByTestId('ask-back');

let transport: FakeTransport;
let unseed: () => void = () => {};

beforeEach(() => {
  transport = fakeTransport();
  configureConversations({ api: fakeApi().api, transport: transport.transport });
  clearChatState();
  unseed = seedAI(CONNECTED_MODEL);
  useMobileNavStore.setState({ activeTab: 'chat' });
  useUIStore.setState({ activeDialog: null, displacedItemId: null });
  useProposalStore.getState().dismiss();
  usePlannerStore.setState({
    userId: 'user-1',
    userTimezone: 'UTC',
    isLoading: false,
    items: [TASK],
    tasks: [],
    habits: [],
    projects: [],
    routines: [],
    seasons: [],
    goals: [],
  });
  swipe.handlers = null;
});

afterEach(async () => {
  cleanup();
  await conversationsSettled();
  unseed();
  unseed = () => {};
  configureConversations({ api: httpConversationsApi, transport: chatTransport });
});

/** A saved conversation this browser has read: one question and its answer. */
function seedConversation(id: string, answer = 'Two items are open.') {
  const at = (pos: number, role: 'user' | 'assistant', content: string): ChatMessage => ({
    id: `${id}-m${pos}`,
    role,
    content,
    status: 'complete',
    errorCode: null,
    replyTo: role === 'assistant' ? `${id}-m${pos - 1}` : null,
    answerer: role === 'assistant' ? 'model' : null,
    model: null,
    createdAt: 1_759_400_000_000,
    pos,
    sync: 'saved',
  });
  useConversationsStore.setState((s) => ({
    summaries: { ...s.summaries, [id]: summary({ id, title: 'What is open', messageCount: 2 }) },
    threads: {
      ...s.threads,
      [id]: {
        id,
        itemId: null,
        draftTitle: null,
        saved: true,
        messages: [at(1, 'user', 'What is open?'), at(2, 'assistant', answer)],
        load: 'loaded',
        hasEarlier: false,
        streaming: false,
        typing: false,
        fetchedAt: Date.now(),
      },
    },
  }));
}

function renderShell(stack: AskView[] = []) {
  for (const view of stack) rail().push('phone', view);
  return render(<MobileShell />);
}

describe('one stack under one capsule', () => {
  it('Ask home: "Ask", History, + and the user menu, no ✕, and no box of its own', () => {
    renderShell();
    const tabRoot = document.querySelector('[data-ask-tab]') as HTMLElement;
    expect(within(tabRoot).getByText('Ask')).toBeInTheDocument();
    expect(within(tabRoot).getByRole('button', { name: 'History' })).toBeInTheDocument();
    expect(within(tabRoot).getByRole('button', { name: 'New chat' })).toBeInTheDocument();
    expect(within(tabRoot).getByRole('button', { name: 'User menu' })).toBeInTheDocument();
    expect(within(tabRoot).queryByRole('button', { name: /close/i })).toBeNull();
    expect(within(tabRoot).queryByRole('textbox')).toBeNull();
    // The dock's is the one box on the tab.
    expect(screen.getAllByRole('textbox')).toEqual([dockInput()]);
  });

  it('History, a new chat and Back: each view names the one beneath, and Back hands focus to what pushed it', async () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(phone()).toEqual([{ kind: 'history', returnFocus: 'history' }]);
    expect(back()).toHaveAccessibleName('Back to Ask');

    // "+" asks for the box, and the dock's takes it.
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(phone()).toMatchObject([{ kind: 'history' }, { kind: 'conversation' }]);
    expect(back()).toHaveAccessibleName('Back to History');
    expect(screen.getByText('New chat')).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(dockInput()));

    // Back to History lets the box go (the keyboard would hide the rows)...
    fireEvent.click(back());
    await waitFor(() => expect(document.activeElement).not.toBe(dockInput()));
    // ...and Back home hands focus to the control that pushed History.
    fireEvent.click(back());
    expect(phone()).toEqual([]);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'History' })));
  });

  // The rail's rule (rail-header.tsx conversationHeaderAction): a new chat's
  // History is how to reach History, so over History it offers none.
  it('a new chat over History offers no History of its own, nor "+"; from Ask home it has History', async () => {
    renderShell();
    const tabRoot = () => document.querySelector('[data-ask-tab]') as HTMLElement;
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(phone().map((v) => v.kind)).toEqual(['history', 'conversation']);
    expect(back()).toHaveAccessibleName('Back to History');
    expect(within(tabRoot()).getByText('New chat')).toBeInTheDocument();
    expect(within(tabRoot()).queryByRole('button', { name: 'History' })).toBeNull();
    expect(within(tabRoot()).queryByRole('button', { name: 'New chat' })).toBeNull();
    // The user menu still ends the capsule.
    expect(within(tabRoot()).getByRole('button', { name: 'User menu' })).toBeInTheDocument();

    fireEvent.click(back());
    fireEvent.click(back());
    expect(phone()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(phone().map((v) => v.kind)).toEqual(['conversation']);
    expect(within(tabRoot()).getByRole('button', { name: 'History' })).toBeInTheDocument();
  });

  // A tap or Enter on "‹ History" leaves focus on that button, and React keeps
  // it into History's capsule, where it reads "‹ Ask": focus left there would
  // send a second press home. As in the rail, it goes to what pushed the view.
  it('hands focus from the pressed "‹" to the control that pushed the view, not the "‹" React kept', async () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(phone()).toMatchObject([{ kind: 'history' }, { kind: 'conversation', returnFocus: 'new-chat' }]);
    await waitFor(() => expect(document.activeElement).toBe(dockInput()));

    const pressed = back();
    act(() => pressed.focus());
    fireEvent.click(pressed);
    expect(phone()).toEqual([{ kind: 'history', returnFocus: 'history' }]);
    // The same node, now the way home.
    expect(back()).toBe(pressed);
    expect(back()).toHaveAccessibleName('Back to Ask');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New chat' })));
    expect(document.activeElement).not.toBe(back());
  });

  it("a saved conversation's title is its ⌄ menu, with + beside it", () => {
    seedConversation('c1');
    renderShell([{ kind: 'conversation', id: 'c1' }]);
    expect(screen.getByTestId('conversation-title-menu')).toHaveTextContent('What is open');
    expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument();
    expect(screen.getByText('Two items are open.')).toBeInTheDocument();
  });

  // The conversation's box is the dock's (disabled while a reply streams), so
  // "Jump to latest" hands the focus it held to the log, never to <body>.
  it('"Jump to latest" pressed with focus on it leaves focus in the conversation', () => {
    seedConversation('c1');
    renderShell([{ kind: 'conversation', id: 'c1' }]);
    const log = screen.getByTestId('chat-transcript');
    Object.defineProperty(log, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(log, 'clientHeight', { value: 300, configurable: true });
    log.scrollTop = 100;
    fireEvent.scroll(log);
    log.scrollTo = vi.fn() as never;
    const pill = screen.getByTestId('chat-jump-latest');
    act(() => pill.focus());
    fireEvent.click(pill);
    expect(screen.queryByTestId('chat-jump-latest')).toBeNull();
    expect(document.activeElement).toBe(log);
  });

  it('keeps the stack and every draft through a trip to Today', () => {
    seedConversation('c1');
    renderShell([{ kind: 'history' }, { kind: 'conversation', id: 'c1' }]);
    fireEvent.change(dockInput(), { target: { value: 'and after lunch?' } });

    act(() => useMobileNavStore.getState().setActiveTab('today'));
    expect(document.querySelector('[data-ask-tab]')).toBeNull();
    act(() => useMobileNavStore.getState().setActiveTab('chat'));

    expect(phone()).toEqual([{ kind: 'history' }, { kind: 'conversation', id: 'c1' }]);
    expect(screen.getByText('Two items are open.')).toBeInTheDocument();
    expect(dockInput().value).toBe('and after lunch?');
  });
});

describe('items push over Ask while the tab is mounted', () => {
  it("counts the tab in an effect, so StrictMode's mount, unmount, mount leaves one host and an unmount none", () => {
    const { unmount } = render(
      <StrictMode>
        <AskTab />
      </StrictMode>
    );
    expect(rail().phoneAskHosts).toBe(1);
    unmount();
    expect(rail().phoneAskHosts).toBe(0);
    // Gone with the last host: the drawer again.
    act(() => openEditFor(TASK, 'task'));
    expect(useUIStore.getState().activeDialog?.type).toBe('edit-item');
    expect(phone()).toEqual([]);
  });

  it('a release is spent once, however often it is called', () => {
    const a = rail().hostPhoneAsk();
    const b = rail().hostPhoneAsk();
    a();
    a();
    expect(rail().phoneAskHosts).toBe(1);
    b();
    expect(rail().phoneAskHosts).toBe(0);
  });

  it('an openEditFor from inside Ask pushes the item inline, never the drawer', () => {
    renderShell([{ kind: 'history' }]);
    act(() => openEditFor(TASK, 'task'));

    expect(phone()).toEqual([{ kind: 'history' }, { kind: 'item', itemId: 'item-1' }]);
    expect(useUIStore.getState().activeDialog).toBeNull();
    expect(screen.getByTestId('ask-item')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Book the dentist')).toBeInTheDocument();
    expect(back()).toHaveAccessibleName('Back to History');
    // Inline: autosaved, nothing to close.
    expect(screen.queryByTestId('item-dialog-submit')).toBeNull();
    expect(screen.queryByTestId('item-dialog-close')).toBeNull();

    fireEvent.click(back());
    expect(phone()).toEqual([{ kind: 'history' }]);
  });

  it('Today keeps the drawer: nothing is intercepted while the tab is not mounted', () => {
    useMobileNavStore.setState({ activeTab: 'today' });
    renderShell();
    fireEvent.click(screen.getByTestId('today-row'));
    expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'edit-item', item: { id: 'item-1' } });
    expect(phone()).toEqual([]);
    expect(rail().phoneAskHosts).toBe(0);
  });

  it('nor once the tab has been left for Today', () => {
    renderShell();
    act(() => useMobileNavStore.getState().setActiveTab('today'));
    fireEvent.click(screen.getByTestId('today-row'));
    expect(useUIStore.getState().activeDialog?.type).toBe('edit-item');
    expect(phone()).toEqual([]);
  });

  it("a pushed item's delete confirm stays open through a planner write to that item", () => {
    renderShell([{ kind: 'item', itemId: 'item-1' }]);
    fireEvent.click(screen.getByTestId('item-dialog-delete'));
    const confirm = screen.getByTestId('item-dialog-delete-confirm');
    expect(confirm).toHaveAttribute('data-state', 'open');

    // A write lands on the item (the panel's own autosave, another device):
    // a new object for the same id, which must not read as a new payload.
    act(() => usePlannerStore.setState({ items: [{ ...TASK, title: 'Book the dentist, Tuesday' } as TaskItem] }));

    expect(screen.getByTestId('item-dialog-delete-confirm')).toHaveAttribute('data-state', 'open');
    expect(phone()).toEqual([{ kind: 'item', itemId: 'item-1' }]);
  });

  it('an item deleted while it is pushed shows the view beneath', () => {
    renderShell([{ kind: 'history' }, { kind: 'item', itemId: 'item-1' }]);
    act(() => usePlannerStore.setState({ items: [] }));
    expect(phone()).toEqual([{ kind: 'history' }]);
  });
});

describe('swipe right', () => {
  it('is Back while anything is pushed, and walks to Today only from Ask home', () => {
    seedConversation('c1');
    renderShell([{ kind: 'history' }, { kind: 'conversation', id: 'c1' }]);

    act(() => swipe.handlers?.onSwipedRight?.());
    expect(phone()).toEqual([{ kind: 'history' }]);
    expect(tab()).toBe('chat');

    act(() => swipe.handlers?.onSwipedRight?.());
    expect(phone()).toEqual([]);
    expect(tab()).toBe('chat');

    act(() => swipe.handlers?.onSwipedRight?.());
    expect(tab()).toBe('today');
  });

  it('on Today is the plain tab walk, whatever the Ask stack holds', () => {
    useMobileNavStore.setState({ activeTab: 'today' });
    renderShell([{ kind: 'history' }]);
    act(() => swipe.handlers?.onSwipedRight?.());
    expect(tab()).toBe('braindump');
    expect(phone()).toEqual([{ kind: 'history' }]);
  });
});

describe("the dock's box", () => {
  it('follows the top view: a new conversation from home, a reply in a conversation, an ask about an item', () => {
    seedConversation('c1');
    renderShell();
    expect(dockInput()).toHaveAttribute('placeholder', 'Ask anything…');

    act(() => rail().push('phone', { kind: 'history' }));
    expect(dockInput()).toHaveAttribute('placeholder', 'Ask anything…');
    act(() => rail().push('phone', { kind: 'conversation', id: 'c1' }));
    expect(dockInput()).toHaveAttribute('placeholder', 'Reply…');
    act(() => rail().push('phone', { kind: 'item', itemId: 'item-1' }));
    expect(dockInput()).toHaveAttribute('placeholder', 'Ask about this item…');
  });

  it('a send from Ask home pushes the new conversation, and the tab shows it', async () => {
    renderShell();
    fireEvent.change(dockInput(), { target: { value: 'what is next?' } });
    fireEvent.keyDown(dockInput(), { key: 'Enter' });
    await act(() => flush());

    const top = phone().at(-1) as Extract<AskView, { kind: 'conversation' }>;
    expect(top.kind).toBe('conversation');
    expect(transport.inputs[0]).toMatchObject({ conversationId: top.id, message: 'what is next?' });
    expect(back()).toHaveAccessibleName('Back to Ask');
    const view = document.querySelector(`[data-ask-conversation="${top.id}"]`) as HTMLElement;
    expect(within(view).getByText('what is next?')).toBeInTheDocument();
    // The box that sent keeps the caret: the conversation is where typing goes on.
    expect(rail().pendingFocus).toBeNull();
  });

  it('a send from a pushed item asks in that item, pushing nothing', async () => {
    renderShell([{ kind: 'item', itemId: 'item-1' }]);
    fireEvent.change(dockInput(), { target: { value: 'what first?' } });
    fireEvent.keyDown(dockInput(), { key: 'Enter' });
    await act(() => flush());
    expect(phone()).toEqual([{ kind: 'item', itemId: 'item-1' }]);
    expect(transport.inputs[0]).toMatchObject({ message: 'what first?' });
    expect(useConversationsStore.getState().threads[transport.inputs[0].conversationId]?.itemId).toBe('item-1');
  });

  it.each([
    ['the model id', CONNECTED_MODEL, 'gpt-4o-mini'],
    ['OpenClaw and its agent', OPENCLAW_PLUGIN, 'OpenClaw · kirby-1'],
  ])('names who answers under it, at home and in a conversation: %s', (_, seed, label) => {
    unseed();
    unseed = seedAI(seed);
    seedConversation('c1');
    renderShell();
    const dock = screen.getByTestId('mobile-dock');
    expect(within(dock).getByTestId('answerer-label')).toHaveTextContent(label);
    act(() => rail().push('phone', { kind: 'conversation', id: 'c1' }));
    expect(within(dock).getByTestId('answerer-label')).toHaveTextContent(label);
    // One label: the conversation view brings no box, and so no label, of its own.
    expect(screen.getAllByTestId('answerer-label')).toHaveLength(1);
  });
});

describe('arriving on the tab', () => {
  async function arrive() {
    act(() => useMobileNavStore.getState().setActiveTab('chat'));
    await act(() => new Promise((r) => setTimeout(r, 0)));
  }

  it('puts the caret in the box only where typing is the point: a conversation or an item', async () => {
    useMobileNavStore.setState({ activeTab: 'today' });
    seedConversation('c1');
    renderShell();

    await arrive();
    expect(document.activeElement).not.toBe(dockInput());
    expect(rail().pendingFocus).toBeNull();

    act(() => useMobileNavStore.getState().setActiveTab('today'));
    act(() => rail().push('phone', { kind: 'history' }));
    await arrive();
    expect(document.activeElement).not.toBe(dockInput());

    act(() => useMobileNavStore.getState().setActiveTab('today'));
    act(() => rail().push('phone', { kind: 'conversation', id: 'c1' }));
    await arrive();
    await waitFor(() => expect(document.activeElement).toBe(dockInput()));

    act(() => {
      (document.activeElement as HTMLElement).blur();
      useMobileNavStore.getState().setActiveTab('today');
    });
    act(() => rail().push('phone', { kind: 'item', itemId: 'item-1' }));
    await arrive();
    await waitFor(() => expect(document.activeElement).toBe(dockInput()));
  });

  it("the mode sheet's focus return asks the same question", () => {
    // The sheet hands focus back to the mode card unless the box is about to
    // take it (mode-switcher-sheet.tsx onCloseAutoFocus); vaul never unmounts
    // its content under jsdom, so the predicate both read is pinned here.
    expect(phoneArrivalFocuses([])).toBe(false);
    expect(phoneArrivalFocuses([{ kind: 'history' }])).toBe(false);
    expect(phoneArrivalFocuses([{ kind: 'history' }, { kind: 'conversation', id: 'c1' }])).toBe(true);
    expect(phoneArrivalFocuses([{ kind: 'item', itemId: 'item-1' }])).toBe(true);
  });

  it('an explicit open (`?`, "Ask AI") asks for the box at any view', async () => {
    useMobileNavStore.setState({ activeTab: 'today' });
    renderShell();
    const { revealChat } = await import('@/lib/open-chat');
    act(() => {
      revealChat(true);
    });
    await act(() => new Promise((r) => setTimeout(r, 0)));
    await waitFor(() => expect(document.activeElement).toBe(dockInput()));
    expect(phone()).toEqual([]);
  });
});

describe("a conversation's card", () => {
  it('survives a switch to Today and back', () => {
    seedConversation('c1');
    renderShell([{ kind: 'conversation', id: 'c1' }]);
    act(() =>
      useProposalStore.setState({
        status: 'ready',
        error: null,
        proposal: {
          id: 'plan-1',
          summary: 'A lighter week',
          operations: [{ kind: 'create' as const, itemType: 'task', title: 'Call the bank' }],
          createdAt: '2026-10-01T00:00:00.000Z',
        },
        lastRequest: { intent: 'ask', prompt: 'plan it', surface: 'conv:c1' },
      })
    );
    const tabRoot = () => document.querySelector('[data-ask-tab]') as HTMLElement;
    expect(within(tabRoot()).getByTestId('proposal-card')).toHaveTextContent('A lighter week');

    act(() => useMobileNavStore.getState().setActiveTab('today'));
    expect(useProposalStore.getState().status).toBe('ready');

    act(() => useMobileNavStore.getState().setActiveTab('chat'));
    expect(within(tabRoot()).getByTestId('proposal-card')).toHaveTextContent('A lighter week');
    expect(screen.getAllByTestId('proposal-card')).toHaveLength(1);
  });
});

describe('the History button', () => {
  it('is named "History", and is gone while saving is off (nothing to list)', () => {
    renderShell();
    expect(screen.getByRole('button', { name: 'History' })).toHaveAttribute('title', 'History');
    act(() => useConversationsStore.setState({ saving: 'off' }));
    expect(screen.queryByRole('button', { name: 'History' })).toBeNull();
  });
});
