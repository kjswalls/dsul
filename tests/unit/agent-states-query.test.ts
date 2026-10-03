import { describe, it, expect, vi } from 'vitest';

/**
 * fetchAgentStates' one query (lib/db.ts), on a recording client: which rows
 * Ask home's freshness read brings back. It is every row whose agent state
 * was ever stamped, not every delegated row: an item undelegated on another
 * device (the Remove button: assignee and status null, a fresh stamp) has to
 * come back, or this browser keeps its "needs you" card for an item no agent
 * holds (review round of AI step 2a, C3+C4: data-4).
 */

vi.mock('@/lib/supabase', () => ({ createClient: vi.fn(() => ({})) }));

import { fetchAgentStates } from '@/lib/db';

function recordingClient(rows: Record<string, unknown>[]) {
  const calls: unknown[][] = [];
  const chain = {
    from: (...a: unknown[]) => (calls.push(['from', ...a]), chain),
    select: (...a: unknown[]) => (calls.push(['select', ...a]), chain),
    not: (...a: unknown[]) => (calls.push(['not', ...a]), chain),
    is: (...a: unknown[]) => (calls.push(['is', ...a]), chain),
    then: (resolve: (v: unknown) => void) => resolve({ data: rows, error: null }),
  };
  return { client: chain, calls };
}

describe('fetchAgentStates', () => {
  it('reads every stamped, undeleted item, delegated or not', async () => {
    const { client, calls } = recordingClient([
      { id: 'undelegated', assignee: null, ai_status: null, ai_result: null, ai_status_at: '2026-10-02T09:30:00.000Z' },
    ]);
    const rows = await fetchAgentStates(client);
    expect(calls).toEqual([
      ['from', 'items'],
      ['select', 'id, assignee, ai_status, ai_result, ai_status_at'],
      ['not', 'ai_status_at', 'is', null],
      ['is', 'deleted_at', null],
    ]);
    expect(calls).not.toContainEqual(['not', 'assignee', 'is', null]);
    expect(rows).toEqual([
      { id: 'undelegated', assignee: null, aiStatus: null, aiResult: null, aiStatusAt: '2026-10-02T09:30:00.000Z' },
    ]);
  });
});
