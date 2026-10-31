import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, within } from '@testing-library/react';

/**
 * The ghost fold at the top of Today (components/planner/ghost-fold.tsx): when
 * it renders at all, what the caption says, the pile rule, and that each verb
 * is the existing store action (so undo and the undo strip come with it).
 * Which items ghost is pinned in ghost-rows.test.ts.
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
  loadPlannerData: vi.fn((_u: string, perTable: () => Promise<unknown>) => perTable()),
  createGoal: vi.fn(async () => {}),
  updateGoal: vi.fn(async () => {}),
  deleteGoal: vi.fn(async () => {}),
  restoreGoal: vi.fn(async () => {}),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));
vi.mock('@/lib/ui-store', async (orig) => {
  const real = await orig<typeof import('@/lib/ui-store')>();
  return { ...real, openEditFor: vi.fn() };
});
const mobile = vi.hoisted(() => ({ on: false }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mobile.on }));

import { GhostFold, GHOST_DONE_MS } from '@/components/planner/ghost-fold';
import { usePlannerStore } from '@/lib/planner-store';
import { useMorningStore } from '@/lib/morning-store';
import { __resetModEventsForTests, subscribeModEvents, type ModEvent } from '@/lib/mod-events';
import { openEditFor } from '@/lib/ui-store';
import * as db from '@/lib/db';
import type { Item, TaskItem } from '@/lib/planner-types';

const USER = 'user-1';
const TODAY = '2026-07-14'; // a Tuesday
const TOMORROW = '2026-07-15';
const store = () => usePlannerStore.getState();
const taskById = (id: string) => store().items.find((i) => i.id === id) as TaskItem;

const task = (id: string, startDate: string, extra: Partial<TaskItem> = {}): Item =>
  ({
    type: 'task',
    id,
    title: `Title ${id}`,
    status: 'pending',
    isScheduled: true,
    timeBucket: 'morning',
    order: 0,
    startDate,
    completedDates: [],
    skippedDates: [],
    ...extra,
  }) as Item;

const TWO = [task('thu', '2026-07-09'), task('mon', '2026-07-13')];

async function load(items: Item[]) {
  store().clearStore();
  vi.mocked(db.fetchItems).mockResolvedValue(items);
  await store().initializeStore(USER);
  usePlannerStore.setState({ userTimezone: 'UTC' });
}

const rows = () => screen.queryAllByTestId('ghost-row');
const row = (id: string) => rows().find((r) => r.getAttribute('data-item-id') === id)!;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date(`${TODAY}T15:00:00Z`));
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
  vi.clearAllMocks();
  mobile.on = false;
  useMorningStore.setState({ morningCheckEnabled: true });
  await load(TWO);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  useMorningStore.setState({ morningCheckEnabled: false });
});

describe('when the fold is drawn', () => {
  it('renders the caption, the count, and the rows newest first', () => {
    render(<GhostFold dateStr={TODAY} />);
    const fold = screen.getByTestId('ghost-fold');
    expect(within(fold).getByText('From earlier')).toBeInTheDocument();
    expect(screen.getByTestId('ghost-fold-count')).toHaveTextContent('2');
    expect(rows().map((r) => r.getAttribute('data-item-id'))).toEqual(['mon', 'thu']);
    // The day it was for, in the start-time slot.
    expect(within(row('thu')).getByTestId('ghost-day')).toHaveTextContent('Thu');
    expect(fold).toHaveAttribute('data-ghost-fold', 'open');
  });

  it('draws nothing while the leftovers switch is off', () => {
    useMorningStore.setState({ morningCheckEnabled: false });
    render(<GhostFold dateStr={TODAY} />);
    expect(screen.queryByTestId('ghost-fold')).toBeNull();
  });

  it('draws nothing on a day that is not today', () => {
    render(<GhostFold dateStr={TOMORROW} />);
    expect(screen.queryByTestId('ghost-fold')).toBeNull();
    cleanup();
    render(<GhostFold dateStr="2026-07-13" />);
    expect(screen.queryByTestId('ghost-fold')).toBeNull();
  });

  it('draws nothing before the planner has loaded (cached rows are not the pile)', () => {
    usePlannerStore.setState({ isLoading: true, isPreview: true });
    render(<GhostFold dateStr={TODAY} />);
    expect(screen.queryByTestId('ghost-fold')).toBeNull();
  });

  it('draws nothing when nothing is left from earlier', async () => {
    await load([task('today', TODAY)]);
    render(<GhostFold dateStr={TODAY} />);
    expect(screen.queryByTestId('ghost-fold')).toBeNull();
  });

  it('starts collapsed past five, with the bulk verbs on screen', async () => {
    await load(Array.from({ length: 6 }, (_, i) => task(`p${i}`, `2026-07-0${i + 1}`)));
    render(<GhostFold dateStr={TODAY} />);
    expect(screen.getByTestId('ghost-fold')).toHaveAttribute('data-ghost-fold', 'closed');
    expect(screen.getByTestId('ghost-fold-count')).toHaveTextContent('6');
    expect(rows()).toHaveLength(0);
    expect(screen.getByTestId('ghost-keep-all')).toHaveTextContent('Keep all');
    expect(screen.getByTestId('ghost-send-all')).toHaveTextContent('Send all to sidebar');

    fireEvent.click(screen.getByTestId('ghost-fold-toggle'));
    expect(rows()).toHaveLength(6);
  });

  it('five stays open', async () => {
    await load(Array.from({ length: 5 }, (_, i) => task(`p${i}`, `2026-07-0${i + 1}`)));
    render(<GhostFold dateStr={TODAY} />);
    expect(rows()).toHaveLength(5);
  });
});

describe('the verbs are the store’s own', () => {
  const lastLabel = () => store().actionLog[0]?.label ?? '';

  it('Keep for today moves it to today, as one undoable step', () => {
    render(<GhostFold dateStr={TODAY} />);
    fireEvent.click(within(row('thu')).getByTestId('ghost-keep'));
    expect(taskById('thu').startDate).toBe(TODAY);
    expect(lastLabel()).toMatch(/^Move task to /);
    expect(rows().map((r) => r.getAttribute('data-item-id'))).toEqual(['mon']);
  });

  it('the dashed box keeps it too', () => {
    render(<GhostFold dateStr={TODAY} />);
    fireEvent.click(within(row('mon')).getByTestId('ghost-box'));
    expect(taskById('mon').startDate).toBe(TODAY);
  });

  it('Move to tomorrow', () => {
    render(<GhostFold dateStr={TODAY} />);
    fireEvent.click(within(row('thu')).getByTestId('ghost-tomorrow'));
    expect(taskById('thu').startDate).toBe(TOMORROW);
    expect(lastLabel()).toMatch(/^Move task to /);
  });

  it('Send to sidebar unschedules it', () => {
    render(<GhostFold dateStr={TODAY} />);
    fireEvent.click(within(row('thu')).getByTestId('ghost-sidebar'));
    expect(taskById('thu').isScheduled).toBe(false);
    expect(taskById('thu').startDate).toBeUndefined();
    expect(lastLabel()).toMatch(/^Unschedule task:/);
  });

  it('Let it go cancels it, kept in history', () => {
    render(<GhostFold dateStr={TODAY} />);
    fireEvent.click(within(row('thu')).getByTestId('ghost-let-go'));
    expect(taskById('thu').status).toBe('cancelled');
    expect(lastLabel()).toMatch(/^Let go:/);
  });

  it('Keep all is one bulk move', () => {
    render(<GhostFold dateStr={TODAY} />);
    fireEvent.click(screen.getByTestId('ghost-keep-all'));
    expect(taskById('thu').startDate).toBe(TODAY);
    expect(taskById('mon').startDate).toBe(TODAY);
    expect(lastLabel()).toBe(`Move all tasks to ${TODAY} (2)`);
  });

  it('Send all to sidebar is one bulk unschedule', () => {
    render(<GhostFold dateStr={TODAY} />);
    fireEvent.click(screen.getByTestId('ghost-send-all'));
    expect(taskById('thu').isScheduled).toBe(false);
    expect(taskById('mon').isScheduled).toBe(false);
    expect(lastLabel()).toBe('Unschedule task: 2 items');
  });

  it('undo brings the ghost back', () => {
    render(<GhostFold dateStr={TODAY} />);
    fireEvent.click(within(row('thu')).getByTestId('ghost-keep'));
    expect(rows()).toHaveLength(1);
    act(() => store().undo());
    expect(rows()).toHaveLength(2);
  });

  it('the title opens the item, writing nothing', () => {
    render(<GhostFold dateStr={TODAY} />);
    fireEvent.click(within(row('thu')).getByTestId('ghost-title'));
    expect(openEditFor).toHaveBeenCalledWith(expect.objectContaining({ id: 'thu' }), 'task');
    expect(taskById('thu').startDate).toBe('2026-07-09');
  });

  it('says “All sorted, you got this” after the last one, then nothing', () => {
    render(<GhostFold dateStr={TODAY} />);
    fireEvent.click(screen.getByTestId('ghost-keep-all'));
    expect(screen.getByTestId('ghost-fold-done')).toHaveTextContent('All sorted, you got this');
    act(() => vi.advanceTimersByTime(GHOST_DONE_MS + 10));
    expect(screen.queryByTestId('ghost-fold')).toBeNull();
  });
});

describe('on the phone', () => {
  it('shows the ellipsis instead of the hover capsule, and its sheet carries the verbs', () => {
    mobile.on = true;
    render(<GhostFold dateStr={TODAY} />);
    expect(within(row('thu')).queryByTestId('ghost-keep')).toBeNull();
    fireEvent.click(within(row('thu')).getByTestId('ghost-actions-button'));
    const sheet = screen.getByTestId('ghost-sheet');
    expect(within(sheet).getByTestId('ghost-sheet-keep')).toHaveTextContent('Keep for today');
    expect(within(sheet).getByTestId('ghost-sheet-tomorrow')).toBeInTheDocument();
    expect(within(sheet).getByTestId('ghost-sheet-reschedule')).toBeInTheDocument();
    expect(within(sheet).getByTestId('ghost-sheet-sidebar')).toBeInTheDocument();
    expect(within(sheet).getByTestId('ghost-sheet-let-go')).toBeInTheDocument();
    fireEvent.click(within(sheet).getByTestId('ghost-sheet-tomorrow'));
    expect(taskById('thu').startDate).toBe(TOMORROW);
  });
});

describe('a legacy full-ISO start date', () => {
  // items.start_date is text, and the selector admits these on purpose
  // (lib/overdue.ts toDateOnly). Every date the fold formats is normalised, so
  // the weekday, its tooltip, the gates and the phone sheet all survive one.
  const ISO = [task('iso', '2026-07-10T00:00:00.000Z')];

  it('renders, with its weekday', async () => {
    await load(ISO);
    render(<GhostFold dateStr={TODAY} />);
    expect(within(row('iso')).getByTestId('ghost-day')).toHaveTextContent('Fri');
    expect(within(row('iso')).getByTestId('ghost-keep')).toBeInTheDocument();
  });

  it('opens its phone sheet, which names the day it was for', async () => {
    mobile.on = true;
    await load(ISO);
    render(<GhostFold dateStr={TODAY} />);
    fireEvent.click(within(row('iso')).getByTestId('ghost-actions-button'));
    expect(screen.getByTestId('ghost-sheet')).toHaveTextContent(/Planned for/);
    fireEvent.click(screen.getByTestId('ghost-sheet-reschedule'));
    expect(screen.getByTestId('ghost-sheet')).toBeInTheDocument();
  });
});

describe('“All sorted” is for the person’s own last verb', () => {
  it('stays quiet when the pile empties from outside the fold', () => {
    render(<GhostFold dateStr={TODAY} />);
    // As a catch-up fold or the auto-age sweep would: no verb here.
    act(() => store().unscheduleTasks(['thu', 'mon']));
    expect(screen.queryByTestId('ghost-fold-done')).toBeNull();
    expect(screen.queryByTestId('ghost-fold')).toBeNull();
  });

  it('stays quiet when only some of the emptying was the fold’s', () => {
    render(<GhostFold dateStr={TODAY} />);
    fireEvent.click(within(row('thu')).getByTestId('ghost-keep'));
    expect(rows()).toHaveLength(1);
    act(() => store().moveTaskToDate('mon', TODAY));
    expect(screen.queryByTestId('ghost-fold-done')).toBeNull();
  });

  it('an undo of the last keep brings the row back and takes the line down', () => {
    render(<GhostFold dateStr={TODAY} />);
    fireEvent.click(screen.getByTestId('ghost-keep-all'));
    expect(screen.getByTestId('ghost-fold-done')).toBeInTheDocument();
    act(() => store().undo());
    expect(rows()).toHaveLength(2);
    expect(screen.queryByTestId('ghost-fold-done')).toBeNull();
    act(() => vi.advanceTimersByTime(GHOST_DONE_MS + 10));
    expect(rows()).toHaveLength(2);
  });
});

/**
 * The `review.saved` stand-in (ghost rows phase 2): the end of day review's
 * event for recipes and mods, raised when the person's own verbs sort the last
 * leftover, once a day, and never for a pile something else emptied.
 */
describe('sorting the last leftover raises review.saved', () => {
  let heard: ModEvent[] = [];
  let unsubscribe: () => void = () => {};
  beforeEach(() => {
    heard = [];
    // An earlier test's dispatch can be left queued on a fake timer that
    // useRealTimers discarded, which would hold the bus shut.
    __resetModEventsForTests();
    useMorningStore.setState({ leftoversClearedByUser: {} });
    unsubscribe = subscribeModEvents((e) => {
      if (e.kind === 'review.saved') heard.push(e);
    });
  });
  afterEach(() => unsubscribe());

  /** Run the bus's dispatch task (lib/mod-events.ts queues it on setTimeout 0). */
  const dispatch = () => act(() => vi.advanceTimersByTime(1));

  it('raises once, with today as its date, when the fold’s own verb clears it', () => {
    render(<GhostFold dateStr={TODAY} />);
    fireEvent.click(screen.getByTestId('ghost-keep-all'));
    dispatch();
    expect(heard).toEqual([{ kind: 'review.saved', date: TODAY }]);
    expect(useMorningStore.getState().leftoversClearedByUser).toEqual({ [USER]: TODAY });
  });

  it('raises nothing when the pile empties from outside the fold', () => {
    render(<GhostFold dateStr={TODAY} />);
    act(() => store().unscheduleTasks(['thu', 'mon']));
    dispatch();
    expect(heard).toEqual([]);
  });

  it('raises nothing while ghosts remain', () => {
    render(<GhostFold dateStr={TODAY} />);
    fireEvent.click(within(row('thu')).getByTestId('ghost-keep'));
    dispatch();
    expect(heard).toEqual([]);
  });

  it('is once a day: an undo and a second clearing say nothing more', () => {
    render(<GhostFold dateStr={TODAY} />);
    fireEvent.click(screen.getByTestId('ghost-keep-all'));
    dispatch();
    act(() => store().undo());
    expect(rows()).toHaveLength(2);
    fireEvent.click(screen.getByTestId('ghost-keep-all'));
    dispatch();
    expect(heard).toEqual([{ kind: 'review.saved', date: TODAY }]);
    // The line still says it, every time.
    expect(screen.getByTestId('ghost-fold-done')).toBeInTheDocument();
  });
});

describe('the pile rule is judged at first sight', () => {
  const bulk = () => screen.getByTestId('ghost-keep-all').parentElement!;

  it('six shrinking to five stays closed, with the bulk verbs still on screen', async () => {
    await load(Array.from({ length: 6 }, (_, i) => task(`p${i}`, `2026-07-0${i + 1}`)));
    render(<GhostFold dateStr={TODAY} />);
    expect(bulk().className).toContain('opacity-100');
    act(() => store().moveTaskToDate('p0', TODAY));
    expect(screen.getByTestId('ghost-fold-count')).toHaveTextContent('5');
    expect(screen.getByTestId('ghost-fold')).toHaveAttribute('data-ghost-fold', 'closed');
    expect(rows()).toHaveLength(0);
    expect(bulk().className).toContain('opacity-100');
    expect(bulk().className).not.toContain('opacity-0');
  });

  it('an open fold keeps them behind hover', () => {
    render(<GhostFold dateStr={TODAY} />);
    expect(bulk().className).toContain('opacity-0');
  });
});

describe('a ghost inside a project block', () => {
  beforeEach(async () => {
    await load([task('blocked', '2026-07-10', { inProjectBlock: true }), task('free', '2026-07-09')]);
  });

  it('offers only Let it go, and its box neither keeps nor shows a Plus', () => {
    render(<GhostFold dateStr={TODAY} />);
    const r = row('blocked');
    for (const id of ['ghost-keep', 'ghost-tomorrow', 'ghost-reschedule', 'ghost-sidebar']) {
      expect(within(r).queryByTestId(id)).toBeNull();
    }
    expect(within(r).getByTestId('ghost-let-go')).toBeInTheDocument();
    const box = within(r).getByTestId('ghost-box');
    expect(box).toBeDisabled();
    expect(box.querySelector('svg')).toBeNull();
  });

  it('is skipped by Keep all and by Send all to sidebar', () => {
    render(<GhostFold dateStr={TODAY} />);
    fireEvent.click(screen.getByTestId('ghost-keep-all'));
    expect(taskById('free').startDate).toBe(TODAY);
    expect(taskById('blocked').startDate).toBe('2026-07-10');
    act(() => store().undo());
    fireEvent.click(screen.getByTestId('ghost-send-all'));
    expect(taskById('free').isScheduled).toBe(false);
    expect(taskById('blocked').isScheduled).toBe(true);
    expect(taskById('blocked').startDate).toBe('2026-07-10');
  });
});

describe('Reschedule', () => {
  it('moves it to the day picked in the calendar', () => {
    render(<GhostFold dateStr={TODAY} />);
    fireEvent.click(within(row('thu')).getByTestId('ghost-reschedule'));
    const popover = screen.getByTestId('ghost-reschedule-popover');
    fireEvent.click(within(popover).getByRole('button', { name: /July 20/ }));
    expect(taskById('thu').startDate).toBe('2026-07-20');
    expect(store().actionLog[0]?.label).toMatch(/^Move task to /);
  });

  it('on the phone, through the sheet’s calendar', () => {
    mobile.on = true;
    render(<GhostFold dateStr={TODAY} />);
    fireEvent.click(within(row('thu')).getByTestId('ghost-actions-button'));
    fireEvent.click(screen.getByTestId('ghost-sheet-reschedule'));
    fireEvent.click(within(screen.getByTestId('ghost-sheet')).getByRole('button', { name: /July 20/ }));
    expect(taskById('thu').startDate).toBe('2026-07-20');
  });
});

describe('the accent', () => {
  it('draws no lime in a ghost row: a low priority’s bars are muted, not faded', async () => {
    await load([task('low', '2026-07-10', { priority: 'low' })]);
    render(<GhostFold dateStr={TODAY} />);
    const r = row('low');
    expect(r.querySelector('[class*="bg-priority"]')).toBeNull();
    expect(r.querySelector('[class*="bg-primary"]')).toBeNull();
    expect(within(r).getByRole('img', { name: /priority/ }).parentElement!.className).not.toMatch(/opacity-/);
  });
});
