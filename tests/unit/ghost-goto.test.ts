import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { findCommand, type CommandContext } from '@/lib/commands';
import { usePlannerStore } from '@/lib/planner-store';
import { useMorningStore } from '@/lib/morning-store';
import { useViewStore } from '@/lib/view-store';
import { useMobileNavStore } from '@/lib/mobile-nav-store';
import { toDateStr } from '@/lib/recurrence';
import type { Item } from '@/lib/planner-types';

/**
 * goto.overdue ("Show leftovers") since the ghost rows: it lights exactly when
 * the fold would have something in it (the fold's own selector, milestones
 * excluded), and it goes where the fold is drawn: today, in the day scope on
 * the desktop, on the Today tab on the phone.
 */

const TODAY = '2026-07-14';
const desk: CommandContext = {
  theme: { resolved: 'light', value: 'light', set: () => {} },
  openChat: () => {},
  userId: 'u1',
  isMobile: false,
};
const phone: CommandContext = { ...desk, isMobile: true };

const task = (id: string, startDate: string): Item =>
  ({
    type: 'task',
    id,
    title: id,
    status: 'pending',
    isScheduled: true,
    timeBucket: 'morning',
    order: 0,
    startDate,
    completedDates: [],
  }) as Item;

function seed(items: Item[], goals: unknown[] = []) {
  usePlannerStore.setState({
    items,
    tasks: items as never,
    habits: [],
    routines: [],
    seasons: [],
    goals: goals as never,
    userTimezone: 'UTC',
    selectedDate: new Date('2026-07-01T12:00:00Z'),
  });
}

const cmd = (ctx: CommandContext) => {
  const c = findCommand('goto.overdue', ctx);
  if (!c) throw new Error('no goto.overdue');
  return c;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T15:00:00Z`));
  useMorningStore.setState({ morningCheckEnabled: true });
});
afterEach(() => {
  vi.useRealTimers();
  useMorningStore.setState({ morningCheckEnabled: false });
  seed([]);
});

describe('when it is available', () => {
  it('lights with a leftover, and not while the switch is off', () => {
    seed([task('late', '2026-07-10')]);
    expect(cmd(desk).availableWhen!(desk)).toBe(true);
    useMorningStore.setState({ morningCheckEnabled: false });
    expect(cmd(desk).availableWhen!(desk)).toBe(false);
  });

  it('stays grey when the only thing past its date is a goal milestone (a target, never a ghost)', () => {
    seed([task('m', '2026-07-10')], [{ id: 'g1', title: 'Goal', milestoneIds: ['m'] }]);
    expect(cmd(desk).availableWhen!(desk)).toBe(false);
  });
});

describe('where it goes', () => {
  it('on the desktop, to today in the day scope', () => {
    seed([task('late', '2026-07-10')]);
    useViewStore.getState().setScope('week');
    cmd(desk).run(desk);
    expect(useViewStore.getState().scope).toBe('day');
    expect(toDateStr(usePlannerStore.getState().selectedDate, 'UTC')).toBe(TODAY);
  });

  it('on the phone, to the Today tab on today', () => {
    seed([task('late', '2026-07-10')]);
    useMobileNavStore.getState().setActiveTab('chat');
    cmd(phone).run(phone);
    expect(useMobileNavStore.getState().activeTab).toBe('today');
    expect(toDateStr(usePlannerStore.getState().selectedDate, 'UTC')).toBe(TODAY);
  });
});
