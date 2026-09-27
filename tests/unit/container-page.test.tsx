// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * /routine/[id], /season/[id], /project/[id] (Kirby, 2026-09-26) — the goal
 * page's posture for the other containers: deep-linkable, inert when their
 * extension is off, loading-aware, and editing only through the console door.
 */

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/routine/r1',
  useParams: () => ({}),
}));

import { ContainerPage } from '@/components/planner/container-page';
import { usePlannerStore } from '@/lib/planner-store';
import { useUIStore } from '@/lib/ui-store';
import { EXT_ORGANIZE } from '@/lib/extension-registry';
import { disableExtensions, enableExtensions } from './support/extensions';
import type { Item } from '@/lib/planner-types';

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

function seed(over: Record<string, unknown> = {}) {
  const items = [habit('h1', 'Stretch'), habit('h2', 'Journal', { project: 'Home' })];
  usePlannerStore.setState({
    items,
    tasks: [],
    habits: items,
    routines: [{ id: 'r1', name: 'Mornings', itemIds: ['h1'] }],
    seasons: [
      { id: 'p1', name: 'Autumn term', state: 'auto', startsOn: '2026-09-01', endsOn: '2026-12-18', itemIds: [], routineIds: ['r1'] },
    ],
    projects: [{ id: 'pr1', name: 'Home', emoji: '' }],
    userTimezone: 'UTC',
    weekStartDay: 'sunday',
    userId: 'u1',
    isLoading: false,
    ...over,
  } as never);
}

beforeEach(() => {
  usePlannerStore.setState(pristine, true);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-26T12:00:00Z'));
  enableExtensions(EXT_ORGANIZE);
  useUIStore.setState({ activeDialog: null });
  push.mockClear();
  seed();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the routine page', () => {
  it('reads the routine: its rhythm, and the season holding it', () => {
    render(<ContainerPage kind="routine" id="r1" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Mornings');
    expect(screen.getAllByTestId('container-page-rhythm-row')).toHaveLength(1);
    // Twice — today's checklist leads, and the rhythm follows — and both go to the item.
    const links = screen.getAllByRole('link', { name: 'Stretch' });
    expect(links).toHaveLength(2);
    for (const link of links) expect(link.getAttribute('href')).toBe('/item/h1');
    expect(screen.getByTestId('container-page-today').textContent).toContain('Stretch');
    expect(screen.getByRole('link', { name: /Autumn term/ }).getAttribute('href')).toBe('/season/p1');
  });

  it('says when the routine usually happens, in the user’s clock format', () => {
    seed({ routines: [{ id: 'r1', name: 'Mornings', itemIds: ['h1'], usualTime: '07:00' }], timeFormat: '12h' });
    render(<ContainerPage kind="routine" id="r1" />);
    // A property row now: "Usually at" beside "7:00 am".
    expect(screen.getByTestId('container-page-summary').textContent).toContain('Usually at7:00 am');
  });

  it('reads its note under the title, and its properties beside it', () => {
    const done = habit('h1', 'Stretch', { completedDates: ['2026-09-26'] });
    seed({
      items: [done],
      habits: [done],
      routines: [{ id: 'r1', name: 'Mornings', itemIds: ['h1'], notes: 'Before the phone.' }],
    });
    render(<ContainerPage kind="routine" id="r1" />);
    expect(screen.getByTestId('container-page-notes').textContent).toBe('Before the phone.');
    const props = screen.getByTestId('container-page-summary');
    expect(props.textContent).toContain('Active');
    expect(props.textContent).toContain('Autumn term');
    // Saturday, done today. The six earlier days recorded nothing — open, not
    // missed — so they are not counted against it.
    expect(screen.getByTestId('container-page-progress').textContent).toContain('1 of 1');
  });

  it('never lights a paused routine lime, and says nothing when there is no note', () => {
    seed({ routines: [{ id: 'r1', name: 'Mornings', itemIds: ['h1'], pausedAt: '2026-09-20T12:00:00Z' }] });
    render(<ContainerPage kind="routine" id="r1" />);
    expect(screen.queryByTestId('container-page-notes')).toBeNull();
    const props = screen.getByTestId('container-page-summary');
    expect(props.textContent).toContain('Paused');
    expect(props.querySelector('.bg-primary')).toBeNull();
  });

  it('edits through the console door — arm the slot, then go where the console lives', () => {
    render(<ContainerPage kind="routine" id="r1" />);
    fireEvent.click(screen.getByTestId('container-page-organize'));
    expect(useUIStore.getState().activeDialog).toEqual({ type: 'organize', section: 'routines', focusId: 'r1' });
    expect(push).toHaveBeenCalledWith('/');
  });

  it('is inert, not missing, with Organize switched off', () => {
    disableExtensions(EXT_ORGANIZE);
    render(<ContainerPage kind="routine" id="r1" />);
    expect(screen.getByTestId('container-page-extension-off')).toBeTruthy();
  });

  it('says Loading while the fetch is in flight, and not found after', () => {
    seed({ isLoading: true });
    render(<ContainerPage kind="routine" id="nope" />);
    expect(screen.getByTestId('container-page-missing').textContent).toBe('Loading…');
    cleanup();
    seed();
    render(<ContainerPage kind="routine" id="nope" />);
    expect(screen.getByTestId('container-page-missing').textContent).toBe('Routine not found');
  });
});

describe('the season page', () => {
  it('leads with its season, counting its routines\' members', () => {
    render(<ContainerPage kind="season" id="p1" />);
    expect(screen.getByTestId('container-page-calendar')).toBeTruthy();
    expect(screen.getByTestId('container-page-summary').textContent).toContain('Runs');
    expect(screen.getByTestId('container-page-summary').textContent).toContain('On now');
    expect(screen.getAllByTestId('container-page-rhythm-row')).toHaveLength(1);
  });
});

describe('the project page', () => {
  it('draws its time block as a row, and skips members with nothing in the week', () => {
    seed({
      items: [
        habit('h2', 'Journal', { project: 'Home' }),
        { id: 't9', type: 'task', title: 'Someday', status: 'pending', order: 0, isScheduled: false, project: 'Home' } as unknown as Item,
      ],
      habits: [habit('h2', 'Journal', { project: 'Home' })],
      projects: [
        { id: 'pr1', name: 'Home', emoji: '', repeatFrequency: 'custom', repeatDays: [6], timeBucket: 'morning', startTime: '10:00' },
      ],
    });
    render(<ContainerPage kind="project" id="pr1" />);
    expect(screen.getByTestId('container-page-rhythm-block').textContent).toContain('10:00');
    // The console chip's own words, never the stored slug.
    expect(screen.getByTestId('container-page-summary').textContent).toContain('Chosen days · ');
    expect(screen.getByTestId('container-page-summary').textContent).not.toContain('custom');
    expect(screen.getAllByTestId('container-page-rhythm-row')).toHaveLength(1);
  });

  it('holds its items by name, and does not need Organize to be read', () => {
    disableExtensions(EXT_ORGANIZE);
    render(<ContainerPage kind="project" id="pr1" />);
    expect(screen.getByRole('link', { name: 'Journal' })).toBeTruthy();
    expect(screen.queryByTestId('container-page-organize')).toBeNull();
  });
});
