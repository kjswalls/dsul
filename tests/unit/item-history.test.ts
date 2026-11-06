import { describe, expect, it } from 'vitest';
import type { ItemEvent } from '@/lib/db';
import { buildHistory, editCount, happenedOnly, historyText } from '@/lib/item-history';

const now = new Date();
const at = (h: number, daysAgo = 0) => {
  const d = new Date(now);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, 0, 0, 0);
  return d.toISOString();
};
const ev = (id: string, action: string, payload: Record<string, unknown>, createdAt: string) =>
  ({ id, itemId: 'i1', itemType: 'task', action, payload, createdAt }) as unknown as ItemEvent;

const events = [
  ev('e1', 'create', { title: 'x' }, at(8, 1)),
  ev('e2', 'update', { notes: 'a note' }, at(9)),
  ev('e3', 'update', { title: 'Call the dentist', by: 'ai' }, at(10)),
  ev('e4', 'update', { status: 'completed' }, at(11)),
];

describe('historyText', () => {
  it('drops the "it" and capitalises', () => {
    expect(historyText('moved it to Tue, Nov 3')).toBe('Moved to Tue, Nov 3');
    expect(historyText('let it go')).toBe('Let go');
    expect(historyText('marked it done')).toBe('Marked done');
  });
});

describe('buildHistory', () => {
  const days = buildHistory(events, new Date(at(12)));

  it('puts the newest day first and the newest row first in it', () => {
    expect(days.map((d) => d.label)).toEqual(['Today', 'Yesterday']);
    expect(days[0].rows.map((r) => r.at)).toEqual([...days[0].rows.map((r) => r.at)].sort((a, b) => b - a));
    expect(days[1].rows[0]).toMatchObject({ icon: 'added', text: 'Added', by: null });
  });

  it('names who did it only when it was not you, and keeps the AI’s rows in what happened', () => {
    const ai = days[0].rows.find((r) => r.actor === 'ai')!;
    expect(ai.by).toBe('AI');
    expect(ai.happened).toBe(true);
    const done = days[0].rows.find((r) => r.icon === 'done')!;
    expect(done.happened).toBe(true);
  });

  it('holds your own small edits behind Show all edits', () => {
    const notes = days[0].rows.find((r) => r.text === 'Edited the notes')!;
    expect(notes.happened).toBe(false);
    expect(editCount(days)).toBe(1);
    expect(happenedOnly(days).flatMap((d) => d.rows).some((r) => r.key === notes.key)).toBe(false);
  });

  it('drops a day left empty by what happened', () => {
    const onlyEdit = buildHistory([ev('n', 'update', { notes: 'x' }, at(9))], new Date(at(12)));
    expect(onlyEdit).toHaveLength(1);
    expect(happenedOnly(onlyEdit)).toEqual([]);
  });
});
