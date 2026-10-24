import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * POST /api/agent/items/:id/progress — the delegation loop's compare-and-set.
 *
 * This route exists because the race it closes silently destroys the user's
 * work. Worker A marks an item `working` and is slow but alive; an hour later
 * the user, seeing no update, taps Try again; worker B picks it up and
 * finishes it; then A — still running — reports `done` with its own result and
 * the write lands on top. The user reads A's report, written against a premise
 * they had already discarded, with B's result gone from the panel. Worse if A
 * reports `blocked`: the item flips back from finished to "needs you", asking a
 * question from the run they killed.
 *
 * The old path was the generic task PATCH, which verified only that the row
 * belonged to the caller's ACCOUNT. Nothing checked the assignee, and nothing
 * checked that the item was still the one the worker had read.
 */

const updateItem = vi.fn(async () => {});
type Owner = {
  user_id: string;
  type: string;
  assignee: string | null;
  ai_status?: string | null;
  ai_result?: string | null;
  ai_status_at: string | null;
};
const STAMP = '2026-08-26T10:00:00.000Z';
let owner: Owner | null = {
  user_id: 'u1',
  type: 'task',
  assignee: 'openclaw',
  ai_status_at: STAMP,
};
let resolvedUser: string | null = 'u1';

vi.mock('@/lib/db', () => ({ updateItem: (...a: unknown[]) => updateItem(...a) }));

vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ is: () => ({ maybeSingle: async () => ({ data: owner }) }) }),
      }),
    }),
  }),
  resolveUserIdFromApiKey: async () => resolvedUser,
}));

import { POST } from '@/app/api/agent/items/[id]/progress/route';

const report = (body: unknown, auth = 'Bearer dsul_key') =>
  POST(
    new Request('http://localhost/api/agent/items/item-1/progress', {
      method: 'POST',
      headers: auth ? { authorization: auth, 'content-type': 'application/json' } : {},
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: 'item-1' }) }
  );

beforeEach(() => {
  updateItem.mockClear();
  updateItem.mockResolvedValue(undefined);
  owner = { user_id: 'u1', type: 'task', assignee: 'openclaw', ai_status_at: STAMP };
  resolvedUser = 'u1';
});

describe('the compare-and-set', () => {
  it('accepts a report from a worker holding the current stamp', async () => {
    const res = await report({ aiStatus: 'done', aiResult: 'booked it', lastSeenAt: STAMP });
    expect(res.status).toBe(200);
    expect(updateItem).toHaveBeenCalledWith(
      'item-1',
      'task',
      { aiStatus: 'done', aiResult: 'booked it' },
      'u1',
      expect.anything()
    );
  });

  it('refuses a report from a run the item has moved past', async () => {
    // The whole point: A's late `done` must not land over B's work.
    const res = await report({ aiStatus: 'done', aiResult: 'A stale result', lastSeenAt: STAMP });
    owner = { ...owner!, ai_status_at: '2026-08-26T11:00:00.000Z' };
    const stale = await report({ aiStatus: 'done', lastSeenAt: STAMP });

    expect(res.status).toBe(200);
    expect(stale.status).toBe(409);
    expect(updateItem).toHaveBeenCalledTimes(1);
  });

  it('tells the refused worker what to do instead of just failing', async () => {
    owner = { ...owner!, ai_status_at: '2026-08-26T11:00:00.000Z' };
    const body = await (await report({ aiStatus: 'done', lastSeenAt: STAMP })).json();
    expect(body.error).toMatch(/re-read it/i);
    // The current value, so a worker can resume without a second round trip.
    expect(body.currentStatusAt).toBe('2026-08-26T11:00:00.000Z');
  });

  it('compares instants, not strings', async () => {
    // Postgres and the client spell the same moment differently ('+00:00' vs
    // 'Z', varying fractional digits). A string compare would refuse every
    // write for a reason no worker could diagnose.
    owner = { ...owner!, ai_status_at: '2026-08-26T10:00:00+00:00' };
    expect((await report({ aiStatus: 'working', lastSeenAt: STAMP })).status).toBe(200);
  });

  it('allows an unconditional first report, which has no stamp to send', async () => {
    owner = { ...owner!, ai_status_at: null };
    expect((await report({ aiStatus: 'working' })).status).toBe(200);
  });

  it('refuses a stamp sent against an item that has none', async () => {
    // The worker believes it read something this item never had — it is not
    // looking at the row it thinks it is.
    owner = { ...owner!, ai_status_at: null };
    expect((await report({ aiStatus: 'done', lastSeenAt: STAMP })).status).toBe(409);
  });

  it('refuses an unparseable stamp rather than treating it as a match', async () => {
    expect((await report({ aiStatus: 'done', lastSeenAt: 'yesterday' })).status).toBe(409);
    expect(updateItem).not.toHaveBeenCalled();
  });
});

describe('who may report', () => {
  it('refuses without a bearer token', async () => {
    expect((await report({ aiStatus: 'working' }, '')).status).toBe(401);
  });

  it('refuses another account item without confirming it exists', async () => {
    owner = { ...owner!, user_id: 'someone-else' };
    expect((await report({ aiStatus: 'working' })).status).toBe(404);
    expect(updateItem).not.toHaveBeenCalled();
  });

  it('refuses an item nobody was assigned', async () => {
    // An unassigned item is one the user has taken back, and the panel shows
    // the assign button rather than a status block — so the report would
    // render nowhere.
    owner = { ...owner!, assignee: null };
    expect((await report({ aiStatus: 'working' })).status).toBe(409);
  });

  it('refuses a type that cannot be delegated', async () => {
    owner = { ...owner!, type: 'habit' };
    expect((await report({ aiStatus: 'working' })).status).toBe(400);
  });
});

describe('what may be reported', () => {
  it('refuses a status outside the frozen vocabulary', async () => {
    expect((await report({ aiStatus: 'nearly-done' })).status).toBe(400);
    expect((await report({ aiStatus: 'toString' })).status).toBe(400);
    expect(updateItem).not.toHaveBeenCalled();
  });

  it('accepts every status in it', async () => {
    for (const aiStatus of ['queued', 'working', 'blocked', 'done', 'failed']) {
      expect((await report({ aiStatus, aiResult: `now ${aiStatus}` })).status).toBe(200);
    }
  });

  it('omits the result rather than clearing it when none is sent', async () => {
    // A heartbeat with no new text must not wipe the last thing the agent said.
    await report({ aiStatus: 'working' });
    expect(updateItem.mock.calls[0][2]).toEqual({ aiStatus: 'working' });
  });

  it('refuses a body that is not JSON', async () => {
    expect((await report('not json')).status).toBe(400);
  });

  it('goes through updateItem, so the webhook and the feed entry still fire', async () => {
    await report({ aiStatus: 'done', aiResult: 'booked it' });
    expect(updateItem).toHaveBeenCalledTimes(1);
  });
});

describe('a report the user can read', () => {
  // Kirby, 2026-10-24: Claude asked which gym, was answered, and marked the
  // item done with no result two minutes later. Its old question stayed the
  // last thing it said, and the user saw no reply at all.
  it.each(['done', 'failed', 'blocked'])('refuses a bare %s', async (aiStatus) => {
    const res = await report({ aiStatus, aiResult: '   ' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/result/);
    expect(updateItem).not.toHaveBeenCalled();
  });

  it('still takes a bare working or queued, which say nothing to the user', async () => {
    expect((await report({ aiStatus: 'working' })).status).toBe(200);
    expect((await report({ aiStatus: 'queued' })).status).toBe(200);
  });

  it('refuses a done that repeats the question the user just answered', async () => {
    owner = { ...owner!, ai_status: 'queued', ai_result: 'Which gym do you mean?' };
    const res = await report({ aiStatus: 'done', aiResult: 'Which gym do you mean? ' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/nothing new/);
    expect(updateItem).not.toHaveBeenCalled();
  });

  it('takes a retried done with the same words', async () => {
    owner = { ...owner!, ai_status: 'done', ai_result: 'booked it' };
    expect((await report({ aiStatus: 'done', aiResult: 'booked it' })).status).toBe(200);
  });

  it('takes the same question asked again', async () => {
    owner = { ...owner!, ai_status: 'queued', ai_result: 'Which gym?' };
    expect((await report({ aiStatus: 'blocked', aiResult: 'Which gym?' })).status).toBe(200);
  });
});
