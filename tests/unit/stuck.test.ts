import { describe, it, expect } from 'vitest';
import { ledgerFor, prepCandidates, recordAsked } from '@/lib/background-prep';
import type { Item } from '@/lib/planner-types';
import { isStuck, moveCounts, STUCK_AT } from '@/lib/stuck';

/**
 * Unstick (lib/stuck.ts): an item moved to another day on three different
 * days is stuck, and prep gets it a smaller start, first and once.
 */

const TODAY = '2026-10-21';
const task = (over: Record<string, unknown> = {}): Item =>
  ({ type: 'task', id: 'a', title: 'Renew the passport', status: 'pending', isScheduled: false, order: 0, ...over }) as Item;
const ctx = (over: Partial<Parameters<typeof prepCandidates>[1]> = {}) => ({
  todayStr: TODAY,
  inactiveIds: new Set<string>(),
  hasPack: () => false,
  ledger: ledgerFor(null, TODAY),
  ...over,
});

describe('moveCounts', () => {
  it('counts the different days an item was moved on, so a double drag is one', () => {
    const counts = moveCounts([
      { itemId: 'a', day: '2026-10-18' },
      { itemId: 'a', day: '2026-10-18' },
      { itemId: 'a', day: '2026-10-19' },
      { itemId: 'b', day: '2026-10-19' },
      { itemId: 'a', day: '2026-10-20' },
    ]);
    expect(counts.get('a')).toBe(3);
    expect(counts.get('b')).toBe(1);
    expect(isStuck(counts.get('a'))).toBe(true);
    expect(isStuck(counts.get('b'))).toBe(false);
    expect(isStuck(undefined)).toBe(false);
    expect(STUCK_AT).toBe(3);
  });
});

describe('background prep and stuck items', () => {
  const stuck = (i: Item) => i.id === 'stuck';

  it('takes stuck items first, on any day, before today and the braindump', () => {
    const items = [
      task({ id: 'dump' }),
      task({ id: 'today', startDate: TODAY, isScheduled: true }),
      task({ id: 'stuck', startDate: '2026-10-24', isScheduled: true }),
    ];
    expect(prepCandidates(items, ctx({ stuck })).map((i) => i.id)).toEqual(['stuck', 'today', 'dump']);
  });

  it('asks again once when an item already asked about becomes stuck, then not again', () => {
    const item = task({ id: 'stuck', startDate: TODAY, isScheduled: true });
    const before = recordAsked(ledgerFor(null, TODAY), [item]);
    expect(prepCandidates([item], ctx({ ledger: before }))).toEqual([]);
    expect(prepCandidates([item], ctx({ ledger: before, stuck }))).toHaveLength(1);
    const after = recordAsked(before, [item], stuck);
    expect(prepCandidates([item], ctx({ ledger: after, stuck }))).toEqual([]);
  });
});

describe('prepItemFor', () => {
  it('marks a stuck item, and only a stuck one', async () => {
    const { useStuckStore } = await import('@/lib/stuck-store');
    const { prepItemFor } = await import('@/lib/prep-packs-store');
    useStuckStore.setState({ moves: { stuck: 3, moved: 2 } });
    expect(prepItemFor(task({ id: 'stuck' }), []).stuck).toBe(true);
    expect(prepItemFor(task({ id: 'moved' }), []).stuck).toBeUndefined();
  });
});
