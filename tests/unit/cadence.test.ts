import { describe, expect, it } from 'vitest';
import { cadenceLabel } from '@/lib/cadence';

describe('cadenceLabel', () => {
  it('names a repeat by its rule', () => {
    expect(cadenceLabel({ repeatFrequency: 'daily' })).toBe('Daily');
    expect(cadenceLabel({ repeatFrequency: 'weekdays' })).toBe('Weekdays');
    expect(cadenceLabel({ repeatFrequency: 'custom', repeatDays: [3, 1] })).toBe('Mon, Wed');
    expect(cadenceLabel({ repeatFrequency: 'custom', repeatDays: [0, 1, 2, 3, 4, 5, 6] })).toBe('Daily');
    expect(cadenceLabel({ repeatFrequency: 'monthly', repeatMonthDay: 12 })).toBe('Monthly · 12');
  });

  it('gives a one-off its day, or says it has none', () => {
    expect(cadenceLabel({ repeatFrequency: 'none', startDate: '2026-10-12' })).toMatch(/Oct\s*12/);
    expect(cadenceLabel({})).toBe('No date');
  });
});
