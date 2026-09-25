import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';

// The canonical redirect has to run before the auth gate's early returns, so
// these requests never need a Supabase to answer.
afterEach(() => vi.unstubAllEnvs());

describe('proxy canonical redirect', () => {
  it('sends a production Site URL fallback on the alias to the callback on do.dsul.app', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_DISABLE_AUTH', 'true');
    const res = await proxy(new NextRequest('https://v0-anchor-plum.vercel.app/?code=abc'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://do.dsul.app/auth/callback?code=abc');
  });

  it('keeps path and query on a production page request', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_DISABLE_AUTH', 'true');
    const res = await proxy(new NextRequest('https://v0-anchor-plum.vercel.app/login?a=1'));
    expect(res.headers.get('location')).toBe('https://do.dsul.app/login?a=1');
  });

  it('leaves API routes on the alias alone', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_DISABLE_AUTH', 'true');
    const res = await proxy(new NextRequest('https://v0-anchor-plum.vercel.app/api/cron/reminders'));
    expect(res.headers.get('location')).toBeNull();
  });

  it('leaves a preview deployment alone', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('NEXT_PUBLIC_DISABLE_AUTH', 'true');
    const res = await proxy(new NextRequest('https://dsul-git-x-kirby.vercel.app/login'));
    expect(res.headers.get('location')).toBeNull();
  });
});
