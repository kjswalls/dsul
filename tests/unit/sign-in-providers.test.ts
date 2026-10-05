import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROVIDERS_RETRY_MS,
  PROVIDERS_TTL_MS,
  __resetSignInProvidersForTests,
  signInProviders,
} from '@/lib/sign-in-providers';

/**
 * The login page's Apple button follows GoTrue's public /auth/v1/settings, and
 * fails closed: anything short of a clear `external.apple: true` hides it.
 */

const URL_ = 'https://project.supabase.co';
const KEY = 'anon-key';
const T0 = 1_800_000_000_000;

const fetchMock = vi.fn();

function settings(external: Record<string, unknown>) {
  return new Response(JSON.stringify({ external, disable_signup: false }), { status: 200 });
}

beforeEach(() => {
  __resetSignInProvidersForTests();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', URL_);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', KEY);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('signInProviders', () => {
  it('asks GoTrue settings with the anon key and reads Apple from `external`', async () => {
    fetchMock.mockResolvedValue(settings({ google: true, apple: true }));
    await expect(signInProviders(T0)).resolves.toEqual({ apple: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${URL_}/auth/v1/settings`);
    expect(init.headers).toEqual({ apikey: KEY });
    expect(init.cache).toBe('no-store');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('hides Apple while the provider is off', async () => {
    fetchMock.mockResolvedValue(settings({ google: true, apple: false }));
    await expect(signInProviders(T0)).resolves.toEqual({ apple: false });
  });

  it.each([
    ['a non-2xx answer', () => new Response('nope', { status: 500 })],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    ['a body with no `external`', () => new Response('{}', { status: 200 })],
    ['a truthy value that is not true', () => settings({ apple: 'true' })],
  ])('fails closed on %s', async (_, response) => {
    fetchMock.mockResolvedValue(response());
    await expect(signInProviders(T0)).resolves.toEqual({ apple: false });
  });

  it('fails closed when the request throws or times out', async () => {
    fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    await expect(signInProviders(T0)).resolves.toEqual({ apple: false });
  });

  it('asks nothing without the Supabase env', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
    await expect(signInProviders(T0)).resolves.toEqual({ apple: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps an answer for the TTL, then asks again', async () => {
    fetchMock.mockResolvedValue(settings({ apple: false }));
    await signInProviders(T0);
    fetchMock.mockResolvedValue(settings({ apple: true }));
    await expect(signInProviders(T0 + PROVIDERS_TTL_MS - 1)).resolves.toEqual({ apple: false });
    expect(fetchMock).toHaveBeenCalledOnce();
    await expect(signInProviders(T0 + PROVIDERS_TTL_MS)).resolves.toEqual({ apple: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a failure only briefly', async () => {
    fetchMock.mockRejectedValue(new Error('down'));
    await signInProviders(T0);
    fetchMock.mockResolvedValue(settings({ apple: true }));
    await expect(signInProviders(T0 + PROVIDERS_RETRY_MS - 1)).resolves.toEqual({ apple: false });
    await expect(signInProviders(T0 + PROVIDERS_RETRY_MS)).resolves.toEqual({ apple: true });
  });
});
