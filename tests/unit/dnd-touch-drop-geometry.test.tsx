import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { DndContext, closestCenter } from '@dnd-kit/core';
import type { ClientRect } from '@dnd-kit/core';

/**
 * Where a drop LANDS once the timed slivers stop being offered to a finger.
 *
 * ## The bug this exists to prevent
 *
 * `closestCenter` compares CENTRES, not containment — `tests/e2e/helpers/dnd.ts`
 * says so, and `centerOfRectangle` in dnd-kit's source is the whole of it. So
 * the set of droppables a card mounts decides which regions of that card belong
 * to it at all. The 8px gap boxes between timed rows are what give a bucket's
 * timed spine a centre every ~44px; the card's other droppables (the bare
 * bucket, the untimed section) have centres at or above the card's middle.
 *
 * Withhold the gap boxes from touch and mount NOTHING in their place, and the
 * lowest centre a tall Morning card owns is its own midpoint. Everything below
 * the midpoint between that and Afternoon's centre then resolves to AFTERNOON —
 * a silent wrong-bucket write, in the view whose entire job is bucket placement.
 * The band opens once the dragged-over card is taller than the next card plus
 * two gaps (about four timed rows) and grows without bound after that.
 *
 * That is why the touch rule in lib/dnd/drop-targets.ts is a SUBSTITUTION: the
 * same box mounts, carrying `spine:{bucket}:{above|below}:{id}` instead of
 * `scheduled:{bucket}:{before|after}:{ref}`. Same rect, same centre, different
 * command — "assign this bucket, no time" instead of "schedule at that row's
 * time ±30 min".
 *
 * ## What is real here and what is modelled
 *
 * REAL: the rendered `DayBuckets`, so the set of droppable ids under test is
 * the one the view actually mounts for each input; dnd-kit's own
 * `closestCenter`; and `resolveDrop`, so the assertion is about the COMMAND, not
 * about an id.
 *
 * MODELLED: the rects. jsdom has no layout — every `getBoundingClientRect` is
 * zeroes — so heights come from the table below and boxes are stacked in
 * document order. The numbers are ordinary (44px rows, 8px gaps, 16px card
 * gaps); nothing in the conclusion depends on their exact values, because the
 * third test re-runs the same model with the spine ids removed and shows the
 * band appear. A model that could not produce the bug could not pin the fix.
 */

const ROW_H = 44;
const GAP_H = 8;
const TRAY_H = 40;
const CAPTION_H = 22;
const CARD_GAP = 16;
const MIN_SECTION_H = 24;
const CARD_X = 24;
const CARD_W = 700;
const FIRST_CARD_TOP = 100;

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
import { resolveDrop } from '@/lib/dnd/handle-drag-end';
import { dropTargetKind } from '@/lib/dnd/drop-targets';
import type { DragInput } from '@/lib/dnd/sensors';
import { useDragStore } from '@/lib/drag-store';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { EMPTY_VIEW_FILTERS } from '@/lib/filters';
import type { Task, TimeBucket } from '@/lib/planner-types';

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

/** A tall Morning (N timed rows + one untimed) above an empty Afternoon. */
function fixtureTasks(timed: number): Task[] {
  return [
    task({ id: 'untimed', title: 'Untimed thing' }),
    ...Array.from({ length: timed }, (_, i) =>
      task({
        id: `t${i}`,
        title: `Timed ${i}`,
        startTime: `0${5 + Math.floor(i / 2)}:${i % 2 ? '30' : '00'}`,
      })
    ),
  ];
}

function seed(timed: number, input: DragInput) {
  const tasks = fixtureTasks(timed);
  usePlannerStore.setState({
    userId: 'user-1',
    userTimezone: TZ,
    selectedDate: DATE,
    navDirection: null,
    tasks,
    habits: [],
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
  useDragStore.getState().startDrag('untimed', input);
}

/* ------------------------------------------------------------------ *
 * The layout model
 * ------------------------------------------------------------------ */

type Box = { id: string; top: number; height: number };

/** Height of one leaf, or null if the node is a container to recurse into. */
function leafHeight(el: Element): number | null {
  if (el.getAttribute('data-testid') === 'item-card') return ROW_H;
  const id = el.getAttribute('data-dnd-id');
  if (!id) return null;
  const kind = dropTargetKind(id);
  if (kind === 'relative-time' || kind === 'bucket-spine') return GAP_H;
  if (kind === 'bucket-timed') return TRAY_H;
  return null;
}

/** Stack an element's subtree from `top`, collecting every droppable's rect. */
function layout(el: Element, top: number, boxes: Box[]): number {
  const leaf = leafHeight(el);
  const id = el.getAttribute('data-dnd-id');
  if (leaf !== null) {
    if (id) boxes.push({ id, top, height: leaf });
    return leaf;
  }
  let y = top;
  for (const child of el.children) y += layout(child, y, boxes);
  const height = Math.max(y - top, id ? MIN_SECTION_H : 0);
  if (id) boxes.push({ id, top, height });
  return height;
}

const rect = (top: number, height: number): ClientRect => ({
  top,
  bottom: top + height,
  left: CARD_X,
  right: CARD_X + CARD_W,
  width: CARD_W,
  height,
});

/** Lay every rendered bucket card out in order, with a gap between cards. */
function measure() {
  const boxes: Box[] = [];
  const cards: Record<string, { top: number; bottom: number }> = {};
  let y = FIRST_CARD_TOP;
  for (const card of document.querySelectorAll('[data-dnd-bucket]')) {
    const bucket = card.getAttribute('data-dnd-bucket')!;
    const before = boxes.length;
    const height = CAPTION_H + layout(card, y + CAPTION_H, boxes);
    // The card wrapper is itself the bare `{bucket}` droppable; `layout` sized
    // it from its children, which excludes the caption strip above them.
    const own = boxes.slice(before).find((b) => b.id === bucket);
    if (own) {
      own.top = y;
      own.height = height;
    }
    cards[bucket] = { top: y, bottom: y + height };
    y += height + CARD_GAP;
  }
  const rects = new Map(boxes.map((b) => [b.id, rect(b.top, b.height)]));
  return { rects, cards };
}

/** What a drop whose dragged row is centred at `y` resolves to. */
function dropAt(
  y: number,
  rects: Map<string, ClientRect>,
  input: DragInput
): { id: string; bucket?: TimeBucket } {
  const collisions = closestCenter({
    active: { id: 'untimed', data: { current: undefined }, rect: { current: { initial: null, translated: null } } } as never,
    collisionRect: rect(y - ROW_H / 2, ROW_H),
    droppableRects: rects,
    droppableContainers: [...rects.keys()].map((id) => ({ id })) as never,
    pointerCoordinates: null,
  });
  const id = String(collisions[0].id);
  const command = resolveDrop('untimed', id, {
    itemType: 'task',
    input,
    selectedDate: DATE,
    userTimezone: TZ,
    getRefTime: () => '09:00',
    inferDropTime: () => '09:30',
  });
  return { id, bucket: command && 'bucket' in command ? command.bucket : undefined };
}

/** Every 4px down the Morning card, which bucket does the drop land in? */
function sweepMorning(rects: Map<string, ClientRect>, card: { top: number; bottom: number }, input: DragInput) {
  const out: { y: number; id: string; bucket?: TimeBucket }[] = [];
  for (let y = card.top + 2; y < card.bottom; y += 4) out.push({ y, ...dropAt(y, rects, input) });
  return out;
}

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
beforeEach(() => vi.clearAllMocks());

/**
 * Sweep the Morning card for one input and return it with its own geometry.
 *
 * Note the two topmost samples of any card belong to the card ABOVE it: two
 * adjacent centres always split their gap, so the first ~8px of a card sit on
 * the far side of the midpoint. That is `closestCenter` being `closestCenter`,
 * it is identical for a mouse, and it is not what this file is about — the
 * assertions below are either input-parity or scoped to the card's lower half,
 * where the sliver's absence is what moves the boundary.
 */
function sweepFor(timed: number, input: DragInput) {
  seed(timed, input);
  renderBuckets();
  const { rects, cards } = measure();
  return { rects, card: cards.morning, sweep: sweepMorning(rects, cards.morning, input) };
}

const lowerHalf = (sweep: ReturnType<typeof sweepMorning>, card: { top: number; bottom: number }) =>
  sweep.filter((s) => s.y > (card.top + card.bottom) / 2);

describe('withholding the sliver does not move where a drop lands', () => {
  it.each([4, 6, 8])('%i timed rows: a finger lands exactly where a cursor does', (timed) => {
    // The claim the whole design rests on, stated as input PARITY rather than
    // against absolute coordinates — and parity with the cursor is parity with
    // main, since main mounted these same boxes for fingers too.
    const mouse = sweepFor(timed, 'pointer');
    cleanup();
    const finger = sweepFor(timed, 'touch');

    expect(finger.card).toEqual(mouse.card);
    expect(finger.sweep.map((s) => s.bucket)).toEqual(mouse.sweep.map((s) => s.bucket));
  });

  it.each([4, 6, 8])('%i timed rows: nothing in the lower half escapes to the next bucket', (timed) => {
    const { sweep, card } = sweepFor(timed, 'touch');

    expect(lowerHalf(sweep, card).filter((s) => s.bucket !== 'morning')).toEqual([]);
    // …and not one of them schedules a TIME: the finger's drop through this
    // region is "assign Morning, untimed", which is the trade Kirby accepted.
    expect(sweep.every((s) => dropTargetKind(s.id) !== 'relative-time')).toBe(true);
  });

  it('shows the band this design avoids: delete the gap boxes instead of substituting', () => {
    // Not a test of the app — a test of the MODEL, and of the reasoning. It
    // re-runs the same sweep with the spine rects removed, i.e. the "just don't
    // mount anything for touch" design, and shows the bottom of the card
    // resolving to the next bucket. Without this, the sweeps above could pass
    // for a model that cannot express the failure at all.
    //
    // It deletes the RECTS and not the boxes, so it models the collision
    // consequence without the reflow a real no-mount design would also cause
    // (the card would shrink by 8px per gap). Measured bands at the bottom of
    // Morning: 44px at 4 timed rows, 68px at 6, 96px at 8 — a lower bound.
    const { rects, card } = sweepFor(8, 'touch');
    for (const id of [...rects.keys()]) {
      if (dropTargetKind(id) === 'bucket-spine') rects.delete(id);
    }

    const stray = lowerHalf(sweepMorning(rects, card, 'touch'), card).filter(
      (s) => s.bucket !== 'morning'
    );
    expect(stray.length).toBeGreaterThan(0);
    expect(stray.every((s) => s.bucket === 'afternoon')).toBe(true);
    // The band reaches the bottom edge — the region a user reads as "just under
    // the last timed row in Morning".
    expect(stray[stray.length - 1].y).toBeGreaterThan(card.bottom - 8);
  });
});
