import { describe, expect, it } from 'vitest';
import { moveToSlot, slotAt, sortSubtasks, stepTo } from '@/lib/subtasks';

const ids = ['a', 'b', 'c', 'd'];

describe('subtask order (lib/subtasks.ts)', () => {
  it('sorts by order, rows with none last in the order they came', () => {
    const rows = [{ id: 'x' }, { id: 'b', order: 2 }, { id: 'y' }, { id: 'a', order: 1 }];
    expect(sortSubtasks(rows).map((r) => r.id)).toEqual(['a', 'b', 'x', 'y']);
  });

  it('moves a row into a gap of the original list', () => {
    expect(moveToSlot(ids, 'd', 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveToSlot(ids, 'a', 4)).toEqual(['b', 'c', 'd', 'a']);
    expect(moveToSlot(ids, 'a', 2)).toEqual(['b', 'a', 'c', 'd']);
    expect(moveToSlot(ids, 'c', 1)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('writes nothing for a drop back into its own place, or an unknown row', () => {
    expect(moveToSlot(ids, 'b', 1)).toBeNull();
    expect(moveToSlot(ids, 'b', 2)).toBeNull();
    expect(moveToSlot(ids, 'z', 0)).toBeNull();
  });

  it('steps up, down and to either end, and stops at the ends', () => {
    expect(stepTo(ids, 'b', 'up')).toEqual(['b', 'a', 'c', 'd']);
    expect(stepTo(ids, 'b', 'down')).toEqual(['a', 'c', 'b', 'd']);
    expect(stepTo(ids, 'c', 'top')).toEqual(['c', 'a', 'b', 'd']);
    expect(stepTo(ids, 'b', 'bottom')).toEqual(['a', 'c', 'd', 'b']);
    expect(stepTo(ids, 'a', 'up')).toBeNull();
    expect(stepTo(ids, 'd', 'down')).toBeNull();
    expect(stepTo(ids, 'a', 'top')).toBeNull();
    expect(stepTo(ids, 'd', 'bottom')).toBeNull();
  });

  it('finds the gap under the pointer from the rows\' middles', () => {
    const middles = [15, 45, 75];
    expect(slotAt(middles, 0)).toBe(0);
    expect(slotAt(middles, 30)).toBe(1);
    expect(slotAt(middles, 74)).toBe(2);
    expect(slotAt(middles, 200)).toBe(3);
  });
});
