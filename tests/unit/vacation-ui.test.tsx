import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/lib/db', async (orig) => ({
  ...(await orig<typeof import('@/lib/db')>()),
  createAwayPeriod: vi.fn(async () => {}),
  updateAwayPeriod: vi.fn(async () => {}),
  deleteAwayPeriod: vi.fn(async () => {}),
}));

import { VacationDialog } from '@/components/planner/vacation-dialog';
import { AwayNotice } from '@/components/views/away-notice';
import { useAwayStore } from '@/lib/away-store';
import { usePlannerStore } from '@/lib/planner-store';
import { EMPTY_KEEP, addDays } from '@/lib/away';
import type { Item } from '@/lib/planner-types';

const TODAY = '2026-10-11';
const every = Array.from({ length: 30 }, (_, i) => addDays(TODAY, -(i + 1)));
const habit = (id: string, title: string, completedDates: string[] = [], streak = 0): Item =>
  ({
    type: 'habit', id, title, streak, status: 'pending', completedDates, skippedDates: [],
    dailyCounts: {}, repeatFrequency: 'daily',
  }) as unknown as Item;

// Radix's checkbox measures itself; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-11T15:00:00Z'));
  usePlannerStore.setState({
    items: [habit('meds', 'Take meds', every), habit('gym', 'Gym', [], 9), habit('read', 'Read', [], 2)],
    routines: [],
    userTimezone: 'UTC',
  });
  useAwayStore.setState({ periods: [], loaded: true, available: true, userId: 'u' });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useAwayStore.getState().reset();
});

describe('the vacation card', () => {
  it('starts with the month\'s every-day habits kept, and starts the trip', () => {
    const onOpenChange = vi.fn();
    render(<VacationDialog open onOpenChange={onOpenChange} />);
    expect(screen.getByTestId('vacation-keep-sentence').textContent).toContain('Take meds keeps going. Everything else rests.');
    fireEvent.change(screen.getByTestId('vacation-back-on'), { target: { value: '2026-10-20' } });
    fireEvent.click(screen.getByTestId('vacation-submit'));
    const [trip] = useAwayStore.getState().periods;
    expect(trip).toMatchObject({ startsOn: TODAY, endsOn: '2026-10-20' });
    expect(trip.keep.itemIds).toEqual(['meds']);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('lets the picker change what keeps going', () => {
    render(<VacationDialog open editKeep onOpenChange={() => {}} />);
    fireEvent.click(screen.getByLabelText('Gym'));
    expect(screen.getByTestId('vacation-keep-sentence').textContent).toContain('Take meds and Gym keep going.');
  });
});

describe('the line beside the date', () => {
  it('says until when, what still runs, and ends the trip on "I\'m back"', () => {
    useAwayStore.setState({
      periods: [{ id: 'p', startsOn: '2026-10-05', endsOn: '2026-10-20', keep: { ...EMPTY_KEEP, itemIds: ['meds'] }, returns: {}, fromTrip: {} }],
    });
    render(<AwayNotice />);
    expect(screen.getByTestId('away-notice').textContent).toContain('Away until Tue, Oct 20 · 1 still running');
    fireEvent.click(screen.getByTestId('away-notice-verb'));
    expect(useAwayStore.getState().periods[0].endsOn).toBe(TODAY);
  });

  it('offers to bring everything back while habits ease in', () => {
    useAwayStore.setState({
      periods: [{ id: 'p', startsOn: '2026-10-01', endsOn: '2026-10-10', keep: EMPTY_KEEP, returns: { gym: '2026-10-14' }, fromTrip: {} }],
    });
    render(<AwayNotice />);
    expect(screen.getByTestId('away-notice').dataset.awayState).toBe('easing');
    fireEvent.click(screen.getByTestId('away-notice-verb'));
    expect(useAwayStore.getState().periods[0].returns).toEqual({});
  });
});
