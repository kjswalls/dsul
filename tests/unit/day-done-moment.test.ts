import { beforeEach, describe, expect, it } from 'vitest';

import {
  claimDayDone,
  DAY_DONE_CHIP,
  DAY_DONE_HEADLINES,
  DAY_DONE_HINT,
  DAY_DONE_HINT_TOUCH,
  dayDoneCountLine,
  pickDayDoneHeadline,
} from '@/lib/day-done-moment';

/** The day done aurora's words and its once-a-day gate (lib/day-done-moment.ts). */

const ALL = [...DAY_DONE_HEADLINES, DAY_DONE_CHIP, DAY_DONE_HINT, DAY_DONE_HINT_TOUCH, dayDoneCountLine(5)];

describe('the day done copy', () => {
  it('picks from the pool, edges included', () => {
    expect(pickDayDoneHeadline(() => 0)).toBe(DAY_DONE_HEADLINES[0]);
    expect(pickDayDoneHeadline(() => 0.9999)).toBe(DAY_DONE_HEADLINES[DAY_DONE_HEADLINES.length - 1]);
  });

  it('never guesses the time or the day', () => {
    const guess = /\b(morning|afternoon|evening|night|late|tonight|tomorrow|weekend|bed|sleep|(mon|tues|wednes|thurs|fri|satur|sun)day)\b/i;
    for (const line of ALL) expect(line).not.toMatch(guess);
  });

  it('is lowercase with no em dashes', () => {
    for (const line of ALL) {
      expect(line).toBe(line.toLowerCase());
      expect(line).not.toContain('—');
    }
  });

  it('counts both sides the same', () => {
    expect(dayDoneCountLine(1)).toBe('1 of 1 done');
    expect(dayDoneCountLine(5)).toBe('5 of 5 done');
  });
});

describe('claimDayDone', () => {
  beforeEach(() => window.localStorage.clear());

  it('plays once a day, and again the next day', () => {
    expect(claimDayDone('2026-11-08')).toBe(true);
    expect(claimDayDone('2026-11-08')).toBe(false);
    expect(claimDayDone('2026-11-09')).toBe(true);
  });
});
