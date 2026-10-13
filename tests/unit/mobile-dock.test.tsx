import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

/**
 * The phone dock as the iPhone app lays it out (mobile web round 3): the
 * capture bar (the dock's omnibar as a capsule, with the braindump count that
 * opens the braindump sheet), the Today · Ask · Organize tab pill, the Search
 * circle, and the fold to one row.
 *
 * The tab pill carries `data-tour="mode-card"`, the onboarding tour's phone
 * spotlight, and `data-surface`, which the e2e helper `switchMobileTab` reads.
 *
 * The toast anchor is here for the other reason a dock change could go quietly
 * wrong: the undo toast is placed from a measurement of the dock.
 */

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  fetchRoutines: vi.fn(async () => []),
  fetchSeasons: vi.fn(async () => []),
  fetchGoals: vi.fn(async () => []),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
  })),
}));
// The omnibar's command context reaches for the router.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

import { MobileBottomDock } from '@/components/mobile/mobile-bottom-dock';
import { Omnibar } from '@/components/sidebar/omnibar';
import { useMobileNavStore } from '@/lib/mobile-nav-store';
import { chatTransport } from '@/lib/chat-transport';
import { httpConversationsApi } from '@/lib/conversations-api';
import {
  clearChatState,
  configureConversations,
  conversationsSettled,
  useConversationsStore,
} from '@/lib/conversations-store';
import { useRailStore } from '@/lib/rail-store';
import {
  AI_HIDDEN,
  CONNECTED_MODEL,
  KEY_TURNED_DOWN,
  NOTHING_CONNECTED,
  OPENCLAW_PLUGIN,
  seedAI,
  type SeedAI,
} from './helpers/ai-fixtures';
import { fakeApi, fakeTransport, flush, hangs, type FakeTransport } from './helpers/conversations-fakes';

/** Where the stubbed layout puts the dock's top edge, in a 800px-tall viewport. */
const DOCK_TOP = 724;
const VIEWPORT_HEIGHT = 800;

const realGetBoundingClientRect = Element.prototype.getBoundingClientRect;

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

  window.innerHeight = VIEWPORT_HEIGHT;
  // jsdom lays nothing out, so every rect is zero. Giving ONLY the dock's outer
  // box a top is what makes the anchor assertion below meaningful: if the ref
  // ever slides onto an inner element, the published value changes.
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
    const top = this.getAttribute('data-testid') === 'mobile-dock' ? DOCK_TOP : 0;
    return { top, bottom: VIEWPORT_HEIGHT, left: 0, right: 0, width: 0, height: 0, x: 0, y: top };
  } as Element['getBoundingClientRect'];
});

// Restored rather than left patched: vitest's per-file environment contains the
// blast radius today, but a prototype this broad outliving its file is the kind
// of thing that makes an unrelated suite fail mysteriously once environments are
// ever shared.
afterAll(() => {
  Element.prototype.getBoundingClientRect = realGetBoundingClientRect;
});

/**
 * A connected model by default: most of this file is about the chat tab and
 * the routes to it, which exist only while something can answer. The cases
 * about the gate itself re-seed.
 */
let unseed: () => void = () => {};
beforeEach(() => {
  useMobileNavStore.setState({ activeTab: 'today', braindumpOpen: false, dockMinimized: false });
  useRailStore.getState().reset();
  unseed = seedAI(CONNECTED_MODEL);
  document.documentElement.style.removeProperty('--toast-bottom');
});
afterEach(() => {
  cleanup();
  unseed();
});

const pill = () => screen.getByTestId('mobile-tab-pill');
const askKey = () => screen.queryByTestId('mobile-tab-chat');
/** The AI's mark on the Ask key (components/ai/ask-mark.tsx). */
const askMark = () => askKey()?.querySelector('[data-ask-mark]') ?? null;

describe('the tab pill', () => {
  it('shows Today, Ask and Organize, with the one you are on selected', () => {
    render(<MobileBottomDock />);
    expect(pill()).toHaveAttribute('data-surface', 'today');
    expect(screen.getByTestId('mobile-tab-today')).toHaveAttribute('aria-current', 'page');
    expect(askKey()).toHaveTextContent('Ask');
    expect(askKey()).not.toHaveAttribute('aria-current');
    expect(screen.getByTestId('mobile-tab-organize')).toHaveTextContent('Organize');
  });

  it("is the tour's spotlight on the phone, at every mobile step", () => {
    // onboarding-tour.tsx `tourSpotlightSelector`: renamed, every phone step
    // would draw a plain scrim with nothing lit, the AI card's included.
    render(<MobileBottomDock />);
    expect(pill()).toHaveAttribute('data-tour', 'mode-card');
    expect(document.querySelectorAll('[data-tour="mode-card"]')).toHaveLength(1);
  });

  it('switches tab on a tap, and says the braindump sheet is on screen while it is', () => {
    render(<MobileBottomDock />);
    fireEvent.click(askKey()!);
    expect(useMobileNavStore.getState().activeTab).toBe('chat');
    expect(pill()).toHaveAttribute('data-surface', 'chat');

    fireEvent.click(screen.getByTestId('mobile-tab-today'));
    act(() => useMobileNavStore.getState().setBraindumpOpen(true));
    expect(pill()).toHaveAttribute('data-surface', 'braindump');
  });

  it('calls it Ask whoever answers: the label under the bar names the answerer (D11)', () => {
    unseed();
    unseed = seedAI(OPENCLAW_PLUGIN);
    useMobileNavStore.setState({ activeTab: 'chat' });
    render(<MobileBottomDock />);

    expect(askKey()).toHaveTextContent('Ask');
    expect(screen.getByTestId('answerer-label')).toHaveTextContent('OpenClaw · kirby-1');
  });

  it("wears Ask's one-ink mark on the Ask key, not the lit aurora", () => {
    render(<MobileBottomDock />);
    expect(askMark()).toHaveAttribute('data-tone', 'ink');
    expect(askMark()).not.toHaveAttribute('data-lit');
  });

  it.each<[string, SeedAI | undefined]>([
    ['the account has said No AI', AI_HIDDEN],
    ['the gate has not answered', undefined],
  ])('has no Ask key, and never says it is on Ask, while it is not offered: %s', (_, s) => {
    unseed();
    unseed = seedAI(s);
    useMobileNavStore.setState({ activeTab: 'chat' });
    render(<MobileBottomDock />);

    // The shell shows Today for this stored tab in the same frame; the pill
    // and the bar agree with what is on screen, not with the stale store.
    expect(pill()).toHaveAttribute('data-surface', 'today');
    expect(askKey()).toBeNull();
    expect(screen.queryByTestId('chat-dock-input')).toBeNull();
    expect(screen.getByTestId('omnibar-input')).toBeInTheDocument();
  });

  // Nothing answers, but the gate invites or offers the fix: the Ask key
  // holds the setup page, named for it, in the unlit mark the desktop's key
  // wears. The bar stays the omnibar: there is no conversation to type into,
  // and capture still belongs to it.
  it.each<[string, SeedAI, string]>([
    ['invited', NOTHING_CONNECTED, 'Set up AI'],
    ['offering the fix', KEY_TURNED_DOWN, 'Fix AI'],
  ])('names the setup page while the gate is %s, and keeps the omnibar there', (_, s, word) => {
    unseed();
    unseed = seedAI(s);
    useMobileNavStore.setState({ activeTab: 'chat' });
    render(<MobileBottomDock />);

    expect(pill()).toHaveAttribute('data-surface', 'chat');
    expect(askKey()).toHaveTextContent(word);
    expect(askMark()).toHaveAttribute('data-tone', 'aurora');
    expect(askMark()).toHaveAttribute('data-lit', 'false');
    expect(screen.getByTestId('omnibar-input')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-dock-input')).toBeNull();
    expect(screen.queryByTestId('answerer-label')).toBeNull();
  });
});

describe('the capture bar', () => {
  it('is the dock omnibar, as the capsule, leading with the iPhone line', () => {
    render(<MobileBottomDock />);
    expect(screen.getByTestId('omnibar-input')).toHaveAttribute('placeholder', 'Get it out of your head');
    expect(document.querySelector('[data-omnibar-variant="dock"]')).not.toBeNull();
  });

  it('opens and closes the braindump sheet from its count', () => {
    render(<MobileBottomDock />);
    const count = screen.getByTestId('mobile-braindump-count');
    expect(count).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(count);
    expect(useMobileNavStore.getState().braindumpOpen).toBe(true);
    expect(count).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(count);
    expect(useMobileNavStore.getState().braindumpOpen).toBe(false);
  });

  it('folds to one row on Today, keeping the same field, and a tap on the lime circle unfolds it', () => {
    render(<MobileBottomDock />);
    const input = screen.getByTestId('omnibar-input');
    act(() => useMobileNavStore.getState().setDockMinimized(true));

    expect(screen.getByTestId('mobile-dock')).toHaveAttribute('data-minimized', 'true');
    expect(screen.queryByTestId('mobile-tab-pill')).toBeNull();
    // The same element: a fold never drops what is typed.
    expect(screen.getByTestId('omnibar-input')).toBe(input);
    expect(input).toHaveAttribute('placeholder', 'Capture');

    fireEvent.click(screen.getByTestId('mobile-dock-unfold'));
    expect(screen.getByTestId('mobile-dock')).toHaveAttribute('data-minimized', 'false');
    expect(pill()).toBeInTheDocument();
  });

  it('never folds on Ask', () => {
    useMobileNavStore.setState({ activeTab: 'chat', dockMinimized: true });
    render(<MobileBottomDock />);
    expect(screen.getByTestId('mobile-dock')).toHaveAttribute('data-minimized', 'false');
  });
});

describe('the omnibar in the dock', () => {
  /** Focus is what opens the results panel. */
  const openPanel = () => fireEvent.focus(screen.getByTestId('omnibar-input'));

  it('keeps both routes to chat that a phone still has', async () => {
    render(<MobileBottomDock />);
    openPanel();

    // The row is the only route from typed text to chat on a phone — there is
    // no ⌘Enter, and the mode card carries no query. The hint beside it is the
    // only mention of the `?` prefix anywhere on the screen, so it earns its
    // place here more than it does on desktop, not less; the dock is the same
    // Omnibar desktop mounts and takes nothing off it.
    expect(await screen.findByText(/Ask AI/)).toBeInTheDocument();
    expect(screen.getByText(/\? chat/)).toBeInTheDocument();
  });

  it('offers neither route while nothing can answer', async () => {
    unseed();
    unseed = seedAI(NOTHING_CONNECTED);
    render(<MobileBottomDock />);
    openPanel();

    // The hint row renders only while the bar is EMPTY, so the hint is checked
    // before anything is typed. `commands` sits in the same row, so its presence
    // proves the row is up and an absent `? chat` is the gate.
    expect(await screen.findByText(/commands/)).toBeInTheDocument();
    expect(screen.queryByText(/\? chat/)).toBeNull();

    fireEvent.change(screen.getByTestId('omnibar-input'), { target: { value: 'plan my day' } });

    // Something renders for the typed text (the add row), so an absent Ask row
    // is the gate, not an empty panel.
    await waitFor(() => expect(screen.queryAllByText(/plan my day/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/Ask AI|Ask OpenClaw/)).toBeNull();
  });

  it('is the same panel desktop gets', async () => {
    render(<Omnibar />);
    openPanel();

    expect(await screen.findByText(/\? chat/)).toBeInTheDocument();
  });

  it('hands the bar to the chat composer on the chat tab', () => {
    useMobileNavStore.setState({ activeTab: 'chat' });
    render(<MobileBottomDock />);

    // Swapped, not removed. Phase 2 gated the omnibar off this tab and left the
    // well holding a 44px card and ~300px of nothing, which read as chrome that
    // had failed to load; the composer that used to sit at the foot of the
    // conversation fills the row instead.
    expect(screen.queryByTestId('omnibar-input')).toBeNull();
    expect(screen.getByTestId('chat-dock-input')).toBeInTheDocument();
    expect(document.querySelector('[data-dock-surface]')?.className).not.toContain('w-fit');
  });

  it('names the field after whoever is answering, and says who that is under it', () => {
    useMobileNavStore.setState({ activeTab: 'chat' });
    render(<MobileBottomDock />);

    expect(screen.getByTestId('chat-dock-input')).toHaveAttribute(
      'placeholder',
      'Ask anything…'
    );
    expect(screen.getByTestId('answerer-label')).toHaveTextContent('GPT-4o mini');
  });

  it('shows no answerer label off the Ask tab', () => {
    render(<MobileBottomDock />);
    expect(screen.queryByTestId('answerer-label')).toBeNull();
  });
});

describe('the chat composer in the dock', () => {
  const input = () => screen.getByTestId('chat-dock-input') as HTMLTextAreaElement;
  /** The real conversations store over fakes: a send is a turn this sees. */
  let transport: FakeTransport;

  beforeEach(() => {
    useMobileNavStore.setState({ activeTab: 'chat' });
    transport = fakeTransport();
    configureConversations({ api: fakeApi().api, transport: transport.transport });
    clearChatState();
  });

  afterEach(async () => {
    await conversationsSettled();
    configureConversations({ api: httpConversationsApi, transport: chatTransport });
  });

  it('sends on Enter and clears, and newlines on Shift+Enter', async () => {
    render(<MobileBottomDock />);

    fireEvent.change(input(), { target: { value: 'plan my afternoon' } });
    fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true });
    await act(() => flush());
    expect(transport.inputs).toEqual([]);
    expect(input().value).toBe('plan my afternoon');

    fireEvent.keyDown(input(), { key: 'Enter' });
    await act(() => flush());
    // At Ask home: a new conversation, pushed on the phone's stack.
    expect(transport.inputs.map((i) => i.message)).toEqual(['plan my afternoon']);
    const top = useRailStore.getState().stacks.phone.at(-1);
    expect(top).toEqual({ kind: 'conversation', id: transport.inputs[0].conversationId });
    expect(useRailStore.getState().stacks.desktop).toEqual([]);
    expect(input().value).toBe('');
  });

  it('lets an IME keep Enter for committing its candidate', async () => {
    render(<MobileBottomDock />);

    fireEvent.change(input(), { target: { value: 'こんにち' } });
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true });
    await act(() => flush());

    expect(transport.inputs).toEqual([]);
    expect(input().value).toBe('こんにち');
  });

  it('will not send whitespace, and stands down mid-stream', async () => {
    // A reply still arriving in the conversation the dock is bound to.
    const reply = hangs();
    transport.next = reply.run;
    const id = useConversationsStore.getState().newDraft();
    useRailStore.getState().push('phone', { kind: 'conversation', id });
    void useConversationsStore.getState().send(id, 'earlier');
    render(<MobileBottomDock />);

    fireEvent.change(input(), { target: { value: '   ' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await act(() => flush());
    expect(transport.inputs.map((i) => i.message)).toEqual(['earlier']);
    expect(input()).toBeDisabled();

    await act(async () => {
      reply.release('done');
      await flush();
    });
    expect(input()).not.toBeDisabled();
  });

  it('shows the send button only once there is something to send', () => {
    render(<MobileBottomDock />);
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();

    fireEvent.change(input(), { target: { value: 'hi' } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  // A connect on the setup page lights the gate before it pops the phone's
  // stack home (connect-ai.tsx's `succeed` runs after the store's write), so
  // for that moment the dock sees Ask over whatever the stack kept from
  // before. Nobody arrived: no caret, no keyboard over "It works.".
  it('takes no caret when the setup page turns into Ask under it, whatever the stack kept', async () => {
    unseed();
    unseed = seedAI(NOTHING_CONNECTED);
    const id = useConversationsStore.getState().newDraft();
    useRailStore.getState().push('phone', { kind: 'conversation', id });
    render(<MobileBottomDock />);
    expect(screen.queryByTestId('chat-dock-input')).toBeNull();

    act(() => {
      seedAI(CONNECTED_MODEL);
    });
    await act(() => new Promise((r) => setTimeout(r, 0)));

    expect(input()).toBeInTheDocument();
    expect(document.activeElement).not.toBe(input());
    expect(useRailStore.getState().pendingFocus).toBeNull();
  });

  it('still takes it arriving on Ask from another tab over that stack', async () => {
    useMobileNavStore.setState({ activeTab: 'today' });
    const id = useConversationsStore.getState().newDraft();
    useRailStore.getState().push('phone', { kind: 'conversation', id });
    render(<MobileBottomDock />);

    act(() => useMobileNavStore.getState().setActiveTab('chat'));
    await waitFor(() => expect(document.activeElement).toBe(input()));
  });

  it("follows the top of the phone's stack: the binding, its wording, and its own half-typed text", () => {
    const rail = () => useRailStore.getState();
    render(<MobileBottomDock />);
    fireEvent.change(input(), { target: { value: 'for home' } });

    const id = useConversationsStore.getState().newDraft();
    act(() => rail().push('phone', { kind: 'conversation', id }));
    // A new chat has nothing to reply to yet.
    expect(input()).toHaveAttribute('placeholder', 'Ask anything…');
    expect(input().value).toBe('');
    fireEvent.change(input(), { target: { value: 'for the chat' } });

    act(() => rail().push('phone', { kind: 'item', itemId: 'i1' }));
    expect(input()).toHaveAttribute('placeholder', 'Ask about this item…');
    expect(input().value).toBe('');

    act(() => rail().back('phone'));
    expect(input().value).toBe('for the chat');
    act(() => rail().back('phone'));
    expect(input().value).toBe('for home');
    expect(input()).toHaveAttribute('placeholder', 'Ask anything…');
  });

  it('keeps every draft through a trip to Today, which swaps the bar for the omnibar', () => {
    const id = useConversationsStore.getState().newDraft();
    useRailStore.getState().push('phone', { kind: 'conversation', id });
    render(<MobileBottomDock />);
    fireEvent.change(input(), { target: { value: 'half a thought' } });

    act(() => useMobileNavStore.setState({ activeTab: 'today' }));
    expect(screen.queryByTestId('chat-dock-input')).toBeNull();
    act(() => useMobileNavStore.setState({ activeTab: 'chat' }));
    expect(input().value).toBe('half a thought');
    expect(useRailStore.getState().stacks.phone).toEqual([{ kind: 'conversation', id }]);
  });

  it("says Reply… under a conversation that has something to reply to", async () => {
    const id = useConversationsStore.getState().newDraft();
    await useConversationsStore.getState().send(id, 'earlier');
    useRailStore.getState().push('phone', { kind: 'conversation', id });
    render(<MobileBottomDock />);
    expect(input()).toHaveAttribute('placeholder', 'Reply…');
    expect(screen.getByTestId('answerer-label')).toHaveTextContent('GPT-4o mini');
  });
});

describe('the toast anchor', () => {
  it('publishes the dock’s own top edge, not an inner row’s', () => {
    render(<MobileBottomDock />);

    // innerHeight − top + 8. Measured rather than assumed is the whole point:
    // this dock shed ~55px in the redesign and the toast followed it for free.
    expect(document.documentElement.style.getPropertyValue('--toast-bottom')).toBe(
      `${VIEWPORT_HEIGHT - DOCK_TOP + 8}px`
    );
  });
});
