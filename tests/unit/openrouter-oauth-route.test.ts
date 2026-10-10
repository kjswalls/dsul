// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as start from '@/app/api/ai/openrouter/start/route';
import * as callback from '@/app/api/ai/openrouter/callback/[state]/route';
import * as pkce from '@/lib/ai-server/pkce';
import * as box from '@/lib/ai-server/secret-box';
import {
  AiDbError,
  readModelConnection,
  saveModelConnection,
  setConnectionLimit,
  type ModelConnectionRow,
} from '@/lib/ai-server/connections';
import { ProviderError, type ProviderErrorKind } from '@/lib/ai-server/errors';
import { CONNECT_FLOWS } from '@/lib/connect-flow';
import { takeSharedToken } from '@/lib/ai-server/rate-limit';

/**
 * "Sign in with OpenRouter": GET /api/ai/openrouter/start and
 * GET /api/ai/openrouter/callback/[state].
 *
 * Most cases stand pkce.ts and secret-box.ts in with a simple reference
 * implementation, to pin the ROUTES' order and answers. The STATE cases run
 * the real modules (U1's): mocking `pkceStateMatches` would test nothing, so
 * those exercise the real seal, the real cookie and the real comparison. Until
 * U1 lands they fail with `not implemented: <name>` and nothing else.
 */

const h = vi.hoisted(() => ({ user: { id: 'user-1' } as { id: string } | null }));
const real = vi.hoisted(() => ({
  pkce: null as null | typeof import('@/lib/ai-server/pkce'),
  box: null as null | typeof import('@/lib/ai-server/secret-box'),
}));

vi.mock('@/lib/supabase-server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: h.user }, error: h.user ? null : { message: 'no' } })) },
  })),
}));

// Real by default (vi.fn(actual)); the mocked cases install their own below.
vi.mock('@/lib/ai-server/secret-box', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai-server/secret-box')>();
  real.box = actual;
  return {
    ...actual,
    loadEncryptionKey: vi.fn(actual.loadEncryptionKey),
    sealSecret: vi.fn(actual.sealSecret),
    openSecret: vi.fn(actual.openSecret),
  };
});
vi.mock('@/lib/ai-server/pkce', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai-server/pkce')>();
  real.pkce = actual;
  return {
    ...actual,
    createPkcePair: vi.fn(actual.createPkcePair),
    sealPkceCookie: vi.fn(actual.sealPkceCookie),
    openPkceCookie: vi.fn(actual.openPkceCookie),
    pkceStateMatches: vi.fn(actual.pkceStateMatches),
    openRouterCallbackUrl: vi.fn(actual.openRouterCallbackUrl),
    openRouterAuthUrl: vi.fn(actual.openRouterAuthUrl),
    // Never real here: no network in unit tests.
    exchangeOpenRouterCode: vi.fn(),
  };
});

vi.mock('@/lib/ai-server/connections', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai-server/connections')>();
  return {
    ...actual,
    readModelConnection: vi.fn(),
    saveModelConnection: vi.fn(),
    setConnectionLimit: vi.fn(),
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
vi.mock('@/lib/ai-server/rate-limit', () => ({
  takeToken: vi.fn(() => true),
  takeSharedToken: vi.fn(async () => true),
}));

const adapter = vi.hoisted(() => ({
  verify: vi.fn(),
  listModels: vi.fn(),
  ping: vi.fn(),
  pickDefaultModel: vi.fn(),
}));
vi.mock('@/lib/ai-server/providers', () => ({
  getAdapter: vi.fn(() => adapter),
  credentialsFor: vi.fn((provider: string, _baseUrl: string | null, apiKey: string) => ({
    provider,
    apiKey,
    baseUrl: 'https://openrouter.ai/api/v1',
  })),
}));

// The real modules, captured by the factories below for the state cases.
const realPkce = real.pkce!;
const realBox = real.box!;

const ORIGIN = 'https://do.dsul.app';
const SETTINGS = `${ORIGIN}/settings/ai`;
const KEY = Buffer.alloc(32, 9);
const ENV_KEY = KEY.toString('base64');

// The mocked flow's fixed values.
const VERIFIER = 'v'.repeat(43);
const CHALLENGE = 'c'.repeat(43);
const STATE = 'S'.repeat(22);
const SEALED = 'v1:sealed-for-user-1';
const CODE = 'or-code-abcdef123456';
const SAVED_CIPHER = 'v1:saved-iv:saved-tag:saved-ct';
/** Where the sealed cookie says the sign-in came from, for the mocked cases. */
const RETURN: { value: 'settings' | 'home' } = { value: 'settings' };

function startReq(headers: Record<string, string> = {}, origin = ORIGIN, query = '') {
  return start.GET(new Request(`${origin}/api/ai/openrouter/start${query}`, { headers }));
}
function callbackReq(
  state: string,
  query: string,
  cookie: string | null = `dsul_or_pkce=${encodeURIComponent(SEALED)}`,
  origin = ORIGIN
) {
  return callback.GET(
    new Request(`${origin}/api/ai/openrouter/callback/${state}${query}`, {
      headers: cookie ? { cookie } : {},
    }),
    { params: Promise.resolve({ state }) }
  );
}

const setCookie = (res: Response) => res.headers.get('set-cookie') ?? '';
function cookieValue(res: Response): string {
  const m = /^dsul_or_pkce=([^;]*)/.exec(setCookie(res));
  return m ? decodeURIComponent(m[1]) : '';
}
function expectCleared(res: Response, secure = true) {
  const c = setCookie(res);
  expect(c).toMatch(/^dsul_or_pkce=;/);
  expect(c).toContain('Path=/api/ai/openrouter');
  expect(c).toContain('Max-Age=0');
  expect(c).toContain('HttpOnly');
  expect(c.includes('Secure')).toBe(secure);
}
function expectHeaders(res: Response) {
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('cache-control')).toBe('no-store');
}

/** The simple stand-ins for the mocked cases. */
function useMockedPkce() {
  vi.mocked(box.loadEncryptionKey).mockReset();
  vi.mocked(box.loadEncryptionKey).mockReturnValue({ ok: true, key: KEY });
  vi.mocked(pkce.createPkcePair).mockReset();
  vi.mocked(pkce.createPkcePair).mockReturnValue({ verifier: VERIFIER, challenge: CHALLENGE, state: STATE });
  vi.mocked(pkce.sealPkceCookie).mockReset();
  vi.mocked(pkce.sealPkceCookie).mockReturnValue(SEALED);
  vi.mocked(pkce.openPkceCookie).mockReset();
  vi.mocked(pkce.openPkceCookie).mockImplementation((raw, userId) =>
    raw === SEALED && userId === 'user-1' ? { verifier: VERIFIER, state: STATE, r: RETURN.value } : null
  );
  vi.mocked(pkce.pkceStateMatches).mockReset();
  vi.mocked(pkce.pkceStateMatches).mockImplementation((expected, got) => typeof got === 'string' && got === expected);
  vi.mocked(pkce.openRouterCallbackUrl).mockReset();
  vi.mocked(pkce.openRouterCallbackUrl).mockImplementation(
    (origin, state) => `${origin}/api/ai/openrouter/callback/${state}`
  );
  vi.mocked(pkce.openRouterAuthUrl).mockReset();
  vi.mocked(pkce.openRouterAuthUrl).mockImplementation(
    (cb, challenge) =>
      `https://openrouter.ai/auth?callback_url=${encodeURIComponent(cb)}&code_challenge=${challenge}&code_challenge_method=S256`
  );
}

/** The real U1 modules, behind a valid env key. */
function useRealPkce() {
  process.env.MODEL_KEYS_ENCRYPTION_KEY = ENV_KEY;
  vi.mocked(box.loadEncryptionKey).mockReset();
  vi.mocked(box.loadEncryptionKey).mockImplementation(realBox.loadEncryptionKey);
  for (const name of [
    'createPkcePair',
    'sealPkceCookie',
    'openPkceCookie',
    'pkceStateMatches',
    'openRouterCallbackUrl',
    'openRouterAuthUrl',
  ] as const) {
    const fn = vi.mocked(pkce[name]) as unknown as { mockReset(): void; mockImplementation(f: unknown): void };
    fn.mockReset();
    fn.mockImplementation(realPkce[name]);
  }
}

const ENV_BEFORE = process.env.MODEL_KEYS_ENCRYPTION_KEY;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.user = { id: 'user-1' };
  useMockedPkce();
  vi.mocked(pkce.exchangeOpenRouterCode).mockReset();
  vi.mocked(pkce.exchangeOpenRouterCode).mockResolvedValue('sk-or-v1-SENTINEL-issued');
  vi.mocked(takeSharedToken).mockReset();
  vi.mocked(takeSharedToken).mockResolvedValue(true);
  vi.mocked(readModelConnection).mockReset();
  vi.mocked(readModelConnection).mockResolvedValue({ kind: 'none' });
  vi.mocked(saveModelConnection).mockReset();
  // The saved row's ciphertext is what a limit is written against.
  vi.mocked(saveModelConnection).mockResolvedValue({ key_ciphertext: SAVED_CIPHER } as never);
  vi.mocked(setConnectionLimit).mockReset();
  vi.mocked(setConnectionLimit).mockResolvedValue(true);
  RETURN.value = 'settings';
  adapter.ping.mockReset();
  adapter.ping.mockResolvedValue(undefined);
  adapter.verify.mockReset();
  adapter.verify.mockResolvedValue({ models: [], listed: false, freeTier: true });
  adapter.listModels.mockReset();
  adapter.listModels.mockResolvedValue({
    models: [{ id: 'meta-llama/llama-3:free', label: 'Llama 3 (free)', free: true }],
    listed: true,
  });
  adapter.pickDefaultModel.mockReset();
  adapter.pickDefaultModel.mockReturnValue('meta-llama/llama-3:free');
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in unit tests'));
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ENV_BEFORE === undefined) delete process.env.MODEL_KEYS_ENCRYPTION_KEY;
  else process.env.MODEL_KEYS_ENCRYPTION_KEY = ENV_BEFORE;
});

// ── /start ───────────────────────────────────────────────────────────────────

describe('GET /api/ai/openrouter/start', () => {
  it('arms a sealed, HttpOnly, path-scoped cookie and sends the browser to OpenRouter with S256', async () => {
    const res = await startReq({ 'sec-fetch-site': 'same-origin' });
    expect(res.status).toBe(302);
    expectHeaders(res);
    const c = setCookie(res);
    expect(c).toMatch(/^dsul_or_pkce=/);
    expect(c).toContain('Path=/api/ai/openrouter');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Max-Age=600');
    expect(c).toContain('Secure');
    expect(cookieValue(res)).toBe(SEALED);
    expect(pkce.sealPkceCookie).toHaveBeenCalledWith({ verifier: VERIFIER, state: STATE, r: 'settings' }, 'user-1', KEY);

    const loc = new URL(res.headers.get('location') ?? '');
    expect(loc.origin).toBe('https://openrouter.ai');
    expect(loc.pathname).toBe('/auth');
    expect(loc.searchParams.get('callback_url')).toBe(`${ORIGIN}/api/ai/openrouter/callback/${STATE}`);
    expect(loc.searchParams.get('code_challenge')).toBe(CHALLENGE);
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(res.headers.get('location')).not.toContain(VERIFIER);
  });

  it('returns to the host the flow started on, and drops Secure on plain http', async () => {
    const res = await startReq({}, 'http://localhost:3000');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') ?? '');
    expect(loc.searchParams.get('callback_url')).toBe(`http://localhost:3000/api/ai/openrouter/callback/${STATE}`);
    expect(setCookie(res)).not.toContain('Secure');
  });

  it.each([['same-origin'], ['none'], [null]])('Sec-Fetch-Site %s arms the cookie', async (site) => {
    const res = await startReq(site ? { 'sec-fetch-site': site } : {});
    expect(res.status).toBe(302);
    expect(cookieValue(res)).toBe(SEALED);
  });

  it.each([['cross-site'], ['same-site']])(
    'a %s start is refused: 303 ?connect=failed and NO cookie',
    async (site) => {
      const res = await startReq({ 'sec-fetch-site': site });
      expect(res.status).toBe(303);
      expectHeaders(res);
      expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=failed`);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(pkce.createPkcePair).not.toHaveBeenCalled();
    }
  );

  it('no session → 303 /login, no cookie', async () => {
    h.user = null;
    const res = await startReq();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/login?redirect=%2Fsettings%2Fai`);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('no encryption key → ?connect=unavailable, no cookie', async () => {
    vi.mocked(box.loadEncryptionKey).mockReturnValue({ ok: false, reason: 'missing' });
    const res = await startReq();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=unavailable`);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('?r=home seals home, so the callback can come back there', async () => {
    const res = await startReq({}, ORIGIN, '?r=home');
    expect(res.status).toBe(302);
    expect(pkce.sealPkceCookie).toHaveBeenCalledWith(
      { verifier: VERIFIER, state: STATE, r: 'home' },
      'user-1',
      KEY
    );
    // `r` rides inside the seal, never in the callback URL.
    expect(res.headers.get('location')).not.toContain('home');
  });

  it('?r=settings is the same as no `r` at all', async () => {
    await startReq({}, ORIGIN, '?r=settings');
    expect(pkce.sealPkceCookie).toHaveBeenCalledWith(
      { verifier: VERIFIER, state: STATE, r: 'settings' },
      'user-1',
      KEY
    );
  });

  it.each([['evil'], ['https://evil.example'], ['HOME'], ['']])(
    'an `r` this build does not know (%s) arms nothing and says so on the pane',
    async (r) => {
      const res = await startReq({}, ORIGIN, `?r=${encodeURIComponent(r)}`);
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=failed`);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(pkce.createPkcePair).not.toHaveBeenCalled();
    }
  );

  it('no session still sends the sign-in to the pane, whatever `r` said', async () => {
    h.user = null;
    const res = await startReq({}, ORIGIN, '?r=home');
    expect(res.headers.get('location')).toBe(`${ORIGIN}/login?redirect=%2Fsettings%2Fai`);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

// ── /callback/[state] (mocked pkce) ──────────────────────────────────────────

describe('GET /api/ai/openrouter/callback/[state]', () => {
  it('the happy path exchanges, verifies, stores an oauth connection, and lands ?connect=ok', async () => {
    const res = await callbackReq(STATE, `?code=${CODE}`);
    expect(res.status).toBe(303);
    expectHeaders(res);
    expectCleared(res);
    expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=ok`);
    expect(pkce.exchangeOpenRouterCode).toHaveBeenCalledWith(CODE, VERIFIER, expect.any(AbortSignal));
    expect(takeSharedToken).toHaveBeenCalledWith('user-1', 'connect');
    expect(adapter.pickDefaultModel).toHaveBeenCalledWith({
      models: [{ id: 'meta-llama/llama-3:free', label: 'Llama 3 (free)', free: true }],
      listed: true,
      freeTier: true,
    });
    expect(saveModelConnection).toHaveBeenCalledWith('user-1', {
      provider: 'openrouter',
      baseUrl: null,
      model: 'meta-llama/llama-3:free',
      modelMeta: { label: 'Llama 3 (free)' },
      authMethod: 'oauth',
      apiKey: 'sk-or-v1-SENTINEL-issued',
    });
    const all = JSON.stringify([...res.headers.entries()]) + (await res.text());
    expect(all).not.toContain('SENTINEL');
  });

  it('asks the model it is about to save, and records no limit when it answered', async () => {
    await callbackReq(STATE, `?code=${CODE}`);
    expect(adapter.ping).toHaveBeenCalledTimes(1);
    const [creds, model, signal] = adapter.ping.mock.calls[0];
    expect(creds).toMatchObject({ provider: 'openrouter', apiKey: 'sk-or-v1-SENTINEL-issued' });
    expect(model).toBe('meta-llama/llama-3:free');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(vi.mocked(saveModelConnection).mock.calls[0][1].model).toBe(model);
    expect(setConnectionLimit).not.toHaveBeenCalled();
  });

  it('drops a catalog name that only repeats the id', async () => {
    adapter.listModels.mockResolvedValue({
      models: [{ id: 'meta-llama/llama-3:free', label: 'meta-llama/llama-3:free', free: true }],
      listed: true,
    });
    await callbackReq(STATE, `?code=${CODE}`);
    expect(saveModelConnection).toHaveBeenCalledWith('user-1', expect.objectContaining({ modelMeta: {} }));
  });

  it('no session → /login, cookie cleared, nothing exchanged', async () => {
    h.user = null;
    const res = await callbackReq(STATE, `?code=${CODE}`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/login?redirect=%2Fsettings%2Fai`);
    expectCleared(res);
    expect(pkce.exchangeOpenRouterCode).not.toHaveBeenCalled();
  });

  it('no encryption key → unavailable', async () => {
    vi.mocked(box.loadEncryptionKey).mockReturnValue({ ok: false, reason: 'invalid' });
    const res = await callbackReq(STATE, `?code=${CODE}`);
    expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=unavailable`);
    expectCleared(res);
  });

  it.each([
    ['no cookie', null],
    ['a cookie for another flow', 'dsul_or_pkce=v1%3Aother'],
    ['a malformed cookie header', 'dsul_or_pkce=%E0%A4%A'],
  ])('%s → expired, cleared, no exchange and no fetch', async (_label, cookie) => {
    const res = await callbackReq(STATE, `?code=${CODE}`, cookie);
    expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=expired`);
    expectCleared(res);
    expect(pkce.exchangeOpenRouterCode).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a cookie that opens only for another user → expired', async () => {
    h.user = { id: 'user-2' };
    const res = await callbackReq(STATE, `?code=${CODE}`);
    expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=expired`);
    expectCleared(res);
    expect(pkce.openPkceCookie).toHaveBeenCalledWith(SEALED, 'user-2', KEY);
  });

  it('?error= with the right state → denied; no code → denied', async () => {
    let res = await callbackReq(STATE, '?error=access_denied');
    expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=denied`);
    expectCleared(res);
    res = await callbackReq(STATE, '');
    expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=denied`);
    expectCleared(res);
    expect(pkce.exchangeOpenRouterCode).not.toHaveBeenCalled();
  });

  it.each([['short'], ['has space here'], ['semi;colon-abcdef'], ['x'.repeat(513)]])(
    'a malformed code (%s) → failed, never sent anywhere',
    async (code) => {
      const res = await callbackReq(STATE, `?code=${encodeURIComponent(code)}`);
      expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=failed`);
      expectCleared(res);
      expect(pkce.exchangeOpenRouterCode).not.toHaveBeenCalled();
    }
  );

  it('the connect limiter → busy, no exchange', async () => {
    vi.mocked(takeSharedToken).mockResolvedValue(false);
    const res = await callbackReq(STATE, `?code=${CODE}`);
    expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=busy`);
    expectCleared(res);
    expect(pkce.exchangeOpenRouterCode).not.toHaveBeenCalled();
  });

  it('an exchange failure → failed, nothing stored', async () => {
    vi.mocked(pkce.exchangeOpenRouterCode).mockRejectedValue(new ProviderError('auth', 403));
    const res = await callbackReq(STATE, `?code=${CODE}`);
    expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=failed`);
    expectCleared(res);
    expect(saveModelConnection).not.toHaveBeenCalled();
  });

  it.each([['auth'], ['network']] as const)('a %s verify of the issued key → failed, nothing stored', async (kind) => {
    adapter.verify.mockRejectedValue(new ProviderError(kind as ProviderErrorKind));
    const res = await callbackReq(STATE, `?code=${CODE}`);
    expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=failed`);
    expectCleared(res);
    expect(saveModelConnection).not.toHaveBeenCalled();
  });

  describe('what the test question said, and where it lands', () => {
    // An issued key has no box to stay in: a second try mints another key on
    // the account. So once OpenRouter's own key check has passed, the key is
    // kept whatever the test question said, and the landing says what happened.
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('a daily limit is saved, then recorded, in that order', async () => {
      const at = '2026-10-08T07:00:00.000Z';
      adapter.ping.mockRejectedValue(new ProviderError('daily_limit', 429, at));
      const res = await callbackReq(STATE, `?code=${CODE}`);
      expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=daily_limit`);
      expect(saveModelConnection).toHaveBeenCalledTimes(1);
      // Against the ciphertext the save just wrote: the limit belongs to THIS key.
      expect(setConnectionLimit).toHaveBeenCalledWith('user-1', SAVED_CIPHER, at);
      expect(vi.mocked(setConnectionLimit).mock.invocationCallOrder[0]).toBeGreaterThan(
        vi.mocked(saveModelConnection).mock.invocationCallOrder[0]
      );
    });

    it('a daily limit with no reset time known still lands there', async () => {
      adapter.ping.mockRejectedValue(new ProviderError('daily_limit', 429));
      const res = await callbackReq(STATE, `?code=${CODE}`);
      expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=daily_limit`);
      expect(setConnectionLimit).toHaveBeenCalledWith('user-1', SAVED_CIPHER, null);
    });

    it('a database that cannot record the limit still keeps the key', async () => {
      adapter.ping.mockRejectedValue(new ProviderError('daily_limit', 429));
      vi.mocked(setConnectionLimit).mockRejectedValue(new AiDbError('limit', '42703'));
      const res = await callbackReq(STATE, `?code=${CODE}`);
      expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=daily_limit`);
      expect(saveModelConnection).toHaveBeenCalledTimes(1);
    });

    it('no credit is saved and says so', async () => {
      adapter.ping.mockRejectedValue(new ProviderError('quota', 402));
      const res = await callbackReq(STATE, `?code=${CODE}`);
      expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=no_credit`);
      expect(saveModelConnection).toHaveBeenCalledTimes(1);
      expect(setConnectionLimit).not.toHaveBeenCalled();
    });

    it.each([['rate_limit'], ['upstream'], ['region']] as const)(
      'a %s answer is saved, and lands on saved rather than ok',
      async (kind) => {
        adapter.ping.mockRejectedValue(new ProviderError(kind as ProviderErrorKind));
        const res = await callbackReq(STATE, `?code=${CODE}`);
        expect(saveModelConnection).toHaveBeenCalledTimes(1);
        // 'ok' would claim a model answered.
        expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=saved`);
      }
    );

    it.each([['bad_model'], ['bad_request'], ['forbidden']] as const)(
      'a %s answer passes the check and lands on ok: the key answered, the model is the picker’s business',
      async (kind) => {
        adapter.ping.mockRejectedValue(new ProviderError(kind as ProviderErrorKind));
        const res = await callbackReq(STATE, `?code=${CODE}`);
        expect(saveModelConnection).toHaveBeenCalledTimes(1);
        expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=ok`);
      }
    );

    it.each([['auth'], ['aborted']] as const)('a %s answer saves nothing', async (kind) => {
      adapter.ping.mockRejectedValue(new ProviderError(kind as ProviderErrorKind));
      const res = await callbackReq(STATE, `?code=${CODE}`);
      expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=failed`);
      expectCleared(res);
      expect(saveModelConnection).not.toHaveBeenCalled();
      expect(setConnectionLimit).not.toHaveBeenCalled();
    });
  });

  describe('where the sign-in came from', () => {
    it('a sign-in from home comes back to home', async () => {
      RETURN.value = 'home';
      const res = await callbackReq(STATE, `?code=${CODE}`);
      expect(res.headers.get('location')).toBe(`${ORIGIN}/?connect=ok`);
      expectCleared(res);
    });

    it('a failure from home lands on home too, once the cookie has opened', async () => {
      RETURN.value = 'home';
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(pkce.exchangeOpenRouterCode).mockRejectedValue(new ProviderError('auth', 403));
      const res = await callbackReq(STATE, `?code=${CODE}`);
      expect(res.headers.get('location')).toBe(`${ORIGIN}/?connect=failed`);
    });

    it('an exit before the cookie opens cannot know, and lands on the pane', async () => {
      RETURN.value = 'home';
      const res = await callbackReq(STATE, `?code=${CODE}`, null);
      expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=expired`);
    });
  });

  it('a save failure → failed, logged as op + code only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(saveModelConnection).mockRejectedValue(new AiDbError('save', '23514'));
    const res = await callbackReq(STATE, `?code=${CODE}`);
    expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=failed`);
    expectCleared(res);
    expect(warn).toHaveBeenCalledWith('[ai] db', 'save', 'failed', '23514');
  });

  describe('signing in again keeps the model the user picked', () => {
    function orRow(o: Partial<ModelConnectionRow> = {}): ModelConnectionRow {
      return {
        user_id: 'user-1',
        provider: 'openrouter',
        base_url: null,
        model: 'anthropic/claude-sonnet-4',
        model_meta: {},
        auth_method: 'oauth',
        key_ciphertext: 'v1:old',
        status: 'failing',
        last_error: 'key_rejected',
        checked_at: null,
        limited_until: null,
        ...o,
      };
    }
    const CATALOG = [
      { id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4' },
      { id: 'meta-llama/llama-3:free', label: 'Llama 3 (free)', free: true },
    ];
    const savedModel = () => vi.mocked(saveModelConnection).mock.calls[0]?.[1].model;

    beforeEach(() => {
      adapter.verify.mockResolvedValue({ models: [], listed: false, freeTier: false });
      adapter.listModels.mockResolvedValue({ models: CATALOG, listed: true });
      adapter.pickDefaultModel.mockReturnValue('openrouter/auto');
    });

    it('a failing OpenRouter row whose model is still listed keeps it, not the default', async () => {
      vi.mocked(readModelConnection).mockResolvedValue({ kind: 'row', row: orRow() });
      const res = await callbackReq(STATE, `?code=${CODE}`);
      expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=ok`);
      expect(readModelConnection).toHaveBeenCalledWith('user-1');
      expect(savedModel()).toBe('anthropic/claude-sonnet-4');
      expect(saveModelConnection).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ provider: 'openrouter', authMethod: 'oauth', model: 'anthropic/claude-sonnet-4' })
      );
    });

    it('a pasted OpenRouter key replaced by a sign-in keeps its model too', async () => {
      vi.mocked(readModelConnection).mockResolvedValue({ kind: 'row', row: orRow({ auth_method: 'key', status: 'ok' }) });
      await callbackReq(STATE, `?code=${CODE}`);
      expect(savedModel()).toBe('anthropic/claude-sonnet-4');
    });

    it.each([
      ['no row', { kind: 'none' } as const],
      ['another provider’s row', { kind: 'row', row: orRow({ provider: 'openai', model: 'anthropic/claude-sonnet-4' }) } as const],
      ['an OpenRouter row with no model yet', { kind: 'row', row: orRow({ model: null }) } as const],
      ['an OpenRouter row whose model left the catalog', { kind: 'row', row: orRow({ model: 'gone/retired-model' }) } as const],
    ])('%s → the default', async (_label, read) => {
      vi.mocked(readModelConnection).mockResolvedValue(read);
      await callbackReq(STATE, `?code=${CODE}`);
      expect(savedModel()).toBe('openrouter/auto');
    });

    it('a free-tier key keeps a free pick but not a paid one, which could only fail there', async () => {
      adapter.verify.mockResolvedValue({ models: [], listed: false, freeTier: true });
      adapter.pickDefaultModel.mockReturnValue('meta-llama/llama-3:free');

      vi.mocked(readModelConnection).mockResolvedValue({ kind: 'row', row: orRow() });
      await callbackReq(STATE, `?code=${CODE}`);
      expect(savedModel()).toBe('meta-llama/llama-3:free');
      expect(adapter.pickDefaultModel).toHaveBeenCalledWith({ models: CATALOG, listed: true, freeTier: true });

      vi.mocked(saveModelConnection).mockClear();
      adapter.listModels.mockResolvedValue({
        models: [...CATALOG, { id: 'qwen/qwen-2:free', label: 'Qwen 2 (free)', free: true }],
        listed: true,
      });
      vi.mocked(readModelConnection).mockResolvedValue({ kind: 'row', row: orRow({ model: 'qwen/qwen-2:free' }) });
      await callbackReq(STATE, `?code=${CODE}`);
      expect(savedModel()).toBe('qwen/qwen-2:free');
    });
  });

  it('no table yet → unavailable, read before any key is minted', async () => {
    vi.mocked(readModelConnection).mockResolvedValue({ kind: 'unavailable', reason: 'no_table' });
    const res = await callbackReq(STATE, `?code=${CODE}`);
    expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=unavailable`);
    expectCleared(res);
    expect(takeSharedToken).not.toHaveBeenCalled();
    expect(pkce.exchangeOpenRouterCode).not.toHaveBeenCalled();
    expect(saveModelConnection).not.toHaveBeenCalled();
  });

  it('a failed read → failed, logged as op + code only, no key minted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(readModelConnection).mockRejectedValue(new AiDbError('read', 'PGRST301'));
    const res = await callbackReq(STATE, `?code=${CODE}`);
    expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=failed`);
    expectCleared(res);
    expect(warn).toHaveBeenCalledWith('[ai] db', 'read', 'failed', 'PGRST301');
    expect(pkce.exchangeOpenRouterCode).not.toHaveBeenCalled();
    expect(saveModelConnection).not.toHaveBeenCalled();
  });

  it('a denied or malformed callback never reads the database', async () => {
    await callbackReq(STATE, '?error=access_denied');
    await callbackReq(STATE, '?code=short');
    await callbackReq('A'.repeat(22), `?code=${CODE}`);
    expect(readModelConnection).not.toHaveBeenCalled();
  });

  it('every `?connect=` either route sends is a flow the landing has words for', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen = new Set<string>();
    const note = (res: Response) => {
      const value = new URL(res.headers.get('location') ?? '').searchParams.get('connect');
      if (value !== null) seen.add(value);
    };
    // One of each exit that carries a result.
    note(await startReq({ 'sec-fetch-site': 'cross-site' }));
    vi.mocked(box.loadEncryptionKey).mockReturnValueOnce({ ok: false, reason: 'missing' });
    note(await startReq());
    note(await callbackReq(STATE, `?code=${CODE}`));
    note(await callbackReq(STATE, `?code=${CODE}`, null));
    note(await callbackReq(STATE, '?error=access_denied'));
    note(await callbackReq(STATE, '?code=short'));
    vi.mocked(takeSharedToken).mockResolvedValueOnce(false);
    note(await callbackReq(STATE, `?code=${CODE}`));
    vi.mocked(readModelConnection).mockResolvedValueOnce({ kind: 'unavailable', reason: 'no_table' });
    note(await callbackReq(STATE, `?code=${CODE}`));
    adapter.ping.mockRejectedValueOnce(new ProviderError('daily_limit', 429));
    note(await callbackReq(STATE, `?code=${CODE}`));
    adapter.ping.mockRejectedValueOnce(new ProviderError('quota', 402));
    note(await callbackReq(STATE, `?code=${CODE}`));
    // A kind the check does not retry and does not forgive: saved, not ok.
    adapter.ping.mockRejectedValue(new ProviderError('region', 403));
    note(await callbackReq(STATE, `?code=${CODE}`));

    expect(seen.size).toBeGreaterThan(8);
    for (const value of seen) expect(CONNECT_FLOWS).toContain(value);
  });

  it('clears without Secure on plain http', async () => {
    const res = await callbackReq(STATE, `?code=${CODE}`, `dsul_or_pkce=${encodeURIComponent(SEALED)}`, 'http://localhost:3000');
    expect(res.headers.get('location')).toBe('http://localhost:3000/settings/ai?connect=ok');
    expectCleared(res, false);
  });
});

// ── state binding, on the REAL pkce.ts + secret-box (cross-unit: U1) ─────────

describe('state binding (real pkce.ts + secret-box)', () => {
  beforeEach(() => {
    useRealPkce();
    // Pre-U1 these throw `not implemented: <name>`, which is the only failure allowed.
    expect(realBox.loadEncryptionKey().ok).toBe(true);
    realPkce.createPkcePair();
  });

  /** A real /start, returning the cookie header and the state from the callback PATH. */
  async function realStart(headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }) {
    const res = await startReq(headers);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') ?? '');
    const cb = loc.searchParams.get('callback_url') ?? '';
    const m = /^https:\/\/do\.dsul\.app\/api\/ai\/openrouter\/callback\/([A-Za-z0-9_-]+)$/.exec(cb);
    expect(m).not.toBeNull();
    return {
      res,
      loc,
      state: m![1],
      sealed: cookieValue(res),
      cookie: `dsul_or_pkce=${encodeURIComponent(cookieValue(res))}`,
    };
  }

  it('/start puts the state in the callback PATH and seals the same state in the cookie, with S256', async () => {
    const { loc, state, sealed } = await realStart();
    expect(state).toMatch(realPkce.PKCE_STATE_RE);
    const flow = realPkce.openPkceCookie(sealed, 'user-1', KEY);
    expect(flow).not.toBeNull();
    expect(flow!.state).toBe(state);
    expect(flow!.verifier).toHaveLength(43);
    expect(flow!.r).toBe('settings');
    expect(loc.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(flow!.verifier).digest('base64url')
    );
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('two starts mint two different states', async () => {
    const a = await realStart();
    const b = await realStart();
    expect(a.state).not.toBe(b.state);
  });

  it('a cross-site or same-site start sets NO cookie', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const res = await startReq({ 'sec-fetch-site': site });
      expect(res.status).toBe(303);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
  });

  it('only the matching state reaches the exchange', async () => {
    const { state, cookie } = await realStart();
    const res = await callbackReq(state, `?code=${CODE}`, cookie);
    expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=ok`);
    expectCleared(res);
    expect(pkce.exchangeOpenRouterCode).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a different valid state', () => 'A'.repeat(22)],
    ['a malformed state', (s: string) => `${s}!`],
    ['a 21-character state', (s: string) => s.slice(1)],
    ['an empty state', () => ''],
  ])('%s → expired, cookie cleared, no exchange and no fetch', async (_label, wrong) => {
    const { state, cookie } = await realStart();
    const bad = wrong(state);
    expect(bad).not.toBe(state);
    const res = await callbackReq(bad, `?code=${CODE}`, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=expired`);
    expectCleared(res);
    expect(pkce.exchangeOpenRouterCode).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('?error= with the right state → denied', async () => {
    const { state, cookie } = await realStart();
    const res = await callbackReq(state, '?error=access_denied', cookie);
    expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=denied`);
    expect(pkce.exchangeOpenRouterCode).not.toHaveBeenCalled();
  });

  it('a real cookie opened by another signed-in user → expired', async () => {
    const { state, cookie } = await realStart();
    h.user = { id: 'user-2' };
    const res = await callbackReq(state, `?code=${CODE}`, cookie);
    expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=expired`);
    expect(pkce.exchangeOpenRouterCode).not.toHaveBeenCalled();
  });

  it('a tampered cookie → expired', async () => {
    const { state, sealed } = await realStart();
    const parts = sealed.split(':');
    const ct = Buffer.from(parts[3], 'base64');
    ct[0] ^= 1;
    parts[3] = ct.toString('base64');
    const res = await callbackReq(state, `?code=${CODE}`, `dsul_or_pkce=${encodeURIComponent(parts.join(':'))}`);
    expect(res.headers.get('location')).toBe(`${SETTINGS}?connect=expired`);
    expect(pkce.exchangeOpenRouterCode).not.toHaveBeenCalled();
  });
});
