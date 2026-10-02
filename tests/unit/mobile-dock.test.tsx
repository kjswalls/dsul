import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

/**
 * The redesigned mobile dock — the mode card, the sheet behind it, and the two
 * contracts that leave this file.
 *
 * The interesting part is not the styling. It is that retiring the tab bar moved
 * three `[data-tour="tab-*"]` handles INSIDE a sheet that is closed by default,
 * and two things outside this component read them: the onboarding tour, which
 * now spotlights the card instead, and three @mobile e2e specs, which go through
 * `switchMobileTab` and open the sheet first. A test that only asserted the
 * handles exist would pass with them mounted anywhere, including the one place
 * that breaks both readers — so the assertion here is that they are ABSENT until
 * the card is tapped.
 *
 * The toast anchor is here for the other reason a phase-2 change could go
 * quietly wrong: the dock lost ~55px of height, and the undo toast is placed
 * from a measurement of it.
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
import { useChatStore } from '@/lib/chat-store';
import { CONNECTED_MODEL, NOTHING_CONNECTED, OPENCLAW_PLUGIN, seedAI } from './helpers/ai-fixtures';

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
  useMobileNavStore.setState({ activeTab: 'today' });
  unseed = seedAI(CONNECTED_MODEL);
  document.documentElement.style.removeProperty('--toast-bottom');
});
afterEach(() => {
  cleanup();
  unseed();
});

const card = () => screen.getByTestId('mobile-mode-card');

describe('the mode card', () => {
  it('names the surface it is showing', () => {
    render(<MobileBottomDock />);
    expect(card()).toHaveAttribute('data-surface', 'today');
    expect(card()).toHaveAttribute('aria-label', 'Surface: Today. Change surface.');
  });

  it('follows the active surface, and names chat after whoever answers', () => {
    useMobileNavStore.setState({ activeTab: 'chat' });
    render(<MobileBottomDock />);

    expect(card()).toHaveAttribute('data-surface', 'chat');
    expect(card()).toHaveAttribute('aria-label', 'Surface: AI. Change surface.');
  });

  it('calls the chat surface OpenClaw when OpenClaw is the one answering', () => {
    unseed();
    unseed = seedAI(OPENCLAW_PLUGIN);
    useMobileNavStore.setState({ activeTab: 'chat' });
    render(<MobileBottomDock />);

    expect(card()).toHaveAttribute('aria-label', 'Surface: OpenClaw. Change surface.');
  });

  it('never says it is on a chat tab that cannot answer', () => {
    unseed();
    unseed = seedAI(NOTHING_CONNECTED);
    useMobileNavStore.setState({ activeTab: 'chat' });
    render(<MobileBottomDock />);

    // The shell shows Today for this stored tab in the same frame; the card
    // and the bar agree with what is on screen, not with the stale store.
    expect(card()).toHaveAttribute('data-surface', 'today');
    expect(screen.queryByTestId('chat-dock-input')).toBeNull();
    expect(screen.getByTestId('omnibar-input')).toBeInTheDocument();
  });

  it('carries no lime: the glyph alone says where you are', () => {
    render(<MobileBottomDock />);
    // Round 6 removed the highlight. `text-foreground` and nothing tinted —
    // spelled out because the tint is the kind of thing a later restyle
    // reintroduces "for affordance" without knowing it was decided against.
    expect(card().className).toContain('text-foreground');
    expect(card().className).not.toMatch(/primary|lime|text-ai/);
  });
});

describe('the switcher sheet', () => {
  it('keeps the tab handles out of the DOM until it is opened', async () => {
    render(<MobileBottomDock />);
    expect(document.querySelectorAll('[data-tour^="tab-"]')).toHaveLength(0);

    fireEvent.click(card());

    await waitFor(() => {
      expect(document.querySelectorAll('[data-tour^="tab-"]')).toHaveLength(3);
    });
    for (const tab of ['braindump', 'today', 'chat']) {
      expect(document.querySelector(`[data-tour="tab-${tab}"]`)).not.toBeNull();
    }
    expect(screen.getByTestId('mode-option-chat')).toHaveTextContent('AI');
  });

  it('lists only the surfaces that exist when nothing can answer', async () => {
    unseed();
    unseed = seedAI(NOTHING_CONNECTED);
    render(<MobileBottomDock />);
    fireEvent.click(card());

    await waitFor(() => {
      expect(document.querySelectorAll('[data-tour^="tab-"]')).toHaveLength(2);
    });
    expect(screen.queryByTestId('mode-option-chat')).toBeNull();
  });

  it('marks the surface you are on', async () => {
    render(<MobileBottomDock />);
    fireEvent.click(card());

    const today = await screen.findByTestId('mode-option-today');
    expect(today).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('mode-option-braindump')).not.toHaveAttribute('aria-current');
  });

  it('switches surface and closes', async () => {
    render(<MobileBottomDock />);
    fireEvent.click(card());
    const sheet = await screen.findByTestId('mode-switcher-sheet');

    fireEvent.click(screen.getByTestId('mode-option-braindump'));

    expect(useMobileNavStore.getState().activeTab).toBe('braindump');
    expect(card()).toHaveAttribute('data-surface', 'braindump');
    // `data-state`, not unmounting: vaul holds the content through its exit
    // transition, and jsdom fires no transitionend, so it never leaves the tree
    // here. The e2e helper waits for the real unmount because there the overlay
    // it takes with it is what would eat the next click.
    await waitFor(() => expect(sheet).toHaveAttribute('data-state', 'closed'));
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

  it('names the field after whoever is answering', () => {
    useMobileNavStore.setState({ activeTab: 'chat' });
    render(<MobileBottomDock />);

    expect(screen.getByTestId('chat-dock-input')).toHaveAttribute(
      'placeholder',
      'Ask anything…'
    );
  });
});

describe('the chat composer in the dock', () => {
  const input = () => screen.getByTestId('chat-dock-input') as HTMLTextAreaElement;

  beforeEach(() => {
    useMobileNavStore.setState({ activeTab: 'chat' });
    useChatStore.setState({ isLoading: false, send: vi.fn() });
  });

  it('sends on Enter and clears, and newlines on Shift+Enter', () => {
    const send = vi.fn();
    useChatStore.setState({ send });
    render(<MobileBottomDock />);

    fireEvent.change(input(), { target: { value: 'plan my afternoon' } });
    fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true });
    expect(send).not.toHaveBeenCalled();
    expect(input().value).toBe('plan my afternoon');

    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(send).toHaveBeenCalledWith('plan my afternoon');
    expect(input().value).toBe('');
  });

  it('lets an IME keep Enter for committing its candidate', () => {
    const send = vi.fn();
    useChatStore.setState({ send });
    render(<MobileBottomDock />);

    fireEvent.change(input(), { target: { value: 'こんにち' } });
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true });

    expect(send).not.toHaveBeenCalled();
    expect(input().value).toBe('こんにち');
  });

  it('will not send whitespace, and stands down mid-stream', () => {
    const send = vi.fn();
    useChatStore.setState({ send, isLoading: true });
    render(<MobileBottomDock />);

    fireEvent.change(input(), { target: { value: '   ' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(send).not.toHaveBeenCalled();
    expect(input()).toBeDisabled();
  });

  it('shows the send button only once there is something to send', () => {
    render(<MobileBottomDock />);
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();

    fireEvent.change(input(), { target: { value: 'hi' } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
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
