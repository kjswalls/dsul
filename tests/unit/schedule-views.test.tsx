// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * The container schedule charts, where they are mounted (Kirby, 2026-09-26).
 * Pinned: each surface draws the grid's answer for its container; a draft's
 * preview resolves against the draft; the past never says "missed".
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useParams: () => ({}),
}));
vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  fetchTrashedNames: vi.fn(async () => ({ projects: [] })),
  fetchItemEvents: vi.fn(async () => []),
  getItemEventsAvailable: () => false,
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

import { ContainerDialog } from '@/components/planner/container-dialog';
import { BlockWeekRow, TodayGlyph, useWeekDotsFor } from '@/components/planner/schedule/schedule-views';
import { blockWhen, hasTimeBlock } from '@/lib/project-block';
import { renderHook } from '@testing-library/react';
import { OrganizeConsole } from '@/components/planner/organize/organize-console';
import { usePlannerStore } from '@/lib/planner-store';
import { useUIStore } from '@/lib/ui-store';
import { EXT_GOALS, EXT_ORGANIZE } from '@/lib/extension-registry';
import { enableExtensions } from './support/extensions';
import type { Item } from '@/lib/planner-types';

const TODAY = '2026-09-26'; // Saturday

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

const task = (id: string, title: string, extra: Record<string, unknown> = {}): Item =>
  ({
    id,
    type: 'task',
    title,
    status: 'pending',
    order: 0,
    isScheduled: true,
    timeBucket: 'anytime',
    completedDates: [],
    skippedDates: [],
    ...extra,
  }) as unknown as Item;

const pristine = usePlannerStore.getState();

function seed(over: Record<string, unknown> = {}) {
  const items = (over.items as Item[] | undefined) ?? [
    habit('h1', 'Stretch', { completedDates: ['2026-09-21'] }),
    task('t1', 'Midterm', { startDate: '2026-10-22' }),
  ];
  usePlannerStore.setState({
    projects: [],
    routines: [],
    seasons: [],
    goals: [],
    itemTypes: [],
    collectionsAvailable: true,
    goalsAvailable: true,
    itemTypesAvailable: true,
    userTimezone: 'UTC',
    weekStartDay: 'sunday',
    isLoading: false,
    userId: null,
    ...over,
    items,
    tasks: items.filter((i) => i.type !== 'habit'),
    habits: items.filter((i) => i.type === 'habit'),
  } as never);
}

beforeEach(() => {
  usePlannerStore.setState(pristine, true);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  enableExtensions(EXT_GOALS, EXT_ORGANIZE);
  useUIStore.setState({ activeDialog: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const id = (t: string) => screen.getByTestId(t);

describe('the routine pane', () => {
  it('carries this week on every member row, from the user\'s week start', () => {
    seed({ routines: [{ id: 'r1', name: 'Mornings', itemIds: ['h1'] }] });
    render(<OrganizeConsole open onOpenChange={() => {}} section="routines" focusId="r1" />);
    const dots = id('week-dots');
    const label = dots.getAttribute('aria-label')!;
    // Sunday start: Sep 20 … 26. Monday was ticked; Saturday is today.
    expect(label).toContain('Mon done');
    expect(label).toContain('Sat due');
    expect(label).toContain('Sun nothing recorded');
    expect(label).not.toMatch(/miss/i);
  });
});

describe('the season pane', () => {
  it('draws its season over its run, with what lands on a day on hover', () => {
    seed({
      seasons: [
        {
          id: 'p1',
          name: 'Autumn term',
          state: 'auto',
          startsOn: '2026-09-01',
          endsOn: '2026-12-18',
          itemIds: ['t1'],
          routineIds: [],
        },
      ],
    });
    render(<OrganizeConsole open onOpenChange={() => {}} section="seasons" focusId="p1" />);
    const cells = screen.getAllByTestId('season-heatmap-cell');
    expect(cells[0].getAttribute('data-date')).toBe('2026-08-30'); // the week holding Sep 1
    const exam = cells.find((c) => c.getAttribute('data-date') === '2026-10-22')!;
    fireEvent.mouseEnter(exam);
    expect(id('season-heatmap-info').textContent).toContain('Midterm');
  });
});

describe('the goal pane', () => {
  it('shows its milestones on a timeline, and the same window as bars', () => {
    seed({
      goals: [
        {
          id: 'g1',
          name: 'Half marathon',
          state: 'active',
          startsOn: '2026-09-01',
          targetOn: '2027-03-01',
          memberIds: ['h1'],
          milestoneIds: ['t1'],
          checkinIds: [],
        },
      ],
    });
    render(<OrganizeConsole open onOpenChange={() => {}} section="goals" focusId="g1" />);
    expect(id('goal-schedule-timeline-milestone').textContent).toContain('Midterm');
    expect(screen.getAllByTestId('goal-schedule-timeline-lane')).toHaveLength(1);
    fireEvent.click(id('goal-schedule-view-bars'));
    expect(screen.getAllByTestId('goal-schedule-bars-bar').length).toBeGreaterThan(20);
  });
});

describe('the create modal previews the DRAFT', () => {
  it('quiets a routine\'s dots the moment it is set Paused', () => {
    seed();
    render(<ContainerDialog state={{ kind: 'routine', title: 'Mornings' }} onOpenChange={() => {}} />);
    fireEvent.click(id('routine-dialog-items-member-add'));
    const stretch = screen
      .getAllByTestId('routine-dialog-items-member-candidate')
      .find((b) => b.textContent?.includes('Stretch'))!;
    fireEvent.click(stretch);
    expect(id('week-dots').getAttribute('aria-label')).toContain('Sat due');

    fireEvent.click(id('routine-dialog-state-chip'));
    fireEvent.click(id('routine-dialog-state-paused'));
    // Held from today: today's open loop is off the grid, so off the preview.
    expect(id('week-dots').getAttribute('aria-label')).not.toContain('Sat due');
  });

  it('shows no season until the season holds something to place', () => {
    seed();
    render(<ContainerDialog state={{ kind: 'season', title: 'Term' }} onOpenChange={() => {}} />);
    expect(screen.queryByTestId('season-dialog-calendar')).toBeNull();
    fireEvent.click(id('season-dialog-items-member-add'));
    fireEvent.click(
      screen.getAllByTestId('season-dialog-items-member-candidate').find((b) => b.textContent?.includes('Stretch'))!
    );
    expect(screen.queryByTestId('season-dialog-calendar')).not.toBeNull();
  });

  it('draws a NEW routine habit on its chosen days before it exists', () => {
    seed();
    render(<ContainerDialog state={{ kind: 'routine', title: 'Mornings' }} onOpenChange={() => {}} />);
    const input = id('routine-dialog-create-item-new-name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Journal' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // Seeded daily. The form looks AHEAD — today (a Saturday) and the six days
    // after — so every one of them carries a mark.
    const label = () => id('week-dots').getAttribute('aria-label')!;
    expect(label()).toContain('Journal this week: Sat due, Sun');
    expect(label()).toContain('Fri');
    // Weekdays: the weekend drops out, Monday stays.
    fireEvent.click(id('routine-dialog-create-item-when'));
    fireEvent.click(id('routine-dialog-create-item-when-weekdays'));
    expect(label()).not.toContain('Sat');
    expect(label()).not.toContain('Sun');
    expect(label()).toContain('Mon');
    expect(id('routine-dialog-create-item-when').textContent).toContain('Weekdays');
  });

  it('shows a goal no chart until it has something to place', () => {
    seed();
    render(<ContainerDialog state={{ kind: 'goal', title: 'Run a 10k' }} onOpenChange={() => {}} />);
    expect(screen.queryByTestId('goal-dialog-schedule')).toBeNull();
    const input = id('goal-dialog-create-checkin-new-name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Weekly review' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByTestId('goal-dialog-schedule')).not.toBeNull();
    expect(id('goal-dialog-create-checkin-when').textContent).toContain('Sun');
  });
});

describe('a project', () => {
  it('lists its items with this week on each row, and its undated work in a tray', () => {
    seed({
      items: [
        task('a', 'Fix sink', { project: 'Home', startDate: TODAY }),
        task('b', 'Paint', { project: 'Home', isScheduled: false, timeBucket: undefined }),
      ],
      projects: [{ id: 'pr1', name: 'Home', emoji: '' }],
    });
    render(<OrganizeConsole open onOpenChange={() => {}} section="projects" focusId="pr1" />);
    expect(screen.getAllByTestId('project-member')).toHaveLength(2);
    expect(screen.getAllByTestId('week-dots')[0].getAttribute('aria-label')).toContain('Fix sink this week: Sat due');
    expect(id('project-unscheduled').textContent).toContain('Paint');
    // Each member opens its item.
    const links = screen.getAllByTestId('project-member-open');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/item/a', '/item/b']);
  });

  it('never links a member out of a create form, where leaving drops the draft', () => {
    seed();
    render(<ContainerDialog state={{ kind: 'routine', title: 'Mornings' }} onOpenChange={() => {}} />);
    fireEvent.click(id('routine-dialog-items-member-add'));
    fireEvent.click(
      screen.getAllByTestId('routine-dialog-items-member-candidate').find((b) => b.textContent?.includes('Stretch'))!
    );
    expect(screen.queryByTestId('routine-dialog-items-member-open')).toBeNull();
  });
});

describe('the Linear-style pane parts', () => {
  it('shapes the status by TYPE, so a habit and a repeating task of one title differ', () => {
    seed();
    const { container } = render(
      <>
        <TodayGlyph item={habit('h', 'Stretch')} state="due" todayStr={TODAY} />
        <TodayGlyph item={task('t', 'Stretch', { repeatFrequency: 'daily', startDate: TODAY })} state="due" todayStr={TODAY} />
      </>
    );
    const [a, b] = Array.from(container.querySelectorAll('[data-testid="today-glyph"]'));
    expect(a.querySelector('circle')).not.toBeNull();
    expect(b.querySelector('rect')).not.toBeNull();
    // …and the type is in the accessible name, not only a hover title.
    expect(a.querySelector('svg')!.getAttribute('aria-label')).toMatch(/^Habit,/);
    expect(b.querySelector('svg')!.getAttribute('aria-label')).toMatch(/^Task,/);
  });

  it('counts a week by what is done or ahead — never an unrecorded past day', () => {
    // Added Thursday (the past days before are `open`), so Sat and Sun remain.
    seed({ items: [habit('h1', 'Stretch')] });
    const { result } = renderHook(() => useWeekDotsFor(['h1']));
    const { done, total } = result.current.weekTotals(['h1']);
    expect(done).toBe(0);
    // Saturday (today) and nothing before it counts as missed.
    expect(total).toBeLessThanOrEqual(2);
  });

  it('draws an early block where it is, not clamped to 6am', () => {
    const { container } = render(
      <BlockWeekRow
        block={{ id: 'p', name: 'Deep', emoji: '', startTime: '05:00', timeBucket: 'morning', duration: 60, repeatFrequency: 'daily' }}
        days={[{ date: TODAY, on: true }]}
        todayStr={TODAY}
        trailingPad={0}
      />
    );
    const slice = container.querySelector('[style*="top"]') as HTMLElement;
    expect(slice.style.top).toBe('0%');
    expect(parseFloat(slice.style.height)).toBeGreaterThan(0);
  });

  it('agrees on a block between the chip and the row', () => {
    expect(blockWhen({ startTime: '23:00', duration: 120 })).toBe('11pm–1am');
    expect(hasTimeBlock({ startTime: '19:00', timeBucket: 'evening' })).toBe(false);
    expect(hasTimeBlock({ startTime: '19:00', timeBucket: 'evening', repeatFrequency: 'daily' })).toBe(true);
  });
});
