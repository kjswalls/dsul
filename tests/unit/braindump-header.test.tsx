import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';

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

/**
 * The Braindump header: a live count of OPEN undated items in place of the
 * word, "X of Y" while a filter narrows the list, the word back until there is
 * a number worth showing, and the name kept for assistive tech. Mounts the
 * real Braindump so the count is the list's own, not arithmetic in this file.
 */

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  createItemType: vi.fn(async () => {}),
  updateItemType: vi.fn(async () => {}),
  deleteItemType: vi.fn(async () => {}),
  createItem: vi.fn(async () => {}),
  updateItem: vi.fn(async () => {}),
  deleteItem: vi.fn(async () => {}),
  restoreItem: vi.fn(async () => {}),
  setItemCompletion: vi.fn(async () => {}),
  createProject: vi.fn(async () => {}),
  updateProject: vi.fn(async () => {}),
  deleteProject: vi.fn(async () => {}),
  restoreProject: vi.fn(async () => {}),
  fetchRoutines: vi.fn(async () => []),
  createRoutine: vi.fn(async () => {}),
  updateRoutine: vi.fn(async () => {}),
  deleteRoutine: vi.fn(async () => {}),
  restoreRoutine: vi.fn(async () => {}),
  fetchSeasons: vi.fn(async () => []),
  createSeason: vi.fn(async () => {}),
  updateSeason: vi.fn(async () => {}),
  deleteSeason: vi.fn(async () => {}),
  restoreSeason: vi.fn(async () => {}),
  fetchGoals: vi.fn(async () => []),
  createGoal: vi.fn(async () => {}),
  updateGoal: vi.fn(async () => {}),
  deleteGoal: vi.fn(async () => {}),
  restoreGoal: vi.fn(async () => {}),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));

import { Braindump } from '@/components/sidebar/braindump';
import { usePlannerStore } from '@/lib/planner-store';
import { useUIStore } from '@/lib/ui-store';
import { __resetHeldCapturesForTests } from '@/lib/held-captures';
import { useViewStore } from '@/lib/view-store';
import { useKeyboardShortcutsStore } from '@/lib/keyboard-shortcuts-store';
import { EMPTY_VIEW_FILTERS } from '@/lib/filters';
import type { Item } from '@/lib/planner-types';
import { enableGoalsAndOrganize } from './support/extensions';

const task = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    type: 'task',
    id,
    title: `Task ${id}`,
    status: 'pending',
    isScheduled: false,
    order: 0,
    ...extra,
  }) as unknown as Item;

function seed(items: Item[], state: Record<string, unknown> = {}) {
  usePlannerStore.setState({
    userId: 'user-1',
    isLoading: false,
    error: null,
    userTimezone: 'UTC',
    items,
    tasks: items as never,
    habits: [],
    projects: [
      { id: 'p1', name: 'Work', emoji: '💼' },
      { id: 'p2', name: 'Home', emoji: '🏠' },
    ],
    routines: [],
    seasons: [],
    goals: [],
    ...state,
  });
  useViewStore.setState({
    braindumpGroupBy: 'none',
    braindumpSortBy: 'default',
    braindumpFilters: EMPTY_VIEW_FILTERS,
  });
}

const renderBraindump = () =>
  render(
    <DndContext>
      <Braindump />
    </DndContext>
  );

const heading = () => screen.getByRole('heading', { level: 2 });
const count = () => screen.queryByTestId('braindump-count')?.textContent;

const FOUR = [
  task('a', { project: 'Work' }),
  task('b', { project: 'Work' }),
  task('c', { project: 'Home' }),
  task('d', { project: 'Home', status: 'completed' }),
  // Scheduled: not a member at all, so in neither number.
  task('e', { project: 'Work', isScheduled: true, timeBucket: 'morning' }),
];

beforeEach(() => {
  enableGoalsAndOrganize();
  useKeyboardShortcutsStore.setState({ overrides: {} });
});
afterEach(cleanup);

describe('braindump header: the count', () => {
  it('counts open undated items and keeps the name for assistive tech', () => {
    seed(FOUR);
    renderBraindump();
    // Three open; the finished one sinks in the list but is not waiting on a day.
    expect(count()).toBe('3 undated');
    // textContent, not toHaveAccessibleName: jsdom's name computation joins
    // inline spans without their spaces, which no browser does.
    expect(heading().textContent).toBe('Braindump, 3 undated');
    expect(heading()).toHaveAccessibleName(/^Braindump/);
  });

  it('reads "X of Y" while a filter narrows the list', () => {
    seed(FOUR);
    useViewStore.setState({
      braindumpFilters: { ...EMPTY_VIEW_FILTERS, containers: ['project:Work'] },
    });
    renderBraindump();
    expect(count()).toBe('2 of 3');
  });

  it('does not treat Hide finished as narrowing — it never changes an open count', () => {
    seed(FOUR);
    useViewStore.setState({ braindumpFilters: { ...EMPTY_VIEW_FILTERS, hideFinished: true } });
    renderBraindump();
    expect(count()).toBe('3 undated');
  });

  it('ignores a goal clause that resolves to nothing', () => {
    // No live goal named: passesGoalFilter treats it as inert, so "3 of 3"
    // would be a filter the list is not applying.
    seed(FOUR);
    useViewStore.setState({ braindumpFilters: { ...EMPTY_VIEW_FILTERS, goals: ['gone'] } });
    renderBraindump();
    expect(count()).toBe('3 undated');
  });

  it('keeps counting when a filter leaves nothing', () => {
    seed(FOUR);
    useViewStore.setState({ braindumpFilters: { ...EMPTY_VIEW_FILTERS, priorities: ['high'] } });
    renderBraindump();
    expect(count()).toBe('0 of 3');
  });

  it('shows the word until the planner has loaded', () => {
    seed(FOUR, { isLoading: true });
    renderBraindump();
    expect(count()).toBeUndefined();
    expect(heading()).toHaveTextContent('Braindump');
    // The count and the list's skeleton share one gate (lib/planner-ready.ts),
    // so they flip on the same edge — never a number over bars, or bars under one.
    expect(screen.queryByTestId('planner-skeleton')).not.toBeNull();
    act(() => usePlannerStore.setState({ isLoading: false }));
    expect(count()).toBe('3 undated');
    expect(screen.queryByTestId('planner-skeleton')).toBeNull();
  });

  it('shows the word, not "0 undated", over an empty list', () => {
    seed([task('x', { status: 'completed' })]);
    renderBraindump();
    expect(count()).toBeUndefined();
    expect(heading()).toHaveTextContent('Braindump');
  });

  it('drops the decorative lines glyph that looked like a menu', () => {
    seed(FOUR);
    renderBraindump();
    expect(document.querySelector('.lucide-align-left')).toBeNull();
  });
});

describe('braindump header: tooltips', () => {
  it('opens the add tooltip on hover with the live new-task binding', async () => {
    seed(FOUR);
    renderBraindump();
    const add = screen.getByLabelText('Add task');
    fireEvent.pointerEnter(add);
    fireEvent.pointerMove(add);
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent(/Add task/);
    // The live binding, drawn as keycaps — not a printed letter.
    expect(tip).toHaveTextContent(/Shortcut\s*N/i);
  });

  it('follows a rebinding of the new-task shortcut', async () => {
    seed(FOUR);
    useKeyboardShortcutsStore.setState({ overrides: { new_task: ['t'] } });
    renderBraindump();
    const add = screen.getByLabelText('Add task');
    fireEvent.pointerEnter(add);
    fireEvent.pointerMove(add);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/Shortcut\s*T/i);
  });

  // jsdom's selector engine answers :focus-visible like :focus, so the
  // browser's modality heuristic is stood in for here: the hook is asked
  // "is this focus-visible" and each test answers it.
  const focusVisible = (visible: boolean) => {
    const real = Element.prototype.matches;
    return vi.spyOn(Element.prototype, 'matches').mockImplementation(function (
      this: Element,
      sel: string
    ) {
      return sel === ':focus-visible' ? visible : real.call(this, sel);
    });
  };

  it('does not open on focus handed back after a click (not :focus-visible)', async () => {
    seed(FOUR);
    renderBraindump();
    const add = screen.getByLabelText('Add task');
    // A click that has fully finished — pointerup releases Radix's own
    // pointer-down guard — then focus handed back the way a closing dialog
    // hands it.
    fireEvent.pointerDown(add);
    fireEvent.pointerUp(document);
    const spy = focusVisible(false);
    act(() => add.focus());
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole('tooltip')).toBeNull();
    spy.mockRestore();
  });

  it('does open on keyboard focus (:focus-visible)', async () => {
    seed(FOUR);
    renderBraindump();
    const add = screen.getByLabelText('Add task');
    const spy = focusVisible(true);
    act(() => add.focus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/Add task/);
    spy.mockRestore();
  });

  it('does not spring the Display tooltip back when its menu closes', async () => {
    seed(FOUR);
    renderBraindump();
    const trigger = screen.getByTestId('display-trigger-braindump');
    fireEvent.pointerEnter(trigger);
    fireEvent.pointerMove(trigger);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/Display/);
    // Open the menu the way a click does, then leave it with Escape.
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    expect(await screen.findByTestId('display-menu')).toBeInTheDocument();
    // Closing hands focus back to the trigger; after a mouse click a browser
    // does not call that :focus-visible.
    const spy = focusVisible(false);
    fireEvent.keyDown(screen.getByTestId('display-menu'), { key: 'Escape' });
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByTestId('display-menu')).toBeNull();
    expect(screen.queryByRole('tooltip')).toBeNull();
    spy.mockRestore();
  });

  it('gives the phone no tooltips', async () => {
    seed(FOUR);
    render(
      <DndContext>
        <Braindump variant="mobile" />
      </DndContext>
    );
    const add = screen.getByLabelText('Add task');
    fireEvent.pointerEnter(add);
    fireEvent.pointerMove(add);
    fireEvent.focus(add);
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

/**
 * The quick-add row before the planner has LOADED (cold load, look-only
 * preview, failed load). Typed text is never lost: Enter holds the capture
 * (lib/held-captures.ts) and it lands with the fresh data — an intended fix,
 * since a cold-load capture used to be erased by the landing set() — and ＋
 * keeps the text rather than handing it to a dialog that cannot open yet.
 */
describe('braindump quick-add: before the planner has loaded', () => {
  let frames: FrameRequestCallback[] = [];
  let scrolls: number[] = [];

  const input = () => screen.getByTestId('braindump-quick-add-input') as HTMLInputElement;
  const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
  /** Two rounds: the scroll waits two frames (commit, then layout). */
  const runFrames = () => {
    for (let i = 0; i < 2; i++) {
      const due = frames;
      frames = [];
      due.forEach((cb) => cb(0));
    }
  };
  /** The scroll port, with something to scroll and every write to it recorded. */
  const watchScroll = () => {
    const port = document.querySelector('[data-testid="braindump"] .overflow-y-auto') as HTMLElement;
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 640 });
    Object.defineProperty(port, 'scrollTop', {
      configurable: true,
      get: () => 0,
      set: (v: number) => scrolls.push(v),
    });
  };
  /** Cached rows on screen, the load still out: the look-only preview. */
  const seedPreview = () => seed(FOUR, { isLoading: true, isPreview: true });

  beforeEach(() => {
    frames = [];
    scrolls = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    __resetHeldCapturesForTests();
    useUIStore.setState({ activeDialog: null, deferredDialog: null });
  });
  afterEach(() => {
    vi.mocked(window.requestAnimationFrame).mockRestore();
    __resetHeldCapturesForTests();
    usePlannerStore.setState({ isPreview: false, loadFailedUserId: null });
  });

  it('scrolls the new row into view on a loaded Enter — the control for the case below', () => {
    seed(FOUR);
    renderBraindump();
    watchScroll();

    type('Gamma');
    fireEvent.keyDown(input(), { key: 'Enter' });
    act(runFrames);

    expect(usePlannerStore.getState().items.filter((i) => i.title === 'Gamma')).toHaveLength(1);
    expect(scrolls).toEqual([640]);
    expect(screen.queryByTestId('quick-add-held')).toBeNull();
  });

  it('holds an Enter while previewing: clears, says so, does not scroll, and lands once', async () => {
    seedPreview();
    renderBraindump();
    watchScroll();

    type('Gamma');
    fireEvent.keyDown(input(), { key: 'Enter' });
    act(runFrames);

    expect(input().value).toBe('');
    expect(document.activeElement).toBe(input());
    expect(screen.getByTestId('quick-add-held')).toHaveTextContent('Adds once synced');
    expect(screen.getByTestId('quick-add-held')).toHaveAttribute('role', 'status');
    // A held capture lands mid-settle; scrolling for a row that does not exist
    // yet would yank the list under the landing.
    expect(scrolls).toEqual([]);
    expect(usePlannerStore.getState().items.some((i) => i.title === 'Gamma')).toBe(false);

    // The fresh data lands.
    await act(async () => {
      usePlannerStore.setState({ isLoading: false, isPreview: false });
      await Promise.resolve();
    });

    expect(usePlannerStore.getState().items.filter((i) => i.title === 'Gamma')).toHaveLength(1);
    expect(screen.getAllByText('Gamma')).toHaveLength(1);
    expect(screen.queryByTestId('quick-add-held')).toBeNull();
  });

  it('keeps the text on ＋ while not loaded, and opens nothing', () => {
    seedPreview();
    renderBraindump();

    type('Delta');
    fireEvent.click(screen.getByRole('button', { name: 'Open the full add dialog' }));

    expect(input().value).toBe('Delta');
    expect(document.activeElement).toBe(input());
    const ui = useUIStore.getState();
    expect(ui.activeDialog).toBeNull();
    expect(ui.deferredDialog).toBeNull();
  });

  it('keeps it after a failed load too, whose empty store is settled but not loaded', () => {
    seed([], { error: 'Failed to load data', loadFailedUserId: 'user-1' });
    renderBraindump();

    type('Delta');
    fireEvent.click(screen.getByRole('button', { name: 'Open the full add dialog' }));

    expect(input().value).toBe('Delta');
    expect(useUIStore.getState().activeDialog).toBeNull();
  });

  it('hands the text to the full dialog on ＋ once loaded, as it always has', () => {
    seed(FOUR);
    renderBraindump();

    type('Delta');
    fireEvent.click(screen.getByRole('button', { name: 'Open the full add dialog' }));

    expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'add', tab: 'task', title: 'Delta' });
    expect(input().value).toBe('');
  });
});
