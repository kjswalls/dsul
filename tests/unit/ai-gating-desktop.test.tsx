import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, onTestFinished } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/**
 * The AI gate on every desktop and shared surface (design 5.3, "Desktop and
 * shared"): nothing that talks to an AI renders unless something can answer,
 * and while the server has not said (unknown) or could not say (error), the
 * answer is no.
 *
 * Four "no chat" states are walked, because each fails closed for a different
 * reason: the status has not loaded, its read failed, nothing is connected, and
 * the connected key stopped working. The connected cases then check the same
 * surfaces come back, named after whoever answers ("AI" for a model, "OpenClaw"
 * for OpenClaw).
 *
 * The gate is the REAL pair of stores, seeded through the shared fixture.
 */

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchHabitGroups: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  fetchRoutines: vi.fn(async () => []),
  fetchSeasons: vi.fn(async () => []),
  fetchGoals: vi.fn(async () => []),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('sonner', () => ({
  toast: Object.assign(() => 'id', { error: vi.fn(), dismiss: vi.fn() }),
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
  useSearchParams: () => new URLSearchParams(),
}));

import { Omnibar } from '@/components/sidebar/omnibar';
import { SidebarDock } from '@/components/sidebar/sidebar-dock';
import { RailColumn } from '@/components/shell/desktop-shell';
import { ProposalCard } from '@/components/ai/proposal-card';
import { useCommandShortcuts } from '@/hooks/use-command-shortcuts';
import { matchCommands, STATIC_COMMANDS, type CommandContext } from '@/lib/commands';
import { proposalCardShowsOn } from '@/lib/open-chat';
import { PANEL_OVERLAY_QUERY, useRailStore, type AskView } from '@/lib/rail-store';
import { getAICapabilities } from '@/lib/ai-connection-store';
import { useSidebarStore } from '@/lib/sidebar-store';
import { usePlannerStore } from '@/lib/planner-store';
import { chatTransport } from '@/lib/chat-transport';
import { httpConversationsApi } from '@/lib/conversations-api';
import {
  clearChatState,
  configureConversations,
  conversationsSettled,
  useConversationsStore,
} from '@/lib/conversations-store';
import { useProposalStore, type ProposalStatus, type ProposalSurface } from '@/lib/proposal-store';
import {
  seedAI,
  AI_HIDDEN,
  CONNECTED_MODEL,
  NOTHING_CONNECTED,
  OPENCLAW_PLUGIN,
  type SeedAI,
} from './helpers/ai-fixtures';
import { fakeApi, fakeTransport, flush, type FakeTransport } from './helpers/conversations-fakes';

/* ── fixtures ────────────────────────────────────────────────────────── */

const FAILING: SeedAI = {
  ...CONNECTED_MODEL,
  model: { provider: 'openai', model: 'gpt-4o-mini', status: 'failing', problem: 'key_rejected' },
};

/**
 * Every way the gate says "no chat", and what it offers instead: the setup
 * column ("Set up AI", `askInvite`), the fix ("Fix AI", `askFix`), or nothing.
 */
const NO_CHAT: Array<[string, SeedAI | undefined, 'invite' | 'fix' | null]> = [
  ['the status has not loaded', undefined, null],
  ['the status read failed', { phase: 'error' }, null],
  ['nothing is connected', NOTHING_CONNECTED, 'invite'],
  ['the key stopped working', FAILING, 'fix'],
  ['the account said No AI, thanks', AI_HIDDEN, null],
  ['the key stopped working, and the account said No AI, thanks', { ...FAILING, aiHidden: true }, null],
  ['the server cannot say whether AI is hidden', { ...NOTHING_CONNECTED, aiHidden: null }, null],
  ['chat is Off on this device', { ...NOTHING_CONNECTED, choice: 'none' }, null],
];

const desktopCtx: CommandContext = {
  theme: { resolved: 'light', value: 'light', set: () => {} },
  openChat: () => {},
  userId: 'u1',
  isMobile: false,
};

const CHAT_COMMANDS = ['rituals.chat', 'rituals.planDay', 'workspace.toggleChat', 'ask.newChat', 'ask.history'];

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
});

let unseed: () => void = () => {};
const seed = (o?: SeedAI) => {
  unseed();
  unseed = seedAI(o);
};

const addTask = vi.fn();
const originalAddTask = usePlannerStore.getState().addTask;
/** The real conversations store over fakes: a send is a turn this sees. */
let transport: FakeTransport;

beforeEach(() => {
  addTask.mockClear();
  // Spied, not stubbed out of existence: the assertion that matters is that
  // ⌘Enter without chat never files the text as a task.
  usePlannerStore.setState({ addTask });
  transport = fakeTransport();
  configureConversations({ api: fakeApi().api, transport: transport.transport });
  clearChatState();
  useSidebarStore.setState({ askOpen: false, leftSidebarOpen: true });
  useProposalStore.getState().dismiss();
});

afterEach(async () => {
  cleanup();
  await conversationsSettled();
  unseed();
  unseed = () => {};
  usePlannerStore.setState({ addTask: originalAddTask, userId: null });
  configureConversations({ api: httpConversationsApi, transport: chatTransport });
  useProposalStore.getState().dismiss();
});

/* ── helpers ─────────────────────────────────────────────────────────── */

const scopeFor = (variant: 'dock' | 'launcher') =>
  document.querySelector(`[data-omnibar-variant="${variant}"]`) as HTMLElement;
const inputIn = (variant: 'dock' | 'launcher') =>
  scopeFor(variant).querySelector('[data-testid="omnibar-input"]') as HTMLInputElement;

function renderDock(text?: string) {
  render(<Omnibar variant="dock" />);
  const input = inputIn('dock');
  fireEvent.focus(input);
  if (text !== undefined) fireEvent.change(input, { target: { value: text } });
  return input;
}

const askRow = () => document.querySelector('[data-value="action-chat"]');

function ShortcutHarness() {
  useCommandShortcuts(desktopCtx);
  return null;
}

/** Dispatches Ctrl+J at the window and reports whether anything claimed it. */
function pressToggleChat(): boolean {
  const event = new KeyboardEvent('keydown', {
    key: 'j',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'j', bubbles: true }));
  return event.defaultPrevented;
}

/**
 * The dock beside the right column, docked, with no item open: the two places
 * the catch-up card can live (Ask home, or the dock's host when Ask home
 * cannot carry it), both on screen as they are in the shell.
 */
function renderDockAndRail() {
  return render(
    <>
      <SidebarDock />
      <RailColumn
        panelState={null}
        onPanelOpenChange={() => {}}
        overlays={false}
        plate
        spread={false}
        flatPanel={false}
      />
    </>
  );
}

/** Ask's view in the rail, or null while it is not mounted. */
const askRail = () => document.querySelector<HTMLElement>('[data-rail-view]');

/**
 * The SidebarDock capsule's direct children, top to bottom, by what each one
 * is. Structure rather than a testid, because the regression this guards (an
 * unconditional `mb-3` wrapper around a conditional card) leaves the testid
 * absent and still opens a 12px gap above the user row. The relay ground is a
 * feature flag (RELAY.dock), so it is dropped rather than required.
 */
function capsuleRows(): string[] {
  const capsule = document.querySelector('[data-dock-surface]');
  if (!capsule) throw new Error('SidebarDock capsule not rendered');
  return Array.from(capsule.children)
    .map((el) => {
      if (el.getAttribute('aria-hidden') === 'true' && el.classList.contains('pointer-events-none')) {
        return 'relay';
      }
      if (el.getAttribute('data-testid') === 'dock-catch-up-host') return 'catch-up';
      if (el.querySelector('[aria-label="User menu"]')) return 'user';
      if (el.querySelector('[data-omnibar-variant="dock"]')) return 'omnibar';
      return `other: <${el.tagName.toLowerCase()} class="${el.className}">`;
    })
    .filter((row) => row !== 'relay');
}

/* ── no chat ─────────────────────────────────────────────────────────── */

describe.each(NO_CHAT)('with no chat (%s)', (_label, state, offered) => {
  beforeEach(() => seed(state));

  it('offers no Ask row in the dock', () => {
    renderDock('foo');
    expect(askRow()).toBeNull();
    expect(scopeFor('dock').textContent).not.toMatch(/\bAsk (AI|OpenClaw)\b/);
    // The add row is still there: the panel is open, the absence is real.
    expect(screen.getByTestId('omnibar-add-row')).toBeInTheDocument();
  });

  it('drops the `? chat` hint from the resting panel', () => {
    renderDock();
    expect(screen.getByText(/commands/)).toBeInTheDocument();
    expect(screen.queryByText(/\? chat/)).toBeNull();
  });

  it('treats `?` as text, not as a chat prefix', () => {
    renderDock('?foo');
    expect(screen.queryByText('Chat')).toBeNull();
    expect(askRow()).toBeNull();
    // Free text: it can still be filed, prefix and all.
    expect(screen.getByTestId('omnibar-add-row')).toHaveTextContent('“?foo”');
  });

  it('keeps the launcher from offering to ask, in its placeholder and its footer', () => {
    render(<Omnibar variant="launcher" />);
    expect(inputIn('launcher').getAttribute('placeholder')).toBe(
      'Search, add a task, or run a command…'
    );
    const footer = screen.getByTestId('omnibar-launcher-footer');
    expect(footer.textContent).not.toMatch(/chat|\bAI\b|OpenClaw|Beacon/);
    expect(footer).toHaveTextContent('↵ open');
    expect(askRow()).toBeNull();
  });

  it('consumes ⌘Enter without opening chat or filing the text as a task', async () => {
    const input = renderDock('plan my day');
    const notPrevented = fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    await act(() => flush());

    // Consumed: had it fallen through, cmdk's root Enter would have run the
    // highlighted Add row and filed "plan my day" as a task.
    expect(notPrevented).toBe(false);
    expect(addTask).not.toHaveBeenCalled();
    expect(transport.inputs).toEqual([]);
    expect(useConversationsStore.getState().threads).toEqual({});
    expect(useSidebarStore.getState().askOpen).toBe(false);
    expect(useRailStore.getState().summoned).toBe(false);
    // The text stays where it was: nothing happened to it.
    expect(input.value).toBe('plan my day');
  });

  it('drops the AI rows from the palette, and keeps catch-up', () => {
    const ids = matchCommands('', desktopCtx).map((r) => r.command.id);
    for (const id of CHAT_COMMANDS) expect(ids).not.toContain(id);
    expect(ids).toContain('rituals.catchUp');
    expect(ids).toContain('rituals.eod');
    // Not reachable by name either, old or new.
    for (const q of ['ask', 'chat', 'beacon', 'plan my day']) {
      const hits = matchCommands(q, desktopCtx).map((r) => r.command.id);
      for (const id of CHAT_COMMANDS) expect(hits).not.toContain(id);
    }
  });

  if (offered === null) {
    it('makes Ctrl+J inert, and still keeps it from the browser', () => {
      useSidebarStore.setState({ leftSidebarOpen: false });
      render(<ShortcutHarness />);
      // Consumed: Ctrl+J is Downloads in Chrome, Edge and Firefox. Handed
      // through, it would open the browser's downloads on every press until the
      // gate's read lands, for users who do have AI as well.
      for (const askOpen of [false, true]) {
        useSidebarStore.setState({ askOpen });
        expect(pressToggleChat()).toBe(true);
        // And inert: nothing opened, nothing closed, nothing summoned.
        expect(useSidebarStore.getState().askOpen).toBe(askOpen);
        expect(useRailStore.getState().summoned).toBe(false);
      }
      expect(useSidebarStore.getState().leftSidebarOpen).toBe(false);
    });
  } else {
    // The spec's ":299": the chord opens what the unlit key opens.
    it(`opens the ${offered === 'fix' ? 'fix' : 'setup'} column with Ctrl+J, and shuts it, kept open or not`, () => {
      useSidebarStore.setState({ leftSidebarOpen: false });
      render(<ShortcutHarness />);
      renderDockAndRail();
      const column = document.querySelector('[data-rail]') as HTMLElement;
      for (const askOpen of [false, true]) {
        useSidebarStore.setState({ askOpen });
        let consumed = false;
        act(() => {
          consumed = pressToggleChat();
        });
        expect(consumed).toBe(true);
        expect(useRailStore.getState().summoned).toBe(true);
        expect(document.querySelector(`[data-ask-setup="${offered}"]`)).toBeInTheDocument();
        expect(column.className).toMatch(/\bw-\[420px\]/);
        // Not Ask: no Ask view, no box, nothing asked of a box, and never kept open.
        expect(askRail()).toBeNull();
        expect(screen.queryByPlaceholderText(/Ask anything|Message/)).toBeNull();
        expect(useRailStore.getState().pendingFocus).toBeNull();
        expect(useSidebarStore.getState().askOpen).toBe(askOpen);
        act(() => {
          consumed = pressToggleChat();
        });
        expect(consumed).toBe(true);
        expect(useRailStore.getState().summoned).toBe(false);
        expect(column.className).toMatch(/\bw-0\b/);
        // A kept-open Ask's preference is the person's, untouched by setup.
        expect(useSidebarStore.getState().askOpen).toBe(askOpen);
      }
      expect(useSidebarStore.getState().leftSidebarOpen).toBe(false);
    });
  }

  // The spec's ":315": setup is only ever summoned, never kept open, so a
  // persisted `askOpen` raises nothing, offered or not.
  it('mounts no Ask and no setup, even with Ask left open from an earlier session', () => {
    useSidebarStore.setState({ askOpen: true });
    renderDockAndRail();
    // The column is only the item host: closed, with nothing in it, and not
    // the tour's Ask target. The tour points at the dock instead.
    expect(askRail()).toBeNull();
    expect(document.querySelector('[data-ask-setup]')).toBeNull();
    expect(screen.queryByTestId('rail-close')).toBeNull();
    expect(screen.queryByPlaceholderText(/Ask anything|Message/)).toBeNull();
    const column = document.querySelector('[data-rail]') as HTMLElement;
    expect(column.className).toMatch(/\bw-0\b/);
    expect(column).not.toHaveAttribute('data-tour');
    expect(document.querySelector('[data-tour="dock"]')).toBeInTheDocument();
  });

  it(offered ? 'shows the setup column when summoned, and never Ask' : 'shows nothing when summoned', () => {
    renderDockAndRail();
    act(() => useRailStore.getState().summon({ persist: false }));
    expect(askRail()).toBeNull();
    const column = document.querySelector('[data-rail]') as HTMLElement;
    if (offered) {
      expect(document.querySelector(`[data-ask-setup="${offered}"]`)).toBeInTheDocument();
      expect(column.className).toMatch(/\bw-\[420px\]/);
    } else {
      expect(document.querySelector('[data-ask-setup]')).toBeNull();
      expect(column.className).toMatch(/\bw-0\b/);
    }
    // Not the tour's Ask target either way (PR 6 points the tour at the key).
    expect(column).not.toHaveAttribute('data-tour');
  });
});

/* ── catch-up without chat ───────────────────────────────────────────── */

describe('catch-up when chat is hidden', () => {
  it.each([
    ['unknown', undefined],
    ['error', { phase: 'error' } as SeedAI],
    ['nothing connected', NOTHING_CONNECTED],
  ])('renders its card in the dock while the gate is %s', (_label, state) => {
    seed(state);
    render(<SidebarDock />);
    expect(screen.queryByTestId('proposal-card')).toBeNull();

    act(() => {
      void useProposalStore.getState().request('catch-up');
    });

    const host = screen.getByTestId('dock-catch-up-host');
    expect(host).toContainElement(screen.getByTestId('proposal-card'));
    // A direct child of the capsule, right above the user row: the chat slot.
    expect(capsuleRows()).toEqual(['catch-up', 'user', 'omnibar']);
    // A capped plain box, because ScrollArea ignores max-h.
    expect(host.className).toMatch(/max-h-\[50vh\]/);
    expect(host.className).toMatch(/overflow-y-auto/);
  });

  it.each([
    ['unknown', undefined],
    ['error', { phase: 'error' } as SeedAI],
    ['nothing connected', NOTHING_CONNECTED],
  ])('takes no space at all while there is nothing to show (%s)', (_label, state) => {
    seed(state);
    useSidebarStore.setState({ askOpen: true });
    renderDockAndRail();
    expect(screen.queryByTestId('dock-catch-up-host')).toBeNull();
    expect(screen.queryByTestId('proposal-card')).toBeNull();
    // Not even an empty wrapper: the user row is the capsule's first row,
    // exactly as in a dock that never had a catch-up slot.
    expect(capsuleRows()).toEqual(['user', 'omnibar']);
  });

  // The setup column is not Ask home: it carries no catch-up card, so the
  // dock keeps it while setup shows (lib/open-chat.ts useAskHomeShown).
  it.each([
    ['nothing connected', NOTHING_CONNECTED, 'invite'],
    ['the key stopped working', FAILING, 'fix'],
  ])('keeps its card in the dock while the setup column shows (%s)', (_label, state, kind) => {
    seed(state);
    renderDockAndRail();
    act(() => useRailStore.getState().summon({ persist: false }));
    expect(document.querySelector(`[data-ask-setup="${kind}"]`)).toBeInTheDocument();
    act(() => {
      void useProposalStore.getState().request('catch-up');
    });
    expect(screen.getByTestId('dock-catch-up-host')).toContainElement(screen.getByTestId('proposal-card'));
    expect(screen.getAllByTestId('proposal-card')).toHaveLength(1);
  });

  it('leaves an item panel’s card to the item panel', () => {
    seed(NOTHING_CONNECTED);
    render(<SidebarDock />);
    act(() => {
      useProposalStore.setState({
        status: 'loading',
        lastRequest: { intent: 'breakdown', itemId: 'abc', surface: 'item:abc' },
      });
    });
    expect(screen.queryByTestId('dock-catch-up-host')).toBeNull();
    expect(capsuleRows()).toEqual(['user', 'omnibar']);
  });

  it('opens the sidebar for the command, since there is no chat to open', () => {
    seed(NOTHING_CONNECTED);
    useSidebarStore.setState({ leftSidebarOpen: false });
    const catchUp = STATIC_COMMANDS.find((c) => c.id === 'rituals.catchUp')!;
    act(() => catchUp.run(desktopCtx));

    expect(useSidebarStore.getState().leftSidebarOpen).toBe(true);
    expect(useSidebarStore.getState().askOpen).toBe(false);
    expect(useRailStore.getState().summoned).toBe(false);
    expect(useProposalStore.getState().lastRequest?.intent).toBe('catch-up');
  });

  /** A catch-up card with lines to review, as the command draws over an overdue planner. */
  const REVIEW = {
    id: 'catch-up-1',
    summary: 'Three things slipped',
    operations: ['Call the bank', 'File the receipts', 'Water the plants'].map((title) => ({
      kind: 'create' as const,
      itemType: 'task',
      title,
    })),
    createdAt: '2026-10-01T00:00:00.000Z',
  };

  it.each([
    ['unknown', undefined],
    ['error', { phase: 'error' } as SeedAI],
  ])(
    'keeps the card in the dock when the gate opens mid-review (from %s)',
    (_label, state) => {
      seed(state);
      renderDockAndRail();
      const catchUp = STATIC_COMMANDS.find((c) => c.id === 'rituals.catchUp')!;
      act(() => catchUp.run(desktopCtx));
      act(() => {
        useProposalStore.setState({ status: 'ready', proposal: REVIEW, error: null });
      });
      // The user starts reviewing: one line dropped.
      fireEvent.click(screen.getAllByTestId('proposal-line')[1]);
      expect(useSidebarStore.getState().askOpen).toBe(false);
      expect(useRailStore.getState().summoned).toBe(false);

      // The status read answers (the first one, or a failed one retried on a
      // tab return): a working model, so Ask home is now the card's home.
      act(() => seed(CONNECTED_MODEL));
      expect(getAICapabilities().canChat).toBe(true);

      // Still in the dock, still once, and the SAME card: the dropped line is
      // still dropped, which a remount would have lost.
      const host = screen.getByTestId('dock-catch-up-host');
      expect(within(host).getByTestId('proposal-card')).toBeInTheDocument();
      expect(screen.getAllByTestId('proposal-card')).toHaveLength(1);
      expect(screen.getAllByTestId('proposal-line')[1]).toHaveAttribute('data-dropped', 'true');
      expect(askRail()).toBeNull();

      // Opening Ask hands the card over to Ask home; it never shows twice.
      act(() => useRailStore.getState().summon());
      expect(screen.queryByTestId('dock-catch-up-host')).toBeNull();
      expect(screen.getAllByTestId('proposal-card')).toHaveLength(1);
      expect(askRail()).toContainElement(screen.getByTestId('proposal-card'));
    }
  );

  it('keeps the dropped lines when the gate opens under Ask resting open, and the card moves home', () => {
    // The default: Ask rests open, so the moment something answers, Ask home
    // shows and is the card's home. The card remounts there; the lines the
    // user dropped are the proposal store's, so they come with it.
    useSidebarStore.setState({ askOpen: true });
    seed(undefined);
    renderDockAndRail();
    const catchUp = STATIC_COMMANDS.find((c) => c.id === 'rituals.catchUp')!;
    act(() => catchUp.run(desktopCtx));
    act(() => {
      useProposalStore.setState({ status: 'ready', proposal: REVIEW, error: null });
    });
    fireEvent.click(screen.getAllByTestId('proposal-line')[1]);
    expect(screen.getByTestId('dock-catch-up-host')).toBeInTheDocument();

    act(() => seed(CONNECTED_MODEL));
    expect(screen.queryByTestId('dock-catch-up-host')).toBeNull();
    expect(screen.getAllByTestId('proposal-card')).toHaveLength(1);
    expect(askRail()).toContainElement(screen.getByTestId('proposal-card'));
    expect(screen.getAllByTestId('proposal-line')[1]).toHaveAttribute('data-dropped', 'true');
    expect(screen.getAllByTestId('proposal-line')[0]).not.toHaveAttribute('data-dropped');

    // Accept applies what is still ticked, never the line that was dropped.
    const accept = vi.fn(() => 0);
    act(() => useProposalStore.setState({ accept }));
    fireEvent.click(screen.getByTestId('proposal-accept'));
    const kept = (accept.mock.calls[0] as unknown as [Array<{ title: string }>])[0];
    expect(kept.map((op) => op.title)).toEqual([
      'Call the bank',
      'Water the plants',
    ]);
  });

  it('shares the ticks with the copy of the card Ask holds hidden at an overlay width', () => {
    // Below 1180 a persisted askOpen mounts Ask hidden once the gate
    // opens (never an overlay at boot), and Ask home with it: a second mount
    // of the catch-up card, behind the dock's latched one.
    useSidebarStore.setState({ askOpen: true });
    seed(undefined);
    // Every reader of the overlay query (the dock's card-home rule) agrees with the column.
    const realMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({
        matches: query === PANEL_OVERLAY_QUERY,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    onTestFinished(() => {
      window.matchMedia = realMatchMedia;
    });
    render(
      <>
        <SidebarDock />
        <RailColumn panelState={null} onPanelOpenChange={() => {}} overlays plate spread={false} flatPanel={false} />
      </>
    );
    const catchUp = STATIC_COMMANDS.find((c) => c.id === 'rituals.catchUp')!;
    act(() => catchUp.run(desktopCtx));
    act(() => {
      useProposalStore.setState({ status: 'ready', proposal: REVIEW, error: null });
    });
    act(() => seed(CONNECTED_MODEL));
    const hidden = askRail() as HTMLElement;
    expect(hidden).not.toBeVisible();

    // The user drops a line on the card they can see, the dock's.
    const dock = screen.getByTestId('dock-catch-up-host');
    fireEvent.click(within(dock).getAllByTestId('proposal-line')[1]);
    // Ask's copy, the one a summon shows, has the same line dropped.
    expect(within(hidden).getAllByTestId('proposal-line')[1]).toHaveAttribute('data-dropped', 'true');
    act(() => useRailStore.getState().summon());
    expect(screen.queryByTestId('dock-catch-up-host')).toBeNull();
    expect(within(askRail() as HTMLElement).getAllByTestId('proposal-line')[1]).toHaveAttribute('data-dropped', 'true');
  });

  it('lets the latch go once the card is done', () => {
    seed({ phase: 'error' });
    renderDockAndRail();
    const catchUp = STATIC_COMMANDS.find((c) => c.id === 'rituals.catchUp')!;
    act(() => catchUp.run(desktopCtx));
    act(() => seed(CONNECTED_MODEL));
    expect(screen.getByTestId('dock-catch-up-host')).toBeInTheDocument();

    act(() => useProposalStore.getState().dismiss());
    expect(screen.queryByTestId('dock-catch-up-host')).toBeNull();

    // The next card has Ask to go to, so it goes to Ask home, not to the dock.
    act(() => catchUp.run(desktopCtx));
    expect(useSidebarStore.getState().askOpen).toBe(true);
    expect(screen.queryByTestId('dock-catch-up-host')).toBeNull();
    expect(screen.getAllByTestId('proposal-card')).toHaveLength(1);
    expect(askRail()).toContainElement(screen.getByTestId('proposal-card'));
  });

  it("carries the conversation's own plan when the key is turned down mid-review", () => {
    // "Turn this into a plan" answers on `conv:<id>`, and its home is that
    // conversation's view in the rail; the card outlives the gate exactly as
    // the catch-up card does (components/ai/proposal-card.tsx).
    seed(CONNECTED_MODEL);
    useSidebarStore.setState({ askOpen: true });
    const id = 'c-plan';
    useRailStore.getState().push('desktop', { kind: 'conversation', id });
    renderDockAndRail();
    act(() => {
      useProposalStore.setState({
        status: 'ready',
        error: null,
        proposal: REVIEW,
        lastRequest: { intent: 'ask', prompt: 'plan it', surface: `conv:${id}` },
      });
    });
    expect(screen.queryByTestId('dock-catch-up-host')).toBeNull();
    expect(screen.getAllByTestId('proposal-card')).toHaveLength(1);
    expect(
      document.querySelector(`[data-ask-conversation="${id}"]`)
    ).toContainElement(screen.getByTestId('proposal-card'));

    // The gate closes: Ask goes with it, and the dock picks the card up.
    act(() => seed(FAILING));
    expect(getAICapabilities().canChat).toBe(false);
    expect(askRail()).toBeNull();
    const host = screen.getByTestId('dock-catch-up-host');
    expect(within(host).getByTestId('proposal-card')).toBeInTheDocument();
    expect(screen.getAllByTestId('proposal-card')).toHaveLength(1);
  });

  it('shows a card with no request left to match once, not once per mount', () => {
    // An accept the planner took nothing from leaves 'empty' with no request:
    // every ProposalCard renders it, so only one of its homes may mount it.
    seed(CONNECTED_MODEL);
    useSidebarStore.setState({ askOpen: true });
    renderDockAndRail();
    act(() => {
      useProposalStore.setState({
        status: 'empty',
        emptyMessage: 'Those items have changed, so there is nothing left to apply.',
        proposal: null,
        lastRequest: null,
      });
    });
    expect(screen.getAllByTestId('proposal-card')).toHaveLength(1);
    expect(askRail()).toContainElement(screen.getByTestId('proposal-card'));
  });

  it('uses Ask home instead when something answers, so the card never shows twice', () => {
    seed(CONNECTED_MODEL);
    useSidebarStore.setState({ leftSidebarOpen: false });
    renderDockAndRail();
    const catchUp = STATIC_COMMANDS.find((c) => c.id === 'rituals.catchUp')!;
    act(() => catchUp.run(desktopCtx));

    expect(useSidebarStore.getState().askOpen).toBe(true);
    expect(screen.queryByTestId('dock-catch-up-host')).toBeNull();
    expect(screen.getAllByTestId('proposal-card')).toHaveLength(1);
    expect(askRail()).toContainElement(screen.getByTestId('proposal-card'));
  });
});

describe('proposalCardShowsOn', () => {
  it("agrees with ProposalCard's own render rule for every status and surface", () => {
    const statuses: ProposalStatus[] = ['idle', 'loading', 'ready', 'empty', 'error'];
    const requests: Array<{ surface: ProposalSurface } | null> = [
      null,
      { surface: 'chat' },
      { surface: 'item:abc' },
    ];
    const mounts: ProposalSurface[] = ['chat', 'item:abc'];
    const proposal = {
      id: 'p1',
      summary: 'A lighter Tuesday',
      operations: [{ kind: 'create' as const, itemType: 'task', title: 'Stretch' }],
      createdAt: '2026-10-01T00:00:00.000Z',
    };

    let checked = 0;
    for (const status of statuses) {
      for (const req of requests) {
        for (const surface of mounts) {
          const state = {
            status,
            lastRequest: req ? { intent: 'ask' as const, ...req } : null,
            proposal: status === 'ready' ? proposal : null,
            error: status === 'error' ? 'Something went wrong.' : null,
            emptyMessage: status === 'empty' ? 'Nothing to do.' : null,
          };
          useProposalStore.setState(state);
          const { unmount } = render(<ProposalCard surface={surface} />);
          const rendered = screen.queryByTestId('proposal-card') !== null;
          expect(
            rendered,
            `${status} × ${req?.surface ?? 'no request'} on ${surface}`
          ).toBe(proposalCardShowsOn(state, surface));
          unmount();
          checked += 1;
        }
      }
    }
    expect(checked).toBe(statuses.length * requests.length * mounts.length);
  });
});

/* ── with chat ───────────────────────────────────────────────────────── */

describe('with a connected model', () => {
  beforeEach(() => seed(CONNECTED_MODEL));

  it('offers "Ask AI" in the dock, for free text and for `?`', () => {
    renderDock('foo');
    expect(askRow()).toHaveTextContent('Ask AI “foo”');

    fireEvent.change(inputIn('dock'), { target: { value: '?what now' } });
    expect(screen.getByText('Chat')).toBeInTheDocument();
    expect(askRow()).toHaveTextContent('Ask AI “what now”');
  });

  it('advertises `? chat` on focus', () => {
    renderDock();
    expect(screen.getByText(/\? chat/)).toBeInTheDocument();
  });

  it('offers to ask in the launcher, in its placeholder and its footer', () => {
    render(<Omnibar variant="launcher" />);
    expect(inputIn('launcher').getAttribute('placeholder')).toBe(
      'Search, add a task, run a command, or ask AI…'
    );
    const footer = screen.getByTestId('omnibar-launcher-footer');
    expect(footer).toHaveTextContent('chat');
    expect(footer.textContent).toMatch(/↵ AI/);
  });

  it('sends ⌘Enter to Ask and opens it', async () => {
    const input = renderDock('plan my day');
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    await act(() => flush());

    // Ask was closed, so nothing was on screen to continue: a new
    // conversation, pushed onto the rail, as one turn (D10).
    const top = useRailStore.getState().stacks.desktop.at(-1) as Extract<AskView, { kind: 'conversation' }>;
    expect(top).toEqual({ kind: 'conversation', id: top.id });
    expect(transport.inputs.map((i) => i.message)).toEqual(['plan my day']);
    expect(transport.inputs[0].conversationId).toBe(top.id);
    expect(useConversationsStore.getState().threads[top.id]?.messages[0]?.content).toBe('plan my day');
    expect(addTask).not.toHaveBeenCalled();
    expect(useSidebarStore.getState().askOpen).toBe(true);
    expect(useRailStore.getState().summoned).toBe(true);
  });

  it('files a plain Enter as a task, as it always has', () => {
    // The control for the ⌘Enter cases: this harness DOES see an add when one
    // happens, so "addTask was not called" above is a real absence.
    // Loaded: a capture before landing is now held, not added (lib/held-captures.ts).
    usePlannerStore.setState({ userId: 'u1', isLoading: false, error: null });
    const input = renderDock('plan my day');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(addTask).toHaveBeenCalledWith({ title: 'plan my day' });
  });

  it('lists the AI rows in the palette, named for no one in particular', () => {
    const rows = matchCommands('', desktopCtx);
    const ids = rows.map((r) => r.command.id);
    for (const id of CHAT_COMMANDS) expect(ids).toContain(id);
    const ask = rows.find((r) => r.command.id === 'rituals.chat')!;
    expect(ask.command.label).toBe('Ask AI');
    // The old name still finds it, as an alias.
    expect(matchCommands('beacon', desktopCtx).map((r) => r.command.id)).toContain('rituals.chat');
  });

  it('opens and closes Ask with Ctrl+J', () => {
    render(<ShortcutHarness />);
    expect(pressToggleChat()).toBe(true);
    expect(useSidebarStore.getState().askOpen).toBe(true);
    expect(pressToggleChat()).toBe(true);
    expect(useSidebarStore.getState().askOpen).toBe(false);
  });

  it('opens Ask in the rail, headed "Ask", with the model named under the box', () => {
    useSidebarStore.setState({ askOpen: true });
    renderDockAndRail();
    const rail = askRail() as HTMLElement;
    expect(rail).toBeVisible();
    expect(within(rail).getByRole('heading', { name: 'Ask' })).toBeInTheDocument();
    expect(within(rail).getByPlaceholderText('Ask anything…')).toBeInTheDocument();
    expect(within(rail).getByTestId('answerer-label')).toHaveTextContent(/^GPT-4o mini$/);
    // The tour's Ask target is the column, and the dock keeps its own.
    expect(document.querySelector('[data-tour="right-sidebar"]')).toHaveAttribute('data-rail');
    expect(document.querySelector('[data-tour="dock"]')).toHaveAttribute('data-dock-surface');
    // The dock itself has no chat any more.
    expect(document.querySelector('[data-dock-surface]')).not.toContainElement(
      within(rail).getByPlaceholderText('Ask anything…')
    );
  });
});

describe('with OpenClaw on the plugin path', () => {
  beforeEach(() => seed(OPENCLAW_PLUGIN));

  it('names OpenClaw everywhere chat is offered', () => {
    renderDock('foo');
    expect(askRow()).toHaveTextContent('Ask OpenClaw “foo”');
    cleanup();

    render(<Omnibar variant="launcher" />);
    expect(inputIn('launcher').getAttribute('placeholder')).toBe(
      'Search, add a task, run a command, or ask OpenClaw…'
    );
    expect(screen.getByTestId('omnibar-launcher-footer').textContent).toMatch(/↵ OpenClaw/);
  });

  it('greets with openers, and offers no plan it cannot make', () => {
    useSidebarStore.setState({ askOpen: true });
    renderDockAndRail();

    expect(screen.getByTestId('answerer-label')).toHaveTextContent('OpenClaw · kirby-1');
    expect(screen.getByPlaceholderText('Message OpenClaw…')).toBeInTheDocument();
    expect(screen.getByTestId('chat-openers').querySelectorAll('button').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('chat-make-plan')).toBeNull();
    expect(screen.queryByText('Turn this into a plan')).toBeNull();
  });
});

/* ── constant across states ──────────────────────────────────────────── */

describe('what does not move with the gate', () => {
  it('keeps the dock placeholder identical in every state', () => {
    const seen = new Set<string>();
    for (const [, state] of [
      ...NO_CHAT,
      ['model', CONNECTED_MODEL] as [string, SeedAI],
      ['openclaw', OPENCLAW_PLUGIN] as [string, SeedAI],
    ]) {
      seed(state);
      const { unmount } = render(<Omnibar variant="dock" />);
      seen.add(inputIn('dock').getAttribute('placeholder') ?? '');
      unmount();
    }
    expect([...seen]).toEqual(['Add a task or search…']);
  });

  it('heads the rituals group "Rituals", with or without chat', () => {
    for (const state of [NOTHING_CONNECTED, CONNECTED_MODEL]) {
      seed(state);
      const { unmount } = render(<Omnibar variant="launcher" initialQuery="/" />);
      expect(screen.getByText('Rituals')).toBeInTheDocument();
      expect(screen.queryByText(/Rituals &/)).toBeNull();
      expect(screen.getByText('Pick things back up')).toBeInTheDocument();
      unmount();
    }
  });
});
