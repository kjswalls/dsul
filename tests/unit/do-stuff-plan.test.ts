import { describe, it, expect } from 'vitest';
import {
  capNow,
  LANES,
  laneDef,
  laneForDigit,
  NOW_MAX,
  laneOf,
  laneOffered,
  nextNow,
  placeOnDays,
  ruleLane,
  packsFirst,
  stepLane,
  type LaneFacts,
} from '@/lib/do-stuff-plan';

/**
 * Do stuff's plan in lanes (lib/do-stuff-plan.ts): the rules that sort the
 * braindump, the moves the user may make, and the days the calendar lane
 * lands on.
 */

const task: LaneFacts = { plannable: true, canHandOff: false, handedOff: false };
const agentOn: LaneFacts = { ...task, canHandOff: true };
const held: LaneFacts = { ...task, handedOff: true };
const habit: LaneFacts = { plannable: false, canHandOff: false, handedOff: false };

describe('the lanes', () => {
  it('keep their keys 1 to 6 in the order they draw, in Kirby\'s words, do it for me second', () => {
    expect(LANES.map((l) => [l.key, l.digit, l.label])).toEqual([
      ['now', '1', 'do it now'],
      ['handoff', '2', 'do it for me'],
      ['today', '3', 'today'],
      ['calendar', '4', 'another day'],
      ['leave', '5', 'later'],
      ['archive', '6', 'whatever'],
    ]);
    expect(laneDef('now').note).toBe('yes u can');
    expect(laneForDigit('4')).toBe('calendar');
    expect(laneForDigit('7')).toBeUndefined();
  });

  it('offer "handed off" only to what the agent can take or already holds', () => {
    expect(laneOffered('handoff', task)).toBe(false);
    expect(laneOffered('handoff', agentOn)).toBe(true);
    expect(laneOffered('handoff', held)).toBe(true);
    // Held by the agent: taking it back is the item menu's job, not a lane move.
    expect(laneOffered('now', held)).toBe(false);
    expect(laneOffered('calendar', habit)).toBe(false);
    expect(laneOffered('leave', habit)).toBe(true);
  });
});

describe('the rule', () => {
  it('reads the size the user gave first, then the title', () => {
    expect(ruleLane({ title: 'plan the trip', size: 'quick' }, task)).toBe('now');
    expect(ruleLane({ title: 'email the landlord' }, task)).toBe('now');
    expect(ruleLane({ title: 'pick up the dry cleaning' }, task)).toBe('calendar');
    expect(ruleLane({ title: 'declutter the garage' }, task)).toBe('calendar');
  });

  it('hands fuzzy things to the agent when it can take them, and leaves them otherwise', () => {
    expect(ruleLane({ title: 'figure out the budget' }, agentOn)).toBe('handoff');
    expect(ruleLane({ title: 'figure out the budget' }, task)).toBe('leave');
  });

  it('puts what the AI got ready in do it now, whatever its size: ready is a mark, not a lane', () => {
    expect(ruleLane({ title: 'pick up stamps' }, { ...task, hasPack: true })).toBe('now');
    expect(ruleLane({ title: 'plan the trip' }, { ...task, hasPack: true, onToday: true })).toBe('now');
    expect(ruleLane({ title: 'pick up stamps' }, { ...held, hasPack: true })).toBe('handoff');
  });

  it('leaves alone what it cannot read, and every habit', () => {
    expect(ruleLane({ title: 'zebra' }, task)).toBe('leave');
    expect(ruleLane({ title: 'email mum' }, habit)).toBe('leave');
    expect(ruleLane({ title: 'email mum' }, held)).toBe('handoff');
  });

  it("follows the user's move while that lane is still offered", () => {
    const item = { id: 'a', title: 'zebra' };
    expect(laneOf(item, task, { a: 'now' })).toBe('now');
    expect(laneOf(item, task, { a: 'handoff' })).toBe('leave');
  });
});

describe('the swipe', () => {
  it('steps to the next offered lane, skipping what is not', () => {
    expect(stepLane('now', 1, task)).toBe('today');
    expect(stepLane('calendar', 1, task)).toBe('leave');
    expect(stepLane('today', -1, agentOn)).toBe('handoff');
    expect(stepLane('today', -1, task)).toBe('now');
    expect(stepLane('now', -1, task)).toBe('now');
    // A swipe never lets go: "whatever" takes the 6 key or the chip.
    expect(stepLane('leave', 1, task)).toBe('leave');
    expect(stepLane('archive', -1, task)).toBe('leave');
  });
});

describe('whatever and the cap', () => {
  it('never suggests "whatever", but offers it for a task', () => {
    for (const title of ['email the landlord', 'buy stamps', 'plan the trip', 'figure out the budget', 'zebra']) {
      expect(ruleLane({ title }, task)).not.toBe('archive');
      expect(ruleLane({ title }, agentOn)).not.toBe('archive');
    }
    expect(laneOffered('archive', task)).toBe(true);
    expect(laneOffered('archive', { ...task, plannable: false })).toBe(false);
  });

  it('holds "do it now" to three, spilling the rule\'s picks onto today before the user\'s', () => {
    const row = (id: string) => ({ item: { id } });
    const lanes = { done: [], now: ['a', 'b', 'c', 'd', 'e'].map(row), today: [row('t')], calendar: [], handoff: [], leave: [], archive: [] };
    capNow(lanes, () => true, { e: 'now' });
    expect(NOW_MAX).toBe(3);
    expect(lanes.now.map((r) => r.item.id)).toEqual(['a', 'b', 'e']);
    expect(lanes.today.map((r) => r.item.id)).toEqual(['c', 'd', 't']);
  });

  it('counts only open rows against the cap', () => {
    const row = (id: string) => ({ item: { id } });
    const lanes = { done: [], now: ['x', 'a', 'b', 'c'].map(row), today: [], calendar: [], handoff: [], leave: [], archive: [] };
    capNow(lanes, (r) => r.item.id !== 'x', {});
    expect(lanes.now).toHaveLength(4);
    expect(lanes.today).toHaveLength(0);
  });
});

describe('the days', () => {
  it('batches errands on tomorrow and spreads the rest a day each', () => {
    const days = placeOnDays(
      [
        { id: 'a', title: 'plan the trip' },
        { id: 'b', title: 'buy stamps' },
        { id: 'c', title: 'clean the oven' },
        { id: 'd', title: 'return the parcel' },
      ],
      '2026-10-30'
    );
    expect(Object.fromEntries(days)).toEqual({
      a: '2026-10-31',
      b: '2026-10-31',
      c: '2026-11-01',
      d: '2026-10-31',
    });
  });
});

describe('up next', () => {
  const rows = ['a', 'b', 'c'].map((id) => ({ item: { id }, open: id !== 'a' }));
  const open = (r: (typeof rows)[number]) => r.open;
  it('is the first open row not skipped, and skipped ones come round again', () => {
    expect(nextNow(rows, open, [])?.item.id).toBe('b');
    expect(nextNow(rows, open, ['b'])?.item.id).toBe('c');
    expect(nextNow(rows, open, ['c', 'b'])?.item.id).toBe('c');
    expect(nextNow([], open, [])).toBeUndefined();
  });
});

describe('the ready mark', () => {
  it('puts the prepped rows first in a lane, each group in its own order', () => {
    const rows = ['a', 'b', 'c', 'd'].map((id) => ({ item: { id } }));
    const has = (id: string) => id === 'c' || id === 'a';
    expect(packsFirst(rows, has).map((r) => r.item.id)).toEqual(['a', 'c', 'b', 'd']);
    expect(packsFirst(rows, () => false)).toEqual(rows);
  });
});
