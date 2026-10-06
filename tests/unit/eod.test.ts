import { describe, it, expect } from 'vitest';
import {
  eodLinkDay,
  isEodOwed,
  minutesOfDay,
  nowMinutesIn,
  reviewedDay,
  shouldShowEodNotice,
} from '@/lib/eod';

/**
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

describe('shouldShowEodNotice', () => {
  it('hides the line for a deferred day', () => {
    expect(shouldShowEodNotice({ ...base, eodDeferredDate: TODAY }, TODAY, NINE_PM)).toBe(false);
  });

  it('but the review is still owed — a deferral is not a completion', () => {
    // The split the two functions exist for. Anything asking whether the user
    // owes tonight's review (a digest, a streak, the push job) must not read a
    // "not tonight" as a finished review.
    expect(isEodOwed({ ...base, eodDeferredDate: TODAY }, TODAY, NINE_PM)).toBe(true);
  });

  it('yesterday’s deferral does not carry into today', () => {
    expect(shouldShowEodNotice({ ...base, eodDeferredDate: '2026-08-10' }, TODAY, NINE_PM)).toBe(
      true
    );
  });
});

describe('nowMinutesIn', () => {
  it('reads the clock in the SAVED timezone, not the machine one', () => {
    // 2026-08-11T23:30Z is 19:30 in New York and 09:30 the next day in Sydney.
    const at = new Date('2026-08-11T23:30:00Z');
    expect(nowMinutesIn(at, 'America/New_York')).toBe(19 * 60 + 30);
    expect(nowMinutesIn(at, 'Australia/Sydney')).toBe(9 * 60 + 30);
  });

  it('renders midnight as 0, not 1440', () => {
    // hour12:false yields "24" for midnight under some ICU versions, which
    // would put the clock an entire day past every review hour.
    expect(nowMinutesIn(new Date('2026-08-11T04:00:00Z'), 'America/New_York')).toBe(0);
  });
});

describe('eodLinkDay', () => {
  it('reads the day the review push names', () => {
    expect(eodLinkDay('2026-10-06')).toBe('2026-10-06');
  });

  // Pushes sent before the link named its day said ?eod=1, and a notification
  // can wait in the shade: it still opens the review, naming no day.
  it('names no day for the bare ?eod=1, or anything that is not a day', () => {
    expect(eodLinkDay('1')).toBeNull();
    expect(eodLinkDay('')).toBeNull();
    expect(eodLinkDay('2026-10-6')).toBeNull();
    expect(eodLinkDay('2026-10-06T00:15')).toBeNull();
  });
});

describe('reviewedDay', () => {
  // THE case. Done used to stamp the day it was pressed, so the 6th's 23:30
  // push, finished at 00:15 on the 7th, recorded the 7th as reviewed, and
  // isEodOwed (which the scan asks too) retired the 7th's invitation before
  // it was sent.
  it('records an after-midnight review against the day its push invited', () => {
    expect(reviewedDay('2026-10-06', '2026-10-07')).toBe('2026-10-06');
  });

  it('records a review opened from tonight\'s push as tonight\'s', () => {
    expect(reviewedDay('2026-10-06', '2026-10-06')).toBe('2026-10-06');
  });

  // Opened from the palette or the dock: the day it opened on, which a Done
  // pressed after midnight no longer moves.
  it('falls back to the day the review opened on', () => {
    expect(reviewedDay(null, '2026-10-06')).toBe('2026-10-06');
  });

  // A notification tapped days later opens a review of today; filing it under
  // a day long gone would leave tonight's review owed. A day after the one it
  // opened on is no day anyone was invited to review.
  it('ignores an invitation that is not for the day it opened on or the one before', () => {
    expect(reviewedDay('2026-10-04', '2026-10-07')).toBe('2026-10-07');
    expect(reviewedDay('2026-10-08', '2026-10-07')).toBe('2026-10-07');
    expect(reviewedDay('1', '2026-10-07')).toBe('2026-10-07');
  });

  it('counts the day before across a month and a year', () => {
    expect(reviewedDay('2026-09-30', '2026-10-01')).toBe('2026-09-30');
    expect(reviewedDay('2025-12-31', '2026-01-01')).toBe('2025-12-31');
    expect(reviewedDay('2028-02-29', '2028-03-01')).toBe('2028-02-29');
  });
});
