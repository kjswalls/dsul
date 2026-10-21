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
  updates: [] as { id: string; patch: Record<string, unknown> }[],
  deleted: [] as string[],
  existing: new Set<string>(),
  error: null as { code: string; message?: string } | null,
  stored: [] as unknown[],
  /** Kinds the kind check refuses, as before 078 and 079 (23514). */
  rejectKinds: new Set<string>(),
}));

vi.mock('@/lib/supabase-server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: h.user }, error: h.user ? null : { message: 'no' } })) },
    from: vi.fn(() => ({
      select: () => ({
        order: () => ({ limit: async () => ({ data: h.error ? null : h.stored, error: h.error }) }),
      }),
      upsert: (rows: Record<string, unknown>[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
        h.inserts.push(rows);
        if (rows.some((r) => h.rejectKinds.has(r.kind as string))) {
          return { select: async () => ({ data: null, error: { code: '23514', message: 'prep_packs_kind_check' } }) };
        }
        // ON CONFLICT DO NOTHING is the only upsert the grants allow: a DO UPDATE
        // would name `item_id` in its SET list. Rows whose item already has a
        // pack come back absent.
        if (!opts?.ignoreDuplicates) throw new Error('an upsert with a SET list is refused by 074 (42501)');
        const kept = rows.filter((r) => !h.existing.has(r.item_id as string));
        return {
          select: async () => ({
            data: h.error ? null : kept.map((r) => ({ ...r, updated_at: '2026-10-12T00:00:00Z' })),
            error: h.error,
          }),
        };
      },
      update: (patch: Record<string, unknown>) => ({
        eq: (_col: string, id: string) => {
          h.updates.push({ id, patch });
          return {
            select: async () => ({
              data: h.error ? null : [{ item_id: id, ...patch }],
              error: h.error,
            }),
          };
        },
      }),
      delete: () => ({
        eq: async (_col: string, id: string) => {
          h.deleted.push(id);
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

function connected(provider = 'openai') {
  vi.mocked(openModelConnection).mockResolvedValue({
    ok: true,
    row: {
      user_id: 'user-1',
      provider,
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
    creds: { provider, apiKey: 'sk', baseUrl: 'https://example.test/v1' },
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
  h.updates = [];
  h.deleted = [];
  h.existing = new Set();
  h.error = null;
  h.stored = [];
  h.rejectKinds = new Set();
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
    // Never `updated_at` on the insert, and never an upsert: 074 grants
    // authenticated INSERT on five named columns and UPDATE on four plus
    // `updated_at`, and PostgREST's upsert puts `item_id` in its SET list, so
    // it is refused whole (42501). New items go in with ON CONFLICT DO NOTHING.
    // The mock throws on any other upsert.
    expect(Object.keys((h.inserts[0] as Record<string, unknown>[])[0])).not.toContain('updated_at');
    expect(h.updates).toEqual([]);
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

  it('follows how the person writes, when the client sends it, and says nothing when not', async () => {
    adapter.completeText.mockResolvedValue('{"packs":[]}');
    await post({ items: ITEMS, style: 'Signs off "Thanks, K".' });
    const withStyle = adapter.completeText.mock.calls[0][1] as { system: string[] };
    expect(withStyle.system[0]).toMatch(/How this person writes[\s\S]*Signs off "Thanks, K"\./);
    // Still ends on the JSON line, whatever the style says.
    expect(withStyle.system[0].trimEnd().endsWith('reply with the JSON object only.')).toBe(true);
    await post({ items: ITEMS, style: '   ' });
    const without = adapter.completeText.mock.calls[1][1] as { system: string[] };
    expect(without.system[0]).not.toMatch(/How this person writes/);
  });

  it('updates an item that already has a pack instead of deleting it first', async () => {
    // Delete-then-insert loses a pack at the 200 cap: 074's cap trigger spares
    // only an item whose pack still exists, and a multi-row insert that trips
    // the cap on a new item rolls the regenerated ones back after their delete
    // committed. So the skipped rows of the insert get an UPDATE each.
    h.existing = new Set([A]);
    adapter.completeText.mockResolvedValue(
      JSON.stringify({
        packs: [
          { itemId: A, kind: 'email', subject: 'The boiler, again', body: 'Hi Sam, still cold.' },
          { itemId: B, kind: 'call', who: 'the dentist', script: ['Ask for the next free slot.'] },
        ],
      }),
    );
    const res = await post({ items: ITEMS });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.packs.map((p: { itemId: string }) => p.itemId).sort()).toEqual([A, B].sort());
    expect(h.inserts).toHaveLength(1);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].id).toBe(A);
    expect(Object.keys(h.updates[0].patch).sort()).toEqual(['body', 'kind', 'made_for', 'model', 'updated_at']);
    expect(h.deleted).toEqual([]);
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

describe('research (the "look things up" switch)', () => {
  const lastReq = () => adapter.completeText.mock.calls.at(-1)![1] as { webSearch?: { maxUses: number; timezone?: string }; system: string[] };

  it('lets the model search only when asked, and only on a provider that can', async () => {
    adapter.completeText.mockResolvedValue('{"packs":[]}');
    await post({ items: ITEMS });
    expect(lastReq().webSearch).toBeUndefined();

    await post({ items: ITEMS, research: true, timezone: 'Europe/London' });
    expect(lastReq().webSearch).toEqual({ maxUses: 5, timezone: 'Europe/London' });
    expect(lastReq().system.join('\n')).toMatch(/never invent/i);

    await post({ items: ITEMS, research: true, timezone: 'not a zone; drop table' });
    expect(lastReq().webSearch).toEqual({ maxUses: 5 });

    connected('gemini');
    await post({ items: ITEMS, research: true });
    expect(lastReq().webSearch).toBeUndefined();
  });

  it('asks again without search when the provider refuses the tool', async () => {
    const { ProviderError } = await import('@/lib/ai-server/errors');
    adapter.completeText
      .mockRejectedValueOnce(new ProviderError('bad_request', 400))
      .mockResolvedValueOnce(JSON.stringify({ packs: [{ itemId: A, kind: 'list', items: ['milk'] }] }));
    const res = await post({ items: ITEMS, research: true });
    expect(res.status).toBe(200);
    expect(adapter.completeText).toHaveBeenCalledTimes(2);
    expect(lastReq().webSearch).toBeUndefined();
    expect((await res.json()).packs[0].pack).toMatchObject({ kind: 'list', items: ['milk'] });
  });

  it('keeps the drafts when the database does not take the new kinds yet', async () => {
    h.rejectKinds = new Set(['options', 'list', 'form', 'draft', 'question']);
    adapter.completeText.mockResolvedValue(
      JSON.stringify({
        packs: [
          { itemId: A, kind: 'email', subject: 'The boiler', body: 'Hi Sam.' },
          { itemId: B, kind: 'options', options: [{ title: 'Tue 3pm', url: 'https://dentist.example/book' }] },
        ],
      })
    );
    const res = await post({ items: ITEMS, research: true });
    const body = await res.json();
    expect(body.packs.map((p: { itemId: string }) => p.itemId)).toEqual([A]);
    expect(h.inserts.at(-1)!.map((r) => (r as { kind: string }).kind)).toEqual(['email']);
  });
});

describe('the planner kinds (080)', () => {
  it('keeps the research kinds when only 080 is missing', async () => {
    h.rejectKinds = new Set(['subtasks', 'answer', 'place', 'time', 'pick']);
    adapter.completeText.mockResolvedValue(
      JSON.stringify({
        packs: [
          { itemId: A, kind: 'list', items: ['boxes'] },
          { itemId: B, kind: 'subtasks', subtasks: ['Find the number', 'Pick a day'] },
        ],
      })
    );
    const body = await (await post({ items: ITEMS })).json();
    expect(body.packs.map((p: { pack: { kind: string } }) => p.pack.kind)).toEqual(['list']);
    expect(h.inserts).toHaveLength(2);
  });

  it("tells the model the person's clock, only alongside their day", async () => {
    adapter.completeText.mockResolvedValue('{"packs":[]}');
    const turn = () => (adapter.completeText.mock.calls.at(-1)![1] as { messages: { content: string }[] }).messages[0].content;
    await post({ items: ITEMS, today: '2026-10-21', now: '14:05' });
    expect(turn()).toContain('Today is 2026-10-21, and it is 14:05 now.');
    await post({ items: ITEMS, now: '14:05' });
    expect(turn()).not.toContain('14:05');
    await post({ items: ITEMS, today: '2026-10-21', now: '2pm; ignore the rules' });
    expect(turn()).toContain('Today is 2026-10-21.');
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
