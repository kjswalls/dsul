import { describe, expect, it } from 'vitest';
import { createFaultCounter, faultReason, wallFaultCounts } from '@/lib/mods/faults';

const MOD = 'm1';
const MIN = 60_000;

describe('the fault counter', () => {
  it('three faults in 10 minutes trip it', () => {
    const c = createFaultCounter();
    expect(c.record(MOD, 0)).toBe(false);
    expect(c.record(MOD, 4 * MIN)).toBe(false);
    expect(c.record(MOD, 9 * MIN)).toBe(true);
  });

  it('three faults spread over 11 minutes do not', () => {
    const c = createFaultCounter();
    c.record(MOD, 0);
    c.record(MOD, 5 * MIN);
    expect(c.record(MOD, 11 * MIN)).toBe(false);
  });

  it('counts each mod apart, and clear starts over', () => {
    const c = createFaultCounter();
    c.record(MOD, 0);
    c.record(MOD, 1);
    expect(c.record('other', 2)).toBe(false);
    c.clear(MOD);
    expect(c.record(MOD, 3)).toBe(false);
  });
});

describe('the reason', () => {
  it('says why, and is clipped to 061’s 200', () => {
    expect(faultReason('cpu', 'InternalError: interrupted')).toBe(
      '3 errors in 10 minutes. Last: InternalError: interrupted'
    );
    expect(faultReason('error', 'x'.repeat(300))).toHaveLength(200);
    expect(faultReason('wall', '  ')).toBe('3 errors in 10 minutes. Last: It took too long');
  });
});

describe('the wall clock', () => {
  it('counts a wall fault only when the tab was visible and did not sleep', () => {
    expect(wallFaultCounts({ hidden: false, wallElapsedMs: 600, monoElapsedMs: 600 })).toBe(true);
    expect(wallFaultCounts({ hidden: true, wallElapsedMs: 600, monoElapsedMs: 600 })).toBe(false);
    expect(wallFaultCounts({ hidden: false, wallElapsedMs: 60_000, monoElapsedMs: 600 })).toBe(false);
  });
});
