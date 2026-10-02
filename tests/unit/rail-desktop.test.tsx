import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/**
 * The desktop right rail (PR-2 "Move", checkpoint C2): DesktopShell's
 * RailColumn, with the item panel and Ask in one 420px column.
 *
 * The shell is real down to the column: the item panel is the real ItemDialog
 * and Ask is the real RightRail, over the real stores. Only the canvas is
 * stubbed (a bare area to click away on) and the left column (a render
 * counter), so what is asserted is the column's own contract:
 *
 *  - With AI, the item wears the rail's header ("‹ Ask", ✕) and has no Done;
 *    ✕ closes the item AND the rail; Back shows Ask, as it was.
 *  - Escape and click-away give an overlay back and leave a docked Ask alone;
 *    `<main>` is inert exactly while an overlay covers it, never at boot.
 *  - Ctrl+J is the one flushing close: the row lets go, the title is saved now.
 *  - Closed, the column draws nothing, in every layout.
 *  - With no AI, the item is today's panel, Done included, and Ctrl+J is inert.
 *
 * Pieces of the C2 test table that need views C2 does not ship (History rows,
 * Needs you, a conversation's delete confirm) are asserted with those views.
 */

const counters = vi.hoisted(() => ({ sidebar: 0, view: 0 }));

vi.mock('@/components/sidebar/sidebar', () => ({
  Sidebar: () => {
    counters.sidebar += 1;
    return null;
  },
}));
// Bare canvas to click away on, with two rows' worth of focusable controls.
vi.mock('@/components/views/view-router', () => ({
  ViewRouter: () => (
    counters.view++,
    <div data-testid="canvas-empty">
      <button type="button" data-testid="row-a">
        A
      </button>
      <button type="button" data-testid="row-b">
        B
      </button>
    </div>
  ),
}));
vi.mock('@/components/views/season-notice', () => ({ SeasonNotice: () => null }));
vi.mock('@/components/notices/notice-slot', () => ({ DayHeaderNotice: () => null }));
vi.mock('@/components/canvas/week-scale', () => ({ WeekScale: () => null }));
vi.mock('@/components/canvas/header-capsule', () => ({ HeaderCapsule: () => null }));
// The other layouts' panes: the braindump on the right, the dock along the foot.
vi.mock('@/components/shell/braindump-pane', () => ({ BraindumpPane: () => null }));
vi.mock('@/components/sidebar/sidebar-dock', () => ({ SidebarDock: () => null }));
vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
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

import { DesktopShell } from '@/components/shell/desktop-shell';
import { BulkActionBar } from '@/components/shell/bulk-action-bar';
import { AskHome } from '@/components/ai/ask/ask-home';
import { RailHeader } from '@/components/ai/rail/rail-header';
import { ChatComposer } from '@/components/ai/chat-composer';
import { useCommandShortcuts } from '@/hooks/use-command-shortcuts';
import type { CommandContext } from '@/lib/commands';
import { PANEL_OVERLAY_QUERY, RAIL_RESERVE_PX, useRailStore, type AskView } from '@/lib/rail-store';
import { openEditFor, useUIStore } from '@/lib/ui-store';
import { useSelectionStore } from '@/lib/selection-store';
import { useSidebarStore } from '@/lib/sidebar-store';
import { usePlannerStore } from '@/lib/planner-store';
import { useLookStore } from '@/lib/look-store';
import { useViewStore } from '@/lib/view-store';
import { LAYOUTS } from '@/lib/layout-themes';
import { useProposalStore } from '@/lib/proposal-store';
import { chatTransport } from '@/lib/chat-transport';
import { httpConversationsApi } from '@/lib/conversations-api';
import {
  clearChatState,
  configureConversations,
  conversationsSettled,
  useConversationsStore,
} from '@/lib/conversations-store';
import { seedAI, CONNECTED_MODEL, NOTHING_CONNECTED, type SeedAI } from './helpers/ai-fixtures';
import { fakeApi, fakeTransport, flush, hangs, summary, type FakeTransport } from './helpers/conversations-fakes';
import { askFromCommandBar } from '@/lib/open-chat';
import type { TaskItem } from '@/lib/planner-types';

/* ── fixtures ────────────────────────────────────────────────────────── */

const task = (over: Partial<TaskItem> = {}): TaskItem => ({
  type: 'task',
  id: 't1',
  title: 'Book the dentist',
  status: 'pending',
  isScheduled: false,
  order: 0,
  ...over,
});
const DENTIST = task();
const PLANTS = task({ id: 't2', title: 'Water the plants', order: 1 });

const ctx: CommandContext = {
  theme: { resolved: 'light', value: 'light', set: () => {} },
  openChat: () => {},
  userId: 'u1',
  isMobile: false,
};

/** A catch-up card with lines to review. */
const REVIEW = {
  id: 'plan-1',
  summary: 'Three things slipped',
  operations: ['Call the bank', 'File the receipts', 'Water the plants'].map((title) => ({
    kind: 'create' as const,
    itemType: 'task',
    title,
  })),
  createdAt: '2026-10-01T00:00:00.000Z',
};

/* ── environment ─────────────────────────────────────────────────────── */

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

/** PANEL_OVERLAY_QUERY, switchable: the rest of the queries never match. */
const viewport = { narrow: false, listeners: new Set<() => void>() };
const realMatchMedia = window.matchMedia;
function installViewport() {
  window.matchMedia = ((query: string) =>
    ({
      matches: query === PANEL_OVERLAY_QUERY && viewport.narrow,
      media: query,
      onchange: null,
      addEventListener: (_: string, fn: () => void) => viewport.listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => viewport.listeners.delete(fn),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}
function setNarrow(narrow: boolean) {
  act(() => {
    viewport.narrow = narrow;
    for (const fn of [...viewport.listeners]) fn();
  });
}

let unseed: () => void = () => {};
const seed = (o?: SeedAI) => {
  unseed();
  unseed = seedAI(o);
};

let transport: FakeTransport;
const updateTask = vi.fn();
const originalUpdateTask = usePlannerStore.getState().updateTask;

beforeEach(() => {
  installViewport();
  viewport.narrow = false;
  transport = fakeTransport();
  configureConversations({ api: fakeApi().api, transport: transport.transport });
  clearChatState();
  updateTask.mockClear();
  usePlannerStore.setState({
    items: [DENTIST, PLANTS],
    projects: [],
    routines: [],
    seasons: [],
    goals: [],
    itemTypes: [],
    userTimezone: 'UTC',
    isLoading: false,
    userId: 'u1',
    // The write the panel's autosave makes, observed rather than sent.
    updateTask,
  } as never);
  useUIStore.setState({ activeDialog: null, displacedItemId: null });
  useSelectionStore.getState().clear();
  useSidebarStore.setState({ askOpen: true, leftSidebarOpen: true });
  useLookStore.setState({ layout: 'classic' });
  useProposalStore.getState().dismiss();
  counters.sidebar = 0;
  counters.view = 0;
  seed(CONNECTED_MODEL);
});

afterEach(async () => {
  cleanup();
  await conversationsSettled();
  unseed();
  unseed = () => {};
  window.matchMedia = realMatchMedia;
  viewport.listeners.clear();
  usePlannerStore.setState({ updateTask: originalUpdateTask });
  configureConversations({ api: httpConversationsApi, transport: chatTransport });
  useProposalStore.getState().dismiss();
  useUIStore.setState({ activeDialog: null, displacedItemId: null });
});

/* ── helpers ─────────────────────────────────────────────────────────── */

function ShortcutHarness() {
  useCommandShortcuts(ctx);
  return null;
}

const renderShell = () =>
  render(
    <>
      <DesktopShell />
      <ShortcutHarness />
    </>
  );

const column = () => document.querySelector('[data-rail]') as HTMLElement;
const askView = () => document.querySelector<HTMLElement>('[data-rail-view]');
const main = () => document.querySelector('main') as HTMLElement;
const dialog = () => screen.getByTestId('item-dialog');
const itemOpen = () => useUIStore.getState().activeDialog?.type === 'edit-item';

/** A plain row click: it selects the row and opens it (the grid's own gesture). */
function openRow(item: TaskItem = DENTIST) {
  act(() => {
    useSelectionStore.getState().replace([item.id]);
    openEditFor(item as never, 'task');
  });
}

/** A click on bare canvas: a press and a click that start and end on nothing. */
function clickAway() {
  const empty = screen.getByTestId('canvas-empty');
  fireEvent.pointerDown(empty, { button: 0 });
  fireEvent.click(empty, { button: 0, detail: 1 });
}

/** Ctrl+J at the window; true when something claimed it. */
function pressCtrlJ(): boolean {
  const event = new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true, cancelable: true });
  act(() => {
    window.dispatchEvent(event);
  });
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'j', bubbles: true }));
  return event.defaultPrevented;
}

const push = (view: AskView) => act(() => useRailStore.getState().push('desktop', view));

/** Every timer queued so far (a deferred focus, a hand-back) has run. */
const timers = () => act(() => new Promise((r) => setTimeout(r, 10)));
const row = (name: 'a' | 'b') => screen.getByTestId(`row-${name}`);
const askBox = () => (askView() as HTMLElement).querySelector('[data-ask-composer] textarea') as HTMLTextAreaElement;
const itemBox = () => dialog().querySelector('[data-ask-composer] textarea') as HTMLTextAreaElement;

/** Ctrl+J from wherever focus is, as a real keypress bubbles from there. */
function pressCtrlJHere() {
  const event = new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true, cancelable: true });
  act(() => {
    (document.activeElement ?? window).dispatchEvent(event);
  });
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'j', bubbles: true }));
}

/** Escape from wherever focus is. */
function pressEscapeHere() {
  act(() => {
    (document.activeElement ?? window).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
  });
}

/** Open an item the way a click on its row does: the row takes focus first. */
function openFromRow(name: 'a' | 'b', item: TaskItem = DENTIST) {
  row(name).focus();
  openRow(item);
}

/** Conversations as History's first page brings them, fresh: Ask home and History list these. */
function listConversations(...rows: ReturnType<typeof summary>[]) {
  act(() =>
    useConversationsStore.setState((s) => ({
      summaries: { ...s.summaries, ...Object.fromEntries(rows.map((r) => [r.id, r])) },
      list: { ...s.list, ids: rows.map((r) => r.id), status: 'loaded', fetchedAt: Date.now() },
    }))
  );
}

/** A conversation's saved title, as History's first page would bring it. */
function nameConversation(id: string, title: string) {
  act(() =>
    useConversationsStore.setState((s) => ({
      summaries: { ...s.summaries, [id]: { id, title } as never },
    }))
  );
}

/* ── the item, with AI ───────────────────────────────────────────────── */

describe('an item in the rail, with AI', () => {
  it('wears the rail header, "‹ Ask … ✕", and has no Done', () => {
    renderShell();
    openRow();

    const back = within(dialog()).getByTestId('rail-back');
    expect(back).toHaveTextContent(/^Ask$/);
    expect(back).toHaveAccessibleName('Back to Ask');
    // ✕ names the binding that does the same thing, never a hard-coded key.
    expect(within(dialog()).getByTestId('item-dialog-close')).toHaveAttribute('title', 'Close (Ctrl+J)');
    expect(within(dialog()).queryByTestId('item-dialog-submit')).toBeNull();
    // Its box is pinned at the foot, says what it is about, and does not
    // take focus for mounting.
    const box = dialog().querySelector('[data-ask-composer] textarea');
    expect(box).not.toBeNull();
    expect(box).toHaveAttribute('placeholder', 'Ask about this item…');
    expect(askBox()).toHaveAttribute('placeholder', 'Ask anything…');
    expect(document.activeElement).not.toBe(box);
    // Ask stays mounted beneath it, hidden and out of the tab order.
    expect(askView()).not.toBeVisible();
    expect(askView()).toHaveAttribute('inert');
    // The column is the item's direct host, in the drag band's hole.
    expect(dialog().parentElement).toBe(column());
    expect(column()).toHaveClass('titlebar-hole', 'w-[420px]');
  });

  it('names the view beneath on its back control, by its live title', () => {
    push({ kind: 'history' });
    renderShell();
    openRow();
    expect(within(dialog()).getByTestId('rail-back')).toHaveTextContent(/^History$/);

    act(() => useUIStore.getState().closeDialog());
    push({ kind: 'conversation', id: 'c1' });
    nameConversation('c1', 'Trip plans');
    openRow();
    expect(within(dialog()).getByTestId('rail-back')).toHaveTextContent(/^Trip plans$/);

    // A rename shows at once.
    nameConversation('c1', 'Lisbon in May');
    expect(within(dialog()).getByTestId('rail-back')).toHaveTextContent(/^Lisbon in May$/);
  });

  it("names a conversation's item by its live title, and the view beneath once the item is gone", () => {
    push({ kind: 'history' });
    push({ kind: 'conversation', id: 'c2', returnTo: { itemId: 't1' } });
    renderShell();
    const back = () => within(askView() as HTMLElement).getByTestId('rail-back');
    expect(back()).toHaveTextContent(/^Book the dentist$/);

    act(() => usePlannerStore.setState({ items: [task({ title: 'Call the dentist' }), PLANTS] }));
    expect(back()).toHaveTextContent(/^Call the dentist$/);

    // Deleted: Back cannot reopen it, so the label never promises it.
    act(() => usePlannerStore.setState({ items: [PLANTS] }));
    expect(back()).toHaveTextContent(/^History$/);
  });

  it('closes the item AND the rail on ✕', () => {
    renderShell();
    openRow();
    fireEvent.click(within(dialog()).getByTestId('item-dialog-close'));

    expect(itemOpen()).toBe(false);
    expect(useSidebarStore.getState().askOpen).toBe(false);
    expect(useRailStore.getState().summoned).toBe(false);
    // The row the click selected lets go with it (the shell's one close).
    expect(useSelectionStore.getState().selectedIds.size).toBe(0);
    expect(column()).toHaveClass('w-0');
    expect(askView()).toBeNull();
  });

  it('goes back to Ask on Back, with a card and its ticks as they were', () => {
    push({ kind: 'conversation', id: 'c1' });
    act(() =>
      useProposalStore.setState({
        status: 'ready',
        error: null,
        proposal: REVIEW,
        lastRequest: { intent: 'ask', prompt: 'plan it', surface: 'conv:c1' },
      })
    );
    renderShell();
    fireEvent.click(screen.getAllByTestId('proposal-line')[1]);
    expect(screen.getAllByTestId('proposal-line')[1]).toHaveAttribute('data-dropped', 'true');

    // An item over the conversation: the card is out of sight, not gone.
    openRow();
    expect(askView()).not.toBeVisible();
    expect(useProposalStore.getState().status).toBe('ready');

    fireEvent.click(within(dialog()).getByTestId('rail-back'));
    expect(itemOpen()).toBe(false);
    expect(askView()).toBeVisible();
    expect(within(askView() as HTMLElement).getByTestId('proposal-card')).toBeInTheDocument();
    expect(screen.getAllByTestId('proposal-line')[1]).toHaveAttribute('data-dropped', 'true');
    expect(useRailStore.getState().stacks.desktop).toEqual([{ kind: 'conversation', id: 'c1' }]);
  });

  it('keeps the item open for an IME commit in its box, and sends on a real Enter', async () => {
    renderShell();
    openRow();
    const box = dialog().querySelector('[data-ask-composer] textarea') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'いつがいい' } });

    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(itemOpen()).toBe(true);
    expect(transport.inputs).toEqual([]);

    fireEvent.keyDown(box, { key: 'Enter' });
    await act(() => flush());
    expect(itemOpen()).toBe(true);
    expect(transport.inputs.map((i) => i.message)).toEqual(['いつがいい']);
  });

  it('keeps the same title field focused when the gate flips under it', () => {
    seed(NOTHING_CONNECTED);
    renderShell();
    openRow();
    const title = screen.getByDisplayValue('Book the dentist');
    title.focus();
    expect(within(dialog()).getByTestId('item-dialog-submit')).toBeInTheDocument();

    act(() => seed(CONNECTED_MODEL));
    expect(within(dialog()).getByTestId('rail-back')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Book the dentist')).toBe(title);
    expect(document.activeElement).toBe(title);

    act(() => seed(NOTHING_CONNECTED));
    expect(within(dialog()).getByTestId('item-dialog-submit')).toBeInTheDocument();
    expect(document.activeElement).toBe(title);
  });
});

/* ── Escape, click-away, overlay ─────────────────────────────────────── */

describe('giving the planner back', () => {
  it('blurs a box with text on Escape, and does nothing else', () => {
    push({ kind: 'history' });
    renderShell();
    const home = askView() as HTMLElement;
    const box = home.querySelector('[data-ask-composer] textarea') as HTMLTextAreaElement | null;
    // History has no box in C2; Back first, to Ask home's.
    expect(box).toBeNull();
    act(() => useRailStore.getState().back('desktop'));

    const homeBox = (askView() as HTMLElement).querySelector(
      '[data-ask-composer] textarea'
    ) as HTMLTextAreaElement;
    homeBox.focus();
    fireEvent.change(homeBox, { target: { value: 'half a thought' } });
    fireEvent.keyDown(homeBox, { key: 'Escape' });
    expect(document.activeElement).not.toBe(homeBox);
    expect(homeBox.value).toBe('half a thought');
    expect(useSidebarStore.getState().askOpen).toBe(true);

    // The same in the item's box: the draft is kept and the item stays.
    openRow();
    const itemBox = dialog().querySelector('[data-ask-composer] textarea') as HTMLTextAreaElement;
    itemBox.focus();
    fireEvent.change(itemBox, { target: { value: 'move it to Friday?' } });
    fireEvent.keyDown(itemBox, { key: 'Escape' });
    expect(document.activeElement).not.toBe(itemBox);
    expect(itemOpen()).toBe(true);

    // A second Escape, from nowhere, is the item's: it closes, and Ask shows.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(itemOpen()).toBe(false);
    expect(askView()).toBeVisible();
  });

  it('goes back a view on Escape, and leaves a docked Ask home where it is', () => {
    push({ kind: 'history' });
    renderShell();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useRailStore.getState().stacks.desktop).toEqual([]);

    // Docked, home is a resting surface.
    act(() => useRailStore.getState().summon());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useRailStore.getState().summoned).toBe(true);
    expect(askView()).toBeVisible();
  });

  it('parks an overlay on click-away and on Escape, and never a docked Ask', () => {
    renderShell();
    act(() => useRailStore.getState().summon());
    clickAway();
    expect(useRailStore.getState().summoned).toBe(true);
    expect(askView()).toBeVisible();

    // Narrowing into overlay parks it, so the planner stays usable.
    setNarrow(true);
    expect(useRailStore.getState().summoned).toBe(false);
    expect(askView()).not.toBeVisible();
    expect(main()).not.toHaveAttribute('inert');

    act(() => useRailStore.getState().summon());
    expect(askView()).toBeVisible();
    expect(main()).toHaveAttribute('inert');
    clickAway();
    expect(useRailStore.getState().summoned).toBe(false);
    expect(main()).not.toHaveAttribute('inert');
    // Parked, not closed: the choice to keep Ask is the user's.
    expect(useSidebarStore.getState().askOpen).toBe(true);

    act(() => useRailStore.getState().summon());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useRailStore.getState().summoned).toBe(false);
    expect(main()).not.toHaveAttribute('inert');
  });

  it('makes <main> inert under an overlay only: never at boot, with Ask summoned, with an item', () => {
    viewport.narrow = true;
    renderShell();
    // Ask was left open, but a persisted choice never raises an overlay.
    expect(main()).not.toHaveAttribute('inert');
    expect(column()).toHaveClass('w-0');
    expect(askView()).not.toBeVisible();

    act(() => useRailStore.getState().summon());
    expect(main()).toHaveAttribute('inert');
    act(() => useRailStore.getState().park());
    expect(main()).not.toHaveAttribute('inert');

    openRow();
    expect(main()).toHaveAttribute('inert');
  });

  it('shows Ask on Back from an overlaid item; click-away on an item gives the planner back', () => {
    viewport.narrow = true;
    renderShell();
    openRow();
    fireEvent.click(within(dialog()).getByTestId('rail-back'));
    expect(itemOpen()).toBe(false);
    expect(askView()).toBeVisible();
    expect(main()).toHaveAttribute('inert');

    openRow();
    clickAway();
    expect(itemOpen()).toBe(false);
    expect(useRailStore.getState().summoned).toBe(false);
    expect(askView()).not.toBeVisible();
    expect(main()).not.toHaveAttribute('inert');
  });
});

/* ── Ctrl+J and focus ────────────────────────────────────────────────── */

describe('Ctrl+J', () => {
  it('lets a selected, opened row go and saves its typed title before it closes', () => {
    renderShell();
    openRow();
    fireEvent.change(screen.getByDisplayValue('Book the dentist'), {
      target: { value: 'Book the dentist for Friday' },
    });
    // Queued, not sent: the autosave waits for a pause.
    expect(updateTask).not.toHaveBeenCalled();

    expect(pressCtrlJ()).toBe(true);
    expect(updateTask).toHaveBeenCalledWith('t1', expect.objectContaining({ title: 'Book the dentist for Friday' }));
    expect(useSelectionStore.getState().selectedIds.size).toBe(0);
    expect(itemOpen()).toBe(false);
    expect(useSidebarStore.getState().askOpen).toBe(false);
    expect(column()).toHaveClass('w-0');
  });

  it('focuses the box from hidden, and a row clicked after it does not focus the item’s box', async () => {
    useSidebarStore.setState({ askOpen: false });
    renderShell();
    expect(pressCtrlJ()).toBe(true);
    await act(() => flush());
    const home = (askView() as HTMLElement).querySelector('[data-ask-composer] textarea');
    expect(document.activeElement).toBe(home);

    openRow();
    await act(() => flush());
    const itemBox = dialog().querySelector('[data-ask-composer] textarea');
    expect(itemBox).not.toBeNull();
    expect(document.activeElement).not.toBe(itemBox);
  });
});

/* ── the box's height ────────────────────────────────────────────────── */

describe('the box, measured once it can be', () => {
  // jsdom lays nothing out, so a textarea measures as a browser would: 0
  // under a `hidden` ancestor (display:none), 48 once it shows.
  beforeAll(() => {
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLTextAreaElement) {
        return this.closest('[hidden]') ? 0 : 48;
      },
    });
  });
  afterAll(() => {
    delete (HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight;
  });

  it('keeps no 0px height while Ask is mounted hidden at boot, and measures when summoned', () => {
    viewport.narrow = true;
    renderShell();
    expect(askView()).not.toBeVisible();
    expect(askBox().style.height).not.toBe('0px');

    act(() => useRailStore.getState().summon());
    expect(askBox().style.height).toBe('48px');
  });

  it('measures Ask home mounted under an item once Back shows it', () => {
    openRow();
    renderShell();
    expect(askBox().style.height).not.toBe('0px');
    fireEvent.click(within(dialog()).getByTestId('rail-back'));
    expect(askView()).toBeVisible();
    expect(askBox().style.height).toBe('48px');
  });

  it('measures Ask home remounted under the item a "?" goes back to', () => {
    push({ kind: 'conversation', id: 'c1', returnTo: { itemId: 't1' } });
    renderShell();
    // Back pops to home and reopens the item in one go: home mounts hidden.
    fireEvent.click(within(askView() as HTMLElement).getByTestId('rail-back'));
    expect(itemOpen()).toBe(true);
    expect(askBox().style.height).not.toBe('0px');
    fireEvent.click(within(dialog()).getByTestId('rail-back'));
    expect(askBox().style.height).toBe('48px');
  });

  it('writes no height for a field with no box, whoever mounts it', () => {
    render(
      <div hidden>
        <ChatComposer variant="panel" binding={{ kind: 'home' }} />
      </div>
    );
    expect((document.querySelector('textarea') as HTMLTextAreaElement).style.height).toBe('');
  });
});

/* ── focus after a send ──────────────────────────────────────────────── */

describe('focus after a send', () => {
  const conversationBox = () =>
    (askView() as HTMLElement).querySelector('[data-ask-conversation] [data-ask-composer] textarea') as HTMLTextAreaElement;

  it('moves to the pushed conversation’s box from Ask home, and stays through the reply', async () => {
    const turn = hangs('Su');
    transport.next = turn.run;
    renderShell();
    askBox().focus();
    fireEvent.change(askBox(), { target: { value: 'what is next' } });
    fireEvent.keyDown(askBox(), { key: 'Enter' });
    await timers();

    expect(useRailStore.getState().stacks.desktop.at(-1)?.kind).toBe('conversation');
    const box = conversationBox();
    expect(document.activeElement).toBe(box);
    // Busy, and still a field: read-only, never disabled, so focus holds.
    expect(box).toHaveAttribute('readonly');
    expect(box).toHaveAttribute('aria-busy', 'true');
    expect(box).not.toBeDisabled();

    act(() => turn.release('re.'));
    await timers();
    expect(document.activeElement).toBe(box);
    expect(box).not.toHaveAttribute('readonly');
  });

  it('moves to the box of the conversation a chip starts', async () => {
    transport.next = hangs('Su').run;
    renderShell();
    const chip = within(screen.getByTestId('chat-openers')).getAllByRole('button')[0];
    chip.focus();
    fireEvent.click(chip);
    await timers();
    expect(document.activeElement).toBe(conversationBox());
  });

  it('moves to the box of the conversation a "?" starts, from a closed rail', async () => {
    transport.next = hangs('Su').run;
    useSidebarStore.setState({ askOpen: false });
    renderShell();
    row('a').focus();
    act(() => askFromCommandBar('what now', false));
    await timers();
    expect(document.activeElement).toBe(conversationBox());
  });

  it("stays in the item's box, with the item open, while it answers", async () => {
    transport.next = hangs('Su').run;
    renderShell();
    openRow();
    const box = itemBox();
    box.focus();
    fireEvent.change(box, { target: { value: 'move it to Friday?' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await timers();
    expect(itemOpen()).toBe(true);
    expect(itemBox()).toBe(box);
    expect(document.activeElement).toBe(box);
    expect(box).toHaveAttribute('readonly');
    expect(box).not.toBeDisabled();
  });
});

/* ── focus across a close ────────────────────────────────────────────── */

describe('focus across a close', () => {
  const heading = () => (askView() as HTMLElement).querySelector('[data-ask-heading]');

  it("leaves Ctrl+J's close to the item's own return, over an older summon", async () => {
    useSidebarStore.setState({ askOpen: false });
    renderShell();
    row('a').focus();
    pressCtrlJHere();
    await timers();
    expect(document.activeElement).toBe(askBox());

    openFromRow('b');
    // Into the title from nowhere: nothing new is noted on the way in.
    (document.activeElement as HTMLElement).blur();
    screen.getByDisplayValue('Book the dentist').focus();
    pressCtrlJHere();
    await timers();
    expect(itemOpen()).toBe(false);
    expect(document.activeElement).toBe(row('b'));
  });

  it("does the same for the item's ✕", async () => {
    useSidebarStore.setState({ askOpen: false });
    renderShell();
    row('a').focus();
    pressCtrlJHere();
    await timers();

    openFromRow('b');
    (document.activeElement as HTMLElement).blur();
    const close = within(dialog()).getByTestId('item-dialog-close');
    close.focus();
    fireEvent.click(close);
    await timers();
    expect(document.activeElement).toBe(row('b'));
  });

  it('hands focus back to the row an overlay was summoned from when Escape parks it', async () => {
    viewport.narrow = true;
    renderShell();
    row('a').focus();
    pressCtrlJHere();
    await timers();
    expect(document.activeElement).toBe(askBox());

    pressEscapeHere();
    await timers();
    expect(useRailStore.getState().summoned).toBe(false);
    expect(document.activeElement).toBe(row('a'));
  });

  it('hands focus back to where it came from into an Ask open since boot', async () => {
    renderShell();
    row('a').focus();
    askBox().focus();
    pressCtrlJHere();
    await timers();
    expect(useSidebarStore.getState().askOpen).toBe(false);
    expect(document.activeElement).toBe(row('a'));
  });

  it('gives the item the focus when Back reopens it, by click or by Escape', async () => {
    push({ kind: 'conversation', id: 'c1', returnTo: { itemId: 't1' } });
    renderShell();
    const back = within(askView() as HTMLElement).getByTestId('rail-back');
    back.focus();
    fireEvent.click(back);
    await timers();
    expect(itemOpen()).toBe(true);
    expect(document.activeElement).toBe(dialog());

    act(() => useUIStore.getState().closeDialog());
    push({ kind: 'conversation', id: 'c1', returnTo: { itemId: 't1' } });
    (heading() as HTMLElement).focus();
    pressEscapeHere();
    await timers();
    expect(itemOpen()).toBe(true);
    expect(document.activeElement).toBe(dialog());
  });

  it.each([
    ['Ask kept open', true],
    ['Ask closed, so it mounts on Back', false],
  ])('focuses the Ask heading on Back from an overlaid item (%s)', async (_label, askOpen) => {
    useSidebarStore.setState({ askOpen });
    viewport.narrow = true;
    renderShell();
    openFromRow('a');
    const back = within(dialog()).getByTestId('rail-back');
    back.focus();
    fireEvent.click(back);
    await timers();
    // The row it was opened from is under the inert canvas: no return there.
    expect(main()).toHaveAttribute('inert');
    expect(document.activeElement).toBe(heading());
  });

  it('acts on a request for the item panel’s focus once, not on every open after it', async () => {
    renderShell();
    openFromRow('a');
    act(() => {
      (document.activeElement ?? window).dispatchEvent(
        new KeyboardEvent('keydown', { key: '\\', ctrlKey: true, bubbles: true, cancelable: true })
      );
    });
    expect(document.activeElement).toBe(dialog());

    act(() => useUIStore.getState().closeDialog());
    await timers();
    // A later row click opens the item and leaves focus on the row.
    openFromRow('b');
    await timers();
    expect(document.activeElement).toBe(row('b'));
  });

  it('leaves the docked return to the row on Back from an item', async () => {
    renderShell();
    openFromRow('a');
    fireEvent.click(within(dialog()).getByTestId('rail-back'));
    await timers();
    expect(document.activeElement).toBe(row('a'));
  });

  it('forgets where focus came from once the column hides by another path', async () => {
    useSidebarStore.setState({ askOpen: false });
    renderShell();
    // An item opened from row A, focus taken into it from there: noted.
    openFromRow('a');
    screen.getByDisplayValue('Book the dentist').focus();
    // Closed by Escape, not by a close that takes the record.
    pressEscapeHere();
    expect(itemOpen()).toBe(false);
    await timers();

    // Another item, entered from nowhere; its Back shows Ask (a summon from
    // inside the column keeps what its entry noted, which is nothing now).
    openFromRow('b', PLANTS);
    (document.activeElement as HTMLElement).blur();
    const back = within(dialog()).getByTestId('rail-back');
    back.focus();
    fireEvent.click(back);
    await timers();
    (document.activeElement as HTMLElement).blur();
    askBox().focus();
    pressCtrlJHere();
    await timers();
    expect(useSidebarStore.getState().askOpen).toBe(false);
    expect(document.activeElement).not.toBe(row('a'));
  });

  it('moves nothing when Ask shows at boot', async () => {
    renderShell();
    await timers();
    expect(document.activeElement).toBe(document.body);
  });
});

/* ── the pinned conversation ─────────────────────────────────────────── */

describe("the item's pinned conversation", () => {
  const msg = (id: string, i: number) => ({
    id: `${id}-${i}`,
    role: i % 2 ? ('assistant' as const) : ('user' as const),
    content: `${id} ${i}`,
    status: 'done' as never,
    errorCode: null,
    replyTo: null,
    answerer: null,
    model: null,
    createdAt: 0,
    pos: i,
    sync: 'saved' as const,
  });
  const loaded = (id: string, itemId: string, n: number) => ({
    id,
    itemId,
    draftTitle: null,
    saved: true,
    load: 'loaded' as const,
    hasEarlier: false,
    streaming: false,
    typing: false,
    fetchedAt: Date.now(),
    messages: Array.from({ length: n }, (_, i) => msg(id, i)),
  });

  it('lands a retargeted panel at the new item’s top, not at the end of its conversation', () => {
    act(() =>
      useConversationsStore.setState((s) => ({
        threads: { ...s.threads, ca: loaded('ca', 't1', 2), cb: loaded('cb', 't2', 6) } as never,
        itemIndex: { ...s.itemIndex, t1: 'ca', t2: 'cb' },
      }))
    );
    const writes: number[] = [];
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    Object.defineProperty(proto, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute('data-rail-body') ? 999 : 0;
      },
    });
    Object.defineProperty(proto, 'scrollTop', {
      configurable: true,
      get: () => 0,
      set(this: HTMLElement, v: number) {
        if (this.hasAttribute('data-rail-body')) writes.push(v);
      },
    });
    try {
      renderShell();
      openRow();
      expect(within(dialog()).getByTestId('item-conversation')).toBeInTheDocument();
      openRow(PLANTS);
      expect(within(dialog()).getAllByText(/^cb \d$/)).toHaveLength(6);
      expect(writes).toEqual([]);
    } finally {
      delete proto.scrollHeight;
      delete proto.scrollTop;
    }
  });
});

/* ── the column ──────────────────────────────────────────────────────── */

describe('the column', () => {
  it('re-renders on a push without re-rendering the sidebar', () => {
    renderShell();
    const before = counters.sidebar;
    push({ kind: 'history' });
    expect(within(askView() as HTMLElement).getByRole('heading', { name: 'History' })).toBeInTheDocument();
    push({ kind: 'conversation', id: 'c1' });
    act(() => useRailStore.getState().back('desktop'));
    expect(counters.sidebar).toBe(before);
  });

  it('holds back 432px while docked, for an item and for Ask alike, and nothing otherwise', () => {
    renderShell();
    const reserve = () => useRailStore.getState().reservePx;
    expect(reserve()).toBe(RAIL_RESERVE_PX);
    expect(RAIL_RESERVE_PX).toBe(432);

    act(() => useRailStore.getState().closeRail());
    expect(reserve()).toBe(0);
    openRow();
    expect(reserve()).toBe(432);

    // Overlaid it holds nothing back, and covers the canvas instead (the
    // bulk bar stands down for that).
    const covers = () => useRailStore.getState().covers;
    expect(covers()).toBe(false);
    setNarrow(true);
    expect(reserve()).toBe(0);
    expect(covers()).toBe(true);
    setNarrow(false);
    expect(reserve()).toBe(432);
    expect(covers()).toBe(false);

    setNarrow(true);
    cleanup();
    expect(reserve()).toBe(0);
    expect(covers()).toBe(false);
  });

  it('re-renders neither the braindump nor the day for a docked Ctrl+J, either way', () => {
    // DesktopShell's one rail read is the overlay (useRailCovers), constant
    // false while the column docks: the column re-renders alone. The left
    // column and the canvas here are plain counters, so any shell render
    // shows on them.
    renderShell();
    const before = { ...counters };
    expect(pressCtrlJ()).toBe(true);
    fireEvent.transitionEnd(column(), { propertyName: 'width' });
    expect(askView()).toBeNull();
    expect(pressCtrlJ()).toBe(true);
    expect(askView()).toBeVisible();
    expect(counters).toEqual(before);

    // An overlay is the shell's business (<main> goes inert), and only then.
    setNarrow(true);
    act(() => useRailStore.getState().summon());
    expect(main()).toHaveAttribute('inert');
    expect(counters.view).toBeGreaterThan(before.view);
  });

  it('lays out a braindump, a header capsule and a day that a shell render alone does not re-render', async () => {
    const memo = Symbol.for('react.memo');
    const real = {
      sidebar: await vi.importActual<typeof import('@/components/sidebar/sidebar')>('@/components/sidebar/sidebar'),
      capsule: await vi.importActual<typeof import('@/components/canvas/header-capsule')>(
        '@/components/canvas/header-capsule'
      ),
      router: await vi.importActual<typeof import('@/components/views/view-router')>('@/components/views/view-router'),
    };
    expect((real.sidebar.Sidebar as unknown as { $$typeof: symbol }).$$typeof).toBe(memo);
    expect((real.capsule.HeaderCapsule as unknown as { $$typeof: symbol }).$$typeof).toBe(memo);
    expect((real.router.ViewRouter as unknown as { $$typeof: symbol }).$$typeof).toBe(memo);
  });

  it('centres the bulk bar on the space left of a docked rail, as wide as that space allows', () => {
    // Never the canvas's width: beside the rail at 1280 the day can be ~380px,
    // and the full row of actions is ~590.
    render(
      <>
        <DesktopShell />
        <BulkActionBar />
      </>
    );
    act(() => useSelectionStore.getState().replace(['t1', 't2']));
    let bar = screen.getByTestId('bulk-action-bar');
    // Ask docked: centred on (100vw - 432px) / 2, capped 16px a side inside it.
    expect(bar.style.left).toBe('calc(50% - 216px)');
    expect(bar.style.maxWidth).toBe('calc(100vw - 464px)');

    // No AI: nothing docked, the window's centre. Then an item docks: the
    // same column, so the same place.
    act(() => seed(NOTHING_CONNECTED));
    expect(bar.style.left).toBe('');
    expect(bar.style.maxWidth).toBe('');
    openRow();
    act(() => useSelectionStore.getState().replace(['t1', 't2']));
    expect(itemOpen()).toBe(true);
    bar = screen.getByTestId('bulk-action-bar');
    expect(bar.style.left).toBe('calc(50% - 216px)');
    expect(bar.style.maxWidth).toBe('calc(100vw - 464px)');

    // An overlaid item covers the canvas: the bar stands down (the next test
    // has why). Once it closes, nothing is held back and the bar is the
    // window's, as it always was (the class list's left-1/2 and phone cap).
    setNarrow(true);
    expect(screen.queryByTestId('bulk-action-bar')).toBeNull();
    act(() => useUIStore.getState().closeDialog());
    bar = screen.getByTestId('bulk-action-bar');
    expect(bar.style.left).toBe('');
    expect(bar.style.maxWidth).toBe('');
    expect(bar).toHaveClass('left-1/2', 'max-w-[calc(100vw-32px)]');
  });

  it('takes the bulk bar away under an overlaid Ask, and gives it back, selection kept, when Ask parks', () => {
    // At or below 1180px, centred on the window, the bar sat on the overlay's
    // card, over Ask's box, with live actions for rows under an inert canvas.
    setNarrow(true);
    render(
      <>
        <DesktopShell />
        <BulkActionBar />
        <ShortcutHarness />
      </>
    );
    act(() => useSelectionStore.getState().replace(['t1', 't2']));
    expect(screen.getByTestId('bulk-action-bar')).toBeInTheDocument();

    expect(pressCtrlJ()).toBe(true);
    expect(askView()).toBeVisible();
    expect(main()).toHaveAttribute('inert');
    expect(useRailStore.getState().covers).toBe(true);
    expect(screen.queryByTestId('bulk-action-bar')).toBeNull();

    // Escape gives the planner back and is the overlay's alone: the selection
    // the bar stood down for is still there, so the bar comes back with it.
    pressEscapeHere();
    expect(askView()).not.toBeVisible();
    expect(main()).not.toHaveAttribute('inert');
    expect(useRailStore.getState().covers).toBe(false);
    expect(useSelectionStore.getState().selectedIds.size).toBe(2);
    expect(screen.getByTestId('bulk-action-bar')).toBeInTheDocument();

    // Docked, the column covers nothing, so the bar stays (beside it).
    setNarrow(false);
    expect(pressCtrlJ()).toBe(true);
    expect(useRailStore.getState().covers).toBe(false);
    expect(screen.getByTestId('bulk-action-bar')).toBeInTheDocument();
  });

  it('lands at full width when the gate answers at boot, and slides on every reveal after', async () => {
    // The launch: Ask was left open, and the gate has not answered yet.
    seed(undefined);
    renderShell();
    expect(column()).toHaveClass('w-0');

    act(() => seed(CONNECTED_MODEL));
    expect(column()).toHaveClass('w-[420px]', 'transition-none');
    expect(column()).toHaveAttribute('data-instant');

    // One frame later the width transition is back, for good (Classic's
    // plate eases its -ml-3 gutter with it).
    await act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));
    expect(column()).not.toHaveAttribute('data-instant');
    expect(column()).toHaveClass('transition-[width,margin-left]');

    act(() => useRailStore.getState().closeRail());
    act(() => useRailStore.getState().summon());
    expect(column()).toHaveClass('w-[420px]', 'transition-[width,margin-left]');
    expect(column()).not.toHaveAttribute('data-instant');
  });

  it('keeps Ask painted while the column eases shut, and lets it go when the ease ends', () => {
    renderShell();
    const view = askView() as HTMLElement;
    expect(pressCtrlJ()).toBe(true);
    // The same ease both ways: the column narrows over its transition while
    // Ask stays on it, out of reach.
    expect(column()).toHaveClass('w-0', 'transition-[width,margin-left]', 'motion-reduce:transition-none');
    expect(askView()).toBe(view);
    expect(view).toBeVisible();
    expect(view).toHaveAttribute('inert');
    // Nothing but the column's own width ending lets it go…
    fireEvent.transitionEnd(view, { propertyName: 'width' });
    fireEvent.transitionEnd(column(), { propertyName: 'opacity' });
    expect(askView()).toBe(view);
    // …and that does.
    fireEvent.transitionEnd(column(), { propertyName: 'width' });
    expect(askView()).toBeNull();
    expect(useRailStore.getState().reservePx).toBe(0);

    // Opening again slides it back in on the same ease.
    expect(pressCtrlJ()).toBe(true);
    expect(column()).toHaveClass('w-[420px]', 'transition-[width,margin-left]');
    expect(askView()).toBeVisible();
    expect(askView()).not.toHaveAttribute('inert');
  });

  it('lets a leaving Ask go on its own when the ease never reports its end', async () => {
    renderShell();
    expect(pressCtrlJ()).toBe(true);
    expect(askView()).not.toBeNull();
    await act(() => new Promise((r) => setTimeout(r, 450)));
    expect(askView()).toBeNull();
  });

  it('closes Ask at once under reduced motion, where there is no ease to wait for', () => {
    document.documentElement.setAttribute('data-reduce-motion', '');
    try {
      renderShell();
      expect(pressCtrlJ()).toBe(true);
      expect(column()).toHaveClass('w-0');
      expect(askView()).toBeNull();
    } finally {
      document.documentElement.removeAttribute('data-reduce-motion');
    }
  });

  it('closes an overlaid Ask at once: its card goes with it', () => {
    setNarrow(true);
    renderShell();
    act(() => useRailStore.getState().summon());
    expect(askView()).toBeVisible();
    act(() => useRailStore.getState().closeRail());
    expect(askView()).toBeNull();
  });

  it('says when its reserve came with the instant boot reveal, so the braindump yields without a slide', async () => {
    seed(undefined);
    renderShell();
    expect(useRailStore.getState().reservePx).toBe(0);
    act(() => seed(CONNECTED_MODEL));
    expect(useRailStore.getState()).toMatchObject({ reservePx: 432, reserveInstant: true });
    await act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));

    act(() => useRailStore.getState().closeRail());
    expect(useRailStore.getState()).toMatchObject({ reservePx: 0, reserveInstant: false });
    act(() => useRailStore.getState().summon());
    expect(useRailStore.getState()).toMatchObject({ reservePx: 432, reserveInstant: false });
  });

  it('slides in for a summon, even the first', () => {
    useSidebarStore.setState({ askOpen: false });
    renderShell();
    act(() => useRailStore.getState().summon());
    expect(column()).toHaveClass('w-[420px]', 'transition-[width,margin-left]');
    expect(column()).not.toHaveAttribute('data-instant');
  });

  it('keeps its dress on while Ask leaves, in every layout, and takes it off when the ease ends', () => {
    // Ask stays painted through the close (above); what it is painted ON must
    // stay too, or it sat bare on the desk (Notebook), the grey chrome (the
    // sheet) or the backdrop for the 300ms ease.
    for (const layout of LAYOUTS) {
      useLookStore.setState({ layout: layout.value });
      useSidebarStore.setState({ askOpen: true });
      const view = render(
        <>
          <DesktopShell />
          <ShortcutHarness />
        </>
      );
      const where = layout.value;
      const flat = layout.slots.canvas === 'flat' || layout.slots.canvas === 'sheet';
      const spread = layout.slots.canvas === 'spread';
      const dress = flat
        ? ['box-content', 'border-l', 'bg-canvas']
        : spread
          ? ['ml-12', 'rounded-[6px]', 'bg-[var(--nb-page)]', 'shadow-[var(--nb-sheet-shadow)]']
          : [];
      expect(column(), where).toHaveAttribute('data-rail-docked');
      for (const c of dress) expect(column(), `${where} ${c}`).toHaveClass(c);

      expect(pressCtrlJ()).toBe(true);
      // Leaving: the width has started its ease to 0; the dress has not gone.
      expect(column(), where).toHaveClass('w-0');
      expect(askView(), where).toBeVisible();
      expect(column(), where).toHaveAttribute('data-rail-docked');
      for (const c of dress) expect(column(), `${where} leaving ${c}`).toHaveClass(c);

      fireEvent.transitionEnd(column(), { propertyName: 'width' });
      expect(askView(), where).toBeNull();
      expect(column(), where).not.toHaveAttribute('data-rail-docked');
      for (const c of dress) expect(column(), `${where} closed ${c}`).not.toHaveClass(c);
      view.unmount();
    }
  });

  it('takes its dress off on the fallback when the ease never reports its end', async () => {
    useLookStore.setState({ layout: 'notebook' });
    renderShell();
    expect(pressCtrlJ()).toBe(true);
    expect(column()).toHaveClass('bg-[var(--nb-page)]');
    await act(() => new Promise((r) => setTimeout(r, 450)));
    expect(column()).not.toHaveClass('bg-[var(--nb-page)]');
    expect(column()).not.toHaveAttribute('data-rail-docked');
  });

  it("holds Notebook's page-tab room off the docked column's own mark, never an overlay's", () => {
    useLookStore.setState({ layout: 'notebook' });
    renderShell();
    const root = document.querySelector('[data-click-away-scope]') as HTMLElement;
    // pr-14 holds the page tabs; a column marked docked takes it to pr-5 (CSS
    // :has, so opening and closing re-render nothing out here).
    expect(root).toHaveClass('pr-14', 'has-[[data-rail-docked]]:pr-5');
    expect(column()).toHaveAttribute('data-rail-docked');
    act(() => useRailStore.getState().closeRail());
    fireEvent.transitionEnd(column(), { propertyName: 'width' });
    expect(column()).not.toHaveAttribute('data-rail-docked');
    // An overlay takes no width, so the book keeps its room.
    setNarrow(true);
    act(() => useRailStore.getState().summon());
    expect(askView()).toBeVisible();
    expect(column()).not.toHaveAttribute('data-rail-docked');
  });

  it("eases the plate's gutter with its width; no other layout has one to ease", () => {
    for (const layout of LAYOUTS) {
      useLookStore.setState({ layout: layout.value });
      useSidebarStore.setState({ askOpen: false });
      const view = render(<DesktopShell />);
      act(() => useRailStore.getState().summon());
      const plate = layout.slots.canvas === 'plate';
      expect(column().classList.contains('transition-[width,margin-left]'), layout.value).toBe(plate);
      expect(column().classList.contains('transition-[width]'), layout.value).toBe(!plate);
      act(() => useRailStore.getState().closeRail());
      expect(column().classList.contains('-ml-3'), layout.value).toBe(plate);
      view.unmount();
    }
  });

  it('measures what fits in the day by <main>, not the window', () => {
    // The CSS half of the narrow canvas (app/globals.css, task-row.tsx,
    // header-capsule.tsx) keys off a container named `canvas`. Without it on
    // <main>, every one of those rules silently never matches.
    renderShell();
    expect(main()).toHaveClass('@container/canvas');
    const headerRow = main().querySelector('.canvas-container') as HTMLElement;
    expect(headerRow).toHaveClass('@max-[640px]/canvas:flex-wrap');
  });

  it('puts the help bubble inside <main>', () => {
    renderShell();
    expect(main()).toContainElement(screen.getByLabelText('Help'));
  });

  it('draws nothing while closed, in every layout', () => {
    const states: Array<[string, SeedAI, boolean]> = [
      ['AI, Ask closed', CONNECTED_MODEL, false],
      ['no AI, Ask left open', NOTHING_CONNECTED, true],
    ];
    for (const layout of LAYOUTS) {
      for (const [label, state, askOpen] of states) {
        seed(state);
        useSidebarStore.setState({ askOpen });
        useLookStore.setState({ layout: layout.value });
        const view = render(<DesktopShell />);
        const cls = column().className;
        const where = `${layout.value}, ${label}`;
        expect(cls, where).toMatch(/\bw-0\b/);
        expect(cls, where).not.toMatch(/border|bg-canvas|shadow|bg-\[/);
        view.unmount();
      }
    }
  });

  it('is an opaque card over the canvas while it shows as an overlay', () => {
    renderShell();
    expect(column().className).toMatch(/max-\[1180px\]:bg-canvas/);
    expect(column().className).toMatch(/max-\[1180px\]:shadow-/);
    // Its border sits outside the 420px its children are sized to.
    expect(column().className).toMatch(/max-\[1180px\]:border\b/);
    expect(column()).toHaveClass('max-[1180px]:box-content');
  });

  it('draws the flat and sheet seam outside the 420px its children are sized to', () => {
    for (const layout of LAYOUTS) {
      useLookStore.setState({ layout: layout.value });
      const view = render(<DesktopShell />);
      const flat = layout.slots.canvas === 'flat' || layout.slots.canvas === 'sheet';
      const cls = column().className;
      expect(/(^|\s)border-l(\s|$)/.test(cls), layout.value).toBe(flat);
      // box-content wherever there is a seam, so it never eats the 420.
      expect(/(^|\s)box-content(\s|$)/.test(cls), layout.value).toBe(flat);
      view.unmount();
    }
  });

  it("puts the header's row on the date's line in every layout", () => {
    for (const layout of LAYOUTS) {
      useLookStore.setState({ layout: layout.value });
      const view = render(<DesktopShell />);
      const rowEl = (askView() as HTMLElement).querySelector('[data-rail-header-row]') as HTMLElement;
      const capsule = layout.slots.header === 'capsule';
      expect(rowEl.classList.contains('mt-2'), layout.value).toBe(capsule);
      expect(rowEl.classList.contains('mt-0'), layout.value).toBe(!capsule);
      view.unmount();
    }
  });

  it('is the tour’s Ask target only while something answers', () => {
    renderShell();
    expect(column()).toHaveAttribute('data-tour', 'right-sidebar');
    act(() => seed(NOTHING_CONNECTED));
    expect(column()).not.toHaveAttribute('data-tour');
  });
});

/* ── the Ask button ──────────────────────────────────────────────────── */

describe('the Ask button', () => {
  // Ask starts closed (sidebar-store ASK_OPEN_DEFAULT).
  beforeEach(() => useSidebarStore.setState({ askOpen: false }));
  afterEach(() => useViewStore.setState({ scope: 'day' }));

  const opener = () => document.querySelector<HTMLButtonElement>('[data-ask-opener]') as HTMLButtonElement;
  /** Its pill: the header row's child, the thing that hides. */
  const pill = () => opener().parentElement as HTMLElement;
  /** A pointer's click: the button takes focus, then the click. */
  const clickOpener = () => {
    act(() => opener().focus());
    fireEvent.click(opener());
  };

  it("ends the canvas's header row, on the date's line: the far end in a day, past WeekScale in a week", () => {
    renderShell();
    const headerRow = main().querySelector('.canvas-container') as HTMLElement;
    expect(headerRow.lastElementChild).toBe(pill());
    expect(pill()).toHaveAttribute('data-ask-opener-pill');
    // The rail header's own offset (Classic's capsule: its p-2), so Ask's row lands where it was.
    expect(pill()).toHaveClass('mt-2', 'ml-auto');
    act(() => useViewStore.setState({ scope: 'week', layout: 'buckets' }));
    expect(headerRow).toHaveAttribute('data-wide', 'true');
    // WeekScale holds the far end there; two auto margins would split the room between them.
    expect(pill()).not.toHaveClass('ml-auto');
    act(() => useLookStore.setState({ layout: 'notepad' }));
    expect(pill()).toHaveClass('mt-0');
  });

  it('opens Ask with its box focused, as Ctrl+J does, and hides while the column shows', async () => {
    renderShell();
    expect(askView()).toBeNull();
    clickOpener();
    await timers();
    expect(useSidebarStore.getState().askOpen).toBe(true);
    expect(askView()).not.toHaveAttribute('hidden');
    expect(document.activeElement).toBe(askBox());
    expect(pill()).toHaveAttribute('hidden');
    // Kept mounted, so the hand-back has somewhere to land.
    expect(opener().isConnected).toBe(true);
  });

  it('takes focus back when Ask closes by ✕ or by Ctrl+J from inside it', async () => {
    renderShell();
    clickOpener();
    await timers();
    expect(document.activeElement).toBe(askBox());
    const close = within(askView() as HTMLElement).getByTestId('rail-close');
    act(() => close.focus());
    fireEvent.click(close);
    await timers();
    expect(useSidebarStore.getState().askOpen).toBe(false);
    expect(pill()).not.toHaveAttribute('hidden');
    expect(document.activeElement).toBe(opener());

    // Enter on it (a button's Enter is its click), then Ctrl+J from the box.
    fireEvent.click(opener());
    await timers();
    expect(document.activeElement).toBe(askBox());
    pressCtrlJHere();
    await timers();
    expect(useSidebarStore.getState().askOpen).toBe(false);
    expect(document.activeElement).toBe(opener());
  });

  it('hides while an item is open, and is back when the item and the rail close', async () => {
    renderShell();
    openFromRow('a');
    expect(pill()).toHaveAttribute('hidden');
    fireEvent.click(screen.getByTestId('item-dialog-close'));
    await timers();
    expect(itemOpen()).toBe(false);
    expect(pill()).not.toHaveAttribute('hidden');
  });

  it('is not there with no AI: the column is only the item panel then', () => {
    seed(NOTHING_CONNECTED);
    renderShell();
    expect(opener()).toBeNull();
  });
});

/* ── no AI ───────────────────────────────────────────────────────────── */

describe('with no AI', () => {
  beforeEach(() => seed(NOTHING_CONNECTED));

  it("is today's item panel: Done, no rail header, no box", () => {
    renderShell();
    expect(column()).toHaveClass('w-0');
    expect(askView()).toBeNull();

    openRow();
    expect(within(dialog()).getByTestId('item-dialog-submit')).toBeInTheDocument();
    expect(within(dialog()).queryByTestId('rail-back')).toBeNull();
    expect(within(dialog()).queryByTestId('item-dialog-close')).toBeNull();
    expect(dialog().querySelector('[data-rail-header], [data-rail-body], [data-ask-composer]')).toBeNull();
    // The flat panel's own recipe, untouched.
    expect(dialog()).toHaveClass('overflow-y-auto', 'px-5', 'pt-[42px]', 'pb-5');
  });

  it('keeps Ctrl+J from the browser and does nothing with it', () => {
    renderShell();
    openRow();
    expect(pressCtrlJ()).toBe(true);
    expect(itemOpen()).toBe(true);
    expect(useSidebarStore.getState().askOpen).toBe(true);
    expect(useRailStore.getState().summoned).toBe(false);
    act(() => useUIStore.getState().closeDialog());
    expect(pressCtrlJ()).toBe(true);
    expect(useRailStore.getState().summoned).toBe(false);
    expect(column()).toHaveClass('w-0');
  });
});

/* ── the pieces ──────────────────────────────────────────────────────── */

/* ── Ask home in the column ──────────────────────────────────────────── */

describe('Ask home in the column', () => {
  const WAITING = task({
    id: 't3',
    title: 'Pick a plumber',
    order: 2,
    assignee: 'openclaw',
    aiStatus: 'blocked',
    aiResult: 'Which one?',
  } as Partial<TaskItem>);
  const needsTitle = () => within(askView() as HTMLElement).getByTestId('needs-you-title');

  it.each([
    [
      'Back',
      () => {
        const back = within(dialog()).getByTestId('rail-back');
        back.focus();
        fireEvent.click(back);
      },
    ],
    ['Escape', () => pressEscapeHere()],
  ])('hands focus back to the Needs-you title an item was opened from (%s)', async (_how, leave) => {
    usePlannerStore.setState({ items: [DENTIST, PLANTS, WAITING] } as never);
    renderShell();
    needsTitle().focus();
    fireEvent.click(needsTitle());
    await timers();
    expect(itemOpen()).toBe(true);
    expect(within(dialog()).getByDisplayValue('Pick a plumber')).toBeInTheDocument();
    // Ask went hidden under the item, taking the title with it (a browser
    // drops focus to <body> then, and jsdom does not): the item takes it.
    expect(document.activeElement).toBe(dialog());

    leave();
    await timers();
    expect(itemOpen()).toBe(false);
    expect(document.activeElement).toBe(needsTitle());
  });

  it("opens an item's conversation from its activity row, on the Conversation", async () => {
    renderShell();
    await timers();
    const at = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
    listConversations(summary({ id: 'c9', itemId: 't1', title: 'dentist', lastMessageAt: at }));
    const row = (askView() as HTMLElement).querySelector('[data-ask-focus="conv:c9"]') as HTMLElement;
    expect(row).toHaveTextContent('Book the dentist');
    const reveals: unknown[] = [];
    const unsubscribe = useRailStore.subscribe((s) => void reveals.push(s.pendingReveal));
    row.focus();
    fireEvent.click(row);
    await timers();
    unsubscribe();

    expect(itemOpen()).toBe(true);
    expect(within(dialog()).getByDisplayValue('Book the dentist')).toBeInTheDocument();
    // Asked for, then taken by the item's pinned conversation (it is the one
    // that scrolls the rail body to itself once it has something to show).
    expect(reveals).toContainEqual({ itemId: 't1' });
    expect(useRailStore.getState().pendingReveal).toBeNull();
    // An item, not a push over Ask: Back from it shows Ask home.
    expect(useRailStore.getState().stacks.desktop).toEqual([]);
    // Opened by keyboard: the item has focus, not <body> under a hidden Ask.
    expect(document.activeElement).toBe(dialog());

    const back = within(dialog()).getByTestId('rail-back');
    back.focus();
    fireEvent.click(back);
    await timers();
    expect(itemOpen()).toBe(false);
    expect(document.activeElement).toBe(row);
  });

  it('opens an item from a History row by keyboard, and Back hands focus to that row', async () => {
    const at = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
    const general = summary({ id: 'c1', title: 'Plan my day', lastMessageAt: at });
    const api = fakeApi();
    api.answer.thread = (id) => (id === 'c1' ? { ok: true, value: { conversation: general, messages: [], hasEarlier: false } } : undefined);
    configureConversations({ api: api.api, transport: transport.transport });
    renderShell();
    await timers();
    listConversations(summary({ id: 'c9', itemId: 't1', title: 'dentist', lastMessageAt: at }), general);
    push({ kind: 'history', returnFocus: 'history' });
    await timers();
    const historyRow = (id: string) =>
      (askView() as HTMLElement).querySelector<HTMLElement>(`[data-testid="history-row"][data-ask-focus="conv:${id}"]`) as HTMLElement;

    historyRow('c9').focus();
    fireEvent.click(historyRow('c9'));
    await timers();
    expect(itemOpen()).toBe(true);
    expect(document.activeElement).toBe(dialog());
    pressEscapeHere();
    await timers();
    expect(itemOpen()).toBe(false);
    expect(document.activeElement).toBe(historyRow('c9'));

    // A general conversation pushes over History, and Back comes to its row.
    historyRow('c1').focus();
    fireEvent.click(historyRow('c1'));
    await timers();
    expect(useRailStore.getState().stacks.desktop.at(-1)).toMatchObject({ kind: 'conversation', id: 'c1' });
    fireEvent.click(within(askView() as HTMLElement).getByTestId('rail-back'));
    await timers();
    expect(document.activeElement).toBe(historyRow('c1'));
  });

  it("scrolls the rail body, and only it, to the item's Conversation when opened for it", async () => {
    const at = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
    act(() =>
      useConversationsStore.setState((s) => ({
        threads: {
          ...s.threads,
          c9: {
            id: 'c9',
            itemId: 't1',
            draftTitle: null,
            saved: true,
            load: 'loaded',
            hasEarlier: false,
            streaming: false,
            typing: false,
            fetchedAt: Date.now(),
            messages: [0, 1].map((i) => ({
              id: `c9-${i}`,
              role: i % 2 ? 'assistant' : 'user',
              content: `turn ${i}`,
              status: 'complete',
              errorCode: null,
              replyTo: null,
              answerer: 'model',
              model: null,
              createdAt: Date.now(),
              pos: i,
              sync: 'saved',
            })),
          },
        } as never,
        itemIndex: { ...s.itemIndex, t1: 'c9' },
      }))
    );
    const writes: number[] = [];
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const realRect = HTMLElement.prototype.getBoundingClientRect;
    // The section sits 600px down the rail body's box.
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const top = this.dataset.testid === 'item-conversation' ? 640 : this.hasAttribute('data-rail-body') ? 40 : null;
      return top === null ? realRect.call(this) : ({ top, bottom: top, left: 0, right: 0, height: 0, width: 0, x: 0, y: top } as DOMRect);
    };
    Object.defineProperty(proto, 'scrollTop', {
      configurable: true,
      get: () => 0,
      set(this: HTMLElement, v: number) {
        if (this.hasAttribute('data-rail-body')) writes.push(v);
      },
    });
    try {
      renderShell();
      await timers();
      listConversations(summary({ id: 'c9', itemId: 't1', title: 'dentist', lastMessageAt: at }));
      push({ kind: 'history' });
      await timers();
      fireEvent.click((askView() as HTMLElement).querySelector('[data-testid="history-row"]') as HTMLElement);
      await timers();
      expect(itemOpen()).toBe(true);
      expect(within(dialog()).getByTestId('item-conversation')).toBeInTheDocument();
      expect(writes).toEqual([600]);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = realRect;
      delete proto.scrollTop;
    }
  });

  it('keeps an overlay up on Escape in a Needs-you answer with text: the field takes the press', async () => {
    viewport.narrow = true;
    usePlannerStore.setState({ items: [DENTIST, PLANTS, WAITING] } as never);
    renderShell();
    act(() => useRailStore.getState().summon());
    await timers();
    const field = within(askView() as HTMLElement).getByTestId('needs-you-answer') as HTMLInputElement;
    act(() => field.focus());
    fireEvent.change(field, { target: { value: 'The cheaper one' } });

    // D8: the text clears and the press is consumed, so the overlay's own
    // Escape does not also park Ask out from under the card.
    const press = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => void field.dispatchEvent(press));
    expect(press.defaultPrevented).toBe(true);
    expect(useRailStore.getState().summoned).toBe(true);
    expect(askView()).toBeVisible();
    expect(field).toHaveValue('');
  });
});

describe('<AskHome/>, a brand-new account', () => {
  it("holds the catch-up card, the greeting, today's chips and the box, and nothing else", async () => {
    render(<AskHome />);
    const home = document.querySelector('[data-ask-home]') as HTMLElement;
    // Nothing to say yet about the day or the AI's work (ask-home-view.test.tsx
    // has those), so only the greeting.
    expect(home.querySelector('[data-ask-greeting]')).not.toBeNull();
    expect(within(home).queryByTestId('needs-you')).toBeNull();
    expect(within(home).queryByTestId('ai-activity')).toBeNull();
    expect(home.querySelector('[data-ask-composer] textarea')).not.toBeNull();
    expect(within(home).getByTestId('answerer-label')).toHaveTextContent('gpt-4o-mini');
    expect(within(home).queryByTestId('proposal-card')).toBeNull();

    act(() => {
      void useProposalStore.getState().request('catch-up');
    });
    expect(within(home).getByTestId('proposal-card')).toBeInTheDocument();

    // A chip starts a fresh conversation, titled with its label, and pushes it.
    const chip = within(screen.getByTestId('chat-openers')).getAllByRole('button')[0];
    fireEvent.click(chip);
    await act(() => flush());
    const top = useRailStore.getState().stacks.desktop.at(-1);
    expect(top?.kind).toBe('conversation');
    expect(transport.inputs).toHaveLength(1);
  });
});

describe('<RailHeader/>', () => {
  it('heads Ask home with no way back', () => {
    render(<RailHeader home title="Ask" onClose={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Ask' })).toHaveAttribute('tabindex', '-1');
    expect(screen.queryByTestId('rail-back')).toBeNull();
  });

  it('names where Back goes, and calls each control once', () => {
    const onBack = vi.fn();
    const onClose = vi.fn();
    render(<RailHeader back={{ label: 'History', onBack }} title="Trip plans" onClose={onClose} />);
    const back = screen.getByRole('button', { name: 'Back to History' });
    expect(back).toHaveTextContent(/^History$/);
    fireEvent.click(back);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Trip plans' })).toBeInTheDocument();
  });

  it('keeps the back label whole beside a long title, which truncates instead', () => {
    // A flex row shrinks both in proportion, and "‹ History" read "‹ H…".
    render(<RailHeader back={{ label: 'History', onBack: () => {} }} title={'Plan my day '.repeat(5)} onClose={() => {}} />);
    expect(screen.getByTestId('rail-back')).toHaveClass('shrink-0', 'max-w-[45%]');
    expect(screen.getByTestId('rail-back')).not.toHaveClass('min-w-0');
    expect(screen.getByRole('heading')).toHaveClass('min-w-0', 'flex-1');
  });

  it('with no heading (the item view), lets the label take the row', () => {
    render(<RailHeader back={{ label: 'Plan my day around the dentist', onBack: () => {} }} onClose={() => {}} />);
    expect(screen.getByTestId('rail-back')).toHaveClass('min-w-0');
    expect(screen.getByTestId('rail-back')).not.toHaveClass('shrink-0');
    expect(screen.getByTestId('rail-close')).toHaveClass('ml-auto');
  });
});
