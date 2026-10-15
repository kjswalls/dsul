import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { checkWithApple, rotateAppleSecret } from '../../scripts/apple-secret-rotate.mjs';

/**
 * The unattended renewal of Supabase's Apple client secret
 * (scripts/apple-secret-rotate.mjs). It writes to production auth settings, so
 * every check that stands before the write is locked here: Apple must accept
 * the secret, and Supabase's provider must be the one expected, or nothing is
 * written.
 */

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const P8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ENABLED = { external_apple_enabled: true, external_apple_client_id: 'app.dsul.web,app.dsul.ios' };

function fakeFetch({ apple = json(400, { error: 'invalid_grant' }), config = json(200, ENABLED), patch = json(200, {}) } = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://appleid.apple.com/')) return apple.clone();
    if (init?.method === 'PATCH') return patch.clone();
    return config.clone();
  });
}

const ARGS = { teamId: 'TEAM123456', keyId: 'KEY1234567', privateKey: P8, accessToken: 'sbp_test' };
const patches = (fetch: ReturnType<typeof fakeFetch>) =>
  fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH');

describe('rotateAppleSecret', () => {
  it('writes only the Apple secret, to the dsul project', async () => {
    const fetch = fakeFetch();
    const { written } = await rotateAppleSecret({ ...ARGS, fetch });
    expect(written).toBe(true);
    const [[url, init]] = patches(fetch);
    expect(url).toBe('https://api.supabase.com/v1/projects/ctcspcferkdlzdcqlozq/config/auth');
    expect(Object.keys(JSON.parse(String(init?.body)))).toEqual(['external_apple_secret']);
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer sbp_test');
  });

  it('writes the same secret it showed Apple', async () => {
    const fetch = fakeFetch();
    await rotateAppleSecret({ ...ARGS, fetch });
    const appleBody = fetch.mock.calls.find(([url]) => String(url).startsWith('https://appleid.apple.com/'))?.[1]?.body;
    const shown = new URLSearchParams(String(appleBody)).get('client_secret');
    const [[, init]] = patches(fetch);
    expect(JSON.parse(String(init?.body)).external_apple_secret).toBe(shown);
  });

  it('writes nothing when Apple refuses the secret', async () => {
    const fetch = fakeFetch({ apple: json(400, { error: 'invalid_client' }) });
    await expect(rotateAppleSecret({ ...ARGS, fetch })).rejects.toThrow(/invalid_client/);
    expect(patches(fetch)).toHaveLength(0);
  });

  it('writes nothing when the provider is off', async () => {
    const fetch = fakeFetch({ config: json(200, { ...ENABLED, external_apple_enabled: false }) });
    await expect(rotateAppleSecret({ ...ARGS, fetch })).rejects.toThrow(/Nothing was written/);
    expect(patches(fetch)).toHaveLength(0);
  });

  it('writes nothing when the provider holds another Services ID', async () => {
    const fetch = fakeFetch({ config: json(200, { ...ENABLED, external_apple_client_id: 'app.other.web' }) });
    await expect(rotateAppleSecret({ ...ARGS, fetch })).rejects.toThrow(/expected "app.dsul.web"/);
    expect(patches(fetch)).toHaveLength(0);
  });

  it('writes nothing when the config cannot be read', async () => {
    const fetch = fakeFetch({ config: json(401, { message: 'unauthorized' }) });
    await expect(rotateAppleSecret({ ...ARGS, fetch })).rejects.toThrow(/401/);
    expect(patches(fetch)).toHaveLength(0);
  });

  it('fails when Supabase refuses the write', async () => {
    const fetch = fakeFetch({ patch: json(403, {}) });
    await expect(rotateAppleSecret({ ...ARGS, fetch })).rejects.toThrow(/403/);
  });

  it('checks everything and writes nothing on a dry run', async () => {
    const fetch = fakeFetch();
    const { written } = await rotateAppleSecret({ ...ARGS, fetch, dryRun: true });
    expect(written).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(patches(fetch)).toHaveLength(0);
  });
});

describe('checkWithApple', () => {
  it('fails on an answer it does not recognise', async () => {
    const fetch = fakeFetch({ apple: json(500, {}) });
    await expect(checkWithApple({ clientId: 'app.dsul.web', secret: 'x', fetch })).rejects.toThrow(/unexpectedly/);
  });
});
