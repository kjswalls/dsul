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
 * Do stuff's keys in the sidebar dock, in place of the capture bar
 * (memory/plans/power-mode.md, round 5): the do stuff key and the launcher
 * key at rest, make it so in the same place while doing stuff, and the column
 * opening to half the window.
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
import { DoStuffDockKeys } from '@/components/sidebar/do-stuff-dock';
import { DO_STUFF_SPLIT_MAX_PX, doStuffSidebarWidth, SIDEBAR_MIN_CANVAS } from '@/lib/sidebar-store';
import { useUIStore } from '@/lib/ui-store';
import { finishRun } from '@/lib/do-stuff';
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

/** The braindump and the dock's keys, as the sidebar lays them out once the dock carries the key. */
const renderDocked = () => {
  useDoStuffStore.setState({ docked: true });
  return render(
    <DndContext>
      <Braindump />
      <DoStuffDockKeys />
    </DndContext>
  );
};

const SIX = [
  task('a', { title: 'email the landlord' }),
  task('b', { title: 'call the dentist' }),
  task('c', { title: 'pick up stamps' }),
  task('d', { title: 'declutter the garage' }),
  task('e', { title: 'figure out the budget' }),
  task('f', { title: 'zebra' }),
];


beforeEach(() => {
  enableExtensions(EXT_DO_STUFF);
  useKeyboardShortcutsStore.setState({ overrides: {} });
  useDoStuffStore.getState().stop();
  useDoStuffStore.setState({ docked: false, available: false });
  useUIStore.setState({ activeDialog: null });
  usePrepPacksStore.setState({ userId: 'user-1', packs: {}, loaded: true, available: true, preparing: {}, tried: {}, error: null });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  useAgentsStore.setState({ agents: [], loaded: false });
});
afterEach(cleanup);

describe('do stuff in the dock', () => {
  it('tells the dock the braindump wants the key', () => {
    seed(SIX);
    render(
      <DndContext>
        <Braindump />
      </DndContext>
    );
    expect(useDoStuffStore.getState().available).toBe(true);
  });

  it('does not want it for a short list, so a fresh dock keeps its bar', () => {
    seed(SIX.slice(0, 3));
    render(
      <DndContext>
        <Braindump />
      </DndContext>
    );
    expect(useDoStuffStore.getState().available).toBe(false);
  });

  it('moves the key out of the header and draws no strip while it runs', () => {
    seed(SIX);
    renderDocked();
    expect(screen.getAllByTestId('do-stuff-start')).toHaveLength(1);
    expect(screen.getByTestId('do-stuff-start')).toHaveAttribute('data-do-key-place', 'dock');
    fireEvent.click(screen.getByTestId('do-stuff-start'));
    expect(screen.getByTestId('do-stuff-list')).toBeInTheDocument();
    expect(screen.queryByTestId('do-stuff-on')).toBeNull();
  });

  it('turns the key into make it so, which commits the plan and stops', () => {
    seed(SIX);
    renderDocked();
    fireEvent.click(screen.getByTestId('do-stuff-start'));
    const key = screen.getByTestId('do-stuff-make-it-so');
    expect(key).toHaveAccessibleName('Make it so: 2 onto days');
    expect(key).toHaveAttribute('data-do-key-plain');
    act(() => {
      fireEvent.click(key);
    });
    const byId = new Map(usePlannerStore.getState().items.map((i) => [i.id, i as { startDate?: string }]));
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(byId.get('c')?.startDate).toBe(tomorrow);
    expect(byId.get('d')?.startDate).toBe(tomorrow);
    expect(useDoStuffStore.getState().on).toBe(false);
    expect(screen.getByTestId('do-stuff-start')).toBeInTheDocument();
  });

  it('stops without writing from the ✕', () => {
    seed(SIX);
    renderDocked();
    fireEvent.click(screen.getByTestId('do-stuff-start'));
    fireEvent.click(screen.getByTestId('do-stuff-stop'));
    expect(useDoStuffStore.getState().on).toBe(false);
    for (const i of usePlannerStore.getState().items) expect((i as { startDate?: string }).startDate).toBeUndefined();
  });

  it('reads "finish" when there is nothing to move', () => {
    seed([task('a', { title: 'zebra' }), ...SIX.slice(4)], {});
    useDoStuffStore.setState({ available: true });
    renderDocked();
    fireEvent.click(screen.getByTestId('do-stuff-start'));
    expect(screen.queryByTestId('do-stuff-make-it-so')).toBeNull();
    fireEvent.click(screen.getByTestId('do-stuff-finish'));
    expect(useDoStuffStore.getState().on).toBe(false);
  });

  it('opens the launcher from its key', () => {
    seed(SIX);
    renderDocked();
    fireEvent.click(screen.getByTestId('dock-launcher-key'));
    expect(useUIStore.getState().activeDialog).toEqual({ type: 'launcher' });
  });

  it('commits from the chord too (finishRun)', () => {
    seed(SIX);
    renderDocked();
    fireEvent.click(screen.getByTestId('do-stuff-start'));
    act(() => finishRun());
    expect(useDoStuffStore.getState().on).toBe(false);
    const c = usePlannerStore.getState().items.find((i) => i.id === 'c') as { startDate?: string };
    expect(c.startDate).toBeDefined();
  });
});

describe('the column while doing stuff', () => {
  it('opens to two fifths of what the rail leaves, up to its cap', () => {
    expect(doStuffSidebarWidth(320, 1600)).toBe(640);
    expect(doStuffSidebarWidth(320, 1600, 400)).toBe(480);
    expect(doStuffSidebarWidth(320, 2560)).toBe(DO_STUFF_SPLIT_MAX_PX);
  });

  it('never narrows a column already wider, nor takes the canvas below its floor', () => {
    expect(doStuffSidebarWidth(900, 1600)).toBe(900);
    expect(doStuffSidebarWidth(200, 1180, 400)).toBe(1180 - 400 - SIDEBAR_MIN_CANVAS);
  });

  it('stays as it is below the docking width', () => {
    expect(doStuffSidebarWidth(320, 1100)).toBe(320);
  });

  it('is the user\'s own width again at the desk, so the room has its room', () => {
    expect(doStuffSidebarWidth(320, 1600, 0, true)).toBe(320);
    expect(doStuffSidebarWidth(320, 1280, 300, true)).toBe(320);
    expect(doStuffSidebarWidth(320, 1280, 300, false)).toBe(392);
  });
});
