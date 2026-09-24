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

/**
 * Grouping owns the outer order; Ordering only moves rows inside a section.
 *
 * Rendered rather than reimplemented. The defect this pins was in the ORDER OF
 * TWO OPERATIONS inside one component — sorting the flat row list and then
 * partitioning it — and a test that rebuilds that partition in the test file
 * asserts its own arithmetic, not the component's. That is the third time this
 * project has produced a test that passes whatever the code does, so this one
 * mounts the real Braindump.
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
import { EMPTY_VIEW_FILTERS } from '@/lib/filters';
import type { Goal, Item } from '@/lib/planner-types';
import type { SortBy } from '@/lib/sort-rows';
import { enableGoalsAndOrganize } from './support/extensions';

/**
 * Two unscheduled tasks whose STORE order is the reverse of their alphabetical
 * order, in two different projects. That is what makes the section sequence
 * observable: under the defect, sorting by title promoted Apple's row to the
 * front of the flat list, so Home was the first project the grouping map met.
 */
const items: Item[] = [
  {
    type: 'task',
    id: 'z',
    title: 'Zebra',
    project: 'Work',
    status: 'pending',
    isScheduled: false,
    order: 0,
  } as unknown as Item,
  {
    type: 'task',
    id: 'a',
    title: 'Apple',
    project: 'Home',
    status: 'pending',
    isScheduled: false,
    order: 1,
  } as unknown as Item,
];

function seed(braindumpSortBy: SortBy) {
  usePlannerStore.setState({
    userId: 'user-1',
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
  });
  useViewStore.setState({
    braindumpGroupBy: 'project',
    braindumpSortBy,
    braindumpFilters: EMPTY_VIEW_FILTERS,
  });
}

const renderBraindump = () =>
  render(
    <DndContext>
      <Braindump />
    </DndContext>
  );

/** Section headings in render order. GroupSection renders them as uppercase. */
const sections = () =>
  screen
    .getAllByText(/^(Work|Home|No project)$/i)
    .map((el) => el.textContent?.trim().toLowerCase());

afterEach(cleanup);

describe('braindump: grouping owns the outer order', () => {
  it('keeps the section sequence under Default', () => {
    seed('default');
    renderBraindump();

    expect(sections()).toEqual(['work', 'home']);
  });

  it('keeps the SAME section sequence under Title A–Z', () => {
    // The defect: the grouping map is filled by walking the row list, and
    // `[...groups.entries()]` returns insertion order — so sorting the flat
    // list first made the headings swap to [Home, Work] while the rows inside
    // each stayed correct. It reads as the panel jumping, not as a bug.
    seed('title');
    renderBraindump();

    expect(sections()).toEqual(['work', 'home']);
  });

  it('still orders the rows inside a section', () => {
    // Ordering has to do SOMETHING — this is what stops the fix above from
    // being "ignore the sort entirely".
    usePlannerStore.setState({
      items: [
        ...items,
        {
          type: 'task',
          id: 'm',
          title: 'Mango',
          project: 'Work',
          status: 'pending',
          isScheduled: false,
          order: 2,
        } as unknown as Item,
      ],
    });
    usePlannerStore.setState({ tasks: usePlannerStore.getState().items as never });
    useViewStore.setState({ braindumpSortBy: 'title' });
    renderBraindump();

    const titles = screen.getAllByText(/^(Zebra|Mango|Apple)$/).map((el) => el.textContent);
    // Work's two rows sort inside their section; Apple stays in Home, after them.
    expect(titles).toEqual(['Mango', 'Zebra', 'Apple']);
  });
});

// Group by Goal rides the Goals extension, which ships off.
beforeEach(() => {
  enableGoalsAndOrganize();
  seed('default');
});

describe('braindump: grouping by a gate', () => {
  it('sections unscheduled items by their routine, with a pause switch on the header', () => {
    // The one-line fix that makes gate grouping resolve at all: braindump.tsx
    // passing { routines, programs } to groupRows instead of an empty ctx. With
    // the empty ctx this routine's item fell into "No routine" and the switch
    // never rendered.
    const zebra = {
      type: 'task',
      id: 'z',
      title: 'Zebra',
      status: 'pending',
      isScheduled: false,
      order: 0,
    } as unknown as Item;
    usePlannerStore.setState({
      userId: 'user-1',
      userTimezone: 'UTC',
      items: [zebra],
      tasks: [zebra] as never,
      habits: [],
      projects: [],
      routines: [{ id: 'r', name: 'Mornings', itemIds: ['z'] }],
      programs: [],
    });
    useViewStore.setState({
      braindumpGroupBy: 'routine',
      braindumpSortBy: 'default',
      braindumpFilters: EMPTY_VIEW_FILTERS,
    });
    renderBraindump();

    // The routine names the section, and its header carries the pause switch,
    // reading ON (the routine is not paused).
    expect(screen.getByText('Mornings')).toBeTruthy();
    expect(screen.getByTestId('gate-switch').getAttribute('data-gate-on')).toBe('on');
  });
});

describe('braindump: the aspire axis', () => {
  /**
   * Mounted rather than reimplemented, for the reason the gate case above was:
   * the wiring is the defect surface. `groupRows` and `goalFilterItemIds` are
   * covered on their own; what these pin is that braindump.tsx actually hands
   * them the store's goals — with an empty context the section falls to "No
   * goal", and with no resolution the filter narrows nothing at all.
   */
  const zebra = {
    type: 'task',
    id: 'z',
    title: 'Zebra',
    status: 'pending',
    isScheduled: false,
    order: 0,
  } as unknown as Item;
  const apple = {
    type: 'task',
    id: 'a',
    title: 'Apple',
    status: 'pending',
    isScheduled: false,
    order: 1,
  } as unknown as Item;

  const seedGoal = (over: Partial<Goal> = {}) => {
    usePlannerStore.setState({
      userId: 'user-1',
      userTimezone: 'UTC',
      items: [zebra, apple],
      tasks: [zebra, apple] as never,
      habits: [],
      projects: [],
      routines: [],
      programs: [],
      goals: [
        {
          id: 'g1',
          name: 'Learn Chinese',
          state: 'active',
          memberIds: [],
          milestoneIds: ['z'],
          checkinIds: [],
          ...over,
        },
      ],
    });
  };

  it('sections by goal, and gives the heading NO pause switch', () => {
    seedGoal();
    useViewStore.setState({
      braindumpGroupBy: 'goal',
      braindumpSortBy: 'default',
      braindumpFilters: EMPTY_VIEW_FILTERS,
    });
    renderBraindump();

    // A milestone-role member sections under its goal like any other member.
    expect(screen.getByText('Learn Chinese')).toBeTruthy();
    expect(screen.getByText('No goal')).toBeTruthy();
    // The gate headings carry `data-testid="gate-switch"`; an aspire heading has
    // nothing to switch, because a goal suppresses nothing.
    expect(screen.queryByTestId('gate-switch')).toBeNull();
  });

  it('narrows the list to one goal, milestone role included', () => {
    seedGoal();
    useViewStore.setState({
      braindumpGroupBy: 'none',
      braindumpSortBy: 'default',
      braindumpFilters: { ...EMPTY_VIEW_FILTERS, goals: ['g1'] },
    });
    renderBraindump();

    expect(screen.getByText('Zebra')).toBeTruthy();
    expect(screen.queryByText('Apple')).toBeNull();
  });

  it('leaves the list whole when the selected goal has ended', () => {
    // Inert, not empty. The clause still counts on the trigger and the row that
    // clears it is still in the menu; what it must not do is blank the surface.
    seedGoal({ state: 'achieved' });
    useViewStore.setState({
      braindumpGroupBy: 'none',
      braindumpSortBy: 'default',
      braindumpFilters: { ...EMPTY_VIEW_FILTERS, goals: ['g1'] },
    });
    renderBraindump();

    expect(screen.getByText('Zebra')).toBeTruthy();
    expect(screen.getByText('Apple')).toBeTruthy();
  });
});

describe('braindump: grouping by priority', () => {
  const task = (id: string, title: string, priority: string | undefined, order: number) =>
    ({
      type: 'task',
      id,
      title,
      priority,
      status: 'pending',
      isScheduled: false,
      order,
    }) as unknown as Item;

  /**
   * Reaches 'priority' through the persisted blob, not a bare setState: the
   * rehydrate coercion is what used to turn it into 'none', and a setState
   * would skip it and only exercise the shared `groupRows` arm.
   */
  const seedPriority = async (
    rows: Item[],
    braindumpSortBy: SortBy = 'default',
    habits: Item[] = []
  ) => {
    usePlannerStore.setState({
      userId: 'user-1',
      userTimezone: 'UTC',
      items: [...rows, ...habits],
      tasks: rows as never,
      habits: habits as never,
      projects: [],
      routines: [],
      programs: [],
    });
    localStorage.setItem(
      'dsul-view',
      JSON.stringify({ version: 1, state: { braindumpGroupBy: 'priority', braindumpSortBy } })
    );
    await useViewStore.persist.rehydrate();
    useViewStore.setState({ braindumpFilters: EMPTY_VIEW_FILTERS });
    expect(useViewStore.getState().braindumpGroupBy).toBe('priority');
  };

  afterEach(() => localStorage.removeItem('dsul-view'));

  // Anchored: a task row's PriorityGlyph is labelled "High priority", which an
  // unanchored /High/ would also match.
  const prioritySections = () =>
    screen
      .getAllByText(/^(High|Medium|Low|No priority)$/i)
      .map((el) => el.textContent?.trim().toLowerCase());

  it('sections from highest to lowest, with No priority last, whatever the store order', async () => {
    await seedPriority([
      task('l', 'Lemon', 'low', 0),
      task('n', 'Nectarine', undefined, 1),
      task('h', 'Honeydew', 'high', 2),
      task('m', 'Mango', 'medium', 3),
    ]);
    renderBraindump();

    expect(prioritySections()).toEqual(['high', 'medium', 'low', 'no priority']);
    // A priority heading switches nothing.
    expect(screen.queryByTestId('gate-switch')).toBeNull();
  });

  it('draws no heading for a level nothing sits at', async () => {
    await seedPriority([task('l', 'Lemon', 'low', 0), task('h', 'Honeydew', 'high', 1)]);
    renderBraindump();

    expect(prioritySections()).toEqual(['high', 'low']);
  });

  it('orders rows inside a level without reordering the levels', async () => {
    await seedPriority(
      [task('z', 'Zebra', 'high', 0), task('a', 'Apple', 'low', 1), task('b', 'Banana', 'high', 2)],
      'title'
    );
    renderBraindump();

    expect(prioritySections()).toEqual(['high', 'low']);
    const titles = screen.getAllByText(/^(Zebra|Banana|Apple)$/).map((el) => el.textContent);
    expect(titles).toEqual(['Banana', 'Zebra', 'Apple']);
  });

  it('files a habit, which carries no priority, under No priority', async () => {
    // Not a "Habits" section: the priority axis does not reach the type, so it
    // takes the explicit None value like any other row without one.
    const habit = {
      type: 'habit',
      id: 'hb',
      title: 'Stretch',
      status: 'pending',
      repeatFrequency: 'none',
      completedDates: [],
      skippedDates: [],
      streak: 0,
    } as unknown as Item;
    await seedPriority([task('h', 'Honeydew', 'high', 0)], 'default', [habit]);
    renderBraindump();

    expect(prioritySections()).toEqual(['high', 'no priority']);
    const titles = screen.getAllByText(/^(Honeydew|Stretch)$/).map((el) => el.textContent);
    expect(titles).toEqual(['Honeydew', 'Stretch']);
  });
});
