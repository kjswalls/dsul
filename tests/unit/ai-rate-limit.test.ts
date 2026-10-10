// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRateLimits, takeToken, type Bucket } from '@/lib/ai-server/rate-limit';

/**
 * The per-instance speed bump on calls that reach a provider outside chat
 * (design 1.8): 20 connects and 60 checks per user per sliding hour. The
 * saved-conversation routes have their own three: 600 writes, 1,200 reads and
 * 300 searches.
 */

const HOUR = 60 * 60 * 1000;
const T0 = 1_800_000_000_000;

beforeEach(() => __resetRateLimits());

function take(n: number, user: string, bucket: Bucket, now: number): boolean[] {
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

  it.each([
    ['conv_write', 600],
    ['conv_read', 1_200],
    ['conv_search', 300],
    ['make', 30],
  ] as const)('allows %s %i an hour, then refuses, and frees up an hour later', (bucket, limit) => {
    expect(take(limit, 'u1', bucket, T0).every(Boolean)).toBe(true);
    expect(takeToken('u1', bucket, T0)).toBe(false);
    expect(takeToken('u1', bucket, T0 + HOUR)).toBe(true);
  });

  it('a busy conversation bucket leaves the others, and the provider buckets, alone', () => {
    take(600, 'u1', 'conv_write', T0);
    expect(takeToken('u1', 'conv_write', T0)).toBe(false);
    for (const other of ['conv_read', 'conv_search', 'connect', 'check'] as const) {
      expect(takeToken('u1', other, T0), other).toBe(true);
    }
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

  it('a cost takes that many tokens at once, or none', () => {
    take(29, 'u1', 'make', T0);
    // One left: a cost of 2 is refused and records nothing.
    expect(takeToken('u1', 'make', T0, 2)).toBe(false);
    expect(takeToken('u1', 'make', T0)).toBe(true);
    expect(takeToken('u1', 'make', T0)).toBe(false);
    // An hour on, both of a cost-2 call's tokens free up together.
    expect(takeToken('u2', 'make', T0, 2)).toBe(true);
    take(28, 'u2', 'make', T0 + 1000);
    expect(takeToken('u2', 'make', T0 + 1000)).toBe(false);
    expect(takeToken('u2', 'make', T0 + HOUR, 2)).toBe(true);
    expect(takeToken('u2', 'make', T0 + HOUR)).toBe(false);
  });

  it('survives far more users than the key cap', () => {
    for (let i = 0; i < 6_000; i++) expect(takeToken(`user-${i}`, 'check', T0)).toBe(true);
    // The most recent users are still tracked.
    take(59, 'user-5999', 'check', T0);
    expect(takeToken('user-5999', 'check', T0)).toBe(false);
  });
});
