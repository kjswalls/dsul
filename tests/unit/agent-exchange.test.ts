import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * An agent's exchange about an item, read as chat (lib/agent-exchange.ts), and
 * the item's box answering the agent while its question is open
 * (lib/agent-question.ts `routeItemSendToAgent`).
 */

const recordAgentReply = vi.fn();
const updateTask = vi.fn();
let items: Record<string, unknown>[] = [];

vi.mock('@/lib/db', () => ({
  recordAgentReply: (...args: unknown[]) => recordAgentReply(...args),
}));
vi.mock('@/lib/planner-store', () => ({
  usePlannerStore: { getState: () => ({ items, updateTask }) },
}));
vi.mock('@/lib/planner-ready', () => ({ isPlannerPreviewing: () => false }));

import { buildAgentExchange } from '@/lib/agent-exchange';
import { routeItemSendToAgent, useAgentAnswers } from '@/lib/agent-question';
import type { ItemEvent } from '@/lib/db';

let n = 0;
const ev = (action: string, payload: Record<string, unknown>, createdAt: string): ItemEvent => ({
  id: `e${++n}`,
  itemId: 'i1',
  itemType: 'task',
  action,
  payload,
  createdAt,
});
const handoff = (at: string) => ev('update', { assignee: 'claude', aiStatus: 'queued' }, at);
const asked = (q: string, at: string) => ev('agent_question', { question: q, options: [] }, at);
const answered = (text: string, at: string) => ev('agent_reply', { text }, at);
const result = (status: string, text: string, at: string) =>
  ev('update', { aiStatus: status, aiResult: text, by: 'agent' }, at);
const newestFirst = (...e: ItemEvent[]) => e.reverse();

describe('buildAgentExchange', () => {
  it('is null with no assignee, and while the agent has said nothing', () => {
    expect(buildAgentExchange([asked('Q?', '2026-10-14T10:01:00Z')], {})).toBeNull();
    expect(
      buildAgentExchange([handoff('2026-10-14T10:00:00Z')], { assignee: 'claude', aiStatus: 'queued' })
    ).toBeNull();
  });

  it('reads hand-off, question, answer and result in order', () => {
    const x = buildAgentExchange(
      newestFirst(
        handoff('2026-10-14T10:00:00Z'),
        asked('Which dentist?', '2026-10-14T10:01:00Z'),
        answered('Dr. Lee', '2026-10-14T11:00:00Z'),
        result('done', 'Booked for Tuesday', '2026-10-14T11:05:00Z')
      ),
      { assignee: 'claude', aiStatus: 'done', aiResult: 'Booked for Tuesday' }
    )!;
    expect(x.agent).toBe('Claude');
    expect(x.entries.map((e) => e.kind)).toEqual(['handoff', 'agent', 'you', 'agent']);
    expect(x.openQuestion).toBe(false);
    expect(x.working).toBe(false);
  });

  it('starts at the latest hand-off', () => {
    const x = buildAgentExchange(
      newestFirst(
        handoff('2026-10-13T10:00:00Z'),
        asked('Old question', '2026-10-13T10:01:00Z'),
        handoff('2026-10-14T10:00:00Z'),
        asked('New question', '2026-10-14T10:01:00Z')
      ),
      { assignee: 'claude', aiStatus: 'blocked', aiResult: 'New question' }
    )!;
    expect(x.entries.filter((e) => e.kind === 'agent').map((e) => (e as { text: string }).text)).toEqual([
      'New question',
    ]);
    expect(x.openQuestion).toBe(true);
  });

  it('does not repeat a question also written as the blocked result', () => {
    const x = buildAgentExchange(
      newestFirst(asked('Q?', '2026-10-14T10:01:00Z'), result('blocked', 'Q?', '2026-10-14T10:01:01Z')),
      { assignee: 'claude', aiStatus: 'blocked', aiResult: 'Q?' }
    )!;
    expect(x.entries.filter((e) => e.kind === 'agent')).toHaveLength(1);
  });

  it('shows the open question from aiResult when the trail has none', () => {
    const x = buildAgentExchange([], {
      assignee: 'claude',
      aiStatus: 'blocked',
      aiResult: 'Morning or afternoon?',
      aiStatusAt: '2026-10-14T10:00:00Z',
    })!;
    expect(x.entries).toHaveLength(1);
    expect(x.openQuestion).toBe(true);
  });

  it('shows an answer sent here before the trail has it, once', () => {
    const at = Date.parse('2026-10-14T11:00:00Z');
    const base = { assignee: 'claude', aiStatus: 'queued' };
    const q = asked('Q?', '2026-10-14T10:01:00Z');
    const pending = buildAgentExchange([q], base, [{ text: 'Yes', at }])!;
    expect(pending.entries.map((e) => e.kind)).toEqual(['agent', 'you']);
    expect(pending.working).toBe(true);
    const landed = buildAgentExchange(newestFirst(q, answered('Yes', '2026-10-14T11:00:02Z')), base, [
      { text: 'Yes', at },
    ])!;
    expect(landed.entries.filter((e) => e.kind === 'you')).toHaveLength(1);
  });

  it('drops an answer sent before the current hand-off', () => {
    const x = buildAgentExchange(
      newestFirst(handoff('2026-10-13T10:00:00Z'), handoff('2026-10-14T10:00:00Z')),
      { assignee: 'claude', aiStatus: 'queued' },
      [{ text: 'Dr. Lee', at: Date.parse('2026-10-13T11:00:00Z') }]
    );
    expect(x).toBeNull();
  });
});

describe('routeItemSendToAgent', () => {
  beforeEach(() => {
    recordAgentReply.mockReset();
    updateTask.mockReset();
    useAgentAnswers.setState({ byItem: {}, toModel: {} });
  });

  it('answers the agent while its question is open', () => {
    items = [{ id: 'i1', type: 'task', assignee: 'claude', aiStatus: 'blocked' }];
    expect(routeItemSendToAgent('i1', ' Dr. Lee ')).toBe(true);
    expect(recordAgentReply).toHaveBeenCalledWith('i1', 'task', 'Dr. Lee');
    expect(updateTask).toHaveBeenCalledWith('i1', { aiStatus: 'queued' });
    expect(useAgentAnswers.getState().byItem.i1).toHaveLength(1);
  });

  it('leaves the model to answer when nothing is open, or the box was turned back', () => {
    items = [{ id: 'i1', type: 'task', assignee: 'claude', aiStatus: 'working' }];
    expect(routeItemSendToAgent('i1', 'hi')).toBe(false);
    items = [{ id: 'i1', type: 'task', assignee: 'claude', aiStatus: 'blocked' }];
    useAgentAnswers.getState().setToModel('i1', true);
    expect(routeItemSendToAgent('i1', 'hi')).toBe(false);
    expect(recordAgentReply).not.toHaveBeenCalled();
  });
});
