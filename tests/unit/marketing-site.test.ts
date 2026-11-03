import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { config, proxy } from '@/proxy';
import { MARKETING_HOST, MARKETING_PAGE, MARKETING_PREVIEW_PATH } from '@/lib/marketing-site';
import { PLANNERS, WHY_MAX, EMAIL_MAX } from '@/lib/waitlist';
import nextConfig from '../../next.config.mjs';

// dsul.app's root is the marketing page; every other apex path still goes to
// the app. Three files agree on that (lib/marketing-site.ts says which), and
// each is read here through Next's own matchers rather than re-derived.

async function nextTesting() {
  // The helpers reach for the AsyncLocalStorage a Next server puts on
  // globalThis, which jsdom has none of.
  const g = globalThis as { AsyncLocalStorage?: unknown };
  g.AsyncLocalStorage ??= AsyncLocalStorage;
  return import('next/experimental/testing/server');
}

describe('the apex redirect (next.config.mjs)', () => {
  async function redirectOf(host: string, pathAndQuery: string) {
    const { unstable_getResponseFromNextConfig, getRedirectUrl } = await nextTesting();
    const res = await unstable_getResponseFromNextConfig({
      url: `https://${host}${pathAndQuery}`,
      nextConfig,
      headers: { host },
    });
    return { status: res.status, location: getRedirectUrl(res) };
  }

  it('leaves the root of dsul.app to the page', async () => {
    expect((await redirectOf(MARKETING_HOST, '/')).location).toBeNull();
  });

  it.each([
    '/site/index.html',
    '/site/fonts/Geist-Variable.woff2',
    '/api/waitlist',
    '/_vercel/insights/script.js',
    '/favicon.ico',
    '/icon.svg',
    '/apple-icon.png',
  ])('lets %s through on the apex, since the page fetches it', async (p) => {
    expect((await redirectOf(MARKETING_HOST, p)).location).toBeNull();
  });

  it.each([
    ['/goal/g1?x=1', 'https://do.dsul.app/goal/g1?x=1'],
    ['/login', 'https://do.dsul.app/login'],
    ['/auth/callback?code=abc', 'https://do.dsul.app/auth/callback?code=abc'],
    ['/settings/ai', 'https://do.dsul.app/settings/ai'],
    ['/api/agent/context', 'https://do.dsul.app/api/agent/context'],
    ['/api/waitlist/x', 'https://do.dsul.app/api/waitlist/x'],
    ['/site', 'https://do.dsul.app/site'],
    ['/sitemap.xml', 'https://do.dsul.app/sitemap.xml'],
    ['/manifest.json', 'https://do.dsul.app/manifest.json'],
  ])('still sends %s on the apex to the app', async (p, to) => {
    expect(await redirectOf(MARKETING_HOST, p)).toEqual({ status: 307, location: to });
  });

  it('never redirects on the app host', async () => {
    expect((await redirectOf('do.dsul.app', '/goal/g1')).location).toBeNull();
  });
});

describe('the rewrite to the page (proxy.ts)', () => {
  // Signed out, with a Supabase that cannot answer: the gate would send any
  // page it reached to /login, so a rewrite here proves the page came first.
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:1');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
    vi.stubEnv('NEXT_PUBLIC_DISABLE_AUTH', '');
    vi.stubEnv('VERCEL_ENV', 'production');
  });
  afterEach(() => vi.unstubAllEnvs());

  async function run(url: string) {
    const { getRewrittenUrl } = await nextTesting();
    const res = await proxy(new NextRequest(url));
    return { status: res.status, location: res.headers.get('location'), rewrite: getRewrittenUrl(res) };
  }

  it("serves the page at dsul.app's root, signed out, instead of /login", async () => {
    const r = await run(`https://${MARKETING_HOST}/`);
    expect(r.location).toBeNull();
    expect(r.rewrite).toBe(`https://${MARKETING_HOST}${MARKETING_PAGE}`);
  });

  it('serves it at /welcome on any host, so a preview deployment can show it', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    const r = await run(`https://dsul-git-branch.vercel.app${MARKETING_PREVIEW_PATH}`);
    expect(r.location).toBeNull();
    expect(r.rewrite).toBe(`https://dsul-git-branch.vercel.app${MARKETING_PAGE}`);
  });

  it("leaves the app's own root to the gate", async () => {
    const r = await run('https://do.dsul.app/');
    expect(r.rewrite).toBeNull();
    expect(r.location).toBe('https://do.dsul.app/login');
  });

  it('still sends an auth code at the apex root to the callback first', async () => {
    const r = await run(`https://${MARKETING_HOST}/?code=abc`);
    expect(r.rewrite).toBeNull();
    expect(r.location).toBe(`https://${MARKETING_HOST}/auth/callback?code=abc`);
  });

  it.each(['/site/index.html', '/site/fonts/Geist-Variable.woff2'])(
    'the matcher never runs the gate on %s',
    async (p) => {
      const { unstable_doesMiddlewareMatch } = await nextTesting();
      expect(unstable_doesMiddlewareMatch({ config, url: `https://${MARKETING_HOST}${p}` })).toBe(false);
    }
  );

  it.each(['/', '/welcome', '/site', '/sitemap', '/settings'])('the matcher still runs on %s', async (p) => {
    const { unstable_doesMiddlewareMatch } = await nextTesting();
    expect(unstable_doesMiddlewareMatch({ config, url: `https://do.dsul.app${p}` })).toBe(true);
  });
});

describe('the page (public/site/index.html)', () => {
  const file = path.join(process.cwd(), 'public', MARKETING_PAGE);
  const html = existsSync(file) ? readFileSync(file, 'utf8') : '';

  it('exists where the rewrite points', () => {
    expect(html).toMatch(/^<!doctype html>/i);
  });

  it('fetches nothing of its own outside /site/ (the URL stays / after a rewrite)', () => {
    const refs = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      // The icons and Vercel's analytics script are let through on the apex by next.config.mjs.
      expect(ref).toMatch(/^\/(site\/|_vercel\/|favicon\.ico$|icon\.svg$|apple-icon\.png$)/);
    }
    for (const font of html.matchAll(/url\((\/site\/[^)]+)\)/g)) {
      expect(existsSync(path.join(process.cwd(), 'public', font[1]))).toBe(true);
    }
  });

  it('loads no third-party fonts or scripts', () => {
    expect(html).not.toMatch(/fonts\.googleapis|fonts\.gstatic|<script[^>]+src="https?:/);
  });

  it('posts to /api/waitlist with the same planner keys and caps as the route', () => {
    expect(html).toContain("'/api/waitlist'");
    for (const key of PLANNERS) expect(html).toContain(`data-planner="${key}"`);
    const keys = [...html.matchAll(/data-planner="([a-z]+)"/g)].map((m) => m[1]);
    expect(new Set(keys)).toEqual(new Set(PLANNERS));
    expect(html).toContain(`maxlength="${WHY_MAX}"`);
    expect(html).toContain(`maxlength="${EMAIL_MAX}"`);
  });

  it('keeps the copy rules: no em dashes, and the AI has no name', () => {
    expect(html).not.toContain('—');
    expect(html).not.toMatch(/beacon/i);
  });

  it('registers no service worker and links no app manifest', () => {
    expect(html).not.toMatch(/serviceWorker|rel="manifest"/);
  });
});
