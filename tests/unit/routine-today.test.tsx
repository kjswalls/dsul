// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/**
 * A routine as things done regularly, in order (Kirby, 2026-09-27): today's
 * members as a checklist in the routine's own sequence, an optional usual time,
 * and ⌘K "Run …" rows that list routines in the order the day runs them.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/routine/r1',
  useParams: () => ({}),
}));

import { RoutineToday } from '@/components/planner/routine-today';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { resolveCommands, type CommandContext } from '@/lib/commands';
import type { Item, Routine } from '@/lib/planner-types';

// 2026-09-26 is a Saturday.
const TODAY = '2026-09-26';

const habit = (id: string, title: string, extra: Record<string, unknown> = {}): Item =>
  ({
    id,
    type: 'habit',
    title,
    status: 'pending',
    repeatFrequency: 'daily',
    timeBucket: 'morning',
    completedDates: [],
    skippedDates: [],
    streak: 0,
    ...extra,
  }) as unknown as Item;

const pristine = usePlannerStore.getState();

function seed(items: Item[], routine: Routine) {
  usePlannerStore.setState({
    items,
    tasks: [],
    habits: items,
    routines: [routine],
    seasons: [],
    goals: [],
    userTimezone: 'UTC',
    weekStartDay: 'sunday',
    timeFormat: '12h',
    // No user: the store's writes stay local, which is all a render test needs.
    userId: null,
    isLoading: false,
    collectionsAvailable: true,
  } as never);
}

const rowIds = () => screen.getAllByTestId('routine-today-row').map((r) => r.getAttribute('data-item-id'));

beforeEach(() => {
  usePlannerStore.setState(pristine, true);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('RoutineToday', () => {
  const water = habit('h1', 'Water');
  const stretch = habit('h2', 'Stretch');
  // Weekdays only — not on a Saturday, so not on today's list.
  const commute = habit('h3', 'Commute reading', { repeatFrequency: 'weekdays' });
  const morning: Routine = { id: 'r1', name: 'Morning', itemIds: ['h2', 'h1', 'h3'] };

  it("lists today's members in the routine's order, not the store's", () => {
    seed([water, stretch, commute], morning);
    render(<RoutineToday routine={morning} />);
    expect(rowIds()).toEqual(['h2', 'h1']);
  });

  it('calls out the first open member as next, and counts how far through you are', () => {
    seed([water, habit('h2', 'Stretch', { completedDates: [TODAY] }), commute], morning);
    render(<RoutineToday routine={usePlannerStore.getState().routines[0]} />);
    const rows = screen.getAllByTestId('routine-today-row');
    expect(rows[0].getAttribute('data-state')).toBe('done');
    expect(rows[1].hasAttribute('data-next')).toBe(true);
    expect(screen.getByTestId('routine-today-summary').textContent).toBe('1 of 2 done');
  });

  it('ticks through the same verb as the console row, for today', () => {
    seed([water, stretch, commute], morning);
    render(<RoutineToday routine={morning} />);
    const first = screen.getAllByTestId('routine-today-row')[0];
    fireEvent.click(within(first).getByTestId('routine-today-tick'));
    const h2 = usePlannerStore.getState().items.find((i) => i.id === 'h2') as unknown as {
      completedDates: string[];
    };
    expect(h2.completedDates).toContain(TODAY);
  });

  it('says it is through once nothing is left open', () => {
    seed(
      [habit('h1', 'Water', { completedDates: [TODAY] }), habit('h2', 'Stretch', { skippedDates: [TODAY] }), commute],
      morning
    );
    render(<RoutineToday routine={morning} />);
    expect(screen.getByTestId('routine-today-finished')).toBeTruthy();
    expect(screen.getByTestId('routine-today-summary').textContent).toBe('1 of 2 done · 1 skipped');
  });

  it('lists nothing while the routine is paused — the grid lists nothing either', () => {
    const paused = { ...morning, pausedAt: '2026-09-20T08:00:00Z' };
    seed([water, stretch, commute], paused);
    render(<RoutineToday routine={paused} />);
    expect(screen.queryAllByTestId('routine-today-row')).toHaveLength(0);
    expect(screen.getByTestId('routine-today-empty').textContent).toBe('Nothing from Morning is on today.');
  });
});

describe('⌘K Run …', () => {
  const ctx: CommandContext = {
    theme: { resolved: 'light', value: 'light', set: () => {} },
    openChat: () => {},
    userId: 'user-1',
    isMobile: false,
  };

  it('offers one per routine, in the order the day runs them, untimed last', () => {
    usePlannerStore.setState({
      ...pristine,
      collectionsAvailable: true,
      userTimezone: 'UTC',
      routines: [
        { id: 'late', name: 'Wind down', usualTime: '21:30', itemIds: [] },
        { id: 'none', name: 'Whenever', itemIds: [] },
        { id: 'early', name: 'Morning', usualTime: '07:00', itemIds: [] },
      ],
    } as never);
    const runs = resolveCommands(ctx).filter((c) => c.id.startsWith('routine.run.'));
    expect(runs.map((c) => c.label)).toEqual(['Run Morning', 'Run Wind down', 'Run Whenever']);
  });

  it("goes to the routine's page, client-side", () => {
    usePlannerStore.setState({
      ...pristine,
      collectionsAvailable: true,
      routines: [{ id: 'r9', name: 'Morning', itemIds: [] }],
    } as never);
    const navigate = vi.fn();
    resolveCommands(ctx).find((c) => c.id === 'routine.run.r9')!.run({ ...ctx, navigate });
    expect(navigate).toHaveBeenCalledWith('/routine/r9');
  });
});

describe('a saved "program" grouping survives the rename', () => {
  it('reads back as season rather than resetting to none', async () => {
    const persist = (useViewStore as unknown as {
      persist: { getOptions: () => { merge: (p: unknown, c: unknown) => Record<string, unknown> } };
    }).persist;
    const merged = persist
      .getOptions()
      .merge({ canvasGroupBy: 'program', braindumpGroupBy: 'program' }, useViewStore.getState());
    expect(merged.canvasGroupBy).toBe('season');
    expect(merged.braindumpGroupBy).toBe('season');
  });
});
