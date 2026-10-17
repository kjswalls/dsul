// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DELETE, GET, POST } from '@/app/api/ai/prep/route';
import { openModelConnection } from '@/lib/ai-server/connections';
import { PREP_BATCH } from '@/lib/prep-packs';

/**
 * /api/ai/prep: prep packs (memory/plans/power-mode.md, build order 3). The
 * user's own model writes them, each pack is checked on its own and kept only
 * for an item that was asked about, and every read and write goes through the
 * session client (RLS), never the service role.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  inserts: [] as unknown[][],
  deleted: [] as string[],
  dropped: [] as string[][],
  error: null as { code: string; message?: string } | null,
  stored: [] as unknown[],
}));

vi.mock('@/lib/supabase-server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: h.user }, error: h.user ? null : { message: 'no' } })) },
    from: vi.fn(() => ({
      select: () => ({
        order: () => ({ limit: async () => ({ data: h.error ? null : h.stored, error: h.error }) }),
      }),
      insert: (rows: Record<string, unknown>[]) => {
        h.inserts.push(rows);
        return {
          select: async () => ({
            data: h.error ? null : rows.map((r) => ({ ...r, updated_at: '2026-10-12T00:00:00Z' })),
            error: h.error,
          }),
        };
      },
      delete: () => ({
        eq: async (_col: string, id: string) => {
          h.deleted.push(id);
          return { error: h.error };
        },
        in: async (_col: string, ids: string[]) => {
          h.dropped.push(ids);
          return { error: h.error };
        },
      }),
    })),
  })),
}));

vi.mock('@/lib/ai-server/connections', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai-server/connections')>();
  return { ...actual, openModelConnection: vi.fn(), setConnectionStatus: vi.fn(), setConnectionLimit: vi.fn() };
});
vi.mock('@/lib/ai-server/stream', () => ({
  anySignal: vi.fn((signals: AbortSignal[]) => AbortSignal.any(signals)),
}));
const adapter = vi.hoisted(() => ({ completeText: vi.fn() }));
vi.mock('@/lib/ai-server/providers', () => ({ getAdapter: vi.fn(() => adapter), credentialsFor: vi.fn() }));

function connected() {
  vi.mocked(openModelConnection).mockResolvedValue({
    ok: true,
    row: {
      user_id: 'user-1',
      provider: 'openai',
      base_url: null,
      model: 'm-1',
      model_meta: {},
      auth_method: 'key',
      key_ciphertext: 'v1:x',
      status: 'ok',
      last_error: null,
      checked_at: null,
      limited_until: null,
    },
    creds: { provider: 'openai', apiKey: 'sk', baseUrl: 'https://example.test/v1' },
    model: 'm-1',
  } as never);
}

const post = (body: unknown) =>
  POST(
    new Request('https://do.dsul.app/api/ai/prep', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

const ITEMS = [
  { id: A, title: 'email the landlord about the boiler', notes: 'landlord is sam@example.com' },
  { id: B, title: 'call the dentist' },
];

beforeEach(() => {
  h.user = { id: 'user-1' };
  h.inserts = [];
  h.deleted = [];
  h.dropped = [];
  h.error = null;
  h.stored = [];
  connected();
  adapter.completeText.mockReset();
});

describe('POST /api/ai/prep', () => {
  it("keeps one checked pack per asked-for item, for the title it was written for", async () => {
    adapter.completeText.mockResolvedValue(
      JSON.stringify({
        packs: [
          { itemId: A, kind: 'email', to: 'sam@example.com', subject: 'The boiler', body: 'Hi Sam, the boiler is out again.' },
          { itemId: A, kind: 'steps', steps: ['one', 'two'] },
          { itemId: B, kind: 'call', who: 'the dentist', script: [] },
          { itemId: STRANGER, kind: 'steps', steps: ['one', 'two'] },
        ],
      })
    );
    const res = await post({ items: ITEMS });
    expect(res.status).toBe(200);
    const body = await res.json();
    // A's second pack, B's empty script and the stranger are all dropped.
    expect(body.packs).toHaveLength(1);
    expect(body.packs[0]).toMatchObject({
      itemId: A,
      madeFor: 'email the landlord about the boiler',
      pack: { kind: 'email', subject: 'The boiler' },
    });
    expect(h.inserts[0]).toEqual([
      expect.objectContaining({
        item_id: A,
        kind: 'email',
        body: { to: 'sam@example.com', subject: 'The boiler', body: 'Hi Sam, the boiler is out again.' },
        made_for: 'email the landlord about the boiler',
        model: 'm-1',
      }),
    ]);
    // Never `updated_at`, and never an upsert: 074 grants authenticated INSERT
    // on five named columns and UPDATE on four, and PostgREST's upsert assigns
    // `item_id` in its SET list, so either is refused whole (42501). The route
    // drops the user's old rows for these ids and inserts; the default stamps.
    expect(Object.keys((h.inserts[0] as Record<string, unknown>[])[0])).not.toContain('updated_at');
    expect(h.dropped).toEqual([[A]]);
  });

  it('sends the model the titles and notes, and asks for JSON', async () => {
    adapter.completeText.mockResolvedValue('{"packs":[]}');
    await post({ items: ITEMS });
    const req = adapter.completeText.mock.calls[0][1] as { messages: { content: string }[]; json: boolean; system: string[] };
    expect(req.json).toBe(true);
    expect(req.messages[0].content).toContain(`id ${A}: email the landlord about the boiler`);
    expect(req.messages[0].content).toContain('notes: landlord is sam@example.com');
    expect(req.system[0]).toMatch(/Never invent an email address, a phone number/);
  });

  it('writes nothing when the model prepares nothing', async () => {
    adapter.completeText.mockResolvedValue('not json at all');
    const res = await post({ items: ITEMS });
    expect(await res.json()).toEqual({ packs: [] });
    expect(h.inserts).toHaveLength(0);
  });

  it(`refuses a batch over ${PREP_BATCH}, a bad id, and a stranger`, async () => {
    const many = Array.from({ length: PREP_BATCH + 1 }, () => ITEMS[0]);
    expect((await post({ items: many })).status).toBe(400);
    expect((await post({ items: [{ id: 'nope', title: 'x' }] })).status).toBe(400);
    h.user = null;
    expect((await post({ items: ITEMS })).status).toBe(401);
    expect(adapter.completeText).not.toHaveBeenCalled();
  });

  it('says so when no model is connected', async () => {
    vi.mocked(openModelConnection).mockResolvedValue({ ok: false, reason: 'none' } as never);
    const res = await post({ items: ITEMS });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('not_connected');
  });
});

describe('GET and DELETE /api/ai/prep', () => {
  it('lists the packs that still fit the schema', async () => {
    h.stored = [
      { item_id: A, kind: 'steps', body: { steps: ['one', 'two'] }, made_for: 'a', updated_at: 't' },
      { item_id: B, kind: 'steps', body: { steps: [] }, made_for: 'b', updated_at: 't' },
    ];
    const body = await (await GET()).json();
    expect(body.available).toBe(true);
    expect(body.packs.map((p: { itemId: string }) => p.itemId)).toEqual([A]);
  });

  it('answers no packs, unavailable, before 074 is applied', async () => {
    h.error = { code: '42P01' };
    expect(await (await GET()).json()).toEqual({ packs: [], available: false });
  });

  it('drops one pack by item id', async () => {
    const res = await DELETE(new Request(`https://do.dsul.app/api/ai/prep?item=${A}`, { method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(h.deleted).toEqual([A]);
    expect((await DELETE(new Request('https://do.dsul.app/api/ai/prep?item=x', { method: 'DELETE' }))).status).toBe(400);
  });
});
