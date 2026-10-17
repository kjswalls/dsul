import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
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
 * In the day (memory/plans/power-mode.md, the polish round): while doing stuff,
 * the current item opens in today's free stretch on the schedule, the header's
 * up-next card and the list's card stand down to a notched row, done rows leave
 * the walked lanes for a count, and the walk goes on into today when do it now
 * is through.
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
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));

import { Braindump } from '@/components/sidebar/braindump';
import { DoStuffToday } from '@/components/sidebar/do-stuff-today';
import { DoStuffSlot } from '@/components/sidebar/do-stuff-slot';
import { SprintRing } from '@/components/sidebar/sprint-ring';
import { usePlannerStore } from '@/lib/planner-store';
import { doneNext, skipNext, startSprint, useDeskHost, useDoStuffStore } from '@/lib/do-stuff';
import { usePrepPacksStore } from '@/lib/prep-packs-store';
import { useAgentsStore } from '@/lib/agents-store';
import { useViewStore } from '@/lib/view-store';
import { useKeyboardShortcutsStore } from '@/lib/keyboard-shortcuts-store';
import { EMPTY_VIEW_FILTERS } from '@/lib/filters';
import type { Item } from '@/lib/planner-types';
import type { WalkBlock } from '@/lib/do-stuff-walk';
import { enableExtensions } from './support/extensions';
import { EXT_DO_STUFF } from '@/lib/extension-registry';

const task = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    type: 'task',
    id,
    title: `Task ${id}`,
    status: 'pending',
    isScheduled: false,
    order: 0,
    ...extra,
  }) as unknown as Item;

function seed(items: Item[]) {
  usePlannerStore.setState({
    userId: 'user-1',
    isLoading: false,
    error: null,
    userTimezone: 'UTC',
    items,
    tasks: items as never,
    habits: [],
    projects: [],
    routines: [],
    seasons: [],
    goals: [],
  });
  useViewStore.setState({
    braindumpGroupBy: 'none',
    braindumpSortBy: 'default',
    braindumpFilters: EMPTY_VIEW_FILTERS,
  });
}

const today = new Date().toISOString().slice(0, 10);
const ITEMS = [
  task('a', { title: 'email the landlord', size: 'quick' }),
  task('b', { title: 'call the dentist', size: 'quick' }),
  task('c', { title: 'pick up stamps', size: 'errand' }),
  task('d', { title: 'declutter the garage', size: 'big' }),
  task('e', { title: 'figure out the budget' }),
  task('f', { title: 'zebra' }),
  task('t1', { title: 'water the plants', size: 'errand', startDate: today, isScheduled: true, timeBucket: 'morning' }),
];

// 11:10, with lunch at 12:30 and deep work at 15:00.
const NOW = 670;
const BLOCKS: WalkBlock[] = [
  { title: 'Lunch with Ana', startMin: 750, duration: 60 },
  { title: 'Deep work', startMin: 900, duration: 90 },
];

beforeEach(() => {
  enableExtensions(EXT_DO_STUFF);
  useKeyboardShortcutsStore.setState({ overrides: {} });
  useDoStuffStore.getState().stop();
  useDoStuffStore.setState({ missedSeen: [] });
  usePrepPacksStore.setState({ userId: 'user-1', packs: {}, loaded: true, available: true, preparing: {}, tried: {}, error: null });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  useAgentsStore.setState({ agents: [], loaded: false });
});
afterEach(cleanup);

/** `hourPx` is the grid's zoom: a short stretch is a roomy slot only zoomed well in. */
function start(blocks: WalkBlock[] = BLOCKS, hourPx = 120) {
  render(
    <DndContext>
      <Braindump />
      <DoStuffToday />
      <div style={{ position: 'relative' }}>
        <DoStuffSlot blocks={blocks} nowMin={NOW} gridStartHour={8} gridEndHour={20} hourPx={hourPx} />
      </div>
    </DndContext>
  );
  fireEvent.click(screen.getByTestId('do-stuff-start'));
}

const nowLane = () => [...useDoStuffStore.getState().marks].filter(([, m]) => m.lane === 'now').map(([id]) => id);

describe('in the day: the current item on today\'s schedule', () => {
  it('says a block is coming five minutes before it', () => {
    seed(ITEMS);
    start([{ title: 'Standup', startMin: NOW + 3, duration: 15 }, ...BLOCKS]);
    // Three minutes is a sliver: the slot is one line, the heads-up beside the title.
    expect(screen.getByTestId('do-stuff-slot').dataset.compact).toBe('true');
    expect(screen.getByTestId('do-stuff-heads-up').textContent).toBe('Standup in 3m');
  });

  it('offers a missed block once: fit it in moves it to now at its length, let it go writes nothing', () => {
    const missed = task('m1', { title: 'Call the bank', startDate: today, isScheduled: true, startTime: '10:00', timeBucket: 'morning' });
    seed([...ITEMS, missed]);
    const blocks: WalkBlock[] = [{ title: 'Call the bank', startMin: 600, duration: 30, id: 'm1', movable: true }, ...BLOCKS];
    start(blocks);
    expect(screen.getByTestId('do-stuff-missed').textContent).toContain('missed Call the bank?');
    act(() => {
      fireEvent.click(screen.getByTestId('do-stuff-missed-fit'));
    });
    const moved = usePlannerStore.getState().items.find((i) => i.id === 'm1') as unknown as Record<string, unknown>;
    expect(moved.startTime).toBe('11:10');
    expect(moved.duration).toBe(30);
    expect(useDoStuffStore.getState().missedSeen).toEqual(['m1']);
    expect(screen.queryByTestId('do-stuff-missed')).toBeNull();
  });

  it('shortens a fitted block to the gap before the next block, and offers only "let it go" under ten minutes', () => {
    const missed = task('m1', { title: 'Call the bank', startDate: today, isScheduled: true, startTime: '10:00', timeBucket: 'morning' });
    seed([...ITEMS, missed]);
    const bank: WalkBlock = { title: 'Call the bank', startMin: 600, duration: 30, id: 'm1', movable: true };
    // 11:10 with lunch at 11:30 (zoomed in enough for the offer): twenty minutes, not thirty.
    start([bank, { title: 'Lunch', startMin: 690, duration: 60 }], 300);
    act(() => {
      fireEvent.click(screen.getByTestId('do-stuff-missed-fit'));
    });
    const moved = usePlannerStore.getState().items.find((i) => i.id === 'm1') as unknown as Record<string, unknown>;
    expect(moved).toMatchObject({ startTime: '11:10', duration: 20 });
    cleanup();
    // Eight minutes before lunch: nothing worth fitting, so no "fit it in".
    useDoStuffStore.getState().stop();
    useDoStuffStore.setState({ missedSeen: [] });
    start([bank, { title: 'Lunch', startMin: NOW + 8, duration: 60 }], 800);
    expect(screen.getByTestId('do-stuff-missed')).toBeTruthy();
    expect(screen.queryByTestId('do-stuff-missed-fit')).toBeNull();
    expect(screen.getByTestId('do-stuff-missed-let-go')).toBeTruthy();
  });

  it('asks about fitting in only where the shared reschedule gate allows a move', () => {
    // Inside a project block: reschedule is not offered, so fit it in writes nothing, and the question is still answered.
    const missed = task('m1', { title: 'Call the bank', startDate: today, isScheduled: true, startTime: '10:00', timeBucket: 'morning', inProjectBlock: true });
    seed([...ITEMS, missed]);
    start([{ title: 'Call the bank', startMin: 600, duration: 30, id: 'm1', movable: true }, ...BLOCKS]);
    act(() => {
      fireEvent.click(screen.getByTestId('do-stuff-missed-fit'));
    });
    const kept = usePlannerStore.getState().items.find((i) => i.id === 'm1') as unknown as Record<string, unknown>;
    expect(kept.startTime).toBe('10:00');
    expect(useDoStuffStore.getState().missedSeen).toEqual(['m1']);
  });

  it('asks about missed blocks once a run: answering one answers the rest', () => {
    seed(ITEMS);
    start([
      { title: 'Call the bank', startMin: 600, duration: 30, id: 'm1', movable: true },
      { title: 'Gym', startMin: 640, duration: 20, id: 'm2', movable: true },
      ...BLOCKS,
    ]);
    // The latest is offered; letting it go takes the earlier one with it.
    expect(screen.getByTestId('do-stuff-missed').textContent).toContain('missed Gym?');
    act(() => {
      fireEvent.click(screen.getByTestId('do-stuff-missed-let-go'));
    });
    expect(screen.queryByTestId('do-stuff-missed')).toBeNull();
    expect([...useDoStuffStore.getState().missedSeen].sort()).toEqual(['m1', 'm2']);
  });

  it('says only "<block> in 3m" when the stretch waits on a block that is on: the user is in it, not here', () => {
    seed(ITEMS);
    // Standup is on until 11:40 and lunch starts in 3m, over it: the free stretch
    // starts after both, roomy, and the heads-up names lunch without "wrap up here".
    start([
      { title: 'Standup', startMin: 660, duration: 40 },
      { title: 'Lunch with Ana', startMin: NOW + 3, duration: 60 },
      { title: 'Deep work', startMin: 900, duration: 90 },
    ]);
    expect(screen.getByTestId('do-stuff-slot').dataset.compact).toBeUndefined();
    expect(screen.getByTestId('do-stuff-heads-up').textContent).toBe('Lunch with Ana in 3m');
    cleanup();
    useDoStuffStore.getState().stop();
    // Free now, and zoomed in enough for a roomy slot: it says where to wrap up.
    start([{ title: 'Lunch with Ana', startMin: NOW + 3, duration: 60 }, { title: 'Deep work', startMin: 900, duration: 600 }], 2000);
    expect(screen.getByTestId('do-stuff-slot').dataset.compact).toBeUndefined();
    expect(screen.getByTestId('do-stuff-heads-up').textContent).toBe('Lunch with Ana in 3m · wrap up here');
  });

  it("lets a missed block go, and doesn't ask about a habit or a series", () => {
    seed(ITEMS);
    start([
      { title: 'Stretch', startMin: 540, duration: 15, id: 'h1', movable: false },
      { title: 'Call the bank', startMin: 600, duration: 30, id: 'm1', movable: true },
      ...BLOCKS,
    ]);
    expect(screen.getByTestId('do-stuff-missed').textContent).toContain('Call the bank');
    act(() => {
      fireEvent.click(screen.getByTestId('do-stuff-missed-let-go'));
    });
    expect(screen.queryByTestId('do-stuff-missed')).toBeNull();
    expect(useDoStuffStore.getState().missedSeen).toEqual(['m1']);
  });

  it('opens in the free stretch, and the header card and the list card stand down', () => {
    seed(ITEMS);
    start();
    const next = useDoStuffStore.getState().next!;
    const slot = screen.getByTestId('do-stuff-slot');
    expect(slot.textContent).toContain(next.title);
    expect(screen.getByTestId('do-stuff-slot-stretch').textContent).toContain('1h 20m free');
    expect(screen.getByTestId('do-stuff-slot-stretch').textContent).toContain('until Lunch with Ana');
    // From 11:10 at 120px an hour on a grid from 8:00, inset clear of the marker.
    expect(slot.style.top).toBe(`${380 + 6}px`);
    expect(useDoStuffStore.getState().slot).toBe(true);
    expect(screen.queryByTestId('do-stuff-up-next')).toBeNull();
    expect(screen.getByTestId('do-stuff-next').dataset.slim).toBe('true');
    expect(screen.queryByTestId('do-stuff-done')).toBeNull();
  });

  it('done leaves the slot where it is, the row leaves its lane, and the next one rises in', () => {
    seed(ITEMS);
    start();
    const first = useDoStuffStore.getState().next!;
    act(() => {
      fireEvent.click(screen.getByTestId('do-stuff-slot-done'));
    });
    const after = useDoStuffStore.getState().next!;
    expect(after.id).not.toBe(first.id);
    expect(screen.getByTestId('do-stuff-slot').textContent).toContain(after.title);
    expect(screen.queryByText(first.title, { selector: '[data-lane-row] *' })).toBeNull();
    expect(screen.getByTestId('do-stuff-done-here').textContent).toContain('1 done here');
  });

  it('walks on into today once do it now is through', () => {
    seed(ITEMS);
    start();
    act(() => {
      for (const id of nowLane()) useDoStuffStore.getState().move(id, 'leave');
    });
    expect(nowLane()).toEqual([]);
    const next = useDoStuffStore.getState().next;
    expect(next).not.toBeNull();
    expect(useDoStuffStore.getState().marks.get(next!.id)?.lane).toBe('today');
    expect(screen.getByTestId('do-stuff-slot').textContent).toContain(next!.title);
  });

  it('gives the item back to the header card when the day has no free time left', () => {
    seed(ITEMS);
    start([{ title: 'Overnight shift', startMin: 600, duration: 900 }]);
    expect(screen.queryByTestId('do-stuff-slot')).toBeNull();
    expect(useDoStuffStore.getState().slot).toBe(false);
    expect(screen.getByTestId('do-stuff-up-next')).toBeTruthy();
    expect(screen.getByTestId('do-stuff-next').dataset.slim).toBeUndefined();
  });

  it('starts a sprint sized to the gap, and ends it on a tap', () => {
    seed(ITEMS);
    start();
    act(() => {
      fireEvent.click(screen.getByTestId('sprint-start'));
    });
    const sprint = useDoStuffStore.getState().sprint!;
    expect(sprint.until).toBe('Lunch with Ana');
    expect(Math.round((sprint.endsAt - sprint.startedAt) / 60_000)).toBe(75);
    expect(screen.getByTestId('sprint-label').textContent).toBe('1h 15m left · till Lunch with Ana');
    expect(screen.queryByTestId('sprint-start')).toBeNull();
    act(() => {
      fireEvent.click(screen.getByTestId('sprint-ring'));
    });
    expect(useDoStuffStore.getState().sprint).toBeNull();
  });

  it('says time is up, without fuss, and stopping the mode ends it', () => {
    seed(ITEMS);
    start();
    act(() => useDoStuffStore.setState({ sprint: { startedAt: Date.now() - 60_000, endsAt: Date.now() - 1, until: 'Lunch with Ana' } }));
    expect(screen.getByTestId('sprint-label').textContent).toBe("time's up · Lunch with Ana next");
    act(() => useDoStuffStore.getState().stop());
    expect(useDoStuffStore.getState().sprint).toBeNull();
  });

  it('keeps the ring beside the title when the slot is a sliver: a sprint ends exactly then', () => {
    seed(ITEMS);
    // Three minutes to the block: one line.
    start([{ title: 'Lunch with Ana', startMin: NOW + 3, duration: 60 }, ...BLOCKS.slice(1)]);
    expect(screen.getByTestId('do-stuff-slot').dataset.compact).toBe('true');
    act(() => useDoStuffStore.setState({ sprint: { startedAt: Date.now() - 60_000, endsAt: Date.now() + 120_000, until: 'Lunch with Ana' } }));
    const slot = screen.getByTestId('do-stuff-slot');
    expect(slot.contains(screen.getByTestId('sprint-ring'))).toBe(true);
    expect(screen.getByTestId('sprint-label').textContent).toBe('2m left · till Lunch with Ana');
    // The ring takes the heads-up's place: one line says one thing.
    expect(screen.queryByTestId('do-stuff-heads-up')).toBeNull();
    act(() => useDoStuffStore.setState({ sprint: { startedAt: Date.now() - 60_000, endsAt: Date.now() - 1, until: 'Lunch with Ana' } }));
    expect(screen.getByTestId('sprint-label').textContent).toBe("time's up · Lunch with Ana next");
  });
});

describe('a sprint lets go of itself', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('clears once the block it ran to has started: five minutes after time is up', () => {
    startSprint(10, 'Lunch with Ana', 'a');
    vi.advanceTimersByTime(10 * 60_000);
    // At 0 it waits for a tap.
    expect(useDoStuffStore.getState().sprint).not.toBeNull();
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(useDoStuffStore.getState().sprint).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(useDoStuffStore.getState().sprint).toBeNull();
  });

  it('an open 25 clears five minutes after it ends, too', () => {
    startSprint(25, null, 'a');
    vi.advanceTimersByTime(30 * 60_000);
    expect(useDoStuffStore.getState().sprint).toBeNull();
  });

  it('ends with done or skip on the item it was started for, and not on another', () => {
    seed(ITEMS);
    useDoStuffStore.getState().start();
    startSprint(25, null, 'a');
    skipNext('b');
    expect(useDoStuffStore.getState().sprint).not.toBeNull();
    skipNext('a');
    expect(useDoStuffStore.getState().sprint).toBeNull();
    startSprint(25, null, 'b');
    doneNext('b');
    expect(useDoStuffStore.getState().sprint).toBeNull();
    // Its timer went with it: nothing fires later.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops the ring\'s second clock once time is up', () => {
    const now = Date.now();
    useDoStuffStore.setState({ sprint: { startedAt: now - 60_000, endsAt: now + 2_000, until: null } });
    render(<SprintRing />);
    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByTestId('sprint-label').textContent).toBe("time's up");
    expect(vi.getTimerCount()).toBe(0);
  });
});

/** Stands in for the desktop view router, the one view that draws the desk. */
function Host() {
  useDeskHost();
  return null;
}

describe('the slot and the desk', () => {
  it('draws the ⤢ only where a desk can open', () => {
    seed(ITEMS);
    start();
    expect(screen.getByTestId('do-stuff-slot')).toBeTruthy();
    expect(screen.queryByTestId('do-stuff-slot-desk')).toBeNull();
    const { unmount } = render(<Host />);
    expect(screen.getByTestId('do-stuff-slot-desk')).toBeTruthy();
    unmount();
    expect(screen.queryByTestId('do-stuff-slot-desk')).toBeNull();
  });

  it('keeps its stretch line at the desk while a sprint runs: the ring is the desk\'s', () => {
    seed(ITEMS);
    start();
    render(<Host />);
    act(() => {
      fireEvent.click(screen.getByTestId('sprint-start'));
    });
    expect(screen.getByTestId('sprint-ring')).toBeTruthy();
    expect(screen.queryByTestId('do-stuff-slot-stretch')).toBeNull();
    act(() => useDoStuffStore.setState({ desk: true }));
    expect(screen.queryByTestId('sprint-ring')).toBeNull();
    expect(screen.getByTestId('do-stuff-slot-stretch')).toBeTruthy();
    expect(screen.queryByTestId('do-stuff-slot-done')).toBeNull();
  });
});
