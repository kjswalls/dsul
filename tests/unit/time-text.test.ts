import { describe, expect, it } from 'vitest';
import { formatClock, fromMinutes, parseTimeText, TIME_STEPS, timeRows, toMinutes } from '@/lib/time-text';

const at = (hhmm: string) => toMinutes(hhmm)!;

describe('parseTimeText', () => {
  it('reads the ways people type a time', () => {
    const now = at('08:00');
    expect(parseTimeText('9:30', '12h', now)).toBe('09:30');
    expect(parseTimeText('930', '12h', now)).toBe('09:30');
    expect(parseTimeText('9.30', '12h', now)).toBe('09:30');
    expect(parseTimeText('2pm', '12h', now)).toBe('14:00');
    expect(parseTimeText('2:15 p', '12h', now)).toBe('14:15');
    expect(parseTimeText('12am', '12h', now)).toBe('00:00');
    expect(parseTimeText('12pm', '12h', now)).toBe('12:00');
    expect(parseTimeText('21:30', '12h', now)).toBe('21:30');
    expect(parseTimeText('noon', '12h', now)).toBe('12:00');
    expect(parseTimeText('Midnight', '12h', now)).toBe('00:00');
  });

  it('takes a bare 12-hour clock hour as the next one ahead', () => {
    expect(parseTimeText('9', '12h', at('08:00'))).toBe('09:00');
    expect(parseTimeText('9', '12h', at('15:00'))).toBe('21:00');
    // Both have passed: the morning one, for another day.
    expect(parseTimeText('9', '12h', at('22:00'))).toBe('09:00');
    // A leading zero, or a 24-hour clock, means what it says.
    expect(parseTimeText('09:00', '12h', at('15:00'))).toBe('09:00');
    expect(parseTimeText('9', '24h', at('15:00'))).toBe('09:00');
  });

  it('counts forward from now, to the next five minutes', () => {
    expect(parseTimeText('in 2h', '12h', at('10:02'))).toBe('12:00');
    expect(parseTimeText('in 45 min', '12h', at('23:30'))).toBe('00:15');
  });

  it('refuses what is not a time', () => {
    for (const bad of ['', 'soon', '25', '9:75', '13pm', '0am', '12345']) {
      expect(parseTimeText(bad, '12h', at('08:00'))).toBeNull();
    }
  });
});

describe('formatClock', () => {
  it('draws the stored time in the user clock', () => {
    expect(formatClock('00:05', '12h')).toBe('12:05 AM');
    expect(formatClock('13:30', '12h')).toBe('1:30 PM');
    expect(formatClock('13:30', '24h')).toBe('13:30');
    expect(fromMinutes(-30)).toBe('23:30');
  });
});

describe('timeRows', () => {
  it('lists every half hour, with an in-between value slotted in', () => {
    expect(TIME_STEPS).toHaveLength(48);
    const { rows } = timeRows('', '07:15', '12h', 0);
    expect(rows).toHaveLength(49);
    expect(rows.indexOf('07:15')).toBe(rows.indexOf('07:00') + 1);
  });

  it('puts the typed time first, then the half hours that start the same way', () => {
    const { rows, typed } = timeRows('7', '', '12h', at('08:00'));
    expect(typed).toBe('19:00');
    expect(rows).toEqual(['19:00', '07:00', '07:30', '19:30']);
  });

  it('reads two digits that are not yet a time as the start of one', () => {
    expect(timeRows('94', '', '12h', at('08:00')).typed).toBe('09:40');
  });

  it('offers nothing for words it cannot read', () => {
    expect(timeRows('soon', '', '12h', 0)).toEqual({ rows: [], typed: null });
  });
});
