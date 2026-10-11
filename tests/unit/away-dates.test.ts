import { describe, it, expect } from 'vitest';
import { formatAwayDay, parseBackOn, shortAwayDay } from '@/lib/away-dates';

// 2026-10-11 is a Sunday.
const today = '2026-10-11';

describe('parseBackOn: what "back on" reads', () => {
  it('reads a weekday as the next one, a week on for today\'s own name', () => {
    expect(parseBackOn('tue', today)).toBe('2026-10-13');
    expect(parseBackOn('until tuesday', today)).toBe('2026-10-13');
    expect(parseBackOn('next fri', today)).toBe('2026-10-16');
    expect(parseBackOn('sun', today)).toBe('2026-10-18');
  });

  it('reads tomorrow and spans', () => {
    expect(parseBackOn('tomorrow', today)).toBe('2026-10-12');
    expect(parseBackOn('3 days', today)).toBe('2026-10-14');
    expect(parseBackOn('2 weeks', today)).toBe('2026-10-25');
    expect(parseBackOn('a week', today)).toBe('2026-10-18');
  });

  it('reads a month and day either way round, rolling into next year when past', () => {
    expect(parseBackOn('oct 20', today)).toBe('2026-10-20');
    expect(parseBackOn('20 oct', today)).toBe('2026-10-20');
    expect(parseBackOn('back on Oct 20th', today)).toBe('2026-10-20');
    expect(parseBackOn('10/20', today)).toBe('2026-10-20');
    expect(parseBackOn('jan 3', today)).toBe('2027-01-03');
    expect(parseBackOn('oct 5', today)).toBe('2027-10-05');
  });

  it('reads an ISO date only when it is after today', () => {
    expect(parseBackOn('2026-10-20', today)).toBe('2026-10-20');
    expect(parseBackOn('2026-10-11', today)).toBeNull();
    expect(parseBackOn('2026-02-30', today)).toBeNull();
  });

  it('refuses what it cannot read', () => {
    expect(parseBackOn('', today)).toBeNull();
    expect(parseBackOn('soon', today)).toBeNull();
    expect(parseBackOn('feb 30', today)).toBeNull();
    expect(parseBackOn('0 days', today)).toBeNull();
  });
});

describe('formatting', () => {
  it('says the day in full, or short when it is this week', () => {
    expect(formatAwayDay('2026-10-20')).toBe('Tue, Oct 20');
    expect(shortAwayDay('2026-10-13', today)).toBe('Tue');
    expect(shortAwayDay('2026-10-20', today)).toBe('Oct 20');
  });
});
