import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';

/**
 * Phase 3 of the mobile redesign: content on the paper backdrop, and the two
 * dateless tabs' shells.
 *
 * What is worth pinning here is not the flattening — the panel's removal is a
 * deleted wrapper, and a test asserting a class is absent pins the class, not
 * the design. It is the two SHARED components that grew a mobile variant, and
 * the one thing that variant must not do: leak onto desktop. Braindump is the
 * sidebar's whole body and ChatConversation is the desktop chat panel's, so an
 * unguarded default in either is a desktop regression, not a mobile one.
 *
 * The other contract is the Beacon composer's single mount. Its field moved
 * into the dock, so the conversation must stop rendering one — two text fields
 * on that tab, the upper of them a decoy, is the failure mode.
 */

// RelayField (the braindump's empty-state backdrop) reads prefers-reduced-motion.
beforeAll(() => {
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
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

import { Braindump } from '@/components/sidebar/braindump';
import { ChatConversation } from '@/components/ai/chat-conversation';
import { MobileChatPanel } from '@/components/mobile/mobile-chat-panel';
import { useAISettingsStore } from '@/lib/ai-settings-store';
import { useChatStore } from '@/lib/chat-store';
import { usePlannerStore } from '@/lib/planner-store';

beforeEach(() => {
  usePlannerStore.setState({
    userId: 'user-1',
    userTimezone: 'UTC',
    items: [],
    tasks: [],
    habits: [],
    projects: [],
    routines: [],
    seasons: [],
  });
  useAISettingsStore.setState({ provider: 'anthropic' });
  useChatStore.setState({ messages: [], isLoading: false, openclawAgentIdDisplay: null });
});
afterEach(cleanup);

/** The user menu the phone shell hangs in the dateless tabs' header capsule. */
const AVATAR = <button aria-label="User menu">K</button>;

/** ReactMarkdown wraps the reply in a <p>; its parent is the prose block. */
const replyBlock = (text: string) => screen.getByText(text).parentElement;

describe('the Braindump header, shared by the sidebar and the phone tab', () => {
  const renderBraindump = (props: Parameters<typeof Braindump>[0]) =>
    render(
      <DndContext>
        <Braindump {...props} />
      </DndContext>
    );

  /** The outer surface-3 capsule, reached from the title it frames. */
  const capsule = () =>
    screen.getByRole('heading', { name: /Braindump/ }).closest('div')?.parentElement;

  it('carries the user menu on the phone, where this capsule is the only header', () => {
    renderBraindump({ variant: 'mobile', headerAccessory: AVATAR });
    expect(screen.getByRole('button', { name: 'User menu' })).toBeInTheDocument();
    // Inset off the screen edge, so it lines up with the dated tabs' header
    // card and with the dock rather than running full-bleed under the notch.
    expect(capsule()).toHaveClass('mx-[10px]');
  });

  it('leaves the sidebar mount exactly as it was', () => {
    renderBraindump({});
    // The desktop shell has its own user menu in the canvas header; a second
    // one here would also make `waitForAppReady`'s lookup ambiguous.
    expect(screen.queryByRole('button', { name: 'User menu' })).toBeNull();
    // Flush to the sidebar column, which has no gutter of its own. The phone
    // shell has one, so only the mobile variant insets off the screen edge.
    expect(capsule()).not.toHaveClass('mx-[10px]');
  });

  it('keeps the list controls on both, in the same row-pill', () => {
    renderBraindump({ variant: 'mobile', headerAccessory: AVATAR });
    expect(screen.getByRole('button', { name: 'Organize projects & groups' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add task' })).toBeInTheDocument();
  });
});

describe('the Beacon tab shell', () => {
  it('titles the capsule after the agent that is answering', () => {
    useAISettingsStore.setState({ provider: 'openclaw' });
    useChatStore.setState({ openclawAgentIdDisplay: 'kirby-1' });
    render(<MobileChatPanel headerAccessory={AVATAR} />);

    expect(screen.getByRole('heading', { name: 'OpenClaw · kirby-1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'User menu' })).toBeInTheDocument();
  });

  it('brings no composer of its own — the dock owns the field', () => {
    render(<MobileChatPanel />);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('cards Beacon’s replies, which have nothing else bounding them on paper', () => {
    useChatStore.setState({ messages: [{ role: 'assistant', content: 'Two items are open.' }] });
    render(<MobileChatPanel />);

    // design/mobile-redesign/ChatTab.dc.html: surface-2, hairline, soft shadow.
    // Without it the user's bubble is the only carded turn on the screen.
    expect(replyBlock('Two items are open.')?.className).toMatch(/bg-surface-2/);
  });

  it('opens with one header, not a header under a header', () => {
    render(<MobileChatPanel />);
    // ChatConversation's own provider strip is suppressed; the capsule title
    // says the same thing one line higher.
    expect(screen.getAllByText('Beacon')).toHaveLength(1);
  });
});

describe('the desktop conversation', () => {
  it('still renders its composer when nothing asks it not to', () => {
    render(<ChatConversation variant="desktop" hideHeader />);
    expect(screen.getByPlaceholderText('Message Beacon...')).toBeInTheDocument();
  });

  it('leaves its replies flat — the sidebar panel is already the card', () => {
    useChatStore.setState({ messages: [{ role: 'assistant', content: 'Two items are open.' }] });
    render(<ChatConversation variant="desktop" hideHeader />);

    expect(replyBlock('Two items are open.')?.className).not.toMatch(/bg-surface-2/);
  });
});
