import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';

/**
 * Grouping on Week × List, tested through the rendered week.
 *
 * This surface honoured NOTHING before Phase 5a — `groupByBlockedBy` answered
 * 'Day only' for every value on every week layout, and `DaySection` rendered one
 * flat list. So the thing to pin is that a week is SEVEN independent lists and
 * both axes apply per day: each date heading sections its own rows rather than
 * the week being pulled into one partition.
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

import { WeekList } from '@/components/views/week-list';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { EMPTY_VIEW_FILTERS } from '@/lib/filters';
import type { GroupBy, Task } from '@/lib/planner-types';

const TZ = 'UTC';
/** A Thursday. The week runs Sun 2026-08-09 → Sat 2026-08-15 by default. */
const THURSDAY = '2026-08-13';
const FRIDAY = '2026-08-14';

const task = (over: Partial<Task>): Task =>
  ({
    status: 'pending',
    isScheduled: true,
    order: 0,
    timeBucket: 'morning',
    ...over,
  }) as Task;

/** Two days, two projects each, so a per-week partition would be visible. */
const tasks: Task[] = [
  task({ id: 'th-work', title: 'Thursday work', project: 'Work', startDate: THURSDAY }),
  task({ id: 'th-home', title: 'Thursday home', project: 'Home', startDate: THURSDAY }),
  task({ id: 'fr-work', title: 'Friday work', project: 'Work', startDate: FRIDAY }),
];

function seed(canvasGroupBy: GroupBy) {
  usePlannerStore.setState({
    userId: 'user-1',
    userTimezone: TZ,
    selectedDate: new Date(`${THURSDAY}T12:00:00Z`),
    weekStartDay: 'sunday',
    navDirection: null,
    tasks,
    habits: [],
    items: tasks as never,
    projects: [
      { id: 'p1', name: 'Work', emoji: '💼' },
      { id: 'p2', name: 'Home', emoji: '🏠' },
    ],
    routines: [],
    seasons: [],
    showCompletedTasks: true,
    showPausedOnGrid: true,
  });
  useViewStore.setState({
    canvasGroupBy,
    canvasSortBy: 'default',
    canvasFilters: EMPTY_VIEW_FILTERS,
    typeFilter: 'all',
  });
}

const renderWeek = () =>
  render(
    <DndContext>
      <WeekList />
    </DndContext>
  );

/** Every section heading in the week, in render order. */
const headings = () =>
  [...document.querySelectorAll('button[aria-expanded]')].map((el) => el.textContent?.trim());

afterEach(cleanup);
beforeEach(() => seed('none'));

describe('Week × List grouping', () => {
  it('renders a flat list under each date when nothing is grouped', () => {
    renderWeek();
    expect(headings()).toEqual([]);
    expect(screen.getByText('Thursday work')).toBeInTheDocument();
  });

  it('sections each DAY separately, not the week as one partition', () => {
    // Work appears twice — once under Thursday, once under Friday — because a
    // day section is its own list. One "Work" heading spanning both days would
    // mean the week had been repartitioned across its own primary axis.
    seed('project');
    renderWeek();

    expect(headings()).toEqual(['Work', 'Home', 'Work']);
  });

  it('leaves an empty day as its whisper rather than an empty section', () => {
    seed('project');
    renderWeek();

    // Five of the seven days hold nothing; none of them contributes a heading.
    expect(screen.getAllByText('Nothing planned.')).toHaveLength(5);
  });
});
