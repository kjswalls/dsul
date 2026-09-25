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
  fetchPrograms: vi.fn(async () => []),
  createProgram: vi.fn(async () => {}),
  updateProgram: vi.fn(async () => {}),
  deleteProgram: vi.fn(async () => {}),
  restoreProgram: vi.fn(async () => {}),
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
    programs: [],
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
    act(() => usePlannerStore.setState({ isLoading: false }));
    expect(count()).toBe('3 undated');
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
