import { describe, it, expect } from 'vitest';
import { snoozeFireInstant } from '@/lib/reminders/snooze';
import { SNOOZE_MINUTES } from '@/lib/reminders/channels/push';

const NY = 'America/New_York';
/** An instant from a UTC wall time, for readability. */
const at = (iso: string) => Date.parse(iso);

describe('snoozeFireInstant', () => {
  it('rings the snooze length after the tap, on the day it belongs to', () => {
    // 07:35 in New York (EDT, UTC-4).
    const tap = at('2026-08-10T11:35:00Z');
    expect(snoozeFireInstant(tap, SNOOZE_MINUTES, NY, '2026-08-10')).toBe(tap + 15 * 60_000);
  });

  // habit-reminders.md decision 8: a snooze belongs to a DAY. Past its local
  // midnight it expires rather than misfires, which is the server's own gate:
  // the scan rings a matured snooze only while its day is still today.
  it('expires at local midnight rather than ringing tomorrow', () => {
    const at2350 = at('2026-08-11T03:50:00Z'); // 23:50 on the 10th in New York
    const at2340 = at('2026-08-11T03:40:00Z'); // 23:40
    expect(snoozeFireInstant(at2350, SNOOZE_MINUTES, NY, '2026-08-10')).toBeNull();
    expect(snoozeFireInstant(at2340, SNOOZE_MINUTES, NY, '2026-08-10')).toBe(at2340 + 15 * 60_000);
  });

  it('treats midnight itself as the next day', () => {
    const at2345 = at('2026-08-11T03:45:00Z');
    expect(snoozeFireInstant(at2345, SNOOZE_MINUTES, NY, '2026-08-10')).toBeNull();
    expect(snoozeFireInstant(at2345 - 1, SNOOZE_MINUTES, NY, '2026-08-10')).toBe(at2345 - 1 + 15 * 60_000);
  });

  // Yesterday's cue can still be in the shade. Snoozed after midnight it
  // snoozes to nothing, as the server would answer it.
  it('a notification about yesterday snoozes to nothing', () => {
    const at0005 = at('2026-08-11T04:05:00Z'); // 00:05 on the 11th in New York
    expect(snoozeFireInstant(at0005, SNOOZE_MINUTES, NY, '2026-08-10')).toBeNull();
    expect(snoozeFireInstant(at0005, SNOOZE_MINUTES, NY, '2026-08-11')).toBe(at0005 + 15 * 60_000);
  });

  it('reads the day in the zone it is given, not in UTC', () => {
    // 03:50Z is still the 10th in New York and already the 11th in London.
    const tap = at('2026-08-11T03:30:00Z');
    expect(snoozeFireInstant(tap, SNOOZE_MINUTES, NY, '2026-08-10')).not.toBeNull();
    expect(snoozeFireInstant(tap, SNOOZE_MINUTES, 'Europe/London', '2026-08-10')).toBeNull();
    expect(snoozeFireInstant(tap, SNOOZE_MINUTES, 'Europe/London', '2026-08-11')).not.toBeNull();
  });

  it('answers null for what it cannot place', () => {
    const tap = at('2026-08-10T11:35:00Z');
    expect(snoozeFireInstant(tap, SNOOZE_MINUTES, 'Not/AZone', '2026-08-10')).toBeNull();
    expect(snoozeFireInstant(tap, SNOOZE_MINUTES, NY, '2026-8-10')).toBeNull();
    expect(snoozeFireInstant(tap, 0, NY, '2026-08-10')).toBeNull();
    expect(snoozeFireInstant(tap, -5, NY, '2026-08-10')).toBeNull();
    expect(snoozeFireInstant(Number.NaN, SNOOZE_MINUTES, NY, '2026-08-10')).toBeNull();
  });
});
