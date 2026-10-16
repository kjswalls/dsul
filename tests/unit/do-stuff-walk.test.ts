import { describe, it, expect } from 'vitest';
import { freeStretch, spanLabel, sprintFor, stretchLabel, type WalkBlock } from '@/lib/do-stuff-walk';

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
