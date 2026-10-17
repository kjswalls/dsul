import { describe, it, expect } from 'vitest';
import {
  fitIn,
  freeStretch,
  headsUp,
  missedBlock,
  missedBlocks,
  spanLabel,
  sprintFor,
  stretchLabel,
  type WalkBlock,
} from '@/lib/do-stuff-walk';

/**
 * The walk's free stretch (lib/do-stuff-walk.ts): where "In the day" opens the
 * current item on today's schedule.
 */

const standup: WalkBlock = { title: 'Standup', startMin: 600, duration: 30 };
const lunch: WalkBlock = { title: 'Lunch with Ana', startMin: 750, duration: 60 };
const deep: WalkBlock = { title: 'Deep work', startMin: 900, duration: 90 };
const day = [deep, standup, lunch];

describe('freeStretch', () => {
  it('runs from now to the next block', () => {
    expect(freeStretch(day, 670)).toEqual({
      startMin: 670,
      endMin: 750,
      until: { title: 'Lunch with Ana', startMin: 750 },
      after: null,
    });
  });

  it('waits for a block that is on now', () => {
    const s = freeStretch(day, 770)!;
    expect(s.startMin).toBe(810);
    expect(s.endMin).toBe(900);
    expect(s.after).toEqual({ title: 'Lunch with Ana', endMin: 810 });
  });

  it('reads back-to-back blocks as one busy run', () => {
    const s = freeStretch([standup, { title: 'Retro', startMin: 630, duration: 30 }, lunch], 610)!;
    expect(s.startMin).toBe(660);
    expect(s.after?.title).toBe('Retro');
    expect(s.until?.title).toBe('Lunch with Ana');
  });

  it('gives a done block its time back', () => {
    const s = freeStretch([{ ...lunch, done: true }, deep], 770)!;
    expect(s.startMin).toBe(770);
    expect(s.until?.title).toBe('Deep work');
  });

  it('runs to the end of the day after the last block', () => {
    expect(freeStretch(day, 1000)).toEqual({ startMin: 1000, endMin: 1440, until: null, after: null });
  });

  it('is null when a block runs past midnight', () => {
    expect(freeStretch([{ title: 'Late', startMin: 1380, duration: 120 }], 1400)).toBeNull();
  });
});

describe('labels', () => {
  it('say how long, in hours and minutes', () => {
    expect(spanLabel(80)).toBe('1h 20m');
    expect(spanLabel(45)).toBe('45m');
    expect(spanLabel(120)).toBe('2h');
  });

  it('name what the stretch runs up to, and what it waits for', () => {
    expect(stretchLabel(freeStretch(day, 670)!, 670)).toEqual({ lead: '1h 20m free', rest: 'until Lunch with Ana' });
    expect(stretchLabel(freeStretch(day, 770)!, 770)).toEqual({
      lead: '1h 30m free',
      rest: 'after Lunch with Ana, until Deep work',
    });
    expect(stretchLabel(freeStretch(day, 1000)!, 1000)).toEqual({ lead: 'free', rest: 'for the rest of the day' });
  });
});

describe('sprintFor', () => {
  it('runs to five minutes before the next block', () => {
    expect(sprintFor(freeStretch(day, 670), 670)).toEqual({ minutes: 75, until: 'Lunch with Ana' });
  });

  it('is an open 25 with nothing after it', () => {
    expect(sprintFor(freeStretch(day, 1000), 1000)).toEqual({ minutes: 25, until: null });
  });

  it('is offered only while the stretch is free now, and long enough', () => {
    expect(sprintFor(freeStretch(day, 770), 770)).toBeNull();
    expect(sprintFor(freeStretch(day, 738), 738)).toBeNull();
    expect(sprintFor(null, 670)).toBeNull();
  });
});

describe('headsUp', () => {
  it('names the block starting within five minutes, and nothing earlier or later', () => {
    expect(headsUp(day, 746)).toEqual({ title: 'Lunch with Ana', inMin: 4 });
    expect(headsUp(day, 744)).toBeNull();
    expect(headsUp(day, 750)).toBeNull();
    expect(headsUp([{ ...lunch, done: true }], 746)).toBeNull();
  });
});

describe('missedBlock', () => {
  const bank: WalkBlock = { title: 'Call the bank', startMin: 600, duration: 30, id: 'm1', movable: true };
  const gym: WalkBlock = { title: 'Gym', startMin: 640, duration: 20, id: 'm2', movable: true };
  it('offers the latest movable block that ended undone, within three hours', () => {
    expect(missedBlock([bank, gym], 670, new Set())?.id).toBe('m2');
    expect(missedBlock([bank, gym], 670, new Set(['m2']))?.id).toBe('m1');
    // Still on, done, not movable, or long gone.
    expect(missedBlock([bank], 620, new Set())).toBeNull();
    expect(missedBlock([{ ...bank, done: true }], 670, new Set())).toBeNull();
    expect(missedBlock([{ ...bank, movable: false }], 670, new Set())).toBeNull();
    expect(missedBlock([bank], 630 + 181, new Set())).toBeNull();
  });

  it('lists every missed block, latest first, so one answer can cover them all', () => {
    expect(missedBlocks([bank, gym], 670, new Set()).map((b) => b.id)).toEqual(['m2', 'm1']);
    expect(missedBlocks([bank, gym], 670, new Set(['m1', 'm2']))).toEqual([]);
  });

  it('fits it in at the free stretch: now, or after the block running now, at its own length', () => {
    expect(fitIn(freeStretch(day, 671), 671, 30)).toEqual({ startMin: 671, duration: 30 });
    expect(fitIn(freeStretch(day, 770), 770, 30)).toEqual({ startMin: 810, duration: 30 });
    expect(fitIn(null, 671, 30)).toBeNull();
  });

  it('shortens a block to the gap before the next block or midnight, and gives up under ten minutes', () => {
    // 20 minutes before lunch: a 30-minute block gets 20.
    expect(fitIn(freeStretch(day, 730), 730, 30)).toEqual({ startMin: 730, duration: 20 });
    // Eight minutes before lunch: nothing worth it fits.
    expect(fitIn(freeStretch(day, 742), 742, 30)).toBeNull();
    // Late in the day the room ends at midnight.
    expect(fitIn(freeStretch(day, 1425), 1425, 60)).toEqual({ startMin: 1425, duration: 15 });
    expect(fitIn(freeStretch(day, 1435), 1435, 60)).toBeNull();
    // A five-minute block with room to spare is a five-minute block, not a refusal.
    expect(fitIn(freeStretch(day, 671), 671, 5)).toEqual({ startMin: 671, duration: 5 });
    // Cut to three minutes, it is refused like any sliver.
    expect(fitIn(freeStretch(day, 747), 747, 5)).toBeNull();
  });
});
