// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as connection from '@/app/api/ai/connection/route';
import * as models from '@/app/api/ai/connection/models/route';
import * as chat from '@/app/api/chat/route';
import * as propose from '@/app/api/ai/propose/route';
import * as start from '@/app/api/ai/openrouter/start/route';
import * as callback from '@/app/api/ai/openrouter/callback/[state]/route';
import * as conversations from '@/app/api/ai/conversations/route';
import * as conversationSearch from '@/app/api/ai/conversations/search/route';
import * as conversation from '@/app/api/ai/conversations/[id]/route';
import * as turns from '@/app/api/ai/conversations/[id]/turns/route';
import * as conn from '@/lib/ai-server/connections';
import type { ModelConnectionRow } from '@/lib/ai-server/connections';
import * as box from '@/lib/ai-server/secret-box';
import * as errors from '@/lib/ai-server/errors';
import type { ProviderErrorKind } from '@/lib/ai-server/errors';
import type { ModelProviderId } from '@/lib/ai-types';
import { createServiceClient } from '@/lib/supabase-service';

/**
 * The security sweep across EVERY AI route handler:
 *   - no session: 401 (303 /login for the OAuth pair), with no fetch and no
 *     service-client call
 *   - a cross-site request: 403 on every state-changing handler
 *   - the key sentinel: a key PUT once never comes back out, in any body,
 *     header, Location or log line, and neither does its ciphertext
 *   - no app key: OPENAI_API_KEY in the environment changes nothing
 *   - no encryption key: available:false or 503, never a 500, never a throw
 *   - a database error whose details carry the row: 503 and one log line
 *   - Cache-Control: no-store on every response
 *
 * secret-box.ts and connections.ts are REAL by default (vi.fn(actual)); the
 * key-sentinel case swaps connections for an in-memory store sealed with the
 * real secret-box, and the db sweep runs the real connections.ts over a
 * service client that fails every write. Both are U1's modules (cross-unit).
 */

const h = vi.hoisted(() => ({ user: { id: 'user-1' } as { id: string } | null }));

vi.mock('@/lib/supabase-server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: h.user }, error: h.user ? null : { message: 'no' } })) },
  })),
}));

vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: vi.fn(() => {
    throw new Error('the service client must not be reached in this case');
  }),
  resolveUserIdFromApiKey: vi.fn(),
}));

vi.mock('@/lib/ai-server/secret-box', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai-server/secret-box')>();
  return {
    ...actual,
    loadEncryptionKey: vi.fn(actual.loadEncryptionKey),
    sealSecret: vi.fn(actual.sealSecret),
    openSecret: vi.fn(actual.openSecret),
  };
});

const real = vi.hoisted(() => ({ conn: null as null | typeof import('@/lib/ai-server/connections') }));
vi.mock('@/lib/ai-server/connections', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai-server/connections')>();
  real.conn = actual;
  return {
    ...actual,
    readModelConnection: vi.fn(actual.readModelConnection),
    isReadable: vi.fn(actual.isReadable),
    openConnectionKey: vi.fn(actual.openConnectionKey),
    openModelConnection: vi.fn(actual.openModelConnection),
    saveModelConnection: vi.fn(actual.saveModelConnection),
    setConnectionModel: vi.fn(actual.setConnectionModel),
    setConnectionStatus: vi.fn(actual.setConnectionStatus),
    deleteModelConnection: vi.fn(actual.deleteModelConnection),
    readOpenClawStatus: vi.fn(async () => ({ gateway: false, pluginChat: false, agent: false, agentId: null })),
    readAIHidden: vi.fn(async () => false),
    writeAIHidden: vi.fn(async () => true),
  };
});

// Deterministic stand-ins for the rest of U1 (their own tests pin them). The
// key-sentinel case swaps the real classifier and logger back in.
const realErrors = vi.hoisted(() => ({ mod: null as null | typeof import('@/lib/ai-server/errors') }));
vi.mock('@/lib/ai-server/errors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai-server/errors')>();
  realErrors.mod = actual;
  return {
    ...actual,
    toProviderError: vi.fn((err: unknown) =>
      err instanceof actual.ProviderError ? err : new actual.ProviderError('upstream')
    ),
    toChatErrorCode: vi.fn((k: ProviderErrorKind) => (k === 'aborted' ? 'network' : k)),
    httpStatusFor: vi.fn((k: ProviderErrorKind) => (k === 'blocked_url' ? 400 : k === 'timeout' ? 504 : 502)),
    logProviderError: vi.fn(),
  };
});
vi.mock('@/lib/ai-server/stream', () => ({
  anySignal: vi.fn((signals: AbortSignal[]) => AbortSignal.any(signals)),
  deltasToSse: vi.fn(
    (source: AsyncIterable<string>, opts: { onError: (e: unknown) => Promise<object> }) => {
      const enc = new TextEncoder();
      return new ReadableStream<Uint8Array>({
        async start(c) {
          try {
            for await (const d of source) c.enqueue(enc.encode(`data: ${JSON.stringify({ content: d })}\n\n`));
          } catch (err) {
            c.enqueue(enc.encode(`data: ${JSON.stringify(await opts.onError(err))}\n\n`));
          }
          c.enqueue(enc.encode('data: [DONE]\n\n'));
          c.close();
        },
      });
    }
  ),
}));
vi.mock('@/lib/ai-server/rate-limit', () => ({ takeToken: vi.fn(() => true) }));

const adapter = vi.hoisted(() => ({
  verify: vi.fn(),
  listModels: vi.fn(),
  describeModel: vi.fn(),
  pickDefaultModel: vi.fn(() => 'gpt-4o-mini'),
  openStream: vi.fn(),
  completeText: vi.fn(),
}));
vi.mock('@/lib/ai-server/providers', () => ({
  getAdapter: vi.fn(() => adapter),
  credentialsFor: vi.fn((provider: string, baseUrl: string | null, apiKey: string) => ({
    provider,
    apiKey,
    baseUrl: baseUrl ?? 'https://api.openai.com/v1',
  })),
}));

const ORIGIN = 'https://do.dsul.app';
const SENTINEL_KEY = 'sk-test-SENTINEL-9876';
const ENV_KEY = Buffer.alloc(32, 3).toString('base64');
const ENV_BEFORE = { model: process.env.MODEL_KEYS_ENCRYPTION_KEY, openai: process.env.OPENAI_API_KEY };

const realConn = () => real.conn!;

function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const params = (state: string) => ({ params: Promise.resolve({ state }) });
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
/** A valid id, so a 403 comes from the origin check and never from id validation. */
const CONV = 'c0000000-0000-4000-8000-0000000000a1';

/** Every route handler, as a thunk over optional extra headers. */
const HANDLERS: Array<[string, (headers?: Record<string, string>) => Promise<Response>, 'json' | 'redirect']> = [
  ['connection GET', () => connection.GET(), 'json'],
  ['connection PUT', (hd) => connection.PUT(req('PUT', '/api/ai/connection', { provider: 'openai', apiKey: SENTINEL_KEY }, hd)), 'json'],
  ['connection PATCH model', (hd) => connection.PATCH(req('PATCH', '/api/ai/connection', { provider: 'openai', model: 'gpt-4o' }, hd)), 'json'],
  ['connection PATCH recheck', (hd) => connection.PATCH(req('PATCH', '/api/ai/connection', { recheck: true }, hd)), 'json'],
  ['connection PATCH hidden', (hd) => connection.PATCH(req('PATCH', '/api/ai/connection', { hidden: true }, hd)), 'json'],
  ['connection DELETE', (hd) => connection.DELETE(req('DELETE', '/api/ai/connection', undefined, hd)), 'json'],
  ['models GET', (hd) => models.GET(req('GET', '/api/ai/connection/models', undefined, hd)), 'json'],
  ['chat POST', (hd) => chat.POST(req('POST', '/api/chat', { messages: [{ role: 'user', content: 'hi' }] }, hd)), 'json'],
  ['propose POST', (hd) => propose.POST(req('POST', '/api/ai/propose', { prompt: 'plan' }, hd)), 'json'],
  ['openrouter start', (hd) => start.GET(req('GET', '/api/ai/openrouter/start', undefined, hd)), 'redirect'],
  [
    'openrouter callback',
    (hd) => callback.GET(req('GET', `/api/ai/openrouter/callback/${'A'.repeat(22)}?code=abcdefgh12`, undefined, hd), params('A'.repeat(22))),
    'redirect',
  ],
  ['conversations GET', (hd) => conversations.GET(req('GET', '/api/ai/conversations', undefined, hd)), 'json'],
  [
    'conversations search POST',
    (hd) => conversationSearch.POST(req('POST', '/api/ai/conversations/search', { q: 'dentist' }, hd)),
    'json',
  ],
  ['conversation GET', (hd) => conversation.GET(req('GET', `/api/ai/conversations/${CONV}`, undefined, hd), idParams(CONV)), 'json'],
  [
    'conversation PATCH',
    (hd) => conversation.PATCH(req('PATCH', `/api/ai/conversations/${CONV}`, { starred: true }, hd), idParams(CONV)),
    'json',
  ],
  [
    'conversation DELETE',
    (hd) => conversation.DELETE(req('DELETE', `/api/ai/conversations/${CONV}`, undefined, hd), idParams(CONV)),
    'json',
  ],
  [
    'turns POST',
    (hd) =>
      turns.POST(
        req(
          'POST',
          `/api/ai/conversations/${CONV}/turns`,
          {
            ownerId: 'user-1',
            create: { itemId: null, title: 'Plan' },
            messages: [{ id: 'c0000000-0000-4000-8000-0000000000b1', role: 'user', content: 'plan' }],
          },
          hd
        ),
        idParams(CONV)
      ),
    'json',
  ],
];

const STATE_CHANGING = HANDLERS.filter(([name]) =>
  [
    'connection PUT',
    'connection PATCH model',
    'connection PATCH recheck',
    'connection PATCH hidden',
    'connection DELETE',
    'chat POST',
    'propose POST',
    // The conversation routes with an origin check. Never 'conversation GET':
    // a read has none, so here it would reach the auth-only mock's .from().
    'conversations search POST',
    'conversation PATCH',
    'conversation DELETE',
    'turns POST',
  ].includes(name)
);

let fetchSpy: ReturnType<typeof vi.spyOn>;
let logs: unknown[][];

/**
 * Everything that writes the account's AI rows. The stand-ins for the
 * hidden flag never reach createServiceClient, so "no service call" alone
 * would not see a write of it; these are checked by name.
 */
const WRITES = [
  conn.saveModelConnection,
  conn.setConnectionModel,
  conn.setConnectionStatus,
  conn.deleteModelConnection,
  conn.writeAIHidden,
];
const expectNothingWritten = () => {
  for (const f of WRITES) expect(f).not.toHaveBeenCalled();
};

beforeEach(() => {
  h.user = { id: 'user-1' };
  process.env.MODEL_KEYS_ENCRYPTION_KEY = ENV_KEY;
  vi.mocked(createServiceClient).mockClear();
  for (const f of [...WRITES, conn.readAIHidden]) vi.mocked(f).mockClear();
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in unit tests'));
  logs = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args);
    });
  }
  adapter.verify.mockReset();
  adapter.verify.mockResolvedValue({ models: [{ id: 'gpt-4o-mini', label: 'gpt-4o-mini' }], listed: true });
  adapter.listModels.mockReset();
  adapter.listModels.mockResolvedValue({ models: [{ id: 'gpt-4o-mini', label: 'gpt-4o-mini' }], listed: true });
  adapter.openStream.mockReset();
  adapter.completeText.mockReset();
  adapter.describeModel.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [name, value] of [
    ['MODEL_KEYS_ENCRYPTION_KEY', ENV_BEFORE.model],
    ['OPENAI_API_KEY', ENV_BEFORE.openai],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  // Back to the real modules for the next case.
  const r = realConn();
  for (const name of [
    'readModelConnection',
    'isReadable',
    'openConnectionKey',
    'openModelConnection',
    'saveModelConnection',
    'setConnectionModel',
    'setConnectionStatus',
    'deleteModelConnection',
  ] as const) {
    (vi.mocked(conn[name]) as unknown as { mockImplementation(f: unknown): void }).mockImplementation(r[name]);
  }
});

function expectNoStore(res: Response) {
  expect(res.headers.get('cache-control')).toBe('no-store');
}

describe('no session', () => {
  it.each(HANDLERS)('%s refuses with no fetch and no service call', async (_name, run, kind) => {
    h.user = null;
    const res = await run();
    expectNoStore(res);
    if (kind === 'json') {
      expect(res.status).toBe(401);
      expect((await res.json()) as object).toMatchObject(
        _name === 'chat POST' || _name === 'propose POST' ? { code: 'unauthorized' } : { error: 'unauthorized' }
      );
    } else {
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toMatch(new RegExp(`^${ORIGIN}/login`));
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
    expectNothingWritten();
    expect(conn.readAIHidden).not.toHaveBeenCalled();
    expect(adapter.verify).not.toHaveBeenCalled();
  });
});

describe('cross-site requests', () => {
  it.each(STATE_CHANGING)('%s answers 403 for a foreign Origin and for Sec-Fetch-Site: cross-site', async (_name, run) => {
    const variants: Array<Record<string, string>> = [
      { origin: 'https://evil.example' },
      { 'sec-fetch-site': 'cross-site' },
      { origin: 'null' },
    ];
    for (const headers of variants) {
      const res = await run(headers);
      expect(res.status).toBe(403);
      expectNoStore(res);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
    expectNothingWritten();
  });
});

describe('the key never comes back out (real secret-box)', () => {
  /** connections.ts as an in-memory table, sealed and opened with the REAL secret-box. */
  function memoryConnections() {
    const store = new Map<string, ModelConnectionRow>();
    const key = () => {
      const k = box.loadEncryptionKey();
      if (!k.ok) throw new Error('no key');
      return k.key;
    };
    const ctx = (userId: string, provider: ModelProviderId, baseUrl: string | null) => ({
      userId,
      purpose: 'model-key' as const,
      provider,
      baseUrl,
    });
    const open = (row: ModelConnectionRow, userId: string) =>
      box.openSecret(row.key_ciphertext, ctx(userId, row.provider, row.base_url), key());

    vi.mocked(conn.readModelConnection).mockImplementation(async (userId) => {
      const row = store.get(userId);
      return row ? { kind: 'row', row } : { kind: 'none' };
    });
    vi.mocked(conn.isReadable).mockImplementation((row, userId) => open(row, userId) !== null);
    vi.mocked(conn.openConnectionKey).mockImplementation(async (userId) => {
      const row = store.get(userId);
      if (!row) return { ok: false, reason: 'none' };
      const apiKey = open(row, userId);
      if (apiKey === null) return { ok: false, reason: 'unreadable' };
      return { ok: true, row, creds: { provider: row.provider, apiKey, baseUrl: 'https://api.openai.com/v1' } };
    });
    vi.mocked(conn.openModelConnection).mockImplementation(async (userId) => {
      const o = await conn.openConnectionKey(userId);
      if (!o.ok) return o;
      if (o.row.status === 'failing') return { ok: false, reason: 'failing' };
      if (!o.row.model) return { ok: false, reason: 'no_model' };
      return { ...o, model: o.row.model };
    });
    vi.mocked(conn.saveModelConnection).mockImplementation(async (userId, v) => {
      const row: ModelConnectionRow = {
        user_id: userId,
        provider: v.provider,
        base_url: v.baseUrl,
        model: v.model,
        model_meta: v.modelMeta,
        auth_method: v.authMethod,
        key_ciphertext: box.sealSecret(v.apiKey, ctx(userId, v.provider, v.baseUrl), key()),
        status: 'ok',
        last_error: null,
        checked_at: new Date().toISOString(),
      };
      store.set(userId, row);
      return row;
    });
    vi.mocked(conn.setConnectionModel).mockImplementation(async (userId, provider, model, meta) => {
      const row = store.get(userId);
      if (!row || row.provider !== provider) return null;
      const next = { ...row, model, model_meta: meta };
      store.set(userId, next);
      return next;
    });
    vi.mocked(conn.setConnectionStatus).mockImplementation(async (userId, expect_, status, problem) => {
      const row = store.get(userId);
      if (!row || row.key_ciphertext !== expect_) return false;
      store.set(userId, { ...row, status, last_error: problem });
      return true;
    });
    vi.mocked(conn.deleteModelConnection).mockImplementation(async (userId) => {
      store.delete(userId);
    });
    return store;
  }

  it('after a PUT with a sentinel key, no body, header, Location or log line carries it or its ciphertext', async () => {
    // Pre-U1 these throw `not implemented: <name>`, the only failure allowed.
    expect(box.loadEncryptionKey().ok).toBe(true);
    const store = memoryConnections();

    // The REAL classifier and logger, so the path an upstream error takes from
    // a throw to a response and a log line is the shipped one.
    const standIns = {
      toProviderError: vi.mocked(errors.toProviderError).getMockImplementation(),
      logProviderError: vi.mocked(errors.logProviderError).getMockImplementation(),
    };
    vi.mocked(errors.toProviderError).mockImplementation(realErrors.mod!.toProviderError);
    vi.mocked(errors.logProviderError).mockImplementation(realErrors.mod!.logProviderError);
    try {
      // Upstream errors that quote the key back, as real providers do.
      const leaky = () => new Error(`401 Incorrect API key provided: ${SENTINEL_KEY}`);
      // A real 401 as the SDKs throw it: status-bearing, the key in its text.
      const leaky401 = () => Object.assign(leaky(), { status: 401 });
      adapter.describeModel.mockRejectedValueOnce(leaky401()).mockRejectedValueOnce(leaky());
      adapter.openStream.mockImplementation(async () =>
        (async function* () {
          yield 'hello';
          throw leaky();
        })()
      );
      adapter.completeText.mockRejectedValue(leaky());

      const responses: Array<[string, Response]> = [];
      const run = async (label: string, p: Promise<Response>) => {
        const res = await p;
        responses.push([label, res]);
        return res;
      };

      const first = await run('PUT', connection.PUT(req('PUT', '/api/ai/connection', { provider: 'openai', apiKey: SENTINEL_KEY })));
      expect(first.status).toBe(200);
      expect(store.get('user-1')?.key_ciphertext).toMatch(/^v1:/);
      expect(store.get('user-1')?.key_ciphertext).not.toContain('SENTINEL');

      await run('GET', connection.GET());
      await run('PATCH model', connection.PATCH(req('PATCH', '/api/ai/connection', { provider: 'openai', model: 'gpt-4o' })));
      await run('PATCH recheck', connection.PATCH(req('PATCH', '/api/ai/connection', { recheck: true })));
      await run('PATCH hidden', connection.PATCH(req('PATCH', '/api/ai/connection', { hidden: true })));
      await run('models', models.GET(req('GET', '/api/ai/connection/models')));
      await run('chat', chat.POST(req('POST', '/api/chat', { messages: [{ role: 'user', content: 'hi' }] })));
      await run('propose', propose.POST(req('POST', '/api/ai/propose', { prompt: 'plan' })));
      // A replace whose verify fails with the key in the upstream error.
      adapter.verify.mockRejectedValueOnce(leaky());
      await run('PUT failing', connection.PUT(req('PUT', '/api/ai/connection', { provider: 'openai', apiKey: SENTINEL_KEY })));
      // Anthropic describe, also quoting the key. Connect Anthropic first so the
      // stored key is sealed for it: a row merely relabelled 'anthropic' keeps
      // an OpenAI seal, opens as unreadable, and describe is never asked.
      const anthropic = await run(
        'PUT anthropic',
        connection.PUT(req('PUT', '/api/ai/connection', { provider: 'anthropic', apiKey: SENTINEL_KEY }))
      );
      expect(anthropic.status).toBe(200);
      expect(store.get('user-1')?.provider).toBe('anthropic');
      // A 401 that quotes the key: marked failing, conditionally, and answered in our words.
      const rejected = await run(
        'PATCH anthropic 401',
        connection.PATCH(req('PATCH', '/api/ai/connection', { provider: 'anthropic', model: 'claude-opus-5-5' }))
      );
      expect(rejected.status).toBe(400);
      expect(store.get('user-1')?.status).toBe('failing');
      // Any other failure that quotes it: the model is stored without effort.
      const described = await run(
        'PATCH anthropic',
        connection.PATCH(req('PATCH', '/api/ai/connection', { provider: 'anthropic', model: 'claude-opus-5-5' }))
      );
      expect(described.status).toBe(200);
      expect(store.get('user-1')).toMatchObject({ model: 'claude-opus-5-5', model_meta: {} });
      // Both PATCHes really asked, with the opened key, so neither case can go vacuous.
      expect(adapter.describeModel).toHaveBeenCalledTimes(2);
      for (const [creds] of adapter.describeModel.mock.calls) {
        expect(creds).toMatchObject({ provider: 'anthropic', apiKey: SENTINEL_KEY });
      }
      await run('DELETE', connection.DELETE(req('DELETE', '/api/ai/connection')));

      for (const [label, res] of responses) {
        expectNoStore(res);
        const text = await res.text(); // SSE drained to the end
        const headers = JSON.stringify([...res.headers.entries()]);
        for (const needle of ['SENTINEL', '9876', 'v1:']) {
          expect(text, `${label} body`).not.toContain(needle);
          expect(headers, `${label} headers`).not.toContain(needle);
        }
      }
      const logged = JSON.stringify(logs, (_k, v: unknown) => (v instanceof Error ? `${v.name}: ${v.message}` : v));
      expect(logged).not.toContain('SENTINEL');
      expect(logged).not.toContain('v1:');
      // The real logger did run on the describe path, and said only our words.
      expect(logged).toContain('"model","anthropic","auth",401');
    } finally {
      vi.mocked(errors.toProviderError).mockImplementation(standIns.toProviderError!);
      vi.mocked(errors.logProviderError).mockImplementation(standIns.logProviderError!);
    }
  });
});

describe('no app key', () => {
  it('OPENAI_API_KEY in the environment with no connection: chat and propose are not_connected, nothing fetched', async () => {
    process.env.OPENAI_API_KEY = 'sk-env-SENTINEL';
    vi.mocked(conn.openModelConnection).mockResolvedValue({ ok: false, reason: 'none' });
    const c = await chat.POST(req('POST', '/api/chat', { provider: 'openai', messages: [{ role: 'user', content: 'hi' }] }));
    const p = await propose.POST(req('POST', '/api/ai/propose', { provider: 'openai', prompt: 'plan' }));
    for (const res of [c, p]) {
      expect(res.status).toBe(409);
      expectNoStore(res);
      const text = await res.text();
      expect(JSON.parse(text).code).toBe('not_connected');
      expect(text).not.toContain('SENTINEL');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(adapter.openStream).not.toHaveBeenCalled();
    expect(adapter.completeText).not.toHaveBeenCalled();
  });
});

describe('a missing or invalid encryption key (real secret-box + connections)', () => {
  it.each([
    ['missing', undefined],
    ['31 bytes', Buffer.alloc(31, 1).toString('base64')],
    ['url-safe', Buffer.alloc(32, 0xfb).toString('base64url')],
    ['garbage', 'not a key'],
  ])('%s: GET 200 available:false; PUT, models and chat 503; never a 500 or a throw', async (_label, value) => {
    if (value === undefined) delete process.env.MODEL_KEYS_ENCRYPTION_KEY;
    else process.env.MODEL_KEYS_ENCRYPTION_KEY = value;

    const get = await connection.GET();
    expect(get.status).toBe(200);
    expectNoStore(get);
    expect(await get.json()).toEqual({
      available: false,
      model: null,
      openclaw: { gateway: false, pluginChat: false, agent: false, agentId: null },
      aiHidden: false,
    });

    const put = await connection.PUT(req('PUT', '/api/ai/connection', { provider: 'openai', apiKey: SENTINEL_KEY }));
    expect(put.status).toBe(503);
    expectNoStore(put);
    expect(await put.json()).toEqual({ error: 'unavailable', available: false });

    const list = await models.GET(req('GET', '/api/ai/connection/models'));
    expect(list.status).toBe(503);
    expectNoStore(list);
    expect(await list.json()).toEqual({ error: 'unavailable', available: false });

    const c = await chat.POST(req('POST', '/api/chat', { messages: [{ role: 'user', content: 'hi' }] }));
    expect(c.status).toBe(503);
    expect((await c.json()).available).toBe(false);

    expect(adapter.verify).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('a database error that carries the row (real connections.ts)', () => {
  /**
   * A service client whose every WRITE fails the way a CHECK violation does:
   * PostgREST answers the whole failing row in `details`, ciphertext and all.
   * Reads find nothing. Any query shape works: every call chains, and the
   * chain resolves when awaited.
   */
  function failingWrites() {
    const failure = {
      data: null,
      error: {
        code: '23514',
        message: 'new row for relation "model_connections" violates check constraint SENTINEL',
        details: 'Failing row contains (user-1, openai, null, v1:SENTINEL+ciphertext==, ok).',
        hint: null,
      },
    };
    const chain = (wrote: boolean): unknown =>
      new Proxy(function () {}, {
        get(_t, prop) {
          if (prop === 'then') {
            const result = wrote ? failure : { data: null, error: null };
            return (resolve: (v: unknown) => void) => resolve(result);
          }
          return () => chain(wrote || ['insert', 'upsert', 'update', 'delete'].includes(String(prop)));
        },
      });
    vi.mocked(createServiceClient).mockImplementation(() => chain(false) as ReturnType<typeof createServiceClient>);
  }

  it('PUT answers 503 server; the only log line is `[ai] db save failed 23514`', async () => {
    failingWrites();
    const res = await connection.PUT(req('PUT', '/api/ai/connection', { provider: 'openai', apiKey: SENTINEL_KEY }));
    expect(res.status).toBe(503);
    expectNoStore(res);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'server' });
    expect(text).not.toContain('SENTINEL');
    expect(logs).toEqual([['[ai] db', 'save', 'failed', '23514']]);
    expect(JSON.stringify(logs)).not.toContain('SENTINEL');
  });

  it('a raw error object from anywhere is never logged whole', async () => {
    vi.mocked(conn.saveModelConnection).mockRejectedValue(
      Object.assign(new Error('violates check SENTINEL'), { details: 'v1:SENTINEL', code: '23514' })
    );
    const res = await connection.PUT(req('PUT', '/api/ai/connection', { provider: 'openai', apiKey: SENTINEL_KEY }));
    expect(res.status).toBe(503);
    expect(JSON.stringify(logs, (_k, v: unknown) => (v instanceof Error ? `${v.message}` : v))).not.toContain('SENTINEL');
  });
});
