import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ITEM_VERBS, eligibleVerbs, type VerbContext } from '@/lib/item-verbs';
import { usePlannerStore } from '@/lib/planner-store';
import type { Item } from '@/lib/planner-types';

/**
 * The shared verb declarations. What each surface does with them is tested
 * where it renders (commands.test.ts, member-row-actions.test.tsx); this pins
 * the one thing they must agree on — that the day is an argument, and the
 * caller's knowledge of that day narrows the per-day verbs and nothing else.
 */

const TODAY = '2026-09-26'; // Saturday
const TZ = 'UTC';

const ctxOn = (dateStr: string, over: Partial<VerbContext> = {}): VerbContext => ({
  dateStr,
  date: new Date(`${dateStr}T12:00:00Z`),
  todayStr: TODAY,
  tz: TZ,
  milestoneIds: new Set(),
  ...over,
});

const habit = (over: Record<string, unknown> = {}): Item =>
  ({
    id: 'h1',
    type: 'habit',
    title: 'Stretch',
    status: 'pending',
    repeatFrequency: 'daily',
    completedDates: [],
    skippedDates: [],
    dailyCounts: {},
    streak: 0,
    ...over,
  }) as unknown as Item;

const task = (over: Record<string, unknown> = {}): Item =>
  ({
    id: 't1',
    type: 'task',
    title: 'Fix sink',
    status: 'pending',
    order: 0,
    isScheduled: false,
    completedDates: [],
    ...over,
  }) as unknown as Item;

const ids = (item: Item, ctx: VerbContext) => eligibleVerbs(item, ctx).map((v) => v.id);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
});
afterEach(() => vi.useRealTimers());

describe('item verbs', () => {
  it('acts on the day it is handed, not on today', () => {
    const h = habit({ completedDates: ['2026-09-24'] });
    expect(ITEM_VERBS.complete.eligible(h, ctxOn('2026-09-24'))).toBe(false);
    expect(ITEM_VERBS.complete.eligible(h, ctxOn(TODAY))).toBe(true);
    expect(ITEM_VERBS.tick.label(h, ctxOn('2026-09-24'))).toBe('Undo today');
  });

  it('offers no per-day verb on a day the caller knows the item is absent from', () => {
    const verbs = ids(habit(), ctxOn(TODAY, { occurrence: 'absent' }));
    for (const perDay of ['complete', 'tick', 'skip', 'unskip'] as const) expect(verbs).not.toContain(perDay);
    // Dateless verbs are untouched by it.
    expect(verbs).toContain('pause');
    expect(verbs).toContain('delete');
  });

  it('answers a skipped day with Unskip, never a tick', () => {
    const verbs = ids(habit({ skippedDates: [TODAY] }), ctxOn(TODAY));
    expect(verbs).toContain('unskip');
    expect(verbs).not.toContain('tick');
    expect(verbs).not.toContain('skip');
  });

  it('skips only a live day when the caller knows the state', () => {
    expect(ITEM_VERBS.skip.eligible(habit(), ctxOn('2026-09-20', { occurrence: 'open' }))).toBe(false);
    expect(ITEM_VERBS.skip.eligible(habit(), ctxOn(TODAY, { occurrence: 'due' }))).toBe(true);
    // Unknown (the palette): gated on the item's own records alone.
    expect(ITEM_VERBS.skip.eligible(habit(), ctxOn(TODAY))).toBe(true);
  });

  it('reads pause state off wall-clock today, whatever day is being acted on', () => {
    // Paused until tomorrow: paused now, even while looking at next week.
    const paused = habit({ pausedAt: '2026-09-20T00:00:00Z', pausedUntil: '2026-09-27' });
    const nextWeek = ctxOn('2026-10-03');
    expect(ITEM_VERBS.resume.eligible(paused, nextWeek)).toBe(true);
    expect(ITEM_VERBS.pause.eligible(paused, nextWeek)).toBe(false);
  });

  it('keeps the carries off recurring items and undated ones', () => {
    const series = task({ startDate: '2026-09-01', repeatFrequency: 'daily' });
    expect(ids(series, ctxOn(TODAY))).not.toContain('nextDay');
    // Reschedule is the exception: a picked day becomes the series start.
    expect(ids(series, ctxOn(TODAY))).toContain('reschedule');
    expect(ITEM_VERBS.reschedule.label(series, ctxOn(TODAY))).toBe('Reschedule');
    const undated = task();
    expect(ids(undated, ctxOn(TODAY))).not.toContain('nextDay');
    expect(ids(undated, ctxOn(TODAY))).toContain('reschedule');
    expect(ITEM_VERBS.reschedule.label(undated, ctxOn(TODAY))).toBe('Schedule');
  });

  it('never sends a milestone to the braindump', () => {
    const dated = task({ startDate: TODAY, isScheduled: true, timeBucket: 'anytime' });
    expect(ITEM_VERBS.braindump.eligible(dated, ctxOn(TODAY))).toBe(true);
    expect(ITEM_VERBS.braindump.eligible(dated, ctxOn(TODAY, { milestoneIds: new Set(['t1']) }))).toBe(false);
  });

  it('writes a recurring completion to the day handed in', () => {
    const series = task({ startDate: '2026-09-01', repeatFrequency: 'daily' });
    usePlannerStore.setState({
      items: [series],
      tasks: [series],
      habits: [],
      userTimezone: TZ,
      selectedDate: new Date(`${TODAY}T12:00:00Z`),
    } as never);
    ITEM_VERBS.complete.run(series, ctxOn('2026-09-24'));
    const after = usePlannerStore.getState().items[0] as unknown as { completedDates: string[]; status: string };
    expect(after.completedDates).toEqual(['2026-09-24']);
    expect(after.status).toBe('pending');
  });
});
