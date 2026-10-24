import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';

/**
 * Who is allowed to start a schedule resize (lib/dnd/CONTRACT.md § Sensors).
 *
 * The handle's hit zone is 12px tall — a target no fingertip can aim at, but one
 * a scrolling thumb crosses constantly, and every crossing used to capture the
 * pointer and commit a new duration on release. So `onResizeDown` declines
 * touch pointers, and mouse/pen keep the same element.
 *
 * The two existing tests that press a handle (`schedule-lanes-render.test.tsx`,
 * `schedule-block-overlap.test.tsx`) fire `pointerDown` with no `pointerType` at
 * all, so they pass identically with the guard deleted — a review found it could
 * be removed with CI staying green. These press the handle as each input type
 * actually presses it.
 *
 * The blank case is here deliberately and is not padding: an unlabelled
 * `pointerType` must keep reading as NON-touch, because that is the pointer
 * every other resize test in the suite sends, and because erring the other way
 * would disable resize outright on any engine that leaves the field empty.
 */

// The two writes a resize can end in, held so the last describe can read them.
const writes = vi.hoisted(() => ({ updateTask: vi.fn(), updateHabit: vi.fn() }));

vi.mock('@/lib/planner-store', () => ({
  usePlannerStore: () => ({
    getProjectColor: () => 'var(--accent-3)',
    getHabitGroupColor: () => 'var(--accent-2)',
    selectedDate: new Date('2026-07-29T12:00:00Z'),
    userTimezone: 'UTC',
    toggleTaskStatus: vi.fn(),
    updateTask: writes.updateTask,
    updateHabit: writes.updateHabit,
  }),
}));
vi.mock('@/lib/use-time-format', () => ({ useTimeFormat: () => 'h:mm a' }));
vi.mock('@/lib/ui-store', () => ({ openEditFor: vi.fn() }));

const { ScheduleBlock } = await import('@/components/views/day-schedule');
const { useScheduleResizeStore } = await import('@/lib/schedule-resize-store');
type TimedEntry = import('@/components/views/day-schedule').TimedEntry;

const HOUR = 52;
const GRID = 9 * 60;

const entry: TimedEntry = {
  itemType: 'task',
  item: {
    id: 'gym',
    title: 'Go to the gym',
    type: 'task',
    status: 'pending',
    startTime: '10:00',
    duration: 60,
    repeatFrequency: 'none',
    completedDates: [],
  } as never,
  startMin: 10 * 60,
  duration: 60,
};

function paint() {
  const { container } = render(
    <DndContext>
      <ScheduleBlock entry={entry} gridStartMin={GRID} hourPx={HOUR} fieldWidth={900} />
    </DndContext>
  );
  return {
    handle: (edge: 'start' | 'duration') =>
      container.querySelector(`[aria-label="Resize ${edge}"]`) as HTMLElement,
  };
}

const resizing = () => useScheduleResizeStore.getState().resizing;

let capture: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  useScheduleResizeStore.setState({ resizing: false });
  // jsdom's stub is installed in tests/unit/setup.ts; spying keeps it a no-op
  // and records whether the gesture was taken over.
  capture = vi.spyOn(Element.prototype, 'setPointerCapture').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  capture.mockRestore();
});

describe('a finger on a resize handle', () => {
  it('starts nothing, on either edge', () => {
    const { handle } = paint();

    for (const edge of ['start', 'duration'] as const) {
      fireEvent.pointerDown(handle(edge), { pointerType: 'touch', clientY: 100, pointerId: 1 });
      expect(resizing()).toBe(false);
      expect(capture).not.toHaveBeenCalled();
    }
  });

  it('leaves the gesture to the browser, so the grid can still scroll', () => {
    const { handle } = paint();

    // `fireEvent` reports the dispatch result: false once anything has called
    // preventDefault. A handler that swallowed the touch here would take the
    // scroll away whatever else it did or didn't do.
    const delivered = fireEvent.pointerDown(handle('duration'), {
      pointerType: 'touch',
      clientY: 100,
      pointerId: 1,
    });

    expect(delivered).toBe(true);
  });
});

describe('a mouse on the same handle', () => {
  it('starts the resize and captures the pointer', () => {
    const { handle } = paint();

    const delivered = fireEvent.pointerDown(handle('duration'), {
      pointerType: 'mouse',
      clientY: 100,
      pointerId: 1,
    });

    expect(resizing()).toBe(true);
    expect(capture).toHaveBeenCalledWith(1);
    // The gesture IS claimed on this path — preventDefault is what stops the
    // press from turning into a text selection or a click on the block.
    expect(delivered).toBe(false);
  });
});

describe('an unlabelled pointerType', () => {
  it('still resizes — blank is read as not-a-finger', () => {
    const { handle } = paint();

    fireEvent.pointerDown(handle('duration'), { clientY: 100, pointerId: 1 });

    expect(resizing()).toBe(true);
  });
});

/**
 * What a mouse resize writes, end to end through the block: the press, one
 * move and the release, with the grid's scroll viewport around it (the
 * component reads its scroll offset, and without one it previews nothing).
 * The maths is lib/schedule-resize.ts's, pinned there and in
 * tests/fixtures/day/resize.json; these cases say the block still asks it, and
 * still writes the store action of the item's own type.
 */
describe('what a mouse resize writes', () => {
  let raf: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writes.updateTask.mockClear();
    writes.updateHabit.mockClear();
    // The auto-scroll loop is a frame callback; jsdom measures every box as
    // zero, which would read as a pointer below the viewport and scroll it.
    raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
  });

  afterEach(() => raf.mockRestore());

  const block = (startTime: string, duration: number, over: Record<string, unknown> = {}): TimedEntry => {
    const [h, m] = startTime.split(':').map(Number);
    return {
      ...entry,
      item: { ...(entry.item as object), startTime, duration, ...over } as never,
      startMin: h * 60 + m,
      duration,
    };
  };

  /** Press `edge` at y 100, move `dy` pixels (52 to the hour), release. */
  function resize(e: TimedEntry, edge: 'start' | 'duration', dy: number) {
    const { container } = render(
      <DndContext>
        <div data-slot="scroll-area-viewport">
          <ScheduleBlock entry={e} gridStartMin={0} hourPx={HOUR} fieldWidth={900} />
        </div>
      </DndContext>
    );
    const handle = container.querySelector(`[aria-label="Resize ${edge}"]`) as HTMLElement;
    fireEvent.pointerDown(handle, { pointerType: 'mouse', clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { pointerType: 'mouse', clientY: 100 + dy, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerType: 'mouse', clientY: 100 + dy, pointerId: 1 });
  }

  it('the bottom edge writes the length alone', () => {
    resize(block('10:00', 60), 'duration', HOUR / 2);
    expect(writes.updateTask).toHaveBeenCalledTimes(1);
    expect(writes.updateTask).toHaveBeenCalledWith('gym', { duration: 90 });
  });

  it('the bottom edge stops at the 15-minute floor', () => {
    resize(block('10:00', 60), 'duration', -2 * HOUR);
    expect(writes.updateTask).toHaveBeenCalledWith('gym', { duration: 15 });
  });

  it('a move that snaps back to the same length writes nothing', () => {
    resize(block('10:00', 60), 'duration', 5);
    expect(writes.updateTask).not.toHaveBeenCalled();
  });

  it('the top edge writes the start, the length and the start’s part of day, the end fixed', () => {
    resize(block('10:00', 60), 'start', -HOUR / 2);
    expect(writes.updateTask).toHaveBeenCalledWith('gym', { startTime: '09:30', duration: 90, timeBucket: 'morning' });
  });

  it('the top edge files the new start in its own part of day', () => {
    resize(block('11:00', 120), 'start', (HOUR * 3) / 2);
    expect(writes.updateTask).toHaveBeenCalledWith('gym', { startTime: '12:30', duration: 30, timeBucket: 'afternoon' });
  });

  it('the top edge stops 15 minutes before the end, and at midnight', () => {
    resize(block('10:00', 60), 'start', 2 * HOUR);
    expect(writes.updateTask).toHaveBeenLastCalledWith('gym', { startTime: '10:45', duration: 15, timeBucket: 'morning' });
    cleanup();
    resize(block('00:30', 60), 'start', -2 * HOUR);
    expect(writes.updateTask).toHaveBeenLastCalledWith('gym', { startTime: '00:00', duration: 90, timeBucket: 'morning' });
  });

  it('the bottom edge stops at midnight', () => {
    // The one change PR 9 makes to the web's resize: the end no longer runs on
    // past 24:00, where nothing draws.
    resize(block('23:00', 30), 'duration', 2 * HOUR);
    expect(writes.updateTask).toHaveBeenCalledWith('gym', { duration: 60 });
  });

  it('the top edge of a block that runs past midnight never reaches 24:00', () => {
    // Its end comes back to midnight and the start stops at 23:45, a time the
    // day has, where it once ran on to "24:15" (and, dragged up, to a length
    // over a day).
    resize(block('23:30', 60), 'start', 2 * HOUR);
    expect(writes.updateTask).toHaveBeenCalledWith('gym', { startTime: '23:45', duration: 15, timeBucket: 'evening' });
  });

  it('the bottom edge of a block stored at 24:15 writes nothing', () => {
    // The start stays, and none after midnight has a length that ends inside
    // the day; this once wrote a length under zero.
    resize(block('24:15', 30), 'duration', HOUR);
    expect(writes.updateTask).not.toHaveBeenCalled();
  });

  it('the top edge of a block that ends before 0:15 stays at 0:00', () => {
    // The start can't go before midnight to keep 15 minutes, so the floor gives
    // way and nothing changes; this once wrote a start of "-1:-5".
    resize(block('00:00', 10), 'start', HOUR / 4);
    expect(writes.updateTask).not.toHaveBeenCalled();
  });

  it('a habit writes through its own action', () => {
    const stretch: TimedEntry = {
      itemType: 'habit',
      item: {
        id: 'stretch',
        title: 'Stretch',
        type: 'habit',
        startTime: '18:00',
        duration: 30,
        timeBucket: 'evening',
        repeatFrequency: 'daily',
        completedDates: [],
        streak: 0,
      } as never,
      startMin: 18 * 60,
      duration: 30,
    };
    resize(stretch, 'start', -HOUR);
    expect(writes.updateTask).not.toHaveBeenCalled();
    expect(writes.updateHabit).toHaveBeenCalledWith('stretch', { startTime: '17:00', duration: 90, timeBucket: 'evening' });
  });
});
