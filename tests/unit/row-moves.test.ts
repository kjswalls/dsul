import { describe, it, expect } from 'vitest';
import {
  canMoveToNextDay,
  canSendToBraindump,
  formatTargetDay,
  nextDayLabel,
  nextDayTarget,
} from '@/lib/row-moves';

const base = { id: 't', status: 'pending' as const, completedDates: [] as string[] };
const none = new Set<string>();

describe('nextDayTarget', () => {
  it('is the day after the later of the row day and today', () => {
    expect(nextDayTarget('2026-07-14', '2026-07-14')).toBe('2026-07-15');
    expect(nextDayTarget('2026-07-16', '2026-07-14')).toBe('2026-07-17');
    expect(nextDayTarget('2026-07-01', '2026-07-14')).toBe('2026-07-15');
  });

  it('crosses month, year and DST boundaries on the calendar', () => {
    expect(nextDayTarget('2026-01-31', '2026-01-31')).toBe('2026-02-01');
    expect(nextDayTarget('2026-12-31', '2026-12-31')).toBe('2027-01-01');
    expect(nextDayTarget('2026-03-08', '2026-03-08')).toBe('2026-03-09');
    expect(nextDayTarget('2026-11-01', '2026-11-01')).toBe('2026-11-02');
  });
});

describe('labels', () => {
  it('says tomorrow only when it is', () => {
    expect(nextDayLabel('2026-07-15', '2026-07-14')).toBe('Move to tomorrow');
    expect(nextDayLabel('2026-07-17', '2026-07-14')).toBe('Move to next day');
  });
  it('formats the target day off the string', () => {
    expect(formatTargetDay('2026-07-15')).toBe('Wed, Jul 15');
  });
});

describe('gates', () => {
  const d = '2026-07-14';
  it('an open one-off task may take both', () => {
    expect(canMoveToNextDay(base, 'task', d)).toBe(true);
    expect(canSendToBraindump(base, 'task', d, none)).toBe(true);
  });
  it('habits take neither', () => {
    expect(canMoveToNextDay(base, 'habit', d)).toBe(false);
    expect(canSendToBraindump(base, 'habit', d, none)).toBe(false);
  });
  it('recurring items take neither — their start date is the series anchor', () => {
    const r = { ...base, repeatFrequency: 'daily' as const };
    expect(canMoveToNextDay(r, 'task', d)).toBe(false);
    expect(canSendToBraindump(r, 'task', d, none)).toBe(false);
  });
  it('done, cancelled and in-block tasks take neither', () => {
    for (const it of [
      { ...base, status: 'completed' as const },
      { ...base, status: 'cancelled' as const },
      { ...base, inProjectBlock: true },
    ]) {
      expect(canMoveToNextDay(it, 'task', d)).toBe(false);
      expect(canSendToBraindump(it, 'task', d, none)).toBe(false);
    }
  });
  it('a milestone may move a day but not lose its date', () => {
    const ms = new Set(['t']);
    expect(canMoveToNextDay(base, 'task', d)).toBe(true);
    expect(canSendToBraindump(base, 'task', d, ms)).toBe(false);
  });
  it('custom types ask their own config', () => {
    const c = { ...base, type: 'custom', customType: 'errand' };
    expect(canMoveToNextDay(c, 'task', d)).toBe(true);
  });
});
