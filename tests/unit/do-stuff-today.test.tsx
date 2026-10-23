import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react';
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
 * One do stuff (memory/plans/power-mode.md, round 5): today's open rows at no
 * fixed time join the braindump's in the lanes, wear a "today" tag, show where
 * they are going on the grid, and the up-next card and the arriving rows sit
 * in the canvas header.
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
import { DoStuffToday } from '@/components/sidebar/do-stuff-today';
import { TaskRow } from '@/components/primitives/task-row';
import { usePlannerStore } from '@/lib/planner-store';
import { startSprint, useDoStuffStore } from '@/lib/do-stuff';
import { usePrepPacksStore } from '@/lib/prep-packs-store';
import { useAgentsStore } from '@/lib/agents-store';
import { useViewStore } from '@/lib/view-store';
import { useKeyboardShortcutsStore } from '@/lib/keyboard-shortcuts-store';
import { EMPTY_VIEW_FILTERS } from '@/lib/filters';
import type { Item } from '@/lib/planner-types';
import { enableExtensions } from './support/extensions';
import { EXT_DO_STUFF } from '@/lib/extension-registry';

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

const SIX = [
  task('a', { title: 'email the landlord' }),
  task('b', { title: 'call the dentist' }),
  task('c', { title: 'pick up stamps' }),
  task('d', { title: 'declutter the garage' }),
  task('e', { title: 'figure out the budget' }),
  task('f', { title: 'zebra' }),
];

// The lanes fold to peeks while doing stuff (L1); these tests read every lane.
const unfold = () => {
  for (const peek of screen.queryAllByTestId(/^do-stuff-peek-/)) fireEvent.click(peek);
};

const laneOfRow = (title: string) => {
  unfold();
  return screen.getByText(title, { selector: '[data-lane-row] *' }).closest('[data-lane]')?.getAttribute('data-lane');
};

const today = new Date().toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const onToday = (id: string, extra: Record<string, unknown>) =>
  task(id, { startDate: today, isScheduled: true, timeBucket: 'morning', ...extra });

const TODAY = [
  onToday('t1', { title: 'water the plants', size: 'errand' }),
  onToday('t2', { title: 'text sam back', size: 'quick' }),
  // At a fixed time: it stays where it is, out of the plan.
  onToday('t3', { title: 'dentist at ten', size: 'errand', startTime: '10:00' }),
];

beforeEach(() => {
  enableExtensions(EXT_DO_STUFF);
  useKeyboardShortcutsStore.setState({ overrides: {} });
  useDoStuffStore.getState().stop();
  usePrepPacksStore.setState({ userId: 'user-1', packs: {}, loaded: true, available: true, preparing: {}, tried: {}, error: null });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  useAgentsStore.setState({ agents: [], loaded: false });
});
afterEach(cleanup);

const start = () => {
  render(
    <DndContext>
      <Braindump />
      <DoStuffToday />
    </DndContext>
  );
  fireEvent.click(screen.getByTestId('do-stuff-start'));
};

const hoverKey = (title: string, key: string) => {
  unfold();
  (document.activeElement as HTMLElement | null)?.blur();
  fireEvent.mouseEnter(screen.getByText(title, { selector: '[data-lane-row] *' }).closest('[data-lane-row]')!);
  fireEvent.keyDown(window, { key });
};

const byId = () => new Map(usePlannerStore.getState().items.map((i) => [i.id, i as Record<string, unknown>]));

describe('one do stuff: today joins the plan', () => {
  it('plans today\'s open rows beside the braindump\'s, tagged, and leaves a timed one alone', () => {
    seed([...SIX, ...TODAY]);
    start();
    expect(laneOfRow('water the plants')).toBe('today');
    expect(laneOfRow('text sam back')).toBe('now');
    expect(screen.queryByText('dentist at ten')).toBeNull();
    expect(screen.getAllByTestId('do-stuff-today-tag')).toHaveLength(2);
  });

  it('writes nothing for a today row that stays on today', () => {
    seed([...SIX, ...TODAY]);
    start();
    act(() => {
      fireEvent.click(screen.getByTestId('do-stuff-make-it-so'));
    });
    expect(byId().get('t1')).toMatchObject({ startDate: today, isScheduled: true, timeBucket: 'morning' });
  });

  it('moves a today row to another day, or back to the braindump for later', () => {
    seed([...SIX, ...TODAY]);
    start();
    hoverKey('water the plants', '4');
    hoverKey('text sam back', '5');
    expect(useDoStuffStore.getState().commit?.unschedule).toEqual(['t2']);
    act(() => {
      fireEvent.click(screen.getByTestId('do-stuff-make-it-so'));
    });
    expect(byId().get('t1')?.startDate).toBe(tomorrow);
    expect(byId().get('t2')?.isScheduled).toBe(false);
    expect(byId().get('t2')?.timeBucket).toBeUndefined();
  });

  it('shows the up-next card and the rows arriving on today', () => {
    seed([...SIX, ...TODAY]);
    start();
    // Do it now: the braindump's two quick ones, then today's quick one.
    expect(screen.getByTestId('do-stuff-up-next')).toHaveTextContent('email the landlord');
    // The braindump's do it now rows come onto today; today's own do not.
    const arriving = screen.getAllByTestId('do-stuff-arriving').map((a) => a.textContent);
    expect(arriving).toEqual(['call the dentist']);
    act(() => {
      fireEvent.click(screen.getByTestId('do-stuff-up-next-skip'));
    });
    expect(screen.getByTestId('do-stuff-up-next')).toHaveTextContent('call the dentist');
  });

  it('marks a today row on the grid with where it is going, and nothing at rest', () => {
    seed([...SIX, ...TODAY]);
    const row = { itemType: 'task' as const, item: TODAY[0] as never };
    const grid = render(<TaskRow row={row} context="bucket" date={new Date()} />);
    expect(grid.queryByTestId('do-stuff-mark')).toBeNull();
    grid.unmount();
    start();
    hoverKey('water the plants', '4');
    render(<TaskRow row={row} context="bucket" date={new Date()} />);
    const mark = screen.getByTestId('do-stuff-mark');
    expect(mark).toHaveAttribute('data-lane', 'calendar');
    expect(mark).toHaveTextContent('→ tomorrow');
  });
});

describe('the up-next card arrives after the sort', () => {
  const animated: { el: Element; delay: number }[] = [];
  beforeEach(() => {
    animated.length = 0;
    HTMLElement.prototype.animate = vi.fn(function (this: HTMLElement, _k: unknown, o?: number | KeyframeAnimationOptions) {
      animated.push({ el: this, delay: typeof o === 'object' && o ? Number(o.delay ?? 0) : 0 });
      return {} as Animation;
    });
  });
  afterEach(() => {
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
    document.documentElement.removeAttribute('data-reduce-motion');
  });

  it('waits for the rows to land, like the slot and the list card', () => {
    seed([...SIX, ...TODAY]);
    start();
    const card = screen.getByTestId('do-stuff-up-next');
    const arrival = animated.find((a) => a.el === card);
    expect(arrival).toBeDefined();
    expect(arrival!.delay).toBeGreaterThan(0);
  });

  it('and not under reduced motion', () => {
    document.documentElement.setAttribute('data-reduce-motion', '');
    seed([...SIX, ...TODAY]);
    start();
    const card = screen.getByTestId('do-stuff-up-next');
    expect(animated.some((a) => a.el === card)).toBe(false);
  });
});

describe('what counts as done this run', () => {
  const tick = (title: string) => {
    unfold();
    const row = screen.getByText(title, { selector: '[data-lane-row] *' }).closest('[data-lane-row]')!;
    act(() => {
      fireEvent.click(within(row).getByTestId('item-complete-button'));
    });
  };

  it('counts a today row ticked on its own checkbox, and keeps it on the list for "done here"', () => {
    seed([...SIX, ...TODAY]);
    start();
    expect(laneOfRow('text sam back')).toBe('now');
    tick('text sam back');
    expect(byId().get('t2')?.status).toBe('completed');
    expect(useDoStuffStore.getState().doneCount).toBe(1);
    expect(screen.getByTestId('do-stuff-done-here')).toHaveTextContent('1 done here');
    // Not a second time when the card's own done is used on the next one.
    act(() => {
      fireEvent.click(screen.getByTestId('do-stuff-up-next-done'));
    });
    expect(useDoStuffStore.getState().doneCount).toBe(2);
    expect(screen.getByTestId('do-stuff-done-here')).toHaveTextContent('2 done here');
  });

  it('counts a completion from the grid or the store while on, in a walked lane only, and never one from before the run', () => {
    seed([...SIX, ...TODAY, onToday('t9', { title: 'already done', size: 'quick', status: 'completed' })]);
    start();
    expect(useDoStuffStore.getState().doneCount).toBe(0);
    expect(screen.queryByText('already done')).toBeNull();
    act(() => usePlannerStore.getState().toggleTaskStatus('t2', 'completed'));
    expect(useDoStuffStore.getState().doneCount).toBe(1);
    // A row in "later" is not being walked: done there is not the run's.
    act(() => usePlannerStore.getState().toggleTaskStatus('f', 'completed'));
    expect(useDoStuffStore.getState().doneCount).toBe(1);
    // Unticked again, it leaves the count.
    act(() => usePlannerStore.getState().toggleTaskStatus('t2', 'pending'));
    expect(useDoStuffStore.getState().doneCount).toBe(0);
  });

  it('a tick from the grid ends the sprint started for that item, and leaves another\'s alone', () => {
    seed([...SIX, ...TODAY]);
    start();
    act(() => startSprint(25, null, 't2'));
    act(() => usePlannerStore.getState().toggleTaskStatus('t1', 'completed'));
    expect(useDoStuffStore.getState().sprint?.forItem).toBe('t2');
    act(() => usePlannerStore.getState().toggleTaskStatus('t2', 'completed'));
    expect(useDoStuffStore.getState().sprint).toBeNull();
  });
});

describe('the up-next card and the desk', () => {
  it('stands down while the desk is open, with the slot off the grid', () => {
    seed([...SIX, ...TODAY]);
    start();
    expect(screen.getByTestId('do-stuff-up-next')).toBeTruthy();
    act(() => useDoStuffStore.setState({ desk: true, slot: false }));
    expect(screen.queryByTestId('do-stuff-up-next')).toBeNull();
    act(() => useDoStuffStore.setState({ desk: false }));
    expect(screen.getByTestId('do-stuff-up-next')).toBeTruthy();
  });
});
