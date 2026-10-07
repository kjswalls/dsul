import { BUCKET_START_TIMES } from '@/lib/time-bucket';
import type { ClockBucket } from './filters';

/**
 * The recipe clock's arithmetic. Pure.
 *
 * Parts of day start where the web offers them (BUCKET_START_TIMES: 05:00,
 * 12:00, 17:00), not at TIME_BUCKET_RANGES' first hour, which starts morning
 * at midnight and would fire a "morning starts" recipe just after 00:00.
 * Before 05:00 there is no part of day, so nothing fires.
 */

const ORDER: ClockBucket[] = ['evening', 'afternoon', 'morning'];

export function clockBucket(hhmm: string): ClockBucket | null {
  for (const b of ORDER) if (hhmm >= BUCKET_START_TIMES[b]) return b;
  return null;
}

/**
 * The user's own day and hh:mm. `hourCycle: 'h23'`, as lib/reminders/scan.ts
 * localClock spells out: some ICU builds answer midnight as "24" otherwise.
 */
export function localDayAndTime(now: Date, tz: string): { today: string; hhmm: string } {
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
  return { today, hhmm };
}

/** mod_runs claim keys, unique per recipe (061's unique (mod_id, claim_key)). */
export const dayClaimKey = (today: string) => `day:${today}`;
export const bucketClaimKey = (today: string, bucket: ClockBucket) => `bucket:${today}:${bucket}`;
