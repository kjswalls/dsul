import { describe, expect, it } from 'vitest';
import {
  actorOf,
  buildStream,
  buildTimeline,
  changeLine,
  foldLine,
  talkLine,
  type ChangeEntry,
  type TalkEntry,
} from '@/lib/item-timeline';
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
  it('reads your own hand-off and re-queue as you, though they carry a status', () => {
    // "Hand off to Claude" writes this with no `by`; it once read "OpenClaw assigned it to Claude".
    expect(actorOf(ev({ action: 'update', payload: { assignee: 'Claude', aiStatus: 'queued' } }))).toBe('you');
    expect(actorOf(ev({ action: 'update', payload: { assignee: null, aiStatus: null } }))).toBe('you');
    expect(actorOf(ev({ action: 'update', payload: { aiStatus: 'queued' } }))).toBe('you');
    expect(actorOf(ev({ action: 'update', payload: { aiStatus: 'blocked', by: 'agent' } }))).toBe('agent');
  });

  it('names the agent by who held the item when the line was written', () => {
    const days = buildTimeline(
      [
        // Newest first, as fetchItemEvents returns them.
        ev({ action: 'agent_question', payload: { question: 'Which dentist?' } }, '2026-10-14T02:55:58'),
        ev({ action: 'update', payload: { aiStatus: 'working', by: 'agent' } }, '2026-10-14T02:55:52'),
        ev({ action: 'update', payload: { assignee: 'Claude', aiStatus: 'queued' } }, '2026-10-14T02:55:15'),
        ev({ action: 'update', payload: { assignee: null, aiStatus: null } }, '2026-10-13T22:12:00'),
        ev({ action: 'update', payload: { aiStatus: 'working', by: 'agent' } }, '2026-10-13T18:40:00'),
        ev({ action: 'update', payload: { assignee: 'openclaw', aiStatus: 'queued' } }, '2026-10-13T18:36:00'),
      ],
      [],
      { filter: 'all', now: new Date('2026-10-14T12:00:00') }
    );
    const lines = days.flatMap((d) => d.entries).map((e) => (e.kind === 'change' ? [e.by, e.agent ?? null, e.text] : null));
    expect(lines).toEqual([
      ['you', null, 'handed it to OpenClaw'],
      ['agent', 'OpenClaw', 'marked it working'],
      ['you', null, 'took it back'],
      ['you', null, 'assigned it to Claude'],
      ['agent', 'Claude', 'marked it working'],
      ['agent', 'Claude', 'asked: “Which dentist?”'],
    ]);
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

describe('a long history', () => {
  const now = new Date('2026-10-12T23:00:00');
  const move = (day: string | null, at: string) =>
    ev({ action: 'update', id: `m-${at}`, payload: { startDate: day, isScheduled: !!day } }, at);
  const texts = (events: ItemEvent[]) =>
    buildTimeline(events, [], { filter: 'changes', now }).flatMap((d) => d.entries.map((e) => (e as ChangeEntry).text));

  it('reads a burst of the same change as where it ended up', () => {
    const burst = [
      move('2026-10-12', '2026-10-12T22:22:00'),
      move(null, '2026-10-12T22:22:10'),
      move('2026-10-12', '2026-10-12T22:22:20'),
      move(null, '2026-10-12T22:22:30'),
    ];
    expect(texts(burst)).toEqual(['moved it to the braindump']);
  });

  it('keeps changes of different kinds, by different people, or far apart', () => {
    expect(
      texts([
        ev({ action: 'update', id: 'a', payload: { pausedAt: 'x' } }, '2026-10-12T10:00:00'),
        ev({ action: 'update', id: 'b', payload: { status: 'completed' } }, '2026-10-12T10:00:05'),
        ev({ action: 'update', id: 'c', payload: { status: 'pending' } }, '2026-10-12T10:00:10'),
        ev({ action: 'update', id: 'd', payload: { status: 'completed', by: 'ai' } }, '2026-10-12T10:00:20'),
        ev({ action: 'update', id: 'e', payload: { status: 'pending', by: 'ai' } }, '2026-10-12T11:00:00'),
      ])
    ).toEqual(['paused it', 'opened it again', 'marked it done', 'opened it again']);
  });

  it('drops a change that says nothing', () => {
    expect(texts([ev({ action: 'update', id: 'z', payload: { projectId: 'p1' } }, '2026-10-12T10:00:00')])).toEqual([]);
  });

  it('sets changes between the messages, folds a long run, and never folds messages', () => {
    const events = Array.from({ length: 6 }, (_, n) =>
      ev({ action: 'update', id: `p${n}`, payload: { priority: n % 2 ? 'low' : 'high' } }, `2026-10-0${n + 1}T10:00:00`)
    );
    events.push(ev({ action: 'update', id: 'late', payload: { title: 'Later' } }, '2026-10-12T12:00:00'));
    const messages = [
      { createdAt: new Date('2026-10-12T09:00:00').getTime() },
      { createdAt: new Date('2026-10-12T09:01:00').getTime() },
    ];
    const slots = buildStream(events, messages, { filter: 'all', now });
    expect(slots).toHaveLength(3);
    const kinds = slots.map((rows) => rows.map((r) => r.kind));
    expect(kinds[0]).toEqual(['fold', 'day', 'change', 'day', 'change', 'day', 'change', 'day']);
    expect(slots[0][0]).toMatchObject({ kind: 'fold', hidden: 3 });
    expect(foldLine(3)).toBe('Show 3 earlier changes');
    expect(kinds[1]).toEqual([]);
    expect(kinds[2]).toEqual(['change']);
    const open = buildStream(events, messages, { filter: 'all', now, unfolded: new Set([0]) });
    expect(open[0].filter((r) => r.kind === 'change')).toHaveLength(6);
    expect(buildStream(events, messages, { filter: 'talk', now }).flat().every((r) => r.kind === 'day')).toBe(true);
    expect(buildStream(events, messages, { filter: 'changes', now })).toHaveLength(1);
  });
});
