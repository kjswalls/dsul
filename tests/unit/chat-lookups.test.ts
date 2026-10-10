// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { FIND_LIMIT, RESULT_MAX_CHARS, makeLookups, type LookupSource } from '@/lib/ai-server/chat-lookups';
import { MAX_CALLS_PER_ROUND, MAX_ROUNDS, OUT_OF_ROUNDS_REPLY, lookupLoop, type LoopEvent } from '@/lib/ai-server/chat-loop';
import type { ProviderAdapter, ProviderCredentials, ToolStep } from '@/lib/ai-server/providers';
import type { Item } from '@/lib/planner-types';

/**
 * Chat's lookups (AI step 3, build step 2): what each tool finds and says,
 * and the loop that runs them between model rounds.
 */

const task = (over: Record<string, unknown>) =>
  ({
    type: 'task',
    status: 'pending',
    isScheduled: true,
    completedDates: [],
    ...over,
  }) as unknown as Item;

const ITEMS: Item[] = [
  task({ id: 't1', title: 'Book dentist', startDate: '2026-10-15', startTime: '09:00', project: 'Health' }),
  task({ id: 't2', title: 'Write report', startDate: '2026-10-12', project: 'Work', notes: 'Quarterly numbers' }),
  task({ id: 't3', title: 'Outline', parentItemId: 't2', startDate: '2026-10-12', project: 'Work' }),
  task({ id: 't4', title: 'Call the dentist back', status: 'completed', startDate: '2026-09-01' }),
  task({ id: 't5', title: 'Learn guitar', isScheduled: false }),
  { id: 'h1', type: 'habit', title: 'Floss', status: 'pending', streak: 4, completedDates: [], project: 'Health' } as unknown as Item,
];

function source(over: Partial<LookupSource> = {}): LookupSource {
  return {
    items: vi.fn(async () => ITEMS),
    projects: vi.fn(async () => [
      { id: 'p1', name: 'Health', emoji: '' },
      { id: 'p2', name: 'Work', emoji: '' },
    ]),
    routines: vi.fn(async () => [{ id: 'r1', name: 'Morning', itemIds: [] }]) as unknown as LookupSource['routines'],
    seasons: vi.fn(async () => null),
    goals: vi.fn(async () => []),
    events: vi.fn(async () => [
      { id: 'e1', itemId: 't1', itemType: 'task', action: 'update', payload: { startDate: '2026-10-15' }, createdAt: '2026-10-09T10:00:00Z' },
      { id: 'e2', itemId: 't1', itemType: 'task', action: 'create', payload: {}, createdAt: '2026-10-01T10:00:00Z' },
    ]),
    ...over,
  };
}

const call = (name: string, args: Record<string, unknown> | null = {}) => ({ id: 'c', name, args });

describe('find_items', () => {
  it('matches every word against title, notes and project, open items only by default', async () => {
    const r = await makeLookups(source()).run(call('find_items', { query: 'dentist' }));
    expect(r.action).toBe('Looked for "dentist" (1 found)');
    expect(r.content).toMatch(/^Data from the user's planner\./);
    expect(r.content).toContain('- Book dentist [id: t1] (task · 2026-10-15 09:00 · project: Health · pending)');
    expect(r.content).not.toContain('Call the dentist back');

    const notes = await makeLookups(source()).run(call('find_items', { query: 'quarterly' }));
    expect(notes.content).toContain('[id: t2]');
    expect(notes.content).toContain('notes: Quarterly numbers');
  });

  it('finished and any reach done work', async () => {
    const done = await makeLookups(source()).run(call('find_items', { query: 'dentist', status: 'finished' }));
    expect(done.content).toContain('Call the dentist back [id: t4]');
    expect(done.content).not.toContain('[id: t1]');
    const any = await makeLookups(source()).run(call('find_items', { query: 'dentist', status: 'any' }));
    expect(any.action).toBe('Looked for "dentist" (2 found)');
  });

  it('filters by day range, project (any case) and type; steps name their task', async () => {
    const r = await makeLookups(source()).run(call('find_items', { from: '2026-10-12', to: '2026-10-12', project: 'work' }));
    expect(r.action).toBe('Looked in work on 2026-10-12 (2 found)');
    expect(r.content).toContain('Outline [id: t3] (task · 2026-10-12 · project: Work · pending · step of "Write report")');

    const habits = await makeLookups(source()).run(call('find_items', { type: 'habit' }));
    expect(habits.content).toContain('Floss [id: h1] (habit · project: Health · streak 4)');
    expect(habits.content).not.toContain('[id: t1]');
  });

  it('lists dated items by day and time, then undated, and says when one has no day', async () => {
    const r = await makeLookups(source()).run(call('find_items', { status: 'any' }));
    const order = [...r.content.matchAll(/\[id: (\w+)\]/g)].map((m) => m[1]);
    expect(order).toEqual(['t4', 't2', 't3', 't1', 't5', 'h1']);
    expect(r.content).toContain('Learn guitar [id: t5] (task · no day (braindump) · pending)');
  });

  it(`caps the list at ${FIND_LIMIT} and says how many more`, async () => {
    const many = Array.from({ length: 40 }, (_, i) => task({ id: `m${i}`, title: `Errand ${i}`, isScheduled: false }));
    const r = await makeLookups(source({ items: async () => many })).run(call('find_items', { query: 'errand' }));
    expect(r.content.match(/\[id: m\d+\]/g)).toHaveLength(FIND_LIMIT);
    expect(r.content).toContain(`…and ${40 - FIND_LIMIT} more.`);
    expect(r.action).toBe('Looked for "errand" (40 found)');
  });

  it('caps one result in characters', async () => {
    const long = Array.from({ length: 30 }, (_, i) => task({ id: `l${i}`, title: `Long ${'x'.repeat(500)}`, notes: 'n'.repeat(500) }));
    const r = await makeLookups(source({ items: async () => long })).run(call('find_items', { query: 'long' }));
    expect(r.content.length).toBeLessThanOrEqual(RESULT_MAX_CHARS);
  });

  it('asks for a filter, and for days written as days', async () => {
    expect((await makeLookups(source()).run(call('find_items', {}))).content).toMatch(/^error: give at least one filter/);
    expect((await makeLookups(source()).run(call('find_items', { from: 'next week' }))).content).toMatch(/^error: from and to/);
  });

  it('clips long search words in the action line', async () => {
    const r = await makeLookups(source()).run(call('find_items', { query: 'a'.repeat(200) }));
    expect(r.action.length).toBeLessThan(100);
  });
});

describe('planner_overview', () => {
  it('lists projects with open counts, and says what could not be read', async () => {
    const r = await makeLookups(source()).run(call('planner_overview'));
    expect(r.action).toBe('Looked over your projects, routines and goals');
    expect(r.content).toContain('Items: 5 open (1 with no day), 1 finished.');
    expect(r.content).toContain('- Health [id: p1] (2 open)');
    expect(r.content).toContain('- Work [id: p2] (2 open)');
    expect(r.content).toContain('- Morning [id: r1]');
    expect(r.content).toContain('Seasons: could not be read just now.');
    expect(r.content).toContain('Goals: none.');
  });
});

describe('item_activity', () => {
  it("reads one item's history, newest first", async () => {
    const src = source();
    const r = await makeLookups(src).run(call('item_activity', { id: 't1' }));
    expect(r.action).toBe('Read the history of "Book dentist"');
    expect(src.events).toHaveBeenCalledWith('t1');
    expect(r.content).toContain('- 2026-10-09T10:00:00Z update {"startDate":"2026-10-15"}');
    expect(r.content).toContain('- 2026-10-01T10:00:00Z create');
  });

  it('an id that is not one of the user’s items reads nothing', async () => {
    const src = source();
    const r = await makeLookups(src).run(call('item_activity', { id: 'someone-elses' }));
    expect(r.content).toMatch(/^error: no item has that id/);
    expect(src.events).not.toHaveBeenCalled();
  });
});

describe('every call gets an answer, never a throw', () => {
  it('malformed arguments, an unknown tool, a planner that cannot be read', async () => {
    expect((await makeLookups(source()).run(call('find_items', null))).content).toMatch(/^error: the arguments/);
    expect((await makeLookups(source()).run(call('delete_everything'))).content).toMatch(/^error: there is no tool/);
    const broken = source({ items: async () => Promise.reject(new Error('db down')) });
    const r = await makeLookups(broken).run(call('find_items', { query: 'x' }));
    expect(r.content).toBe('error: the planner could not be read just now.');
  });

  it('reads the items once per turn, however many calls ask', async () => {
    const src = source();
    const lookups = makeLookups(src);
    await lookups.run(call('find_items', { query: 'a' }));
    await lookups.run(call('planner_overview'));
    await lookups.run(call('item_activity', { id: 't1' }));
    expect(src.items).toHaveBeenCalledTimes(1);
  });
});

// ── the loop ────────────────────────────────────────────────────────────────

function loopWith(steps: ToolStep[]) {
  const completeWithTools = vi.fn(async () => {
    const next = steps.shift();
    if (!next) throw new Error('no more steps');
    return next;
  });
  const adapter = { completeWithTools } as unknown as ProviderAdapter;
  const run = async () => {
    const out: LoopEvent[] = [];
    for await (const e of lookupLoop({
      adapter,
      creds: {} as ProviderCredentials,
      request: { model: 'm', modelMeta: {}, system: ['prompt'], maxOutputTokens: 100, signal: new AbortController().signal },
      messages: [{ role: 'user', content: 'where is the dentist?' }],
      lookups: makeLookups(source()),
    })) {
      out.push(e);
    }
    return out;
  };
  return { completeWithTools, run };
}

const find = (id: string, query = 'dentist') => ({ id, name: 'find_items', args: { query } });

describe('lookupLoop', () => {
  it('an answer with no calls is the reply', async () => {
    const { run, completeWithTools } = loopWith([{ text: 'Hi', toolCalls: [] }]);
    expect(await run()).toEqual([{ content: 'Hi' }]);
    expect(completeWithTools).toHaveBeenCalledTimes(1);
  });

  it('runs the calls, sends each action line, and gives the model the results', async () => {
    const { run, completeWithTools } = loopWith([
      { text: 'Looking.', toolCalls: [find('a'), { id: 'b', name: 'planner_overview', args: {} }] },
      { text: 'Thursday at 9.', toolCalls: [] },
    ]);
    expect(await run()).toEqual([
      { action: 'Looked for "dentist" (1 found)' },
      { action: 'Looked over your projects, routines and goals' },
      { content: 'Thursday at 9.' },
    ]);
    const second = (completeWithTools.mock.calls[1] as unknown[])[1] as { messages: unknown[] };
    expect(second.messages).toEqual([
      { role: 'user', content: 'where is the dentist?' },
      { role: 'assistant', content: 'Looking.', toolCalls: [find('a'), { id: 'b', name: 'planner_overview', args: {} }] },
      expect.objectContaining({ role: 'tool', callId: 'a', name: 'find_items' }),
      expect.objectContaining({ role: 'tool', callId: 'b', name: 'planner_overview' }),
    ]);
  });

  it(`runs at most ${MAX_CALLS_PER_ROUND} calls a round, and still answers the rest`, async () => {
    const calls = Array.from({ length: MAX_CALLS_PER_ROUND + 2 }, (_, i) => find(`c${i}`));
    const { run, completeWithTools } = loopWith([{ text: '', toolCalls: calls }, { text: 'ok', toolCalls: [] }]);
    const out = await run();
    expect(out.filter((e) => 'action' in e)).toHaveLength(MAX_CALLS_PER_ROUND);
    const second = (completeWithTools.mock.calls[1] as unknown[])[1] as { messages: Array<{ role: string; content: string }> };
    const results = second.messages.filter((m) => m.role === 'tool');
    expect(results).toHaveLength(calls.length);
    expect(results.at(-1)?.content).toMatch(/^error: at most/);
  });

  it(`stops after ${MAX_ROUNDS} rounds, telling the model on the last one`, async () => {
    const steps = Array.from({ length: MAX_ROUNDS }, (_, i) => ({ text: '', toolCalls: [find(`r${i}`)] }));
    const { run, completeWithTools } = loopWith(steps);
    const out = await run();
    expect(completeWithTools).toHaveBeenCalledTimes(MAX_ROUNDS);
    expect(out.filter((e) => 'action' in e)).toHaveLength(MAX_ROUNDS - 1);
    expect(out.at(-1)).toEqual({ content: OUT_OF_ROUNDS_REPLY });
    const last = (completeWithTools.mock.calls[MAX_ROUNDS - 1] as unknown[])[1] as { system: string[] };
    expect(last.system.at(-1)).toMatch(/used all your lookups/);
    const first = (completeWithTools.mock.calls[0] as unknown[])[1] as { system: string[] };
    expect(first.system).toEqual(['prompt']);
  });

  it('a last round that still asks but has words keeps its words', async () => {
    const steps = Array.from({ length: MAX_ROUNDS }, (_, i) => ({ text: i === MAX_ROUNDS - 1 ? 'Best guess: Thursday.' : '', toolCalls: [find(`r${i}`)] }));
    const { run } = loopWith(steps);
    expect((await run()).at(-1)).toEqual({ content: 'Best guess: Thursday.' });
  });

  it('a failing round throws for the route to classify', async () => {
    const { run } = loopWith([]);
    await expect(run()).rejects.toThrow('no more steps');
  });
});
