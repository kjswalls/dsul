// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `model_connections` on the service client (design 1.9), against a recording
 * mock of the Supabase query builder. Two rules carry the weight here:
 *   - a key this deployment cannot open is reported, NEVER written;
 *   - a DB error leaves the module as `AiDbError(op, code)` and nothing else,
 *     because a CHECK failure's `details` is the whole row, ciphertext included.
 */

type Op = [string, unknown[]];
interface Call {
  table: string;
  ops: Op[];
}
type Result = { data: unknown; error: unknown };

const mock = vi.hoisted(() => {
  const state = {
    calls: [] as Array<{ table: string; ops: Array<[string, unknown[]]> }>,
    respond: (() => ({ data: null, error: null })) as (call: {
      table: string;
      ops: Array<[string, unknown[]]>;
    }) => { data: unknown; error: unknown },
    throwOnCreate: false,
    /** When set, createServiceClient hands out this (a real supabase-js client) instead of the recorder. */
    realClient: null as unknown,
  };
  function builder(table: string) {
    const call = { table, ops: [] as Array<[string, unknown[]]> };
    state.calls.push(call);
    const proxy: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
              Promise.resolve()
                .then(() => state.respond(call))
                .then(resolve, reject);
          }
          return (...args: unknown[]) => {
            call.ops.push([String(prop), args]);
            return proxy;
          };
        },
      }
    );
    return proxy;
  }
  return { state, builder };
});

vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: () => {
    if (mock.state.throwOnCreate) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY env vars');
    if (mock.state.realClient) return mock.state.realClient;
    return { from: (table: string) => mock.builder(table) };
  },
}));

import {
  AiDbError,
  deleteModelConnection,
  isReadable,
  openConnectionKey,
  openModelConnection,
  readModelConnection,
  readOpenClawStatus,
  saveModelConnection,
  setConnectionModel,
  setConnectionStatus,
  toConnectionView,
  type ModelConnectionRow,
} from '@/lib/ai-server/connections';
import { BUILTIN_BASE_URLS } from '@/lib/ai-server/providers';
import { openSecret, sealSecret } from '@/lib/ai-server/secret-box';
import { createClient } from '@supabase/supabase-js';

const ENV_KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const USER = '00000000-0000-0000-0000-0000000000aa';
const PLAINTEXT = 'sk-test-SENTINEL-9876';

const opsOf = (call: Call) => call.ops.map(([name]) => name);
const hasWrite = () =>
  mock.state.calls.some((c) => c.ops.some(([name]) => ['update', 'upsert', 'insert', 'delete'].includes(name)));

function sealed(
  provider: ModelConnectionRow['provider'],
  baseUrl: string | null,
  key: Buffer = ENV_KEY,
  user = USER
): string {
  return sealSecret(PLAINTEXT, { userId: user, purpose: 'model-key', provider, baseUrl }, key);
}

function row(over: Partial<ModelConnectionRow> = {}): ModelConnectionRow {
  const provider = over.provider ?? 'openai';
  const baseUrl = over.base_url ?? null;
  return {
    user_id: USER,
    provider,
    base_url: baseUrl,
    model: 'gpt-4o-mini',
    model_meta: {},
    auth_method: 'key',
    key_ciphertext: sealed(provider, baseUrl),
    status: 'ok',
    last_error: null,
    checked_at: '2026-10-01T12:00:00.123+00:00',
    ...over,
  };
}

function answer(fn: (call: Call) => Result) {
  mock.state.respond = fn;
}

let savedEnv: string | undefined;
let logSpies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  savedEnv = process.env.MODEL_KEYS_ENCRYPTION_KEY;
  process.env.MODEL_KEYS_ENCRYPTION_KEY = ENV_KEY.toString('base64');
  mock.state.calls = [];
  mock.state.throwOnCreate = false;
  mock.state.realClient = null;
  answer(() => ({ data: null, error: null }));
  logSpies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {})
  );
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.MODEL_KEYS_ENCRYPTION_KEY;
  else process.env.MODEL_KEYS_ENCRYPTION_KEY = savedEnv;
  vi.restoreAllMocks();
});

function loggedText(): string {
  return logSpies.flatMap((s) => s.mock.calls.flat()).map((x) => {
    try {
      return typeof x === 'string' ? x : JSON.stringify(x, Object.getOwnPropertyNames(x ?? {}));
    } catch {
      return String(x);
    }
  }).join('\n');
}

describe('readModelConnection', () => {
  it('reads the caller’s row on the service client', async () => {
    const r = row();
    answer(() => ({ data: r, error: null }));
    const read = await readModelConnection(USER);
    expect(read).toEqual({ kind: 'row', row: { ...r, checked_at: r.checked_at } });
    const [call] = mock.state.calls;
    expect(call.table).toBe('model_connections');
    expect(call.ops).toContainEqual(['eq', ['user_id', USER]]);
    expect(opsOf(call)).toContain('maybeSingle');
  });

  it('no row → none', async () => {
    expect(await readModelConnection(USER)).toEqual({ kind: 'none' });
  });

  it.each(['42P01', 'PGRST205', '42703', 'PGRST204'])('missing schema (%s) → unavailable no_table', async (code) => {
    answer(() => ({ data: null, error: { code, message: 'relation does not exist' } }));
    expect(await readModelConnection(USER)).toEqual({ kind: 'unavailable', reason: 'no_table' });
  });

  it('missing env key → unavailable no_key, with no DB call', async () => {
    delete process.env.MODEL_KEYS_ENCRYPTION_KEY;
    expect(await readModelConnection(USER)).toEqual({ kind: 'unavailable', reason: 'no_key' });
    process.env.MODEL_KEYS_ENCRYPTION_KEY = 'not-a-key';
    expect(await readModelConnection(USER)).toEqual({ kind: 'unavailable', reason: 'no_key' });
    expect(mock.state.calls).toHaveLength(0);
  });

  it('another DB error throws AiDbError with only the code', async () => {
    answer(() => ({ data: null, error: { code: 'PGRST301', message: 'JWT expired', details: 'x', hint: 'y' } }));
    const err = await readModelConnection(USER).catch((e) => e);
    expect(err).toBeInstanceOf(AiDbError);
    expect(err).toMatchObject({ op: 'read', code: 'PGRST301', message: 'db read failed PGRST301' });
  });

  it('a missing service client throws AiDbError, not the env message', async () => {
    mock.state.throwOnCreate = true;
    const err = await readModelConnection(USER).catch((e) => e);
    expect(err).toBeInstanceOf(AiDbError);
    expect((err as AiDbError).code).toBe('no_service_client');
  });
});

describe('openModelConnection', () => {
  it('opens a usable connection with the built-in base URL', async () => {
    answer(() => ({ data: row(), error: null }));
    const opened = await openModelConnection(USER);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.creds).toEqual({ provider: 'openai', apiKey: PLAINTEXT, baseUrl: BUILTIN_BASE_URLS.openai });
      expect(opened.model).toBe('gpt-4o-mini');
    }
    expect(hasWrite()).toBe(false);
  });

  it('returns unreadable for a key sealed elsewhere and makes NO update call', async () => {
    answer(() => ({ data: row({ key_ciphertext: sealed('openai', null, OTHER_KEY) }), error: null }));
    expect(await openModelConnection(USER)).toEqual({ ok: false, reason: 'unreadable' });
    expect(mock.state.calls).toHaveLength(1);
    expect(hasWrite()).toBe(false);
  });

  it('returns unreadable for another user’s ciphertext', async () => {
    answer(() => ({ data: row({ key_ciphertext: sealed('openai', null, ENV_KEY, 'someone-else') }), error: null }));
    expect(await openModelConnection(USER)).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('a missing table → unavailable; no row → none', async () => {
    answer(() => ({ data: null, error: { code: '42P01' } }));
    expect(await openModelConnection(USER)).toEqual({ ok: false, reason: 'unavailable' });
    answer(() => ({ data: null, error: null }));
    expect(await openModelConnection(USER)).toEqual({ ok: false, reason: 'none' });
  });

  it('a failing row → failing; a row with no model → no_model', async () => {
    answer(() => ({ data: row({ status: 'failing', last_error: 'key_rejected' }), error: null }));
    expect(await openModelConnection(USER)).toEqual({ ok: false, reason: 'failing' });
    answer(() => ({ data: row({ model: null }), error: null }));
    expect(await openModelConnection(USER)).toEqual({ ok: false, reason: 'no_model' });
    expect(hasWrite()).toBe(false);
  });

  it('a stored custom URL that no longer passes the policy → blocked_url', async () => {
    const base = 'https://10.0.0.8/v1';
    answer(() => ({ data: row({ provider: 'custom', base_url: base, key_ciphertext: sealed('custom', base) }), error: null }));
    expect(await openModelConnection(USER)).toEqual({ ok: false, reason: 'blocked_url' });
  });

  it('a custom row opens with its checked base URL', async () => {
    const base = 'https://api.groq.com/openai/v1';
    answer(() => ({
      data: row({ provider: 'custom', base_url: base, model: 'llama-3.3-70b-versatile', key_ciphertext: sealed('custom', base) }),
      error: null,
    }));
    const opened = await openModelConnection(USER);
    expect(opened).toMatchObject({ ok: true, creds: { provider: 'custom', baseUrl: base, apiKey: PLAINTEXT } });
  });

  it('another DB error throws', async () => {
    answer(() => ({ data: null, error: { code: '57014' } }));
    await expect(openModelConnection(USER)).rejects.toBeInstanceOf(AiDbError);
  });
});

describe('openConnectionKey (recheck and the model list)', () => {
  it('opens a failing row and a row with no model', async () => {
    answer(() => ({ data: row({ status: 'failing', last_error: 'key_rejected', model: null }), error: null }));
    const opened = await openConnectionKey(USER);
    expect(opened).toMatchObject({ ok: true, creds: { apiKey: PLAINTEXT } });
  });

  it('still refuses an unreadable key, without writing', async () => {
    answer(() => ({ data: row({ key_ciphertext: sealed('openai', null, OTHER_KEY) }), error: null }));
    expect(await openConnectionKey(USER)).toEqual({ ok: false, reason: 'unreadable' });
    expect(hasWrite()).toBe(false);
  });
});

describe('isReadable / toConnectionView', () => {
  it('readable only under the env key, the same user and the same provider', () => {
    expect(isReadable(row(), USER)).toBe(true);
    expect(isReadable(row(), 'someone-else')).toBe(false);
    expect(isReadable(row({ key_ciphertext: sealed('openai', null, OTHER_KEY) }), USER)).toBe(false);
    expect(isReadable(row({ provider: 'gemini', key_ciphertext: sealed('openai', null) }), USER)).toBe(false);
    delete process.env.MODEL_KEYS_ENCRYPTION_KEY;
    expect(isReadable(row(), USER)).toBe(false);
  });

  it('maps status and problem, and never carries the ciphertext', () => {
    const ok = toConnectionView(row(), true);
    expect(ok).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      baseUrl: null,
      authMethod: 'key',
      status: 'ok',
      problem: null,
      checkedAt: '2026-10-01T12:00:00.123Z',
    });
    expect(JSON.stringify(ok)).not.toContain('v1:');

    expect(toConnectionView(row({ status: 'failing', last_error: 'key_rejected' }), true)).toMatchObject({
      status: 'failing',
      problem: 'key_rejected',
    });
    expect(toConnectionView(row(), false)).toMatchObject({ status: 'failing', problem: 'key_unreadable' });
    expect(
      toConnectionView(row({ provider: 'custom', base_url: 'https://api.groq.com/openai/v1' }), true).baseUrl
    ).toBe('https://api.groq.com/openai/v1');
  });
});

describe('saveModelConnection', () => {
  const echo = (call: Call): Result => {
    const upsert = call.ops.find(([n]) => n === 'upsert');
    return { data: upsert ? { ...(upsert[1][0] as object) } : null, error: null };
  };

  it('upserts on user_id with a sealed key and no plaintext anywhere in the payload', async () => {
    answer(echo);
    const saved = await saveModelConnection(USER, {
      provider: 'anthropic',
      baseUrl: null,
      model: 'claude-opus-5-5',
      modelMeta: { effortLow: true },
      authMethod: 'key',
      apiKey: PLAINTEXT,
    });
    const [call] = mock.state.calls;
    const upsert = call.ops.find(([n]) => n === 'upsert')!;
    const payload = upsert[1][0] as Record<string, unknown>;
    expect(upsert[1][1]).toEqual({ onConflict: 'user_id' });
    expect(JSON.stringify(call.ops)).not.toContain('SENTINEL');
    expect(payload).toMatchObject({
      user_id: USER,
      provider: 'anthropic',
      base_url: null,
      model: 'claude-opus-5-5',
      model_meta: { effortLow: true },
      auth_method: 'key',
      status: 'ok',
      last_error: null,
    });
    expect(typeof payload.checked_at).toBe('string');
    const ct = payload.key_ciphertext as string;
    expect(ct).toMatch(/^v1:/);
    expect(
      openSecret(ct, { userId: USER, purpose: 'model-key', provider: 'anthropic', baseUrl: null }, ENV_KEY)
    ).toBe(PLAINTEXT);
    expect(saved.key_ciphertext).toBe(ct);
  });

  it('binds the custom base URL into the seal and drops a stray baseUrl for a built-in', async () => {
    answer(echo);
    const base = 'https://api.groq.com/openai/v1';
    await saveModelConnection(USER, {
      provider: 'custom', baseUrl: base, model: 'llama', modelMeta: {}, authMethod: 'key', apiKey: PLAINTEXT,
    });
    await saveModelConnection(USER, {
      provider: 'openai', baseUrl: 'https://evil.example', model: null, modelMeta: {}, authMethod: 'key', apiKey: PLAINTEXT,
    });
    const [custom, builtin] = mock.state.calls.map(
      (c) => c.ops.find(([n]) => n === 'upsert')![1][0] as Record<string, string | null>
    );
    expect(custom.base_url).toBe(base);
    expect(openSecret(custom.key_ciphertext!, { userId: USER, purpose: 'model-key', provider: 'custom', baseUrl: base }, ENV_KEY)).toBe(PLAINTEXT);
    expect(builtin.base_url).toBeNull();
    expect(openSecret(builtin.key_ciphertext!, { userId: USER, purpose: 'model-key', provider: 'openai', baseUrl: null }, ENV_KEY)).toBe(PLAINTEXT);
  });

  it('stores only known model_meta fields', async () => {
    answer(echo);
    await saveModelConnection(USER, {
      provider: 'openai', baseUrl: null, model: null,
      modelMeta: { effortLow: false, extra: 'x' } as never,
      authMethod: 'key', apiKey: PLAINTEXT,
    });
    const payload = mock.state.calls[0].ops.find(([n]) => n === 'upsert')![1][0] as Record<string, unknown>;
    expect(payload.model_meta).toEqual({ effortLow: false });
  });

  it.each([
    ['a model with a space', { model: 'Llama 3 8B' }, 'invalid_model'],
    ['a 201-char model', { model: 'm'.repeat(201) }, 'invalid_model'],
    ['custom without a base URL', { provider: 'custom' as const, baseUrl: null }, 'invalid_base_url'],
    ['oauth on a non-OpenRouter provider', { authMethod: 'oauth' as const }, 'invalid_auth_method'],
  ])('refuses %s before any request', async (_label, change, code) => {
    const err = await saveModelConnection(USER, {
      provider: 'openai', baseUrl: null, model: 'gpt-4o-mini', modelMeta: {}, authMethod: 'key', apiKey: PLAINTEXT,
      ...change,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AiDbError);
    expect((err as AiDbError).code).toBe(code);
    expect(mock.state.calls).toHaveLength(0);
  });

  it('allows oauth for OpenRouter', async () => {
    answer(echo);
    const saved = await saveModelConnection(USER, {
      provider: 'openrouter', baseUrl: null, model: 'openrouter/auto', modelMeta: {}, authMethod: 'oauth', apiKey: PLAINTEXT,
    });
    expect(saved.auth_method).toBe('oauth');
  });

  it('no env key → AiDbError no_key, with no request', async () => {
    delete process.env.MODEL_KEYS_ENCRYPTION_KEY;
    await expect(
      saveModelConnection(USER, { provider: 'openai', baseUrl: null, model: null, modelMeta: {}, authMethod: 'key', apiKey: PLAINTEXT })
    ).rejects.toMatchObject({ code: 'no_key' });
    expect(mock.state.calls).toHaveLength(0);
  });

  describe('DB errors (review 4)', () => {
    it('a CHECK failure leaves as AiDbError(23514) carrying nothing of the row', async () => {
      answer(() => ({
        data: null,
        error: {
          code: '23514',
          details: 'Failing row contains (u, openai, null, x, {}, key, v1:SENTINEL-iv:SENTINEL-tag:SENTINEL-ct, ok).',
          message: 'new row violates check constraint "model_connections_model_check" SENTINEL',
          hint: null,
        },
      }));
      const err = await saveModelConnection(USER, {
        provider: 'openai', baseUrl: null, model: 'gpt-4o-mini', modelMeta: {}, authMethod: 'key', apiKey: PLAINTEXT,
      }).catch((e) => e);

      expect(err).toBeInstanceOf(AiDbError);
      expect(err).toMatchObject({ op: 'save', code: '23514' });
      expect((err as Error).message).toBe('db save failed 23514');
      expect((err as Error).message).not.toContain('SENTINEL');
      expect((err as Error).cause).toBeUndefined();
      const own = Object.getOwnPropertyNames(err).map((k) => (err as unknown as Record<string, unknown>)[k]);
      expect(JSON.stringify(own)).not.toContain('SENTINEL');
      expect(String((err as Error).stack)).not.toContain('SENTINEL');
      expect(loggedText()).not.toContain('SENTINEL');
    });

    it('every other op wraps its error the same way', async () => {
      const bad = { code: '23502', details: 'Failing row contains (v1:SENTINEL)', message: 'SENTINEL', hint: 'SENTINEL' };
      answer(() => ({ data: null, error: bad }));
      const errs = await Promise.all([
        setConnectionModel(USER, 'openai', 'gpt-4o', {}).catch((e) => e),
        setConnectionStatus(USER, 'v1:a:b:c', 'failing', 'key_rejected').catch((e) => e),
        deleteModelConnection(USER).catch((e) => e),
        readOpenClawStatus(USER).catch((e) => e),
        readModelConnection(USER).catch((e) => e),
      ]);
      expect(errs.map((e) => [e instanceof AiDbError, e.op, e.code])).toEqual([
        [true, 'model', '23502'],
        [true, 'status', '23502'],
        [true, 'delete', '23502'],
        [true, 'openclaw', '23502'],
        [true, 'read', '23502'],
      ]);
      for (const e of errs) {
        expect(JSON.stringify(Object.getOwnPropertyNames(e).map((k) => e[k]))).not.toContain('SENTINEL');
      }
      expect(loggedText()).not.toContain('SENTINEL');
    });
  });
});

describe('setConnectionModel', () => {
  it('updates only the caller’s row for that provider', async () => {
    answer(() => ({ data: row({ model: 'gpt-4o' }), error: null }));
    const updated = await setConnectionModel(USER, 'openai', 'gpt-4o', { effortLow: true });
    expect(updated?.model).toBe('gpt-4o');
    const [call] = mock.state.calls;
    expect(call.ops).toContainEqual(['update', [{ model: 'gpt-4o', model_meta: { effortLow: true } }]]);
    expect(call.ops).toContainEqual(['eq', ['user_id', USER]]);
    expect(call.ops).toContainEqual(['eq', ['provider', 'openai']]);
  });

  it('returns null when no row matched', async () => {
    expect(await setConnectionModel(USER, 'gemini', 'gemini-flash-latest', {})).toBeNull();
  });

  it('refuses an invalid id before any request', async () => {
    await expect(setConnectionModel(USER, 'openai', 'gpt 4o', {})).rejects.toMatchObject({ code: 'invalid_model' });
    expect(mock.state.calls).toHaveLength(0);
  });
});

describe('setConnectionStatus', () => {
  /** 'v1:<iv>:<tag>:<ct>' split into the head that may travel and the parts that never may. */
  function partsOf(sealedKey: string) {
    const [v, iv, tag, ct] = sealedKey.split(':');
    return { head: `${v}:${iv}:`, iv, tag, ct };
  }

  it('is conditional on the seal the caller read (by its IV), so a newer key is never clobbered', async () => {
    answer(() => ({ data: [{ user_id: USER }], error: null }));
    const expected = sealed('openai', null);
    const changed = await setConnectionStatus(USER, expected, 'failing', 'key_rejected');
    expect(changed).toBe(true);
    const [call] = mock.state.calls;
    expect(call.ops).toContainEqual(['eq', ['user_id', USER]]);
    expect(call.ops).toContainEqual(['like', ['key_ciphertext', `${partsOf(expected).head}%`]]);
    const update = call.ops.find(([n]) => n === 'update')![1][0] as Record<string, unknown>;
    expect(update).toMatchObject({ status: 'failing', last_error: 'key_rejected' });
    expect(typeof update.checked_at).toBe('string');
  });

  it('never filters on the ciphertext: a filter is a URL query parameter, and request URLs are logged', async () => {
    answer(() => ({ data: [{ user_id: USER }], error: null }));
    const expected = sealed('custom', 'https://api.groq.com/openai/v1');
    const { tag, ct } = partsOf(expected);
    await setConnectionStatus(USER, expected, 'ok', null);
    const [call] = mock.state.calls;
    for (const [name, args] of call.ops) {
      if (name === 'update') continue; // the request body, which is not logged
      const text = JSON.stringify(args);
      expect(text).not.toContain(expected);
      expect(text).not.toContain(tag);
      expect(text).not.toContain(ct);
    }
  });

  it('two seals of the same key never share the filter, so a re-saved key is a newer key', () => {
    const a = partsOf(sealed('openai', null));
    const b = partsOf(sealed('openai', null));
    expect(a.head).not.toBe(b.head);
    // Standard base64 carries none of LIKE's metacharacters, so the head matches only itself.
    expect(a.head).toMatch(/^v1:[A-Za-z0-9+/=]+:$/);
  });

  it('a value off 053’s shape matches no row: false, and no request', async () => {
    for (const bad of ['', 'v1:a:b', 'v1:a:b:c:d', 'v1:a%:b:c', 'v1:a_:b:c', 'v1:a:b:c\n', 'x1:a:b:c']) {
      expect(await setConnectionStatus(USER, bad, 'failing', 'key_rejected')).toBe(false);
    }
    expect(mock.state.calls).toHaveLength(0);
  });

  it('reports false when the key changed underneath', async () => {
    answer(() => ({ data: [], error: null }));
    expect(await setConnectionStatus(USER, 'v1:old:ct:x', 'failing', 'key_rejected')).toBe(false);
  });

  it('ok clears the problem', async () => {
    answer(() => ({ data: [{ user_id: USER }], error: null }));
    await setConnectionStatus(USER, 'v1:x:y:z', 'ok', null);
    const update = mock.state.calls[0].ops.find(([n]) => n === 'update')![1][0] as Record<string, unknown>;
    expect(update).toMatchObject({ status: 'ok', last_error: null });
  });
});

describe('the sealed key never travels in a request URL', () => {
  /**
   * The real supabase-js, over a recording fetch: what PostgREST (and so
   * Supabase's API gateway logs) would actually see for every op that touches
   * model_connections. Only a request BODY may carry the ciphertext.
   */
  function recordingClient() {
    const requests: Array<{ method: string; url: string; body: string }> = [];
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? init.body : '';
      requests.push({ method, url, body });
      const answerBody = method === 'POST' ? body : method === 'PATCH' ? `[{"user_id":"${USER}"}]` : 'null';
      return new Response(answerBody, { status: 200, headers: { 'content-type': 'application/json' } });
    };
    mock.state.realClient = createClient('https://proj.supabase.co', 'service-role-key', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch },
    });
    return requests;
  }

  it('setConnectionStatus sends only the IV head in the URL, and the update fields in the body', async () => {
    const requests = recordingClient();
    // An IV with '+' or '/' in it, so the round trip through URL encoding is exercised.
    let expected = sealed('openai', null);
    for (let i = 0; i < 200 && !/[+/]/.test(expected.split(':')[1]); i++) expected = sealed('openai', null);
    const [, iv, tag, ct] = expected.split(':');
    expect(iv).toMatch(/[+/]/);

    expect(await setConnectionStatus(USER, expected, 'ok', null)).toBe(true);

    expect(requests).toHaveLength(1);
    const [req] = requests;
    expect(req.method).toBe('PATCH');
    const url = new URL(req.url);
    expect(url.pathname).toBe('/rest/v1/model_connections');
    expect(url.searchParams.get('user_id')).toBe(`eq.${USER}`);
    expect(url.searchParams.get('key_ciphertext')).toBe(`like.v1:${iv}:%`);
    for (const secret of [expected, tag, ct, encodeURIComponent(tag), encodeURIComponent(ct)]) {
      expect(req.url).not.toContain(secret);
      expect(decodeURIComponent(req.url)).not.toContain(secret);
    }
    expect(JSON.parse(req.body)).toEqual({ status: 'ok', last_error: null, checked_at: expect.any(String) });
  });

  it('no op on model_connections puts any part of the ciphertext past the IV in a URL', async () => {
    const requests = recordingClient();
    const stored = sealed('openai', null);

    await readModelConnection(USER).catch(() => {});
    await openModelConnection(USER).catch(() => {});
    await saveModelConnection(USER, {
      provider: 'openai', baseUrl: null, model: 'gpt-4o-mini', modelMeta: {}, authMethod: 'key', apiKey: PLAINTEXT,
    }).catch(() => {});
    await setConnectionModel(USER, 'openai', 'gpt-4o', {}).catch(() => {});
    await setConnectionStatus(USER, stored, 'failing', 'key_rejected');
    await deleteModelConnection(USER).catch(() => {});

    expect(requests.map((r) => r.method)).toEqual(['GET', 'GET', 'POST', 'PATCH', 'PATCH', 'DELETE']);
    // The upsert's own ciphertext, sealed inside saveModelConnection, rides in its body.
    const savedCt = (JSON.parse(requests[2].body) as Record<string, string>).key_ciphertext;
    expect(savedCt).toMatch(/^v1:/);
    for (const sealedKey of [stored, savedCt]) {
      const [, , tag, ct] = sealedKey.split(':');
      for (const r of requests) {
        const url = decodeURIComponent(r.url);
        expect(url).not.toContain(tag);
        expect(url).not.toContain(ct);
        expect(url).not.toContain(PLAINTEXT);
      }
    }
  });
});

describe('deleteModelConnection', () => {
  it('deletes the caller’s row and is idempotent', async () => {
    await deleteModelConnection(USER);
    expect(mock.state.calls[0].ops).toEqual([['delete', []], ['eq', ['user_id', USER]]]);
    answer(() => ({ data: null, error: { code: '42P01' } }));
    await expect(deleteModelConnection(USER)).resolves.toBeUndefined();
  });
});

describe('readOpenClawStatus', () => {
  function respondWith(settings: Record<string, unknown> | null, secrets: Record<string, unknown> | null, errors: { settings?: unknown; secrets?: unknown } = {}) {
    answer((call) =>
      call.table === 'user_settings'
        ? { data: settings, error: errors.settings ?? null }
        : { data: secrets, error: errors.secrets ?? null }
    );
  }

  it('reports booleans and the agent id, never a key or URL', async () => {
    respondWith(
      { openclaw_gateway_url: 'https://gw.example', openclaw_agent_id: 'kirby-1', openclaw_api_key: 'dsul_SENTINEL', openclaw_chat_url: 'https://gw.example/chat' },
      { openclaw_gateway_token: 'tok_SENTINEL' }
    );
    const status = await readOpenClawStatus(USER);
    expect(status).toEqual({ gateway: true, pluginChat: true, agent: true, agentId: 'kirby-1' });
    expect(JSON.stringify(status)).not.toContain('SENTINEL');
    expect(mock.state.calls.map((c) => c.table).sort()).toEqual(['user_secrets', 'user_settings']);
    for (const c of mock.state.calls) expect(c.ops).toContainEqual(['eq', ['user_id', USER]]);
  });

  it('a gateway needs both the URL and the token; plugin chat needs both the key and the chat URL', async () => {
    respondWith({ openclaw_gateway_url: 'https://gw.example', openclaw_api_key: 'k', openclaw_chat_url: '' }, null);
    expect(await readOpenClawStatus(USER)).toEqual({ gateway: false, pluginChat: false, agent: true, agentId: null });
    respondWith(null, { openclaw_gateway_token: 'tok' });
    expect(await readOpenClawStatus(USER)).toEqual({ gateway: false, pluginChat: false, agent: false, agentId: null });
  });

  it('missing schema → all false', async () => {
    respondWith(null, null, { settings: { code: '42703' }, secrets: { code: '42P01' } });
    expect(await readOpenClawStatus(USER)).toEqual({ gateway: false, pluginChat: false, agent: false, agentId: null });
  });

  it('another error throws', async () => {
    respondWith({ openclaw_api_key: 'k' }, null, { secrets: { code: 'PGRST301' } });
    await expect(readOpenClawStatus(USER)).rejects.toMatchObject({ op: 'openclaw', code: 'PGRST301' });
  });
});
