// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * /routine/[id], /program/[id], /project/[id] (Kirby, 2026-09-26) — the goal
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
    programs: [
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
  it('reads the routine: its rhythm, and the program holding it', () => {
    render(<ContainerPage kind="routine" id="r1" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Mornings');
    expect(screen.getAllByTestId('container-page-rhythm-row')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Stretch' }).getAttribute('href')).toBe('/item/h1');
    expect(screen.getByRole('link', { name: /Autumn term/ }).getAttribute('href')).toBe('/program/p1');
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

describe('the program page', () => {
  it('leads with its season, counting its routines\' members', () => {
    render(<ContainerPage kind="program" id="p1" />);
    expect(screen.getByTestId('container-page-season')).toBeTruthy();
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
    expect(screen.getAllByTestId('container-page-rhythm-row')).toHaveLength(1);
  });

  it('holds its items by name, and does not need Organize to be read', () => {
    disableExtensions(EXT_ORGANIZE);
    render(<ContainerPage kind="project" id="pr1" />);
    expect(screen.getByRole('link', { name: 'Journal' })).toBeTruthy();
    expect(screen.queryByTestId('container-page-organize')).toBeNull();
  });
});
