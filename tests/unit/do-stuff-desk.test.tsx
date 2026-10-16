import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';

// RelayField (the braindump's empty-state backdrop) reads prefers-reduced-motion.
beforeAll(() => {
  // The day column measures itself.
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
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
 * The Desk (memory/plans/power-mode.md, the polish round): while doing stuff,
 * the canvas becomes the current item set large (notes, steps, a jot box and
 * its conversation) beside today's day column. It follows the walk, and Esc or
 * stopping the mode closes it.
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
import { ViewRouter } from '@/components/views/view-router';
import { usePlannerStore } from '@/lib/planner-store';
import { useDoStuffStore } from '@/lib/do-stuff';
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

function seed(items: Item[]) {
  usePlannerStore.setState({
    userId: 'user-1',
    isLoading: false,
    error: null,
    userTimezone: 'UTC',
    selectedDate: new Date(Date.now() + 3 * 86_400_000),
    items,
    tasks: items.filter((i) => !(i as { parentItemId?: string }).parentItemId) as never,
    habits: [],
    projects: [],
    routines: [],
    seasons: [],
    goals: [],
  });
  useViewStore.setState({
    scope: 'day',
    layout: 'buckets',
    braindumpGroupBy: 'none',
    braindumpSortBy: 'default',
    braindumpFilters: EMPTY_VIEW_FILTERS,
  });
}

const ITEMS = [
  task('a', { title: 'reply to sam about the lease', size: 'quick', notes: 'renewal or month to month?' }),
  task('a1', { title: 'find the lease', parentItemId: 'a', order: 0, status: 'completed' }),
  task('a2', { title: 'check the renewal date', parentItemId: 'a', order: 1 }),
  task('b', { title: 'call the dentist', size: 'quick' }),
  task('c', { title: 'pick up stamps', size: 'errand' }),
  task('d', { title: 'declutter the garage', size: 'big' }),
  task('e', { title: 'figure out the budget' }),
  task('f', { title: 'zebra' }),
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

function start() {
  render(
    <DndContext>
      <Braindump />
      <ViewRouter />
    </DndContext>
  );
  fireEvent.click(screen.getByTestId('do-stuff-start'));
}

const byId = (id: string) => usePlannerStore.getState().items.find((i) => i.id === id) as Record<string, unknown>;

describe('the desk', () => {
  it('opens on the current item, on today, with its notes and steps', () => {
    seed(ITEMS);
    start();
    expect(screen.queryByTestId('do-stuff-desk')).toBeNull();
    act(() => {
      fireEvent.click(screen.getByTestId('do-stuff-open-desk'));
    });
    const next = useDoStuffStore.getState().next!;
    expect(next.id).toBe('a');
    const desk = screen.getByTestId('do-stuff-desk-item');
    expect(desk.textContent).toContain('reply to sam about the lease');
    expect(screen.getByTestId('do-stuff-desk-notes').textContent).toContain('renewal or month to month?');
    const steps = screen.getAllByRole('checkbox', { name: /find the lease|check the renewal date/ });
    expect(steps.map((s) => s.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(screen.getByTestId('do-stuff-desk-kicker').textContent).toContain('do it now');
    // Always today: the canvas came back from three days out.
    const sel = usePlannerStore.getState().selectedDate;
    expect(sel.toDateString()).toBe(new Date().toDateString());
  });

  it('ticks a step, and a jot lands at the foot of the notes', () => {
    seed(ITEMS);
    start();
    act(() => {
      fireEvent.click(screen.getByTestId('do-stuff-open-desk'));
    });
    act(() => {
      fireEvent.click(screen.getByRole('checkbox', { name: 'check the renewal date' }));
    });
    expect(byId('a2').status).toBe('completed');
    const jot = screen.getByTestId('do-stuff-desk-jot');
    fireEvent.change(jot, { target: { value: 'landlord prefers email' } });
    act(() => {
      fireEvent.keyDown(jot, { key: 'Enter' });
    });
    expect(byId('a').notes).toBe('renewal or month to month?\nlandlord prefers email');
    expect((jot as HTMLTextAreaElement).value).toBe('');
  });

  it('follows the walk on done, and Esc goes back to the day', () => {
    seed(ITEMS);
    start();
    act(() => {
      fireEvent.click(screen.getByTestId('do-stuff-open-desk'));
    });
    act(() => {
      fireEvent.click(screen.getByTestId('do-stuff-desk-done'));
    });
    expect(byId('a').status).toBe('completed');
    const next = useDoStuffStore.getState().next!;
    expect(screen.getByTestId('do-stuff-desk-item').textContent).toContain(next.title);
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(screen.queryByTestId('do-stuff-desk')).toBeNull();
    expect(useDoStuffStore.getState().desk).toBe(false);
  });

  it('closes when the mode stops', () => {
    seed(ITEMS);
    start();
    act(() => {
      fireEvent.click(screen.getByTestId('do-stuff-open-desk'));
    });
    act(() => useDoStuffStore.getState().stop());
    expect(screen.queryByTestId('do-stuff-desk')).toBeNull();
    act(() => useDoStuffStore.getState().start());
    expect(useDoStuffStore.getState().desk).toBe(false);
  });
});
