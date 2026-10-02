import { describe, it, expect } from 'vitest';
import {
  ACTIVITY_WINDOW_MS,
  MAX_ACTIVITY_ROWS,
  activityRows,
  dayEndFromReview,
  dayLoad,
  dayPart,
  formatLoadMinutes,
  greeting,
  greetingName,
  loadLine,
  needsYou,
  type DayLoad,
} from '@/lib/ask-home';
import { clockTime } from '@/lib/format-chat-timestamp';
import type { OpenerContext } from '@/lib/ai-openers';
import type { ConversationSummary } from '@/lib/conversation-types';
import type { Item } from '@/lib/planner-types';

/**
 * Ask home's words (lib/ask-home.ts). What is pinned here is what a glance at
 * the rail must never get wrong: the greeting turns at the right minute, the
 * load line keeps the copy contract over every input (no miss, no lateness,
 * nothing undone counted against the user, no bedtime the app made up), and
 * the activity list is a short, honest, de-duplicated glance.
 */

const TODAY = '2026-10-02';
const TZ = 'UTC';
const NOW = Date.parse('2026-10-02T15:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

function task(id: string, over: Record<string, unknown> = {}): Item {
  return {
    type: 'task',
    id,
    title: id,
    status: 'pending',
    isScheduled: false,
    order: 0,
    completedDates: [],
    startDate: TODAY,
    ...over,
  } as Item;
}

const ctx = (items: Item[], inactiveIds?: Set<string>): OpenerContext => ({
  items,
  todayStr: TODAY,
  userTimezone: TZ,
  inactiveIds,
});

function convo(id: string, over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    itemId: null,
    title: `Chat ${id}`,
    renamed: false,
    starred: false,
    answerer: null,
    openclawSeen: false,
    changes: {} as ConversationSummary['changes'],
    messageCount: 2,
    lastMessageAt: ago(30 * MIN),
    createdAt: ago(40 * MIN),
    ...over,
  };
}

const rows = (items: Item[], conversations: ConversationSummary[] = [], userTimezone = TZ) =>
  activityRows({ items, conversations, now: NOW, todayStr: TODAY, userTimezone });

/* ── greeting ──────────────────────────────────────────────────────────── */

describe('dayPart', () => {
  it.each([
    [0, 'evening'],
    [3 * 60 + 59, 'evening'],
    [4 * 60, 'morning'],
    [11 * 60 + 59, 'morning'],
    [12 * 60, 'afternoon'],
    [16 * 60 + 59, 'afternoon'],
    [17 * 60, 'evening'],
    [23 * 60 + 59, 'evening'],
  ])('%i minutes is %s', (minutes, part) => {
    expect(dayPart(minutes)).toBe(part);
  });
});

describe('greeting', () => {
  it('is the day part and the first word of the name', () => {
    expect(greeting(9 * 60, 'Kirby Example')).toBe('Morning, Kirby');
    expect(greeting(13 * 60, 'Kirby')).toBe('Afternoon, Kirby');
    expect(greeting(20 * 60, '  Kirby  ')).toBe('Evening, Kirby');
  });

  it('is just the day part with no name, and "Hello" before the clock is known', () => {
    expect(greeting(9 * 60, null)).toBe('Morning');
    expect(greeting(9 * 60, '   ')).toBe('Morning');
    expect(greeting(null, 'Kirby')).toBe('Hello, Kirby');
    expect(greeting(null, null)).toBe('Hello');
  });

  it('leaves out a "first name" too long to be one', () => {
    expect(greetingName('a'.repeat(24))).toBe('a'.repeat(24));
    expect(greetingName('a'.repeat(25))).toBeNull();
    expect(greeting(9 * 60, 'itstoughbeingkirby@example.com')).toBe('Morning');
  });
});

/* ── the day's load ────────────────────────────────────────────────────── */

describe('dayLoad', () => {
  const at = { minutesNow: 10 * 60, dayEndMin: null };

  it('counts the openers’ day: open and done today, nothing else', () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) => task(`open${i}`)),
      task('done1', { status: 'completed' }),
      task('done2', { status: 'completed' }),
      // Neither open nor done: a cancelled task.
      task('cancelled', { status: 'cancelled' }),
      // Not today's: another day, a subtask, no date, a paused item.
      task('tomorrow', { startDate: '2026-10-03' }),
      task('sub', { parentItemId: 'open0' }),
      task('undated', { startDate: undefined }),
      task('paused'),
    ];
    const load = dayLoad(ctx(items, new Set(['paused'])), at);
    expect(load).toEqual({ open: 6, done: 2, plannedMin: null, freeMin: null });
    expect(loadLine(load)).toBe('8 things today · 2 done.');
  });

  it('counts a skipped day as neither open nor done (D13: skipped and cancelled excluded)', () => {
    const items = [
      task('open'),
      task('done', { status: 'completed' }),
      task('skippedTask', { repeatFrequency: 'daily', startDate: '2026-09-01', skippedDates: [TODAY] }),
      {
        type: 'habit',
        id: 'skippedHabit',
        title: 'Stretch',
        streak: 2,
        status: 'pending',
        completedDates: [],
        skippedDates: [TODAY],
        dailyCounts: {},
        repeatFrequency: 'daily',
      } as unknown as Item,
    ];
    expect(dayLoad(ctx(items), at)).toMatchObject({ open: 1, done: 1 });
    // Not skipped, the same two count.
    const kept = items.map((i) => ({ ...i, skippedDates: [] }) as Item);
    expect(dayLoad(ctx(kept), at)).toMatchObject({ open: 3, done: 1 });
  });

  it('sums durations only when at least half the open items carry one', () => {
    const half = [task('a', { duration: 30 }), task('b', { duration: 30 }), task('c'), task('d')];
    expect(dayLoad(ctx(half), at).plannedMin).toBe(60);

    const quarter = [task('a', { duration: 60 }), task('b'), task('c'), task('d')];
    expect(dayLoad(ctx(quarter), at).plannedMin).toBeNull();
  });

  it('calls under 30 minutes planned no plan at all', () => {
    expect(dayLoad(ctx([task('a', { duration: 10 }), task('b', { duration: 10 })]), at).plannedMin).toBeNull();
    expect(dayLoad(ctx([task('a', { duration: 15 }), task('b', { duration: 15 })]), at).plannedMin).toBe(30);
  });

  it('counts a done item’s duration out of what is planned', () => {
    const items = [task('a', { duration: 60 }), task('b', { duration: 120, status: 'completed' })];
    expect(dayLoad(ctx(items), at).plannedMin).toBe(60);
  });

  it('offers hours free only with a day’s end, and only 30 minutes or more', () => {
    const items = [task('a', { duration: 300 })];
    expect(dayLoad(ctx(items), { minutesNow: 600, dayEndMin: null }).freeMin).toBeNull();
    expect(dayLoad(ctx(items), { minutesNow: 600, dayEndMin: 1260 }).freeMin).toBe(360);
    expect(dayLoad(ctx([task('a', { duration: 30 })]), { minutesNow: 1200, dayEndMin: 1260 }).freeMin).toBe(30);
    expect(dayLoad(ctx([task('a', { duration: 30 })]), { minutesNow: 1210, dayEndMin: 1260 }).freeMin).toBeNull();
    // Past the day's end: no negative hours, no line about them.
    expect(dayLoad(ctx(items), { minutesNow: 1300, dayEndMin: 1260 }).freeMin).toBeNull();
  });

  it('never offers free time without a plan to subtract', () => {
    expect(dayLoad(ctx([task('a')]), { minutesNow: 600, dayEndMin: 1260 }).freeMin).toBeNull();
  });
});

describe('"6h free" only while the end-of-day review is on', () => {
  const items = [task('a', { duration: 180 }), task('b', { duration: 120 })];
  const line = (enabled: boolean) =>
    loadLine(dayLoad(ctx(items), { minutesNow: 600, dayEndMin: dayEndFromReview(enabled, '21:00') }));

  it('reads the plan and the hours free with the review on', () => {
    expect(line(true)).toBe('About 5h planned, 6h free.');
  });

  it('reads the plan alone with it off, its default', () => {
    expect(line(false)).toBe('About 5h planned.');
  });
});

describe('dayEndFromReview', () => {
  it.each([
    [true, '21:00', 1260],
    [true, '9:30', 570],
    [true, ' 22:15 ', 1335],
    [false, '21:00', null],
    [true, '', null],
    [true, null, null],
    [true, '25:00', null],
    [true, '21:60', null],
    [true, 'nine', null],
  ])('enabled %s at %j is %j', (enabled, time, expected) => {
    expect(dayEndFromReview(enabled, time)).toBe(expected);
  });
});

describe('formatLoadMinutes', () => {
  it.each([
    [0, '0m'],
    [45, '45m'],
    [59, '59m'],
    [60, '1h'],
    [74, '1h'],
    [75, '1.5h'],
    [300, '5h'],
    [330, '5.5h'],
    [345, '6h'],
  ])('%i minutes reads %s', (minutes, text) => {
    expect(formatLoadMinutes(minutes)).toBe(text);
  });
});

describe('loadLine', () => {
  it('says each shape of day, in its first form that applies', () => {
    const l = (o: Partial<DayLoad>) => loadLine({ open: 0, done: 0, plannedMin: null, freeMin: null, ...o });
    expect(l({ open: 3, plannedMin: 300, freeMin: 360 })).toBe('About 5h planned, 6h free.');
    expect(l({ open: 3, plannedMin: 45 })).toBe('About 45m planned.');
    expect(l({ open: 1 })).toBe('1 thing today.');
    expect(l({ open: 6, done: 2 })).toBe('8 things today · 2 done.');
    expect(l({ done: 2 })).toBe('2 done today.');
    expect(l({ done: 1 })).toBe('1 done today.');
    expect(l({})).toBeNull();
  });

  // The copy contract (lib/ai-openers.ts): never a miss, never lateness, never
  // what is undone counted against the user, and no "more" without a time.
  const SHAPE = /^(About \d+(\.5)?h|About \d+m|\d+ things? today|\d+ done today)/;
  const BANNED = /\b(left|yet|still|only|behind|overdue|late|more)\b|without a time/i;

  it('keeps the copy contract over every shape of day', () => {
    let lines = 0;
    for (const open of [0, 1, 2, 6, 12]) {
      for (const done of [0, 1, 2, 9]) {
        for (const plannedMin of [null, 30, 45, 59, 60, 74, 75, 90, 300, 330, 600]) {
          for (const freeMin of plannedMin === null ? [null] : [null, 30, 45, 60, 360, 720]) {
            const line = loadLine({ open, done, plannedMin, freeMin });
            if (open === 0 && done === 0 && plannedMin === null) {
              expect(line).toBeNull();
              continue;
            }
            expect(line).toMatch(SHAPE);
            expect(line).not.toMatch(BANNED);
            lines++;
          }
        }
      }
    }
    expect(lines).toBeGreaterThan(400);
  });
});

/* ── needs you ─────────────────────────────────────────────────────────── */

describe('needsYou', () => {
  it('lists what an agent is waiting on, longest-waiting first, unstamped leading', () => {
    const items = [
      task('recent', { assignee: 'openclaw', aiStatus: 'blocked', aiStatusAt: ago(5 * MIN) }),
      task('old', { assignee: 'openclaw', aiStatus: 'blocked', aiStatusAt: ago(3 * HOUR) }),
      task('unstamped', { assignee: 'beacon', aiStatus: 'blocked' }),
      task('working', { assignee: 'openclaw', aiStatus: 'working', aiStatusAt: ago(MIN) }),
      task('nobody', { aiStatus: 'blocked' }),
      { type: 'habit', id: 'habit', title: 'h', assignee: 'openclaw', aiStatus: 'blocked' } as unknown as Item,
    ];
    expect(needsYou(items).map((i) => i.id)).toEqual(['unstamped', 'old', 'recent']);
  });
});

/* ── with AI activity ──────────────────────────────────────────────────── */

describe('activityRows', () => {
  it('words each run: in flight, gone quiet, back, couldn’t finish', () => {
    const got = rows([
      task('flight', { title: 'Gift for Ari', assignee: 'openclaw', aiStatus: 'working', aiStatusAt: ago(12 * MIN) }),
      task('queued', { assignee: 'beacon', aiStatus: 'queued', aiStatusAt: ago(30 * MIN) }),
      task('quiet', { assignee: 'openclaw', aiStatus: 'working', aiStatusAt: ago(2 * HOUR) }),
      task('back', { title: 'Phone plans', assignee: 'openclaw', aiStatus: 'done', aiStatusAt: ago(3 * HOUR) }),
      task('failed', { assignee: 'openclaw', aiStatus: 'failed', aiStatusAt: ago(4 * HOUR) }),
    ]);
    expect(got).toEqual([
      { kind: 'agent', itemId: 'flight', title: 'Gift for Ari', state: 'working', meta: 'OpenClaw · 12m', at: NOW - 12 * MIN },
      { kind: 'agent', itemId: 'queued', title: 'queued', state: 'working', meta: 'AI · 30m', at: NOW - 30 * MIN },
      { kind: 'agent', itemId: 'quiet', title: 'quiet', state: 'quiet', meta: 'Gone quiet', at: NOW - 2 * HOUR },
      { kind: 'agent', itemId: 'back', title: 'Phone plans', state: 'back', meta: 'back', at: NOW - 3 * HOUR },
      { kind: 'agent', itemId: 'failed', title: 'failed', state: 'failed', meta: "Couldn't finish", at: NOW - 4 * HOUR },
    ]);
  });

  it('keeps a finished run for a day, and only with a stamp', () => {
    const got = rows([
      task('inside', { assignee: 'openclaw', aiStatus: 'done', aiStatusAt: ago(ACTIVITY_WINDOW_MS) }),
      task('outside', { assignee: 'openclaw', aiStatus: 'done', aiStatusAt: ago(ACTIVITY_WINDOW_MS + MIN) }),
      task('failedOld', { assignee: 'openclaw', aiStatus: 'failed', aiStatusAt: ago(2 * ACTIVITY_WINDOW_MS) }),
      task('unstamped', { assignee: 'openclaw', aiStatus: 'done' }),
    ]);
    expect(got.map((r) => (r.kind === 'agent' ? r.itemId : r.conversationId))).toEqual(['inside']);
  });

  it('leaves out what is in Needs you, the conversation about it included', () => {
    const got = rows(
      [task('blocked', { assignee: 'openclaw', aiStatus: 'blocked', aiStatusAt: ago(MIN) })],
      [convo('c1', { itemId: 'blocked' })]
    );
    expect(got).toEqual([]);
  });

  it('leaves out what is not an agent state at all, and habits', () => {
    const got = rows([
      task('odd', { assignee: 'openclaw', aiStatus: 'toString', aiStatusAt: ago(MIN) }),
      task('unassigned', { aiStatus: 'working', aiStatusAt: ago(MIN) }),
      { type: 'habit', id: 'habit', title: 'h', assignee: 'openclaw', aiStatus: 'working' } as unknown as Item,
    ]);
    expect(got).toEqual([]);
  });

  it("lists today's conversations, titled with the item's live title, once per item", () => {
    const got = rows(
      [
        task('run', { assignee: 'openclaw', aiStatus: 'working', aiStatusAt: ago(5 * MIN) }),
        task('taxes', { title: 'File taxes' }),
      ],
      [
        convo('general', { title: 'Plan for today', lastMessageAt: ago(2 * HOUR) }),
        // The run's own conversation: the run's row stands for both.
        convo('aboutRun', { itemId: 'run', lastMessageAt: ago(MIN) }),
        // Two about one item today: the newer one shows.
        convo('taxesOld', { itemId: 'taxes', title: 'Old name', lastMessageAt: ago(4 * HOUR) }),
        convo('taxesNew', { itemId: 'taxes', title: 'Old name', lastMessageAt: ago(3 * HOUR) }),
        // About an item that is gone: its saved title.
        convo('gone', { itemId: 'deleted', title: 'Find a plumber', lastMessageAt: ago(5 * HOUR) }),
        // Yesterday's.
        convo('yesterday', { lastMessageAt: '2026-10-01T23:59:00Z' }),
        convo('broken', { lastMessageAt: 'not a date' }),
      ]
    );
    expect(got.map((r) => [r.kind, r.kind === 'agent' ? r.itemId : r.conversationId, r.title])).toEqual([
      ['agent', 'run', 'run'],
      ['conversation', 'general', 'Plan for today'],
      ['conversation', 'taxesNew', 'File taxes'],
      ['conversation', 'gone', 'Find a plumber'],
    ]);
    const general = got[1];
    expect(general.kind === 'conversation' && general.itemId).toBeNull();
  });

  it("says whether an item conversation's item is done today, for its ☑, as History draws it", () => {
    const got = rows(
      [task('open', { title: 'Open one' }), task('done', { title: 'Done one', status: 'completed' })],
      [
        convo('cOpen', { itemId: 'open', lastMessageAt: ago(MIN) }),
        convo('cDone', { itemId: 'done', lastMessageAt: ago(2 * MIN) }),
        convo('cGone', { itemId: 'deleted', lastMessageAt: ago(3 * MIN) }),
        convo('cGeneral', { lastMessageAt: ago(4 * MIN) }),
      ]
    );
    expect(got.map((r) => r.kind === 'conversation' && [r.conversationId, r.done])).toEqual([
      ['cOpen', false],
      ['cDone', true],
      ['cGone', false],
      ['cGeneral', false],
    ]);
  });

  it('decides "today" in the user’s timezone', () => {
    // 03:00 UTC on the 2nd is the evening of the 1st in Los Angeles.
    const early = convo('early', { lastMessageAt: '2026-10-02T03:00:00Z' });
    expect(rows([], [early], 'UTC')).toHaveLength(1);
    expect(rows([], [early], 'America/Los_Angeles')).toHaveLength(0);
  });

  it('shows the newest five, newest first', () => {
    const many = Array.from({ length: 8 }, (_, i) => convo(`c${i}`, { lastMessageAt: ago((i + 1) * MIN) }));
    const got = rows([], [...many].reverse());
    expect(got).toHaveLength(MAX_ACTIVITY_ROWS);
    expect(got.map((r) => r.kind === 'conversation' && r.conversationId)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
  });
});

describe('clockTime', () => {
  const at = (iso: string) => Date.parse(iso);

  it('reads the clock with no am/pm, by the time setting', () => {
    expect(clockTime(at('2026-10-02T08:02:00Z'), 'UTC', '12h')).toBe('8:02');
    expect(clockTime(at('2026-10-02T08:02:00Z'), 'UTC', '24h')).toBe('08:02');
    expect(clockTime(at('2026-10-02T20:05:00Z'), 'UTC', '12h')).toBe('8:05');
    expect(clockTime(at('2026-10-02T20:05:00Z'), 'UTC', '24h')).toBe('20:05');
    expect(clockTime(at('2026-10-02T00:05:00Z'), 'UTC', '12h')).toBe('12:05');
    expect(clockTime(at('2026-10-02T00:05:00Z'), 'UTC', '24h')).toBe('00:05');
  });

  it('reads it in the user’s timezone', () => {
    expect(clockTime(at('2026-10-02T12:00:00Z'), 'America/New_York', '12h')).toBe('8:00');
  });
});
