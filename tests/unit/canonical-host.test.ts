import { describe, it, expect } from 'vitest';
import { canonicalRedirect, CANONICAL_HOST } from '@/lib/canonical-host';

const at = (href: string) => canonicalRedirect(new URL(href), 'production');

describe('canonicalRedirect', () => {
  it('moves a production auth callback off the Vercel alias, code intact', () => {
    const to = at('https://dsul.vercel.app/auth/callback?code=abc&next=%2Fconnect');
    expect(to?.toString()).toBe(`https://${CANONICAL_HOST}/auth/callback?code=abc&next=%2Fconnect`);
  });

  it('moves page routes too', () => {
    expect(at('https://dsul-git-main-kirby.vercel.app/')?.toString()).toBe(`https://${CANONICAL_HOST}/`);
  });

  it('leaves the canonical host alone', () => {
    expect(at(`https://${CANONICAL_HOST}/auth/callback?code=abc`)).toBeNull();
  });

  it('leaves API routes alone', () => {
    expect(at('https://dsul.vercel.app/api/cron/reminders')).toBeNull();
    expect(at('https://dsul.vercel.app/api')).toBeNull();
  });

  it('only acts in production', () => {
    const url = new URL('https://dsul-abc123.vercel.app/auth/callback?code=abc');
    expect(canonicalRedirect(url, 'preview')).toBeNull();
    expect(canonicalRedirect(url, 'development')).toBeNull();
    expect(canonicalRedirect(url, undefined)).toBeNull();
  });

  it('never touches localhost', () => {
    expect(at('http://localhost:3000/login')).toBeNull();
  });

  it('sends a Site URL fallback (code at the root) to the callback on the canonical host', () => {
    expect(at('https://v0-anchor-plum.vercel.app/?code=abc')?.toString()).toBe(
      `https://${CANONICAL_HOST}/auth/callback?code=abc`
    );
  });

  it('sends a code at the root to the callback on any host', () => {
    expect(at(`https://${CANONICAL_HOST}/?code=abc`)?.toString()).toBe(
      `https://${CANONICAL_HOST}/auth/callback?code=abc`
    );
    expect(canonicalRedirect(new URL('http://localhost:3000/?code=abc'), undefined)?.toString()).toBe(
      'http://localhost:3000/auth/callback?code=abc'
    );
  });

  it('leaves the root without a code alone', () => {
    expect(at(`https://${CANONICAL_HOST}/?view=week`)).toBeNull();
  });
});
