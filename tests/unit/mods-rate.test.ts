import { describe, expect, it } from 'vitest';
import { createHistoryWindow, createHookRate, hookRateReason } from '@/lib/mods/rate';

const DAY = '2026-03-10';

describe('the hook rate', () => {
  it('31 hooks in a minute trip it', () => {
    const r = createHookRate();
    for (let i = 0; i < 30; i++) expect(r.take('m', i * 1000, DAY)).toBeNull();
    expect(r.take('m', 30_500, DAY)).toBe('minute');
    // Another mod has its own count.
    expect(r.take('other', 30_500, DAY)).toBeNull();
  });

  it('a minute later there is room again', () => {
    const r = createHookRate();
    for (let i = 0; i < 30; i++) r.take('m', 0, DAY);
    expect(r.take('m', 60_001, DAY)).toBeNull();
  });

  it('1001 in a day trips it, and a new day starts over', () => {
    const r = createHookRate(Infinity, 1000);
    for (let i = 0; i < 1000; i++) expect(r.take('m', i, DAY)).toBeNull();
    expect(r.take('m', 2000, DAY)).toBe('day');
    expect(r.take('m', 3000, '2026-03-11')).toBeNull();
  });

  it('says so in the recipe wording', () => {
    expect(hookRateReason('minute')).toBe('It ran more than 30 times in a minute.');
    expect(hookRateReason('day')).toBe('It ran more than 1000 times today.');
  });
});

describe('the history window', () => {
  it('ten real entries per mod in 10 minutes, then no more', () => {
    const w = createHistoryWindow();
    for (let i = 0; i < 10; i++) {
      expect(w.allows('a', i)).toBe(true);
      w.record('a', i);
    }
    expect(w.allows('a', 10)).toBe(false);
    expect(w.allows('b', 10)).toBe(true);
    expect(w.allows('a', 600_001)).toBe(true);
  });

  it('twenty across every mod together', () => {
    const w = createHistoryWindow();
    for (let i = 0; i < 20; i++) w.record(`m${i % 4}`, i);
    expect(w.allows('fresh', 20)).toBe(false);
  });
});
