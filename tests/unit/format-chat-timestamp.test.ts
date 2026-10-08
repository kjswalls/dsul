// @vitest-environment node
/**
 * lib/format-chat-timestamp.ts's `resetClock`: the time a limit lifts, as a
 * sentence says it.
 *
 * Unlike `clockTime` it keeps am/pm, because it stands alone inside a line of
 * copy ("AI is back when it resets at 7 am."), where "7:00" could be either.
 * The copy rule holds here too: no em dashes, and nothing a provider wrote.
 */

import { describe, expect, it } from 'vitest';
import { resetClock } from '@/lib/format-chat-timestamp';

/** A UTC wall clock, so a zone's offset is the only thing under test. */
const at = (h: number, m = 0, day = 7) => Date.UTC(2026, 9, day, h, m);

describe('resetClock, 12-hour', () => {
  const z = 'UTC';
  it('drops the minutes on the hour, and keeps them otherwise', () => {
    expect(resetClock(at(7), z, '12h')).toBe('7 am');
    expect(resetClock(at(17, 52), z, '12h')).toBe('5:52 pm');
    expect(resetClock(at(19), z, '12h')).toBe('7 pm');
    expect(resetClock(at(9, 5), z, '12h')).toBe('9:05 am');
  });

  it('says midnight and noon by name, but only on the hour', () => {
    expect(resetClock(at(0), z, '12h')).toBe('midnight');
    expect(resetClock(at(12), z, '12h')).toBe('noon');
    expect(resetClock(at(0, 1), z, '12h')).toBe('12:01 am');
    expect(resetClock(at(12, 30), z, '12h')).toBe('12:30 pm');
  });

  it('reads the hour the zone is at, not the server\'s', () => {
    // Google's free tier resets at midnight Pacific; that is 3 am in New York.
    const midnightPacific = Date.UTC(2026, 9, 8, 7);
    expect(resetClock(midnightPacific, 'America/Los_Angeles', '12h')).toBe('midnight');
    expect(resetClock(midnightPacific, 'America/New_York', '12h')).toBe('3 am');
    expect(resetClock(midnightPacific, 'Europe/London', '12h')).toBe('8 am');
    expect(resetClock(midnightPacific, 'Asia/Kolkata', '12h')).toBe('12:30 pm');
    expect(resetClock(midnightPacific, 'Australia/Sydney', '12h')).toBe('6 pm');
  });
});

describe('resetClock, 24-hour', () => {
  it('pads to two digits and never names midnight or noon', () => {
    expect(resetClock(at(7), 'UTC', '24h')).toBe('07:00');
    expect(resetClock(at(0), 'UTC', '24h')).toBe('00:00');
    expect(resetClock(at(12), 'UTC', '24h')).toBe('12:00');
    expect(resetClock(at(17, 52), 'UTC', '24h')).toBe('17:52');
    expect(resetClock(at(23, 9), 'UTC', '24h')).toBe('23:09');
  });

  it('follows the zone, the same way', () => {
    const midnightPacific = Date.UTC(2026, 9, 8, 7);
    expect(resetClock(midnightPacific, 'America/New_York', '24h')).toBe('03:00');
    expect(resetClock(midnightPacific, 'Asia/Kolkata', '24h')).toBe('12:30');
  });
});

describe('resetClock: the zone it is given', () => {
  it('a zone this engine does not know falls back rather than throwing', () => {
    for (const zone of ['Mars/Olympus', 'not a zone', 'America/Nowhere']) {
      // The fallback is the host's own zone, so only the shape is assertable.
      expect(resetClock(at(7), zone, '24h')).toMatch(/^\d{2}:\d{2}$/);
    }
  });

  it('a missing or blank zone is the host\'s own', () => {
    for (const zone of [null, undefined, '', '   ']) {
      expect(resetClock(at(7), zone, '24h')).toMatch(/^\d{2}:\d{2}$/);
    }
  });

  it('keeps daylight saving in mind', () => {
    // 2026-11-01 is the US fall-back: 09:00Z is 2 am PDT, 08:00Z is 1 am PDT.
    expect(resetClock(Date.UTC(2026, 10, 1, 7), 'America/Los_Angeles', '24h')).toBe('00:00');
    expect(resetClock(Date.UTC(2026, 10, 2, 8), 'America/Los_Angeles', '24h')).toBe('00:00');
    expect(resetClock(Date.UTC(2026, 6, 1, 7), 'America/Los_Angeles', '24h')).toBe('00:00');
  });

  it('takes a real time: its caller checks that before asking', () => {
    // `chatErrorCopy` parses `limitedUntil` and falls back to the static line
    // unless it is finite and still in the future (lib/chat-errors.ts), so an
    // unparseable reset time never reaches here.
    expect(() => resetClock(Number.NaN, 'UTC', '12h')).toThrow(RangeError);
    expect(resetClock(0, 'UTC', '24h')).toBe('00:00');
  });
});
