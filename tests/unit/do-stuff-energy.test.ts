import { describe, it, expect } from 'vitest';
import { energyOrder } from '@/lib/do-stuff-plan';

/** The energy-aware walk (lib/do-stuff-plan.ts energyOrder). */

const row = (title: string, size?: string) => ({ item: { title, ...(size ? { size } : {}) } });
const titles = (rows: { item: { title: string } }[]) => rows.map((r) => r.item.title);

describe('energyOrder', () => {
  const rows = [row('report', 'big'), row('reply', 'quick'), row('post office', 'errand'), row('think', 'fuzzy'), row('bin', 'quick')];

  it('low puts the small things first, keeping the plan order within a size', () => {
    expect(titles(energyOrder(rows, 'low'))).toEqual(['reply', 'bin', 'post office', 'think', 'report']);
  });

  it('high puts the big things first', () => {
    expect(titles(energyOrder(rows, 'high'))).toEqual(['report', 'post office', 'think', 'reply', 'bin']);
  });

  it('okay, or nothing said, changes nothing', () => {
    expect(titles(energyOrder(rows, 'okay'))).toEqual(titles(rows));
    expect(titles(energyOrder(rows, null))).toEqual(titles(rows));
  });
});
