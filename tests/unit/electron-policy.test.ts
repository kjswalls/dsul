import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import policy from '../../electron/lib/policy.cjs';

// The Electron shell (electron/, its own npm project) keeps every URL decision in one pure file
// so this suite can hold it to the plan: memory/plans/desktop-app.md, "Testing". This is the one
// deliberate reach into electron/ from the root tests.
const {
  APP_ORIGIN,
  SUPABASE_HOST,
  SUPABASE_ORIGIN,
  GOOGLE_PENDING_MS,
  EMAIL_PENDING_MS,
  BLOCKED_SWITCHES,
  blockedLaunch,
  isAppUrl,
  carriesAuthCode,
  externalAllowed,
  isAuthorizeEndpoint,
  checkAuthorizeUrl,
  parseDeepLink,
  deepLinkFromArgv,
  livePending,
  newerRelease,
} = policy;

const CODE = 'e3b0c442-98fc-1c14-9afb-f4c8996fb924';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

function authorizeUrl(overrides: Record<string, string | null> = {}, base = SUPABASE_ORIGIN) {
  const params: Record<string, string | null> = {
    provider: 'google',
    redirect_to: `${APP_ORIGIN}/auth/desktop`,
    code_challenge: CHALLENGE,
    code_challenge_method: 's256',
    ...overrides,
  };
  const u = new URL('/auth/v1/authorize', base);
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  return u.href;
}

describe('electron/lib/policy.cjs', () => {
  it('stays pure: no requires and no imports, so this suite can load it without Electron', () => {
    const source = readFileSync(path.resolve(__dirname, '../../electron/lib/policy.cjs'), 'utf8');
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/^\s*import\b/m);
  });

  it("keeps offline.html's CSP hash in step with its one inline script", () => {
    // The page's only script is the online retry; a CSP that no longer matches it leaves an
    // offline launch stuck on that page.
    const html = readFileSync(path.resolve(__dirname, '../../electron/offline.html'), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts).toHaveLength(1);
    const hash = createHash('sha256').update(scripts[0]).digest('base64');
    expect(html).toContain(`script-src 'sha256-${hash}'`);
    expect(scripts[0]).toContain("location.replace('https://do.dsul.app/')");
  });

  it('pins production', () => {
    expect(APP_ORIGIN).toBe('https://do.dsul.app');
    // Mirrors NEXT_PUBLIC_SUPABASE_URL (the same host tests/unit/e2e-local-target.test.ts names).
    expect(SUPABASE_HOST).toBe('ctcspcferkdlzdcqlozq.supabase.co');
    expect(GOOGLE_PENDING_MS).toBe(10 * 60 * 1000);
    expect(EMAIL_PENDING_MS).toBe(60 * 60 * 1000);
  });
});

describe('blockedLaunch', () => {
  const only = (name: string) => (s: string) => s === name;
  const none = () => false;

  it('refuses every switch that drives the window, exposes its traffic or turns a check off', () => {
    // Each of the later five was run against Electron 44.5.1: a net log in Everything mode holds
    // the sb-* cookie values, a key log decrypts any capture, an SPKI allow-list skips the
    // certificate check, and a PAC URL routes the window through any proxy.
    expect([...BLOCKED_SWITCHES].sort()).toEqual(
      [
        'remote-debugging-port',
        'remote-debugging-pipe',
        'inspect',
        'inspect-brk',
        'host-resolver-rules',
        'ignore-certificate-errors',
        'proxy-server',
        'disable-web-security',
        'log-net-log',
        'net-log-capture-mode',
        'ssl-key-log-file',
        'ignore-certificate-errors-spki-list',
        'proxy-pac-url',
      ].sort()
    );
    for (const name of BLOCKED_SWITCHES) expect(blockedLaunch(only(name), {})).toBe(true);
  });

  it('refuses a TLS key log asked for through the environment', () => {
    expect(blockedLaunch(none, { SSLKEYLOGFILE: '/tmp/keys.log' })).toBe(true);
  });

  it('lets an ordinary launch through', () => {
    expect(blockedLaunch(none, {})).toBe(false);
    expect(blockedLaunch(none, { SSLKEYLOGFILE: '' })).toBe(false);
    expect(blockedLaunch(only('dsul-shell-version'), { PATH: '/usr/bin' })).toBe(false);
  });
});

describe('isAppUrl', () => {
  it('accepts the app, however the scheme, host and default port are written', () => {
    expect(isAppUrl('https://do.dsul.app/')).toBe(true);
    expect(isAppUrl('https://do.dsul.app/settings/day?x=1#y')).toBe(true);
    expect(isAppUrl('HTTPS://DO.DSUL.APP:443/')).toBe(true);
  });

  it('rejects lookalikes and other schemes', () => {
    for (const url of [
      // Same origin as the app, but not the app.
      'blob:https://do.dsul.app/x',
      'https://do.dsul.app.evil.com',
      'https://do.dsul.app@evil.com',
      'https://user@do.dsul.app/',
      'http://do.dsul.app/',
      'https://do.dsul.app:8443/',
      'file:///C:/x.html',
      'javascript:',
      'javascript:alert(1)',
      'about:blank',
      'not a url',
      '',
    ]) {
      expect(isAppUrl(url), url).toBe(false);
    }
  });

  it('rejects anything that is not a string', () => {
    expect(isAppUrl(undefined)).toBe(false);
    expect(isAppUrl(null)).toBe(false);
    expect(isAppUrl({ href: 'https://do.dsul.app/' })).toBe(false);
  });

  it("follows a dev build's origin instead of production's", () => {
    expect(isAppUrl('http://localhost:3000/login', 'http://localhost:3000')).toBe(true);
    expect(isAppUrl('http://localhost:3001/', 'http://localhost:3000')).toBe(false);
    expect(isAppUrl('https://do.dsul.app/', 'http://localhost:3000')).toBe(false);
  });
});

describe('carriesAuthCode', () => {
  it('flags the callback, with or without a code', () => {
    expect(carriesAuthCode('https://do.dsul.app/auth/callback')).toBe(true);
    expect(carriesAuthCode(`https://do.dsul.app/auth/callback?code=${CODE}`)).toBe(true);
    expect(carriesAuthCode('https://do.dsul.app/auth/callback?next=%2F')).toBe(true);
  });

  it('flags the callback however a server might route it', () => {
    for (const url of [
      'https://do.dsul.app/auth/callback/',
      'https://do.dsul.app/AUTH/Callback',
      'https://do.dsul.app//auth//callback',
      'https://do.dsul.app/auth/%63allback',
    ]) {
      expect(carriesAuthCode(url), url).toBe(true);
    }
  });

  it('flags a code anywhere the browser client would read one', () => {
    // The root forwards /?code= to the callback, and the browser client exchanges a code on any
    // page load, from the query or the fragment.
    expect(carriesAuthCode(`https://do.dsul.app/?code=${CODE}`)).toBe(true);
    expect(carriesAuthCode(`https://do.dsul.app/settings?x=1&code=${CODE}`)).toBe(true);
    expect(carriesAuthCode(`https://do.dsul.app/#code=${CODE}`)).toBe(true);
    expect(carriesAuthCode(`https://do.dsul.app/?%63ode=${CODE}`)).toBe(true);
    expect(carriesAuthCode('https://do.dsul.app/connect?code=x')).toBe(true);
  });

  it('leaves a signed-out bounce carrying the pairing link alone', () => {
    // proxy.ts and the provider send a signed-out /connect?code=… here with the
    // whole destination encoded inside `redirect` (lib/signed-out-redirect.ts
    // loginPathFor). The old /login?code=… was dropped by this guard.
    expect(carriesAuthCode('https://do.dsul.app/login?redirect=%2Fconnect%3Fcode%3DABCD1234')).toBe(false);
    // And /auth/callback's failure, which hands the same destination back.
    expect(
      carriesAuthCode('https://do.dsul.app/login?redirect=%2Fconnect%3Fcode%3DABCD1234&error=expired')
    ).toBe(false);
  });

  it('leaves ordinary pages alone', () => {
    for (const url of [
      'https://do.dsul.app/',
      'https://do.dsul.app/login?error=expired',
      'https://do.dsul.app/auth/desktop',
      'https://do.dsul.app/auth/callbackevil',
      'https://do.dsul.app/item/x?codes=1',
      'https://do.dsul.app/#settings',
    ]) {
      expect(carriesAuthCode(url), url).toBe(false);
    }
  });
});

describe('externalAllowed', () => {
  it('lets web and mail links out', () => {
    expect(externalAllowed('https://github.com/kjswalls/dsul')).toBe(true);
    expect(externalAllowed('http://example.com/')).toBe(true);
    expect(externalAllowed('mailto:kirby@example.com')).toBe(true);
  });

  it('keeps every other scheme in', () => {
    for (const url of [
      'file:///C:/Windows/System32/calc.exe',
      'smb://evil.example/share',
      'ms-msdt:/id PCWDiagnostic',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'dsul://auth/callback?code=x',
      'vbscript:msgbox',
      'not a url',
    ]) {
      expect(externalAllowed(url), url).toBe(false);
    }
  });
});

describe('isAuthorizeEndpoint', () => {
  it('recognises the authorize endpoint whatever it was asked for', () => {
    expect(isAuthorizeEndpoint(authorizeUrl())).toBe(true);
    expect(
      isAuthorizeEndpoint(authorizeUrl({ redirect_to: 'https://do.dsul.app/auth/callback' }))
    ).toBe(true);
    expect(isAuthorizeEndpoint(`${SUPABASE_ORIGIN}/auth/v1/authorize/`)).toBe(true);
  });

  it('ignores other Supabase paths and other hosts', () => {
    expect(isAuthorizeEndpoint(`${SUPABASE_ORIGIN}/auth/v1/verify?token=x`)).toBe(false);
    expect(isAuthorizeEndpoint('https://evil.supabase.co/auth/v1/authorize')).toBe(false);
  });
});

describe('checkAuthorizeUrl', () => {
  it('accepts the URL the desktop login builds', () => {
    expect(checkAuthorizeUrl(authorizeUrl())).toBe(true);
    expect(checkAuthorizeUrl(authorizeUrl({ code_challenge_method: 'S256' }))).toBe(true);
    // Extra provider options (a prompt, scopes) are the login's business.
    expect(checkAuthorizeUrl(authorizeUrl({ prompt: 'select_account' }))).toBe(true);
  });

  it('rejects a foreign Supabase project or any other host', () => {
    expect(checkAuthorizeUrl(authorizeUrl({}, 'https://attacker.supabase.co'))).toBe(false);
    expect(checkAuthorizeUrl(authorizeUrl({}, `https://${SUPABASE_HOST}.evil.com`))).toBe(false);
    expect(checkAuthorizeUrl(authorizeUrl({}, `http://${SUPABASE_HOST}`))).toBe(false);
    expect(checkAuthorizeUrl(authorizeUrl({}, 'https://accounts.google.com'))).toBe(false);
    expect(
      checkAuthorizeUrl(authorizeUrl().replace('https://', `https://${SUPABASE_HOST}@`))
    ).toBe(false);
  });

  it('rejects any other path', () => {
    expect(checkAuthorizeUrl(authorizeUrl().replace('/auth/v1/authorize', '/auth/v1/verify'))).toBe(
      false
    );
    expect(checkAuthorizeUrl(authorizeUrl().replace('/auth/v1/authorize', '/auth/v1/authorize/'))).toBe(
      false
    );
  });

  it('rejects a redirect_to other than /auth/desktop on the app', () => {
    for (const redirect of [
      'https://do.dsul.app/auth/callback',
      'https://do.dsul.app/auth/desktop/',
      'https://do.dsul.app/auth/desktop?next=/x',
      'https://evil.com/auth/desktop',
      'http://do.dsul.app/auth/desktop',
      'dsul://auth/callback',
    ]) {
      expect(checkAuthorizeUrl(authorizeUrl({ redirect_to: redirect })), redirect).toBe(false);
    }
    expect(checkAuthorizeUrl(authorizeUrl({ redirect_to: null }))).toBe(false);
  });

  it('rejects another provider', () => {
    expect(checkAuthorizeUrl(authorizeUrl({ provider: 'github' }))).toBe(false);
    expect(checkAuthorizeUrl(authorizeUrl({ provider: null }))).toBe(false);
  });

  it('rejects a plain or missing challenge', () => {
    expect(checkAuthorizeUrl(authorizeUrl({ code_challenge_method: 'plain' }))).toBe(false);
    expect(checkAuthorizeUrl(authorizeUrl({ code_challenge_method: null }))).toBe(false);
    expect(checkAuthorizeUrl(authorizeUrl({ code_challenge: null }))).toBe(false);
    expect(checkAuthorizeUrl(authorizeUrl({ code_challenge: 'short' }))).toBe(false);
    expect(checkAuthorizeUrl(authorizeUrl({ code_challenge: `${CHALLENGE.slice(1)}=` }))).toBe(
      false
    );
  });

  it('rejects a parameter given twice, which GoTrue might read differently', () => {
    const twice = `${authorizeUrl()}&redirect_to=${encodeURIComponent('https://evil.com/x')}`;
    expect(checkAuthorizeUrl(twice)).toBe(false);
    expect(checkAuthorizeUrl(`${authorizeUrl()}&provider=github`)).toBe(false);
  });

  it("takes a dev build's own app origin and local Supabase stack", () => {
    const opts = {
      appOrigin: 'http://localhost:3000',
      supabaseOrigins: [SUPABASE_ORIGIN, 'http://127.0.0.1:54321'],
    };
    const local = authorizeUrl(
      { redirect_to: 'http://localhost:3000/auth/desktop' },
      'http://127.0.0.1:54321'
    );
    expect(checkAuthorizeUrl(local, opts)).toBe(true);
    // Production keeps refusing it.
    expect(checkAuthorizeUrl(local)).toBe(false);
  });
});

describe('parseDeepLink', () => {
  it('reads a code link', () => {
    expect(parseDeepLink(`dsul://auth/callback?code=${CODE}`)).toEqual({ type: 'code', code: CODE });
    expect(parseDeepLink('dsul://auth/callback?code=AbC.d_e~f-12')).toEqual({
      type: 'code',
      code: 'AbC.d_e~f-12',
    });
  });

  it('maps an error code to one of three words, and carries no text from the link', () => {
    expect(parseDeepLink('dsul://auth/callback?error_code=flow_state_expired')).toEqual({
      type: 'error',
      error: 'expired',
    });
    expect(parseDeepLink('dsul://auth/callback?error_code=otp_expired')).toEqual({
      type: 'error',
      error: 'expired',
    });
    expect(parseDeepLink('dsul://auth/callback?error_code=access_denied')).toEqual({
      type: 'error',
      error: 'cancelled',
    });
    expect(parseDeepLink('dsul://auth/callback?error_code=bad_oauth_state')).toEqual({
      type: 'error',
      error: 'auth',
    });
    expect(
      parseDeepLink(
        'dsul://auth/callback?error_code=otp_expired&error_description=Call%20this%20number'
      )
    ).toEqual({ type: 'error', error: 'expired' });
  });

  it('rejects the wrong scheme, host or path', () => {
    for (const url of [
      `https://auth/callback?code=${CODE}`,
      `dsul://login/callback?code=${CODE}`,
      `dsul://AUTH/callback?code=${CODE}`,
      `dsul://auth/callback/?code=${CODE}`,
      `dsul://auth/callbackx?code=${CODE}`,
      `dsul://auth/?code=${CODE}`,
      `dsul:auth/callback?code=${CODE}`,
      `dsul://user@auth/callback?code=${CODE}`,
      `dsul://auth:1/callback?code=${CODE}`,
    ]) {
      expect(parseDeepLink(url), url).toBeNull();
    }
  });

  it('rejects a code or an error code of the wrong shape', () => {
    for (const url of [
      'dsul://auth/callback?code=short',
      `dsul://auth/callback?code=${'a'.repeat(257)}`,
      'dsul://auth/callback?code=has%20space%20in%20it',
      'dsul://auth/callback?code=<script>alert(1)</script>',
      'dsul://auth/callback?error_code=Not_Lower',
      'dsul://auth/callback?error_code=has-dash',
      `dsul://auth/callback?error_code=${'a'.repeat(65)}`,
      'dsul://auth/callback?error_code=',
    ]) {
      expect(parseDeepLink(url), url).toBeNull();
    }
  });

  it('rejects a link that carries both, neither, or either twice', () => {
    for (const url of [
      'dsul://auth/callback',
      'dsul://auth/callback?next=%2F',
      `dsul://auth/callback?code=${CODE}&error_code=access_denied`,
      `dsul://auth/callback?code=${CODE}&code=${CODE}x`,
      'dsul://auth/callback?error_code=access_denied&error_code=otp_expired',
    ]) {
      expect(parseDeepLink(url), url).toBeNull();
    }
  });

  it('rejects junk', () => {
    expect(parseDeepLink('')).toBeNull();
    expect(parseDeepLink(undefined)).toBeNull();
    expect(parseDeepLink(`dsul://auth/callback?code=${CODE}&pad=${'x'.repeat(4096)}`)).toBeNull();
  });
});

describe('deepLinkFromArgv', () => {
  const exe = 'C:\\Users\\k\\AppData\\Local\\Programs\\dsul\\dsul.exe';
  const link = `dsul://auth/callback?code=${CODE}`;

  it('finds the one dsul: argument and ignores the rest', () => {
    expect(deepLinkFromArgv([exe, link])).toBe(link);
    expect(deepLinkFromArgv([exe, '--allow-file-access-from-files', link])).toBe(link);
    expect(deepLinkFromArgv([exe, 'DSUL://auth/callback'])).toBe('DSUL://auth/callback');
  });

  it('takes nothing when there is no link, or more than one', () => {
    expect(deepLinkFromArgv([exe])).toBeNull();
    expect(deepLinkFromArgv([exe, link, link])).toBeNull();
    expect(deepLinkFromArgv([exe, 'https://do.dsul.app/auth/callback?code=x'])).toBeNull();
    expect(deepLinkFromArgv(undefined)).toBeNull();
  });
});

describe('livePending', () => {
  const now = 1_800_000_000_000;

  it('keeps a window that is still open', () => {
    expect(livePending({ kind: 'google', until: now + 60_000 }, now)).toEqual({
      kind: 'google',
      until: now + 60_000,
    });
    expect(livePending({ kind: 'email', until: now + EMAIL_PENDING_MS }, now)).toEqual({
      kind: 'email',
      until: now + EMAIL_PENDING_MS,
    });
  });

  it('drops a lapsed window', () => {
    expect(livePending({ kind: 'google', until: now }, now)).toBeNull();
    expect(livePending({ kind: 'email', until: now - 1 }, now)).toBeNull();
  });

  it('drops a window longer than its kind allows, as after the clock moved back', () => {
    expect(livePending({ kind: 'google', until: now + GOOGLE_PENDING_MS + 1 }, now)).toBeNull();
    expect(livePending({ kind: 'email', until: now + EMAIL_PENDING_MS + 1 }, now)).toBeNull();
  });

  it('drops a malformed record', () => {
    expect(livePending(null, now)).toBeNull();
    expect(livePending({ kind: 'magic', until: now + 1000 }, now)).toBeNull();
    expect(livePending({ kind: 'google', until: String(now + 1000) }, now)).toBeNull();
    expect(livePending({ kind: 'google', until: Infinity }, now)).toBeNull();
  });
});

describe('newerRelease', () => {
  const release = (tag: string, extra: Record<string, unknown> = {}) => ({
    tag_name: tag,
    html_url: `https://github.com/kjswalls/dsul/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    ...extra,
  });

  it('reports a newer release and where to get it', () => {
    expect(newerRelease(release('v0.2.0'), '0.1.0')).toEqual({
      version: '0.2.0',
      url: 'https://github.com/kjswalls/dsul/releases/tag/v0.2.0',
    });
    expect(newerRelease(release('v0.1.10'), '0.1.9')?.version).toBe('0.1.10');
    expect(newerRelease(release('1.0.0'), '0.9.9')?.version).toBe('1.0.0');
  });

  it('stays quiet for the same or an older release', () => {
    expect(newerRelease(release('v0.1.0'), '0.1.0')).toBeNull();
    expect(newerRelease(release('v0.0.9'), '0.1.0')).toBeNull();
  });

  it('ignores drafts, prereleases, odd tags and other repos', () => {
    expect(newerRelease(release('v9.0.0', { draft: true }), '0.1.0')).toBeNull();
    expect(newerRelease(release('v9.0.0', { prerelease: true }), '0.1.0')).toBeNull();
    expect(newerRelease(release('v9.0.0-beta.1'), '0.1.0')).toBeNull();
    expect(newerRelease(release('latest'), '0.1.0')).toBeNull();
    expect(
      newerRelease(release('v9.0.0', { html_url: 'https://evil.com/kjswalls/dsul/releases/x' }), '0.1.0')
    ).toBeNull();
    expect(
      newerRelease(release('v9.0.0', { html_url: 'https://github.com/someone/else/releases/x' }), '0.1.0')
    ).toBeNull();
    expect(newerRelease(null, '0.1.0')).toBeNull();
    expect(newerRelease({ message: 'Not Found' }, '0.1.0')).toBeNull();
  });
});
