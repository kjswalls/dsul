import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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


// isOver is dnd-kit's internal collision state; stand it in per droppable id so
// the component's own reaction to it is what gets tested.
const over = new Set<string>();
vi.mock('@dnd-kit/core', async (orig) => {
  const real = await orig<typeof import('@dnd-kit/core')>();
  return {
    ...real,
    useDroppable: (args: { id: string }) => ({ isOver: over.has(args.id), setNodeRef: () => {} }),
  };
});

import { Braindump } from '@/components/sidebar/braindump';
import { ListDropZone } from '@/components/views/list-drop-zone';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { useDragStore } from '@/lib/drag-store';
import { useSelectionStore } from '@/lib/selection-store';
import { EMPTY_VIEW_FILTERS } from '@/lib/filters';
import type { Item } from '@/lib/planner-types';

/**
 * Dragging back to the sidebar lights the SLOT the item will take, not the
 * whole list, and lights nothing when the drop would do nothing.
 */

const task = (id: string, title: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'task', id, title, status: 'pending', isScheduled: false, ...extra }) as unknown as Item;

const items: Item[] = [
  task('a', 'Apple', { project: 'Home' }),
  task('m', 'Mango', { project: 'Work', isScheduled: true, timeBucket: 'morning', startDate: '2026-09-30' }),
  task('z', 'Zebra', { project: 'Work' }),
  {
    type: 'habit',
    id: 'h',
    title: 'Stretch',
    status: 'pending',
    repeatFrequency: 'daily',
    timeBucket: 'morning',
    completedDates: [],
    skippedDates: [],
  } as unknown as Item,
];

function seed() {
  usePlannerStore.setState({
    userId: 'user-1',
    userTimezone: 'UTC',
    items,
    tasks: items.filter((i) => i.type === 'task') as never,
    habits: items.filter((i) => i.type === 'habit') as never,
    projects: [
      { id: 'p1', name: 'Work', emoji: '💼' },
      { id: 'p2', name: 'Home', emoji: '🏠' },
    ],
    routines: [],
    seasons: [],
    goals: [],
  });
  useViewStore.setState({
    braindumpGroupBy: 'project',
    braindumpSortBy: 'title',
    braindumpFilters: EMPTY_VIEW_FILTERS,
  });
  useSelectionStore.setState({ selectedIds: new Set() });
}

const renderBraindump = () =>
  render(
    <DndContext>
      <Braindump />
    </DndContext>
  );

beforeEach(() => {
  over.clear();
  seed();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  useDragStore.getState().endDrag();
});

describe('braindump: where a dragged item will land', () => {
  it('draws the incoming row in its own slot, sorted and grouped as it will be', () => {
    useDragStore.getState().startDrag('m', 'pointer');
    over.add('sidebar');
    renderBraindump();

    const landing = screen.getByTestId('braindump-landing');
    expect(landing.textContent).toBe('Mango');
    // Home then Work (store order sets the sections); Title A–Z inside Work
    // puts Mango ahead of Zebra, not at the foot of the list.
    const titles = screen.getAllByText(/^(Apple|Mango|Zebra)$/).map((el) => el.textContent);
    expect(titles).toEqual(['Apple', 'Mango', 'Zebra']);
    expect(screen.getByTestId('braindump').dataset.dndActs).toBe('true');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('lights nothing for a braindump row over its own list', () => {
    useDragStore.getState().startDrag('z', 'pointer');
    over.add('sidebar');
    renderBraindump();

    expect(screen.queryByTestId('braindump-landing')).toBeNull();
    expect(screen.getByTestId('braindump').dataset.dndActs).toBe('false');
  });

  it('draws a habit from the canvas landing in the Paused section, which a drop pauses', () => {
    useDragStore.getState().startDrag('h', 'pointer');
    over.add('sidebar');
    renderBraindump();

    const section = screen.getByTestId('braindump-paused-section');
    expect(section.querySelector('[data-testid="braindump-landing"]')?.textContent).toBe('Stretch');
    expect(screen.getByTestId('braindump-paused-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('braindump').dataset.dndActs).toBe('true');
  });

  it('lights nothing for a habit that is already paused', () => {
    const paused = { ...items[3], pausedAt: '2020-01-01T00:00:00Z' } as Item;
    const next = [...items.slice(0, 3), paused];
    usePlannerStore.setState({ items: next, habits: [paused] as never });
    useDragStore.getState().startDrag('h', 'pointer');
    over.add('sidebar');
    renderBraindump();

    expect(screen.queryByTestId('braindump-landing')).toBeNull();
    expect(screen.getByTestId('braindump').dataset.dndActs).toBe('false');
  });

  it('shows a selection of a task and a habit each where it will land', () => {
    useSelectionStore.setState({ selectedIds: new Set(['m', 'h']) });
    useDragStore.getState().startDrag('h', 'pointer');
    over.add('sidebar');
    renderBraindump();

    const landings = screen.getAllByTestId('braindump-landing').map((el) => el.textContent);
    expect(landings.sort()).toEqual(['Mango', 'Stretch']);
  });

  it('drops the empty-state poem while a row is landing in an empty list', () => {
    usePlannerStore.setState({ tasks: [items[1]] as never, items: [items[1]] });
    useDragStore.getState().startDrag('m', 'pointer');
    over.add('sidebar');
    renderBraindump();
    expect(screen.getByTestId('braindump-landing')).toBeTruthy();
    expect(screen.queryByText(/A clear head/)).toBeNull();
  });

  it('shows nothing until the drag is over the sidebar', () => {
    useDragStore.getState().startDrag('m', 'pointer');
    renderBraindump();
    expect(screen.queryByTestId('braindump-landing')).toBeNull();
  });
});

describe('list drop zone', () => {
  const renderZone = (dateStr: string) =>
    render(
      <DndContext>
        <ListDropZone dateStr={dateStr}>
          <p>rows</p>
        </ListDropZone>
      </DndContext>
    );
  const zone = () => document.querySelector('[data-dnd-id^="list:"]') as HTMLElement;

  it('lights for a braindump item', () => {
    useDragStore.getState().startDrag('z', 'pointer');
    over.add('list:2026-09-30');
    renderZone('2026-09-30');
    expect(zone().dataset.dndOver).toBe('true');
    expect(zone().dataset.dndActs).toBe('true');
  });

  it('stays dark for a row over the day it is already on', () => {
    useDragStore.getState().startDrag('m', 'pointer');
    over.add('list:2026-09-30');
    renderZone('2026-09-30');
    expect(zone().dataset.dndActs).toBe('false');
  });

  it('lights for a row over another day', () => {
    useDragStore.getState().startDrag('m', 'pointer');
    over.add('list:2026-10-01');
    renderZone('2026-10-01');
    expect(zone().dataset.dndActs).toBe('true');
  });
});
