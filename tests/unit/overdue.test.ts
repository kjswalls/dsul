import { describe, it, expect } from 'vitest';
import {
  RECENT_OVERDUE_DAYS,
  daysOverdue,
  selectOverdue,
  splitOverdueCohorts,
  summarizeOverdue,
  toDateOnly,
} from '@/lib/overdue';
import { buildCustomTypeConfig } from '@/lib/item-registry';
import { inactiveItemIdsOn } from '@/lib/active';
import type { Item } from '@/lib/planner-types';

/** No suppression — the state of the world before anything is paused. */
const NONE: ReadonlySet<string> = new Set();

/**
 * lib/overdue.ts is the single definition of "past due" — the morning surface,
 * Beacon's context and the goto.overdue command all read it. The regression it
 * exists to prevent is recurring items: planner-store deliberately never moves
 * a recurring item's scalar status, so a daily chore anchored months ago is
 * `pending` forever and the old per-call-site predicates reported it as overdue
 * every single day.
 */

const TODAY = '2026-07-15'; // a Wednesday

/** Dates relative to TODAY, so every assertion reads as "n days overdue". */
const D = {
  today: TODAY,
  tomorrow: '2026-07-16',
  d1: '2026-07-14',
  d3: '2026-07-12',
  d5: '2026-07-10',
  d7: '2026-07-08', // exactly the cohort boundary — still "recent"
  d8: '2026-07-07', // one past it — "long overdue"
  d10: '2026-07-05',
  d30: '2026-06-15',
  d100: '2026-04-06',
};

let seq = 0;

function task(over: Partial<Item> & { id?: string } = {}): Item {
  return {
    type: 'task',
    id: over.id ?? `t${++seq}`,
    title: 'task',
    status: 'pending',
    isScheduled: true,
    order: 0,
    ...over,
  } as Item;
}

function habit(over: Partial<Item> = {}): Item {
  return {
    type: 'habit',
    id: `h${++seq}`,
    title: 'habit',
    project: 'Wellness',
    status: 'pending',
    streak: 0,
    completedDates: [],
    skippedDates: [],
    dailyCounts: {},
    repeatFrequency: 'daily',
    ...over,
  } as Item;
}

function custom(over: Partial<Item> = {}): Item {
  return {
    type: 'custom',
    customType: 'goal',
    id: `c${++seq}`,
    title: 'goal',
    status: 'pending',
    isScheduled: true,
    order: 0,
    ...over,
  } as Item;
}

const ids = (items: { id: string }[]) => items.map((i) => i.id);

describe('selectOverdue', () => {
  it('returns nothing for an empty store', () => {
    expect(selectOverdue([], TODAY, NONE)).toEqual([]);
    const summary = summarizeOverdue([], TODAY, NONE);
    expect(summary.count).toBe(0);
    expect(summary.recent).toEqual([]);
    expect(summary.long).toEqual([]);
  });

  it('takes only dates strictly before today', () => {
    const yesterday = task({ id: 'yesterday', startDate: D.d1 });
    const dueToday = task({ id: 'today', startDate: D.today });
    const future = task({ id: 'future', startDate: D.tomorrow });
    const undated = task({ id: 'undated' });

    expect(ids(selectOverdue([yesterday, dueToday, future, undated], TODAY, NONE))).toEqual([
      'yesterday',
    ]);
  });

  it('EXCLUDES recurring items — their misses are per-date state, not a status', () => {
    // The bug this module exists to fix: planner-store never flips a recurring
    // item's scalar status (it writes completedDates), so this stays 'pending'
    // forever and used to appear in the morning banner every single day.
    const daily = task({ id: 'daily', startDate: '2026-04-01', repeatFrequency: 'daily' });
    const weekdays = task({ id: 'weekdays', startDate: D.d30, repeatFrequency: 'weekdays' });
    const custom5 = task({
      id: 'custom',
      startDate: D.d30,
      repeatFrequency: 'custom',
      repeatDays: [1, 3],
    });
    const monthly = task({ id: 'monthly', startDate: D.d30, repeatFrequency: 'monthly', repeatMonthDay: 3 });
    // 'none' and undefined are both one-shot and DO carry forward.
    const explicitNone = task({ id: 'none', startDate: D.d1, repeatFrequency: 'none' });
    const oneShot = task({ id: 'oneShot', startDate: D.d1 });

    const out = selectOverdue(
      [daily, weekdays, custom5, monthly, explicitNone, oneShot],
      TODAY,
      NONE
    );
    expect(ids(out).sort()).toEqual(['none', 'oneShot']);
  });

  it('tolerates legacy full-ISO startDates', () => {
    const legacy = task({ id: 'legacy', startDate: '2026-07-14T00:00:00.000Z' });
    const legacyToday = task({ id: 'legacyToday', startDate: '2026-07-15T09:30:00.000Z' });

    expect(ids(selectOverdue([legacy, legacyToday], TODAY, NONE))).toEqual(['legacy']);
    // ...and a legacy todayStr resolves the same way.
    expect(ids(selectOverdue([legacy, legacyToday], '2026-07-15T00:00:00.000Z', NONE))).toEqual([
      'legacy',
    ]);
    expect(daysOverdue(legacy as { startDate?: string }, TODAY)).toBe(1);
    expect(toDateOnly(selectOverdue([legacy], TODAY, NONE)[0].startDate!)).toBe('2026-07-14');
  });

  it('excludes completed and cancelled items', () => {
    // 'cancelled' has no UI producer but the agent API can write it
    // (MCP dsul_update_task / TaskStatusSchema), and it has no inverse —
    // it must never resurface in a tray whose only exits assume completability.
    const pending = task({ id: 'pending', startDate: D.d1 });
    const completed = task({ id: 'completed', startDate: D.d1, status: 'completed' });
    const cancelled = task({ id: 'cancelled', startDate: D.d1, status: 'cancelled' });

    expect(ids(selectOverdue([pending, completed, cancelled], TODAY, NONE))).toEqual(['pending']);
  });

  it('excludes habits — they are date-blind and never carry forward', () => {
    const overdueHabit = habit({ startDate: D.d30 } as Partial<Item>);
    const oneOffHabit = habit({ startDate: D.d30, repeatFrequency: 'none' } as Partial<Item>);
    const t = task({ id: 'task', startDate: D.d1 });

    expect(ids(selectOverdue([overdueHabit, oneOffHabit, t], TODAY, NONE))).toEqual(['task']);
  });

  it('INCLUDES custom item types — they are task-shaped and carry-forward eligible', () => {
    // The capability, not the type name, is what admits them.
    const config = buildCustomTypeConfig({ name: 'goal', label: 'Goal', labelPlural: 'Goals' });
    expect(config.carryForwardEligible).toBe(true);
    expect(config.dateAnchored).toBe(true);

    const goal = custom({ id: 'goal', startDate: D.d3 });
    const recurringGoal = custom({ id: 'recurringGoal', startDate: D.d3, repeatFrequency: 'daily' });
    const t = task({ id: 'task', startDate: D.d1 });

    // Unhydrated custom types fall back to the same v1 template, so this holds
    // whether or not the item_types row is loaded.
    expect(ids(selectOverdue([goal, recurringGoal, t], TODAY, NONE))).toEqual(['task', 'goal']);
  });
});

describe('daysOverdue', () => {
  it('counts whole calendar days, positive when past', () => {
    expect(daysOverdue({ startDate: D.d1 }, TODAY)).toBe(1);
    expect(daysOverdue({ startDate: D.d7 }, TODAY)).toBe(7);
    expect(daysOverdue({ startDate: D.d8 }, TODAY)).toBe(8);
    expect(daysOverdue({ startDate: D.d100 }, TODAY)).toBe(100);
  });

  it('is 0 for today and for a missing date, negative for the future', () => {
    expect(daysOverdue({ startDate: D.today }, TODAY)).toBe(0);
    expect(daysOverdue({}, TODAY)).toBe(0);
    expect(daysOverdue({ startDate: D.tomorrow }, TODAY)).toBe(-1);
  });

  it('spans a DST transition without drifting', () => {
    // US DST starts 2026-03-08; a local-midnight subtraction would give 89.958
    // days here and round wrong under a naive floor.
    expect(daysOverdue({ startDate: '2026-03-01' }, '2026-07-15')).toBe(136);
    expect(daysOverdue({ startDate: '2026-03-07' }, '2026-03-09')).toBe(2);
  });
});

describe('age cohorts', () => {
  it('puts exactly 7 days in recent and 8 days in long overdue', () => {
    expect(RECENT_OVERDUE_DAYS).toBe(7);
    const seven = task({ id: 'seven', startDate: D.d7 });
    const eight = task({ id: 'eight', startDate: D.d8 });

    const { recent, long } = summarizeOverdue([seven, eight], TODAY, NONE);
    expect(ids(recent)).toEqual(['seven']);
    expect(ids(long)).toEqual(['eight']);
  });

  it('sorts recent newest-first, then long overdue oldest-first', () => {
    const items = [
      task({ id: 'd30', startDate: D.d30 }),
      task({ id: 'd3', startDate: D.d3 }),
      task({ id: 'd100', startDate: D.d100 }),
      task({ id: 'd1', startDate: D.d1 }),
      task({ id: 'd10', startDate: D.d10 }),
      task({ id: 'd5', startDate: D.d5 }),
    ];

    expect(ids(selectOverdue(items, TODAY, NONE))).toEqual([
      // recent cohort (<= 7d), newest first
      'd1',
      'd3',
      'd5',
      // long cohort (> 7d), oldest first
      'd100',
      'd30',
      'd10',
    ]);
  });

  it('splitOverdueCohorts preserves the selector order inside each slice', () => {
    const items = [
      task({ id: 'd10', startDate: D.d10 }),
      task({ id: 'd5', startDate: D.d5 }),
      task({ id: 'd100', startDate: D.d100 }),
      task({ id: 'd1', startDate: D.d1 }),
    ];
    const overdue = selectOverdue(items, TODAY, NONE);
    const { recent, long } = splitOverdueCohorts(overdue, TODAY);

    expect(ids(recent)).toEqual(['d1', 'd5']);
    expect(ids(long)).toEqual(['d100', 'd10']);
    expect(recent.length + long.length).toBe(overdue.length);
  });

  it('keeps store order for items of the same age', () => {
    const items = [
      task({ id: 'a', startDate: D.d3 }),
      task({ id: 'b', startDate: D.d3 }),
      task({ id: 'c', startDate: D.d3 }),
    ];
    expect(ids(selectOverdue(items, TODAY, NONE))).toEqual(['a', 'b', 'c']);
  });
});

describe('the summary is deliberately count-only', () => {
  /**
   * There was an `oldestOverdueDate` here, and a `summary.oldestStartDate`, and
   * this block used to assert them. Both are gone: their only consumer was the
   * "· oldest Apr 9" tail of the bar copy, and an aggregate minimum age has
   * exactly one reading — how far behind the user is — printed somewhere they
   * cannot avoid it. The per-row date stamps carry all of the useful part.
   *
   * This test is the guard, not a relic: it fails if the field comes back.
   */
  it('exposes nothing about the pile beyond its size and its order', () => {
    const summary = summarizeOverdue(
      [task({ startDate: D.d1 }), task({ startDate: D.d100 })],
      TODAY,
      NONE
    );
    expect(Object.keys(summary).sort()).toEqual(['count', 'items', 'long', 'recent']);
    expect(summary.count).toBe(2);
  });
});

describe('toDateOnly', () => {
  it('passes yyyy-MM-dd through and truncates full ISO', () => {
    expect(toDateOnly('2026-07-15')).toBe('2026-07-15');
    expect(toDateOnly('2026-07-15T00:00:00.000Z')).toBe('2026-07-15');
  });
});

/**
 * Suppression exclusion. This lives here rather than in active.test.ts because
 * the coupling is the point: selectOverdue feeds the past-due bar AND the
 * auto-age sweep, the app's only unattended writer, so "paused work is not past
 * due" has to hold at this exact seam.
 */
describe('selectOverdue + suppression', () => {
  const TZ = 'America/New_York';
  const paused = task({
    id: 'paused',
    startDate: D.d1,
    pausedAt: '2026-07-01T12:00:00Z',
    pausedUntil: '2026-09-01',
  });
  const live = task({ id: 'live', startDate: D.d1 });

  it('drops suppressed items from the selection', () => {
    const inactive = inactiveItemIdsOn([paused, live], TODAY, { userTimezone: TZ });
    expect(ids(selectOverdue([paused, live], TODAY, inactive))).toEqual(['live']);
  });

  it('brings them back once the pause resumes', () => {
    // Resumed on the 10th; TODAY is the 15th, so the interval is behind us.
    const resumed = { ...paused, pausedUntil: '2026-07-10' } as Item;
    const inactive = inactiveItemIdsOn([resumed, live], TODAY, { userTimezone: TZ });
    expect(inactive.size).toBe(0);
    expect(ids(selectOverdue([resumed, live], TODAY, inactive)).sort()).toEqual(['live', 'paused']);
  });

  it('does not count suppressed items in the bar summary', () => {
    const inactive = inactiveItemIdsOn([paused, live], TODAY, { userTimezone: TZ });
    expect(summarizeOverdue([paused, live], TODAY, inactive).count).toBe(1);
  });

  it('an empty set changes nothing (the pre-filtered-caller path)', () => {
    expect(ids(selectOverdue([paused, live], TODAY, NONE)).sort()).toEqual(['live', 'paused']);
  });
});
