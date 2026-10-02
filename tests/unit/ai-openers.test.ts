import { describe, it, expect } from 'vitest';
import { format, subDays, addDays } from 'date-fns';
import {
  buildChatOpeners,
  BUSY_DAY_THRESHOLD,
  EVENING_FROM_MIN,
  HOME_OPENERS,
  NEW_CHAT_OPENERS,
  openToday,
  todaysItems,
  type OpenerContext,
  type OpenerOptions,
} from '@/lib/ai-openers';
import type { Item } from '@/lib/planner-types';

/**
 * Openers replace a blank input, so the thing worth pinning is that they stay
 * RELEVANT — a static list would need no tests. Three rules carry the weight:
 * an opener may never be offered when its condition is false ("what's been
 * sitting?" on a clear week is noise), the hour decides whether the offer is
 * about today or about tomorrow, and the reflective one must survive every
 * state, because a brand new account has nothing else to offer.
 */

const TODAY = '2026-08-26';
const tz = 'UTC';
/** 09:30 and 19:00, either side of the 16:00 turn. */
const MORNING = 9 * 60 + 30;
const EVENING = 19 * 60;

function task(id: string, startDate?: string, status: 'pending' | 'completed' = 'pending'): Item {
  return {
    type: 'task',
    id,
    title: id,
    status,
    isScheduled: false,
    order: 0,
    completedDates: [],
    ...(startDate ? { startDate } : {}),
  } as Item;
}

const ctx = (items: Item[]): OpenerContext => ({
  items,
  todayStr: TODAY,
  userTimezone: tz,
});

/** A surface's options: three, in the morning, unless a test says otherwise. */
const opts = (o: Partial<OpenerOptions> = {}): OpenerOptions => ({
  max: NEW_CHAT_OPENERS,
  minutesNow: MORNING,
  ...o,
});

const ids = (items: Item[], o: Partial<OpenerOptions> = {}) =>
  buildChatOpeners(ctx(items), opts(o)).map((x) => x.id);

const past = (days: number) => format(subDays(new Date(TODAY), days), 'yyyy-MM-dd');

describe('buildChatOpeners', () => {
  it('always ends with the reflective opener, even with an empty planner', () => {
    const openers = buildChatOpeners(ctx([]), opts());
    expect(openers.at(-1)?.id).toBe('reflect');
    expect(openers.length).toBeGreaterThan(0);
  });

  it('offers to plan the day before 16:00 while it is not busy', () => {
    expect(ids([])).toContain('plan');
    expect(ids([task('a', TODAY)])).toContain('plan');
    expect(ids([task('a', addDays(new Date(TODAY), 3).toISOString().slice(0, 10))])).toContain('plan');
    expect(ids([], { minutesNow: EVENING_FROM_MIN - 1 })).toContain('plan');
  });

  it('turns to tomorrow from 16:00: plan tomorrow, and review today', () => {
    const got = ids([], { minutesNow: EVENING_FROM_MIN });
    expect(got).toContain('plan-tomorrow');
    expect(got).toContain('review');
    expect(got).not.toContain('plan');
    expect(got).not.toContain('triage');
    // And neither evening offer in the morning.
    expect(ids([])).not.toContain('plan-tomorrow');
    expect(ids([])).not.toContain('review');
  });

  it('offers triage once today crosses the busy threshold', () => {
    const full = Array.from({ length: BUSY_DAY_THRESHOLD }, (_, i) => task(`t${i}`, TODAY));
    expect(ids(full)).toContain('triage');
    expect(ids(full.slice(0, BUSY_DAY_THRESHOLD - 1))).not.toContain('triage');
  });

  it('never offers triage and plan together — they contradict each other', () => {
    const full = Array.from({ length: BUSY_DAY_THRESHOLD + 4 }, (_, i) => task(`t${i}`, TODAY));
    const got = ids(full);
    expect(got).toContain('triage');
    expect(got).not.toContain('plan');
  });

  it('does not triage a busy day once the day has turned', () => {
    const full = Array.from({ length: BUSY_DAY_THRESHOLD + 4 }, (_, i) => task(`t${i}`, TODAY));
    expect(ids(full, { minutesNow: EVENING })).not.toContain('triage');
  });

  it('offers "what\'s been sitting" only when something is actually past due', () => {
    expect(ids([task('old', past(5))])).toContain('let-go');
    expect(ids([task('now', TODAY)])).not.toContain('let-go');
  });

  it('ignores completed work when deciding whether the day is busy', () => {
    // A day of finished tasks is a clear day, not a busy one — the opener has
    // to read open loops, not row counts.
    const done = Array.from({ length: BUSY_DAY_THRESHOLD + 2 }, (_, i) =>
      task(`d${i}`, TODAY, 'completed')
    );
    const got = ids(done);
    expect(got).toContain('plan');
    expect(got).not.toContain('triage');
  });

  it('treats work a routine paused as neither due today nor past due', () => {
    const items = [task('paused', past(5))];
    const got = buildChatOpeners({ ...ctx(items), inactiveIds: new Set(['paused']) }, opts()).map(
      (o) => o.id
    );
    // Suppressed work is set aside on purpose. Offering to triage it is the app
    // arguing with a decision the user already made (lib/active.ts).
    expect(got).not.toContain('let-go');
    expect(got).toContain('plan');
  });

  it('matches the mocks: a morning and an evening with things sitting', () => {
    const sitting = [task('old', past(9))];
    // Mock 1, Ask home.
    expect(
      buildChatOpeners(ctx(sitting), { max: HOME_OPENERS, minutesNow: MORNING }).map((o) => o.label)
    ).toEqual(['Plan my day', "What's been sitting?"]);
    // Mock 6, a new chat.
    expect(
      buildChatOpeners(ctx(sitting), {
        max: NEW_CHAT_OPENERS,
        minutesNow: EVENING,
        includeStart: true,
      }).map((o) => o.label)
    ).toEqual(['Plan tomorrow', "What's been sitting?", 'Review today', 'Help me start…']);
  });

  it.each([
    ['Ask home', HOME_OPENERS],
    ['a new chat', NEW_CHAT_OPENERS],
  ])('never returns more than the surface asks for (%s)', (_, max) => {
    const items = [
      ...Array.from({ length: BUSY_DAY_THRESHOLD + 1 }, (_, i) => task(`t${i}`, TODAY)),
      task('old-1', past(9)),
      task('old-2', past(9)),
    ];
    for (const minutesNow of [MORNING, EVENING]) {
      expect(buildChatOpeners(ctx(items), { max, minutesNow })).toHaveLength(max);
      // "Help me start…" comes on top of the count, and always last.
      const withStart = buildChatOpeners(ctx(items), { max, minutesNow, includeStart: true });
      expect(withStart).toHaveLength(max + 1);
      expect(withStart.at(-1)?.id).toBe('start');
    }
    expect(buildChatOpeners(ctx(items), { max: 0, minutesNow: MORNING })).toEqual([]);
  });

  it('makes "Help me start…" a prefill that sends nothing, and only when asked for', () => {
    expect(ids([])).not.toContain('start');
    const start = buildChatOpeners(ctx([]), opts({ includeStart: true })).at(-1);
    expect(start).toMatchObject({ id: 'start', label: 'Help me start…', mode: 'prefill' });
    expect(start?.prompt).toBe('Help me start ');
    // Everything else is a send.
    for (const o of buildChatOpeners(ctx([task('old', past(5))]), opts({ max: 9 }))) {
      expect(o.mode ?? 'send').toBe('send');
    }
  });

  it('gives every opener a distinct id and a non-empty prompt', () => {
    for (const minutesNow of [MORNING, EVENING]) {
      const openers = buildChatOpeners(ctx([task('old', past(5))]), {
        max: 9,
        minutesNow,
        includeStart: true,
      });
      expect(new Set(openers.map((o) => o.id)).size).toBe(openers.length);
      for (const o of openers) {
        expect(o.label.length).toBeGreaterThan(0);
        expect(o.prompt.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the copy contract — no opener names a failure or counts a miss', () => {
    // memory/plans/ai-vision.md: the whole point of the surface is that it does
    // not manufacture guilt. A regression here is a product regression.
    const busy = Array.from({ length: BUSY_DAY_THRESHOLD }, (_, i) => task(`t${i}`, TODAY));
    const everything = [...busy, task('old', past(30))];

    const forbidden = /overdue|late|behind|missed|failed|should have|neglect/i;
    for (const items of [[], [task('a', TODAY)], [task('old', past(30))], everything]) {
      for (const minutesNow of [0, MORNING, EVENING_FROM_MIN, EVENING, 23 * 60 + 59]) {
        for (const o of buildChatOpeners(ctx(items), { max: 9, minutesNow, includeStart: true })) {
          expect(o.label).not.toMatch(forbidden);
          expect(o.prompt).not.toMatch(forbidden);
        }
      }
    }
  });
});

describe('agreeing with the grid', () => {
  /**
   * `todaysItems` and `openToday` decide which opener the user is offered and
   * what Ask home's load line counts, and disagreeing with `deriveDayItems`
   * means the AI calls a day busy that the grid draws empty. The rule that is
   * easy to miss: recurrence says which WEEKDAYS a series lands on, not when it
   * begins.
   */
  const recurring = (id: string, startDate?: string): Item =>
    ({
      type: 'task',
      id,
      title: id,
      status: 'pending',
      isScheduled: false,
      order: 0,
      completedDates: [],
      repeatFrequency: 'daily',
      ...(startDate ? { startDate } : {}),
    }) as Item;

  it('does not count a recurring series that has not started yet', () => {
    // A daily task starting in December is not on today's plate in August,
    // however cheerfully shouldShowOnDate says "daily".
    expect(openToday(ctx([recurring('future', '2026-12-01')]))).toHaveLength(0);
    expect(todaysItems(ctx([recurring('future', '2026-12-01')]))).toHaveLength(0);
  });

  it('counts a recurring series that has already started', () => {
    expect(openToday(ctx([recurring('running', '2026-01-01')]))).toHaveLength(1);
  });

  it('does not count a recurring task with no start date at all', () => {
    expect(openToday(ctx([recurring('undated')]))).toHaveLength(0);
  });

  it('counts a habit due today, which carries no start date by design', () => {
    // Habits are date-blind: recurrence alone decides, exactly as the grid's
    // habit filter does. Excluding them for having no startDate would call a
    // day of habits empty.
    const habit = {
      type: 'habit',
      id: 'stretch',
      title: 'Stretch',
      group: 'Personal',
      streak: 0,
      status: 'pending',
      completedDates: [],
      skippedDates: [],
      dailyCounts: {},
      repeatFrequency: 'daily',
    } as unknown as Item;
    expect(openToday(ctx([habit]))).toHaveLength(1);
    // Ticked today, it is still today's, but no longer open.
    const ticked = { ...habit, completedDates: [TODAY] } as unknown as Item;
    expect(todaysItems(ctx([ticked]))).toHaveLength(1);
    expect(openToday(ctx([ticked]))).toHaveLength(0);
  });

  it('ignores subtasks, which no day-scoped surface shows', () => {
    const sub = { ...(task('sub', TODAY) as Record<string, unknown>), parentItemId: 'p1' } as Item;
    expect(todaysItems(ctx([sub]))).toHaveLength(0);
  });

  it('keeps a finished one-shot on today, and out of what is open', () => {
    const done = task('done', TODAY, 'completed');
    expect(todaysItems(ctx([done]))).toHaveLength(1);
    expect(openToday(ctx([done]))).toHaveLength(0);
  });

  it('leaves out what a routine or season paused', () => {
    const items = [task('a', TODAY)];
    expect(todaysItems({ ...ctx(items), inactiveIds: new Set(['a']) })).toHaveLength(0);
  });
});
