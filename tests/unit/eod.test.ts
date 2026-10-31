import { describe, it, expect } from 'vitest';
import { isEodOwed, minutesOfDay } from '@/lib/eod';

/**
 * What is left of lib/eod.ts until the iPhone's review goes in phase 3: the
 * hour's parser and the owed predicate its Swift port cites.
 *
 * The review-is-owed predicate. Pure precisely so these cases can exist: the
 * interesting behaviour is all at 20:59 versus 21:00 and either side of a date
 * boundary, and a function that read its own clock could not be asked about
 * them.
 */

const base = {
  eodReviewEnabled: true,
  eodReviewTime: '21:00',
  lastEodReviewDate: null as string | null,
};

const TODAY = '2026-08-11';
const NINE_PM = 21 * 60;

describe('minutesOfDay', () => {
  it('parses the stored HH:mm form', () => {
    expect(minutesOfDay('21:00')).toBe(1260);
    expect(minutesOfDay('00:00')).toBe(0);
    expect(minutesOfDay('9:05')).toBe(545);
    expect(minutesOfDay(' 21:30 ')).toBe(1290);
  });

  it('rejects anything it cannot trust', () => {
    // Nulls rather than a fallback: the caller turns an unparseable time into
    // "not owed", and a silent coercion to midnight would put a line on the
    // dock all day for a value the user never chose.
    expect(minutesOfDay('')).toBeNull();
    expect(minutesOfDay('9pm')).toBeNull();
    expect(minutesOfDay('25:00')).toBeNull();
    expect(minutesOfDay('21:60')).toBeNull();
  });
});

describe('isEodOwed', () => {
  it('is not owed before the hour', () => {
    expect(isEodOwed(base, TODAY, NINE_PM - 1)).toBe(false);
  });

  it('is owed from the hour onward', () => {
    expect(isEodOwed(base, TODAY, NINE_PM)).toBe(true);
    expect(isEodOwed(base, TODAY, 23 * 60 + 59)).toBe(true);
  });

  it('is never owed while the review is turned off', () => {
    expect(isEodOwed({ ...base, eodReviewEnabled: false }, TODAY, NINE_PM)).toBe(false);
  });

  it('retires once today has actually been reviewed', () => {
    expect(isEodOwed({ ...base, lastEodReviewDate: TODAY }, TODAY, NINE_PM)).toBe(false);
  });

  it('comes back the next day, even having reviewed yesterday', () => {
    expect(isEodOwed({ ...base, lastEodReviewDate: '2026-08-10' }, TODAY, NINE_PM)).toBe(true);
  });

  it('treats an unparseable time as not owed rather than as midnight', () => {
    expect(isEodOwed({ ...base, eodReviewTime: 'later' }, TODAY, NINE_PM)).toBe(false);
  });
});
