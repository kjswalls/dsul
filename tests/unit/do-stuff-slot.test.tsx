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
 * In the day (memory/plans/power-mode.md, the polish round): while doing stuff,
 * the current item opens in today's free stretch on the schedule, the header's
 * up-next card and the list's card stand down to a notched row, done rows leave
 * the walked lanes for a count, and the walk goes on into today when do it now
 * is through.
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
import { DoStuffSlot } from '@/components/sidebar/do-stuff-slot';
import { usePlannerStore } from '@/lib/planner-store';
import { useDoStuffStore } from '@/lib/do-stuff';
import { usePrepPacksStore } from '@/lib/prep-packs-store';
import { useAgentsStore } from '@/lib/agents-store';
import { useViewStore } from '@/lib/view-store';
import { useKeyboardShortcutsStore } from '@/lib/keyboard-shortcuts-store';
import { EMPTY_VIEW_FILTERS } from '@/lib/filters';
import type { Item } from '@/lib/planner-types';
import type { WalkBlock } from '@/lib/do-stuff-walk';
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
    items,
    tasks: items as never,
    habits: [],
    projects: [],
    routines: [],
    seasons: [],
    goals: [],
  });
  useViewStore.setState({
    braindumpGroupBy: 'none',
    braindumpSortBy: 'default',
    braindumpFilters: EMPTY_VIEW_FILTERS,
  });
}

const today = new Date().toISOString().slice(0, 10);
const ITEMS = [
  task('a', { title: 'email the landlord', size: 'quick' }),
  task('b', { title: 'call the dentist', size: 'quick' }),
  task('c', { title: 'pick up stamps', size: 'errand' }),
  task('d', { title: 'declutter the garage', size: 'big' }),
  task('e', { title: 'figure out the budget' }),
  task('f', { title: 'zebra' }),
  task('t1', { title: 'water the plants', size: 'errand', startDate: today, isScheduled: true, timeBucket: 'morning' }),
];

// 11:10, with lunch at 12:30 and deep work at 15:00.
const NOW = 670;
const BLOCKS: WalkBlock[] = [
  { title: 'Lunch with Ana', startMin: 750, duration: 60 },
  { title: 'Deep work', startMin: 900, duration: 90 },
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

function start(blocks: WalkBlock[] = BLOCKS) {
  render(
    <DndContext>
      <Braindump />
      <DoStuffToday />
      <div style={{ position: 'relative' }}>
        <DoStuffSlot blocks={blocks} nowMin={NOW} gridStartHour={8} gridEndHour={20} hourPx={120} />
      </div>
    </DndContext>
  );
  fireEvent.click(screen.getByTestId('do-stuff-start'));
}

const nowLane = () => [...useDoStuffStore.getState().marks].filter(([, m]) => m.lane === 'now').map(([id]) => id);

describe('in the day: the current item on today\'s schedule', () => {
  it('opens in the free stretch, and the header card and the list card stand down', () => {
    seed(ITEMS);
    start();
    const next = useDoStuffStore.getState().next!;
    const slot = screen.getByTestId('do-stuff-slot');
    expect(slot.textContent).toContain(next.title);
    expect(screen.getByTestId('do-stuff-slot-stretch').textContent).toContain('1h 20m free');
    expect(screen.getByTestId('do-stuff-slot-stretch').textContent).toContain('until Lunch with Ana');
    // From 11:10 at 120px an hour on a grid from 8:00, inset clear of the marker.
    expect(slot.style.top).toBe(`${380 + 6}px`);
    expect(useDoStuffStore.getState().slot).toBe(true);
    expect(screen.queryByTestId('do-stuff-up-next')).toBeNull();
    expect(screen.getByTestId('do-stuff-next').dataset.slim).toBe('true');
    expect(screen.queryByTestId('do-stuff-done')).toBeNull();
  });

  it('done leaves the slot where it is, the row leaves its lane, and the next one rises in', () => {
    seed(ITEMS);
    start();
    const first = useDoStuffStore.getState().next!;
    act(() => {
      fireEvent.click(screen.getByTestId('do-stuff-slot-done'));
    });
    const after = useDoStuffStore.getState().next!;
    expect(after.id).not.toBe(first.id);
    expect(screen.getByTestId('do-stuff-slot').textContent).toContain(after.title);
    expect(screen.queryByText(first.title, { selector: '[data-lane-row] *' })).toBeNull();
    expect(screen.getByTestId('do-stuff-done-here').textContent).toContain('1 done here');
  });

  it('walks on into today once do it now is through', () => {
    seed(ITEMS);
    start();
    act(() => {
      for (const id of nowLane()) useDoStuffStore.getState().move(id, 'leave');
    });
    expect(nowLane()).toEqual([]);
    const next = useDoStuffStore.getState().next;
    expect(next).not.toBeNull();
    expect(useDoStuffStore.getState().marks.get(next!.id)?.lane).toBe('today');
    expect(screen.getByTestId('do-stuff-slot').textContent).toContain(next!.title);
  });

  it('gives the item back to the header card when the day has no free time left', () => {
    seed(ITEMS);
    start([{ title: 'Overnight shift', startMin: 600, duration: 900 }]);
    expect(screen.queryByTestId('do-stuff-slot')).toBeNull();
    expect(useDoStuffStore.getState().slot).toBe(false);
    expect(screen.getByTestId('do-stuff-up-next')).toBeTruthy();
    expect(screen.getByTestId('do-stuff-next').dataset.slim).toBeUndefined();
  });
});
