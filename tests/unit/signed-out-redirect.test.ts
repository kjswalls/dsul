import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isSignedOutPath,
  leaveForLoginIfSignedOutPage,
  signedOutNav,
} from '@/lib/signed-out-redirect';

describe('leaveForLoginIfSignedOutPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, '', '/');
  });

  it('treats /login and /auth/* as where a signed-out browser belongs', () => {
    expect(isSignedOutPath('/login')).toBe(true);
    expect(isSignedOutPath('/auth/callback')).toBe(true);
    expect(isSignedOutPath('/')).toBe(false);
    expect(isSignedOutPath('/settings')).toBe(false);
  });

  it('replaces any other page with /login', () => {
    const replace = vi.spyOn(signedOutNav, 'replace').mockImplementation(() => {});
    window.history.replaceState({}, '', '/item/x');
    leaveForLoginIfSignedOutPage();
    expect(replace).toHaveBeenCalledWith('/login');
  });

  it('stays put on /login', () => {
    const replace = vi.spyOn(signedOutNav, 'replace').mockImplementation(() => {});
    window.history.replaceState({}, '', '/login');
    leaveForLoginIfSignedOutPage();
    expect(replace).not.toHaveBeenCalled();
  });
});
