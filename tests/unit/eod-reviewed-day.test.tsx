import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

/**
 * Done records the day the review was FOR, never the day Done is pressed.
 *
 * `last_eod_review_date` is the stamp the reminder scan's review tier reads
 * through isEodOwed before it invites tonight's review, and the dock reads it
 * before it shows its line. Stamped with the day Done was pressed, the 6th's
 * 23:30 push finished at 00:15 on the 7th recorded the 7th as reviewed, and
 * the 7th's invitation was retired before it was sent: a night owl got every
 * other night's push. The push's link names its day now (`?eod=2026-10-06`,
 * opened by AppShell through `openInvited`), and lib/eod.ts's reviewedDay
 * picks the day. These pin the wiring between the two, the part a pure test
 * of reviewedDay cannot see. Sibling of eod-dismiss.test.tsx and set up the
 * same way: real stores, real component, db mocked, fixed clock.
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
  loadPlannerData: vi.fn((_u: string, perTable: () => Promise<unknown>) => perTable()),
  createGoal: vi.fn(async () => {}),
  updateGoal: vi.fn(async () => {}),
  deleteGoal: vi.fn(async () => {}),
  restoreGoal: vi.fn(async () => {}),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));

// What saveLastReviewDate upserts, which is what the scan will read.
const upsert = vi.fn(async () => ({ error: null }));
vi.mock('@/lib/supabase', () => ({
  createClient: vi.fn(() => ({ from: () => ({ upsert }) })),
}));

import { EODReview } from '@/components/ai/eod-review';
import { usePlannerStore } from '@/lib/planner-store';
import { useEODStore } from '@/lib/eod-store';

const USER = 'user-1';

/** The day the stamp was written for, as the database was handed it. */
const stamped = () =>
  (upsert.mock.calls as unknown as [Record<string, unknown>][]).map(([row]) => row.last_eod_review_date);

const pressDone = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Done for today' }));
  });
};

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  upsert.mockClear();
  usePlannerStore.getState().clearStore();
  await usePlannerStore.getState().initializeStore(USER);
  // UTC, so the fixed instants below are the user's own wall clock.
  usePlannerStore.setState({ userTimezone: 'UTC' });
  useEODStore.getState().clearUserScopedState();
});

afterEach(() => {
  cleanup();
  useEODStore.getState().clearUserScopedState();
  vi.useRealTimers();
});

describe('Done records the day the review was for', () => {
  it("the 6th's push, finished at 00:15 on the 7th, is the 6th's review", async () => {
    vi.setSystemTime(new Date('2026-10-07T00:15:00Z'));
    act(() => useEODStore.getState().openInvited('2026-10-06'));
    render(<EODReview />);

    await pressDone();

    expect(stamped()).toEqual(['2026-10-06']);
    expect(useEODStore.getState().lastEodReviewDate).toBe('2026-10-06');
  });

  it("tonight's push, finished tonight, is tonight's review", async () => {
    vi.setSystemTime(new Date('2026-10-06T21:10:00Z'));
    act(() => useEODStore.getState().openInvited('2026-10-06'));
    render(<EODReview />);

    await pressDone();

    expect(stamped()).toEqual(['2026-10-06']);
  });

  // Opened without a push (the palette, the dock's line): the day it opened
  // on, which a Done pressed after midnight no longer moves.
  it('a review opened at 23:55 and finished at 00:05 is the day it opened on', async () => {
    vi.setSystemTime(new Date('2026-10-06T23:55:00Z'));
    act(() => useEODStore.getState().open());
    const { rerender } = render(<EODReview />);

    vi.setSystemTime(new Date('2026-10-07T00:05:00Z'));
    rerender(<EODReview />);
    await pressDone();

    expect(stamped()).toEqual(['2026-10-06']);
  });

  // An opening from the push does not outlive itself: the next opening any
  // other way names no day, and records the one it opened on.
  it('a later opening from the palette does not inherit the last push\'s day', async () => {
    vi.setSystemTime(new Date('2026-10-07T21:10:00Z'));
    act(() => useEODStore.getState().openInvited('2026-10-06'));
    act(() => useEODStore.getState().close());
    act(() => useEODStore.getState().open());
    expect(useEODStore.getState().invitedFor).toBeNull();
    render(<EODReview />);

    await pressDone();

    expect(stamped()).toEqual(['2026-10-07']);
  });
});
