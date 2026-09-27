import { describe, expect, it } from 'vitest';
import { deriveActivity } from '@/lib/container-activity';
import type { Item } from '@/lib/planner-types';

const TODAY = '2026-09-26';
const tz = 'UTC';

const habit = (id: string, title: string, completedDates: string[] = []): Item =>
  ({ id, title, type: 'habit', status: 'pending', repeatFrequency: 'daily', completedDates, skippedDates: [] }) as unknown as Item;
const task = (id: string, title: string): Item =>
  ({ id, title, type: 'task', status: 'pending', completedDates: [], skippedDates: [] }) as unknown as Item;

describe('deriveActivity', () => {
  it('lists completions by date and additions from the log, newest first', () => {
    const out = deriveActivity({
      members: [habit('h1', 'Journal', ['2026-09-24', '2026-09-26']), task('t1', 'Book physio')],
      events: [
        { itemId: 't1', action: 'create', payload: {}, createdAt: '2026-09-25T09:00:00Z' },
        { itemId: 't1', action: 'update', payload: { status: 'completed' }, createdAt: '2026-09-25T18:00:00Z' },
        { itemId: 't1', action: 'update', payload: { title: 'x' }, createdAt: '2026-09-25T19:00:00Z' },
      ],
      todayStr: TODAY,
      tz,
    });
    expect(out.map((e) => `${e.kind}:${e.title}:${e.date}`)).toEqual([
      'completed:Journal:2026-09-26',
      'completed:Book physio:2026-09-25',
      'added:Book physio:2026-09-25',
      'completed:Journal:2026-09-24',
    ]);
  });

  it('keeps to the last two weeks, ignores non-members, and caps the feed', () => {
    const many = Array.from({ length: 10 }, (_, i) => `2026-09-${String(26 - i).padStart(2, '0')}`);
    const out = deriveActivity({
      members: [habit('h1', 'Stretch', [...many, '2026-08-01'])],
      events: [{ itemId: 'ghost', action: 'create', payload: {}, createdAt: '2026-09-26T09:00:00Z' }],
      todayStr: TODAY,
      tz,
    });
    expect(out).toHaveLength(6);
    expect(out.every((e) => e.itemId === 'h1' && e.date >= '2026-09-13')).toBe(true);
  });

  it('never counts a recurring completion twice when the log also saw it', () => {
    const out = deriveActivity({
      members: [habit('h1', 'Journal', ['2026-09-26'])],
      events: [{ itemId: 'h1', action: 'update', payload: { status: 'done' }, createdAt: '2026-09-26T20:00:00Z' }],
      todayStr: TODAY,
      tz,
    });
    expect(out.filter((e) => e.kind === 'completed')).toHaveLength(1);
  });
});
