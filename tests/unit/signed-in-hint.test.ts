import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { AuthRetryableFetchError, AuthSessionMissingError } from '@supabase/supabase-js';
import {
  MARKETING_HOST,
  SIGNED_IN_HINT,
  signedInHintClears,
  signedInHintDomain,
  signedInHintOptions,
} from '@/lib/marketing-site';

// dsul.app's "log in" reads "open your planner" while dsul_in=1 is set
// (lib/marketing-site.ts). The proxy is its writer, so this drives the real
// proxy with getUser() answering whatever each test needs.
const auth = vi.hoisted(() => ({
  answer: { data: { user: null as { id: string } | null }, error: null as unknown },
  calls: 0,
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => {
        auth.calls++;
        return auth.answer;
      },
    },
  }),
}));

import { proxy } from '@/proxy';

const SIGNED_IN = { data: { user: { id: 'u1' } }, error: null };
const SIGNED_OUT = { data: { user: null }, error: new AuthSessionMissingError() };
const OFFLINE = { data: { user: null }, error: new AuthRetryableFetchError('fetch failed', 0) };

function run(url: string, cookie?: string) {
  const headers = cookie ? { cookie } : undefined;
  return proxy(new NextRequest(url, { headers }));
}

/** The Set-Cookie header for the hint, or null when the response leaves it alone. */
function hintHeader(res: Response): string | null {
  const all = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  return all.find((c) => c.startsWith(`${SIGNED_IN_HINT}=`)) ?? null;
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:1');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
  vi.stubEnv('NEXT_PUBLIC_DISABLE_AUTH', '');
  vi.stubEnv('VERCEL_ENV', 'production');
  auth.answer = SIGNED_IN;
  auth.calls = 0;
});
afterEach(() => vi.unstubAllEnvs());

describe('where the hint can be written from', () => {
  it('is the whole dsul.app domain from dsul.app and its subdomains, host-only anywhere else', () => {
    expect(signedInHintDomain('do.dsul.app')).toBe('dsul.app');
    expect(signedInHintDomain('dsul.app')).toBe('dsul.app');
    // A lookalike is not a subdomain.
    expect(signedInHintDomain('notdsul.app')).toBeUndefined();
    expect(signedInHintDomain('dsul-git-x-sundaysoftworks.vercel.app')).toBeUndefined();
    expect(signedInHintDomain('localhost')).toBeUndefined();
  });

  it('is readable by the page (not HttpOnly), and Secure only over https', () => {
    expect(signedInHintOptions(new URL('https://do.dsul.app/'))).toMatchObject({
      domain: 'dsul.app',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
    });
    expect(signedInHintOptions(new URL('http://localhost:3000/')).secure).toBe(false);
  });

  it('is cleared in the browser in every scope it can have been written in', () => {
    expect(signedInHintClears(new URL('https://do.dsul.app/settings'))).toEqual([
      'dsul_in=; Path=/; Max-Age=0; SameSite=Lax; Secure; Domain=dsul.app',
      'dsul_in=; Path=/; Max-Age=0; SameSite=Lax; Secure',
    ]);
    expect(signedInHintClears(new URL('http://localhost:3000/'))).toEqual(['dsul_in=; Path=/; Max-Age=0; SameSite=Lax']);
  });
});

describe('the proxy writes it while a session is live', () => {
  it('sets it for the whole domain on a signed-in page request that lacks it', async () => {
    const c = hintHeader(await run('https://do.dsul.app/'));
    expect(c).toMatch(/^dsul_in=1;/);
    expect(c).toMatch(/Domain=dsul\.app/i);
    expect(c).toMatch(/Path=\//);
    expect(c).toMatch(/Secure/i);
    expect(c).not.toMatch(/HttpOnly/i);
  });

  it('says nothing to a browser that already has it', async () => {
    expect(hintHeader(await run('https://do.dsul.app/goal/g1', 'dsul_in=1'))).toBeNull();
  });

  it('rides the signed-in bounce from /login to the planner', async () => {
    const res = await run('https://do.dsul.app/login');
    expect(res.headers.get('location')).toBe('https://do.dsul.app/');
    expect(hintHeader(res)).toMatch(/^dsul_in=1;/);
  });

  it('is host-only on a preview, where Domain=dsul.app would be refused', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    const c = hintHeader(await run('https://dsul-git-x-sundaysoftworks.vercel.app/'));
    expect(c).toMatch(/^dsul_in=1;/);
    expect(c).not.toMatch(/Domain=/i);
  });

  it('never touches an API route', async () => {
    expect(hintHeader(await run('https://do.dsul.app/api/agent/context'))).toBeNull();
    auth.answer = SIGNED_OUT;
    expect(hintHeader(await run('https://do.dsul.app/api/agent/context', 'dsul_in=1'))).toBeNull();
  });

  it("is never read or written at dsul.app's root, which is the page and asks no one who they are", async () => {
    const res = await run(`https://${MARKETING_HOST}/`, 'dsul_in=1');
    expect(hintHeader(res)).toBeNull();
    expect(auth.calls).toBe(0);
  });
});

describe('the proxy drops it once the session is gone', () => {
  it('on the way to /login', async () => {
    auth.answer = SIGNED_OUT;
    const res = await run('https://do.dsul.app/', 'dsul_in=1');
    expect(res.headers.get('location')).toBe('https://do.dsul.app/login');
    const c = hintHeader(res);
    expect(c).toMatch(/^dsul_in=;/);
    expect(c).toMatch(/Max-Age=0/i);
    // The same scope it was written in, or the clear misses it.
    expect(c).toMatch(/Domain=dsul\.app/i);
    expect(c).toMatch(/Path=\//);
  });

  it('on /login itself, where every sign-out already lands', async () => {
    auth.answer = SIGNED_OUT;
    expect(hintHeader(await run('https://do.dsul.app/login', 'dsul_in=1'))).toMatch(/^dsul_in=;.*Max-Age=0/i);
  });

  it('but not on a network failure, which says nothing about the session', async () => {
    auth.answer = OFFLINE;
    expect(hintHeader(await run('https://do.dsul.app/', 'dsul_in=1'))).toBeNull();
  });

  it('and says nothing when there was none', async () => {
    auth.answer = SIGNED_OUT;
    expect(hintHeader(await run('https://do.dsul.app/'))).toBeNull();
  });
});
