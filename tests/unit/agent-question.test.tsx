import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

/**
 * The two pieces AgentReply and Ask home's Needs-you card share
 * (lib/agent-question.ts, hooks/use-agent-question.ts). AgentReply's own
 * behaviour stays pinned by agent-reply-options.test.tsx; this pins the
 * pieces on their own, so a second caller cannot drift from the first.
 */

const recordAgentReply = vi.fn();
const updateTask = vi.fn();
type Ev = { action: string; payload: Record<string, unknown>; createdAt: string };
const eventsById: Record<string, Ev[]> = {};
let available = true;

vi.mock('@/lib/db', () => ({
  fetchItemEvents: vi.fn(async (id: string) => eventsById[id] ?? []),
  getItemEventsAvailable: () => available,
  recordAgentReply: (...args: unknown[]) => recordAgentReply(...args),
}));
vi.mock('@/lib/planner-store', () => ({
  usePlannerStore: { getState: () => ({ updateTask }) },
}));

import { answerAgentQuestion, pickOpenQuestionOptions } from '@/lib/agent-question';
import { useAgentQuestion } from '@/hooks/use-agent-question';
import type { Item } from '@/lib/planner-types';

const question = (q: string, options: unknown[], at = '2026-10-02T10:00:00Z'): Ev => ({
  action: 'agent_question',
  payload: { question: q, options },
  createdAt: at,
});
const reply = (at: string): Ev => ({ action: 'agent_reply', payload: { text: 'x' }, createdAt: at });

const item = (over: Record<string, unknown> = {}) =>
  ({
    type: 'task',
    id: 'item-1',
    title: 'Book the dentist',
    status: 'pending',
    isScheduled: false,
    order: 0,
    assignee: 'openclaw',
    aiStatus: 'blocked',
    aiResult: 'Tue 3pm or Thu 10am?',
    ...over,
  }) as Item & { aiResult?: string };

beforeEach(() => {
  recordAgentReply.mockClear();
  updateTask.mockClear();
  available = true;
  for (const k of Object.keys(eventsById)) delete eventsById[k];
});

describe('pickOpenQuestionOptions', () => {
  it('offers the options of the question on screen', () => {
    expect(pickOpenQuestionOptions([question('Tue or Thu?', ['Tue', 'Thu'])], 'Tue or Thu?')).toEqual(['Tue', 'Thu']);
    // Whitespace is not a different question.
    expect(pickOpenQuestionOptions([question(' Tue or Thu? ', ['Tue'])], 'Tue or Thu?')).toEqual(['Tue']);
  });

  it('offers nothing when the newest question is not the one on screen', () => {
    expect(pickOpenQuestionOptions([question('Which Dana?', ['A', 'B'])], 'Tue or Thu?')).toEqual([]);
    expect(pickOpenQuestionOptions([], 'Tue or Thu?')).toEqual([]);
    expect(pickOpenQuestionOptions([question('Tue or Thu?', ['Tue'])], undefined)).toEqual([]);
  });

  it('offers nothing once a reply was recorded after the question', () => {
    const q = question('Tue or Thu?', ['Tue', 'Thu'], '2026-10-02T10:00:00Z');
    expect(pickOpenQuestionOptions([reply('2026-10-02T10:05:00Z'), q], 'Tue or Thu?')).toEqual([]);
    // A reply to an EARLIER question does not close this one.
    expect(pickOpenQuestionOptions([q, reply('2026-10-02T09:00:00Z')], 'Tue or Thu?')).toEqual(['Tue', 'Thu']);
  });

  it('keeps only non-empty strings, whatever the agent wrote', () => {
    expect(pickOpenQuestionOptions([question('Q', ['Tue', '', '  ', 3, null, { a: 1 }, 'Thu'])], 'Q')).toEqual([
      'Tue',
      'Thu',
    ]);
    const notAList = { action: 'agent_question', payload: { question: 'Q', options: 'Tue' }, createdAt: '' };
    expect(pickOpenQuestionOptions([notAList], 'Q')).toEqual([]);
  });
});

describe('answerAgentQuestion', () => {
  it('records the reply on the item’s trail and re-queues it', () => {
    expect(answerAgentQuestion(item(), '  Thu 10am ')).toBe(true);
    expect(recordAgentReply).toHaveBeenCalledWith('item-1', 'task', 'Thu 10am');
    expect(updateTask).toHaveBeenCalledWith('item-1', { aiStatus: 'queued' });
  });

  it('writes nothing for a blank answer', () => {
    expect(answerAgentQuestion(item(), '   ')).toBe(false);
    expect(recordAgentReply).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });
});

describe('useAgentQuestion', () => {
  it('fetches the options for the item and question on screen', async () => {
    eventsById['item-1'] = [question('Tue 3pm or Thu 10am?', ['Tue 3pm', 'Thu 10am'])];
    const { result } = renderHook(() => useAgentQuestion(item()));
    expect(result.current.options).toEqual([]);
    await waitFor(() => expect(result.current.options).toEqual(['Tue 3pm', 'Thu 10am']));
  });

  it('never shows one item’s options against another, not even for a render', async () => {
    eventsById['item-1'] = [question('Tue 3pm or Thu 10am?', ['Tue 3pm', 'Thu 10am'])];
    eventsById['item-2'] = [question('Which Dana?', ['Dana K', 'Dana P'])];
    const seen: string[][] = [];
    const { result, rerender } = renderHook(
      ({ it }: { it: ReturnType<typeof item> }) => {
        const got = useAgentQuestion(it);
        seen.push(got.options);
        return got;
      },
      { initialProps: { it: item() } }
    );
    await waitFor(() => expect(result.current.options).toEqual(['Tue 3pm', 'Thu 10am']));

    seen.length = 0;
    rerender({ it: item({ id: 'item-2', aiResult: 'Which Dana?' }) });
    expect(seen[0]).toEqual([]);
    await waitFor(() => expect(result.current.options).toEqual(['Dana K', 'Dana P']));
    expect(seen.some((o) => o.includes('Tue 3pm'))).toBe(false);
  });

  it('withdraws the options once answered', async () => {
    eventsById['item-1'] = [question('Tue 3pm or Thu 10am?', ['Tue 3pm'])];
    const { result } = renderHook(() => useAgentQuestion(item()));
    await waitFor(() => expect(result.current.options).toEqual(['Tue 3pm']));
    act(() => result.current.clear());
    expect(result.current.options).toEqual([]);
  });

  it('asks for nothing where the trail is unavailable', async () => {
    available = false;
    eventsById['item-1'] = [question('Tue 3pm or Thu 10am?', ['Tue 3pm'])];
    const { result } = renderHook(() => useAgentQuestion(item()));
    await act(async () => {});
    expect(result.current.options).toEqual([]);
  });
});
