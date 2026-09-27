import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import type { DragStartEvent } from '@dnd-kit/core';

/**
 * The one drop target a finger is not offered, and what it gets instead
 * (lib/dnd/CONTRACT.md § Not every target is offered to every input).
 *
 * `scheduled:{bucket}:{before|after}:{ref}` is an 8px sliver between two timed
 * rows — a third of WCAG 2.5.8's 24px minimum target size, on the input with
 * the coarsest pointer. Mechanically it is a MOVE like every other drop
 * (`inferDropTime` resolves it as ±30 min from the reference row's own time), so
 * it is not the drag-to-reorder `dnd-no-reorder.test.ts` forbids and it survived
 * that sweep. Kirby then removed it for touch anyway, with the cost accepted: on
 * a phone there is no "put this just before that one" — you drop the row in the
 * bucket and set a time.
 *
 * It is a SUBSTITUTION, not a deletion. The same box mounts for a finger
 * carrying `spine:{bucket}:{above|below}:{id}`, which assigns the bucket with no
 * time. Deleting it outright moves where drops LAND — `closestCenter` compares
 * centres, so the bottom of a tall card starts resolving to the next bucket.
 * That is `dnd-touch-drop-geometry.test.tsx`'s subject; this file is about which
 * target is offered and what each one means.
 *
 * ## What has to be true, and why each half needs its own test
 *
 * 1. The rule exists once (`OFFERED_TO`, lib/dnd/drop-targets.ts), and exactly
 *    one of the pair is offered to any given input.
 * 2. The VIEW mounts the right one of the two. This is the view-level rule:
 *    what should this user be OFFERED? Only the view knows what it renders, so
 *    only a mount test can see it.
 * 3. `resolveDrop` answers the grammar-level question — what does this id MEAN
 *    for this input? — over every id shape, for every view that will ever emit
 *    one. Not a backstop for (2): a different question, at a different level.
 * 4. The SHELL actually feeds the real input type in. Without this one, a shell
 *    hard-coding `'pointer'` leaves 1–3 green and ships the sliver to phones —
 *    the exact "load-bearing claim no test held" this repo keeps getting burned
 *    by. Hence `beginDrag` is imported from app-shell rather than rebuilt.
 * 5. Nothing else moved: every OTHER target in the grammar still resolves
 *    identically for a finger and for a cursor.
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
});

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchHabitGroups: vi.fn(async () => []),
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

import { DayBuckets } from '@/components/views/day-buckets';
import { beginDrag } from '@/components/shell/app-shell';
import { dragInputOf, type DragInput } from '@/lib/dnd/sensors';
import { dropTargetKind, isDropTargetOffered, OFFERED_TO } from '@/lib/dnd/drop-targets';
import { resolveDrop, type DropCommand, type DropContext } from '@/lib/dnd/handle-drag-end';
import { useDragStore } from '@/lib/drag-store';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { EMPTY_VIEW_FILTERS } from '@/lib/filters';
import type { Habit, Task } from '@/lib/planner-types';

/* ------------------------------------------------------------------ *
 * 1. The rule, and the parse that feeds it
 * ------------------------------------------------------------------ */

/**
 * Every droppable ID pattern in CONTRACT.md § Droppable IDs — the same list
 * `dnd-no-reorder.test.ts` sweeps, for the same reason: it is the contract
 * restated, so a grammar entry that stops classifying shows up here.
 */
const EVERY_DROP_TARGET = [
  'scheduled:morning:before:task:t2',
  'scheduled:morning:after:habit:h2',
  'spine:morning:above:t2',
  'spine:morning:below:h2',
  'scheduled:afternoon:empty',
  'anytime',
  'morning',
  'afternoon',
  'evening',
  'unscheduled:evening',
  'week:2026-07-06:morning',
  'hour:9',
  'weekhour:2026-07-06:14',
  'week:2026-07-06:anytime',
  'projectblock:Work',
  'sidebar',
] as const;

/** The pair that swaps: one box in the gap, two ids, one per input type. */
const GAP_PAIRS = [
  { sliver: 'scheduled:morning:before:task:t2', spine: 'spine:morning:above:t2' },
  { sliver: 'scheduled:morning:after:habit:h2', spine: 'spine:morning:below:h2' },
] as const;

const RELATIVE_TIME_TARGETS = GAP_PAIRS.map((p) => p.sliver);
const SPINE_TARGETS = GAP_PAIRS.map((p) => p.spine);
/** Every id that is NOT input-restricted — the moves Kirby kept, untouched. */
const RESTRICTED: readonly string[] = [...RELATIVE_TIME_TARGETS, ...SPINE_TARGETS];
const SHARED_TARGETS = EVERY_DROP_TARGET.filter((t) => !RESTRICTED.includes(t));

describe('the offered-to table', () => {
  it('classifies every id in the grammar (an unclassified target would be offered to all)', () => {
    // `isDropTargetOffered` is permissive for an id it cannot parse, on purpose
    // — a new droppable must not vanish for half the users because nobody
    // updated a table. This is the check that keeps that safe: a new grammar
    // entry has to be classified HERE, not discovered in production.
    for (const target of EVERY_DROP_TARGET) {
      expect(dropTargetKind(target), target).not.toBeNull();
    }
  });

  it('withholds the relative-time sliver from touch and nothing else', () => {
    const withheld = Object.entries(OFFERED_TO)
      .filter(([, inputs]) => !inputs.includes('touch'))
      .map(([kind]) => kind);
    expect(withheld).toEqual(['relative-time']);
  });

  it('withholds the spine stand-in from a cursor and nothing else', () => {
    // The other half of the swap. Desktop must not gain a second droppable in
    // the same 8px box: two centres in one gap is a different geometry from the
    // one every desktop drag has today.
    const withheld = Object.entries(OFFERED_TO)
      .filter(([, inputs]) => !inputs.includes('pointer'))
      .map(([kind]) => kind);
    expect(withheld).toEqual(['bucket-spine']);
  });

  it.each(GAP_PAIRS)('offers exactly one of the pair to each input ($sliver)', ({ sliver, spine }) => {
    // The invariant the mount site relies on: never both (double centres),
    // never neither (the wrong-bucket band — see dnd-touch-drop-geometry).
    for (const input of ['pointer', 'touch'] as const) {
      const offered = [sliver, spine].filter((id) => isDropTargetOffered(id, input));
      expect(offered, input).toHaveLength(1);
    }
    expect(isDropTargetOffered(sliver, 'pointer')).toBe(true);
    expect(isDropTargetOffered(spine, 'touch')).toBe(true);
  });

  it('offers every unrestricted kind to both inputs', () => {
    for (const [kind, inputs] of Object.entries(OFFERED_TO)) {
      if (kind === 'relative-time' || kind === 'bucket-spine') continue;
      expect(inputs, kind).toEqual(expect.arrayContaining(['pointer', 'touch']));
    }
  });

  it('reads the sliver ids as relative-time and the empty tray as its own kind', () => {
    for (const target of RELATIVE_TIME_TARGETS) {
      expect(dropTargetKind(target)).toBe('relative-time');
    }
    for (const target of SPINE_TARGETS) {
      expect(dropTargetKind(target)).toBe('bucket-spine');
    }
    // The labelled 40px "Drop here to schedule with time" tray is a different
    // target and stays: it is aimable, and it is not between two rows.
    expect(dropTargetKind('scheduled:afternoon:empty')).toBe('bucket-timed');
    expect(isDropTargetOffered('scheduled:afternoon:empty', 'touch')).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Knowing which input is dragging
 * ------------------------------------------------------------------ */

/** What `NonTouchPointerSensor` hands dnd-kit as the activator event. */
const pointerActivator = (pointerType: string) =>
  ({ pointerType, isPrimary: true, button: 0 }) as unknown as Event;

/** What `TouchSensor` hands it: a touchstart, which has no `pointerType`. */
const touchActivator = () =>
  ({ touches: [{ clientX: 0, clientY: 0 }] }) as unknown as Event;

describe('dragInputOf — per gesture, never per device', () => {
  it('reads a finger from either shape a sensor can produce', () => {
    // The TouchSensor's touchstart carries no pointerType at all, so `touches`
    // is what has to answer. The pointer branch matters too: it keeps the answer
    // correct even if the sensor split above were reverted and a PointerEvent
    // with pointerType 'touch' started reaching drags again.
    expect(dragInputOf(touchActivator())).toBe('touch');
    expect(dragInputOf(pointerActivator('touch'))).toBe('touch');
  });

  it('reads mouse and pen as pointer — a touchscreen laptop keeps its sliver', () => {
    // The failure mode a media query has and this does not: `(pointer: coarse)`
    // on a hybrid laptop answers for the DEVICE, so the machine's mouse would
    // lose a target it can aim perfectly. This answers for the GESTURE.
    expect(dragInputOf(pointerActivator('mouse'))).toBe('pointer');
    expect(dragInputOf(pointerActivator('pen'))).toBe('pointer');
  });

  it('reads an unlabelled or missing activator as pointer, not as touch', () => {
    // Erring the other way would silently disable a desktop capability on any
    // engine that leaves the field blank — the same direction isTouchPointer errs.
    expect(dragInputOf(pointerActivator(''))).toBe('pointer');
    expect(dragInputOf(null)).toBe('pointer');
    expect(dragInputOf({} as Event)).toBe('pointer');
  });
});

describe('the shell records the real input type', () => {
  const dragStart = (activatorEvent: Event) =>
    ({ active: { id: 'row-1' }, activatorEvent }) as unknown as DragStartEvent;

  afterEach(() => useDragStore.getState().endDrag());

  it('puts touch in the drag store when a finger started the drag', () => {
    // The wiring test. Without it, a shell that recorded `'pointer'`
    // unconditionally — or dropped the second argument — would leave every
    // other assertion in this file green while phones kept the sliver.
    beginDrag(dragStart(touchActivator()));
    expect(useDragStore.getState()).toMatchObject({ activeId: 'row-1', input: 'touch' });
  });

  it('puts pointer in it when a mouse did', () => {
    beginDrag(dragStart(pointerActivator('mouse')));
    expect(useDragStore.getState()).toMatchObject({ activeId: 'row-1', input: 'pointer' });
  });

  it('clears both together when the drag ends', () => {
    beginDrag(dragStart(touchActivator()));
    useDragStore.getState().endDrag();
    // A stale `input` outliving `activeId` would decide the NEXT drag's targets.
    expect(useDragStore.getState()).toMatchObject({ activeId: null, input: null });
  });
});

/* ------------------------------------------------------------------ *
 * 3. resolveDrop — the grammar-level rule
 * ------------------------------------------------------------------ */

function ctx(input: DragInput, overrides: Partial<DropContext> = {}): DropContext {
  return {
    itemType: 'task',
    input,
    selectedDate: new Date('2026-07-04T12:00:00Z'),
    userTimezone: 'UTC',
    draggedTaskProject: 'Work',
    getRefTime: () => '10:00',
    inferDropTime: () => '10:30',
    ...overrides,
  };
}

describe('resolveDrop answers per input', () => {
  it.each(RELATIVE_TIME_TARGETS)('a touch drop on %s resolves to nothing', (target) => {
    expect(resolveDrop('t1', target, ctx('touch'))).toBeNull();
    expect(resolveDrop('h1', target, ctx('touch', { itemType: 'habit' }))).toBeNull();
  });

  it.each(RELATIVE_TIME_TARGETS)('a mouse drop on %s still schedules a time', (target) => {
    // Desktop unchanged, stated positively: same command, same inferred time.
    expect(resolveDrop('t1', target, ctx('pointer'))).toEqual({
      kind: 'schedule-task',
      taskId: 't1',
      bucket: 'morning',
      time: '10:30',
      dateStr: '2026-07-04',
    });
    expect(resolveDrop('h1', target, ctx('pointer', { itemType: 'habit' }))).toEqual({
      kind: 'schedule-habit',
      habitId: 'h1',
      bucket: 'morning',
      time: '10:30',
    });
  });

  it.each(SPINE_TARGETS)('a touch drop on %s assigns the bucket with no time', (target) => {
    // The substitution's other half: what the finger gets in that same 8px box.
    // A bucket, not a clock — identical to `unscheduled:{bucket}`, which is the
    // fallback Kirby named when he accepted the cost.
    expect(resolveDrop('t1', target, ctx('touch'))).toEqual({
      kind: 'schedule-task',
      taskId: 't1',
      bucket: 'morning',
      dateStr: '2026-07-04',
    });
    expect(resolveDrop('h1', target, ctx('touch', { itemType: 'habit' }))).toEqual({
      kind: 'assign-habit-bucket',
      habitId: 'h1',
      bucket: 'morning',
    });
    // Whatever else it is, it is not a time write.
    expect(resolveDrop('t1', target, ctx('touch'))).not.toHaveProperty('time');
  });

  it.each(SPINE_TARGETS)('a mouse drop on %s resolves to nothing', (target) => {
    // Desktop never sees this id — the view does not mount it for a cursor —
    // and the grammar says so independently of the view.
    expect(resolveDrop('t1', target, ctx('pointer'))).toBeNull();
  });

  it.each(SHARED_TARGETS)('%s is untouched for a finger — every other move still works', (target) => {
    // Row → bucket, row → day, row → hour slot, row → project block, braindump,
    // and the empty-bucket tray. All of these are moves Kirby explicitly kept on
    // mobile; this is the boundary of the change, asserted rather than assumed.
    const commands = [
      resolveDrop('t1', target, ctx('touch')),
      resolveDrop('h1', target, ctx('touch', { itemType: 'habit' })),
    ].filter((c): c is DropCommand => c !== null);

    expect(commands.length).toBeGreaterThan(0);
    // And identical to what a cursor gets — the gate subtracts one target, it
    // does not rewrite the outcome of any other.
    expect(resolveDrop('t1', target, ctx('touch'))).toEqual(
      resolveDrop('t1', target, ctx('pointer'))
    );
  });
});

/* ------------------------------------------------------------------ *
 * 4. The mount half — the one that changes behaviour
 * ------------------------------------------------------------------ */

const TZ = 'UTC';
const DATE_STR = '2026-08-13';
const DATE = new Date('2026-08-13T12:00:00Z');

const task = (over: Partial<Task>): Task =>
  ({
    status: 'pending',
    isScheduled: true,
    order: 0,
    startDate: DATE_STR,
    timeBucket: 'morning',
    ...over,
  }) as Task;

/** Two TIMED rows in Morning, so the card renders slivers before/after them. */
const tasks: Task[] = [
  task({ id: 'untimed', title: 'Untimed thing' }),
  task({ id: 'nine', title: 'Nine', startTime: '09:00' }),
  task({ id: 'eleven', title: 'Eleven', startTime: '11:00' }),
];
const habits: Habit[] = [];

function seed(input: DragInput) {
  usePlannerStore.setState({
    userId: 'user-1',
    userTimezone: TZ,
    selectedDate: DATE,
    navDirection: null,
    tasks,
    habits,
    items: [...tasks] as never,
    projects: [],
    habitGroups: [],
    routines: [],
    seasons: [],
    showCompletedTasks: true,
    showPausedOnGrid: true,
  });
  useViewStore.setState({
    canvasGroupBy: 'none',
    canvasSortBy: 'default',
    canvasFilters: EMPTY_VIEW_FILTERS,
    typeFilter: 'all',
    collapsedBuckets: [],
    bucketStyle: 'spine',
  });
  // A drag IS in progress — that is the only state in which any of these zones
  // mount at all (CONTRACT.md: the slot opens on activation).
  useDragStore.getState().startDrag('untimed', input);
}

/** Every droppable id the rendered card registered a NODE for. */
const mountedDropIds = () =>
  [...document.querySelectorAll('[data-dnd-id]')].map((el) => el.getAttribute('data-dnd-id')!);

const renderBuckets = () =>
  render(
    <DndContext>
      <DayBuckets activeId="untimed" />
    </DndContext>
  );

afterEach(() => {
  cleanup();
  useDragStore.getState().endDrag();
});
beforeEach(() => seed('pointer'));

describe('Day × Buckets swaps the gap box by input type', () => {
  const SLIVERS = ['scheduled:morning:before:task:nine', 'scheduled:morning:after:task:eleven'];
  const SPINES = ['spine:morning:above:nine', 'spine:morning:below:eleven'];

  it('renders the timed before/after zones during a mouse drag', () => {
    renderBuckets();
    // Guards the guard: if the fixtures stopped producing gap boxes at all, the
    // touch assertions below would pass vacuously.
    expect(mountedDropIds()).toEqual(expect.arrayContaining(SLIVERS));
    expect(mountedDropIds().filter((id) => dropTargetKind(id) === 'bucket-spine')).toEqual([]);
  });

  it('renders NONE of them during a touch drag', () => {
    seed('touch');
    renderBuckets();

    expect(mountedDropIds().filter((id) => dropTargetKind(id) === 'relative-time')).toEqual([]);
  });

  it('renders a spine box in each of those same gaps instead', () => {
    // The substitution, in the DOM. Not decoration: these are the droppable
    // centres that keep a drop at the bottom of a tall card inside its own
    // bucket — dnd-touch-drop-geometry.test.tsx is where that is measured.
    seed('touch');
    renderBuckets();

    expect(mountedDropIds()).toEqual(expect.arrayContaining(SPINES));
    // One box per gap, either way — same count, same places, same rects.
    const gaps = (ids: string[]) =>
      ids.filter((id) => ['relative-time', 'bucket-spine'].includes(dropTargetKind(id) ?? ''));
    const touchGaps = gaps(mountedDropIds());
    cleanup();
    seed('pointer');
    renderBuckets();
    expect(touchGaps).toHaveLength(gaps(mountedDropIds()).length);
  });

  it('keeps every other drop target in the card for touch', () => {
    seed('touch');
    renderBuckets();
    const ids = mountedDropIds();

    // The bucket itself, its untimed section, and the labelled empty-timed tray
    // in the buckets that have no timed rows: none of them is input-restricted,
    // and all of them still mount.
    expect(ids).toEqual(
      expect.arrayContaining([
        'morning',
        'unscheduled:morning',
        'evening',
        'unscheduled:evening',
        'scheduled:evening:empty',
      ])
    );
  });

  it('still renders the timed rows themselves — only the gap box\'s meaning changed', () => {
    seed('touch');
    renderBuckets();
    const morning = document.querySelector('[data-dnd-bucket="morning"]') as HTMLElement;
    expect(morning.textContent).toContain('Nine');
    expect(morning.textContent).toContain('Eleven');
  });

  it('gives the spine box the DOM markers the contract requires of every droppable', () => {
    // CONTRACT.md § DOM markers: data-dnd-id + data-dnd-over on every droppable.
    // `dnd.spec.ts` asserts no droppable is missing them, and a new id that
    // shipped without them would be invisible to every e2e helper.
    seed('touch');
    renderBuckets();
    const box = document.querySelector('[data-dnd-id="spine:morning:above:nine"]')!;
    expect(box.getAttribute('data-dnd-over')).toBe('false');
  });
});
