// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/ai/style/route';
import { openModelConnection } from '@/lib/ai-server/connections';
import { MAX_STYLE_CHARS } from '@/lib/writing-style';

/**
 * /api/ai/style: the person's own model rewrites "How you write" from one
 * edit. The route keeps nothing: no table is ever touched.
 */

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
    new Request('https://do.dsul.app/api/ai/style', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

const EDIT = { kind: 'email', before: 'Hi Sam, the boiler is out.', after: 'Sam - boiler out. Thanks, K', style: 'Short.' };

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

describe('POST /api/ai/style', () => {
  it('answers the rewritten lines, sending the model the note, the draft and the edit', async () => {
    adapter.completeText.mockResolvedValue('{"style":"Short.\\nSigns off \\"Thanks, K\\"."}');
    const res = await post(EDIT);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ style: 'Short.\nSigns off "Thanks, K".' });
    const req = adapter.completeText.mock.calls[0][1] as { messages: { content: string }[]; system: string[]; json: boolean };
    expect(req.json).toBe(true);
    expect(req.system[0]).toMatch(/Style only/);
    expect(req.messages[0].content).toContain('The note so far:\nShort.');
    expect(req.messages[0].content).toContain('Sam - boiler out. Thanks, K');
    expect(h.from).not.toHaveBeenCalled();
  });

  it('keeps the note as it was when the reply is not one, and clips a long one', async () => {
    adapter.completeText.mockResolvedValue('sorry, no');
    expect(await (await post(EDIT)).json()).toEqual({ style: 'Short.' });
    adapter.completeText.mockResolvedValue(JSON.stringify({ style: 'x'.repeat(5000) }));
    expect(((await (await post(EDIT)).json()) as { style: string }).style).toHaveLength(MAX_STYLE_CHARS);
  });

  it('refuses a signed-out caller, another kind, or an empty side, before any model call', async () => {
    h.user = null;
    expect((await post(EDIT)).status).toBe(401);
    h.user = { id: 'user-1' };
    expect((await post({ ...EDIT, kind: 'list' })).status).toBe(400);
    expect((await post({ ...EDIT, after: '  ' })).status).toBe(400);
    expect(adapter.completeText).not.toHaveBeenCalled();
  });

  it('says to connect a model when none is', async () => {
    vi.mocked(openModelConnection).mockResolvedValue({ ok: false, reason: 'none' } as never);
    const res = await post(EDIT);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('not_connected');
  });
});
