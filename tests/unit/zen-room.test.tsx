import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

/**
 * The room, rendered.
 *
 * lib/zen.ts covers the ordering and the hero pick as pure functions; what
 * cannot be tested there is the one thing most likely to be got wrong twice —
 * WHICH DAY a tick lands on. Zen always shows today while the rest of the app
 * follows the navigable `selectedDate`, and the store's completion actions
 * default to `selectedDate` when handed no date. So a tick in here that forgot
 * to name today would silently mark a day the user is not looking at, on a
 * surface whose whole claim is that it shows now.
 *
 * These drive the real component against the real stores, with `selectedDate`
 * parked on a different day on purpose.
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

import { ZenRoom } from '@/components/zen/zen-room';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { toDateStr } from '@/lib/recurrence';
import type { Item } from '@/lib/planner-types';

const TZ = 'UTC';
/** Today, resolved the same way the room resolves it. */
const TODAY = toDateStr(new Date(), TZ);
/**
 * The hour these run at, pinned.
 *
 * `pickHero` takes `nowMin`, so which row holds the hero depends on the WALL
 * CLOCK. While the clock sits INSIDE the 19:00 task below, that task is the
 * current thing and takes the hero from the unscheduled habit — inverting these
 * assertions. Outside that window, on either side of it, they pass.
 *
 * So unpinned this suite was green all day and red for one stretch of the
 * evening, which is the worst shape a flake can have: it looks like whatever
 * change happened to be in flight at the time. Verified by pinning to 19:10,
 * which reproduces it exactly. 08:00 puts every fixture time in the future,
 * which is the state the assertions are written against.
 */
const PINNED_NOW = new Date(`${TODAY}T08:00:00Z`);
/** Somewhere the user has navigated to that is emphatically not today. */
const ELSEWHERE = new Date('2027-03-09T12:00:00Z');
const ELSEWHERE_STR = '2027-03-09';

const HABIT: Item = {
  type: 'habit',
  id: 'h-pages',
  title: 'Morning pages',
  project: 'Growth',
  status: 'pending',
  streak: 4,
  completedDates: [],
  skippedDates: [],
  repeatFrequency: 'daily',
  timeBucket: 'anytime',
  order: 0,
  isScheduled: false,
} as unknown as Item;

const TIMED_TASK: Item = {
  type: 'task',
  id: 't-dinner',
  title: 'Dinner with Sam',
  status: 'pending',
  isScheduled: false,
  order: 0,
  startDate: TODAY,
  timeBucket: 'evening',
  startTime: '19:00',
} as unknown as Item;

function seed(items: Item[]) {
  usePlannerStore.setState({
    userId: 'user-1',
    userTimezone: TZ,
    items,
    // The projections are derived off `items` by the store's own actions, so a
    // direct setState has to write all three or the views read an empty day.
    tasks: items.filter((i) => i.type !== 'habit') as never,
    habits: items.filter((i) => i.type === 'habit') as never,
    // The point of the fixture: the app is looking at another day entirely.
    selectedDate: ELSEWHERE,
    projects: [],
    routines: [],
    seasons: [],
    goals: [],
    showCompletedTasks: true,
    showPausedOnGrid: false,
  } as never);
  useViewStore.setState({ zenOpen: true });
}

beforeEach(() => {
  // Only Date is faked: `useNowMinutes` and testing-library both want real
  // timers, and faking those turns a clock pin into a hang.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(PINNED_NOW);
  seed([HABIT, TIMED_TASK]);
});

afterEach(() => {
  cleanup();
  useViewStore.setState({ zenOpen: false, zenMoving: false });
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('the Zen room', () => {
  it('renders nothing at all while the flag is off', () => {
    useViewStore.setState({ zenOpen: false });
    const { container } = render(<ZenRoom />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows today, not the day the rest of the app is parked on', () => {
    render(<ZenRoom />);
    // The unscheduled habit takes the hero; the 19:00 task waits in the ledger.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Morning pages');
    expect(screen.getByText('Dinner with Sam')).toBeInTheDocument();
  });

  it('ticks TODAY even though selectedDate is a different day', () => {
    render(<ZenRoom />);
    fireEvent.click(screen.getByRole('button', { name: 'Complete Morning pages' }));

    const habit = usePlannerStore
      .getState()
      .items.find((i) => i.id === 'h-pages') as unknown as { completedDates: string[] };

    expect(habit.completedDates).toContain(TODAY);
    // The bug this test exists for: the store defaults an omitted date to
    // selectedDate, so a tick that forgot to name today would land here.
    expect(habit.completedDates).not.toContain(ELSEWHERE_STR);
  });

  it('hands the hero to the next open row once the first is ticked', () => {
    render(<ZenRoom />);
    fireEvent.click(screen.getByRole('button', { name: 'Complete Morning pages' }));
    // No stored cursor: the ticked row simply leaves the open set and the next
    // one wins the same test.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Dinner with Sam');
  });

  it('says so plainly when there is nothing left', () => {
    seed([]);
    render(<ZenRoom />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent("That's the day.");
  });

  it('leaves the room on Escape', () => {
    render(<ZenRoom />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useViewStore.getState().zenOpen).toBe(false);
  });

  it('keeps the room when something else already handled that Escape', () => {
    render(<ZenRoom />);
    // A Radix layer closing itself in the capture phase marks the event handled;
    // the same keypress must not also dump the user out of Zen.
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);
    expect(useViewStore.getState().zenOpen).toBe(true);
  });

  it('leaves the room from the escape hint too', () => {
    render(<ZenRoom />);
    fireEvent.click(screen.getByRole('button', { name: /back to the planner/i }));
    expect(useViewStore.getState().zenOpen).toBe(false);
  });

  it('keeps a skipped occurrence out of the room entirely', () => {
    const skippedHabit = {
      ...HABIT,
      id: 'h-skipped',
      title: 'Stretch',
      skippedDates: [TODAY],
    } as unknown as Item;
    seed([skippedHabit, TIMED_TASK]);
    render(<ZenRoom />);

    // Not the hero, not in the ledger, and above all not tickable: a tick on a
    // skipped habit clears the skip, and an occurrence the user deliberately
    // answered would go back to being an open loop the settlement charges for.
    expect(screen.queryByText('Stretch')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stretch/ })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Dinner with Sam');
  });

  it('points the rest of the app at today, so ⌘K writes the day on screen', () => {
    // The palette's item commands resolve against selectedDate by design. While
    // the room is open the day on screen IS today, so leaving selectedDate on a
    // browsed Tuesday would have ⌘K → Complete mark a day nobody can see.
    expect(toDateStr(usePlannerStore.getState().selectedDate, TZ)).toBe(ELSEWHERE_STR);
    render(<ZenRoom />);
    expect(toDateStr(usePlannerStore.getState().selectedDate, TZ)).toBe(TODAY);
  });

  it('waits for the room to finish flying in before moving the planner to today', () => {
    // While the entry animation runs, the planner is still on screen around it;
    // re-pointing it then would jump the grid under the user's eyes.
    useViewStore.setState({ zenMoving: true });
    render(<ZenRoom />);
    expect(toDateStr(usePlannerStore.getState().selectedDate, TZ)).toBe(ELSEWHERE_STR);
    act(() => useViewStore.setState({ zenMoving: false }));
    expect(toDateStr(usePlannerStore.getState().selectedDate, TZ)).toBe(TODAY);
  });

  it('offers no fold at all when the day is short enough to show whole', () => {
    // The veil used to paint over a ledger that was not overflowing, washing out
    // the only rows there were.
    render(<ZenRoom />);
    expect(screen.queryByRole('button', { name: /the day/i })).not.toBeInTheDocument();
  });

  it('shows a multi-count habit its running tally rather than a dead click', () => {
    const glasses = {
      ...HABIT,
      id: 'h-water',
      title: 'Drink water',
      timesPerDay: 3,
      dailyCounts: { [TODAY]: 1 },
    } as unknown as Item;
    seed([glasses]);
    render(<ZenRoom />);
    expect(screen.getByText('1/3')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Complete Drink water' }));
    // Still not "done" — but the room now says 2/3 instead of looking inert.
    expect(screen.getByText('2/3')).toBeInTheDocument();
  });

  /*
   * A reload with Zen open lands straight in the room, which has no skeleton.
   * While the planner shows the look-only preview (lib/planner-snapshot.ts) the
   * rows are this browser's cache: a tick there would write on stale state
   * (Beeminder included), so <main> is inert — and only <main>, so the way out
   * still works. And before there is anything to show at all, the room claims
   * nothing about the day.
   */
  describe('while the planner is not loaded', () => {
    // seed() writes neither field; leave the rest of the suite settled.
    afterEach(() => usePlannerStore.setState({ isLoading: false, isPreview: false }));

    it('makes <main> inert while previewing, and keeps the exit live', () => {
      usePlannerStore.setState({ isLoading: true, isPreview: true });
      const { container } = render(<ZenRoom />);
      const main = screen.getByRole('main');
      expect(main).toHaveAttribute('inert');
      // The cached day is shown, just not actionable.
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Morning pages');
      expect(screen.getByRole('button', { name: 'Complete Morning pages' }).closest('[inert]')).toBe(main);

      const exit = screen.getByRole('button', { name: /back to the planner/i });
      expect(exit.closest('[inert]')).toBeNull();
      expect(container.querySelector('.zen-room')).not.toHaveAttribute('inert');
      expect(container.querySelector('.zen-room')).toHaveAttribute('data-settle-scope', 'zen');
      fireEvent.click(exit);
      expect(useViewStore.getState().zenOpen).toBe(false);
    });

    it('carries the sync line while previewing — on the room, outside the inert <main>', () => {
      usePlannerStore.setState({ isLoading: true, isPreview: true });
      const { container } = render(<ZenRoom />);
      const line = screen.getByTestId('planner-sync-line');
      expect(line.parentElement).toBe(container.querySelector('.zen-room'));
      expect(line.closest('[inert]')).toBeNull();
      expect(line).toHaveAttribute('aria-hidden', 'true');

      act(() => usePlannerStore.setState({ isLoading: false, isPreview: false }));
      // Landed inside the line's 300ms delay: it was never visible, so no sweep.
      expect(screen.queryByTestId('planner-sync-line')).toBeNull();
    });

    it('lifts inert when the fresh data lands', () => {
      usePlannerStore.setState({ isLoading: true, isPreview: true });
      render(<ZenRoom />);
      act(() => usePlannerStore.setState({ isLoading: false, isPreview: false }));
      expect(screen.getByRole('main')).not.toHaveAttribute('inert');
    });

    it("says nothing — no \"That's the day.\", no \"Clear\" — before anything is visible", () => {
      seed([]);
      usePlannerStore.setState({ isLoading: true, isPreview: false });
      render(<ZenRoom />);
      expect(screen.queryByText("That's the day.")).toBeNull();
      expect(screen.queryByText('Clear')).toBeNull();
      expect(screen.getByRole('main')).not.toHaveAttribute('inert');

      // The fresh, empty day: now it is a claim worth making.
      act(() => usePlannerStore.setState({ isLoading: false }));
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent("That's the day.");
      expect(screen.getByText('Clear')).toBeInTheDocument();
    });

    it('keys the hero and the rows for the settle', () => {
      const { container } = render(<ZenRoom />);
      // Its rows glide unlifted: they sit on the frost and under the folded
      // ledger's veil, neither an ancestor, so a lift's ground would knock the
      // frost out of a moving row and its z-index carry it over the veil.
      expect(container.querySelector('.zen-room')).toHaveAttribute('data-settle-lift', 'off');
      expect(screen.getByRole('heading', { level: 1 })).toHaveAttribute(
        'data-settle-key',
        'zen:hero:h-pages'
      );
      expect(container.querySelector('[data-settle-key="zen:hero"]')).toHaveAttribute(
        'data-settle-role',
        'frame'
      );
      expect(container.querySelector('[data-settle-key="zen:ledger"]')).toHaveAttribute(
        'data-settle-role',
        'frame'
      );
      expect(screen.getByText('Dinner with Sam').closest('li')).toHaveAttribute(
        'data-settle-key',
        'zen:t-dinner'
      );
      // A ledger row says which item it is, as every planner row does…
      expect(screen.getByText('Dinner with Sam').closest('li')).toHaveAttribute(
        'data-item-id',
        't-dinner'
      );
      // …and the hero deliberately does not: the settle pairs unmatched rows by
      // id, and a hero that changed on landing leaves and arrives in place
      // rather than sliding in from a ledger line's slot.
      expect(screen.getByRole('heading', { level: 1 })).not.toHaveAttribute('data-item-id');
    });
  });

  it('unfolds the rest of the day', () => {
    seed([
      HABIT,
      TIMED_TASK,
      { ...TIMED_TASK, id: 't-2', title: 'Two', startTime: '20:00' } as unknown as Item,
      { ...TIMED_TASK, id: 't-3', title: 'Three', startTime: '21:00' } as unknown as Item,
      { ...TIMED_TASK, id: 't-4', title: 'Four', startTime: '22:00' } as unknown as Item,
    ]);
    render(<ZenRoom />);
    const chevron = screen.getByRole('button', { name: 'Show the rest of the day' });
    expect(chevron).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(chevron);
    expect(
      screen.getByRole('button', { name: 'Fold the day away' })
    ).toHaveAttribute('aria-expanded', 'true');
  });
});
