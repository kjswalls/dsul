import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import {
  NO_SESSION_BOUNCE_KEY,
  isSignedOutPath,
  leaveForLoginIfNoSession,
  leaveForLoginIfSignedOutPage,
  loginPathFor,
  signedOutNav,
} from '@/lib/signed-out-redirect';
import { loginRedirectTarget } from '@/lib/auth-redirect';
import { safeNext } from '@/lib/safe-next';

const ORIGIN = 'https://do.dsul.app';

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

describe('loginPathFor', () => {
  it('is bare /login for the root', () => {
    expect(loginPathFor('/', ORIGIN)).toBe('/login');
  });

  it('carries any other page, query and all, as one encoded redirect', () => {
    expect(loginPathFor('/goal/g1?x=1', ORIGIN)).toBe('/login?redirect=%2Fgoal%2Fg1%3Fx%3D1');
  });

  it("drops Next's _rsc cache-buster from what it carries", () => {
    expect(loginPathFor('/settings?_rsc=zz', ORIGIN)).toBe('/login?redirect=%2Fsettings');
    expect(loginPathFor('/goal/g1?x=1&_rsc=zz', ORIGIN)).toBe('/login?redirect=%2Fgoal%2Fg1%3Fx%3D1');
  });

  it.each(['//evil.com', '/\\evil.com', '/..//evil.com', 'https://evil.com/goal/g1'])(
    'carries nothing for %j, which safeNext would not vouch for',
    (raw) => {
      expect(loginPathFor(raw, ORIGIN)).toBe('/login');
    }
  );

  it('keeps a carried code inside the redirect, never top-level', () => {
    // The desktop shell drops any app URL with a top-level `code`
    // (electron/lib/policy.cjs carriesAuthCode); the pairing code must survive.
    const login = new URL(loginPathFor('/connect?code=ABCD1234', ORIGIN), ORIGIN);
    expect(login.searchParams.has('code')).toBe(false);
    expect(login.searchParams.get('redirect')).toBe('/connect?code=ABCD1234');
  });

  it('is read back by /login into a sign-in that lands on the page (and is dropped on desktop)', () => {
    // app/login/login-page.tsx reads `redirect` and hands it to loginRedirectTarget;
    // /auth/callback runs safeNext over its `next` and redirects there.
    const redirect = new URL(loginPathFor('/connect?code=ABCD1234', ORIGIN), ORIGIN).searchParams.get('redirect');
    const target = loginRedirectTarget(redirect, ORIGIN);
    expect(target).toBe('/auth/callback?next=%2Fconnect%3Fcode%3DABCD1234');
    expect(safeNext(new URL(target, ORIGIN).searchParams.get('next'), ORIGIN)).toBe('/connect?code=ABCD1234');
    // The desktop app's sign-in always lands on '/', whatever the page asked for.
    expect(loginRedirectTarget(redirect, ORIGIN, { desktop: true })).toBe('/auth/desktop');
  });

  it('never carries the hash', () => {
    // An implicit-flow link's tokens sit in the fragment; in a query they would
    // reach every log the URL passes through.
    const out = loginPathFor('/#access_token=a&refresh_token=b', ORIGIN);
    expect(out).toBe('/login');
    expect(loginPathFor('/goal/g1?x=1#access_token=a&refresh_token=b', ORIGIN)).toBe(
      '/login?redirect=%2Fgoal%2Fg1%3Fx%3D1'
    );
    expect(loginPathFor('/settings#keys', ORIGIN)).not.toContain('keys');
  });
});

describe('leaveForLoginIfNoSession', () => {
  let replace: MockInstance<typeof signedOutNav.replace>;

  beforeEach(() => {
    sessionStorage.clear();
    replace = vi.spyOn(signedOutNav, 'replace').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    sessionStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('sends / to bare /login', () => {
    window.history.replaceState({}, '', '/');
    leaveForLoginIfNoSession();
    expect(replace).toHaveBeenCalledWith('/login');
  });

  it('keeps the place on any other page, without the hash', () => {
    window.history.replaceState({}, '', '/season/s1?tab=a#x');
    leaveForLoginIfNoSession();
    expect(replace).toHaveBeenCalledWith('/login?redirect=%2Fseason%2Fs1%3Ftab%3Da');
  });

  it.each(['/login', '/login?redirect=%2Fgoal%2Fg1', '/auth/callback', '/auth/desktop'])(
    'stays put on %s',
    (path) => {
      window.history.replaceState({}, '', path);
      leaveForLoginIfNoSession();
      expect(replace).not.toHaveBeenCalled();
    }
  );

  it('still leaves under NEXT_PUBLIC_DISABLE_AUTH=true', () => {
    // The regression lock for the production-flag case: Next inlines the flag
    // into the browser bundle, so a client bounce that read it would switch off
    // with the server gate, exactly when it is the only thing left.
    vi.stubEnv('NEXT_PUBLIC_DISABLE_AUTH', 'true');
    window.history.replaceState({}, '', '/goal/g1');
    leaveForLoginIfNoSession();
    expect(replace).toHaveBeenCalledWith('/login?redirect=%2Fgoal%2Fg1');
  });

  describe('the loop guard', () => {
    /** The stamp a previous page load in this tab left behind, `ageMs` ago. */
    const stampFromAnotherPageLoad = (ageMs: number) =>
      sessionStorage.setItem(
        NO_SESSION_BOUNCE_KEY,
        JSON.stringify({ at: Date.now() - ageMs, page: 'an-earlier-page-load' })
      );

    /** What the browser reports about how this document arrived. */
    const arrivedWithRedirects = (redirectCount: number) =>
      vi
        .spyOn(performance, 'getEntriesByType')
        .mockImplementation((type) =>
          type === 'navigation' ? [{ redirectCount } as unknown as PerformanceEntry] : []
        );

    /**
     * A fresh document in the same tab: its own module instance (so its own
     * page-load id) over the tab's shared sessionStorage.
     */
    const pageLoad = async (path: string, redirectCount: number) => {
      vi.resetModules();
      const mod = await import('@/lib/signed-out-redirect');
      const replaced = vi.spyOn(mod.signedOutNav, 'replace').mockImplementation(() => {});
      window.history.replaceState({}, '', path);
      arrivedWithRedirects(redirectCount);
      mod.leaveForLoginIfNoSession();
      return replaced;
    };

    it('stamps the tab when it bounces', () => {
      leaveForLoginIfNoSession();
      const stamp = JSON.parse(sessionStorage.getItem(NO_SESSION_BOUNCE_KEY) ?? 'null');
      expect(stamp).toEqual({ at: expect.any(Number), page: expect.any(String) });
    });

    it('does not bounce a second time when a page load came straight back, and says why', () => {
      // /login → proxy.ts sees a user → 307 to '/' → the browser still sees none.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stampFromAnotherPageLoad(3_000);
      arrivedWithRedirects(1);
      leaveForLoginIfNoSession();
      expect(replace).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledOnce();
    });

    it('still bounces a page that arrived with no redirect, however fresh the stamp', () => {
      // The desktop shell's offline retry of '/', a typed URL or a bookmark:
      // not the loop, which always comes back through proxy.ts's 307.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      stampFromAnotherPageLoad(5_000);
      arrivedWithRedirects(0);
      leaveForLoginIfNoSession();
      expect(replace).toHaveBeenCalledWith('/login');
      expect(warn).not.toHaveBeenCalled();
    });

    it('holds where the browser cannot say how the page arrived', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      stampFromAnotherPageLoad(3_000);
      vi.spyOn(performance, 'getEntriesByType').mockReturnValue([]);
      leaveForLoginIfNoSession();
      expect(replace).not.toHaveBeenCalled();
    });

    it('forgets the bounce once /login renders, since in the loop it never does', () => {
      stampFromAnotherPageLoad(3_000);
      window.history.replaceState({}, '', '/login?redirect=%2Fgoal%2Fg1');
      leaveForLoginIfNoSession();
      expect(sessionStorage.getItem(NO_SESSION_BOUNCE_KEY)).toBeNull();
      expect(replace).not.toHaveBeenCalled();
    });

    describe('across page loads in one tab', () => {
      it('stops the loop at its second turn', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await pageLoad('/', 0)).toHaveBeenCalledWith('/login');
        // /login was 307'd straight back by a server that sees a user.
        expect(await pageLoad('/', 1)).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledOnce();
      });

      it("bounces the desktop shell's offline retry after a /login load that failed", async () => {
        // did-fail-load shows offline.html, which reloads '/' a few seconds on.
        expect(await pageLoad('/', 0)).toHaveBeenCalledWith('/login');
        expect(await pageLoad('/', 0)).toHaveBeenCalledWith('/login');
      });

      it('bounces the next page opened after landing on /login, redirected or not', async () => {
        expect(await pageLoad('/', 0)).toHaveBeenCalledWith('/login');
        expect(await pageLoad('/login', 0)).not.toHaveBeenCalled();
        // A trailing-slash 308 counts as a redirect; the stamp is gone anyway.
        expect(await pageLoad('/goal/g1', 1)).toHaveBeenCalledWith('/login?redirect=%2Fgoal%2Fg1');
      });
    });

    it('bounces again once the stamp is ~15s old', () => {
      stampFromAnotherPageLoad(20_000);
      leaveForLoginIfNoSession();
      expect(replace).toHaveBeenCalledWith('/login');
    });

    it('ignores a stamp from the future (a clock that moved back)', () => {
      stampFromAnotherPageLoad(-60_000);
      leaveForLoginIfNoSession();
      expect(replace).toHaveBeenCalledWith('/login');
    });

    it('ignores a stamp it cannot read', () => {
      sessionStorage.setItem(NO_SESSION_BOUNCE_KEY, '{not json');
      leaveForLoginIfNoSession();
      expect(replace).toHaveBeenCalledWith('/login');
    });

    it('stays quiet about a second call from the same page load (a dev double mount)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      leaveForLoginIfNoSession();
      leaveForLoginIfNoSession();
      expect(replace).toHaveBeenCalledOnce();
      expect(warn).not.toHaveBeenCalled();
    });

    it('still bounces when storage refuses every access', () => {
      const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      });
      const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      });
      leaveForLoginIfNoSession();
      expect(getItem).toHaveBeenCalled();
      expect(setItem).toHaveBeenCalled();
      expect(replace).toHaveBeenCalledWith('/login');
    });
  });
});
