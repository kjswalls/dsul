import { describe, it, expect, vi, afterEach } from 'vitest';

// The module reaches user_secrets through the service client, which throws
// without server env vars. It is stubbed rather than configured: the
// wire-format helpers never touch it, and getGatewayConfig's cases below hand
// it one canned answer per table.
type Answer = { data: Record<string, unknown> | null; error: { code?: string; message?: string; details?: string } | null };
const service = vi.hoisted(() => ({
  impl: null as null | (() => unknown),
  answers: {} as Record<string, Answer | Error>,
}));
vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: vi.fn(() => {
    if (!service.impl) throw new Error('not used in these tests');
    return service.impl();
  }),
}));

import {
  assertAllowedGatewayUrl,
  conversationSessionKey,
  deltaFromChunk,
  extractJsonObject,
  gatewayCompletion,
  GatewayConfigReadError,
  gatewayTurnMessages,
  getGatewayConfig,
  proposeSessionKey,
  translateGatewayStream,
} from '@/lib/openclaw-gateway';
import { parseSseFrames } from '@/lib/sse';

/**
 * This is the one place that knows the gateway's OpenAI-compatible wire shape,
 * and it is also the one piece of the transport that cannot be verified against
 * a real gateway from CI — so the translation is pinned here instead.
 */

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

/** Runs the translator and reads the result back through dsul's own parser. */
async function translated(...chunks: string[]): Promise<string[]> {
  const out: string[] = [];
  for await (const frame of parseSseFrames(translateGatewayStream(streamOf(...chunks)))) {
    if (frame.content !== undefined) out.push(frame.content);
  }
  return out;
}

const chunk = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

describe('deltaFromChunk', () => {
  it('pulls the incremental text out of an OpenAI-shaped chunk', () => {
    expect(deltaFromChunk({ choices: [{ delta: { content: 'hi' } }] })).toBe('hi');
  });

  it('returns empty for the shapes a stream legitimately contains', () => {
    // Role-only openers, finish chunks, usage chunks and keepalives all arrive
    // with no content and must not become empty frames downstream.
    expect(deltaFromChunk({ choices: [{ delta: { role: 'assistant' } }] })).toBe('');
    expect(deltaFromChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] })).toBe('');
    expect(deltaFromChunk({ choices: [] })).toBe('');
    expect(deltaFromChunk({ usage: { total_tokens: 12 } })).toBe('');
  });

  it('survives malformed payloads instead of throwing mid-stream', () => {
    expect(deltaFromChunk(null)).toBe('');
    expect(deltaFromChunk('nope')).toBe('');
    expect(deltaFromChunk({ choices: [{ delta: { content: 42 } }] })).toBe('');
    expect(deltaFromChunk({ choices: 'not-an-array' })).toBe('');
  });
});

describe('translateGatewayStream', () => {
  it('turns gateway chunks into dsul frames', async () => {
    expect(await translated(chunk('Hel'), chunk('lo'), 'data: [DONE]\n\n')).toEqual(['Hel', 'lo']);
  });

  it('reassembles chunks split across network boundaries', async () => {
    const whole = chunk('split');
    const cut = Math.floor(whole.length / 2);
    expect(await translated(whole.slice(0, cut), whole.slice(cut))).toEqual(['split']);
  });

  it('drops content-free chunks rather than emitting empty frames', async () => {
    const opener = `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`;
    const closer = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`;
    expect(await translated(opener, chunk('real'), closer, 'data: [DONE]\n\n')).toEqual(['real']);
  });

  it('skips unparseable lines and keeps going', async () => {
    expect(await translated('data: {oops\n\n', chunk('fine'), 'data: [DONE]\n\n')).toEqual(['fine']);
  });

  it('always terminates with [DONE], even when the gateway does not send one', async () => {
    // dsul's client parser stops on [DONE]; without one it would read to EOF.
    const decoder = new TextDecoder();
    const stream = translateGatewayStream(streamOf(chunk('a')));
    const reader = stream.getReader();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('emits a trailing chunk that arrived without its newline', async () => {
    expect(await translated(chunk('a').trimEnd())).toEqual(['a']);
  });

  it('passes content through verbatim, including markdown and newlines', async () => {
    const messy = '## Heading\n\n- item "quoted"\n\n```js\nconst a = 1;\n```';
    expect(await translated(chunk(messy), 'data: [DONE]\n\n')).toEqual([messy]);
  });
});

describe('session keys', () => {
  const C1 = '2f1d7c1e-8a4b-4c1e-9f0a-3b2c1d0e9f8a';
  const C2 = '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

  it('namespaces every key under dsul: — subagent:, cron: and acp: are reserved', () => {
    expect(conversationSessionKey('u1', C1)).toBe(`dsul:u:u1:chat:${C1}`);
  });

  it('keeps proposals off the conversation key', () => {
    // A proposal turn is a system prompt demanding JSON. Splicing that into the
    // user's own conversation would leave the next thing they said being
    // answered by a model that had just been told to reply in JSON only.
    expect(proposeSessionKey('u1')).toBe('dsul:u:u1:propose');
    expect(proposeSessionKey('u1')).not.toBe(conversationSessionKey('u1', C1));
  });

  it('is stable across calls, which is what makes a conversation durable', () => {
    expect(conversationSessionKey('u1', C1)).toBe(conversationSessionKey('u1', C1));
  });

  it('gives every conversation its own session, so a new chat is new on OpenClaw', () => {
    expect(conversationSessionKey('u1', C1)).not.toBe(conversationSessionKey('u1', C2));
  });

  it('separates users, so one browser can never address another user’s session', () => {
    expect(conversationSessionKey('u1', C1)).not.toBe(conversationSessionKey('u2', C1));
  });

  it('cannot be pushed into a reserved namespace by hostile input', () => {
    // Keys are built from a fixed literal, so even an id that looks like a
    // reserved prefix stays under dsul:. This is why nothing accepts a
    // caller-supplied session key (and the route also refuses a non-UUID id).
    for (const hostile of ['subagent:evil', 'cron:evil', 'acp:evil', '../../cron:evil']) {
      expect(conversationSessionKey(hostile, C1).startsWith('dsul:')).toBe(true);
      expect(conversationSessionKey('u1', hostile).startsWith('dsul:')).toBe(true);
      expect(proposeSessionKey(hostile).startsWith('dsul:')).toBe(true);
    }
  });
});

describe('assertAllowedGatewayUrl', () => {
  it('accepts an https gateway', () => {
    expect(assertAllowedGatewayUrl('https://gw.example.ts.net')).toEqual({
      ok: true,
      url: 'https://gw.example.ts.net',
    });
  });

  it('strips a trailing slash so path concatenation stays correct', () => {
    const result = assertAllowedGatewayUrl('https://gw.example.ts.net/');
    expect(result).toMatchObject({ ok: true, url: 'https://gw.example.ts.net' });
  });

  it('blocks the cloud metadata range', () => {
    // A server-side fetch of 169.254.169.254 would hand over instance credentials.
    expect(assertAllowedGatewayUrl('http://169.254.169.254/latest/meta-data/').ok).toBe(false);
    expect(assertAllowedGatewayUrl('https://169.254.169.254').ok).toBe(false);
  });

  it('blocks the IPv4-mapped IPv6 form of the metadata address', () => {
    // The WHATWG parser normalises decimal/octal/hex/trailing-dot IPv4 back to
    // dotted quad, but NOT this form — and it reaches the same address.
    expect(assertAllowedGatewayUrl('https://[::ffff:169.254.169.254]').ok).toBe(false);
    expect(assertAllowedGatewayUrl('https://[::ffff:a9fe:a9fe]').ok).toBe(false);
  });

  it('blocks the trailing-dot spelling of a metadata host', () => {
    expect(assertAllowedGatewayUrl('https://169.254.169.254.').ok).toBe(false);
  });

  it('catches the octal spelling, which the URL parser folds to a dotted quad', () => {
    expect(assertAllowedGatewayUrl('https://0251.0376.0251.0376').ok).toBe(false);
  });

  it('blocks the whole link-local /16, not just the famous address', () => {
    expect(assertAllowedGatewayUrl('https://169.254.1.1').ok).toBe(false);
    expect(assertAllowedGatewayUrl('https://[::ffff:169.254.1.1]').ok).toBe(false);
  });

  it('refuses credentials embedded in the URL', () => {
    // user_settings is browser-readable; a token in the URL would land there.
    //
    // The userinfo stays the generic `user:pass` placeholder that
    // reminders-channels.test.ts already uses for this same assertion. A
    // plausible-looking pair here reads as a real credential to a secret
    // scanner and fails the security check on every PR that touches this file.
    const result = assertAllowedGatewayUrl('https://user:pass@gw.example.ts.net:8787');
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/token field/);
  });

  it('allows private and Tailscale ranges — that is the intended deployment', () => {
    expect(assertAllowedGatewayUrl('https://100.101.102.103:8787').ok).toBe(true);
    expect(assertAllowedGatewayUrl('https://192.168.1.50:8787').ok).toBe(true);
  });

  it('requires https except on loopback in development', () => {
    expect(assertAllowedGatewayUrl('http://gw.example.com').ok).toBe(false);
    expect(assertAllowedGatewayUrl('http://localhost:8787').ok).toBe(true);
    expect(assertAllowedGatewayUrl('http://127.0.0.1:8787').ok).toBe(true);
  });

  it('rejects non-http schemes and junk', () => {
    for (const bad of ['file:///etc/passwd', 'ftp://x.com', 'javascript:alert(1)', 'not a url', '']) {
      expect(assertAllowedGatewayUrl(bad).ok).toBe(false);
    }
  });
});

describe('gatewayTurnMessages', () => {
  const messages = [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: 'first' },
    { role: 'assistant' as const, content: 'reply' },
    { role: 'user' as const, content: 'newest' },
  ];

  it('sends the system prompt plus only the newest turn', () => {
    // The gateway session already holds the history; resending it would make
    // the model see every message twice. See SEND_FULL_TRANSCRIPT_TO_GATEWAY.
    expect(gatewayTurnMessages(messages)).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'newest' },
    ]);
  });

  it('handles a first turn with no history', () => {
    expect(gatewayTurnMessages([messages[0], messages[1]])).toEqual([messages[0], messages[1]]);
  });
});

describe('assertAllowedGatewayUrl — metadata spellings', () => {
  /**
   * The WHATWG parser folds octal/decimal/hex/trailing-dot IPv4 back to a
   * dotted quad, so those never needed decoding. IPv4 riding inside IPv6 does,
   * and there is more than one prefix that carries it.
   */
  const blocked = [
    'https://169.254.169.254/',
    'https://[::ffff:169.254.169.254]/',
    'https://[::ffff:a9fe:a9fe]/',
    // IPv4-compatible: deprecated, still routable, previously allowed.
    'https://[::a9fe:a9fe]/',
    // NAT64 well-known prefix — on IPv6-only egress this really is translated
    // to 169.254.169.254, which makes it the one that could actually bite.
    'https://[64:ff9b::a9fe:a9fe]/',
    'https://[64:ff9b::169.254.169.254]/',
    'https://fd00:ec2::254/',
    // Resolves to the metadata address by NAME; no literal-IP test sees it.
    'https://metadata.google.internal/',
    'https://anything.internal/',
  ];

  it.each(blocked)('refuses %s', (url) => {
    const result = assertAllowedGatewayUrl(url);
    expect(result.ok).toBe(false);
  });

  const allowed = [
    // A tailnet address is the intended deployment — private ranges and CGNAT
    // must keep working, or the guard rejects the correct configuration.
    'https://100.64.1.5:8080',
    'https://192.168.1.10',
    'https://10.0.0.7',
    'https://gateway.example.com',
    // Not link-local: 169.253 and 169.255 are ordinary addresses.
    'https://[::ffff:a9fd:a9fd]/',
    'https://[::1234:5678]/',
  ];

  it.each(allowed)('still allows %s', (url) => {
    expect(assertAllowedGatewayUrl(url).ok).toBe(true);
  });
});

describe('extractJsonObject', () => {
  /**
   * The OpenAI branch can demand `json_object` and get it. A gateway agent is
   * whatever model the user put behind whatever system prompt, so the reply is
   * only probably JSON — and every shape below reads to the user as "the
   * assistant is broken" if it is not recovered.
   */
  const draft = { summary: 'Move three things', operations: [] };

  it('parses a bare object', () => {
    expect(extractJsonObject(JSON.stringify(draft))).toEqual(draft);
  });

  it('recovers JSON from a markdown fence', () => {
    expect(extractJsonObject('```json\n' + JSON.stringify(draft) + '\n```')).toEqual(draft);
  });

  it('recovers JSON behind a preamble and a sign-off', () => {
    const raw = `Sure! Here's the plan:\n${JSON.stringify(draft)}\nLet me know if that works.`;
    expect(extractJsonObject(raw)).toEqual(draft);
  });

  it('tolerates surrounding whitespace', () => {
    expect(extractJsonObject(`\n\n  ${JSON.stringify(draft)}  \n`)).toEqual(draft);
  });

  it('returns null rather than throwing on prose, emptiness or broken JSON', () => {
    // Upstream treats "nothing to suggest" as a normal outcome, and an
    // unparseable reply is indistinguishable from one.
    expect(extractJsonObject('I could not think of anything.')).toBeNull();
    expect(extractJsonObject('')).toBeNull();
    expect(extractJsonObject('   ')).toBeNull();
    expect(extractJsonObject('{ "summary": ')).toBeNull();
    expect(extractJsonObject('}{')).toBeNull();
  });

  it('keeps nested braces intact', () => {
    const nested = { summary: 's', operations: [{ kind: 'update', itemId: 'a' }] };
    expect(extractJsonObject(`text ${JSON.stringify(nested)} text`)).toEqual(nested);
  });
});

describe('gatewayCompletion', () => {
  // vitest is not configured with `unstubGlobals`, so a stubbed fetch would
  // outlive this block and silently answer anything added after it.
  afterEach(() => vi.unstubAllGlobals());

  const config = { baseUrl: 'https://gw.example.com', token: 'tok', agentId: 'dsul' };
  const messages = [{ role: 'user' as const, content: 'hi' }];

  function mockFetch(impl: (url: string, init: RequestInit) => unknown) {
    const spy = vi.fn(async (url: string, init: RequestInit) => impl(url, init));
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  const ok = (content: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  });

  it('posts a non-streaming turn to the completions endpoint with the session key', async () => {
    const spy = mockFetch(() => ok('{}'));
    await gatewayCompletion({ config, messages, sessionKey: 'dsul:u:u1:propose' });

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('https://gw.example.com/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers['x-openclaw-session-key']).toBe('dsul:u:u1:propose');
    // A redirect would bounce this authenticated request — bearer token and all
    // — at a host the URL guard never saw.
    expect(init.redirect).toBe('error');
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(false);
    expect(body.model).toBe('dsul');
    // `response_format` is an OpenAI parameter an arbitrary agent may reject
    // outright, and a rejected request yields nothing at all to recover from.
    expect(body).not.toHaveProperty('response_format');
  });

  it('returns the assistant text', async () => {
    mockFetch(() => ok('{"summary":"ok"}'));
    await expect(
      gatewayCompletion({ config, messages, sessionKey: 'k' })
    ).resolves.toBe('{"summary":"ok"}');
  });

  it('refuses a gateway URL the guard rejects, before any request goes out', async () => {
    const spy = mockFetch(() => ok('{}'));
    await expect(
      gatewayCompletion({
        config: { ...config, baseUrl: 'http://169.254.169.254' },
        messages,
        sessionKey: 'k',
      })
    ).rejects.toThrow(/not allowed/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports status only — the upstream body can carry gateway config detail', async () => {
    mockFetch(() => ({
      ok: false,
      status: 502,
      json: async () => ({ error: 'agent "secret-internal-name" is down' }),
    }));
    await expect(
      gatewayCompletion({ config, messages, sessionKey: 'k' })
    ).rejects.toThrow('Gateway responded 502');
  });

  it('degrades to empty text on a shape it does not recognise', async () => {
    for (const payload of [{}, { choices: [] }, { choices: [{ message: {} }] }, { choices: [{ message: { content: 42 } }] }]) {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })));
      await expect(gatewayCompletion({ config, messages, sessionKey: 'k' })).resolves.toBe('');
    }
  });
});

describe('getGatewayConfig', () => {
  /** A service client whose two reads answer from `service.answers`, keyed by table. */
  function serve(answers: Record<string, Answer | Error>) {
    service.answers = answers;
    service.impl = () => ({
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              const a = service.answers[table];
              if (a instanceof Error) throw a;
              return a ?? { data: null, error: null };
            },
          }),
        }),
      }),
    });
  }

  const SETTINGS = { openclaw_gateway_url: 'https://gw.example.ts.net/', openclaw_agent_id: 'kirby-1' };
  const SECRETS = { openclaw_gateway_token: 'tok-SENTINEL' };

  afterEach(() => {
    service.impl = null;
    service.answers = {};
  });

  it('returns the config, trailing slash trimmed, when both halves are there', async () => {
    serve({
      user_settings: { data: SETTINGS, error: null },
      user_secrets: { data: SECRETS, error: null },
    });
    await expect(getGatewayConfig('u1')).resolves.toEqual({
      baseUrl: 'https://gw.example.ts.net',
      token: 'tok-SENTINEL',
      agentId: 'kirby-1',
    });
  });

  it('is null when a row or a value is missing', async () => {
    serve({ user_settings: { data: null, error: null }, user_secrets: { data: SECRETS, error: null } });
    await expect(getGatewayConfig('u1')).resolves.toBeNull();
    serve({ user_settings: { data: SETTINGS, error: null }, user_secrets: { data: null, error: null } });
    await expect(getGatewayConfig('u1')).resolves.toBeNull();
    serve({
      user_settings: { data: { ...SETTINGS, openclaw_gateway_url: null }, error: null },
      user_secrets: { data: SECRETS, error: null },
    });
    await expect(getGatewayConfig('u1')).resolves.toBeNull();
  });

  it.each(['42P01', 'PGRST205', '42703', 'PGRST204'])(
    'is null when the schema is missing (%s): nothing is configured yet',
    async (code) => {
      serve({
        user_settings: { data: null, error: { code, message: 'relation does not exist' } },
        user_secrets: { data: SECRETS, error: null },
      });
      await expect(getGatewayConfig('u1')).resolves.toBeNull();
    }
  );

  it.each(['user_settings', 'user_secrets'])(
    'throws GatewayConfigReadError, carrying no database text, when %s cannot be read',
    async (table) => {
      serve({
        user_settings: { data: SETTINGS, error: null },
        user_secrets: { data: SECRETS, error: null },
        [table]: { data: null, error: { code: 'PGRST301', message: 'JWT expired SENTINEL', details: 'SENTINEL' } },
      });
      const err = await getGatewayConfig('u1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GatewayConfigReadError);
      expect(String((err as Error).message)).not.toContain('SENTINEL');
      expect(JSON.stringify(err)).not.toContain('SENTINEL');
    }
  );

  it('throws GatewayConfigReadError when a read rejects outright', async () => {
    serve({ user_settings: new Error('fetch failed SENTINEL'), user_secrets: { data: SECRETS, error: null } });
    const err = await getGatewayConfig('u1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayConfigReadError);
    expect((err as Error).message).not.toContain('SENTINEL');
  });

  it('throws GatewayConfigReadError when the service client cannot be built', async () => {
    service.impl = null; // createServiceClient throws, as it does without SUPABASE_SECRET_KEY
    await expect(getGatewayConfig('u1')).rejects.toBeInstanceOf(GatewayConfigReadError);
  });
});
