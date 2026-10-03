import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, onTestFinished } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act, within } from '@testing-library/react';

/**
 * The AI gate on the phone and on the item surfaces.
 *
 * Nothing AI-related renders unless something can answer (lib/ai-registry.ts),
 * and on these surfaces "renders" covers more than a button: the phone's chat
 * TAB is a place you can be, reached by the sheet and by a swipe, and the
 * item's thread is a field. Each has to disappear without leaving a hole — a
 * sheet entry, a swipe stop, an empty second column — and the one thing that
 * needs no model, catch-up, has to keep a place to answer on the phone even
 * while the gate's own read is pending or failed.
 */

const swipe = vi.hoisted(() => ({
  handlers: null as null | { onSwipedLeft?: () => void; onSwipedRight?: () => void },
}));

// Only the shell calls useSwipeable in what these tests mount (the header, the
// braindump and Today's rows are stubbed), so the last call is the shell's.
vi.mock('react-swipeable', () => ({
  useSwipeable: (handlers: { onSwipedLeft?: () => void; onSwipedRight?: () => void }) => {
    swipe.handlers = handlers;
    return {};
  },
}));

const events = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  fetchRoutines: vi.fn(async () => []),
  fetchSeasons: vi.fn(async () => []),
  fetchGoals: vi.fn(async () => []),
  fetchItemEvents: vi.fn(async () => events.rows),
  getItemEventsAvailable: () => true,
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
  useParams: () => ({ id: 'item-1' }),
}));
// The item page's editor is a dynamic chunk; the gate is about the columns
// beside it, so it stands in as nothing.
vi.mock('next/dynamic', () => ({
  default: () =>
    function DynamicStub() {
      return null;
    },
}));

// The shell's surfaces, stubbed to a name: what is under test is which one is
// mounted, not what each draws.
vi.mock('@/components/mobile/mobile-header', () => ({ MobileHeader: () => null }));
vi.mock('@/components/planner/user-profile-dropdown', () => ({ UserProfileDropdown: () => null }));
vi.mock('@/components/mobile/schedule-sheet', () => ({ ScheduleSheet: () => null }));
vi.mock('@/components/mobile/mobile-view-router', () => ({
  MobileViewRouter: () => <div data-testid="surface-today" />,
}));
vi.mock('@/components/sidebar/braindump', () => ({
  Braindump: () => <div data-testid="surface-braindump" />,
}));
vi.mock('@/components/mobile/ask-tab', () => ({
  AskTab: () => <div data-testid="surface-chat" />,
}));

import { MobileShell } from '@/components/shell/mobile-shell';
import { MobileBottomDock } from '@/components/mobile/mobile-bottom-dock';
import { ModeSwitcherSheet } from '@/components/mobile/mode-switcher-sheet';
import { ItemDetailSections } from '@/components/planner/item-detail-sections';
import ItemPage from '@/app/item/[id]/page';
import { mobileTabOrder, useMobileNavStore } from '@/lib/mobile-nav-store';
import { usePlannerStore } from '@/lib/planner-store';
import { useProposalStore } from '@/lib/proposal-store';
import { useRailStore } from '@/lib/rail-store';
import type { TaskItem } from '@/lib/planner-types';
import {
  CONNECTED_MODEL,
  NOTHING_CONNECTED,
  OPENCLAW_PLUGIN,
  seedAI,
} from './helpers/ai-fixtures';

beforeAll(() => {
  if (!('PointerEvent' in globalThis)) {
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = MouseEvent;
  }
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

const TASK = {
  type: 'task',
  id: 'item-1',
  title: 'Book the dentist',
  status: 'pending',
  isScheduled: false,
  order: 0,
  completedDates: [],
} as unknown as TaskItem;

const updateTask = vi.fn();

let unseed: () => void = () => {};
beforeEach(() => {
  useMobileNavStore.setState({ activeTab: 'today' });
  useRailStore.getState().reset();
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
    updateTask,
  });
  updateTask.mockClear();
  events.rows = [];
  swipe.handlers = null;
});
afterEach(() => {
  cleanup();
  unseed();
  unseed = () => {};
});

const seed = (o?: Parameters<typeof seedAI>[0]) => {
  unseed = seedAI(o);
};

// ── The phone ────────────────────────────────────────────────────────────────

describe('mobileTabOrder', () => {
  it('drops chat, and only chat, while nothing can answer', () => {
    expect(mobileTabOrder(true)).toEqual(['braindump', 'today', 'chat']);
    expect(mobileTabOrder(false)).toEqual(['braindump', 'today']);
  });
});

describe('the switcher sheet', () => {
  const open = () => fireEvent.click(screen.getByTestId('mobile-mode-card'));
  const entries = () => document.querySelectorAll('[data-testid^="mode-option-"]');

  it('lists two surfaces while nothing can answer', async () => {
    seed(NOTHING_CONNECTED);
    render(<ModeSwitcherSheet />);
    open();

    await waitFor(() => expect(entries()).toHaveLength(2));
    expect(screen.queryByTestId('mode-option-chat')).toBeNull();
    expect(screen.getByText('Switch between the Braindump and Today surfaces.')).toBeInTheDocument();
  });

  it('lists two while the gate has not answered yet (fail closed)', async () => {
    seed();
    render(<ModeSwitcherSheet />);
    open();

    await waitFor(() => expect(entries()).toHaveLength(2));
  });

  it('lists three with a model, the third named Ask', async () => {
    seed(CONNECTED_MODEL);
    render(<ModeSwitcherSheet />);
    open();

    await waitFor(() => expect(entries()).toHaveLength(3));
    expect(screen.getByTestId('mode-option-chat')).toHaveTextContent('Ask');
    expect(
      screen.getByText('Switch between the Braindump, Today and Ask surfaces.')
    ).toBeInTheDocument();
  });
});

describe('the shell', () => {
  const tab = () => useMobileNavStore.getState().activeTab;

  it('bounces off the chat tab when the capability drops', async () => {
    seed(CONNECTED_MODEL);
    useMobileNavStore.setState({ activeTab: 'chat' });
    render(<MobileShell />);
    expect(screen.getByTestId('surface-chat')).toBeInTheDocument();

    // The key stopped working, OpenClaw was unpaired: the gate answers again.
    act(() => {
      seed(NOTHING_CONNECTED);
    });

    expect(screen.queryByTestId('surface-chat')).toBeNull();
    expect(screen.getByTestId('surface-today')).toBeInTheDocument();
    await waitFor(() => expect(tab()).toBe('today'));
  });

  it('shows Today for a stored chat tab while the gate is unknown, without moving it', () => {
    seed();
    useMobileNavStore.setState({ activeTab: 'chat' });
    render(<MobileShell />);

    // Same frame: no chat panel, Today in its place. But an unanswered gate is
    // not news that chat went away, so the stored tab is left where it was.
    expect(screen.queryByTestId('surface-chat')).toBeNull();
    expect(screen.getByTestId('surface-today')).toBeInTheDocument();
    expect(tab()).toBe('chat');
  });

  it('swipes past where chat would be while nothing can answer', () => {
    seed(NOTHING_CONNECTED);
    render(<MobileShell />);

    act(() => swipe.handlers?.onSwipedLeft?.());
    expect(tab()).toBe('today');

    act(() => swipe.handlers?.onSwipedRight?.());
    expect(tab()).toBe('braindump');
    act(() => swipe.handlers?.onSwipedLeft?.());
    expect(tab()).toBe('today');
  });

  it("keeps the preview's sync line outside the keyed tab, so a tab change neither remounts nor fades it", () => {
    seed(NOTHING_CONNECTED);
    usePlannerStore.setState({ isLoading: true, isPreview: true });
    onTestFinished(() => {
      usePlannerStore.setState({ isLoading: false, isPreview: false });
    });
    render(<MobileShell />);
    const line = screen.getByTestId('planner-sync-line');
    const content = line.parentElement!;
    expect(content).toHaveClass('relative');
    expect(content.firstElementChild).toBe(line);
    expect(within(content).getByTestId('surface-today')).toBeInTheDocument();

    act(() => swipe.handlers?.onSwipedRight?.());
    expect(tab()).toBe('braindump');
    expect(screen.getByTestId('planner-sync-line')).toBe(line);
  });

  it('swipes onto chat when something can answer', () => {
    seed(CONNECTED_MODEL);
    render(<MobileShell />);

    act(() => swipe.handlers?.onSwipedLeft?.());
    expect(tab()).toBe('chat');
    expect(screen.getByTestId('surface-chat')).toBeInTheDocument();
  });
});

describe('the catch-up host in the phone dock', () => {
  const host = () => screen.queryByTestId('mobile-catch-up-host');
  const catchUp = async () => {
    await act(async () => {
      await useProposalStore.getState().request('catch-up');
    });
  };

  it('takes no space while there is nothing to show', () => {
    seed(NOTHING_CONNECTED);
    render(<MobileBottomDock />);
    expect(host()).toBeNull();
    expect(screen.queryByTestId('proposal-card')).toBeNull();
  });

  it('answers catch-up when there is no chat tab to answer on', async () => {
    seed(NOTHING_CONNECTED);
    render(<MobileBottomDock />);
    await catchUp();

    expect(within(host() as HTMLElement).getByTestId('proposal-card')).toBeInTheDocument();
  });

  it('still answers while the gate read has failed', async () => {
    // Catch-up needs no model, and the gate is closed while its read is
    // failing — a `known` term here would leave it nowhere to land.
    seed({ phase: 'error' });
    render(<MobileBottomDock />);
    expect(host()).toBeNull();

    await catchUp();
    expect(within(host() as HTMLElement).getByTestId('proposal-card')).toBeInTheDocument();
  });

  it('keeps the card on Today when the gate opens mid-review', async () => {
    seed({ phase: 'error' });
    render(<MobileBottomDock />);
    await catchUp();
    act(() => {
      useProposalStore.setState({
        status: 'ready',
        error: null,
        proposal: {
          id: 'catch-up-1',
          summary: 'Two things slipped',
          operations: ['Call the bank', 'Water the plants'].map((title) => ({
            kind: 'create' as const,
            itemType: 'task',
            title,
          })),
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      });
    });
    fireEvent.click(within(host() as HTMLElement).getAllByTestId('proposal-line')[0]);

    // A retried status read lands on a working model: chat is the card's
    // home now, on a tab the user is not on.
    act(() => seed(CONNECTED_MODEL));

    expect(within(host() as HTMLElement).getByTestId('proposal-card')).toBeInTheDocument();
    // The same card, not a remount: the dropped line is still dropped.
    expect(screen.getAllByTestId('proposal-line')[0]).toHaveAttribute('data-dropped', 'true');

    // Going to the chat tab hands it over, so it never shows twice.
    act(() => useMobileNavStore.getState().setActiveTab('chat'));
    expect(host()).toBeNull();
  });

  it('leaves the card to the chat surface when there is one', async () => {
    seed(CONNECTED_MODEL);
    render(<MobileBottomDock />);
    await catchUp();

    expect(host()).toBeNull();
  });

  it("carries the Ask tab's conversation's plan when the key is turned down mid-review", () => {
    seed(CONNECTED_MODEL);
    useMobileNavStore.setState({ activeTab: 'chat' });
    useRailStore.getState().push('phone', { kind: 'conversation', id: 'c1' });
    render(<MobileBottomDock />);
    act(() => {
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
      });
    });
    // The conversation on the Ask tab carries it while there is one.
    expect(host()).toBeNull();

    act(() => {
      unseed();
      seed({ ...CONNECTED_MODEL, model: { provider: 'openai', model: 'gpt-4o-mini', status: 'failing', problem: 'key_rejected' } });
    });
    expect(within(host() as HTMLElement).getByTestId('proposal-card')).toBeInTheDocument();
    expect(screen.getAllByTestId('proposal-card')).toHaveLength(1);
  });
});

// ── The item surfaces ────────────────────────────────────────────────────────

describe('the item panel', () => {
  const renderSections = (item: TaskItem = TASK) => {
    usePlannerStore.setState({ items: [item] });
    return render(<ItemDetailSections item={item} conversation="inline" />);
  };

  it('has no thread, no breakdown and no assignment while the gate is unknown', () => {
    seed();
    renderSections();

    expect(screen.queryByTestId('item-thread')).toBeNull();
    expect(screen.queryByTestId('break-it-down')).toBeNull();
    expect(screen.queryByTestId('assign-agent')).toBeNull();
    expect(screen.queryByText(/Assign to/)).toBeNull();
  });

  it('offers the thread and the breakdown with a model, and no assignment without an agent', () => {
    seed(CONNECTED_MODEL);
    renderSections();

    expect(screen.getByTestId('item-thread-input')).toHaveAttribute(
      'placeholder',
      'Ask about this item…'
    );
    expect(screen.getByTestId('break-it-down')).toBeInTheDocument();
    expect(screen.queryByTestId('assign-agent')).toBeNull();
  });

  it('assigns to OpenClaw, and only to OpenClaw, when an agent is paired', () => {
    seed(OPENCLAW_PLUGIN);
    renderSections();

    const assign = screen.getByTestId('assign-agent');
    expect(assign).toHaveTextContent('Assign to OpenClaw');
    fireEvent.click(assign);
    expect(updateTask).toHaveBeenCalledWith('item-1', { assignee: 'openclaw', aiStatus: 'queued' });

    // The plugin path has no proposal transport, so no breakdown; its thread
    // is named after the agent.
    expect(screen.queryByTestId('break-it-down')).toBeNull();
    expect(screen.getByTestId('item-thread-input')).toHaveAttribute(
      'placeholder',
      'Ask OpenClaw about this item…'
    );
  });

  it('writes openclaw even when a model answers chat', () => {
    seed({ ...CONNECTED_MODEL, openclaw: { agent: true } });
    renderSections();

    fireEvent.click(screen.getByTestId('assign-agent'));
    expect(updateTask).toHaveBeenCalledWith('item-1', { assignee: 'openclaw', aiStatus: 'queued' });
  });

  it('reads a stored beacon assignee as AI, in the chip and in Activity', async () => {
    seed();
    events.rows = [
      {
        id: 'e1',
        itemId: 'item-1',
        itemType: 'task',
        action: 'update',
        payload: { assignee: 'beacon' },
        createdAt: '2026-09-30T10:00:00.000Z',
      },
    ];
    renderSections({ ...TASK, assignee: 'beacon', aiStatus: 'queued' } as TaskItem);

    const block = screen.getByTestId('agent-block');
    expect(within(block).getByText('AI')).toBeInTheDocument();
    expect(within(block).queryByText(/beacon/i)).toBeNull();
    expect(await screen.findByText('Assigned to AI')).toBeInTheDocument();
  });
});

describe('the item page', () => {
  it('is one column with no thread while nothing can answer', () => {
    seed(NOTHING_CONNECTED);
    render(<ItemPage />);

    expect(screen.queryByTestId('item-thread')).toBeNull();
    const grid = screen.getByTestId('item-page-editor').nextElementSibling as HTMLElement;
    expect(grid.className).not.toContain('lg:grid-cols');
  });

  it('gives the thread its own column when something can answer', () => {
    seed(CONNECTED_MODEL);
    render(<ItemPage />);

    expect(screen.getByTestId('item-thread')).toBeInTheDocument();
    const grid = screen.getByTestId('item-page-editor').nextElementSibling as HTMLElement;
    expect(grid.className).toContain('lg:grid-cols');
  });
});
