import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * POST /api/agent/items/:id/prep — an agent (OpenClaw, Claude) hands back what
 * it got ready as a real prep card, checked by the model's own schema, written
 * for the key holder's own item only.
 */

type Owner = { user_id: string; type: string; assignee: string | null; title: string };
let owner: Owner | null;
let resolvedUser: string | null;
const savePacks = vi.fn();

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
vi.mock('@/lib/event-actor', () => ({ tagClientActor: (c: unknown) => c }));
vi.mock('@/lib/prep-packs-save', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  savePacks: (...args: unknown[]) => savePacks(...args),
}));

import { POST } from '@/app/api/agent/items/[id]/prep/route';

const save = (body: unknown, auth = 'Bearer dsul_key', id = 'item-1') =>
  POST(
    new Request(`http://localhost/api/agent/items/${id}/prep`, {
      method: 'POST',
      headers: auth ? { authorization: auth, 'content-type': 'application/json' } : {},
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id }) }
  );

const email = { kind: 'email', to: 'jo@example.com', subject: 'Friday', body: 'Still on?' };

beforeEach(() => {
  owner = { user_id: 'u1', type: 'task', assignee: 'openclaw', title: 'Email Jo about Friday' };
  resolvedUser = 'u1';
  savePacks.mockReset();
  savePacks.mockImplementation(async (_db: unknown, rows: Map<string, Record<string, unknown>>) => ({
    saved: [...rows.values()].map((r) => ({ ...r, updated_at: '2026-10-21T00:00:00Z' })),
    error: null,
  }));
});

describe('POST /api/agent/items/:id/prep', () => {
  it('saves the card for the item, owned by the key holder, written for its title', async () => {
    const res = await save({ pack: email });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ itemId: 'item-1', kind: 'email', saved: true });
    const rows = savePacks.mock.calls[0][1] as Map<string, Record<string, unknown>>;
    expect(rows.get('item-1')).toEqual({
      item_id: 'item-1',
      user_id: 'u1',
      kind: 'email',
      body: { to: 'jo@example.com', subject: 'Friday', body: 'Still on?' },
      made_for: 'Email Jo about Friday',
      model: 'openclaw',
    });
  });

  it('refuses a missing or unknown key before reading anything', async () => {
    expect((await save({ pack: email }, '')).status).toBe(401);
    resolvedUser = null;
    expect((await save({ pack: email })).status).toBe(401);
    expect(savePacks).not.toHaveBeenCalled();
  });

  it("never writes into another account's item, or one nobody handed over", async () => {
    owner = { ...owner!, user_id: 'u2' };
    expect((await save({ pack: email })).status).toBe(404);
    owner = { ...owner!, user_id: 'u1', assignee: null };
    expect((await save({ pack: email })).status).toBe(409);
    owner = { ...owner!, assignee: 'openclaw', type: 'habit' };
    expect((await save({ pack: email })).status).toBe(400);
    expect(savePacks).not.toHaveBeenCalled();
  });

  it('says what is wrong with a card that does not fit its shape', async () => {
    const res = await save({ pack: { kind: 'steps', steps: ['only one'] } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/steps/);
    expect((await save({ pack: { kind: 'telegram', body: 'x' } })).status).toBe(400);
    expect(savePacks).not.toHaveBeenCalled();
  });

  it('sends a question to dsul_ask_user, whose answer comes back to the agent', async () => {
    const res = await save({ pack: { kind: 'question', question: 'Which Jo?' } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/dsul_ask_user/);
  });

  it('answers the cap in words the agent can act on', async () => {
    savePacks.mockResolvedValue({ saved: [], error: { code: 'P0001', message: 'prep_packs_limit' } });
    const res = await save({ pack: email });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/dsul_report_progress/);
  });
});
