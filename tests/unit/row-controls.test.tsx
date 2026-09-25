import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';

/**
 * "Move to tomorrow" and "Move to Braindump" on a day row and on a schedule
 * block: who gets them, where they send the item, and that they answer with the
 * rail tooltip rather than a native title.
 *
 * The gates live in lib/row-moves.ts (row-moves.test.ts pins them as pure
 * functions); this pins that the row and the block both ask them, and that the
 * write lands on the right day.
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

vi.mock('@/lib/ui-store', async (orig) => {
  const real = await orig<typeof import('@/lib/ui-store')>();
  return { ...real, openEditFor: vi.fn() };
});

import { TaskRow, type RowItem } from '@/components/primitives/task-row';
import { ScheduleBlock, type TimedEntry } from '@/components/views/day-schedule';
import { usePlannerStore } from '@/lib/planner-store';
import { openEditFor } from '@/lib/ui-store';
import * as db from '@/lib/db';
import type { HabitItem, Item, Task, TaskItem } from '@/lib/planner-types';

const USER = 'user-1';
/** The real "today" for every test here. */
const TODAY = '2026-07-14';
const TOMORROW = '2026-07-15';
/** A future week column (Thursday) and an overdue day. */
const THURSDAY = '2026-07-16';
const LAST_WEEK = '2026-07-07';

const asDate = (ymd: string) => new Date(`${ymd}T12:00:00Z`);
const store = () => usePlannerStore.getState();
const taskById = (id: string) => store().items.find((i) => i.id === id) as TaskItem;

const task = (id: string, extra: Partial<TaskItem> = {}): Item =>
  ({
    type: 'task',
    id,
    title: id,
    status: 'pending',
    isScheduled: false,
    timeBucket: 'anytime',
    order: 0,
    startDate: TODAY,
    completedDates: [],
    skippedDates: [],
    ...extra,
  }) as Item;

const fixtures = (): Item[] => [
  task('one-off'),
  task('timed', { isScheduled: true, startTime: '10:00', duration: 60, timeBucket: 'morning' }),
  task('daily', { repeatFrequency: 'daily', startDate: '2026-07-01' }),
  task('done', { status: 'completed' }),
  task('cancelled', { status: 'cancelled' }),
  task('milestone'),
  task('in-block', { inProjectBlock: true, project: 'Work' }),
  {
    type: 'habit',
    id: 'habit',
    title: 'Stretch',
    streak: 0,
    status: 'pending',
    completedDates: [],
    skippedDates: [],
    dailyCounts: {},
    repeatFrequency: 'daily',
  } as Item,
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
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
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

beforeEach(async () => {
  store().clearStore();
  vi.clearAllMocks();
  vi.mocked(db.fetchItems).mockResolvedValue(fixtures());
  await store().initializeStore(USER);
  usePlannerStore.setState({
    selectedDate: asDate(TODAY),
    userTimezone: 'UTC',
    goals: [{ id: 'g1', title: 'Ship', milestoneIds: ['milestone'], memberIds: [], checkInIds: [] }] as never,
  });
});

function LiveRow({ id, date }: { id: string; date?: Date }) {
  const item = usePlannerStore((s) => s.items.find((i) => i.id === id))!;
  const row: RowItem =
    item.type === 'habit'
      ? { itemType: 'habit', item: item as unknown as HabitItem }
      : { itemType: 'task', item: item as unknown as Task };
  return <TaskRow row={row} date={date} />;
}
const renderRow = (id: string, date?: Date) => render(<LiveRow id={id} date={date} />);

const tomorrowBtn = () => screen.queryByTestId('item-tomorrow-button');
const braindumpBtn = () => screen.queryByTestId('item-unschedule-button');

describe('day row: who gets the controls', () => {
  it('a one-off open task gets both', () => {
    renderRow('one-off');
    expect(tomorrowBtn()).not.toBeNull();
    expect(braindumpBtn()).not.toBeNull();
  });

  it('a recurring task gets neither — Skip today is its answer', () => {
    renderRow('daily');
    expect(tomorrowBtn()).toBeNull();
    expect(braindumpBtn()).toBeNull();
    expect(screen.getByTestId('item-skip-button')).toBeInTheDocument();
  });

  it.each(['done', 'cancelled', 'in-block', 'habit'])('%s gets neither', (id) => {
    renderRow(id);
    expect(tomorrowBtn()).toBeNull();
    expect(braindumpBtn()).toBeNull();
  });

  it('a milestone may be carried a day but never unscheduled (it would lose its target date)', () => {
    renderRow('milestone');
    expect(tomorrowBtn()).not.toBeNull();
    expect(braindumpBtn()).toBeNull();
  });
});

describe('day row: where the item goes', () => {
  it('today → tomorrow', () => {
    renderRow('one-off');
    fireEvent.click(tomorrowBtn()!);
    expect(taskById('one-off').startDate).toBe(TOMORROW);
    expect(taskById('one-off').timeBucket).toBe('anytime');
  });

  it("a future week column → that column's next day", () => {
    renderRow('one-off', asDate(THURSDAY));
    fireEvent.click(tomorrowBtn()!);
    expect(taskById('one-off').startDate).toBe('2026-07-17');
  });

  it('an overdue day → real tomorrow, never another past day', () => {
    renderRow('one-off', asDate(LAST_WEEK));
    fireEvent.click(tomorrowBtn()!);
    expect(taskById('one-off').startDate).toBe(TOMORROW);
  });

  it('braindump clears the date and the slot', () => {
    renderRow('timed');
    fireEvent.click(braindumpBtn()!);
    const t = taskById('timed');
    expect(t.startDate).toBeUndefined();
    expect(t.startTime).toBeUndefined();
    expect(t.isScheduled).toBe(false);
  });

  it('clicking a control does not open the editor', () => {
    renderRow('one-off');
    fireEvent.click(tomorrowBtn()!);
    expect(openEditFor).not.toHaveBeenCalled();
  });
});

describe('title under the hover controls', () => {
  /** Lay the row out the way a browser would: the title box ends at x=500,
   *  the capsule starts at x=400, and the title's text ends at `textRight`. */
  function layout(textRight: number) {
    const rect = (left: number, right: number) =>
      ({ left, right, top: 0, bottom: 20, width: right - left, height: 20, x: left, y: 0, toJSON() {} }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.tagName === 'P') return rect(40, 500);
      if (this.querySelector?.('[data-testid="item-delete-button"]') && this.tagName === 'SPAN') return rect(400, 480);
      return rect(0, 0);
    });
    rangeProto.getClientRects = () => [rect(40, textRight)];
  }
  const rangeProto = Range.prototype as unknown as { getClientRects?: () => DOMRect[] };
  const realRects = rangeProto.getClientRects;
  afterEach(() => {
    vi.restoreAllMocks();
    rangeProto.getClientRects = realRects;
  });

  const title = (text: string) => screen.getByText(text, { selector: 'p' });

  it('fades out before the controls, measured per row', () => {
    layout(480);
    renderRow('one-off');
    fireEvent.mouseEnter(screen.getByTestId('item-card'));
    // 500 - 400 + 6px of air = 106px hidden, then a 24px fade.
    expect(title('one-off').style.getPropertyValue('--title-mask')).toBe(
      'linear-gradient(to left, transparent 106px, black 130px)'
    );
  });

  it('shows the full title on hover when the controls cover some of it', async () => {
    layout(480);
    renderRow('one-off');
    fireEvent.mouseEnter(screen.getByTestId('item-card'));
    const p = title('one-off');
    fireEvent.pointerEnter(p);
    fireEvent.pointerMove(p);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('one-off');
  });

  it('gives a title that fits no tooltip', async () => {
    layout(200);
    renderRow('one-off');
    fireEvent.mouseEnter(screen.getByTestId('item-card'));
    const p = title('one-off');
    fireEvent.pointerEnter(p);
    fireEvent.pointerMove(p);
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(p).not.toHaveAttribute('title');
  });
});

describe('row controls: tooltips', () => {
  it('answer with the rail tooltip, naming the day', async () => {
    renderRow('one-off');
    const btn = tomorrowBtn()!;
    expect(btn).not.toHaveAttribute('title');
    fireEvent.pointerEnter(btn);
    fireEvent.pointerMove(btn);
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent(/Move to tomorrow/);
    expect(tip).toHaveTextContent(/Wed, Jul 15/);
  });

  it('say "next day" when the next day is not tomorrow', async () => {
    renderRow('one-off', asDate(THURSDAY));
    const btn = tomorrowBtn()!;
    fireEvent.pointerEnter(btn);
    fireEvent.pointerMove(btn);
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent(/Move to next day/);
    expect(tip).toHaveTextContent(/Fri, Jul 17/);
  });

  it('no control in the cluster carries a native title', () => {
    renderRow('one-off');
    for (const id of ['item-tomorrow-button', 'item-unschedule-button', 'item-delete-button']) {
      expect(screen.getByTestId(id)).not.toHaveAttribute('title');
    }
  });
});

function LiveBlock({ id, variant = 'day' }: { id: string; variant?: 'day' | 'week' }) {
  const item = usePlannerStore((s) => s.items.find((i) => i.id === id))!;
  const entry: TimedEntry = {
    itemType: 'task',
    item: item as unknown as Task,
    startMin: 600,
    duration: 60,
  };
  return (
    <DndContext>
      <ScheduleBlock entry={entry} gridStartMin={480} hourPx={60} variant={variant} fieldWidth={900} />
    </DndContext>
  );
}

describe('schedule block controls', () => {
  it('a one-off timed block carries both controls', () => {
    render(<LiveBlock id="timed" />);
    const controls = screen.getByTestId('block-controls');
    expect(within(controls).getByTestId('item-tomorrow-button')).toBeInTheDocument();
    expect(within(controls).getByTestId('item-unschedule-button')).toBeInTheDocument();
  });

  it('moves to tomorrow at the same clock time, without opening the editor', () => {
    render(<LiveBlock id="timed" />);
    fireEvent.pointerDown(screen.getByTestId('item-tomorrow-button'));
    fireEvent.click(screen.getByTestId('item-tomorrow-button'));
    const t = taskById('timed');
    expect(t.startDate).toBe(TOMORROW);
    expect(t.startTime).toBe('10:00');
    expect(t.isScheduled).toBe(true);
    expect(openEditFor).not.toHaveBeenCalled();
  });

  it('a week block mounts them too (its own hover row; visibility is CSS, not asserted here)', () => {
    render(<LiveBlock id="timed" variant="week" />);
    expect(screen.getByTestId('block-controls')).toBeInTheDocument();
  });

  it.each(['daily', 'done', 'in-block'])('%s renders no empty capsule', (id) => {
    render(<LiveBlock id={id} />);
    expect(screen.queryByTestId('block-controls')).toBeNull();
  });
});
