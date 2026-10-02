import { describe, it, expect } from 'vitest';
import type { ProposalOperation } from '@/lib/planner-types';
import {
  NO_CHANGES,
  addChanges,
  changePhrase,
  groupHistory,
  hasChanges,
  historyDay,
  historySecondLine,
  historyTime,
  tallyOperations,
} from '@/lib/conversation-summary';

/**
 * History's second line is DERIVED: four stored counters plus the item as the
 * planner holds it now. These pin the tally (what one accepted proposal adds)
 * and every row of the line's table (D9).
 */

const create = (o: Partial<ProposalOperation> = {}) => ({ kind: 'create', title: 'New', ...o }) as ProposalOperation;
const update = (itemId: string, o: Record<string, unknown> = {}) => ({ kind: 'update', itemId, ...o }) as ProposalOperation;

describe('tallyOperations', () => {
  it('counts a create under a parent as a step, any other create as added', () => {
    expect(tallyOperations([create(), create(), create({ parentItemId: 'p' } as Partial<ProposalOperation>)])).toEqual({
      added: 2,
      steps: 1,
      moved: 0,
      changed: 0,
    });
  });

  it('counts DISTINCT items: an update touching the schedule moved it, any other changed it', () => {
    const t = tallyOperations([
      update('a', { startDate: '2026-10-03' }),
      update('a', { timeBucket: 'evening' }),
      update('b', { startTime: '09:00' }),
      update('c', { title: 'Renamed' }),
      update('c', { priority: 'high' }),
    ]);
    expect(t).toEqual({ added: 0, steps: 0, moved: 2, changed: 1 });
  });

  it('counts an item both moved and changed once, as moved', () => {
    expect(tallyOperations([update('a', { title: 'x' }), update('a', { startDate: '2026-10-04' })])).toEqual({
      added: 0,
      steps: 0,
      moved: 1,
      changed: 0,
    });
  });

  it('holds each counter to what one PATCH may carry', () => {
    const many = Array.from({ length: 30 }, (_, i) => update(`i${i}`, { startDate: '2026-10-05' }));
    expect(tallyOperations(many).moved).toBe(20);
  });

  it('is nothing for nothing', () => {
    expect(tallyOperations([])).toEqual(NO_CHANGES);
    expect(hasChanges(NO_CHANGES)).toBe(false);
    expect(hasChanges(null)).toBe(false);
    expect(hasChanges({ ...NO_CHANGES, steps: 1 })).toBe(true);
  });
});

describe('addChanges', () => {
  it('adds, never below zero, never past the column ceiling', () => {
    expect(addChanges({ added: 1, steps: 0, moved: 2, changed: 0 }, { moved: 3, changed: -4 })).toEqual({
      added: 1,
      steps: 0,
      moved: 5,
      changed: 0,
    });
    expect(addChanges({ ...NO_CHANGES, added: 99_999 }, { added: 20 }).added).toBe(100_000);
  });
});

describe('changePhrase', () => {
  it('joins the non-zero counters in a fixed order, with singular forms', () => {
    expect(changePhrase({ added: 1, steps: 0, moved: 3, changed: 0 })).toBe('Moved 3 items · Added 1 item');
    expect(changePhrase({ added: 0, steps: 1, moved: 0, changed: 1 })).toBe('Added a step · Changed 1 item');
    expect(changePhrase({ added: 0, steps: 4, moved: 1, changed: 2 })).toBe('Moved 1 item · Broke it into 4 steps · Changed 2 items');
    expect(changePhrase(NO_CHANGES)).toBeNull();
  });
});

describe('historySecondLine (D9)', () => {
  const general = (changes = NO_CHANGES) => ({ itemId: null, changes });
  const forItem = (changes = NO_CHANGES) => ({ itemId: 'i1', changes });

  it('item conversation, delegated and blocked: waiting on you', () => {
    expect(historySecondLine(forItem(), { assignee: 'openclaw', aiStatus: 'blocked' })).toBe('With OpenClaw · waiting on you');
  });

  it('item conversation, delegated and queued or working: working on it', () => {
    expect(historySecondLine(forItem(), { assignee: 'openclaw', aiStatus: 'queued' })).toBe('With OpenClaw · working on it');
    expect(historySecondLine(forItem(), { assignee: 'openclaw', aiStatus: 'working' })).toBe('With OpenClaw · working on it');
  });

  it("reads a stored 'beacon' as AI, never by its id", () => {
    expect(historySecondLine(forItem(), { assignee: 'beacon', aiStatus: 'working' })).toBe('With AI · working on it');
  });

  it('item conversation, item live: its changes, or none', () => {
    expect(historySecondLine(forItem({ ...NO_CHANGES, moved: 1 }), {})).toBe('Item conversation · moved 1 item');
    expect(historySecondLine(forItem(), { assignee: 'openclaw', aiStatus: 'done' })).toBe('Item conversation · no changes');
  });

  it('item conversation, item gone', () => {
    expect(historySecondLine(forItem({ ...NO_CHANGES, moved: 1 }), null)).toBe('Item conversation · item deleted');
    expect(historySecondLine(forItem(), undefined)).toBe('Item conversation · item deleted');
  });

  it('general, with changes and without', () => {
    expect(historySecondLine(general({ added: 1, steps: 0, moved: 3, changed: 0 }), null)).toBe('Moved 3 items · Added 1 item');
    expect(historySecondLine(general(), null)).toBe('No changes');
  });
});

/**
 * History's groups and row times (C4): by the last message, in the USER's
 * zone, never the browser's or UTC's.
 */
describe("History's days and times", () => {
  const NY = 'America/New_York';
  // Friday 2 October 2026, 10:00 in New York.
  const NOW = Date.parse('2026-10-02T14:00:00.000Z');

  it('groups by the day in the user zone', () => {
    expect(historyDay('2026-10-02T12:05:00.000Z', NOW, NY)).toBe('today');
    expect(historyDay('2026-10-01T15:00:00.000Z', NOW, NY)).toBe('yesterday');
    // 23:30 on the 1st in New York, though the 2nd in UTC.
    expect(historyDay('2026-10-02T03:30:00.000Z', NOW, NY)).toBe('yesterday');
    expect(historyDay('2026-10-02T03:30:00.000Z', NOW, 'UTC')).toBe('today');
    expect(historyDay('2026-09-30T15:00:00.000Z', NOW, NY)).toBe('earlier');
    expect(historyDay('not a date', NOW, NY)).toBe('earlier');
  });

  it('crosses a month and a year by the calendar', () => {
    const newYear = Date.parse('2027-01-01T15:00:00.000Z');
    expect(historyDay('2026-12-31T15:00:00.000Z', newYear, NY)).toBe('yesterday');
    const march = Date.parse('2026-03-01T15:00:00.000Z');
    expect(historyDay('2026-02-28T15:00:00.000Z', march, NY)).toBe('yesterday');
  });

  it("today: the clock, with no am/pm; 24-hour under that setting", () => {
    expect(historyTime('2026-10-02T12:05:00.000Z', NOW, NY, false)).toBe('8:05');
    expect(historyTime('2026-10-02T12:05:00.000Z', NOW, NY, true)).toBe('08:05');
    expect(historyTime('2026-10-02T17:30:00.000Z', NOW, NY, false)).toBe('1:30');
    expect(historyTime('2026-10-02T17:30:00.000Z', NOW, NY, true)).toBe('13:30');
    // Just after midnight.
    expect(historyTime('2026-10-02T04:05:00.000Z', NOW, NY, false)).toBe('12:05');
    expect(historyTime('2026-10-02T04:05:00.000Z', NOW, NY, true)).toBe('00:05');
  });

  it('yesterday: the weekday; earlier: the date, with the year once it is not this one', () => {
    expect(historyTime('2026-10-01T15:00:00.000Z', NOW, NY, false)).toBe('Thu');
    expect(historyTime('2026-09-24T15:00:00.000Z', NOW, NY, false)).toBe('Sep 24');
    expect(historyTime('2025-09-24T15:00:00.000Z', NOW, NY, false)).toBe('Sep 24, 2025');
    expect(historyTime('garbage', NOW, NY, false)).toBe('');
  });

  it("falls back to the browser's zone for one Intl does not know", () => {
    expect(() => historyTime('2026-10-02T12:05:00.000Z', NOW, 'Not/AZone', false)).not.toThrow();
    expect(() => historyDay('2026-10-02T12:05:00.000Z', NOW, null)).not.toThrow();
  });

  const at = (lastMessageAt: string, starred = false) => ({ lastMessageAt, starred });

  it('orders Starred, Today, Yesterday, Earlier, leaving out an empty group', () => {
    const summaries = {
      s1: at('2025-01-01T12:00:00.000Z', true),
      t1: at('2026-10-02T13:00:00.000Z'),
      t2: at('2026-10-02T12:00:00.000Z'),
      e1: at('2026-09-01T12:00:00.000Z'),
    };
    const groups = groupHistory({ ids: ['t1', 't2', 'e1'], starredIds: ['s1'] }, summaries, NOW, NY);
    expect(groups).toEqual([
      { key: 'starred', label: 'Starred', ids: ['s1'] },
      { key: 'today', label: 'Today', ids: ['t1', 't2'] },
      { key: 'earlier', label: 'Earlier', ids: ['e1'] },
    ]);
  });

  it('shows a starred conversation ONLY under Starred, even before the list has moved it', () => {
    const summaries = { a: at('2026-10-02T13:00:00.000Z', true), b: at('2026-10-02T12:00:00.000Z') };
    const groups = groupHistory({ ids: ['a', 'b'], starredIds: [] }, summaries, NOW, NY);
    expect(groups.map((g) => [g.key, g.ids])).toEqual([
      ['starred', ['a']],
      ['today', ['b']],
    ]);
    // Listed twice (both pages), shown once.
    const twice = groupHistory({ ids: ['a', 'b'], starredIds: ['a'] }, summaries, NOW, NY);
    expect(twice.flatMap((g) => g.ids)).toEqual(['a', 'b']);
  });

  it('skips an id with no summary, and is empty with nothing', () => {
    expect(groupHistory({ ids: ['x'], starredIds: ['y'] }, {}, NOW, NY)).toEqual([]);
    expect(groupHistory({ ids: [], starredIds: [] }, {}, NOW, NY)).toEqual([]);
  });
});
