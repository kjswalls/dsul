import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { OrganizeConsole } from '@/components/planner/organize/organize-console';
import { usePlannerStore } from '@/lib/planner-store';
import { useUIStore } from '@/lib/ui-store';
import { useAwayStore } from '@/lib/away-store';
import { backOn, pausedShelf } from '@/lib/paused-shelf';
import { backList } from '@/components/notices/back-notice';
import { enableGoalsAndOrganize } from './support/extensions';
import type { Item, Routine, Season } from '@/lib/planner-types';

/**
 * Organize's Paused section and the derivation behind it (lib/paused-shelf.ts):
 * everything set aside, grouped by the day it comes back, with a routine or a
 * season as ONE row. Kirby moved this here from the braindump's drawer on
 * 2026-10-23; the braindump keeps a moon with the count.
 */

vi.mock('vaul', () => ({
  Drawer: {
    Root: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Overlay: () => null,
    Content: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Title: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
    Description: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
    Close: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
    Handle: () => null,
  },
}));

const TODAY = '2026-10-23';
/** Started yesterday, so isPausedOn's lower bound is satisfied today. */
const PAUSED_AT = '2026-10-22T09:00:00.000Z';

const habit = (id: string, title: string, extra: Partial<Item> = {}): Item =>
  ({
    id,
    type: 'habit',
    title,
    status: 'pending',
    repeatFrequency: 'daily',
    completedDates: [],
    skippedDates: [],
    streak: 0,
    order: 0,
    isScheduled: false,
    ...extra,
  }) as Item;

const task = (id: string, title: string, extra: Partial<Item> = {}): Item =>
  ({ id, type: 'task', title, status: 'pending', order: 0, isScheduled: false, ...extra }) as Item;

const routine = (id: string, name: string, extra: Partial<Routine> = {}): Routine => ({
  id,
  name,
  itemIds: [],
  ...extra,
});

const season = (id: string, name: string, extra: Partial<Season> = {}): Season => ({
  id,
  name,
  state: 'auto',
  itemIds: [],
  routineIds: [],
  ...extra,
});

/** The fixture: two self-paused with dates, one without, a paused routine of two, and one live task. */
const fixture = () => {
  const items = [
    habit('gym', 'Gym', { pausedAt: PAUSED_AT, pausedUntil: '2026-10-30' }),
    task('garage', 'Clear out the garage', { pausedAt: PAUSED_AT }),
    habit('pages', 'Morning pages', { pausedAt: PAUSED_AT, pausedUntil: '2026-10-30' }),
    habit('stretch', 'Stretch'),
    habit('meditate', 'Meditate'),
    task('dentist', 'Book dentist'),
  ];
  const routines = [
    routine('morning', 'Morning', {
      itemIds: ['stretch', 'meditate'],
      pausedAt: PAUSED_AT,
      pausedUntil: '2026-11-01',
    } as Partial<Routine>),
  ];
  return { items, routines, seasons: [] as Season[] };
};

const ctx = (f: ReturnType<typeof fixture>) => ({
  userTimezone: 'UTC',
  routines: f.routines,
  seasons: f.seasons,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00.000Z`));
  enableGoalsAndOrganize();
  useAwayStore.setState({ periods: [] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('pausedShelf', () => {
  it('groups by the day each comes back, soonest first and the undated last', () => {
    const f = fixture();
    const shelf = pausedShelf(f.items, TODAY, ctx(f));
    expect(shelf.days.map((d) => d.key)).toEqual(['2026-10-30', '2026-11-01', '']);
    expect(shelf.days[0].entries.map((e) => e.key)).toEqual(['item:gym', 'item:pages']);
    expect(shelf.days[2].entries.map((e) => e.key)).toEqual(['item:garage']);
  });

  it('lists a paused routine once, carrying its members, and counts the members', () => {
    const f = fixture();
    const shelf = pausedShelf(f.items, TODAY, ctx(f));
    const morning = shelf.days[1].entries[0];
    expect(morning.kind).toBe('routine');
    expect(morning.kind === 'routine' && morning.items.map((i) => i.id)).toEqual(['stretch', 'meditate']);
    // Items, not rows: the moon's number is what is hidden, routine members included.
    expect(shelf.count).toBe(5);
  });

  it('names the season when a season is what holds the routine off', () => {
    const f = fixture();
    const routines = [routine('morning', 'Morning', { itemIds: ['stretch'] })];
    const seasons = [season('garden', 'Garden', { routineIds: ['morning'], startsOn: '2027-04-01' })];
    const shelf = pausedShelf([habit('stretch', 'Stretch')], TODAY, { ...ctx(f), routines, seasons });
    expect(shelf.days.map((d) => d.key)).toEqual(['2027-04-01']);
    expect(shelf.days[0].entries[0].key).toBe('season:garden');
  });

  it('leaves out subtasks and what a trip is resting', () => {
    const f = fixture();
    const sub = task('sub', 'Sub', { pausedAt: PAUSED_AT, parentItemId: 'garage' } as Partial<Item>);
    const shelf = pausedShelf([...f.items, sub], TODAY, {
      ...ctx(f),
      away: [{ id: 't', startsOn: '2026-10-20', endsOn: '2026-10-28', keep: { itemIds: [], routineIds: [], projectIds: [] }, returns: {}, fromTrip: {} }] as never,
    });
    expect(shelf.days.flatMap((d) => d.entries).some((e) => e.key === 'item:sub')).toBe(false);
  });

  it('is empty when nothing is set aside', () => {
    expect(pausedShelf([task('a', 'A')], TODAY, { userTimezone: 'UTC' })).toEqual({ days: [], count: 0 });
  });
});

describe('backOn', () => {
  it('names what a pause hands back on its return day, containers once', () => {
    const f = fixture();
    expect(backOn(f.items, '2026-10-30', ctx(f))).toEqual(['Gym', 'Morning pages']);
    expect(backOn(f.items, '2026-11-01', ctx(f))).toEqual(['Morning']);
  });

  it('says nothing on any other day, including today with everything still away', () => {
    const f = fixture();
    expect(backOn(f.items, TODAY, ctx(f))).toEqual([]);
    expect(backOn(f.items, '2026-10-31', ctx(f))).toEqual([]);
  });

  it('reads as a sentence', () => {
    expect(backList(['Gym'])).toBe('Gym');
    expect(backList(['Gym', 'Stretch'])).toBe('Gym and Stretch');
    expect(backList(['Gym', 'Stretch', 'Journal'])).toBe('Gym, Stretch and Journal');
    expect(backList(['A', 'B', 'C', 'D', 'E'])).toBe('A, B and 3 more');
  });
});

describe('the Paused section', () => {
  const seed = (extra: Record<string, unknown> = {}) => {
    const f = fixture();
    usePlannerStore.setState({
      items: f.items,
      routines: f.routines,
      seasons: f.seasons,
      projects: [],
      itemTypes: [],
      collectionsAvailable: true,
      itemTypesAvailable: true,
      isLoading: false,
      userId: 'u1',
      userTimezone: 'UTC',
      ...extra,
    });
  };
  const open = () => render(<OrganizeConsole open onOpenChange={() => {}} section="paused" />);

  it('lists the return days and one row per routine', () => {
    seed();
    open();
    const days = screen.getAllByTestId('paused-day');
    expect(days.map((d) => d.dataset.day)).toEqual(['2026-10-30', '2026-11-01', '']);
    expect(days[0]).toHaveTextContent(/^Fri, Oct 30/);
    expect(days[2]).toHaveTextContent(/^No date/);
    const morning = within(days[1]).getByTestId('paused-row');
    expect(morning.dataset.pausedKind).toBe('routine');
    expect(morning).toHaveTextContent('Routine · 2 habits');
    // Never an age: nothing says how long anything has been set aside.
    expect(screen.getByTestId('organize-list')).not.toHaveTextContent(/ago|days/);
  });

  it('resumes an item from its row', () => {
    const setItemPaused = vi.fn();
    seed({ setItemPaused });
    open();
    const gym = screen.getAllByTestId('paused-row').find((r) => r.dataset.pausedKey === 'item:gym')!;
    fireEvent.click(within(gym).getByTestId('paused-resume'));
    expect(setItemPaused).toHaveBeenCalledWith('gym', false);
  });

  it('resumes a routine through its own switch, never its members', () => {
    const setRoutinePaused = vi.fn();
    const setItemPaused = vi.fn();
    seed({ setRoutinePaused, setItemPaused });
    open();
    const morning = screen.getAllByTestId('paused-row').find((r) => r.dataset.pausedKind === 'routine')!;
    fireEvent.click(within(morning).getByTestId('paused-resume'));
    expect(setRoutinePaused).toHaveBeenCalledWith('morning', false);
    expect(setItemPaused).not.toHaveBeenCalled();
  });

  it('details a selection with its return, and opens the item from there', () => {
    seed();
    open();
    const gym = screen.getAllByTestId('paused-row').find((r) => r.dataset.pausedKey === 'item:gym')!;
    fireEvent.click(within(gym).getByTestId('paused-select'));
    expect(screen.getByTestId('paused-detail-state')).toHaveTextContent('Paused until Oct 30');
    fireEvent.click(screen.getByTestId('paused-detail-open'));
    expect(useUIStore.getState().activeDialog).toMatchObject({ type: 'edit-item' });
  });

  it('says so when nothing is paused', () => {
    seed({ items: [task('a', 'A')], routines: [] });
    open();
    expect(screen.getByTestId('paused-empty')).toHaveTextContent('Nothing is paused.');
  });
});
