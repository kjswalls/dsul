// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { timedRunDay, timeClaimKey, itemClaimKey } from '@/lib/recipes/server/window';
import { passesFilters } from '@/lib/recipes/filters';
import { weekdayOf } from '@/lib/container-schedule';

/**
 * When a recipe "at a time of day" is due (lib/recipes/server/window.ts): at
 * any five-minute tick within the last 30 REAL minutes after the time was
 * crossed on the user's own date. Zones, DST and the midnight clamp, as the
 * reminder windows have them (lib/reminders/due.ts), and weekdays read on the
 * user's date.
 */

const due = (at: string, iso: string, tz: string) => timedRunDay(at, new Date(iso), tz);

describe('timedRunDay', () => {
  it('New York 07:30: due from 07:30 for half an hour, never before, never after', () => {
    const tz = 'America/New_York'; // EDT, UTC-4, in October
    expect(due('07:30', '2026-10-07T11:25:00Z', tz)).toBeNull();
    expect(due('07:30', '2026-10-07T11:30:00Z', tz)).toBe('2026-10-07');
    expect(due('07:30', '2026-10-07T11:55:00Z', tz)).toBe('2026-10-07');
    expect(due('07:30', '2026-10-07T12:00:00Z', tz)).toBeNull();
  });

  it('Kathmandu (+5:45) lands on its own quarter hours, and a 07:32 runs at the next tick', () => {
    const tz = 'Asia/Kathmandu';
    expect(due('07:30', '2026-10-07T01:45:00Z', tz)).toBe('2026-10-07');
    expect(due('07:32', '2026-10-07T01:45:00Z', tz)).toBeNull();
    expect(due('07:32', '2026-10-07T01:50:00Z', tz)).toBe('2026-10-07');
    expect(due('07:32', '2026-10-07T02:15:00Z', tz)).toBe('2026-10-07');
    expect(due('07:32', '2026-10-07T02:20:00Z', tz)).toBeNull();
  });

  it('spring forward: 02:30 never happens, so it runs at 03:00, and only for real half an hour', () => {
    const tz = 'America/New_York'; // 2026-03-08 02:00 EST → 03:00 EDT, at 07:00Z
    expect(due('02:30', '2026-03-08T06:55:00Z', tz)).toBeNull(); // 01:55 EST
    expect(due('02:30', '2026-03-08T07:00:00Z', tz)).toBe('2026-03-08'); // 03:00 EDT
    expect(due('02:30', '2026-03-08T07:25:00Z', tz)).toBe('2026-03-08');
    expect(due('02:30', '2026-03-08T07:30:00Z', tz)).toBeNull();
  });

  it('fall back: 01:30 happens twice, and both are the same day (one claim key)', () => {
    const tz = 'America/New_York'; // 2026-11-01 02:00 EDT → 01:00 EST, at 06:00Z
    const first = due('01:30', '2026-11-01T05:30:00Z', tz); // 01:30 EDT
    expect(due('01:30', '2026-11-01T06:00:00Z', tz)).toBeNull(); // 01:00 EST
    const second = due('01:30', '2026-11-01T06:30:00Z', tz); // 01:30 EST
    expect(first).toBe('2026-11-01');
    expect(second).toBe('2026-11-01');
    expect(timeClaimKey(first!, '01:30')).toBe(timeClaimKey(second!, '01:30'));
  });

  it('23:58 opens at the day’s last tick, 23:55, and nothing spills into tomorrow', () => {
    const tz = 'UTC';
    expect(due('23:58', '2026-10-07T23:50:00Z', tz)).toBeNull();
    expect(due('23:58', '2026-10-07T23:55:00Z', tz)).toBe('2026-10-07');
    expect(due('23:58', '2026-10-08T00:00:00Z', tz)).toBeNull();
    expect(due('23:58', '2026-10-08T00:20:00Z', tz)).toBeNull();
  });

  it('00:00 is due from midnight for half an hour, though half an hour ago was yesterday', () => {
    const tz = 'UTC';
    expect(due('00:00', '2026-10-08T00:00:00Z', tz)).toBe('2026-10-08');
    expect(due('00:00', '2026-10-08T00:25:00Z', tz)).toBe('2026-10-08');
    expect(due('00:00', '2026-10-08T00:30:00Z', tz)).toBeNull();
  });

  it('a time that is not one is never due', () => {
    expect(due('7:30', '2026-10-07T07:30:00Z', 'UTC')).toBeNull();
  });
});

describe('weekdays are read on the user’s own date', () => {
  it('across the date line: Auckland’s Wednesday is still Tuesday in UTC', () => {
    // 2026-10-06T18:30Z is 07:30 on 2026-10-07 in Auckland (NZDT, +13).
    const day = due('07:30', '2026-10-06T18:30:00Z', 'Pacific/Auckland');
    expect(day).toBe('2026-10-07');
    const env = { dateStr: day!, todayStr: day!, tz: 'Pacific/Auckland', routines: [], seasons: [] };
    const local = weekdayOf('2026-10-07');
    const utc = weekdayOf('2026-10-06');
    expect(passesFilters({ weekdays: [local] }, undefined, env)).toBe(true);
    expect(passesFilters({ weekdays: [utc] }, undefined, env)).toBe(false);
  });
});

describe('claim keys', () => {
  it('one per recipe, day and time; one per item event and date', () => {
    expect(timeClaimKey('2026-10-07', '07:30')).toBe('time:2026-10-07:07:30');
    expect(itemClaimKey('item.completed', 'abc', '2026-10-07')).toBe('item:item.completed:abc:2026-10-07');
    expect(itemClaimKey('item.created', 'abc', undefined)).toBe('item:item.created:abc:none');
  });
});
