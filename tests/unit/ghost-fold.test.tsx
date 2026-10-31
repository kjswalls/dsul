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
