// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ModelConnectionView, ModelProviderId } from '@/lib/ai-types';
import * as route from '@/app/api/ai/connection/route';
import * as models from '@/app/api/ai/connection/models/route';
import * as conn from '@/lib/ai-server/connections';
import type { ModelConnectionRow } from '@/lib/ai-server/connections';
import { ProviderError, type ProviderErrorKind } from '@/lib/ai-server/errors';
import { credentialsFor, getAdapter } from '@/lib/ai-server/providers';
import { takeToken } from '@/lib/ai-server/rate-limit';
import { loadEncryptionKey, openSecret } from '@/lib/ai-server/secret-box';

/**
 * /api/ai/connection (GET, PUT, PATCH, DELETE) and /api/ai/connection/models:
 * the shapes and codes of design 3.1-3.5. U1's modules are stood in by
 * reference implementations of their documented contracts, so these cases pin
 * the ROUTES' order, branching and answers.
 */

const h = vi.hoisted(() => ({ user: { id: 'user-1' } as { id: string } | null }));

vi.mock('@/lib/supabase-server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: h.user }, error: h.user ? null : { message: 'no' } })) },
  })),
}));

const db = vi.hoisted(() => ({ readModelConnection: vi.fn() }));

vi.mock('@/lib/ai-server/connections', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai-server/connections')>();
  const box = await import('@/lib/ai-server/secret-box');
  const providers = await import('@/lib/ai-server/providers');
  return {
    ...actual,
    readModelConnection: db.readModelConnection,
    // The documented contract: the stored key opened whatever the row's
    // status or model; unreadable and blocked_url reported, never written.
    openConnectionKey: vi.fn(async (userId: string) => {
      if (!box.loadEncryptionKey().ok) return { ok: false, reason: 'unavailable' };
      const read = await db.readModelConnection(userId);
      if (read.kind === 'unavailable') return { ok: false, reason: 'unavailable' };
      if (read.kind === 'none') return { ok: false, reason: 'none' };
      const row = read.row as ModelConnectionRow;
      const apiKey = box.openSecret(row.key_ciphertext, { userId, purpose: 'model-key' }, Buffer.alloc(32));
      if (apiKey === null) return { ok: false, reason: 'unreadable' };
      try {
        return { ok: true, row, creds: providers.credentialsFor(row.provider, row.base_url, apiKey) };
      } catch {
        return { ok: false, reason: 'blocked_url' };
      }
    }),
    readOpenClawStatus: vi.fn(),
    isReadable: vi.fn(() => true),
    toConnectionView: vi.fn(
      (row: ModelConnectionRow, readable: boolean): ModelConnectionView => ({
        provider: row.provider,
        model: row.model,
        baseUrl: row.base_url,
        authMethod: row.auth_method,
        status: readable ? row.status : 'failing',
        problem: readable ? (row.last_error as ModelConnectionView['problem']) : 'key_unreadable',
        checkedAt: row.checked_at,
      })
    ),
    saveModelConnection: vi.fn(),
    setConnectionModel: vi.fn(),
    setConnectionStatus: vi.fn(async () => true),
    deleteModelConnection: vi.fn(async () => {}),
    openModelConnection: vi.fn(async () => {
      throw new Error('these routes open the stored key themselves');
    }),
  };
});

vi.mock('@/lib/ai-server/errors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai-server/errors')>();
  return {
    ...actual,
    toProviderError: vi.fn((err: unknown) =>
      err instanceof actual.ProviderError ? err : new actual.ProviderError('upstream')
    ),
    logProviderError: vi.fn(),
  };
});

vi.mock('@/lib/ai-server/stream', () => ({
  anySignal: vi.fn((signals: AbortSignal[]) => AbortSignal.any(signals)),
}));

vi.mock('@/lib/ai-server/rate-limit', () => ({ takeToken: vi.fn(() => true) }));

vi.mock('@/lib/ai-server/secret-box', () => ({
  loadEncryptionKey: vi.fn(() => ({ ok: true, key: Buffer.alloc(32, 7) })),
  openSecret: vi.fn(() => 'sk-opened-key'),
  sealSecret: vi.fn(),
}));

vi.mock('@/lib/ai-server/url-policy', () => ({
  checkModelBaseUrl: vi.fn((raw: unknown) => {
    if (typeof raw !== 'string') return { ok: false, reason: 'invalid' };
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return { ok: false, reason: 'invalid' };
    }
    if (u.protocol !== 'https:') return { ok: false, reason: 'not_https' };
    if (/^(localhost|127\.|10\.)/.test(u.hostname)) return { ok: false, reason: 'blocked_host' };
    const baseUrl = `${u.origin}${u.pathname}`.replace(/\/+$/, '').replace(/\/(chat\/completions|models)$/, '');
    return { ok: true, baseUrl, origin: u.origin, hostname: u.hostname };
  }),
}));

const adapter = vi.hoisted(() => ({
  id: 'openai',
  openStream: vi.fn(),
  completeText: vi.fn(),
  verify: vi.fn(),
  listModels: vi.fn(),
  describeModel: vi.fn(),
  pickDefaultModel: vi.fn(),
}));
vi.mock('@/lib/ai-server/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai-server/providers')>();
  const errors = await import('@/lib/ai-server/errors');
  return {
    BUILTIN_BASE_URLS: actual.BUILTIN_BASE_URLS,
    getAdapter: vi.fn(() => adapter),
    credentialsFor: vi.fn((provider: ModelProviderId, baseUrl: string | null, apiKey: string) => {
      if (provider === 'custom') {
        if (!baseUrl || baseUrl.includes('stale-blocked')) throw new errors.ProviderError('blocked_url');
        return { provider, apiKey, baseUrl };
      }
      return { provider, apiKey, baseUrl: actual.BUILTIN_BASE_URLS[provider] };
    }),
  };
});

const OPENCLAW = { gateway: false, pluginChat: true, agent: true, agentId: 'kirby-1' };
const CIPHER = 'v1:aXZpdml2aXZpdml2:dGFndGFndGFndGFndGFn:Y2lwaGVy';

function rowOf(o: Partial<ModelConnectionRow> = {}): ModelConnectionRow {
  return {
    user_id: 'user-1',
    provider: 'openai',
    base_url: null,
    model: 'gpt-4o-mini',
    model_meta: {},
    auth_method: 'key',
    key_ciphertext: CIPHER,
    status: 'ok',
    last_error: null,
    checked_at: '2026-10-01T00:00:00.000Z',
    ...o,
  };
}

const URL_BASE = 'https://do.dsul.app';
function call(
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
  path = '/api/ai/connection'
): Request {
  return new Request(`${URL_BASE}${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const put = (body: unknown, headers?: Record<string, string>) => route.PUT(call('PUT', body, headers));
const patch = (body: unknown, headers?: Record<string, string>) => route.PATCH(call('PATCH', body, headers));
const listModels = () => models.GET(call('GET', undefined, {}, '/api/ai/connection/models'));

async function json(res: Response): Promise<Record<string, unknown>> {
  expect(res.headers.get('cache-control')).toBe('no-store');
  const text = await res.text();
  expect(text).not.toContain(CIPHER);
  expect(text).not.toContain('v1:');
  expect(text).not.toContain('sk-opened-key');
  return JSON.parse(text) as Record<string, unknown>;
}

const LISTED = [
  { id: 'gpt-4o-mini', label: 'gpt-4o-mini', created: 2, contextLength: 128_000 },
  { id: 'gpt-4o', label: 'gpt-4o', created: 1 },
];

beforeEach(() => {
  h.user = { id: 'user-1' };
  vi.mocked(loadEncryptionKey).mockReset();
  vi.mocked(loadEncryptionKey).mockReturnValue({ ok: true, key: Buffer.alloc(32, 7) });
  vi.mocked(openSecret).mockReset();
  vi.mocked(openSecret).mockReturnValue('sk-opened-key');
  vi.mocked(takeToken).mockReset();
  vi.mocked(takeToken).mockReturnValue(true);
  vi.mocked(conn.readModelConnection).mockReset();
  vi.mocked(conn.readModelConnection).mockResolvedValue({ kind: 'row', row: rowOf() });
  vi.mocked(conn.readOpenClawStatus).mockReset();
  vi.mocked(conn.readOpenClawStatus).mockResolvedValue(OPENCLAW);
  vi.mocked(conn.isReadable).mockReset();
  vi.mocked(conn.isReadable).mockReturnValue(true);
  vi.mocked(conn.saveModelConnection).mockReset();
  vi.mocked(conn.saveModelConnection).mockImplementation(async (userId, v) =>
    rowOf({
      user_id: userId,
      provider: v.provider,
      base_url: v.baseUrl,
      model: v.model,
      model_meta: v.modelMeta,
      auth_method: v.authMethod,
    })
  );
  vi.mocked(conn.setConnectionModel).mockReset();
  vi.mocked(conn.setConnectionModel).mockImplementation(async (_u, provider, model, meta) =>
    rowOf({ provider, model, model_meta: meta })
  );
  vi.mocked(conn.setConnectionStatus).mockReset();
  vi.mocked(conn.setConnectionStatus).mockResolvedValue(true);
  vi.mocked(conn.deleteModelConnection).mockReset();
  vi.mocked(conn.deleteModelConnection).mockResolvedValue(undefined);
  for (const fn of [adapter.verify, adapter.listModels, adapter.describeModel, adapter.pickDefaultModel]) fn.mockReset();
  adapter.verify.mockResolvedValue({ models: LISTED, listed: true });
  adapter.listModels.mockResolvedValue({ models: LISTED, listed: true });
  adapter.pickDefaultModel.mockImplementation((r: { models: Array<{ id: string }> }) => r.models[0]?.id ?? null);
  adapter.describeModel.mockResolvedValue({ effortLow: true });
  vi.mocked(getAdapter).mockClear();
  vi.mocked(credentialsFor).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── GET ──────────────────────────────────────────────────────────────────────

describe('GET /api/ai/connection', () => {
  it('a readable row answers its view, with OpenClaw beside it', async () => {
    const res = await route.GET();
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      available: true,
      model: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        baseUrl: null,
        authMethod: 'key',
        status: 'ok',
        problem: null,
        checkedAt: '2026-10-01T00:00:00.000Z',
      },
      openclaw: OPENCLAW,
    });
    expect(conn.isReadable).toHaveBeenCalledWith(rowOf(), 'user-1');
  });

  it('nothing connected answers available with model null', async () => {
    vi.mocked(conn.readModelConnection).mockResolvedValue({ kind: 'none' });
    expect(await json(await route.GET())).toEqual({ available: true, model: null, openclaw: OPENCLAW });
  });

  it('no encryption key: available:false, OpenClaw still answered, the table never read', async () => {
    vi.mocked(loadEncryptionKey).mockReturnValue({ ok: false, reason: 'missing' });
    const res = await route.GET();
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ available: false, model: null, openclaw: OPENCLAW });
    expect(conn.readModelConnection).not.toHaveBeenCalled();
  });

  it('no table yet: available:false', async () => {
    vi.mocked(conn.readModelConnection).mockResolvedValue({ kind: 'unavailable', reason: 'no_table' });
    expect(await json(await route.GET())).toEqual({ available: false, model: null, openclaw: OPENCLAW });
  });

  it('an unreadable key shows failing/key_unreadable from memory and writes nothing', async () => {
    vi.mocked(conn.isReadable).mockReturnValue(false);
    const body = await json(await route.GET());
    expect(body.model).toMatchObject({ status: 'failing', problem: 'key_unreadable' });
    expect(conn.setConnectionStatus).not.toHaveBeenCalled();
    expect(conn.saveModelConnection).not.toHaveBeenCalled();
  });

  it('a stored rejection comes back as its problem', async () => {
    vi.mocked(conn.readModelConnection).mockResolvedValue({
      kind: 'row',
      row: rowOf({ status: 'failing', last_error: 'key_rejected' }),
    });
    expect((await json(await route.GET())).model).toMatchObject({ status: 'failing', problem: 'key_rejected' });
  });

  it('a transient db error answers 503 server and logs op + code only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(conn.readOpenClawStatus).mockRejectedValue(new conn.AiDbError('openclaw', 'PGRST301'));
    const res = await route.GET();
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({ error: 'server' });
    expect(warn).toHaveBeenCalledWith('[ai] db', 'openclaw', 'failed', 'PGRST301');
  });

  it('makes no upstream call and takes no rate-limit token', async () => {
    await route.GET();
    expect(takeToken).not.toHaveBeenCalled();
    expect(adapter.verify).not.toHaveBeenCalled();
  });
});

// ── PUT ──────────────────────────────────────────────────────────────────────

describe('PUT /api/ai/connection', () => {
  it('verifies, picks the default, saves, and answers ConnectResponse', async () => {
    const res = await put({ provider: 'openai', apiKey: '  sk-test-abcdefgh  ' });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      connection: expect.objectContaining({ provider: 'openai', model: 'gpt-4o-mini', status: 'ok' }),
      models: [
        { id: 'gpt-4o-mini', label: 'gpt-4o-mini' },
        { id: 'gpt-4o', label: 'gpt-4o' },
      ],
      listed: true,
    });
    expect(credentialsFor).toHaveBeenCalledWith('openai', null, 'sk-test-abcdefgh');
    const [creds, opts] = adapter.verify.mock.calls[0];
    expect(creds).toEqual({ provider: 'openai', apiKey: 'sk-test-abcdefgh', baseUrl: 'https://api.openai.com/v1' });
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.modelHint).toBeUndefined();
    expect(takeToken).toHaveBeenCalledWith('user-1', 'connect');
    expect(conn.saveModelConnection).toHaveBeenCalledWith('user-1', {
      provider: 'openai',
      baseUrl: null,
      model: 'gpt-4o-mini',
      modelMeta: {},
      authMethod: 'key',
      apiKey: 'sk-test-abcdefgh',
    });
  });

  it.each([
    ['an unknown provider', { provider: 'cohere', apiKey: 'sk-abcdefgh' }, 'invalid', 'provider'],
    ['a short key', { provider: 'openai', apiKey: 'sk-1' }, 'invalid', 'apiKey'],
    ['a key with a space', { provider: 'openai', apiKey: 'sk-abc defgh' }, 'invalid', 'apiKey'],
    ['a key over 512', { provider: 'openai', apiKey: 'k'.repeat(513) }, 'invalid', 'apiKey'],
    ['a non-string key', { provider: 'openai', apiKey: 12345678 }, 'invalid', 'apiKey'],
    ['custom without a base URL', { provider: 'custom', apiKey: 'sk-abcdefgh' }, 'invalid', 'baseUrl'],
    ['custom on http', { provider: 'custom', apiKey: 'sk-abcdefgh', baseUrl: 'http://api.example.com/v1' }, 'blocked_url', 'baseUrl'],
    ['custom on loopback', { provider: 'custom', apiKey: 'sk-abcdefgh', baseUrl: 'https://127.0.0.1/v1' }, 'blocked_url', 'baseUrl'],
    ['a model id with a space', { provider: 'openai', apiKey: 'sk-abcdefgh', model: 'Llama 3 8B' }, 'invalid', 'model'],
    ['an array body', [], 'invalid', 'body'],
  ])('refuses %s with 400 before any check', async (_label, body, error, field) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error, field });
    expect(takeToken).not.toHaveBeenCalled();
    expect(adapter.verify).not.toHaveBeenCalled();
    expect(conn.saveModelConnection).not.toHaveBeenCalled();
  });

  it('no encryption key, or no table: 503 unavailable, available:false', async () => {
    vi.mocked(loadEncryptionKey).mockReturnValue({ ok: false, reason: 'invalid' });
    let res = await put({ provider: 'openai', apiKey: 'sk-abcdefgh' });
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({ error: 'unavailable', available: false });

    vi.mocked(loadEncryptionKey).mockReturnValue({ ok: true, key: Buffer.alloc(32, 7) });
    vi.mocked(conn.readModelConnection).mockResolvedValue({ kind: 'unavailable', reason: 'no_table' });
    res = await put({ provider: 'openai', apiKey: 'sk-abcdefgh' });
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({ error: 'unavailable', available: false });
    expect(adapter.verify).not.toHaveBeenCalled();
  });

  it('429 busy on the connect limiter, before any upstream call', async () => {
    vi.mocked(takeToken).mockReturnValue(false);
    const res = await put({ provider: 'openai', apiKey: 'sk-abcdefgh' });
    expect(res.status).toBe(429);
    expect(await json(res)).toEqual({ error: 'busy' });
    expect(adapter.verify).not.toHaveBeenCalled();
  });

  it.each([
    ['auth', 400, { error: 'key_rejected' }],
    ['network', 502, { error: 'unreachable' }],
    ['timeout', 502, { error: 'unreachable' }],
    ['upstream', 502, { error: 'unreachable' }],
    ['rate_limit', 502, { error: 'unreachable' }],
    ['blocked_url', 400, { error: 'blocked_url', field: 'baseUrl' }],
    ['model_required', 400, { error: 'model_required' }],
    ['bad_model', 400, { error: 'invalid', field: 'model' }],
  ] as const)('a %s verify answers %i and leaves any existing row alone', async (kind, status, body) => {
    adapter.verify.mockRejectedValue(new ProviderError(kind as ProviderErrorKind));
    const res = await put({ provider: 'openai', apiKey: 'sk-abcdefgh' });
    expect(res.status).toBe(status);
    expect(await json(res)).toEqual(body);
    expect(conn.saveModelConnection).not.toHaveBeenCalled();
    expect(conn.setConnectionStatus).not.toHaveBeenCalled();
    expect(conn.deleteModelConnection).not.toHaveBeenCalled();
  });

  it('custom: the normalized base URL is checked and stored; a typed model is the hint and the choice', async () => {
    adapter.verify.mockResolvedValue({ models: [], listed: false });
    const res = await put({
      provider: 'custom',
      apiKey: 'gsk_abcdefgh',
      baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.1-8b-instant',
    });
    expect(res.status).toBe(200);
    expect(credentialsFor).toHaveBeenCalledWith('custom', 'https://api.groq.com/openai/v1', 'gsk_abcdefgh');
    expect(adapter.verify.mock.calls[0][1].modelHint).toBe('llama-3.1-8b-instant');
    expect(conn.saveModelConnection).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.1-8b-instant' })
    );
  });

  it('custom: nothing usable listed and no model typed → 400 model_required, nothing saved', async () => {
    adapter.verify.mockResolvedValue({ models: [], listed: true });
    const res = await put({ provider: 'custom', apiKey: 'sk-abcdefgh', baseUrl: 'https://api.example.com/v1' });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'model_required' });
    expect(conn.saveModelConnection).not.toHaveBeenCalled();
  });

  it('custom: a host that lists several models and no model typed connects with model null and returns the list', async () => {
    // The custom default is the ONLY listed id, so two or more give null. That
    // is a choice to make in the picker, not a host that cannot list.
    const several = [
      { id: 'llama-3.1-8b-instant', label: 'llama-3.1-8b-instant' },
      { id: 'mixtral-8x7b', label: 'mixtral-8x7b' },
    ];
    adapter.verify.mockResolvedValue({ models: several, listed: true });
    adapter.pickDefaultModel.mockImplementation((r: { models: Array<{ id: string }> }) =>
      r.models.length === 1 ? r.models[0].id : null
    );
    const res = await put({ provider: 'custom', apiKey: 'gsk_abcdefgh', baseUrl: 'https://api.groq.com/openai/v1' });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      connection: expect.objectContaining({ provider: 'custom', model: null, baseUrl: 'https://api.groq.com/openai/v1' }),
      models: several,
      listed: true,
    });
    expect(conn.saveModelConnection).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ provider: 'custom', model: null, modelMeta: {} })
    );
  });

  it('custom: a host that lists exactly one model connects with it', async () => {
    adapter.verify.mockResolvedValue({ models: [{ id: 'only-one', label: 'only-one' }], listed: true });
    adapter.pickDefaultModel.mockImplementation((r: { models: Array<{ id: string }> }) =>
      r.models.length === 1 ? r.models[0].id : null
    );
    const res = await put({ provider: 'custom', apiKey: 'sk-abcdefgh', baseUrl: 'https://api.example.com/v1' });
    expect(res.status).toBe(200);
    expect(conn.saveModelConnection).toHaveBeenCalledWith('user-1', expect.objectContaining({ model: 'only-one' }));
  });

  it('custom: an unlisted host with no model typed is still 400 model_required, nothing saved', async () => {
    adapter.verify.mockResolvedValue({ models: [], listed: false });
    adapter.pickDefaultModel.mockReturnValue(null);
    const res = await put({ provider: 'custom', apiKey: 'sk-abcdefgh', baseUrl: 'https://api.example.com/v1' });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'model_required' });
    expect(conn.saveModelConnection).not.toHaveBeenCalled();
  });

  it('a built-in provider with no default still connects, model null until picked', async () => {
    adapter.verify.mockResolvedValue({ models: [], listed: true });
    const res = await put({ provider: 'gemini', apiKey: 'AIzaabcdefgh' });
    expect(res.status).toBe(200);
    expect(conn.saveModelConnection).toHaveBeenCalledWith('user-1', expect.objectContaining({ model: null }));
  });

  it('OpenRouter: the public catalog is listed and the default sees the free tier', async () => {
    adapter.verify.mockResolvedValue({ models: [], listed: false, freeTier: true });
    adapter.listModels.mockResolvedValue({
      models: [{ id: 'meta-llama/llama-3:free', label: 'Llama 3 (free)', free: true, contextLength: 8192 }],
      listed: true,
    });
    const res = await put({ provider: 'openrouter', apiKey: 'sk-or-abcdefgh' });
    expect(res.status).toBe(200);
    expect(adapter.pickDefaultModel).toHaveBeenCalledWith({
      models: [{ id: 'meta-llama/llama-3:free', label: 'Llama 3 (free)', free: true, contextLength: 8192 }],
      listed: true,
      freeTier: true,
    });
    expect((await json(res)).models).toEqual([{ id: 'meta-llama/llama-3:free', label: 'Llama 3 (free)', free: true }]);
    expect(conn.saveModelConnection).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ provider: 'openrouter', authMethod: 'key', model: 'meta-llama/llama-3:free' })
    );
  });

  it('Anthropic: the listed entry’s effort capability becomes model_meta', async () => {
    adapter.verify.mockResolvedValue({
      models: [
        { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', effortLow: true },
        { id: 'claude-3-haiku', label: 'Claude Haiku 3', effortLow: false },
      ],
      listed: true,
    });
    await put({ provider: 'anthropic', apiKey: 'sk-ant-abcdefgh' });
    expect(conn.saveModelConnection).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ model: 'claude-opus-5-5', modelMeta: { effortLow: true } })
    );
    vi.mocked(conn.saveModelConnection).mockClear();
    await put({ provider: 'anthropic', apiKey: 'sk-ant-abcdefgh', model: 'claude-3-haiku' });
    expect(conn.saveModelConnection).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ model: 'claude-3-haiku', modelMeta: { effortLow: false } })
    );
    vi.mocked(conn.saveModelConnection).mockClear();
    await put({ provider: 'anthropic', apiKey: 'sk-ant-abcdefgh', model: 'claude-unlisted' });
    expect(conn.saveModelConnection).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ model: 'claude-unlisted', modelMeta: {} })
    );
  });

  it('a save failure answers 503 server and logs op + code only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(conn.saveModelConnection).mockRejectedValue(new conn.AiDbError('save', '23514'));
    const res = await put({ provider: 'openai', apiKey: 'sk-abcdefgh' });
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({ error: 'server' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[ai] db', 'save', 'failed', '23514');
  });

  it('a stored custom URL that credentialsFor refuses answers 400 blocked_url', async () => {
    vi.mocked(credentialsFor).mockImplementationOnce(() => {
      throw new ProviderError('blocked_url');
    });
    const res = await put({ provider: 'custom', apiKey: 'sk-abcdefgh', baseUrl: 'https://api.example.com/v1' });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'blocked_url', field: 'baseUrl' });
  });
});

// ── PATCH {provider, model} ──────────────────────────────────────────────────

describe('PATCH /api/ai/connection {provider, model}', () => {
  it.each([
    [{}],
    [{ recheck: false }],
    [{ recheck: true, provider: 'openai' }],
    [{ provider: 'openai' }],
    [{ provider: 'nope', model: 'x' }],
    [{ provider: 'openai', model: 'gpt-4o', extra: 1 }],
    [[]],
    ['"recheck"'],
  ])('refuses anything outside the closed union: %j', async (body) => {
    const res = await patch(body);
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'invalid' });
    expect(conn.setConnectionModel).not.toHaveBeenCalled();
    expect(adapter.verify).not.toHaveBeenCalled();
  });

  it('a model id outside MODEL_ID_RE is 400 invalid on model', async () => {
    const res = await patch({ provider: 'openai', model: 'has space' });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'invalid', field: 'model' });
  });

  it('sets the model for a non-Anthropic provider with no upstream call', async () => {
    const res = await patch({ provider: 'openai', model: 'gpt-4o' });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ connection: expect.objectContaining({ provider: 'openai', model: 'gpt-4o' }) });
    expect(conn.setConnectionModel).toHaveBeenCalledWith('user-1', 'openai', 'gpt-4o', {});
    expect(takeToken).not.toHaveBeenCalled();
    expect(adapter.describeModel).not.toHaveBeenCalled();
  });

  it('409 conflict when the row belongs to another provider; 404 when there is no row', async () => {
    vi.mocked(conn.setConnectionModel).mockResolvedValue(null);
    vi.mocked(conn.readModelConnection).mockResolvedValue({ kind: 'row', row: rowOf({ provider: 'gemini' }) });
    let res = await patch({ provider: 'openai', model: 'gpt-4o' });
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: 'conflict' });

    vi.mocked(conn.readModelConnection).mockResolvedValue({ kind: 'none' });
    res = await patch({ provider: 'openai', model: 'gpt-4o' });
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: 'not_connected' });
  });

  it('Anthropic: one describe call, and model_meta.effortLow is stored', async () => {
    vi.mocked(conn.readModelConnection).mockResolvedValue({ kind: 'row', row: rowOf({ provider: 'anthropic' }) });
    const res = await patch({ provider: 'anthropic', model: 'claude-opus-5-5' });
    expect(res.status).toBe(200);
    expect(takeToken).toHaveBeenCalledWith('user-1', 'check');
    expect(conn.openConnectionKey).toHaveBeenCalledWith('user-1');
    const [creds, model, signal] = adapter.describeModel.mock.calls[0];
    expect(creds).toEqual({ provider: 'anthropic', apiKey: 'sk-opened-key', baseUrl: 'https://api.anthropic.com' });
    expect(model).toBe('claude-opus-5-5');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(conn.setConnectionModel).toHaveBeenCalledWith('user-1', 'anthropic', 'claude-opus-5-5', { effortLow: true });
  });

  it('Anthropic: an unknown model is 400 invalid on model, and nothing is stored', async () => {
    vi.mocked(conn.readModelConnection).mockResolvedValue({ kind: 'row', row: rowOf({ provider: 'anthropic' }) });
    adapter.describeModel.mockRejectedValue(new ProviderError('bad_model', 404));
    const res = await patch({ provider: 'anthropic', model: 'claude-nope' });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'invalid', field: 'model' });
    expect(conn.setConnectionModel).not.toHaveBeenCalled();
  });

  it('Anthropic: a rejected key is marked failing conditionally and answers key_rejected', async () => {
    vi.mocked(conn.readModelConnection).mockResolvedValue({ kind: 'row', row: rowOf({ provider: 'anthropic' }) });
    adapter.describeModel.mockRejectedValue(new ProviderError('auth', 401));
    const res = await patch({ provider: 'anthropic', model: 'claude-opus-5-5' });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'key_rejected' });
    expect(conn.setConnectionStatus).toHaveBeenCalledWith('user-1', CIPHER, 'failing', 'key_rejected');
    expect(conn.setConnectionModel).not.toHaveBeenCalled();
  });

  it('Anthropic: a network failure stores the model with empty meta', async () => {
    vi.mocked(conn.readModelConnection).mockResolvedValue({ kind: 'row', row: rowOf({ provider: 'anthropic' }) });
    adapter.describeModel.mockRejectedValue(new ProviderError('network'));
    const res = await patch({ provider: 'anthropic', model: 'claude-opus-5-5' });
    expect(res.status).toBe(200);
    expect(conn.setConnectionModel).toHaveBeenCalledWith('user-1', 'anthropic', 'claude-opus-5-5', {});
  });

  it('Anthropic: 429 on the check limiter; another provider’s key is never sent to Anthropic', async () => {
    vi.mocked(takeToken).mockReturnValue(false);
    let res = await patch({ provider: 'anthropic', model: 'claude-opus-5-5' });
    expect(res.status).toBe(429);
    expect(await json(res)).toEqual({ error: 'busy' });

    vi.mocked(takeToken).mockReturnValue(true);
    vi.mocked(conn.readModelConnection).mockResolvedValue({ kind: 'row', row: rowOf({ provider: 'openai' }) });
    res = await patch({ provider: 'anthropic', model: 'claude-opus-5-5' });
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: 'conflict' });
    expect(adapter.describeModel).not.toHaveBeenCalled();
  });

  it('no encryption key → 503 unavailable', async () => {
    vi.mocked(loadEncryptionKey).mockReturnValue({ ok: false, reason: 'missing' });
    const res = await patch({ provider: 'openai', model: 'gpt-4o' });
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({ error: 'unavailable', available: false });
  });
});

// ── PATCH {recheck:true} ─────────────────────────────────────────────────────

describe('PATCH /api/ai/connection {recheck:true}', () => {
  it('a passing key is written ok conditionally on the ciphertext read, then re-read', async () => {
    vi.mocked(conn.readModelConnection)
      .mockResolvedValueOnce({ kind: 'row', row: rowOf({ status: 'failing', last_error: 'key_rejected' }) })
      .mockResolvedValueOnce({ kind: 'row', row: rowOf() });
    const res = await patch({ recheck: true });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ connection: expect.objectContaining({ status: 'ok', problem: null }) });
    expect(takeToken).toHaveBeenCalledWith('user-1', 'check');
    expect(adapter.verify.mock.calls[0][1].modelHint).toBe('gpt-4o-mini');
    expect(conn.setConnectionStatus).toHaveBeenCalledWith('user-1', CIPHER, 'ok', null);
  });

  it('works with no model chosen yet', async () => {
    vi.mocked(conn.readModelConnection).mockResolvedValue({ kind: 'row', row: rowOf({ model: null }) });
    const res = await patch({ recheck: true });
    expect(res.status).toBe(200);
    expect(adapter.verify.mock.calls[0][1].modelHint).toBeUndefined();
  });

  it('a rejected key is written failing, conditionally, and answered 200', async () => {
    vi.mocked(conn.readModelConnection)
      .mockResolvedValueOnce({ kind: 'row', row: rowOf() })
      .mockResolvedValueOnce({ kind: 'row', row: rowOf({ status: 'failing', last_error: 'key_rejected' }) });
    adapter.verify.mockRejectedValue(new ProviderError('auth', 401));
    const res = await patch({ recheck: true });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ connection: expect.objectContaining({ status: 'failing', problem: 'key_rejected' }) });
    expect(conn.setConnectionStatus).toHaveBeenCalledTimes(1);
    expect(conn.setConnectionStatus).toHaveBeenCalledWith('user-1', CIPHER, 'failing', 'key_rejected');
  });

  it('an unreachable provider is 502 and the status is left alone', async () => {
    adapter.verify.mockRejectedValue(new ProviderError('network'));
    const res = await patch({ recheck: true });
    expect(res.status).toBe(502);
    expect(await json(res)).toEqual({ error: 'unreachable' });
    expect(conn.setConnectionStatus).not.toHaveBeenCalled();
  });

  it('a custom host whose stored model is gone: 400 invalid on model, like connect, and the status is left alone', async () => {
    // A custom host that cannot list checks the key with a 1-token call on the
    // stored model; a retired one answers 404, which is a model problem.
    vi.mocked(conn.readModelConnection).mockResolvedValue({
      kind: 'row',
      row: rowOf({ provider: 'custom', base_url: 'https://llm.example.com/v1', model: 'retired-model' }),
    });
    adapter.verify.mockRejectedValue(new ProviderError('bad_model', 404));
    const res = await patch({ recheck: true });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'invalid', field: 'model' });
    expect(adapter.verify.mock.calls[0][1].modelHint).toBe('retired-model');
    expect(conn.setConnectionStatus).not.toHaveBeenCalled();
  });

  it.each(['bad_model', 'model_required', 'blocked_url', 'bad_request', 'network', 'timeout', 'upstream'] as const)(
    'a %s check answers exactly what connect answers for it, and writes nothing',
    async (kind) => {
      const custom = { provider: 'custom', base_url: 'https://llm.example.com/v1', model: 'some-model' } as const;
      vi.mocked(conn.readModelConnection).mockResolvedValue({ kind: 'row', row: rowOf(custom) });
      adapter.verify.mockRejectedValue(new ProviderError(kind));
      const viaConnect = await put({ provider: 'custom', apiKey: 'sk-abcdefgh', baseUrl: custom.base_url, model: custom.model });
      const viaRecheck = await patch({ recheck: true });
      expect(adapter.verify).toHaveBeenCalledTimes(2);
      expect(viaRecheck.status).toBe(viaConnect.status);
      expect(await json(viaRecheck)).toEqual(await json(viaConnect));
      expect(conn.setConnectionStatus).not.toHaveBeenCalled();
      expect(conn.saveModelConnection).not.toHaveBeenCalled();
    }
  );

  it('an unreadable key answers 200 key_unreadable and writes nothing', async () => {
    vi.mocked(openSecret).mockReturnValue(null);
    const res = await patch({ recheck: true });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      connection: expect.objectContaining({ status: 'failing', problem: 'key_unreadable' }),
    });
    expect(adapter.verify).not.toHaveBeenCalled();
    expect(conn.setConnectionStatus).not.toHaveBeenCalled();
  });

  it('404 with nothing connected, 503 when unavailable, 429 on the limiter', async () => {
    vi.mocked(conn.readModelConnection).mockResolvedValue({ kind: 'none' });
    let res = await patch({ recheck: true });
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: 'not_connected' });

    vi.mocked(conn.readModelConnection).mockResolvedValue({ kind: 'unavailable', reason: 'no_table' });
    res = await patch({ recheck: true });
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({ error: 'unavailable', available: false });

    vi.mocked(takeToken).mockReturnValue(false);
    res = await patch({ recheck: true });
    expect(res.status).toBe(429);
    expect(await json(res)).toEqual({ error: 'busy' });
  });
});

// ── DELETE ───────────────────────────────────────────────────────────────────

describe('DELETE /api/ai/connection', () => {
  it('forgets the connection, idempotently', async () => {
    let res = await route.DELETE(call('DELETE'));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });
    res = await route.DELETE(call('DELETE'));
    expect(res.status).toBe(200);
    expect(conn.deleteModelConnection).toHaveBeenCalledTimes(2);
    expect(conn.deleteModelConnection).toHaveBeenCalledWith('user-1');
  });

  it('a db failure is 503 server', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(conn.deleteModelConnection).mockRejectedValue(new conn.AiDbError('delete', '57014'));
    const res = await route.DELETE(call('DELETE'));
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({ error: 'server' });
  });
});

// ── GET /models ──────────────────────────────────────────────────────────────

describe('GET /api/ai/connection/models', () => {
  it('lists the connected key’s models in the picker’s shape', async () => {
    const res = await listModels();
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      models: [
        { id: 'gpt-4o-mini', label: 'gpt-4o-mini' },
        { id: 'gpt-4o', label: 'gpt-4o' },
      ],
      listed: true,
    });
    expect(takeToken).toHaveBeenCalledWith('user-1', 'check');
    expect(adapter.listModels.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
  });

  it('answers while no model is chosen yet, and while the key is marked failing', async () => {
    vi.mocked(conn.readModelConnection).mockResolvedValue({
      kind: 'row',
      row: rowOf({ model: null, status: 'failing', last_error: 'key_rejected' }),
    });
    expect((await listModels()).status).toBe(200);
  });

  it('404 none, 409 unreadable, 503 unavailable or no key, 429 busy', async () => {
    vi.mocked(conn.readModelConnection).mockResolvedValue({ kind: 'none' });
    let res = await listModels();
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: 'not_connected' });

    vi.mocked(conn.readModelConnection).mockResolvedValue({ kind: 'row', row: rowOf() });
    vi.mocked(openSecret).mockReturnValue(null);
    res = await listModels();
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: 'not_connected' });

    vi.mocked(conn.readModelConnection).mockResolvedValue({ kind: 'unavailable', reason: 'no_table' });
    res = await listModels();
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({ error: 'unavailable', available: false });

    vi.mocked(loadEncryptionKey).mockReturnValue({ ok: false, reason: 'missing' });
    res = await listModels();
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({ error: 'unavailable', available: false });

    vi.mocked(takeToken).mockReturnValue(false);
    res = await listModels();
    expect(res.status).toBe(429);
    expect(await json(res)).toEqual({ error: 'busy' });
    expect(adapter.listModels).not.toHaveBeenCalled();
  });

  it('a rejected key is marked failing conditionally: 400 key_rejected', async () => {
    adapter.listModels.mockRejectedValue(new ProviderError('auth', 401));
    const res = await listModels();
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'key_rejected' });
    expect(conn.setConnectionStatus).toHaveBeenCalledWith('user-1', CIPHER, 'failing', 'key_rejected');
  });

  it('an unreachable provider is 502 unreachable, nothing written', async () => {
    adapter.listModels.mockRejectedValue(new ProviderError('timeout'));
    const res = await listModels();
    expect(res.status).toBe(502);
    expect(await json(res)).toEqual({ error: 'unreachable' });
    expect(conn.setConnectionStatus).not.toHaveBeenCalled();
  });
});
