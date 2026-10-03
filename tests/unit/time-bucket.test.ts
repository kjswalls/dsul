import { describe, expect, it } from 'vitest';
import { BUCKET_START_TIMES, autoCorrectBucket, getBucketForTime } from '@/lib/time-bucket';

/**
 * The time → bucket rules moved out of the 'use client' store so the iPhone's
 * schedule route can file a dropped row exactly as the web's drop does. These
 * pin the rules as they were, so the move cannot have changed them.
 */
describe('getBucketForTime', () => {
  it.each([
    ['00:00', 'morning'],
    ['04:59', 'morning'],
    ['09:15', 'morning'],
    ['11:59', 'morning'],
    ['12:00', 'afternoon'],
    ['16:59', 'afternoon'],
    ['17:00', 'evening'],
    ['23:59', 'evening'],
  ])('%s is %s', (time, bucket) => {
    expect(getBucketForTime(time)).toBe(bucket);
  });

  it('reads only the hour', () => {
    expect(getBucketForTime('9:05')).toBe('morning');
    expect(getBucketForTime('14')).toBe('afternoon');
  });
});

describe('autoCorrectBucket', () => {
  it('moves a timed item to its hour’s bucket', () => {
    expect(autoCorrectBucket('18:30', 'morning')).toBe('evening');
    expect(autoCorrectBucket('09:00', 'evening')).toBe('morning');
  });

  it('leaves anytime alone, and anything without both halves', () => {
    expect(autoCorrectBucket('18:30', 'anytime')).toBe('anytime');
    expect(autoCorrectBucket(undefined, 'afternoon')).toBe('afternoon');
    expect(autoCorrectBucket('18:30', undefined)).toBeUndefined();
    expect(autoCorrectBucket('', 'morning')).toBe('morning');
  });
});

describe('BUCKET_START_TIMES', () => {
  it('starts each part of day where the web offers it: a project block’s default, the phone’s Add a time', () => {
    expect(BUCKET_START_TIMES).toEqual({ morning: '05:00', afternoon: '12:00', evening: '17:00' });
  });

  it('files each start in its own part of day', () => {
    for (const [bucket, time] of Object.entries(BUCKET_START_TIMES)) {
      expect(getBucketForTime(time), bucket).toBe(bucket);
      expect(autoCorrectBucket(time, bucket as 'morning'), bucket).toBe(bucket);
    }
  });
});
