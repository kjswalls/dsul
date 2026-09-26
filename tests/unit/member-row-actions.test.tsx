// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/**
 * Controls on the console's member rows (Kirby, 2026-09-26 — reverses "member
 * rows are addresses"). Pinned: each verb is the planner row's own, behind the
 * planner row's own gate; ticks and skips are for TODAY and only when due; the
 * bin still means remove; Delete confirms; a habit cannot leave its project.
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

function seed(items: Item[], over: Record<string, unknown> = {}) {
  usePlannerStore.setState({
    items,
    tasks: items.filter((i) => i.type !== 'habit'),
    habits: items.filter((i) => i.type === 'habit'),
    projects: [],
    routines: [],
    programs: [],
    goals: [],
    itemTypes: [],
    collectionsAvailable: true,
    goalsAvailable: true,
    userTimezone: 'UTC',
    weekStartDay: 'sunday',
    isLoading: false,
    userId: null,
    ...over,
  } as never);
}

beforeEach(() => {
  usePlannerStore.setState(pristine, true);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  enableExtensions(EXT_GOALS, EXT_ORGANIZE);
  useUIStore.setState({ activeDialog: null, confirmRequest: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const rowOf = (title: string) => screen.getAllByTestId(/-member$/).find((r) => r.textContent?.includes(title))!;
function openMenu(title: string) {
  const trigger = within(rowOf(title)).getByTestId('member-menu');
  fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
  const open = screen.getAllByTestId('member-menu-content');
  return open[open.length - 1];
}
const item = (id: string) => usePlannerStore.getState().items.find((i) => i.id === id) as unknown as Record<string, unknown>;

describe('a routine\'s rows', () => {
  it('ticks a habit for TODAY, and offers no tick on a day it does not occur', () => {
    seed([habit('h1', 'Stretch'), habit('h2', 'Journal', { repeatFrequency: 'weekdays' })], {
      routines: [{ id: 'r1', name: 'Mornings', itemIds: ['h1', 'h2'] }],
    });
    render(<OrganizeConsole open onOpenChange={() => {}} section="routines" focusId="r1" />);

    const stretch = openMenu('Stretch');
    fireEvent.click(within(stretch).getByTestId('member-menu-tick'));
    expect(item('h1').completedDates).toEqual([TODAY]);

    // Journal is weekdays-only and today is Saturday: no tick, no skip.
    const journal = openMenu('Journal');
    expect(within(journal).queryByTestId('member-menu-tick')).toBeNull();
    expect(within(journal).queryByTestId('member-menu-skip')).toBeNull();
    // A repeating item never offers the put-off verbs — its date is the series anchor.
    expect(within(journal).queryByTestId('member-menu-next-day')).toBeNull();
    expect(within(journal).queryByTestId('member-menu-reschedule')).toBeNull();
  });

  it('skips today, and keeps the bin meaning "remove from the routine"', () => {
    seed([habit('h1', 'Stretch')], { routines: [{ id: 'r1', name: 'Mornings', itemIds: ['h1'] }] });
    render(<OrganizeConsole open onOpenChange={() => {}} section="routines" focusId="r1" />);
    fireEvent.click(within(openMenu('Stretch')).getByTestId('member-menu-skip'));
    expect(item('h1').skippedDates).toEqual([TODAY]);

    fireEvent.click(within(openMenu('Stretch')).getByTestId('member-menu-remove'));
    expect(usePlannerStore.getState().routines[0].itemIds).toEqual([]);
    expect(item('h1')).toBeTruthy(); // removed from the routine, not deleted
  });

  it('asks before Delete', () => {
    seed([habit('h1', 'Stretch')], { routines: [{ id: 'r1', name: 'Mornings', itemIds: ['h1'] }] });
    render(<OrganizeConsole open onOpenChange={() => {}} section="routines" focusId="r1" />);
    fireEvent.click(within(openMenu('Stretch')).getByTestId('member-menu-delete'));
    expect(useUIStore.getState().confirmRequest).toMatchObject({ destructive: true, confirmLabel: 'Delete' });
    expect(item('h1')).toBeTruthy();
  });
});

describe('a program\'s one-off rows', () => {
  it('moves a dated task to its next day, and sends it to the braindump', () => {
    seed([task('t1', 'Midterm', { startDate: '2026-10-22' }), task('t2', 'Essay', { startDate: '2026-11-12' })], {
      programs: [{ id: 'p1', name: 'Term', state: 'auto', itemIds: ['t1', 't2'], routineIds: [] }],
    });
    render(<OrganizeConsole open onOpenChange={() => {}} section="programs" focusId="p1" />);
    const menu = openMenu('Midterm');
    expect(within(menu).getByTestId('member-menu-next-day').textContent).toContain('Move to next day');
    fireEvent.click(within(menu).getByTestId('member-menu-next-day'));
    expect(item('t1').startDate).toBe('2026-10-23');

    fireEvent.click(within(openMenu('Essay')).getByTestId('member-menu-braindump'));
    expect(item('t2').startDate).toBeUndefined();
  });
});

describe('a goal\'s milestone', () => {
  it('never offers the braindump — unscheduling erases the target date', () => {
    seed([task('m1', 'Run 10k', { startDate: '2026-10-10' })], {
      goals: [{ id: 'g1', name: 'Half', state: 'active', memberIds: [], milestoneIds: ['m1'], checkinIds: [] }],
    });
    render(<OrganizeConsole open onOpenChange={() => {}} section="goals" focusId="g1" />);
    const menu = openMenu('Run 10k');
    expect(within(menu).queryByTestId('member-menu-braindump')).toBeNull();
    expect(within(menu).getByTestId('member-menu-next-day')).toBeTruthy();
    fireEvent.click(within(menu).getByTestId('member-menu-remove'));
    expect(usePlannerStore.getState().goals[0].milestoneIds).toEqual([]);
  });
});

describe('a project\'s rows', () => {
  it('cannot release a habit, whose project is required', () => {
    seed([habit('h1', 'Stretch', { project: 'Home' }), task('t1', 'Fix sink', { project: 'Home', startDate: TODAY })], {
      projects: [{ id: 'pr1', name: 'Home', emoji: '' }],
    });
    render(<OrganizeConsole open onOpenChange={() => {}} section="projects" focusId="pr1" />);
    expect(within(rowOf('Stretch')).queryByTestId('project-member-remove')).toBeNull();
    expect(within(openMenu('Stretch')).queryByTestId('member-menu-remove')).toBeNull();
    fireEvent.click(within(rowOf('Fix sink')).getByTestId('project-member-remove'));
    expect(item('t1').project).toBeUndefined();
  });
});

describe('the risky branches', () => {
  it('unskips a skipped day instead of ticking it — never skipped AND done', () => {
    const weekly = task('rt', 'Review', {
      startDate: '2026-09-19',
      repeatFrequency: 'custom',
      repeatDays: [6],
      skippedDates: [TODAY],
    });
    seed([weekly], { routines: [{ id: 'r1', name: 'Weekly', itemIds: ['rt'] }] });
    render(<OrganizeConsole open onOpenChange={() => {}} section="routines" focusId="r1" />);
    const menu = openMenu('Review');
    expect(within(menu).getByTestId('member-menu-tick').textContent).toContain('Unskip today');
    fireEvent.click(within(menu).getByTestId('member-menu-tick'));
    expect(item('rt').skippedDates).toEqual([]);
    expect(item('rt').completedDates).toEqual([]);
  });

  it('ticks a recurring TASK for today only', () => {
    const weekly = task('rt', 'Review', { startDate: '2026-09-19', repeatFrequency: 'custom', repeatDays: [6] });
    seed([weekly], { routines: [{ id: 'r1', name: 'Weekly', itemIds: ['rt'] }] });
    render(<OrganizeConsole open onOpenChange={() => {}} section="routines" focusId="r1" />);
    fireEvent.click(within(openMenu('Review')).getByTestId('member-menu-tick'));
    expect(item('rt').completedDates).toEqual([TODAY]);
  });

  it('says a counted habit steps one at a time', () => {
    seed([habit('w', 'Water', { timesPerDay: 3, dailyCounts: { [TODAY]: 1 } })], {
      routines: [{ id: 'r1', name: 'Day', itemIds: ['w'] }],
    });
    render(<OrganizeConsole open onOpenChange={() => {}} section="routines" focusId="r1" />);
    expect(within(openMenu('Water')).getByTestId('member-menu-tick').textContent).toContain('Count one (1/3)');
  });

  it('offers no Pause on an item already paused', () => {
    seed([habit('h1', 'Stretch', { pausedAt: '2026-09-20T00:00:00Z' }), habit('h2', 'Read')], {
      routines: [{ id: 'r1', name: 'M', itemIds: ['h1', 'h2'] }],
    });
    render(<OrganizeConsole open onOpenChange={() => {}} section="routines" focusId="r1" />);
    expect(within(openMenu('Stretch')).queryByTestId('member-menu-pause')).toBeNull();
    expect(within(openMenu('Read')).getByTestId('member-menu-pause')).toBeTruthy();
  });

  it('keeps subtasks out of a project\'s list, and items filed elsewhere out of its picker', () => {
    seed(
      [
        task('t1', 'Fix sink', { project: 'Home', startDate: TODAY }),
        task('s1', 'Buy washer', { project: 'Home', parentItemId: 't1' }),
        task('w1', 'Quarterly report', { project: 'Work' }),
        task('u1', 'Loose end'),
      ],
      { projects: [{ id: 'pr1', name: 'Home', emoji: '' }, { id: 'pr2', name: 'Work', emoji: '' }] }
    );
    render(<OrganizeConsole open onOpenChange={() => {}} section="projects" focusId="pr1" />);
    expect(screen.getAllByTestId('project-member').map((r) => r.getAttribute('data-item-id'))).toEqual(['t1']);
    fireEvent.click(screen.getByTestId('project-member-add'));
    const offered = screen.getAllByTestId('project-member-candidate').map((b) => b.getAttribute('data-item-id'));
    expect(offered).toEqual(['u1']);
    fireEvent.click(screen.getAllByTestId('project-member-candidate')[0]);
    expect(item('u1').project).toBe('Home');
  });
});
