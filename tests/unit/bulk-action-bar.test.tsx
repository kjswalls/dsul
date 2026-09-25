import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

/**
 * The multiselect bar's Edit menu, rendered for real: which property rows a
 * selection earns, the " · n" honesty suffix, and that drilling into a pane and
 * picking a value calls the store verb with the eligible ids only.
 *
 * The verbs themselves are pinned in bulk-properties.test.ts; here they are
 * spies, so these tests are about what the menu OFFERS and what it SENDS.
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
/**
 * Which shell the Edit menu draws. `touch.current` is flipped per describe: the
 * drill-in Popover for a phone, the hover-flyout dropdown for a pointer.
 */
const touch = vi.hoisted(() => ({ current: true }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => touch.current }));

import { BulkActionBar } from '@/components/shell/bulk-action-bar';
import { usePlannerStore } from '@/lib/planner-store';
import { useSelectionStore } from '@/lib/selection-store';
import { useExtensionsStore } from '@/lib/extensions-store';
import { EXT_GOALS } from '@/lib/extension-registry';
import type { Goal, Item, Routine } from '@/lib/planner-types';

const task = (id: string, over: Record<string, unknown> = {}): Item =>
  ({
    type: 'task',
    id,
    title: `Task ${id}`,
    status: 'pending',
    isScheduled: false,
    order: 0,
    completedDates: [],
    skippedDates: [],
    ...over,
  }) as unknown as Item;

const habit = (id: string): Item =>
  ({
    type: 'habit',
    id,
    title: `Habit ${id}`,
    status: 'pending',
    repeatFrequency: 'daily',
    completedDates: [],
    skippedDates: [],
    streak: 0,
    project: 'Health',
  }) as unknown as Item;

const setItemsPriority = vi.fn();
const setItemsProject = vi.fn();
const setItemsReminder = vi.fn();
const setItemsCollected = vi.fn();
const setItemsGoal = vi.fn();

function seed({
  items,
  routines = [],
  goals = [],
  collectionsAvailable = true,
}: {
  items: Item[];
  routines?: Routine[];
  goals?: Goal[];
  collectionsAvailable?: boolean;
}) {
  usePlannerStore.setState({
    userId: 'user-1',
    userTimezone: 'UTC',
    items,
    projects: [{ id: 'p-work', name: 'Work', emoji: '' }],
    routines,
    programs: [],
    goals,
    collectionsAvailable,
    goalsAvailable: true,
    setItemsPriority,
    setItemsProject,
    setItemsReminder,
    setItemsCollected,
    setItemsGoal,
  });
  useSelectionStore.setState({ selectedIds: new Set(items.map((i) => i.id)) });
}

function openEdit() {
  fireEvent.click(screen.getByTestId('bulk-edit'));
}

const rowKeys = () =>
  screen
    .queryAllByTestId(/^bulk-edit-row-/)
    .map((el) => el.getAttribute('data-testid')!.replace('bulk-edit-row-', ''));

beforeEach(() => {
  vi.clearAllMocks();
  useExtensionsStore.setState({ enabled: {} });
});
afterEach(() => {
  cleanup();
  useSelectionStore.setState({ selectedIds: new Set() });
});

describe('BulkActionBar — Edit menu (touch: drilled in place)', () => {
  beforeEach(() => {
    touch.current = true;
  });

  it('replaces Collect with one Edit button', () => {
    seed({ items: [task('a'), task('b')] });
    render(<BulkActionBar />);
    expect(screen.queryByTestId('bulk-collect')).toBeNull();
    expect(screen.getByTestId('bulk-edit')).toBeInTheDocument();
  });

  it('lists the property rows a task selection earns, in the dialog order', () => {
    seed({
      items: [task('a'), task('b')],
      routines: [{ id: 'r1', name: 'Mornings', itemIds: [] }],
    });
    render(<BulkActionBar />);
    openEdit();
    expect(rowKeys()).toEqual(['priority', 'remind', 'project', 'routine']);
  });

  it('hides rows nothing in the selection can take, and gates goals on the extension', () => {
    // Collections unreachable ⇒ no Routine row, even with a routine present.
    // Goals off (the default) ⇒ no Goal row, even with an active goal.
    seed({
      items: [task('a'), task('b')],
      routines: [{ id: 'r1', name: 'Mornings', itemIds: [] }],
      goals: [{ id: 'g1', name: 'Marathon', state: 'active', memberIds: [], milestoneIds: [], checkinIds: [] } as Goal],
      collectionsAvailable: false,
    });
    render(<BulkActionBar />);
    openEdit();
    expect(rowKeys()).toEqual(['priority', 'remind', 'project']);
  });

  it('shows the Goal row once the extension is on', () => {
    useExtensionsStore.setState({ enabled: { [EXT_GOALS]: true } });
    seed({
      items: [task('a'), task('b')],
      goals: [{ id: 'g1', name: 'Marathon', state: 'active', memberIds: [], milestoneIds: [], checkinIds: [] } as Goal],
    });
    render(<BulkActionBar />);
    openEdit();
    expect(rowKeys()).toContain('goal');
  });

  it('suffixes the eligible count when only part of the selection qualifies', () => {
    seed({ items: [task('a'), habit('h')] });
    render(<BulkActionBar />);
    openEdit();
    // A habit carries no priority, so only one of two is eligible.
    expect(screen.getByTestId('bulk-edit-row-priority')).toHaveTextContent('· 1');
    expect(screen.getByTestId('bulk-edit-row-remind')).not.toHaveTextContent('·');
  });

  it('drills into Priority, and High calls the verb with the eligible ids', () => {
    seed({ items: [task('a'), habit('h'), task('b', { priority: 'low' })] });
    render(<BulkActionBar />);
    openEdit();
    fireEvent.click(screen.getByTestId('bulk-edit-row-priority'));
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
    const high = screen
      .getAllByTestId('bulk-priority-option')
      .find((el) => el.getAttribute('data-value') === 'high')!;
    fireEvent.click(high);
    expect(setItemsPriority).toHaveBeenCalledWith(['a', 'b'], 'high');
    // Back at the root, selection kept for the next property.
    expect(screen.getByTestId('bulk-edit-row-priority')).toBeInTheDocument();
    expect(useSelectionStore.getState().selectedIds.size).toBe(3);
  });

  it('Back returns to the root list', () => {
    seed({ items: [task('a'), task('b')] });
    render(<BulkActionBar />);
    openEdit();
    fireEvent.click(screen.getByTestId('bulk-edit-row-remind'));
    // Focus lands on the time field, not on Back (which precedes it).
    expect(screen.getByTestId('bulk-remind-time')).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(rowKeys()).toContain('remind');
    // …and returns to the row it was drilled from, not the top one.
    expect(screen.getByTestId('bulk-edit-row-remind')).toHaveFocus();
  });

  it('applies a reminder time on Enter, and warns about undated items', () => {
    seed({ items: [task('a'), task('b', { startDate: '2026-09-25' })] });
    render(<BulkActionBar />);
    openEdit();
    fireEvent.click(screen.getByTestId('bulk-edit-row-remind'));
    expect(screen.getByText('1 have no date. Give them one and they will fire.')).toBeInTheDocument();
    // No reminder is set on anything, so there is nothing to clear.
    expect(screen.queryByTestId('bulk-remind-clear')).toBeNull();
    const input = screen.getByTestId('bulk-remind-time');
    fireEvent.change(input, { target: { value: '08:00' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(setItemsReminder).toHaveBeenCalledWith(['a', 'b'], '08:00');
  });

  it('files under a project by name', () => {
    seed({ items: [task('a'), task('b')] });
    render(<BulkActionBar />);
    openEdit();
    fireEvent.click(screen.getByTestId('bulk-edit-row-project'));
    const work = screen
      .getAllByTestId('bulk-project-option')
      .find((el) => el.getAttribute('data-project-id') === 'p-work')!;
    fireEvent.click(work);
    expect(setItemsProject).toHaveBeenCalledWith(['a', 'b'], 'Work');
  });

  it('keeps the routine rows tri-state', () => {
    seed({
      items: [task('a'), task('b')],
      routines: [{ id: 'r1', name: 'Mornings', itemIds: ['a'] }],
    });
    render(<BulkActionBar />);
    openEdit();
    expect(screen.getByTestId('bulk-edit-row-routine')).toHaveTextContent('Mixed');
    fireEvent.click(screen.getByTestId('bulk-edit-row-routine'));
    const row = screen.getByTestId('bulk-collect-option');
    expect(row).toHaveAttribute('data-state', 'some');
    fireEvent.click(row);
    expect(setItemsCollected).toHaveBeenCalledWith(['a', 'b'], 'routine', 'r1', true);
  });

  it('Goal rows add the collectible ids to the goal', () => {
    useExtensionsStore.setState({ enabled: { [EXT_GOALS]: true } });
    seed({
      items: [task('a'), task('b'), task('sub', { parentItemId: 'a' })],
      goals: [{ id: 'g1', name: 'Marathon', state: 'active', memberIds: [], milestoneIds: [], checkinIds: [] } as Goal],
    });
    render(<BulkActionBar />);
    openEdit();
    fireEvent.click(screen.getByTestId('bulk-edit-row-goal'));
    fireEvent.click(screen.getByTestId('bulk-goal-option'));
    // The subtask is not collectible, so it never reaches the verb.
    expect(setItemsGoal).toHaveBeenCalledWith(['a', 'b'], 'g1', true);
  });

  it('No reminder clears, and Apply sets, over the remindable ids', () => {
    seed({ items: [task('a', { reminderTime: '07:00' }), task('b')] });
    render(<BulkActionBar />);
    openEdit();
    fireEvent.click(screen.getByTestId('bulk-edit-row-remind'));
    fireEvent.click(screen.getByTestId('bulk-remind-clear'));
    expect(setItemsReminder).toHaveBeenCalledWith(['a', 'b'], undefined);

    fireEvent.click(screen.getByTestId('bulk-edit-row-remind'));
    fireEvent.change(screen.getByTestId('bulk-remind-time'), { target: { value: '09:15' } });
    fireEvent.click(screen.getByTestId('bulk-remind-apply'));
    expect(setItemsReminder).toHaveBeenLastCalledWith(['a', 'b'], '09:15');
  });

  it('No project counts and clears only the types that may go unfiled', () => {
    seed({ items: [task('a', { project: 'Work' }), habit('h')] });
    render(<BulkActionBar />);
    openEdit();
    fireEvent.click(screen.getByTestId('bulk-edit-row-project'));
    const none = screen
      .getAllByTestId('bulk-project-option')
      .find((el) => el.getAttribute('data-project-id') === '')!;
    // The habit's project is required, so "No project" reaches one of two.
    expect(none).toHaveTextContent('· 1');
    fireEvent.click(none);
    expect(setItemsProject).toHaveBeenCalledWith(['a'], undefined);
  });

  it('closing the popover resets it to the root list', () => {
    seed({ items: [task('a'), task('b')] });
    render(<BulkActionBar />);
    openEdit();
    fireEvent.click(screen.getByTestId('bulk-edit-row-remind'));
    expect(screen.getByTestId('bulk-remind-time')).toBeInTheDocument();
    openEdit(); // the trigger toggles it shut
    expect(screen.queryByTestId('bulk-remind-time')).toBeNull();
    openEdit();
    expect(rowKeys()).toContain('remind');
    expect(screen.queryByTestId('bulk-remind-time')).toBeNull();
  });

  it('hides Edit entirely when no row applies', () => {
    // Cancelled subtasks with nowhere to file them: no priority (cancelled),
    // no reminder or containers (subtasks), and no project to pick or clear.
    seed({
      items: [
        task('s1', { parentItemId: 'p', status: 'cancelled' }),
        task('s2', { parentItemId: 'p', status: 'cancelled' }),
      ],
    });
    usePlannerStore.setState({ projects: [] });
    render(<BulkActionBar />);
    expect(screen.getByTestId('bulk-action-bar')).toBeInTheDocument();
    expect(screen.queryByTestId('bulk-edit')).toBeNull();
  });
});

/**
 * Radix's DropdownMenuTrigger opens on POINTERDOWN, not click; sub-triggers and
 * items do respond to click (see display-menu.test.tsx).
 */
const openMenu = () =>
  fireEvent.pointerDown(screen.getByTestId('bulk-edit'), { button: 0, ctrlKey: false });

describe('BulkActionBar — Edit menu (pointer: flyouts, like the Display menu)', () => {
  beforeEach(() => {
    touch.current = false;
  });

  it('draws a dropdown whose property rows are real submenu triggers', async () => {
    seed({ items: [task('a'), task('b')] });
    render(<BulkActionBar />);
    openMenu();
    const menu = await screen.findByTestId('bulk-edit-menu');
    expect(menu).toHaveAttribute('data-bulk-edit-variant', 'menu');
    expect(screen.getByTestId('bulk-edit-row-priority').getAttribute('data-slot')).toBe(
      'dropdown-menu-sub-trigger'
    );
    expect(screen.queryByLabelText('Back')).toBeNull();
  });

  it('a priority picked in the flyout calls the verb and closes the menu', async () => {
    seed({ items: [task('a'), habit('h')] });
    render(<BulkActionBar />);
    openMenu();
    fireEvent.click(await screen.findByTestId('bulk-edit-row-priority'));
    const high = (await screen.findAllByTestId('bulk-priority-option')).find(
      (el) => el.getAttribute('data-value') === 'high'
    )!;
    expect(high).toHaveAttribute('role', 'menuitemradio');
    fireEvent.click(high);
    expect(setItemsPriority).toHaveBeenCalledWith(['a'], 'high');
    expect(screen.queryByTestId('bulk-edit-menu')).toBeNull();
  });

  it('keeps the menu open while toggling several routines', async () => {
    const routine = { id: 'r1', name: 'Morning', itemIds: ['a'] } as unknown as Routine;
    const routine2 = { id: 'r2', name: 'Evening', itemIds: [] } as unknown as Routine;
    seed({ items: [task('a'), task('b')], routines: [routine, routine2] });
    render(<BulkActionBar />);
    openMenu();
    fireEvent.click(await screen.findByTestId('bulk-edit-row-routine'));
    const rows = await screen.findAllByTestId('bulk-collect-option');
    expect(rows[0]).toHaveAttribute('aria-checked', 'mixed');
    fireEvent.click(rows[1]);
    expect(setItemsCollected).toHaveBeenCalledWith(['a', 'b'], 'routine', 'r2', true);
    expect(screen.getByTestId('bulk-edit-menu')).toBeInTheDocument();
  });

  it('the Remind flyout keeps its keys: typing and Enter set the time', async () => {
    seed({ items: [task('a', { startDate: '2026-09-25' }), task('b', { startDate: '2026-09-25' })] });
    render(<BulkActionBar />);
    openMenu();
    fireEvent.click(await screen.findByTestId('bulk-edit-row-remind'));
    const field = await screen.findByTestId('bulk-remind-time');
    fireEvent.change(field, { target: { value: '08:30' } });
    // Radix's menu content preventDefaults Tab (and runs typeahead on letters)
    // from its own onKeyDown; the pane stops the bubble before it gets there,
    // so Tab still walks from the field to Apply.
    expect(fireEvent.keyDown(field, { key: 'Tab' })).toBe(true);
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(setItemsReminder).toHaveBeenCalledWith(['a', 'b'], '08:30');
    expect(screen.queryByTestId('bulk-edit-menu')).toBeNull();
  });

  it('prefills the shared time, and No reminder clears and closes', async () => {
    seed({ items: [task('a', { reminderTime: '07:15' }), task('b', { reminderTime: '07:15' })] });
    render(<BulkActionBar />);
    openMenu();
    fireEvent.click(await screen.findByTestId('bulk-edit-row-remind'));
    expect(await screen.findByTestId('bulk-remind-time')).toHaveValue('07:15');
    fireEvent.click(screen.getByTestId('bulk-remind-clear'));
    expect(setItemsReminder).toHaveBeenCalledWith(['a', 'b'], undefined);
    expect(screen.queryByTestId('bulk-edit-menu')).toBeNull();
  });

  it('a keyboard-opened Remind flyout steps into the time field', async () => {
    seed({ items: [task('a'), task('b')] });
    render(<BulkActionBar />);
    openMenu();
    const row = await screen.findByTestId('bulk-edit-row-remind');
    row.focus();
    fireEvent.keyDown(row, { key: 'ArrowRight' });
    const field = await screen.findByTestId('bulk-remind-time');
    const flyout = field.closest<HTMLElement>('[data-slot="dropdown-menu-sub-content"]')!;
    fireEvent.keyDown(flyout, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(field);
  });

  it('files under a project from its flyout', async () => {
    seed({ items: [task('a'), task('b')] });
    render(<BulkActionBar />);
    openMenu();
    fireEvent.click(await screen.findByTestId('bulk-edit-row-project'));
    const work = (await screen.findAllByTestId('bulk-project-option')).find(
      (el) => el.getAttribute('data-project-id') === 'p-work'
    )!;
    fireEvent.click(work);
    expect(setItemsProject).toHaveBeenCalledWith(['a', 'b'], 'Work');
  });
});
