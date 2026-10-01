import { describe, it, expect } from 'vitest';
import {
  isRowCompletedOn,
  orderRows,
  sinkCompleted,
  type SortableRow,
} from '@/lib/sort-rows';
import type { HabitItem, Task } from '@/lib/planner-types';

/**
 * Finished work sinks to the foot of its group.
 *
 * The pure half. The surfaces that call it are covered by
 * completed-sinks-surfaces.test.tsx, which mounts them — the scoping decision
 * (Day × Buckets hands over its untimed rows only; the week views resolve per
 * COLUMN) lives in the components, so a props-level test says nothing about it.
 */

const DAY = '2026-08-13';
const OTHER_DAY = '2026-08-14';

/**
 * `over` is loosely typed on purpose: two cases below hand a row the OTHER
 * type's finished value ('done' to a task, 'completed' to a habit) to prove the
 * predicate asks the registry rather than accepting either. The declared
 * unions reject exactly those, which is the point being tested.
 */
const task = (title: string, over: Record<string, unknown> = {}): SortableRow => ({
  itemType: 'task',
  item: {
    type: 'task',
    id: title,
    title,
    status: 'pending',
    order: 0,
    ...over,
  } as unknown as Task,
});

const habit = (title: string, over: Record<string, unknown> = {}): SortableRow => ({
  itemType: 'habit',
  item: {
    type: 'habit',
    id: title,
    title,
    project: 'Health',
    status: 'pending',
    streak: 0,
    completedDates: [],
    skippedDates: [],
    repeatFrequency: 'daily',
    ...over,
  } as unknown as HabitItem,
});

/** A task-shaped row of a user-defined type, under the closed custom envelope. */
const custom = (title: string, over: Record<string, unknown> = {}): SortableRow => ({
  itemType: 'task',
  item: {
    type: 'custom',
    customType: 'errand',
    id: title,
    title,
    status: 'pending',
    order: 0,
    ...over,
  } as unknown as Task,
});

const titles = (rows: SortableRow[]) => rows.map((r) => r.item.title);

describe('isRowCompletedOn — recurrence decides which rule applies', () => {
  it('reads a recurring item PER DATE, not off its scalar status', () => {
    // The bug this exists to stop: a habit ticked today sinking on every other
    // day of the week. `status` on a recurring item is a last-toggle snapshot
    // (migration 016) and says nothing about the date being rendered.
    const ticked = habit('Stretch', { completedDates: [DAY], status: 'done' });

    expect(isRowCompletedOn(ticked, DAY)).toBe(true);
    expect(isRowCompletedOn(ticked, OTHER_DAY)).toBe(false);
  });

  it('reads a recurring TASK per date too — recurrence, not type', () => {
    const recurringTask = task('Water plants', {
      repeatFrequency: 'daily',
      startDate: DAY,
      completedDates: [DAY],
    });

    expect(isRowCompletedOn(recurringTask, DAY)).toBe(true);
    expect(isRowCompletedOn(recurringTask, OTHER_DAY)).toBe(false);
  });

  it('never calls a recurring row finished on a DATELESS surface', () => {
    // The braindump passes null. TaskRow already refuses to draw a recurring
    // row as completed there (`suppressCompletedLook`, issue #181), so a row
    // wearing no completion mark must not move as though it had one.
    const ticked = habit('Stretch', { completedDates: [DAY], status: 'done' });

    expect(isRowCompletedOn(ticked, null)).toBe(false);
  });

  it('still resolves a ONE-SHOT row on a dateless surface', () => {
    // Which is what makes null a scoping decision rather than a switch-off:
    // the braindump is almost entirely one-shot tasks, and they do sink.
    expect(isRowCompletedOn(task('Buy milk', { status: 'completed' }), null)).toBe(true);
  });
});

describe('isRowCompletedOn — one status vocabulary per type, asked of the registry', () => {
  it("uses the TASK vocabulary's 'completed'", () => {
    expect(isRowCompletedOn(task('done', { status: 'completed' }), DAY)).toBe(true);
  });

  it("uses the HABIT vocabulary's 'done' for a non-recurring habit", () => {
    // CONSTRUCTED, not a live row: `habit.allowedFrequencies` has no 'none'
    // (lib/item-registry.ts), and `braindumpEligible` is false, so no habit
    // reaches either the dateless surface or a non-recurring shape through the
    // app. It is still the assertion that pins the scalar branch to the
    // registry: `isRowCompletedOn` only consults `doneStatus` when `isRecurring`
    // is false, so a task-vocabulary literal there is invisible to every other
    // habit case in this file.
    const finished = habit('Read', { repeatFrequency: 'none', status: 'done' });

    expect(isRowCompletedOn(finished, DAY)).toBe(true);
  });

  it('does NOT accept the other type\'s finished value', () => {
    // The two vocabularies are external contracts the OpenClaw plugin parses
    // and throws on, so they must not be merged into one "is it done" set. A
    // hardcoded `status === 'completed'` passes the task cases above and fails
    // here; a merged `['completed','done']` check fails here too.
    expect(isRowCompletedOn(habit('Read', { repeatFrequency: 'none', status: 'completed' }), DAY)).toBe(
      false
    );
    expect(isRowCompletedOn(task('odd', { status: 'done' }), DAY)).toBe(false);
  });

  it('resolves a CUSTOM type through the registry, not through its envelope', () => {
    // `type` is 'custom' on the wire; the registry name is the slug. The v1
    // template is task-shaped, so its doneStatus is 'completed'.
    expect(isRowCompletedOn(custom('Post parcel', { status: 'completed' }), DAY)).toBe(true);
    expect(isRowCompletedOn(custom('Post parcel'), DAY)).toBe(false);
  });
});

describe('isRowCompletedOn — cancelled and skipped are not finished', () => {
  it('leaves a cancelled task where it is', () => {
    // `doneStatus` is the only field in the registry that names a finished
    // state. Sinking 'cancelled' would mean hardcoding one member of the task
    // vocabulary and asserting it means what 'skipped' means to a habit.
    expect(isRowCompletedOn(task('dropped', { status: 'cancelled' }), DAY)).toBe(false);
  });

  it('leaves a skipped occurrence where it is', () => {
    const skipped = habit('Stretch', { skippedDates: [DAY], status: 'skipped' });

    expect(isRowCompletedOn(skipped, DAY)).toBe(false);
  });
});

describe('sinkCompleted', () => {
  it('moves finished rows to the foot of the list', () => {
    const rows = [
      task('a', { status: 'completed' }),
      task('b'),
      task('c', { status: 'completed' }),
      task('d'),
    ];

    expect(titles(sinkCompleted(rows, DAY))).toEqual(['b', 'd', 'a', 'c']);
  });

  it('preserves the incoming order INSIDE each half', () => {
    // Both halves are appended in the order they were walked, so whatever the
    // derivation (or an Ordering) put them in survives within each half. This
    // is what keeps "Priority" time-ordered inside a band after the sink.
    const rows = [
      task('done-1', { status: 'completed' }),
      task('open-1'),
      task('done-2', { status: 'completed' }),
      task('open-2'),
      task('done-3', { status: 'completed' }),
      task('open-3'),
    ];

    expect(titles(sinkCompleted(rows, DAY))).toEqual([
      'open-1',
      'open-2',
      'open-3',
      'done-1',
      'done-2',
      'done-3',
    ]);
  });

  it('never mutates its input', () => {
    const rows = [task('a', { status: 'completed' }), task('b')];
    const before = titles(rows);

    sinkCompleted(rows, DAY);

    expect(titles(rows)).toEqual(before);
  });

  it('returns the SAME array when the split is trivial', () => {
    // The convention sortRows('default') sets. A list with nothing finished —
    // the overwhelmingly common case — is already in this order, and a fresh
    // array per render would be a copy for nothing.
    const nothingDone = [task('a'), task('b')];
    const allDone = [task('a', { status: 'completed' }), task('b', { status: 'completed' })];

    expect(sinkCompleted(nothingDone, DAY)).toBe(nothingDone);
    expect(sinkCompleted(allDone, DAY)).toBe(allDone);
  });

  it('sinks a habit ticked TODAY without sinking it tomorrow', () => {
    const rows = [
      habit('Stretch', { completedDates: [DAY] }),
      habit('Journal'),
    ];

    expect(titles(sinkCompleted(rows, DAY))).toEqual(['Journal', 'Stretch']);
    expect(titles(sinkCompleted(rows, OTHER_DAY))).toEqual(['Stretch', 'Journal']);
  });
});

describe('orderRows — Ordering first, then the sink', () => {
  it('lets Title A–Z order each half without lifting a finished row over an open one', () => {
    // The composition order is the whole point. Sink first and sort second and
    // 'Apple' climbs back above 'Zebra' — the behaviour undone by an ordering
    // the user picked for an unrelated reason.
    const rows = [
      task('Zebra'),
      task('Apple', { status: 'completed' }),
      task('Mango'),
      task('Banana', { status: 'completed' }),
    ];

    expect(titles(orderRows(rows, 'title', DAY))).toEqual(['Mango', 'Zebra', 'Apple', 'Banana']);
  });

  it('sinks under Default too, keeping the derivation order in each half', () => {
    const rows = [task('one', { status: 'completed' }), task('two'), task('three')];

    expect(titles(orderRows(rows, 'default', DAY))).toEqual(['two', 'three', 'one']);
  });

  it('honours the dateless null the braindump passes', () => {
    const rows = [
      habit('Stretch', { completedDates: [DAY] }),
      task('Buy milk', { status: 'completed' }),
      task('Call bank'),
    ];

    // Only the one-shot task moves; the recurring row holds its place.
    expect(titles(orderRows(rows, 'default', null))).toEqual([
      'Stretch',
      'Call bank',
      'Buy milk',
    ]);
  });
});

describe('sinkCompleted — skipped occurrences sink below finished ones', () => {
  it('moves a skipped habit to the foot of its group, under the done rows', () => {
    const rows = [
      habit('skipped', { skippedDates: [DAY], status: 'skipped' }),
      habit('open'),
      habit('done', { completedDates: [DAY], status: 'done' }),
      habit('also open'),
    ];

    expect(titles(sinkCompleted(rows, DAY))).toEqual(['open', 'also open', 'done', 'skipped']);
  });

  it('reads the skip per date, so the same habit stays put on another day', () => {
    const rows = [habit('skipped', { skippedDates: [DAY] }), habit('open')];

    expect(titles(sinkCompleted(rows, OTHER_DAY))).toEqual(['skipped', 'open']);
  });

  it('leaves the braindump (no date) alone, where no skipped strip is drawn', () => {
    const rows = [habit('skipped', { skippedDates: [DAY] }), habit('open')];

    expect(titles(sinkCompleted(rows, null))).toEqual(['skipped', 'open']);
  });

  it('returns the same array when the skipped row is already last', () => {
    const rows = [habit('open'), habit('skipped', { skippedDates: [DAY] })];

    expect(sinkCompleted(rows, DAY)).toBe(rows);
  });

  it('keeps a just-skipped row in place while the hold says it is still open', () => {
    const rows = [habit('skipped', { skippedDates: [DAY] }), habit('open')];

    expect(titles(sinkCompleted(rows, DAY, () => false))).toEqual(['skipped', 'open']);
  });
});
