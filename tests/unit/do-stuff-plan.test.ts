import { describe, it, expect } from 'vitest';
import {
  LANES,
  laneForDigit,
  laneOf,
  laneOffered,
  nextNow,
  placeOnDays,
  ruleLane,
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
  it('keep their keys 1 to 5 in the order they draw', () => {
    expect(LANES.map((l) => [l.key, l.digit])).toEqual([
      ['done', '1'],
      ['now', '2'],
      ['calendar', '3'],
      ['handoff', '4'],
      ['leave', '5'],
    ]);
    expect(laneForDigit('3')).toBe('calendar');
    expect(laneForDigit('6')).toBeUndefined();
  });

  it('offer "done for you" only to what the AI got ready', () => {
    for (const f of [task, agentOn, held, habit]) expect(laneOffered('done', f)).toBe(false);
    expect(laneOffered('done', { ...task, hasPack: true })).toBe(true);
    expect(laneOffered('done', { ...held, hasPack: true })).toBe(false);
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

  it('puts what the AI got ready in "done for you", whatever its size', () => {
    expect(ruleLane({ title: 'pick up stamps' }, { ...task, hasPack: true })).toBe('done');
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
    expect(stepLane('now', 1, task)).toBe('calendar');
    expect(stepLane('calendar', 1, task)).toBe('leave');
    expect(stepLane('calendar', 1, agentOn)).toBe('handoff');
    expect(stepLane('now', -1, task)).toBe('now');
    expect(stepLane('leave', 1, task)).toBe('leave');
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
