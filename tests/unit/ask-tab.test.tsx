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

/** What the shell's handlers read off a swipe: where it began. */
type Swiped = { event: { target: EventTarget } };
const swipe = vi.hoisted(() => ({
  handlers: null as null | { onSwipedLeft?: (e?: Swiped) => void; onSwipedRight?: (e?: Swiped) => void },
}));

// The shell's handlers: a row's (SwipeRow, which tracks its own start) never
// mounts here, but is told apart anyway.
vi.mock('react-swipeable', () => ({
  useSwipeable: (handlers: {
    onSwipedLeft?: (e?: Swiped) => void;
    onSwipedRight?: (e?: Swiped) => void;
    onSwipeStart?: unknown;
  }) => {
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
import { matchCommands, STATIC_COMMANDS, type CommandContext } from '@/lib/commands';
import { CONNECTED_MODEL, NOTHING_CONNECTED, OPENCLAW_PLUGIN, seedAI } from './helpers/ai-fixtures';
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

  // Ask home carries the lime accent (a run come back): nothing above the tab
  // may fade it in through an opacity, as the shell's tab cross-fade would.
  it('enters with no fade around it: no ancestor animates opacity', () => {
    useMobileNavStore.setState({ activeTab: 'today' });
    renderShell();
    act(() => useMobileNavStore.getState().setActiveTab('chat'));
    const tabRoot = document.querySelector('[data-ask-tab]') as HTMLElement;
    for (let el = tabRoot.parentElement; el; el = el.parentElement) {
      expect(el.className).not.toMatch(/fade-|opacity-/);
    }
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

  // A drag along a reply's long code line scrolls that line; it is not Back.
  it('is left to a code block that scrolls sideways, and is Back from anywhere else', () => {
    seedConversation('c1', 'Run this:\n\n```\nnpx supabase db push --include-all --linked --debug\n```');
    renderShell([{ kind: 'history' }, { kind: 'conversation', id: 'c1' }]);
    const pre = document.querySelector('[data-ask-conversation] pre, [data-testid="chat-transcript"] pre') as HTMLElement;
    expect(pre).not.toBeNull();
    // As laid out: 970px of line in a 350px box that scrolls it.
    pre.style.overflowX = 'auto';
    Object.defineProperty(pre, 'scrollWidth', { value: 970, configurable: true });
    Object.defineProperty(pre, 'clientWidth', { value: 350, configurable: true });
    const inLine = pre.querySelector('code') ?? pre;

    act(() => swipe.handlers?.onSwipedRight?.({ event: { target: inLine } }));
    act(() => swipe.handlers?.onSwipedLeft?.({ event: { target: inLine } }));
    expect(phone()).toEqual([{ kind: 'history' }, { kind: 'conversation', id: 'c1' }]);
    expect(tab()).toBe('chat');

    // A box that fits its content takes no swipe.
    Object.defineProperty(pre, 'scrollWidth', { value: 350, configurable: true });
    act(() => swipe.handlers?.onSwipedRight?.({ event: { target: inLine } }));
    expect(phone()).toEqual([{ kind: 'history' }]);
  });

  it('nor a tab change, either way, from inside something that scrolls sideways', () => {
    useMobileNavStore.setState({ activeTab: 'today' });
    renderShell();
    const strip = document.createElement('div');
    strip.style.overflowX = 'scroll';
    Object.defineProperty(strip, 'scrollWidth', { value: 900, configurable: true });
    Object.defineProperty(strip, 'clientWidth', { value: 390, configurable: true });
    screen.getByTestId('today-row').after(strip);
    act(() => swipe.handlers?.onSwipedLeft?.({ event: { target: strip } }));
    act(() => swipe.handlers?.onSwipedRight?.({ event: { target: strip } }));
    expect(tab()).toBe('today');
    strip.remove();
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
    // take it (mode-switcher-sheet.tsx onCloseAutoFocus, driven through a
    // stand-in drawer in mode-switcher-sheet.test.tsx); the predicate both
    // read is pinned here.
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

describe('Back to Ask home', () => {
  const WAITING = {
    ...TASK,
    id: 'item-2',
    title: 'Pick a plumber',
    assignee: 'openclaw',
    aiStatus: 'blocked',
    aiResult: 'Which one?',
  } as unknown as TaskItem;
  const WORKING = {
    ...TASK,
    id: 'item-3',
    title: 'Draft the invite',
    assignee: 'openclaw',
    aiStatus: 'working',
    aiStatusAt: new Date().toISOString(),
  } as unknown as TaskItem;

  /**
   * Ask home's scroller shows y 100–300, and the opener sits below that, at
   * y 400–430, until the scroller moves: the remounted home is back at its top.
   */
  function stubGeometry(opener: () => HTMLElement | null, grown: () => number = () => 0) {
    return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const rect = (top: number, bottom: number) =>
        ({ top, bottom, left: 0, right: 390, width: 390, height: bottom - top, x: 0, y: top }) as DOMRect;
      if (this.hasAttribute('data-ask-scroller')) return rect(100, 300);
      if (this === opener()) {
        const scrolled = (this.closest('[data-ask-scroller]') as HTMLElement | null)?.scrollTop ?? 0;
        return rect(400 + grown() - scrolled, 430 + grown() - scrolled);
      }
      return rect(0, 0);
    });
  }

  // A tap in WebKit focuses nothing, and jsdom's click does not either: the
  // opener must take focus itself, or the push records no `returnFocus` and
  // Back lands on the heading at the top.
  it.each([
    ['a Needs-you title', 'needs-you-title', WAITING],
    ['an activity row', 'ai-activity-row', WORKING],
  ])('hands focus back to %s that opened an item, scrolled into sight', async (_what, testId, item) => {
    usePlannerStore.setState({ items: [TASK, item] });
    renderShell();
    const opener = () => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    const geometry = stubGeometry(opener);
    try {
      expect(document.activeElement).toBe(document.body);
      fireEvent.click(opener()!);
      expect(phone()).toEqual([{ kind: 'item', itemId: item.id, returnFocus: expect.stringMatching(/:item-[23]$/) }]);

      fireEvent.click(back());
      expect(phone()).toEqual([]);
      await waitFor(() => expect(document.activeElement).toBe(opener()));
      const scroller = opener()!.closest('[data-ask-scroller]') as HTMLElement;
      // 430 - 300: just enough to bring its foot into the box.
      expect(scroller.scrollTop).toBe(130);
    } finally {
      geometry.mockRestore();
    }
  });

  // The remounted home settles a moment after Back: a Needs-you card's
  // question arrives and pushes every row under it down 33px.
  it('keeps the opener in sight while the view beneath settles, and only while it has focus', async () => {
    const RealRO = globalThis.ResizeObserver;
    const fired: (() => void)[] = [];
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        fired.push(() => cb([], this as unknown as ResizeObserver));
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    let grown = 0;
    usePlannerStore.setState({ items: [TASK, WORKING] });
    renderShell();
    const opener = () => document.querySelector<HTMLElement>('[data-testid="ai-activity-row"]');
    const geometry = stubGeometry(opener, () => grown);
    try {
      fireEvent.click(opener()!);
      fireEvent.click(back());
      await waitFor(() => expect(document.activeElement).toBe(opener()));
      const scroller = opener()!.closest('[data-ask-scroller]') as HTMLElement;
      await waitFor(() => expect(scroller.scrollTop).toBe(130));

      grown = 33;
      act(() => fired.forEach((fire) => fire()));
      expect(scroller.scrollTop).toBe(163);

      // Focus moved on: a later settle leaves the scroll alone.
      act(() => opener()!.blur());
      grown = 66;
      act(() => fired.forEach((fire) => fire()));
      expect(scroller.scrollTop).toBe(163);
    } finally {
      geometry.mockRestore();
      globalThis.ResizeObserver = RealRO;
    }
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

describe("the palette's Ask commands on the phone", () => {
  const phoneCtx: CommandContext = {
    theme: { resolved: 'light', value: 'light', set: () => {} },
    openChat: () => {},
    userId: 'user-1',
    isMobile: true,
  };
  const ids = () => matchCommands('', phoneCtx).map((r) => r.command.id);
  const run = (id: string) => act(() => void STATIC_COMMANDS.find((c) => c.id === id)!.run(phoneCtx));

  // D10 gates "New chat" and "Conversation history" on the AI (and History on
  // saving), never on the surface: the tab shows what both push.
  it('lists "New chat" and "Conversation history" while something answers, and neither with no AI', () => {
    expect(ids()).toEqual(expect.arrayContaining(['ask.newChat', 'ask.history']));
    act(() => useConversationsStore.setState({ saving: 'off' }));
    expect(ids()).toContain('ask.newChat');
    expect(ids()).not.toContain('ask.history');
    unseed();
    unseed = seedAI(NOTHING_CONNECTED);
    expect(ids()).not.toContain('ask.newChat');
    expect(ids()).not.toContain('ask.history');
  });

  it('"New chat" from Today shows the tab with a draft on top and the caret in its box', async () => {
    useMobileNavStore.setState({ activeTab: 'today' });
    renderShell();
    run('ask.newChat');
    expect(tab()).toBe('chat');
    expect(phone()).toMatchObject([{ kind: 'conversation' }]);
    expect(rail().stacks.desktop).toEqual([]);
    expect(back()).toHaveAccessibleName('Back to Ask');
    await waitFor(() => expect(document.activeElement).toBe(dockInput()));
  });

  it('"Conversation history" from Today shows History with its search field focused', async () => {
    useMobileNavStore.setState({ activeTab: 'today' });
    renderShell();
    run('ask.history');
    expect(tab()).toBe('chat');
    expect(phone()).toEqual([{ kind: 'history' }]);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('history-search')));
    expect(rail().pendingFocus).toBeNull();
  });

  // Catch-up lands on its card, which is tapped, not typed into: a box asked
  // for here would raise the keyboard over Apply and Not now.
  it('"Pick things back up" pops to Ask home and asks for no box', async () => {
    useMobileNavStore.setState({ activeTab: 'today' });
    renderShell([{ kind: 'history' }]);
    run('rituals.catchUp');
    expect(tab()).toBe('chat');
    expect(phone()).toEqual([]);
    expect(rail().pendingFocus).toBeNull();
    expect(useProposalStore.getState().lastRequest?.intent).toBe('catch-up');
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(document.activeElement).not.toBe(dockInput());
  });
});
