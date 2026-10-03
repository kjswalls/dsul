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
 * sidebar's whole body and ConversationView is the desktop rail's, so an
 * unguarded default in either is a desktop regression, not a mobile one.
 *
 * The other contract is the chat composer's single mount. Its field moved
 * into the dock, so the Ask tab must render none of its own (no Ask home box,
 * no conversation box): two text fields on that tab, the upper of them a
 * decoy, is the failure mode. The tab's own stack, focus and items are
 * tests/unit/ask-tab.test.tsx.
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
  // Ask home reads the agents' freshness on mount (hooks/use-agent-freshness.ts).
  fetchAgentStates: vi.fn(async () => []),
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
import { ConversationView } from '@/components/ai/ask/conversation-view';
import { AskTab } from '@/components/mobile/ask-tab';
import { chatTransport } from '@/lib/chat-transport';
import { httpConversationsApi } from '@/lib/conversations-api';
import {
  clearChatState,
  configureConversations,
  useConversationsStore,
  type ChatMessage,
} from '@/lib/conversations-store';
import { usePlannerStore } from '@/lib/planner-store';
import { useRailStore } from '@/lib/rail-store';
import { CONNECTED_MODEL, OPENCLAW_PLUGIN, seedAI } from './helpers/ai-fixtures';
import { fakeApi, fakeTransport } from './helpers/conversations-fakes';

let unseed: () => void = () => {};
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
  unseed = seedAI(CONNECTED_MODEL);
  configureConversations({ api: fakeApi().api, transport: fakeTransport().transport });
  clearChatState();
});
afterEach(() => {
  cleanup();
  unseed();
  configureConversations({ api: httpConversationsApi, transport: chatTransport });
});

/** The user menu the phone shell hangs in the dateless tabs' header capsule. */
const AVATAR = <button aria-label="User menu">K</button>;

/** A saved conversation, as a load leaves it, holding one reply. */
const CONV = 'c1';
function seedReply(content: string) {
  const id = CONV;
  const reply: ChatMessage = {
    id: 'reply-1',
    role: 'assistant',
    content,
    status: 'complete',
    errorCode: null,
    replyTo: null,
    answerer: 'model',
    model: null,
    createdAt: 1_759_400_000_000,
    pos: 1,
    sync: 'saved',
  };
  useConversationsStore.setState((s) => ({
    threads: {
      ...s.threads,
      [id]: {
        id,
        itemId: null,
        draftTitle: null,
        saved: true,
        messages: [reply],
        load: 'loaded',
        hasEarlier: false,
        streaming: false,
        typing: false,
        fetchedAt: Date.now(),
      },
    },
  }));
}

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

describe('the Ask tab shell', () => {
  it('titles the capsule "Ask" whoever answers, and carries the user menu', () => {
    unseed();
    unseed = seedAI(OPENCLAW_PLUGIN);
    render(<AskTab headerAccessory={AVATAR} />);

    // The answerer is named under the dock's bar (mobile-dock.test.tsx), not here.
    expect(screen.getByText('Ask')).toBeInTheDocument();
    expect(screen.queryByText(/OpenClaw · kirby-1/)).toBeNull();
    expect(screen.getByRole('button', { name: 'User menu' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'History' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument();
  });

  it('brings no composer of its own, at home or in a conversation — the dock owns the field', () => {
    render(<AskTab />);
    expect(screen.queryByRole('textbox')).toBeNull();
    cleanup();

    seedReply('Two items are open.');
    useRailStore.getState().push('phone', { kind: 'conversation', id: CONV });
    render(<AskTab />);
    expect(screen.getByText('Two items are open.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('leaves the replies plain on the phone too: one transcript, one look (D11)', () => {
    seedReply('Two items are open.');
    useRailStore.getState().push('phone', { kind: 'conversation', id: CONV });
    render(<AskTab />);
    expect(replyBlock('Two items are open.')?.className).not.toMatch(/bg-surface-2/);
  });

  it('has no ✕: the tab is the way out', () => {
    useRailStore.getState().push('phone', { kind: 'history' });
    render(<AskTab />);
    expect(screen.queryByRole('button', { name: /close/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Back to Ask' })).toBeInTheDocument();
  });
});

describe('the desktop conversation', () => {
  it('still renders its composer when nothing asks it not to', () => {
    seedReply('Two items are open.');
    render(<ConversationView id={CONV} />);
    expect(screen.getByPlaceholderText('Reply…')).toBeInTheDocument();
  });

  it('drops it only for the phone, whose box is the dock', () => {
    seedReply('Two items are open.');
    render(<ConversationView id={CONV} surface="phone" composer={false} />);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('leaves its replies flat — the rail is already the card', () => {
    seedReply('Two items are open.');
    render(<ConversationView id={CONV} />);

    expect(replyBlock('Two items are open.')?.className).not.toMatch(/bg-surface-2/);
  });
});
