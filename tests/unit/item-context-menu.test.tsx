import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';

/**
 * The right-click menus (components/planner/item-context-menu.tsx,
 * container-context-menu.tsx). What each verb may do is pinned in
 * item-verbs.test.ts; this pins what the MENU adds: it acts on the day the row
 * is drawn on, it lights what it acts on, a selection gets the batch verbs,
 * and the container menu's switch writes through the gate toggle.
 */

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
}));
vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'light', resolvedTheme: 'light', setTheme: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
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
  setItemSkip: vi.fn(async () => {}),
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

import { TaskRow, type RowItem } from '@/components/primitives/task-row';
import { GroupSection } from '@/components/primitives/group-section';
import { usePlannerStore } from '@/lib/planner-store';
import { useSelectionStore } from '@/lib/selection-store';
import { useUIStore } from '@/lib/ui-store';
import { EXT_ORGANIZE } from '@/lib/extension-registry';
import { enableExtensions } from './support/extensions';
import * as db from '@/lib/db';
import type { HabitItem, Item, Task } from '@/lib/planner-types';

const USER = 'user-1';
/** Real today (the clock is pinned) and the day on screen. */
const TODAY = '2026-07-16';
/** A week column to the left of today — what the user right-clicks in. */
const ROW_DAY = '2026-07-14';

const asDate = (ymd: string) => new Date(`${ymd}T12:00:00Z`);
const store = () => usePlannerStore.getState();
const itemById = (id: string) => store().items.find((i) => i.id === id) as unknown as Record<string, unknown>;

const fixtures = (): Item[] =>
  [
    {
      type: 'task',
      id: 'daily',
      title: 'Water the plants',
      status: 'pending',
      isScheduled: false,
      timeBucket: 'anytime',
      order: 0,
      startDate: '2026-07-01',
      repeatFrequency: 'daily',
      completedDates: [],
      skippedDates: [],
    },
    {
      type: 'task',
      id: 'once',
      title: 'File taxes',
      status: 'pending',
      isScheduled: false,
      timeBucket: 'anytime',
      order: 1,
      startDate: TODAY,
      completedDates: [],
      skippedDates: [],
    },
    {
      type: 'task',
      id: 'other',
      title: 'Call mum',
      status: 'pending',
      isScheduled: false,
      timeBucket: 'anytime',
      order: 2,
      startDate: TODAY,
      completedDates: [],
      skippedDates: [],
    },
  ] as unknown as Item[];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(asDate(TODAY));
  store().clearStore();
  vi.clearAllMocks();
  vi.mocked(db.fetchItems).mockResolvedValue(fixtures());
  await store().initializeStore(USER);
  usePlannerStore.setState({ selectedDate: asDate(TODAY), userTimezone: 'UTC', routines: [], seasons: [], goals: [] });
  useSelectionStore.getState().clear();
  useUIStore.setState({ activeDialog: null, confirmRequest: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function LiveRow({ id, date }: { id: string; date?: Date }) {
  const item = usePlannerStore((s) => s.items.find((i) => i.id === id))!;
  const row: RowItem =
    item.type === 'habit'
      ? { itemType: 'habit', item: item as unknown as HabitItem }
      : { itemType: 'task', item: item as unknown as Task };
  return <TaskRow row={row} date={date} />;
}

const cardOf = (id: string) =>
  screen.getAllByTestId('item-card').find((el) => el.getAttribute('data-item-id') === id)!;

function rightClick(el: Element) {
  fireEvent.contextMenu(el, { clientX: 10, clientY: 10 });
  return screen.getByTestId(/context-menu$/);
}

describe('the item right-click menu', () => {
  it('acts on the day the row is drawn on, not the day on screen', () => {
    render(<LiveRow id="daily" date={asDate(ROW_DAY)} />);
    const menu = rightClick(cardOf('daily'));
    const tick = within(menu).getByTestId('item-menu-tick');
    // Not today, so the label does not say "today".
    expect(tick.textContent).toContain('Done');
    expect(tick.textContent).not.toContain('today');
    fireEvent.click(tick);
    expect(itemById('daily').completedDates).toEqual([ROW_DAY]);
  });

  it('keeps the carries off a recurring task and offers them on a dated one-off', () => {
    render(
      <>
        <LiveRow id="daily" />
        <LiveRow id="once" />
      </>
    );
    const series = rightClick(cardOf('daily'));
    expect(within(series).queryByTestId('item-menu-next-day')).toBeNull();
    expect(within(series).queryByTestId('item-menu-reschedule')).toBeNull();
    expect(within(series).getByTestId('item-menu-skip')).toBeTruthy();
    fireEvent.keyDown(series, { key: 'Escape' });

    const once = rightClick(cardOf('once'));
    fireEvent.click(within(once).getByTestId('item-menu-next-day'));
    expect(itemById('once').startDate).toBe('2026-07-17');
  });

  it('makes the right-clicked item the selection, so what it acts on is lit', () => {
    useSelectionStore.getState().replace(['other']);
    render(
      <>
        <LiveRow id="once" />
        <LiveRow id="other" />
      </>
    );
    rightClick(cardOf('once'));
    expect([...useSelectionStore.getState().selectedIds]).toEqual(['once']);
  });

  it('acts on the whole selection when the item is part of one', () => {
    useSelectionStore.getState().replace(['once', 'other']);
    render(
      <>
        <LiveRow id="once" />
        <LiveRow id="other" />
      </>
    );
    const menu = rightClick(cardOf('once'));
    expect(menu.textContent).toContain('2 items');
    fireEvent.click(within(menu).getByTestId('item-menu-batch-complete'));
    expect(itemById('once').status).toBe('completed');
    expect(itemById('other').status).toBe('completed');
  });

  it('asks before Delete', () => {
    render(<LiveRow id="once" />);
    fireEvent.click(within(rightClick(cardOf('once'))).getByTestId('item-menu-delete'));
    expect(useUIStore.getState().confirmRequest).toMatchObject({ destructive: true, confirmLabel: 'Delete' });
    expect(itemById('once')).toBeTruthy();
  });

  it('edits properties through the Edit menu\'s own lists', () => {
    render(<LiveRow id="once" />);
    const menu = rightClick(cardOf('once'));
    fireEvent.pointerMove(within(menu).getByTestId('item-menu-edit-priority'));
    fireEvent.keyDown(within(menu).getByTestId('item-menu-edit-priority'), { key: 'ArrowRight' });
    const high = screen
      .getAllByTestId('bulk-priority-option')
      .find((el) => el.getAttribute('data-value') === 'high')!;
    fireEvent.click(high);
    expect(itemById('once').priority).toBe('high');
  });
});

describe('the container right-click menu', () => {
  it('turns a routine off from its heading, through the gate toggle', () => {
    enableExtensions(EXT_ORGANIZE);
    usePlannerStore.setState({
      routines: [{ id: 'r1', name: 'Mornings', itemIds: [] }] as never,
    });
    render(
      <GroupSection label="Mornings" gate={{ kind: 'routine', id: 'r1' }} variant="canvas">
        <div />
      </GroupSection>
    );
    const menu = rightClick(screen.getByText('Mornings'));
    expect(within(menu).getByTestId('container-menu-open')).toBeTruthy();
    fireEvent.click(within(menu).getByTestId('container-menu-gate'));
    expect((store().routines[0] as { pausedAt?: string }).pausedAt).toBeTruthy();
  });

  it('opens a project heading\'s page by id, resolved from its name', () => {
    usePlannerStore.setState({ projects: [{ id: 'p1', name: 'Work', emoji: '' }] as never });
    render(
      <GroupSection label="Work" groupKey="project:Work">
        <div />
      </GroupSection>
    );
    fireEvent.click(within(rightClick(screen.getByText('Work'))).getByTestId('container-menu-open-page'));
    expect(push).toHaveBeenCalledWith('/project/p1');
  });
});
