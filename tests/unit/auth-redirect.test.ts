import { describe, expect, it } from 'vitest';
import { loginRedirectTarget } from '@/lib/auth-redirect';

const ORIGIN = 'https://do.dsul.app';

describe('loginRedirectTarget', () => {
  it('lands on the callback when no page asked for one', () => {
    expect(loginRedirectTarget(null, ORIGIN)).toBe('/auth/callback');
    expect(loginRedirectTarget('', ORIGIN)).toBe('/auth/callback');
  });

  it("routes a page's own path through the callback as next", () => {
    expect(loginRedirectTarget('/goal/x', ORIGIN)).toBe('/auth/callback?next=%2Fgoal%2Fx');
    expect(loginRedirectTarget('/settings', ORIGIN)).toBe('/auth/callback?next=%2Fsettings');
  });

  it('sends an off-origin redirect home instead', () => {
    expect(loginRedirectTarget('@evil.com', ORIGIN)).toBe('/auth/callback?next=%2F');
    expect(loginRedirectTarget('//evil.com', ORIGIN)).toBe('/auth/callback?next=%2F');
    expect(loginRedirectTarget('https://evil.com/auth/callback?next=%2F', ORIGIN)).toBe('/auth/callback?next=%2F');
  });

  it("passes /connect's callback URL through unchanged rather than wrapping it twice", () => {
    const fromConnect = `/auth/callback?next=${encodeURIComponent('/connect?code=x')}`;
    expect(loginRedirectTarget(fromConnect, ORIGIN)).toBe(fromConnect);
    expect(loginRedirectTarget('/auth/callback', ORIGIN)).toBe('/auth/callback');
  });

  it('does not mistake a lookalike path for the callback', () => {
    expect(loginRedirectTarget('/auth/callbackevil', ORIGIN)).toBe('/auth/callback?next=%2Fauth%2Fcallbackevil');
  });
});
