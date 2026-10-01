// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRateLimits, takeToken } from '@/lib/ai-server/rate-limit';

/**
 * The per-instance speed bump on calls that reach a provider outside chat
 * (design 1.8): 20 connects and 60 checks per user per sliding hour.
 */

const HOUR = 60 * 60 * 1000;
const T0 = 1_800_000_000_000;

beforeEach(() => __resetRateLimits());

function take(n: number, user: string, bucket: 'connect' | 'check', now: number): boolean[] {
  return Array.from({ length: n }, () => takeToken(user, bucket, now));
}

describe('takeToken', () => {
  it('allows 20 connects an hour, then refuses', () => {
    expect(take(20, 'u1', 'connect', T0).every(Boolean)).toBe(true);
    expect(takeToken('u1', 'connect', T0)).toBe(false);
  });

  it('allows 60 checks an hour, then refuses', () => {
    expect(take(60, 'u1', 'check', T0).every(Boolean)).toBe(true);
    expect(takeToken('u1', 'check', T0)).toBe(false);
  });

  it('keeps the buckets apart', () => {
    take(20, 'u1', 'connect', T0);
    expect(takeToken('u1', 'connect', T0)).toBe(false);
    expect(takeToken('u1', 'check', T0)).toBe(true);
  });

  it('keeps users apart', () => {
    take(20, 'u1', 'connect', T0);
    expect(takeToken('u1', 'connect', T0)).toBe(false);
    expect(takeToken('u2', 'connect', T0)).toBe(true);
  });

  it('slides: each token frees up an hour after it was taken', () => {
    // 10 at T0, 10 at T0+30min: full.
    take(10, 'u1', 'connect', T0);
    take(10, 'u1', 'connect', T0 + HOUR / 2);
    expect(takeToken('u1', 'connect', T0 + HOUR / 2)).toBe(false);
    // Just before the first ten expire, still full.
    expect(takeToken('u1', 'connect', T0 + HOUR - 1)).toBe(false);
    // Once they expire, exactly ten slots open, not twenty.
    expect(take(10, 'u1', 'connect', T0 + HOUR).every(Boolean)).toBe(true);
    expect(takeToken('u1', 'connect', T0 + HOUR)).toBe(false);
  });

  it('a refused request does not count against the window', () => {
    take(20, 'u1', 'connect', T0);
    for (let i = 0; i < 50; i++) takeToken('u1', 'connect', T0 + 1000);
    expect(takeToken('u1', 'connect', T0 + HOUR)).toBe(true);
  });

  it('survives far more users than the key cap', () => {
    for (let i = 0; i < 6_000; i++) expect(takeToken(`user-${i}`, 'check', T0)).toBe(true);
    // The most recent users are still tracked.
    take(59, 'user-5999', 'check', T0);
    expect(takeToken('user-5999', 'check', T0)).toBe(false);
  });
});
