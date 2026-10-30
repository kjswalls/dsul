import { describe, expect, it } from 'vitest';

import { CARD_DAYS, cardLine, firstCardStart, habitCards, xCount } from '@/lib/x-effect';

const TZ = 'UTC';

describe('X effect cards', () => {
  it('starts the first card on the first tick since the extension was turned on', () => {
    const habit = { completedDates: ['2026-09-01', '2026-10-03', '2026-10-02'] };
    expect(firstCardStart(habit, '2026-10-01')).toBe('2026-10-02');
    expect(firstCardStart(habit, '2026-11-01')).toBeNull();
  });

  it('has no card until that first tick', () => {
    expect(habitCards({ completedDates: ['2026-09-01'] }, '2026-10-01', '2026-10-30', TZ)).toEqual([]);
  });

  it('draws X, rest, blank and ahead, and counts only the X’s', () => {
    const habit = {
      repeatFrequency: 'daily',
      completedDates: ['2026-10-01', '2026-10-02', '2026-10-05'],
      skippedDates: ['2026-10-03'],
    };
    const [card] = habitCards(habit, '2026-10-01', '2026-10-05', TZ);
    expect(card.cells.slice(0, 6).map((c) => c.state)).toEqual(['x', 'x', 'rest', 'blank', 'x', 'ahead']);
    expect(card.cells[4].today).toBe(true);
    expect(card.xs).toBe(3);
    expect(card.day).toBe(5);
    expect(cardLine(card)).toBe('Card 1 · day 5 of 49');
  });

  it('prints off days in, and an X still wins on one', () => {
    // 2026-10-03 and -04 are a weekend.
    const habit = { repeatFrequency: 'weekdays', completedDates: ['2026-10-01', '2026-10-04'] };
    const [card] = habitCards(habit, '2026-10-01', '2026-10-10', TZ);
    expect(card.cells[2].state).toBe('off');
    expect(card.cells[3].state).toBe('x');
  });

  it('never resets: a long gap keeps the card running, then the next card starts the day after', () => {
    const habit = { repeatFrequency: 'daily', completedDates: ['2026-01-01'] };
    const today = '2026-02-20'; // day 51 since the first tick
    const cards = habitCards(habit, '2026-01-01', today, TZ);
    expect(cards).toHaveLength(2);
    expect(cards[0].filed).toBe(true);
    expect(cards[0].cells).toHaveLength(CARD_DAYS);
    expect(cards[0].xs).toBe(1);
    expect(cardLine(cards[0])).toBe('Card 1 · filed');
    expect(cards[1].start).toBe('2026-02-19');
    expect(cards[1].day).toBe(2);
  });

  it('never names a miss', () => {
    expect(xCount(1)).toBe('1 X');
    expect(xCount(26)).toBe('26 X’s');
  });
});
