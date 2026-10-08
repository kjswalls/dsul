import { describe, it, expect } from 'vitest';
import { format, subDays, addDays } from 'date-fns';
import {
  buildChatOpeners,
  buildOpenerPreviews,
  BUSY_DAY_THRESHOLD,
  PREVIEW_TITLE_MAX,
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

/**
 * The setup column's previews (components/ai/rail/ask-setup.tsx): what Ask's
 * chips would be today, quoted, each with a line on what it does, for someone
 * with nothing connected yet. They are the chips, so they follow the chips'
 * rules; the line under each is held to the same copy contract.
 */
describe('buildOpenerPreviews', () => {
  const busy = Array.from({ length: BUSY_DAY_THRESHOLD }, (_, i) => task(`t${i}`, TODAY));

  it("is buildChatOpeners' list, in its order, without \"Help me start…\"", () => {
    for (const items of [[], [task('old', past(5))], busy, [...busy, task('old', past(30))]]) {
      for (const minutesNow of [0, MORNING, EVENING_FROM_MIN, EVENING]) {
        const previews = buildOpenerPreviews(ctx(items), { max: 3, minutesNow });
        const chips = buildChatOpeners(ctx(items), { max: 3, minutesNow });
        expect(previews.map((p) => [p.id, p.label])).toEqual(chips.map((c) => [c.id, c.label]));
        expect(previews.map((p) => p.id)).not.toContain('start');
      }
    }
  });

  it('describes every opener it can offer, under the copy contract', () => {
    const forbidden = /overdue|late|behind|missed|failed|should have|neglect/i;
    const seen = new Set<string>();
    for (const items of [[], [task('old', past(5))], busy, [...busy, task('old', past(30))]]) {
      for (const minutesNow of [0, MORNING, EVENING_FROM_MIN, EVENING]) {
        for (const p of buildOpenerPreviews(ctx(items), { max: 9, minutesNow })) {
          seen.add(p.id);
          expect(p.description.length, p.id).toBeGreaterThan(20);
          expect(p.description).not.toMatch(forbidden);
          // No em dashes in copy (CLAUDE.md), and it ends as a sentence.
          expect(p.description).not.toMatch(/—/);
          expect(p.description).toMatch(/\.$/);
        }
      }
    }
    // Every id buildChatOpeners can produce, but the prefill.
    expect([...seen].sort()).toEqual(['let-go', 'plan', 'plan-tomorrow', 'reflect', 'review', 'triage']);
  });

  it("says the evening three in the spec's words", () => {
    const previews = buildOpenerPreviews(ctx([task('Fix the squeaky door', past(5))]), { max: 3, minutesNow: EVENING });
    expect(previews).toEqual([
      {
        id: 'plan-tomorrow',
        label: 'Plan tomorrow',
        description: "Drafts tomorrow from what's on it and your braindump. You keep, move or drop each line.",
      },
      {
        id: 'let-go',
        label: "What's been sitting?",
        description:
          'Goes through things that have waited a while, like “Fix the squeaky door”, and helps you keep them or let them go.',
      },
      {
        id: 'review',
        label: 'Review today',
        description: "Looks back at today with you: what got done, and what you'd carry into tomorrow.",
      },
    ]);
  });

  it("quotes the first thing that's been sitting, as selectOverdue orders them, cut at a word when long", () => {
    // The recent cohort first, newest first: three days beats five.
    const two = buildOpenerPreviews(ctx([task('Older one', past(5)), task('Newer one', past(3))]), {
      max: 3,
      minutesNow: MORNING,
    });
    expect(two.find((p) => p.id === 'let-go')?.description).toContain('like “Newer one”');

    const long = 'Call the insurance company about the claim from the spring storm';
    const [cut] = buildOpenerPreviews(ctx([task(long, past(2))]), { max: 3, minutesNow: MORNING })
      .filter((p) => p.id === 'let-go')
      .map((p) => /like “(.*)”/.exec(p.description)?.[1]);
    expect(cut).toBe('Call the insurance company about the…');
    expect((cut ?? '').length).toBeLessThanOrEqual(PREVIEW_TITLE_MAX + 1);

    // A title with nothing to quote drops the example rather than quoting nothing.
    const blank = buildOpenerPreviews(ctx([task('   ', past(2))]), { max: 3, minutesNow: MORNING });
    expect(blank.find((p) => p.id === 'let-go')?.description).toBe(
      'Goes through things that have waited a while, and helps you keep them or let them go.'
    );
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
