import { TIME_BUCKET_RANGES, type TimeBucket } from './planner-types';

/**
 * The time → bucket rules, in a module both the store and a route can import.
 *
 * They lived as private consts in lib/planner-store.ts, which is a 'use client'
 * module no route handler may import. /api/app/items/:id (the iPhone's drop of
 * a braindump row onto an hour) has to file the row the way the web's own drop
 * does, so the rules moved here unchanged and the store imports them back.
 */

// Get appropriate bucket for a given time
export const getBucketForTime = (time: string): TimeBucket => {
  const hour = parseInt(time.split(':')[0]);
  if (hour >= TIME_BUCKET_RANGES.morning.start && hour < TIME_BUCKET_RANGES.morning.end) {
    return 'morning';
  } else if (hour >= TIME_BUCKET_RANGES.afternoon.start && hour < TIME_BUCKET_RANGES.afternoon.end) {
    return 'afternoon';
  } else if (hour >= TIME_BUCKET_RANGES.evening.start || hour < 5) {
    return 'evening';
  }
  return 'anytime';
};

// A concrete start time overrides a mismatched bucket ('anytime' is exempt).
// Single home for the auto-correct rule that used to be copied six times.
export const autoCorrectBucket = (
  time: string | undefined,
  bucket: TimeBucket | undefined,
): TimeBucket | undefined =>
  time && bucket && bucket !== 'anytime' ? getBucketForTime(time) : bucket;
