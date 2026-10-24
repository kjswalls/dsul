import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Week and blocks PR 11: a block drop's "hidden where it landed" receipt is
 * judged on the day the block was let go on, even when the write keeps another
 * date. A repeating task moved to a new time keeps its start date (the series
 * anchor, often weeks back), and a season, routine pause or trip whose window
 * leaves that anchor out must not put "Hidden with your ... season" on the undo
 * toast for a block that is visible right where it landed. Before the rule the
 * drop wrote the day it landed on, and the receipt was judged there; it still is.
 *
 * Each drop goes through resolveDrop with the dragged item, as the shell asks
 * it, and then the store call the shell's switch makes for it
 * (components/shell/app-shell.tsx handleDragEnd, `schedule-task`).
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
vi.mock('@/lib/supabase', () => ({ createClient: () => ({}) }));
vi.mock('@/lib/openclaw-registry', () => ({ notifyPlugins: vi.fn() }));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));


import { usePlannerStore, getActionLog } from '@/lib/planner-store';
import { placementOf, resolveDrop, type DropCommand, type DropContext } from '@/lib/dnd/handle-drag-end';
import type { Item, Season } from '@/lib/planner-types';

/** The system clock, and the day the canvas shows. */
const TODAY = '2026-10-24';
const NOW = new Date(Date.UTC(2026, 9, 24, 12, 0, 0));
const SERIES_START = '2026-09-01';

const task = (id: string, over: Record<string, unknown> = {}): Item =>
  ({
    type: 'task',
    id,
    title: id,
    status: 'pending',
    isScheduled: true,
    order: 0,
    startDate: TODAY,
    timeBucket: 'morning',
    startTime: '09:00',
    completedDates: [],
    skippedDates: [],
    ...over,
  }) as unknown as Item;

const items = {
  series: task('series', { repeatFrequency: 'daily', startDate: SERIES_START }),
  seriesInBlock: task('series-in-block', {
    repeatFrequency: 'daily',
    startDate: SERIES_START,
    startTime: undefined,
    inProjectBlock: true,
    project: 'Work',
  }),
  oneOff: task('one-off'),
};

/** Autumn turns on by itself on Sep 22, after the series began. */
const autumn: Season = {
  id: 'autumn',
  name: 'Autumn',
  state: 'auto',
  startsOn: '2026-09-22',
  endsOn: '2026-12-31',
  itemIds: Object.values(items).map((i) => i.id),
  routineIds: [],
} as Season;

const store = () => usePlannerStore.getState();

/** Drop `item` on `target`, as handleDragEnd does, and return the command. */
function drop(item: Item, target: string): DropCommand | null {
  const ctx: DropContext = {
    itemType: 'task',
    input: 'pointer',
    draggedTaskProject: (item as { project?: string }).project,
    draggedPlacement: placementOf(item),
    draggedItem: item,
    milestoneIds: new Set(),
    selectedDate: NOW,
    userTimezone: 'UTC',
    getRefTime: () => undefined,
    inferDropTime: () => '09:00',
  };
  const command = resolveDrop(item.id, target, ctx);
  if (command?.kind === 'schedule-task') {
    store().scheduleTask(command.taskId, command.bucket, command.time, command.dateStr, {
      landsOn: command.landsOn,
    });
  }
  return command;
}

/** The stored row, read as the task fields these tests check. */
const row = (id: string) =>
  store().items.find((i) => i.id === id) as unknown as {
    startDate?: string;
    startTime?: string;
    inProjectBlock?: boolean;
  };
const receipt = () => getActionLog()[0]?.receipt;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  usePlannerStore.setState({
    userId: 'user-1',
    userTimezone: 'UTC',
    items: Object.values(items),
    routines: [],
    seasons: [autumn],
    goals: [],
    collectionsAvailable: true,
    goalsAvailable: true,
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a block drop judges its receipt on the day it landed on', () => {
  it('a series moved to a new time in a later-starting season leaves no receipt', () => {
    const command = drop(items.series, 'hour:10');
    expect(command).toMatchObject({ kind: 'schedule-task', time: '10:00', landsOn: TODAY });
    expect(command).not.toHaveProperty('dateStr');
    expect(row('series').startDate).toBe(SERIES_START);
    expect(row('series').startTime).toBe('10:00');
    expect(getActionLog()[0]?.label).toBe('Schedule task: series');
    expect(receipt()).toBeUndefined();
  });

  it('a series in a project block, released on its own start date, leaves no receipt either', () => {
    const command = drop(items.seriesInBlock, 'hour:14');
    expect(command).toMatchObject({ dateStr: SERIES_START, landsOn: TODAY });
    expect(row('series-in-block').startDate).toBe(SERIES_START);
    expect(row('series-in-block').inProjectBlock).toBe(false);
    expect(receipt()).toBeUndefined();
  });

  it('still speaks when the day it was let go on is hidden', () => {
    // A Week column before Autumn begins: the series takes the time on its own
    // days, and on the column it was dropped on it is hidden, as it was before.
    const command = drop(items.series, 'weekhour:2026-09-15:8');
    expect(command).toMatchObject({ time: '08:00', landsOn: '2026-09-15' });
    expect(row('series').startDate).toBe(SERIES_START);
    expect(receipt()).toMatch(/^Hidden with your Autumn season/);
  });

  it('a one-off carries no landing day of its own, since it lands on the date it is given', () => {
    expect(drop(items.oneOff, 'weekhour:2026-09-15:8')).toEqual({
      kind: 'schedule-task',
      taskId: 'one-off',
      bucket: 'morning',
      time: '08:00',
      dateStr: '2026-09-15',
    });
    expect(receipt()).toMatch(/^Hidden with your Autumn season/);
    store().scheduleTask('one-off', 'morning', '10:00', TODAY);
    expect(receipt()).toBeUndefined();
  });
});
