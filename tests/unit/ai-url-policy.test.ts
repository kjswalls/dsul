// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '@/lib/ai-server/errors';
import {
  CUSTOM_RESPONSE_CAPS,
  assertPublicHost,
  checkModelBaseUrl,
  guardedFetch,
  isBlockedAddress,
  type LookupFn,
} from '@/lib/ai-server/url-policy';

/**
 * "Other" lets a user type any base URL, and the server then sends that user's
 * key to it and reads whatever comes back (design 1.4, decision 6). Every
 * request is pinned to one origin, refuses redirects, resolves only to public
 * addresses, and a custom host's body is byte-capped.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('checkModelBaseUrl', () => {
  it.each([
    ['http', 'http://api.example.com/v1', 'not_https'],
    ['userinfo', 'https://user:pass@api.example.com/v1', 'credentials'],
    ['user only', 'https://user@api.example.com/v1', 'credentials'],
    ['query', 'https://api.example.com/v1?x=1', 'query'],
    ['bare ?', 'https://api.example.com/v1?', 'query'],
    ['hash', 'https://api.example.com/v1#frag', 'query'],
    ['localhost', 'https://localhost/v1', 'blocked_host'],
    ['x.localhost', 'https://x.localhost/v1', 'blocked_host'],
    ['127.0.0.1', 'https://127.0.0.1/v1', 'blocked_address'],
    ['0x7f.1', 'https://0x7f.1/v1', 'blocked_address'],
    ['2130706433', 'https://2130706433/v1', 'blocked_address'],
    ['[::1]', 'https://[::1]/v1', 'blocked_address'],
    ['[::ffff:127.0.0.1]', 'https://[::ffff:127.0.0.1]/v1', 'blocked_address'],
    ['[::ffff:7f00:1]', 'https://[::ffff:7f00:1]/v1', 'blocked_address'],
    ['10/8', 'https://10.1.2.3/v1', 'blocked_address'],
    ['172.16/12', 'https://172.20.0.1/v1', 'blocked_address'],
    ['192.168/16', 'https://192.168.1.1/v1', 'blocked_address'],
    ['100.64/10', 'https://100.100.100.100/v1', 'blocked_address'],
    ['metadata IP', 'https://169.254.169.254/latest', 'blocked_address'],
    ['metadata name', 'https://metadata.google.internal/computeMetadata', 'blocked_host'],
    ['[fd00::1]', 'https://[fd00::1]/v1', 'blocked_address'],
    ['[fe80::1]', 'https://[fe80::1]/v1', 'blocked_address'],
    ['[64:ff9b::7f00:1]', 'https://[64:ff9b::7f00:1]/v1', 'blocked_address'],
    ['a.local', 'https://a.local/v1', 'blocked_host'],
    ['a.internal', 'https://a.internal/v1', 'blocked_host'],
    ['a.home.arpa', 'https://nas.home.arpa/v1', 'blocked_host'],
    ['a.lan', 'https://router.lan/v1', 'blocked_host'],
    ['single label', 'https://gateway/v1', 'blocked_host'],
    ['single label, trailing dot', 'https://gateway./v1', 'blocked_host'],
    ['metadata', 'https://metadata/v1', 'blocked_host'],
    ['not a URL', 'not a url', 'invalid'],
    ['empty', '', 'invalid'],
  ])('rejects %s', (_label, url, reason) => {
    expect(checkModelBaseUrl(url)).toEqual({ ok: false, reason });
  });

  it('rejects a non-string and an over-long URL', () => {
    expect(checkModelBaseUrl(undefined)).toEqual({ ok: false, reason: 'invalid' });
    expect(checkModelBaseUrl(42)).toEqual({ ok: false, reason: 'invalid' });
    expect(checkModelBaseUrl(`https://api.example.com/${'a'.repeat(2049)}`)).toEqual({
      ok: false,
      reason: 'too_long',
    });
  });

  it.each([
    ['Groq', 'https://api.groq.com/openai/v1/chat/completions', 'https://api.groq.com/openai/v1'],
    ['Mistral', 'https://api.mistral.ai/v1/', 'https://api.mistral.ai/v1'],
    ['DeepSeek', 'https://api.deepseek.com', 'https://api.deepseek.com'],
    ['DeepSeek /models', 'https://api.deepseek.com/v1/models', 'https://api.deepseek.com/v1'],
    ['explicit port', 'https://llm.example.com:8443/v1/', 'https://llm.example.com:8443/v1'],
    ['default port folded', 'https://api.together.xyz:443/v1', 'https://api.together.xyz/v1'],
    ['mixed case host', 'https://API.Fireworks.ai/inference/v1', 'https://api.fireworks.ai/inference/v1'],
  ])('accepts and normalizes %s', (_label, url, baseUrl) => {
    const r = checkModelBaseUrl(url);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.baseUrl).toBe(baseUrl);
      expect(r.origin).toBe(new URL(baseUrl).origin);
      // The 053 CHECK on base_url.
      expect(r.baseUrl).toMatch(/^https:\/\/[^/?#@\s]+/);
    }
  });

  it('accepts a public IP literal', () => {
    expect(checkModelBaseUrl('https://8.8.8.8/v1')).toMatchObject({ ok: true, baseUrl: 'https://8.8.8.8/v1' });
  });
});

describe('isBlockedAddress', () => {
  it('does not block the public internet (guards the ::ffff:0:0/96 mistake)', () => {
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('1.1.1.1')).toBe(false);
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false);
    expect(isBlockedAddress('2001:4860:4860::8888')).toBe(false);
  });

  it.each([
    '0.0.0.0',
    '127.0.0.1',
    '10.0.0.1',
    '100.64.0.1',
    '169.254.169.254',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.1',
    '192.168.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::7f00:1',
    '64:ff9b::7f00:1',
    '2001:db8::1',
    '2002::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%eth0',
    'ff02::1',
    '[::1]',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it('fails closed on anything that is not an address', () => {
    expect(isBlockedAddress('example.com')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});

describe('assertPublicHost', () => {
  const lookupOf =
    (...addresses: string[]): LookupFn =>
    async () =>
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

  it('passes when every address is public', async () => {
    await expect(assertPublicHost('api.example.com', lookupOf('8.8.8.8', '2001:4860:4860::8888'))).resolves.toBeUndefined();
  });

  it('[public, private] → blocked_url', async () => {
    const err = await rejectionOf(assertPublicHost('rebind.example.com', lookupOf('8.8.8.8', '10.0.0.5')));
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('blocked_url');
  });

  it('a lookup error → network', async () => {
    const err = await rejectionOf(
      assertPublicHost('nx.example.com', async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      })
    );
    expect((err as ProviderError).kind).toBe('network');
  });

  it('an empty answer → network', async () => {
    const err = await rejectionOf(assertPublicHost('empty.example.com', lookupOf()));
    expect((err as ProviderError).kind).toBe('network');
  });

  it('a lookup that never answers times out as network after 3 s', async () => {
    vi.useFakeTimers();
    try {
      const p = rejectionOf(assertPublicHost('slow.example.com', () => new Promise(() => {})));
      await vi.advanceTimersByTimeAsync(3_001);
      expect(((await p) as ProviderError).kind).toBe('network');
    } finally {
      vi.useRealTimers();
    }
  });

  it('checks IP literals without a lookup', async () => {
    const lookup = vi.fn(lookupOf('8.8.8.8'));
    await expect(assertPublicHost('[::1]', lookup)).rejects.toMatchObject({ kind: 'blocked_url' });
    await expect(assertPublicHost('8.8.4.4', lookup)).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('guardedFetch', () => {
  const ok = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });

  it('an origin mismatch throws before fetch is called', async () => {
    const fetchSpy = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchSpy);
    const f = guardedFetch({ origin: 'https://api.example.com', checkDns: false });
    const err = await rejectionOf(f('https://elsewhere.example.com/v1/models'));
    expect((err as ProviderError).kind).toBe('blocked_url');
    const err2 = await rejectionOf(f('http://api.example.com/v1/models'));
    expect((err2 as ProviderError).kind).toBe('blocked_url');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes redirect: 'error' and keeps the caller's init", async () => {
    const fetchSpy = vi.fn<(...args: unknown[]) => Promise<Response>>(async () => ok());
    vi.stubGlobal('fetch', fetchSpy);
    const f = guardedFetch({ origin: 'https://api.example.com', checkDns: false });
    await f('https://api.example.com/v1/models', { method: 'POST', redirect: 'follow', body: 'x' });
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.redirect).toBe('error');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('x');
  });

  it('accepts URL and Request inputs', async () => {
    const fetchSpy = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchSpy);
    const f = guardedFetch({ origin: 'https://api.example.com', checkDns: false });
    await f(new URL('https://api.example.com/v1/models'));
    await f(new Request('https://api.example.com/v1/models'));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await expect(f(new Request('https://other.example.com/'))).rejects.toMatchObject({ kind: 'blocked_url' });
  });

  it('runs the DNS check when asked, before fetching', async () => {
    const fetchSpy = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchSpy);
    const f = guardedFetch({
      origin: 'https://llm.example.com',
      checkDns: true,
      lookup: async () => [{ address: '192.168.1.20', family: 4 }],
    });
    await expect(f('https://llm.example.com/v1/models')).rejects.toMatchObject({ kind: 'blocked_url' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the header allowlist drops an injected header', async () => {
    const fetchSpy = vi.fn<(...args: unknown[]) => Promise<Response>>(async () => ok());
    vi.stubGlobal('fetch', fetchSpy);
    const f = guardedFetch({
      origin: 'https://api.anthropic.com',
      checkDns: false,
      headerAllowlist: (n) => ['x-api-key', 'content-type'].includes(n),
    });
    await f('https://api.anthropic.com/v1/messages', {
      headers: { 'X-Api-Key': 'k', 'Content-Type': 'application/json', 'X-Leak': 'SENTINEL' },
    });
    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('x-api-key')).toBe('k');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.has('x-leak')).toBe(false);
  });

  describe('body cap (review 2)', () => {
    const MB = 1_000_000;

    /** A body streamed in 64 KB chunks with no newline anywhere. */
    function streamOf(bytes: number, onPull?: () => void): ReadableStream<Uint8Array> {
      const chunk = new Uint8Array(64 * 1024).fill(0x61);
      let sent = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          onPull?.();
          if (sent >= bytes) {
            controller.close();
            return;
          }
          const n = Math.min(chunk.byteLength, bytes - sent);
          controller.enqueue(chunk.subarray(0, n));
          sent += n;
        },
      });
    }

    const capped = (res: Response) => {
      vi.stubGlobal('fetch', vi.fn(async () => res));
      return guardedFetch({
        origin: 'https://llm.example.com',
        checkDns: false,
        maxResponseBytes: CUSTOM_RESPONSE_CAPS,
      })('https://llm.example.com/v1/models');
    };

    it('5 MB of JSON content-type with no newline makes res.json() reject with upstream', async () => {
      let pulls = 0;
      const res = await capped(
        new Response(streamOf(5 * MB, () => pulls++), { headers: { 'content-type': 'application/json' } })
      );
      const err = await rejectionOf(res.json());
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind).toBe('upstream');
      // The source stopped being read shortly after the 2 MB cap.
      expect(pulls * 64 * 1024).toBeLessThan(3 * MB);
    });

    it('a text/event-stream body is cut at 4 MB the same way', async () => {
      const res = await capped(
        new Response(streamOf(5 * MB), { headers: { 'content-type': 'text/event-stream' } })
      );
      const reader = res.body!.getReader();
      let total = 0;
      const err = await rejectionOf(
        (async () => {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            total += value.byteLength;
          }
        })()
      );
      expect((err as ProviderError).kind).toBe('upstream');
      expect(total).toBeGreaterThan(3 * MB);
      expect(total).toBeLessThanOrEqual(CUSTOM_RESPONSE_CAPS.stream);
    });

    it('a 3 MB event stream passes (the stream cap, not the body cap, applies)', async () => {
      const res = await capped(
        new Response(streamOf(3 * MB), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
      );
      expect((await res.arrayBuffer()).byteLength).toBe(3 * MB);
    });

    it('a 1 MB body passes byte-for-byte with status and headers intact', async () => {
      const payload = new Uint8Array(MB);
      for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
      const res = await capped(
        new Response(payload, { status: 201, statusText: 'Created', headers: { 'content-type': 'application/json', 'x-request-id': 'r1' } })
      );
      expect(res.status).toBe(201);
      expect(res.statusText).toBe('Created');
      expect(res.headers.get('x-request-id')).toBe('r1');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(payload);
    });

    it('caps an error body too', async () => {
      const res = await capped(
        new Response(streamOf(5 * MB), { status: 500, headers: { 'content-type': 'application/json' } })
      );
      expect(res.status).toBe(500);
      await expect(res.text()).rejects.toMatchObject({ kind: 'upstream' });
    });

    it('a 204 is returned untouched', async () => {
      const original = new Response(null, { status: 204 });
      const res = await capped(original);
      expect(res).toBe(original);
    });

    it('without maxResponseBytes nothing is wrapped', async () => {
      const original = new Response(streamOf(5 * MB), { headers: { 'content-type': 'application/json' } });
      vi.stubGlobal('fetch', vi.fn(async () => original));
      const res = await guardedFetch({ origin: 'https://api.openai.com', checkDns: false })(
        'https://api.openai.com/v1/models'
      );
      expect(res).toBe(original);
      await res.body?.cancel();
    });
  });
});
