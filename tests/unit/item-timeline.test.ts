import { describe, expect, it } from 'vitest';
import { actorOf, buildTimeline, changeLine, talkLine, type TalkEntry } from '@/lib/item-timeline';
import type { ItemEvent } from '@/lib/db';

/**
 * The item's timeline, pure (lib/item-timeline.ts): who made a change, the
 * sentence for it, and the stream by day with a day's talk folded to a line.
 */

const ev = (over: Partial<ItemEvent> & { action: string }, at = '2026-10-11T08:20:00'): ItemEvent => ({
  id: `${over.action}-${at}`,
  itemId: 'i1',
  itemType: 'task',
  payload: {},
  createdAt: new Date(at).toISOString(),
  ...over,
});

describe('who', () => {
  it('reads the author from the payload, and an older row as you', () => {
    expect(actorOf(ev({ action: 'update', payload: { title: 'x', by: 'ai' } }))).toBe('ai');
    expect(actorOf(ev({ action: 'update', payload: { title: 'x', by: 'agent' } }))).toBe('agent');
    expect(actorOf(ev({ action: 'update', payload: { title: 'x', by: 'nobody' } }))).toBe('you');
    expect(actorOf(ev({ action: 'update', payload: { title: 'x' } }))).toBe('you');
  });

  it('names the agent for the two kinds only an agent writes, even on an older row', () => {
    expect(actorOf(ev({ action: 'agent_question', payload: { question: 'Which day?' } }))).toBe('agent');
    expect(actorOf(ev({ action: 'update', payload: { aiStatus: 'working' } }))).toBe('agent');
    expect(actorOf(ev({ action: 'agent_reply', payload: { text: 'Monday' } }))).toBe('you');
  });
});

describe('what', () => {
  const line = (action: string, payload: Record<string, unknown> = {}) => changeLine({ action, payload });
  it('says each change in words', () => {
    expect(line('create')).toBe('added it');
    expect(line('delete')).toBe('deleted it');
    expect(line('update', { startDate: '2026-10-14', isScheduled: true })).toBe('moved it to Wed, Oct 14');
    expect(line('update', { startDate: null, isScheduled: false })).toBe('moved it to the braindump');
    expect(line('update', { title: 'Call the dentist' })).toBe('renamed it “Call the dentist”');
    expect(line('update', { status: 'completed' })).toBe('marked it done');
    expect(line('update', { status: 'pending' })).toBe('opened it again');
    expect(line('update', { project: 'Health', projectId: 'p1' })).toBe('filed it under Health');
    expect(line('update', { project: null, projectId: null })).toBe('took it out of its project');
    expect(line('update', { notes: 'x' })).toBe('edited the notes');
    expect(line('update', { assignee: 'openclaw' })).toBe('handed it to OpenClaw');
    expect(line('update', { assignee: null })).toBe('took it back');
    expect(line('update', { assignee: 'beacon' })).toBe('assigned it to AI');
    expect(line('update', { pausedAt: '2026-10-11' })).toBe('paused it');
    expect(line('checkin', { note: 'went well' })).toBe('checked in: “went well”');
    expect(line('agent_question', { question: 'Which day?' })).toBe('asked: “Which day?”');
  });

  it('never names its author key or an internal id as a changed field', () => {
    expect(line('update', { title: 'x', by: 'ai' })).toBe('renamed it “x”');
    expect(line('update', { notes: 'a', duration: '15m', by: 'you' })).toBe('changed the notes and how long it takes');
    expect(line('update', { by: 'you' })).toBe('changed it');
    expect(line('update', { someColumnNobodyKnows: 1 })).toBe('changed it');
  });
});

describe('the stream', () => {
  const now = new Date('2026-10-11T12:00:00');
  const events = [
    ev({ action: 'update', payload: { startDate: '2026-10-14' } }, '2026-10-11T08:20:00'),
    ev({ action: 'create', payload: { title: 'x' } }, '2026-10-09T21:40:00'),
    ev({ action: 'update', payload: { aiStatus: 'done' } }, '2026-10-10T11:03:00'),
  ];
  const messages = [
    { role: 'user' as const, createdAt: new Date('2026-10-10T09:00:00').getTime(), answerer: null },
    { role: 'assistant' as const, createdAt: new Date('2026-10-10T09:01:00').getTime(), answerer: 'model' as const },
  ];

  it('runs oldest first, by day, with a day’s talk folded to one line', () => {
    const days = buildTimeline(events, messages, { filter: 'all', now });
    expect(days.map((d) => d.label)).toEqual(['Fri, Oct 9', 'Yesterday', 'Today']);
    expect(days[1].entries.map((e) => e.kind)).toEqual(['talk', 'change']);
    expect(talkLine(days[1].entries[0] as TalkEntry)).toBe('You and the AI talked it through · 2 messages');
  });

  it('filters to talk or to changes', () => {
    expect(buildTimeline(events, messages, { filter: 'talk', now }).flatMap((d) => d.entries.map((e) => e.kind))).toEqual(['talk']);
    expect(
      buildTimeline(events, messages, { filter: 'changes', now }).flatMap((d) => d.entries.map((e) => e.kind))
    ).toEqual(['change', 'change', 'change']);
  });

  it('names OpenClaw on a day it answered', () => {
    const days = buildTimeline([], [...messages, { role: 'assistant', createdAt: messages[1].createdAt + 1, answerer: 'openclaw' }], {
      filter: 'all',
      now,
    });
    expect(talkLine(days[0].entries[0] as TalkEntry)).toBe('You and OpenClaw talked it through · 3 messages');
  });
});
