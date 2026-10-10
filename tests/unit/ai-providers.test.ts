// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The provider adapters (design section 4), driven end to end through the real
 * SDKs over a stubbed `fetch`. No request leaves the process: `fetch` is a
 * recording router, and DNS is mocked so a custom host's public-address check
 * never resolves anything for real.
 */

const dnsLookup = vi.hoisted(() =>
  vi.fn<(host: string, opts?: unknown) => Promise<{ address: string; family: number }[]>>(async () => [
    { address: '93.184.216.34', family: 4 },
  ])
);
vi.mock('node:dns', () => ({ promises: { lookup: dnsLookup }, default: { promises: { lookup: dnsLookup } } }));

import {
  ProviderError,
  USER_MESSAGES,
  classifyStatus,
  httpStatusFor,
  logProviderError,
  toChatErrorCode,
  toProviderError,
  type ProviderErrorKind,
} from '@/lib/ai-server/errors';
import { checkConnection } from '@/lib/ai-server/check';
import { BUILTIN_BASE_URLS, credentialsFor, getAdapter } from '@/lib/ai-server/providers';
import type { CompletionRequest, ProviderCredentials } from '@/lib/ai-server/providers/types';
import type { ModelProviderId } from '@/lib/ai-types';

// ── the recording fetch ─────────────────────────────────────────────────────

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  redirect?: RequestRedirect;
}

let seen: Seen[] = [];
let route: (req: Seen) => Response | Promise<Response> = () => new Response('{}', { status: 500 });

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
  const body =
    init?.body == null ? null : typeof init.body === 'string' ? init.body : await new Response(init.body).text();
  const req: Seen = { url, method: (init?.method ?? 'GET').toUpperCase(), headers, body, redirect: init?.redirect };
  seen.push(req);
  return route(req);
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Errors the SDK must not retry, so a test never waits on a backoff. */
const noRetry = { 'x-should-retry': 'false' };

const openaiSse = (chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });

const delta = (content: string | null, finish: string | null = null) => ({
  id: 'c1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'm',
  choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finish }],
});

const anthropicSse = (events: Array<{ type: string } & Record<string, unknown>>) =>
  new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

const anthropicEvents = (texts: string[], stop = 'end_turn') => [
  { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
  ...texts.map((t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
];

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const s of it) out.push(s);
  return out;
}

async function rejection(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    return err as ProviderError;
  }
  throw new Error('expected a rejection');
}

function creds(provider: ModelProviderId, baseUrl: string | null = null, apiKey = `key-${provider}`): ProviderCredentials {
  return credentialsFor(provider, baseUrl, apiKey);
}

function req(over: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    model: 'gpt-4o-mini',
    modelMeta: {},
    system: ['You are the planning assistant.', 'Planner context here.'],
    messages: [{ role: 'user', content: 'Plan my day' }],
    maxOutputTokens: 2000,
    signal: new AbortController().signal,
    ...over,
  };
}

const lastBody = () => JSON.parse(seen[seen.length - 1].body ?? '{}');

let logSpies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  seen = [];
  fetchMock.mockClear();
  dnsLookup.mockClear();
  dnsLookup.mockImplementation(async () => [{ address: '93.184.216.34', family: 4 }]);
  vi.stubGlobal('fetch', fetchMock);
  logSpies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {})
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ── registry ────────────────────────────────────────────────────────────────

describe('credentialsFor / getAdapter', () => {
  it('gives each built-in its constant base URL, whatever was stored', () => {
    for (const p of ['openai', 'gemini', 'openrouter', 'anthropic'] as const) {
      expect(credentialsFor(p, 'https://evil.example/v1', 'k')).toEqual({ provider: p, apiKey: 'k', baseUrl: BUILTIN_BASE_URLS[p] });
    }
  });

  it('re-checks a custom URL and throws blocked_url when it no longer passes', () => {
    expect(credentialsFor('custom', 'https://api.groq.com/openai/v1/', 'k').baseUrl).toBe('https://api.groq.com/openai/v1');
    expect(() => credentialsFor('custom', 'https://169.254.169.254/v1', 'k')).toThrow(ProviderError);
    expect(() => credentialsFor('custom', null, 'k')).toThrow(ProviderError);
  });

  it('returns one adapter per provider', () => {
    expect(getAdapter('openai').id).toBe('openai');
    expect(getAdapter('anthropic').id).toBe('anthropic');
    expect(getAdapter('custom')).toBe(getAdapter('custom'));
    expect(getAdapter('anthropic').describeModel).toBeTypeOf('function');
  });
});

// ── request shape ───────────────────────────────────────────────────────────

describe('OpenAI-compatible request bodies', () => {
  beforeEach(() => {
    route = () => openaiSse([delta('Hi'), delta(' there'), delta(null, 'stop')]);
  });

  it('OpenAI: URL, bearer, ONE system message, max_completion_tokens, no response_format', async () => {
    const out = await collect(await getAdapter('openai').openStream(creds('openai'), req()));
    expect(out.join('')).toBe('Hi there');
    const s = seen[0];
    expect(s.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(s.method).toBe('POST');
    expect(s.redirect).toBe('error');
    expect(s.headers.authorization).toBe('Bearer key-openai');
    const body = lastBody();
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are the planning assistant.\n\nPlanner context here.' },
      { role: 'user', content: 'Plan my day' },
    ]);
    expect(body.max_completion_tokens).toBe(2000);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body.stream).toBe(true);
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('response_format');
  });

  it.each([
    ['o3-mini', true],
    ['o4-mini', true],
    ['gpt-5', true],
    ['gpt-5-mini', true],
    ['gpt-5-chat-latest', false],
    ['gpt-4o', false],
    ['gpt-4.1-mini', false],
  ])('OpenAI reasoning_effort on %s: %s', async (model, expected) => {
    await collect(await getAdapter('openai').openStream(creds('openai'), req({ model })));
    const body = lastBody();
    if (expected) expect(body.reasoning_effort).toBe('low');
    else expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('OpenAI json → response_format json_object', async () => {
    route = () => json({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: '{"a":1}' }, finish_reason: 'stop' }] });
    const text = await getAdapter('openai').completeText(creds('openai'), req({ json: true }));
    expect(text).toBe('{"a":1}');
    expect(lastBody().response_format).toEqual({ type: 'json_object' });
    expect(lastBody()).not.toHaveProperty('stream');
  });

  it('Gemini: compat URL, max_tokens, reasoning_effort on 2.5+, response_format on json', async () => {
    await collect(await getAdapter('gemini').openStream(creds('gemini'), req({ model: 'gemini-2.5-flash' })));
    expect(seen[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(seen[0].headers.authorization).toBe('Bearer key-gemini');
    let body = lastBody();
    expect(body.max_tokens).toBe(2000);
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body.reasoning_effort).toBe('low');

    await collect(await getAdapter('gemini').openStream(creds('gemini'), req({ model: 'gemini-2.0-flash' })));
    expect(lastBody()).not.toHaveProperty('reasoning_effort');

    await collect(await getAdapter('gemini').openStream(creds('gemini'), req({ model: 'gemini-3-pro', json: true })));
    body = lastBody();
    expect(body.reasoning_effort).toBe('low');
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it.each([
    // The aliases pickGemini prefers point at a thinking release: unguarded, the
    // default Gemini model thinks at full budget under the 2000-token cap.
    ['gemini-flash-latest', true],
    ['gemini-flash-lite-latest', true],
    ['gemini-pro-latest', true],
    ['gemini-2.5-flash', true],
    ['gemini-2.5-pro', true],
    ['gemini-2.5-flash-lite', true],
    ['gemini-3-flash-preview', true],
    ['gemini-10-flash', true],
    ['gemini-2.0-flash', false],
    ['gemini-2.0-flash-lite', false],
    ['gemini-1.5-flash', false],
    ['gemini-1.5-flash-latest', false],
    ['gemini-exp-1206', false],
  ])('Gemini reasoning_effort on %s: %s', async (model, expected) => {
    route = () => openaiSse([delta('Hi'), delta(null, 'stop')]);
    await collect(await getAdapter('gemini').openStream(creds('gemini'), req({ model })));
    const body = lastBody();
    expect(body.max_tokens).toBe(2000);
    if (expected) expect(body.reasoning_effort).toBe('low');
    else expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('OpenRouter: max_tokens, attribution headers, no reasoning_effort or response_format', async () => {
    await collect(await getAdapter('openrouter').openStream(creds('openrouter'), req({ model: 'openai/gpt-5', json: true })));
    expect(seen[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(seen[0].headers['http-referer']).toBe('https://do.dsul.app');
    expect(seen[0].headers['x-title']).toBe('dsul');
    const body = lastBody();
    expect(body.max_tokens).toBe(2000);
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('response_format');
  });

  it('Other: the checked custom URL, max_tokens, no response_format', async () => {
    const c = creds('custom', 'https://api.groq.com/openai/v1/chat/completions');
    await collect(await getAdapter('custom').openStream(c, req({ model: 'llama-3.3-70b-versatile', json: true })));
    expect(seen[0].url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(dnsLookup).toHaveBeenCalledWith('api.groq.com', { all: true, verbatim: true });
    const body = lastBody();
    expect(body.max_tokens).toBe(2000);
    expect(body).not.toHaveProperty('response_format');
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('omits an empty system message', async () => {
    await collect(await getAdapter('openai').openStream(creds('openai'), req({ system: ['', '  '] })));
    expect(lastBody().messages).toEqual([{ role: 'user', content: 'Plan my day' }]);
  });
});

describe('Anthropic request bodies', () => {
  beforeEach(() => {
    route = () => anthropicSse(anthropicEvents(['Hello', ' world']));
  });

  it('URL, x-api-key, one system string, max_tokens, and only text deltas', async () => {
    const out = await collect(
      await getAdapter('anthropic').openStream(creds('anthropic'), req({ model: 'claude-opus-5-5' }))
    );
    expect(out).toEqual(['Hello', ' world']);
    const s = seen[0];
    expect(s.url).toBe('https://api.anthropic.com/v1/messages');
    expect(s.redirect).toBe('error');
    expect(s.headers['x-api-key']).toBe('key-anthropic');
    expect(s.headers).not.toHaveProperty('authorization');
    const body = lastBody();
    expect(body.system).toBe('You are the planning assistant.\n\nPlanner context here.');
    expect(body.max_tokens).toBe(2000);
    expect(body.stream).toBe(true);
    expect(body).not.toHaveProperty('output_config');
    expect(body).not.toHaveProperty('fallbacks');
  });

  it('output_config.effort is present iff modelMeta.effortLow', async () => {
    await collect(await getAdapter('anthropic').openStream(creds('anthropic'), req({ model: 'claude-opus-5-5', modelMeta: { effortLow: true } })));
    expect(lastBody().output_config).toEqual({ effort: 'low' });
    await collect(await getAdapter('anthropic').openStream(creds('anthropic'), req({ model: 'claude-haiku-4-5', modelMeta: { effortLow: false } })));
    expect(lastBody()).not.toHaveProperty('output_config');
  });

  it('normalizes turns: drops leading assistant and empty turns, merges same-role, ends on the user', async () => {
    await collect(
      await getAdapter('anthropic').openStream(
        creds('anthropic'),
        req({
          messages: [
            { role: 'assistant', content: 'Hi! How can I help?' },
            { role: 'user', content: 'one' },
            { role: 'user', content: 'two' },
            { role: 'assistant', content: '   ' },
            { role: 'user', content: 'three' },
            { role: 'assistant', content: 'answer' },
            { role: 'user', content: 'four' },
            { role: 'assistant', content: 'prefill?' },
          ],
        })
      )
    );
    expect(lastBody().messages).toEqual([
      { role: 'user', content: 'one\n\ntwo\n\nthree' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'four' },
    ]);
  });

  it('completeText joins text blocks', async () => {
    route = () =>
      json({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: '{"proposal":' }, { type: 'text', text: 'null}' }], usage: { input_tokens: 1, output_tokens: 1 } });
    const text = await getAdapter('anthropic').completeText(creds('anthropic'), req({ model: 'claude-opus-5-5', json: true }));
    expect(text).toBe('{"proposal":null}');
    expect(lastBody()).not.toHaveProperty('stream');
    expect(lastBody()).not.toHaveProperty('response_format');
  });
});

// ── env sentinel sweep ──────────────────────────────────────────────────────

describe('environment defaults are never consulted', () => {
  it('no request carries an env sentinel, goes to a sentinel host, or sends org/project/injected headers', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-env-SENTINEL');
    vi.stubEnv('OPENAI_BASE_URL', 'https://sentinel-openai.example/v1');
    vi.stubEnv('OPENAI_ORG_ID', 'org-SENTINEL');
    vi.stubEnv('OPENAI_PROJECT_ID', 'proj-SENTINEL');
    vi.stubEnv('OPENAI_LOG', 'debug');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-env-SENTINEL');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'tok-SENTINEL');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://sentinel-anthropic.example');
    vi.stubEnv('ANTHROPIC_LOG', 'debug');
    vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', 'X-Leak: SENTINEL');

    route = (r) =>
      r.url.startsWith('https://api.anthropic.com')
        ? anthropicSse(anthropicEvents(['ok']))
        : openaiSse([delta('ok'), delta(null, 'stop')]);

    for (const p of ['openai', 'gemini', 'openrouter'] as const) {
      await collect(await getAdapter(p).openStream(creds(p, null, `user-key-${p}`), req()));
    }
    await collect(await getAdapter('custom').openStream(creds('custom', 'https://api.mistral.ai/v1', 'user-key-custom'), req()));
    await collect(await getAdapter('anthropic').openStream(creds('anthropic', null, 'user-key-anthropic'), req()));

    expect(seen).toHaveLength(5);
    for (const s of seen) {
      expect(JSON.stringify(s)).not.toContain('SENTINEL');
      expect(s.url).not.toContain('sentinel');
      expect(s.headers).not.toHaveProperty('openai-organization');
      expect(s.headers).not.toHaveProperty('openai-project');
      expect(s.headers).not.toHaveProperty('x-leak');
    }
    expect(seen.map((s) => new URL(s.url).origin)).toEqual([
      'https://api.openai.com',
      'https://generativelanguage.googleapis.com',
      'https://openrouter.ai',
      'https://api.mistral.ai',
      'https://api.anthropic.com',
    ]);
    // Debug logging (which prints request headers) stayed off.
    const logged = JSON.stringify(logSpies.flatMap((s) => s.mock.calls));
    expect(logged).not.toContain('user-key-');
  });
});

// ── lifecycle and the error map ─────────────────────────────────────────────

describe('lifecycle', () => {
  it('openStream rejects on a 401 before any iteration, never echoing the body', async () => {
    route = () => json({ error: { message: 'Incorrect API key provided: sk-SENTINEL-abcd', code: 'invalid_api_key' } }, 401);
    const err = await rejection(getAdapter('openai').openStream(creds('openai'), req()));
    expect(err.kind).toBe('auth');
    expect(err.status).toBe(401);
    expect(err.message).toBe(USER_MESSAGES.auth);
    expect(JSON.stringify({ ...err, message: err.message, stack: err.stack })).not.toContain('SENTINEL');
  });

  it('Anthropic openStream rejects on a 401 too', async () => {
    route = () => json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key sk-SENTINEL-abcd' } }, 401);
    const err = await rejection(getAdapter('anthropic').openStream(creds('anthropic'), req()));
    expect(err.kind).toBe('auth');
    expect(err.message).not.toContain('SENTINEL');
  });

  it('a call-time 403 is forbidden (the key survives it)', async () => {
    route = () => json({ error: { message: 'model not available in your region' } }, 403);
    expect((await rejection(getAdapter('openai').openStream(creds('openai'), req()))).kind).toBe('forbidden');
    route = () => json({ type: 'error', error: { type: 'permission_error', message: 'nope' } }, 403);
    expect((await rejection(getAdapter('anthropic').completeText(creds('anthropic'), req()))).kind).toBe('forbidden');
  });

  it('429 insufficient_quota → quota; plain 429 → rate_limit; 404 → bad_model; 529 → upstream', async () => {
    route = () => json({ error: { message: 'x', code: 'insufficient_quota' } }, 429, noRetry);
    expect((await rejection(getAdapter('openai').openStream(creds('openai'), req()))).kind).toBe('quota');
    route = () => json({ error: { message: 'slow down' } }, 429, noRetry);
    expect((await rejection(getAdapter('openai').openStream(creds('openai'), req()))).kind).toBe('rate_limit');
    route = () => json({ error: { message: 'no such model' } }, 404);
    expect((await rejection(getAdapter('openai').completeText(creds('openai'), req()))).kind).toBe('bad_model');
    route = () => json({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, 529, noRetry);
    expect((await rejection(getAdapter('anthropic').openStream(creds('anthropic'), req()))).kind).toBe('upstream');
  });

  it('a mid-stream error event → upstream, after the text so far', async () => {
    route = () =>
      new Response(`data: ${JSON.stringify(delta('par'))}\n\ndata: ${JSON.stringify({ error: { message: 'sk-SENTINEL upstream died' } })}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    const it = await getAdapter('openrouter').openStream(creds('openrouter'), req());
    const got: string[] = [];
    const err = await rejection((async () => { for await (const s of it) got.push(s); })());
    expect(got).toEqual(['par']);
    expect(err.kind).toBe('upstream');
    expect(err.message).not.toContain('SENTINEL');
  });

  it('a user abort → aborted; a deadline → timeout', async () => {
    route = (r) => new Promise<Response>(() => void r); // never answers
    const user = new AbortController();
    const p = getAdapter('openai').openStream(creds('openai'), req({ signal: user.signal }));
    user.abort();
    expect((await rejection(p)).kind).toBe('aborted');

    const deadline = new AbortController();
    const q = getAdapter('anthropic').openStream(creds('anthropic'), req({ signal: deadline.signal }));
    deadline.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    expect((await rejection(q)).kind).toBe('timeout');
  });

  it('a refusal → refused (OpenAI content_filter with no text; Anthropic stop_reason after partial text)', async () => {
    route = () => openaiSse([delta(null, 'content_filter')]);
    const it1 = await getAdapter('openai').openStream(creds('openai'), req());
    expect((await rejection(collect(it1))).kind).toBe('refused');

    route = () => anthropicSse(anthropicEvents(['Partial'], 'refusal'));
    const it2 = await getAdapter('anthropic').openStream(creds('anthropic'), req());
    const got: string[] = [];
    const err = await rejection((async () => { for await (const s of it2) got.push(s); })());
    expect(got).toEqual(['Partial']);
    expect(err.kind).toBe('refused');

    route = () => json({ id: 'm', type: 'message', role: 'assistant', model: 'x', stop_reason: 'refusal', content: [], usage: { input_tokens: 1, output_tokens: 0 } });
    expect((await rejection(getAdapter('anthropic').completeText(creds('anthropic'), req()))).kind).toBe('refused');

    route = () => json({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: null, refusal: 'I cannot' }, finish_reason: 'stop' }] });
    expect((await rejection(getAdapter('openai').completeText(creds('openai'), req()))).kind).toBe('refused');
  });

  it('an empty completion → empty', async () => {
    route = () => json({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'length' }] });
    expect((await rejection(getAdapter('gemini').completeText(creds('gemini'), req()))).kind).toBe('empty');
    route = () => json({ id: 'm', type: 'message', role: 'assistant', model: 'x', stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '', signature: 's' }], usage: { input_tokens: 1, output_tokens: 1 } });
    expect((await rejection(getAdapter('anthropic').completeText(creds('anthropic'), req()))).kind).toBe('empty');
  });

  it('strips <think> spans split across deltas', async () => {
    route = () =>
      openaiSse(['<thi', 'nk>plan', 'ning…</th', 'ink>\n\nThe ', 'answer', ' <not a tag>'].map((c) => delta(c)));
    const out = await collect(await getAdapter('custom').openStream(creds('custom', 'https://api.deepseek.com'), req()));
    expect(out.join('')).toBe('The answer <not a tag>');
  });

  it('strips <think> from completeText', async () => {
    route = () => json({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: '<think>hmm</think>\n{"proposal":null}' }, finish_reason: 'stop' }] });
    expect(await getAdapter('custom').completeText(creds('custom', 'https://api.deepseek.com'), req())).toBe('{"proposal":null}');
  });

  it('a custom host resolving to a private address is never fetched', async () => {
    dnsLookup.mockImplementation(async () => [{ address: '10.0.0.7', family: 4 }]);
    const err = await rejection(getAdapter('custom').openStream(creds('custom', 'https://rebind.example.com/v1'), req()));
    expect(err.kind).toBe('blocked_url');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the error map', () => {
  it.each<[number, 'verify' | 'call', ModelProviderId, string | undefined, ProviderErrorKind]>([
    [401, 'verify', 'openai', undefined, 'auth'],
    [401, 'call', 'anthropic', undefined, 'auth'],
    [403, 'verify', 'openai', undefined, 'auth'],
    [403, 'call', 'openai', undefined, 'forbidden'],
    [403, 'verify', 'openai', 'unsupported_country_region_territory', 'region'],
    [403, 'call', 'openai', 'unsupported_country_region_territory', 'region'],
    [400, 'verify', 'gemini', undefined, 'auth'],
    [400, 'call', 'gemini', undefined, 'bad_request'],
    [400, 'verify', 'openai', undefined, 'bad_request'],
    [402, 'call', 'openrouter', undefined, 'quota'],
    [404, 'call', 'anthropic', undefined, 'bad_model'],
    [408, 'call', 'openai', undefined, 'timeout'],
    [504, 'call', 'openai', undefined, 'timeout'],
    [413, 'call', 'anthropic', undefined, 'bad_request'],
    [422, 'call', 'custom', undefined, 'bad_request'],
    [429, 'call', 'openai', 'insufficient_quota', 'quota'],
    [429, 'call', 'anthropic', undefined, 'rate_limit'],
    [500, 'call', 'openai', undefined, 'upstream'],
    [503, 'call', 'gemini', undefined, 'upstream'],
    [529, 'call', 'anthropic', undefined, 'upstream'],
  ])('%i (%s, %s, code %s) → %s', (status, phase, p, code, kind) => {
    expect(classifyStatus(status, p, phase, code)).toBe(kind);
  });

  it('toProviderError passes a carried ProviderError through, and never reads a message', () => {
    const inner = new ProviderError('blocked_url');
    expect(toProviderError(inner, 'custom', 'call')).toBe(inner);
    expect(toProviderError(Object.assign(new Error('wrapped'), { cause: inner }), 'custom', 'call')).toBe(inner);
    expect(toProviderError(new DOMException('x', 'AbortError'), 'openai', 'call').kind).toBe('aborted');
    expect(toProviderError(new DOMException('x', 'TimeoutError'), 'openai', 'call').kind).toBe('timeout');
    expect(toProviderError(new TypeError('fetch failed'), 'openai', 'call').kind).toBe('network');
    const e = toProviderError(Object.assign(new Error('Incorrect key sk-SENTINEL'), { status: 401 }), 'openai', 'call');
    expect(e.kind).toBe('auth');
    expect(e.message).not.toContain('SENTINEL');
    expect(toProviderError('a string', 'openai', 'call').kind).toBe('upstream');
  });

  it('maps kinds to chat codes and HTTP statuses', () => {
    expect(toChatErrorCode('aborted')).toBe('network');
    expect(toChatErrorCode('model_required')).toBe('bad_model');
    expect(toChatErrorCode('auth')).toBe('auth');
    expect(toChatErrorCode('empty')).toBe('empty');
    expect(toChatErrorCode('daily_limit')).toBe('daily_limit');
    expect(toChatErrorCode('region')).toBe('region');
    expect(httpStatusFor('blocked_url')).toBe(400);
    expect(httpStatusFor('model_required')).toBe(400);
    expect(httpStatusFor('timeout')).toBe(504);
    expect(httpStatusFor('region')).toBe(403);
    expect(httpStatusFor('daily_limit')).toBe(429);
    expect(httpStatusFor('auth')).toBe(502);
  });

  it('keeps a reset time it was given, and only a real one', () => {
    expect(new ProviderError('daily_limit', 429, '2026-10-02T07:00:00Z').resetAt).toBe('2026-10-02T07:00:00.000Z');
    expect(new ProviderError('daily_limit', 429).resetAt).toBeUndefined();
    expect(new ProviderError('daily_limit', 429, 'tomorrow').resetAt).toBeUndefined();
  });

  it('reads Anthropic’s billing error as quota, wherever it arrives', () => {
    // A 402 says the same; the type carries it on a stream's error event too,
    // which has no status at all.
    const billing = Object.assign(new Error('x'), { type: 'billing_error' });
    expect(toProviderError(billing, 'anthropic', 'call').kind).toBe('quota');
    expect(toProviderError(Object.assign(new Error('x'), { type: 'billing_error', status: 402 }), 'anthropic', 'call').status).toBe(402);
    // Only Anthropic's: nobody else sends that type.
    expect(toProviderError(billing, 'openai', 'call').kind).toBe('upstream');
  });

  it('logs only route, provider, kind and status', () => {
    logProviderError('chat', 'openai', 'auth', 401);
    logProviderError('propose', 'anthropic', 'refused');
    const warn = logSpies[1];
    expect(warn.mock.calls).toEqual([
      ['[ai]', 'chat', 'openai', 'auth', 401],
      ['[ai]', 'propose', 'anthropic', 'refused'],
    ]);
  });

  it('copy has no em dashes', () => {
    for (const msg of Object.values(USER_MESSAGES)) expect(msg).not.toContain('—');
  });

  // Chat and propose show this copy verbatim, where there is no key, model or
  // address field: each line must say what to do next, and a fix that needs a
  // field must say it lives in Settings. `daily_limit` is the exception: its
  // next step is waiting, and the line says when.
  it('every shown message names a next step', () => {
    const NEXT_STEP = /\b(Try|Pick|Check|Change|Reconnect|Enter)\b/;
    for (const [kind, msg] of Object.entries(USER_MESSAGES)) {
      if (kind === 'aborted' || kind === 'daily_limit') continue;
      expect.soft(msg, kind).toMatch(NEXT_STEP);
    }
    expect(USER_MESSAGES.daily_limit).toMatch(/\bresets\b/);
  });

  // A hint thrown from the fetch layer (error-hints.ts) reaches the route as
  // the error's cause. The OpenAI SDK drops the cause when the rejection reads
  // like a timeout, so no copy of ours may read like one.
  it('no message reads as a timeout, which would lose a thrown hint', () => {
    for (const [kind, msg] of Object.entries(USER_MESSAGES)) {
      expect.soft(msg, kind).not.toMatch(/timed? ?out/i);
    }
  });

  it.each(['auth', 'bad_model', 'bad_request', 'network', 'blocked_url'] as const)(
    '%s points at Settings, since the fix is not in the chat',
    (kind) => {
      expect(USER_MESSAGES[kind]).toMatch(/\bin Settings\b/);
    }
  );
});

// ── verify, lists and defaults ──────────────────────────────────────────────

const openaiModels = (ids: Array<string | [string, number]>) =>
  json({ object: 'list', data: ids.map((x) => (Array.isArray(x) ? { id: x[0], object: 'model', created: x[1], owned_by: 'o' } : { id: x, object: 'model', created: 1, owned_by: 'o' })) });

describe('OpenAI verify and list', () => {
  it('lists /models, filters, and picks the newest mini', async () => {
    route = () =>
      openaiModels([
        ['gpt-4o-mini', 100],
        ['gpt-4.1-mini', 200],
        ['gpt-5-mini', 300],
        ['gpt-5', 310],
        ['o3', 250],
        ['gpt-4o-2024-08-06', 90],
        ['gpt-4o-realtime-preview', 95],
        ['text-embedding-3-small', 50],
        ['whisper-1', 10],
        ['dall-e-3', 10],
        ['gpt-4o-mini-tts', 120],
        ['gpt 4o', 400],
        ['g'.repeat(201), 400],
        ['gpt-\u0007bell', 400],
      ]);
    const adapter = getAdapter('openai');
    const result = await adapter.verify(creds('openai'), { signal: new AbortController().signal });
    expect(seen[0].url).toBe('https://api.openai.com/v1/models');
    expect(seen[0].method).toBe('GET');
    expect(result.listed).toBe(true);
    expect(result.models.map((m) => m.id)).toEqual(['gpt-5', 'gpt-5-mini', 'o3', 'gpt-4.1-mini', 'gpt-4o-mini']);
    expect(adapter.pickDefaultModel(result)).toBe('gpt-5-mini');
  });

  it('falls back to the unfiltered list, and defaults sensibly', async () => {
    route = () => openaiModels(['ft:custom-thing', 'babbage-002']);
    const adapter = getAdapter('openai');
    const result = await adapter.listModels(creds('openai'), new AbortController().signal);
    expect(result.models.map((m) => m.id).sort()).toEqual(['babbage-002', 'ft:custom-thing']);
    expect(adapter.pickDefaultModel(result)).toBe(result.models[0].id);
    expect(adapter.pickDefaultModel({ models: [{ id: 'gpt-4o', label: 'gpt-4o', created: 2 }, { id: 'gpt-4', label: 'gpt-4', created: 1 }], listed: true })).toBe('gpt-4o');
    expect(adapter.pickDefaultModel({ models: [], listed: true })).toBeNull();
  });

  it('a 401 on verify → auth; a 403 on verify → auth', async () => {
    route = () => json({ error: { message: 'bad key sk-SENTINEL' } }, 401);
    expect((await rejection(getAdapter('openai').verify(creds('openai'), { signal: new AbortController().signal }))).kind).toBe('auth');
    route = () => json({ error: { message: 'no' } }, 403);
    expect((await rejection(getAdapter('openai').verify(creds('openai'), { signal: new AbortController().signal }))).kind).toBe('auth');
  });
});

describe('Gemini verify and list', () => {
  it('strips models/, filters, and prefers gemini-flash-latest', async () => {
    route = () =>
      openaiModels([
        'models/gemini-2.5-pro',
        'models/gemini-2.5-flash',
        'models/gemini-flash-latest',
        'models/gemini-embedding-001',
        'models/gemini-2.0-flash-live-001',
        'models/imagen-4.0',
        'models/gemini-2.5-flash-preview-tts',
        'models/aqa',
        'models/gemini 3 pro',
      ]);
    const adapter = getAdapter('gemini');
    const result = await adapter.verify(creds('gemini'), { signal: new AbortController().signal });
    expect(seen[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/models');
    expect(result.models.map((m) => m.id)).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-flash-latest']);
    expect(adapter.pickDefaultModel(result)).toBe('gemini-flash-latest');
  });

  it('the model it picks by default is sent with the low-reasoning guard', async () => {
    route = () => openaiModels(['models/gemini-2.0-flash', 'models/gemini-2.5-flash', 'models/gemini-flash-latest']);
    const adapter = getAdapter('gemini');
    const model = adapter.pickDefaultModel(await adapter.verify(creds('gemini'), { signal: new AbortController().signal }));
    expect(model).toBe('gemini-flash-latest');
    route = () => openaiSse([delta('Hi'), delta(null, 'stop')]);
    await collect(await adapter.openStream(creds('gemini'), req({ model: model! })));
    const body = lastBody();
    expect(body.max_tokens).toBe(2000);
    expect(body.reasoning_effort).toBe('low');
  });

  it('else the highest numbered flash, else any flash, else the first', () => {
    const adapter = getAdapter('gemini');
    const list = (ids: string[]) => ({ models: ids.map((id) => ({ id, label: id })), listed: true });
    expect(adapter.pickDefaultModel(list(['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-10-flash', 'gemini-2.5-pro']))).toBe('gemini-10-flash');
    expect(adapter.pickDefaultModel(list(['gemini-2.5-pro', 'gemini-2.5-flash-lite']))).toBe('gemini-2.5-flash-lite');
    expect(adapter.pickDefaultModel(list(['gemini-2.5-pro']))).toBe('gemini-2.5-pro');
  });

  it('a 400 on verify → auth (a bad key in the compat layer); at call time → bad_request', async () => {
    route = () => json([{ error: { code: 400, message: 'API key not valid. sk-SENTINEL', status: 'INVALID_ARGUMENT' } }], 400);
    expect((await rejection(getAdapter('gemini').verify(creds('gemini'), { signal: new AbortController().signal }))).kind).toBe('auth');
    expect((await rejection(getAdapter('gemini').completeText(creds('gemini'), req()))).kind).toBe('bad_request');
  });
});

describe('OpenRouter verify and list', () => {
  it('verify reads only is_free_tier from GET /key (never the masked label)', async () => {
    route = () => json({ data: { label: 'sk-or-v1-SENTINEL...abcd', usage: 0, limit: null, is_free_tier: true } });
    const result = await getAdapter('openrouter').verify(creds('openrouter', null, 'sk-or-user'), { signal: new AbortController().signal });
    expect(seen[0].url).toBe('https://openrouter.ai/api/v1/key');
    expect(seen[0].headers.authorization).toBe('Bearer sk-or-user');
    expect(result).toEqual({ models: [], listed: false, freeTier: true });
    expect(JSON.stringify(result)).not.toContain('SENTINEL');
  });

  it('verify: 401 → auth', async () => {
    route = () => json({ error: { message: 'No auth credentials found' } }, 401);
    expect((await rejection(getAdapter('openrouter').verify(creds('openrouter'), { signal: new AbortController().signal }))).kind).toBe('auth');
  });

  it('lists the public catalog without the key, keeps text output, flags free models', async () => {
    route = () =>
      json({
        data: [
          { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Meta: Llama 3.3 70B (free)', context_length: 131072, architecture: { output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' } },
          { id: 'google/gemma-3-27b-it:free', name: 'Google: Gemma 3 27B (free)', context_length: 96000, architecture: { output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' } },
          { id: 'openai/gpt-5', name: 'OpenAI: GPT-5', context_length: 400000, architecture: { output_modalities: ['text'] }, pricing: { prompt: '0.00000125', completion: '0.00001' } },
          { id: 'black-forest-labs/flux', name: 'FLUX', architecture: { output_modalities: ['image'] }, pricing: { prompt: '0', completion: '0' } },
          { id: 'legacy/model', name: 'Legacy', architecture: { modality: 'text->text' }, pricing: { prompt: '1', completion: '1' } },
          { id: 'bad id with spaces', name: 'Bad', architecture: { output_modalities: ['text'] } },
          { id: 'openrouter/auto', name: 'Auto Router', architecture: { output_modalities: ['text'] }, pricing: { prompt: '-1', completion: '-1' } },
        ],
      });
    const adapter = getAdapter('openrouter');
    const list = await adapter.listModels(creds('openrouter', null, 'sk-or-user'), new AbortController().signal);
    expect(seen[0].url).toBe('https://openrouter.ai/api/v1/models');
    expect(seen[0].headers).not.toHaveProperty('authorization');
    expect(list.listed).toBe(true);
    expect(list.models.map((m) => m.label)).toEqual([
      'Auto Router',
      'Google: Gemma 3 27B (free)',
      'Legacy',
      'Meta: Llama 3.3 70B (free)',
      'OpenAI: GPT-5',
    ]);
    expect(list.models.filter((m) => m.free).map((m) => m.id).sort()).toEqual([
      'google/gemma-3-27b-it:free',
      'meta-llama/llama-3.3-70b-instruct:free',
    ]);
    // Free tier → the free model with the largest context; otherwise auto.
    expect(adapter.pickDefaultModel({ ...list, freeTier: true })).toBe('meta-llama/llama-3.3-70b-instruct:free');
    expect(adapter.pickDefaultModel({ ...list, freeTier: false })).toBe('openrouter/auto');
    expect(adapter.pickDefaultModel({ models: [], listed: false, freeTier: true })).toBe('openrouter/auto');
  });

  it('caps the catalog at 400, keeping the newest', async () => {
    route = () =>
      json({
        data: Array.from({ length: 450 }, (_, i) => ({
          id: `vendor/model-${String(i).padStart(3, '0')}`,
          name: `Model ${String(i).padStart(3, '0')}`,
          created: i,
          architecture: { output_modalities: ['text'] },
        })),
      });
    const list = await getAdapter('openrouter').listModels(creds('openrouter'), new AbortController().signal);
    expect(list.models).toHaveLength(400);
    expect(list.models[0].id).toBe('vendor/model-050');
    expect(list.models.some((m) => m.id === 'vendor/model-449')).toBe(true);
  });
});

describe('Other (custom) verify and list', () => {
  const base = 'https://llm.example.com/v1';

  it('lists /models, dropping invalid ids and embeddings; one valid id becomes the default', async () => {
    route = () => openaiModels(['Llama 3 8B', 'x'.repeat(201), 'bad\u0001id', 'nomic-embed-text', 'qwen2.5:7b']);
    const adapter = getAdapter('custom');
    const result = await adapter.verify(creds('custom', base), { signal: new AbortController().signal });
    expect(seen[0].url).toBe('https://llm.example.com/v1/models');
    expect(result).toMatchObject({ listed: true, models: [{ id: 'qwen2.5:7b', label: 'qwen2.5:7b' }] });
    expect(adapter.pickDefaultModel(result)).toBe('qwen2.5:7b');
  });

  it('a host listing only invalid ids → listed:true, models:[], no default', async () => {
    route = () => openaiModels(['Llama 3 8B']);
    const adapter = getAdapter('custom');
    const result = await adapter.verify(creds('custom', base), { signal: new AbortController().signal });
    expect(result).toEqual({ models: [], listed: true });
    expect(adapter.pickDefaultModel(result)).toBeNull();
  });

  it('several ids → no default (the user picks)', async () => {
    route = () => openaiModels(['a-model', 'b-model']);
    const adapter = getAdapter('custom');
    expect(adapter.pickDefaultModel(await adapter.verify(creds('custom', base), { signal: new AbortController().signal }))).toBeNull();
  });

  it('caps the list at 300', async () => {
    route = () => openaiModels(Array.from({ length: 350 }, (_, i) => `m-${i}`));
    const list = await getAdapter('custom').listModels(creds('custom', base), new AbortController().signal);
    expect(list.models).toHaveLength(300);
  });

  // A host may list its models without looking at the key (OpenRouter's catalog
  // is public), so a list alone must not keep a refused key marked as working.
  it('a host that lists, with a hint, also checks the key with a 1-token call', async () => {
    route = (r) =>
      r.url.endsWith('/models')
        ? openaiModels(['a-model', 'b-model'])
        : json({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'p' }, finish_reason: 'length' }] });
    const result = await getAdapter('custom').verify(creds('custom', base), { signal: new AbortController().signal, modelHint: 'a-model' });
    expect(result).toMatchObject({ listed: true });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET https://llm.example.com/v1/models',
      'POST https://llm.example.com/v1/chat/completions',
    ]);
    expect(lastBody()).toMatchObject({ model: 'a-model', max_tokens: 1 });
  });

  it('a host that lists without checking the key, whose 1-token call is refused → auth', async () => {
    route = (r) => (r.url.endsWith('/models') ? openaiModels(['a-model']) : json({ error: 'bad key' }, 401));
    const err = await rejection(getAdapter('custom').verify(creds('custom', base), { signal: new AbortController().signal, modelHint: 'a-model' }));
    expect(err.kind).toBe('auth');
  });

  it('a host that lists: a 1-token call failing for any other reason still passes', async () => {
    route = (r) => (r.url.endsWith('/models') ? openaiModels(['a-model']) : json({ error: 'busy' }, 429));
    const result = await getAdapter('custom').verify(creds('custom', base), { signal: new AbortController().signal, modelHint: 'a-model' });
    expect(result).toMatchObject({ listed: true, models: [{ id: 'a-model' }] });
  });

  it("a host that lists: a 403 on the 1-token call is the model's access, not the key's, and passes", async () => {
    // A chat reads the same 403 as 'forbidden' and keeps the connection; a check must agree.
    route = (r) => (r.url.endsWith('/models') ? openaiModels(['a-model', 'b-model']) : json({ error: 'gated' }, 403));
    const result = await getAdapter('custom').verify(creds('custom', base), { signal: new AbortController().signal, modelHint: 'a-model' });
    expect(result).toMatchObject({ listed: true });
  });

  it('a host that lists ONE model checks the key on it without a hint (it becomes the default)', async () => {
    route = (r) => (r.url.endsWith('/models') ? openaiModels(['only-model']) : json({ error: 'bad key' }, 401));
    const err = await rejection(getAdapter('custom').verify(creds('custom', base), { signal: new AbortController().signal }));
    expect(err.kind).toBe('auth');
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET https://llm.example.com/v1/models',
      'POST https://llm.example.com/v1/chat/completions',
    ]);
    expect(lastBody()).toMatchObject({ model: 'only-model', max_tokens: 1 });
  });

  it('a host that lists several models, without a hint, makes no call beyond the list', async () => {
    route = () => openaiModels(['a-model', 'b-model']);
    await getAdapter('custom').verify(creds('custom', base), { signal: new AbortController().signal });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['GET https://llm.example.com/v1/models']);
  });

  it('a 404 on /models with a hint does a 1-token check on that model', async () => {
    route = (r) =>
      r.url.endsWith('/models')
        ? json({ error: 'not found' }, 404)
        : json({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'p' }, finish_reason: 'length' }] });
    const result = await getAdapter('custom').verify(creds('custom', base), { signal: new AbortController().signal, modelHint: 'my-model' });
    expect(result).toEqual({ models: [], listed: false });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET https://llm.example.com/v1/models',
      'POST https://llm.example.com/v1/chat/completions',
    ]);
    expect(lastBody()).toMatchObject({ model: 'my-model', max_tokens: 1 });
  });

  it('a 404 with a hint whose check is refused → auth', async () => {
    route = (r) => (r.url.endsWith('/models') ? json({}, 405) : json({ error: 'bad key' }, 401));
    const err = await rejection(getAdapter('custom').verify(creds('custom', base), { signal: new AbortController().signal, modelHint: 'my-model' }));
    expect(err.kind).toBe('auth');
  });

  it('a 404 on /models without a hint → model_required', async () => {
    route = () => json({ error: 'not found' }, 404);
    const err = await rejection(getAdapter('custom').verify(creds('custom', base), { signal: new AbortController().signal }));
    expect(err.kind).toBe('model_required');
    expect(seen).toHaveLength(1);
  });

  it('listModels on a host that cannot list → listed:false', async () => {
    route = () => json({}, 501);
    expect(await getAdapter('custom').listModels(creds('custom', base), new AbortController().signal)).toEqual({ models: [], listed: false });
  });

  describe('hostile bodies (review 2)', () => {
    const MB = 1_000_000;
    function newlineFree(bytes: number, contentType: string, prefix = ''): Response {
      const enc = new TextEncoder();
      const chunk = new Uint8Array(64 * 1024).fill(0x61);
      let sent = 0;
      let first = true;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            if (first && prefix) {
              first = false;
              c.enqueue(enc.encode(prefix));
              return;
            }
            if (sent >= bytes) return c.close();
            c.enqueue(chunk);
            sent += chunk.byteLength;
          },
        }),
        { headers: { 'content-type': contentType } }
      );
    }

    it('listModels on a 5 MB /models body rejects with upstream', async () => {
      route = () => newlineFree(5 * MB, 'application/json', '{"data":[{"id":"');
      const err = await rejection(getAdapter('custom').listModels(creds('custom', base), new AbortController().signal));
      expect(err.kind).toBe('upstream');
    });

    it('openStream on a 5 MB newline-free SSE body throws upstream', async () => {
      route = () => newlineFree(5 * MB, 'text/event-stream', 'data: {"choices":[{"delta":{"content":"');
      const it = await getAdapter('custom').openStream(creds('custom', base), req({ model: 'm' }));
      const err = await rejection(collect(it));
      expect(err.kind).toBe('upstream');
    });
  });
});

// ── the check's test question ───────────────────────────────────────────────

describe('ping: one streamed test question, one output token', () => {
  const signal = () => new AbortController().signal;

  it('OpenAI sends max_completion_tokens, streamed, and reads it to the end', async () => {
    route = () => openaiSse([delta('o'), delta(null, 'length')]);
    await getAdapter('openai').ping(creds('openai'), 'gpt-5-mini', signal());
    expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual(['POST https://api.openai.com/v1/chat/completions']);
    const body = lastBody();
    expect(body).toMatchObject({ model: 'gpt-5-mini', stream: true, max_completion_tokens: 1 });
    expect(body).not.toHaveProperty('max_tokens');
    expect(body.messages).toEqual([{ role: 'user', content: 'ping' }]);
  });

  it.each(['gemini', 'openrouter', 'custom'] as const)('%s sends max_tokens', async (id) => {
    route = () => openaiSse([delta(null, 'length')]);
    const c = id === 'custom' ? creds('custom', 'https://llm.example.com/v1') : creds(id);
    await getAdapter(id).ping(c, 'some-model', signal());
    const body = lastBody();
    expect(body).toMatchObject({ model: 'some-model', stream: true, max_tokens: 1 });
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  const unverified = () =>
    json(
      {
        error: {
          message: 'Your organization must be verified to stream this model.',
          type: 'invalid_request_error',
          param: 'stream',
          code: 'unsupported_value',
        },
      },
      400,
      noRetry
    );

  it('a model that only refuses a STREAMED request rejects the ping as stream_refused', async () => {
    // The question Ask asks is streamed, so the check asks it that way too.
    route = (r) => (JSON.parse(r.body ?? '{}').stream === true ? unverified() : openaiSse([]));
    expect((await rejection(getAdapter('openai').ping(creds('openai'), 'gpt-5-mini', signal()))).kind).toBe(
      'stream_refused'
    );
  });

  it('any other 400 is still a bad_request', async () => {
    route = () => json({ error: { message: 'nope', param: 'messages' } }, 400, noRetry);
    expect((await rejection(getAdapter('openai').ping(creds('openai'), 'gpt-5-mini', signal()))).kind).toBe(
      'bad_request'
    );
  });

  it('the check fails a default that won’t stream, after asking the next default once', async () => {
    // An organization OpenAI has not verified to stream its newest models:
    // the older mini answers, and that one is saved.
    route = (r) => {
      if (r.method === 'GET') return openaiModels([['gpt-5-mini', 300], ['gpt-4o-mini', 100]]);
      return JSON.parse(r.body ?? '{}').model === 'gpt-5-mini' ? unverified() : openaiSse([delta(null, 'length')]);
    };
    const out = await checkConnection(getAdapter('openai'), creds('openai'), {
      signal: signal(),
      deadline: Date.now() + 20_000,
    });
    expect(seen.map((r) => r.method)).toEqual(['GET', 'POST', 'POST']);
    expect(out.model).toBe('gpt-4o-mini');
    expect(out.ping).toEqual({ ok: true });
  });

  it('with no other default that streams, the check fails as stream_refused', async () => {
    route = (r) => (r.method === 'GET' ? openaiModels(['gpt-5-mini']) : unverified());
    const out = await checkConnection(getAdapter('openai'), creds('openai'), {
      signal: signal(),
      deadline: Date.now() + 20_000,
    });
    expect(out.ping.ok).toBe(false);
    expect(!out.ping.ok && out.ping.error.kind).toBe('stream_refused');
  });

  it('a 403 is the model’s or the region’s, never the key’s: the list already proved the key', async () => {
    route = () => json({ error: 'gated' }, 403, noRetry);
    expect((await rejection(getAdapter('openai').ping(creds('openai'), 'gpt-5', signal()))).kind).toBe('forbidden');
    route = () => json({ error: 'no' }, 401, noRetry);
    expect((await rejection(getAdapter('openai').ping(creds('openai'), 'gpt-5', signal()))).kind).toBe('auth');
  });

  it('is never retried: one request, whatever the answer', async () => {
    route = () => json({ error: { message: 'slow down' } }, 429);
    expect((await rejection(getAdapter('openai').ping(creds('openai'), 'gpt-5', signal()))).kind).toBe('rate_limit');
    expect(seen).toHaveLength(1);
  });

  it('a stream that ends because the signal aborted is no answer', async () => {
    const ac = new AbortController();
    route = () => {
      ac.abort();
      return openaiSse([delta('o')]);
    };
    expect((await rejection(getAdapter('openai').ping(creds('openai'), 'gpt-5', ac.signal))).kind).toBe('aborted');
  });

  it('Anthropic sends one message with max_tokens 1, not streamed', async () => {
    route = () =>
      json({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', stop_reason: 'max_tokens', content: [{ type: 'text', text: 'p' }], usage: { input_tokens: 1, output_tokens: 1 } });
    await getAdapter('anthropic').ping(creds('anthropic'), 'claude-sonnet-4-5', signal());
    expect(seen[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(lastBody()).toEqual({
      model: 'claude-sonnet-4-5',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
  });

  it('Anthropic: a no-credit 400 arrives as bad_request, for check.ts to judge', async () => {
    route = () => json({ type: 'error', error: { type: 'invalid_request_error', message: 'credit balance is too low' } }, 400, noRetry);
    const err = await rejection(getAdapter('anthropic').ping(creds('anthropic'), 'claude-sonnet-4-5', signal()));
    expect(err.kind).toBe('bad_request');
    expect(err.message).not.toContain('credit balance');
  });
});

// ── error-body hints, through the SDK ───────────────────────────────────────

describe('hints from the error body (gemini, openrouter)', () => {
  const quota = (quotaId: string, quotaValue = '50') => ({
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      message: 'Quota exceeded for key AIza-SENTINEL',
      details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId, quotaValue }] }],
    },
  });

  it('Gemini: a per-day quota on the check reads as daily_limit, with a reset time of ours', async () => {
    route = () => json(quota('GenerateRequestsPerDayPerProjectPerModel-FreeTier'), 429, noRetry);
    const err = await rejection(getAdapter('gemini').ping(creds('gemini'), 'gemini-flash-latest', new AbortController().signal));
    expect(err.kind).toBe('daily_limit');
    expect(err.resetAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain('SENTINEL');
  });

  it('Gemini: a per-minute quota is still a rate limit', async () => {
    route = () => json(quota('GenerateRequestsPerMinutePerProjectPerModel'), 429, noRetry);
    const err = await rejection(getAdapter('gemini').ping(creds('gemini'), 'gemini-flash-latest', new AbortController().signal));
    expect(err.kind).toBe('rate_limit');
  });

  it('Gemini: a region refusal on a META call is region, not a bad key', async () => {
    route = () =>
      json({ error: { code: 400, status: 'FAILED_PRECONDITION', message: 'User location is not supported' } }, 400, noRetry);
    const err = await rejection(
      getAdapter('gemini').verify(creds('gemini'), { signal: new AbortController().signal })
    );
    expect(err.kind).toBe('region');
  });

  it('a chat call is never sent twice for a 400 hint: only the 429 one throws there', async () => {
    // Throwing from `fetch` makes the SDK retry; the status alone would not.
    route = () =>
      json({ error: { code: 400, status: 'FAILED_PRECONDITION', message: 'User location is not supported' } }, 400, noRetry);
    const err = await rejection(getAdapter('gemini').completeText(creds('gemini'), req()));
    expect(err.kind).toBe('bad_request');
    expect(seen).toHaveLength(1);
  });

  it('OpenRouter: a daily cap hours away is daily_limit; minutes away is not', async () => {
    const reset = (atMs: number) => ({ error: { code: 429, message: 'rate-limited', metadata: { headers: { 'X-RateLimit-Reset': String(atMs) } } } });
    const far = Date.now() + 6 * 60 * 60_000;
    route = () => json(reset(far), 429, noRetry);
    const err = await rejection(getAdapter('openrouter').ping(creds('openrouter'), 'x/y:free', new AbortController().signal));
    expect(err.kind).toBe('daily_limit');
    expect(Date.parse(err.resetAt!)).toBe(far);

    route = () => json(reset(Date.now() + 20_000), 429, noRetry);
    expect((await rejection(getAdapter('openrouter').ping(creds('openrouter'), 'x/y:free', new AbortController().signal))).kind).toBe('rate_limit');
  });

  it('OpenRouter: the key check reads a hint too, through the raw fetch', async () => {
    route = () =>
      json({ error: { code: 429, metadata: { headers: { 'X-RateLimit-Reset': String(Date.now() + 6 * 60 * 60_000) } } } }, 429, noRetry);
    const err = await rejection(getAdapter('openrouter').verify(creds('openrouter'), { signal: new AbortController().signal }));
    expect(err.kind).toBe('daily_limit');
  });

  it('nothing is read for a provider with no hints of its own', async () => {
    route = () => json(quota('GenerateRequestsPerDayPerProjectPerModel-FreeTier'), 429, noRetry);
    const err = await rejection(getAdapter('openai').ping(creds('openai'), 'gpt-5', new AbortController().signal));
    expect(err.kind).toBe('rate_limit');
  });
});

describe('Anthropic verify, list and describe', () => {
  const modelInfo = (id: string, effortLow: boolean | null, created = '2026-09-01T00:00:00Z') => ({
    id,
    type: 'model',
    display_name: `Claude ${id}`,
    created_at: created,
    max_input_tokens: 1_000_000,
    max_tokens: 128_000,
    capabilities: effortLow === null ? null : { effort: { supported: true, low: { supported: effortLow } } },
  });

  it('verify lists models with their low-effort capability, and defaults to claude-opus-5-5', async () => {
    route = () =>
      json({
        data: [modelInfo('claude-sonnet-5-5', true), modelInfo('claude-opus-5-5', true), modelInfo('claude-haiku-4-5', null), modelInfo('bad id', true)],
        has_more: false,
        first_id: 'a',
        last_id: 'b',
      });
    const adapter = getAdapter('anthropic');
    const result = await adapter.verify(creds('anthropic'), { signal: new AbortController().signal });
    const u = new URL(seen[0].url);
    expect(`${u.origin}${u.pathname}`).toBe('https://api.anthropic.com/v1/models');
    expect(u.searchParams.get('limit')).toBe('100');
    expect(result.listed).toBe(true);
    expect(result.models.map((m) => [m.id, m.effortLow, m.contextLength])).toEqual([
      ['claude-sonnet-5-5', true, 1_000_000],
      ['claude-opus-5-5', true, 1_000_000],
      ['claude-haiku-4-5', false, 1_000_000],
    ]);
    expect(result.models[0].label).toBe('Claude claude-sonnet-5-5');
    expect(adapter.pickDefaultModel(result)).toBe('claude-opus-5-5');
    expect(adapter.pickDefaultModel({ models: [{ id: 'claude-sonnet-5-5', label: 'S' }], listed: true })).toBe('claude-sonnet-5-5');
    expect(adapter.pickDefaultModel({ models: [], listed: true })).toBeNull();
  });

  it('auto-paginates', async () => {
    route = (r) =>
      new URL(r.url).searchParams.get('after_id')
        ? json({ data: [modelInfo('claude-haiku-4-5', false)], has_more: false, first_id: 'c', last_id: 'c' })
        : json({ data: [modelInfo('claude-opus-5-5', true)], has_more: true, first_id: 'a', last_id: 'claude-opus-5-5' });
    const result = await getAdapter('anthropic').listModels(creds('anthropic'), new AbortController().signal);
    expect(result.models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-haiku-4-5']);
    expect(seen).toHaveLength(2);
  });

  it('verify: 401 and 403 → auth', async () => {
    route = () => json({ type: 'error', error: { type: 'authentication_error', message: 'invalid' } }, 401);
    expect((await rejection(getAdapter('anthropic').verify(creds('anthropic'), { signal: new AbortController().signal }))).kind).toBe('auth');
    route = () => json({ type: 'error', error: { type: 'permission_error', message: 'no' } }, 403);
    expect((await rejection(getAdapter('anthropic').verify(creds('anthropic'), { signal: new AbortController().signal }))).kind).toBe('auth');
  });

  it('describeModel reads the low-effort capability; a 404 → bad_model', async () => {
    route = () => json(modelInfo('claude-opus-5-5', true));
    const adapter = getAdapter('anthropic');
    expect(await adapter.describeModel!(creds('anthropic'), 'claude-opus-5-5', new AbortController().signal)).toEqual({ effortLow: true });
    expect(seen[0].url).toBe('https://api.anthropic.com/v1/models/claude-opus-5-5');
    route = () => json(modelInfo('claude-3-haiku', null));
    expect(await adapter.describeModel!(creds('anthropic'), 'claude-3-haiku', new AbortController().signal)).toEqual({ effortLow: false });
    route = () => json({ type: 'error', error: { type: 'not_found_error', message: 'model: nope' } }, 404);
    expect((await rejection(adapter.describeModel!(creds('anthropic'), 'nope', new AbortController().signal))).kind).toBe('bad_model');
  });
});
