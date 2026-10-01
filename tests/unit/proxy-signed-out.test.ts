import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { NextRequest } from 'next/server';
import { config, proxy } from '@/proxy';

// The auth gate, for a request with no session cookie. getUser answers that
// with AuthSessionMissingError before any fetch, so none of these needs a
// Supabase to answer; the URL is a closed loopback port all the same, so a
// regression that did reach for the network fails here instead of reaching out.
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:1');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
  vi.stubEnv('NEXT_PUBLIC_DISABLE_AUTH', '');
  vi.stubEnv('VERCEL_ENV', 'production');
});
afterEach(() => vi.unstubAllEnvs());

async function signedOut(path: string) {
  const res = await proxy(new NextRequest(`https://do.dsul.app${path}`));
  return { status: res.status, location: res.headers.get('location') };
}

describe('proxy auth gate, signed out', () => {
  it('sends / to bare /login', async () => {
    expect(await signedOut('/')).toEqual({ status: 307, location: 'https://do.dsul.app/login' });
  });

  it('carries any other page as ?redirect=, instead of dropping it', async () => {
    expect((await signedOut('/goal/g1?x=1')).location).toBe(
      'https://do.dsul.app/login?redirect=%2Fgoal%2Fg1%3Fx%3D1'
    );
  });

  it('keeps the OpenClaw pairing code inside the redirect, not beside it', async () => {
    // It used to arrive as /login?code=…, which a sign-in dropped and the
    // desktop shell refused outright as an auth code.
    const { location } = await signedOut('/connect?code=ABCD1234');
    expect(location).toBe('https://do.dsul.app/login?redirect=%2Fconnect%3Fcode%3DABCD1234');
    expect(new URL(location!).searchParams.has('code')).toBe(false);
  });

  it("drops Next's _rsc from what it carries", async () => {
    expect((await signedOut('/settings?_rsc=zz')).location).toBe(
      'https://do.dsul.app/login?redirect=%2Fsettings'
    );
  });

  it.each(['/login', '/login?redirect=%2Fgoal%2Fg1', '/auth/callback?code=x', '/auth/desktop', '/api/x'])(
    'lets %s through',
    async (path) => {
      expect((await signedOut(path)).location).toBeNull();
    }
  );

  it('still gates nothing under NEXT_PUBLIC_DISABLE_AUTH=true (that switch is a separate decision)', async () => {
    vi.stubEnv('NEXT_PUBLIC_DISABLE_AUTH', 'true');
    expect(await signedOut('/goal/g1')).toEqual({ status: 200, location: null });
  });
});

// The matcher, through Next's own reading of it: calling proxy() above skips
// the matcher altogether, so it cannot say which requests never reach the gate.
describe('proxy matcher', () => {
  async function gated(path: string) {
    // The helper's import reaches for the AsyncLocalStorage a Next server puts
    // on globalThis, which jsdom has none of.
    const g = globalThis as { AsyncLocalStorage?: unknown };
    g.AsyncLocalStorage ??= AsyncLocalStorage;
    const { unstable_doesMiddlewareMatch } = await import('next/experimental/testing/server');
    return unstable_doesMiddlewareMatch({ config, url: `https://do.dsul.app${path}` });
  }

  it.each(['/manifest.json', '/sw.js'])('never gates %s, which the browser fetches on its own', async (path) => {
    // A manifest fetch carries no cookie, so a gated one went to the login
    // page's HTML for a signed-in visitor too, and no browser could install
    // the app.
    expect(await gated(path)).toBe(false);
  });

  it.each(['/', '/goal/g1', '/login', '/manifest', '/sw.jsx'])('still runs on %s', async (path) => {
    expect(await gated(path)).toBe(true);
  });
});
