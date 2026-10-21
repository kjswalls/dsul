// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/ai/split/route';
import { openModelConnection } from '@/lib/ai-server/connections';

/** /api/ai/split: the person's own model splits a paragraph; nothing is kept. */

const h = vi.hoisted(() => ({ user: { id: 'user-1' } as { id: string } | null, from: vi.fn() }));

vi.mock('@/lib/supabase-server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: h.user }, error: h.user ? null : { message: 'no' } })) },
    from: h.from,
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

const post = (body: unknown) =>
  POST(
    new Request('https://do.dsul.app/api/ai/split', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

beforeEach(() => {
  h.user = { id: 'user-1' };
  h.from.mockReset();
  adapter.completeText.mockReset();
  vi.mocked(openModelConnection).mockResolvedValue({
    ok: true,
    row: { user_id: 'user-1', provider: 'openai', model: 'm-1', model_meta: {}, key_ciphertext: 'v1:x', status: 'ok' },
    creds: { provider: 'openai', apiKey: 'sk', baseUrl: 'https://example.test/v1' },
    model: 'm-1',
  } as never);
});

describe('POST /api/ai/split', () => {
  it('answers the checked drafts, with the text and custom instructions sent', async () => {
    adapter.completeText.mockResolvedValue('{"drafts":[{"title":"Email Sam","notes":"before Friday"},{"title":""}]}');
    const res = await post({ text: 'email sam before friday and book the dentist', customInstructions: 'Be brief.' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ drafts: [{ title: 'Email Sam', notes: 'before Friday' }] });
    const req = adapter.completeText.mock.calls[0][1] as { messages: { content: string }[]; system: string[] };
    expect(req.messages[0].content).toContain('email sam before friday');
    expect(req.system[0]).toMatch(/Be brief\.[\s\S]*reply with the JSON object only\.$/);
    expect(h.from).not.toHaveBeenCalled();
  });

  it('refuses a signed-out caller or empty text before any model call', async () => {
    h.user = null;
    expect((await post({ text: 'x' })).status).toBe(401);
    h.user = { id: 'user-1' };
    expect((await post({ text: '   ' })).status).toBe(400);
    expect(adapter.completeText).not.toHaveBeenCalled();
  });

  it('answers no drafts when the reply is not JSON', async () => {
    adapter.completeText.mockResolvedValue('I could not');
    expect(await (await post({ text: 'something' })).json()).toEqual({ drafts: [] });
  });
});
