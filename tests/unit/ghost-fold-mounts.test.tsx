import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';

/**
 * Where the ghost fold is mounted: at the top of each Day layout, and NOT in
 * the Do stuff desk's day column (DaySchedule's `hideAnytime`), whose lanes
 * already hold the day's open rows. The fold's own gates (today, the switch,
 * loaded) are ghost-fold.test.tsx's; here it is a stub that says it was asked.
 */

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
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof window.ResizeObserver;
  }
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  createItem: vi.fn(async () => {}),
  updateItem: vi.fn(async () => {}),
  deleteItem: vi.fn(async () => {}),
  setItemCompletion: vi.fn(async () => {}),
  fetchRoutines: vi.fn(async () => []),
  fetchSeasons: vi.fn(async () => []),
  fetchGoals: vi.fn(async () => []),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));
vi.mock('@/components/planner/ghost-fold', () => ({
  GhostFold: ({ dateStr }: { dateStr: string }) => <div data-testid="ghost-fold-stub" data-date={dateStr} />,
}));

import { DaySchedule } from '@/components/views/day-schedule';
import { DayList } from '@/components/views/day-list';
import { DayBuckets } from '@/components/views/day-buckets';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { EMPTY_VIEW_FILTERS } from '@/lib/filters';

const DATE_STR = '2026-08-13';

function seed() {
  usePlannerStore.setState({
    userId: 'user-1',
    userTimezone: 'UTC',
    selectedDate: new Date(`${DATE_STR}T12:00:00Z`),
    weekStartDay: 'sunday',
    navDirection: null,
    tasks: [],
    habits: [],
    items: [],
    projects: [],
    routines: [],
    seasons: [],
    showCompletedTasks: true,
    showPausedOnGrid: true,
    showCurrentTimeIndicator: false,
  });
  useViewStore.setState({
    canvasGroupBy: 'none',
    canvasSortBy: 'default',
    canvasFilters: EMPTY_VIEW_FILTERS,
    typeFilter: 'all',
    collapsedBuckets: [],
    bucketStyle: 'spine',
  });
}

const mount = (ui: React.ReactElement) => {
  seed();
  return render(<DndContext>{ui}</DndContext>);
};

afterEach(cleanup);

describe('the ghost fold’s mounts', () => {
  it('Day × Schedule asks for it, on the selected day', () => {
    mount(<DaySchedule activeId={null} />);
    expect(screen.getByTestId('ghost-fold-stub')).toHaveAttribute('data-date', DATE_STR);
  });

  it('the Do stuff desk’s day column (hideAnytime) leaves it out', () => {
    mount(<DaySchedule activeId={null} hideAnytime />);
    expect(screen.queryByTestId('ghost-fold-stub')).toBeNull();
  });

  it('Day × List and Day × Buckets ask for it too', () => {
    mount(<DayList />);
    expect(screen.getAllByTestId('ghost-fold-stub')).toHaveLength(1);
    cleanup();
    mount(<DayBuckets activeId={null} />);
    expect(screen.getAllByTestId('ghost-fold-stub')).toHaveLength(1);
  });
});
