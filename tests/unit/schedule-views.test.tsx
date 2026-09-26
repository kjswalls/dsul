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
    programs: [],
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

describe('the program pane', () => {
  it('draws its season over its run, with what lands on a day on hover', () => {
    seed({
      programs: [
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
    render(<OrganizeConsole open onOpenChange={() => {}} section="programs" focusId="p1" />);
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

  it('gives a new program a season to look at before anything is linked', () => {
    seed();
    render(<ContainerDialog state={{ kind: 'program', title: 'Term' }} onOpenChange={() => {}} />);
    expect(id('program-dialog-season-heatmap-info').textContent).toContain('link routines or items');
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
  });
});
