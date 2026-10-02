import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/app/config/route';

/**
 * GET /api/app/config — where the iPhone app learns which Supabase to sign in
 * against. Public by design (both values ship in the web bundle), so the one
 * thing worth locking is that it can never be the route that leaks the
 * service-role key sitting in the same environment.
 */

const SECRET = 'sb_secret_do-not-ship-this-0123456789';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('/api/app/config', () => {
  it('serves the URL and anon key, cacheable for an hour', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://ref.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'sb_publishable_abc');
    vi.stubEnv('SUPABASE_SECRET_KEY', SECRET);

    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ supabaseUrl: 'https://ref.supabase.co', anonKey: 'sb_publishable_abc' });
    expect(text).not.toContain(SECRET);
  });

  it.each([
    ['the URL', 'NEXT_PUBLIC_SUPABASE_URL'],
    ['the anon key', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'],
  ])('503s without %s, and never falls back to the secret', async (_, missing) => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://ref.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'sb_publishable_abc');
    vi.stubEnv('SUPABASE_SECRET_KEY', SECRET);
    vi.stubEnv(missing, '');

    const res = GET();
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'unavailable' });
    expect(text).not.toContain(SECRET);
    expect(res.headers.get('cache-control') ?? '').not.toMatch(/public/);
  });
});
