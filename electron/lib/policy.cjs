'use strict';

// Every decision the shell makes about a URL, a deep link or a release lives here, so the root
// unit suite can test it (tests/unit/electron-policy.test.ts). Keep it pure: no requires, nothing
// from Electron or Node. URL and URLSearchParams are globals in the main process and in vitest.

const APP_ORIGIN = 'https://do.dsul.app';
// Mirrors production's NEXT_PUBLIC_SUPABASE_URL. A desktop Google or Apple sign-in may only open
// an authorize URL on this host.
const SUPABASE_HOST = 'ctcspcferkdlzdcqlozq.supabase.co';
const SUPABASE_ORIGIN = `https://${SUPABASE_HOST}`;

// The providers a desktop sign-in may open in the system browser. preload.cjs advertises the
// same list to the page as `authProviders`, so the login only offers what this file allows (a
// test holds the two together).
const OAUTH_PROVIDERS = Object.freeze(['google', 'apple']);

// How long a sign-in started in the app keeps accepting a dsul:// link. A provider's code dies
// with GoTrue's flow state at 300s, so ten minutes is generous. A magic link can sit in an inbox
// for longer.
const OAUTH_PENDING_MS = 10 * 60 * 1000;
const EMAIL_PENDING_MS = 60 * 60 * 1000;

const RELEASES_API = 'https://api.github.com/repos/kjswalls/dsul/releases/latest';

// A packaged build refuses to start with any of these. Each lets another process drive the
// window, read its traffic (a net log with cookie values, TLS keys for a packet capture), or
// switch off its checks (certificates, the proxy, same-origin). No list of Chromium switches is
// ever complete; this one closes the ones known to do those things.
const BLOCKED_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-pipe',
  'inspect',
  'inspect-brk',
  'host-resolver-rules',
  'ignore-certificate-errors',
  'ignore-certificate-errors-spki-list',
  'proxy-server',
  'proxy-pac-url',
  'disable-web-security',
  'log-net-log',
  'net-log-capture-mode',
  'ssl-key-log-file',
];

// The same shapes /auth/desktop forwards. Anything else never came from that page.
const CODE_SHAPE = /^[A-Za-z0-9._~-]{8,256}$/;
const ERROR_CODE_SHAPE = /^[a-z_]{1,64}$/;
// An S256 challenge is 43 base64url characters; RFC 7636 allows up to 128.
const CHALLENGE_SHAPE = /^[A-Za-z0-9_-]{43,128}$/;

function parse(raw) {
  if (typeof raw !== 'string' || raw.length > 8192) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

// Compares scheme and host, never `.origin`: `blob:https://do.dsul.app/x` has the app's origin
// but is not the app.
function sameSite(u, origin) {
  const o = parse(origin);
  return !!u && !!o && u.protocol === o.protocol && u.host === o.host && !u.username && !u.password;
}

// A path as a server might route it: decoded, case-folded, slashes collapsed. Only used to
// decide what to BLOCK, so reading it loosely can only block more.
function loosePath(pathname) {
  let p = pathname;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    // Malformed escapes: judge the raw path.
  }
  return p.toLowerCase().replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
}

/** True for a page of the app itself. `appOrigin` is only ever overridden by a dev build. */
function isAppUrl(raw, appOrigin = APP_ORIGIN) {
  return sameSite(parse(raw), appOrigin);
}

/**
 * True when loading this URL in the window could exchange a code against the window's cookie jar.
 * /auth/callback exchanges whatever arrives, the root forwards `/?code=` there, and the browser
 * client exchanges `code` on any page load while a verifier exists, reading the fragment as well
 * as the query (auth-js parseParametersFromURL). Only main's own loadURL may carry one.
 */
function carriesAuthCode(raw) {
  const u = parse(raw);
  if (!u) return false;
  if (loosePath(u.pathname) === '/auth/callback') return true;
  if (u.searchParams.has('code')) return true;
  return new URLSearchParams(u.hash.slice(1)).has('code');
}

/** Schemes a link may hand to the OS. Everything else (file:, smb:, custom handlers) stays shut. */
function externalAllowed(raw) {
  const u = parse(raw);
  return !!u && (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:');
}

/** True for a Supabase authorize endpoint, whatever its parameters. */
function isAuthorizeEndpoint(raw, supabaseOrigins = [SUPABASE_ORIGIN]) {
  const u = parse(raw);
  return (
    !!u &&
    supabaseOrigins.some((o) => sameSite(u, o)) &&
    loosePath(u.pathname) === '/auth/v1/authorize'
  );
}

/**
 * Whether `openAuthUrl` may open this URL and arm a Google or Apple sign-in: exactly the URL the
 * desktop login builds with signInWithOAuth, so the bridge can't be used to open anything else, or
 * to start a flow whose code would come back somewhere other than /auth/desktop.
 */
function checkAuthorizeUrl(raw, { appOrigin = APP_ORIGIN, supabaseOrigins = [SUPABASE_ORIGIN] } = {}) {
  const u = parse(raw);
  if (!u || u.hash || !supabaseOrigins.some((o) => sameSite(u, o))) return false;
  if (u.pathname !== '/auth/v1/authorize') return false;
  // A repeated parameter could be read differently here and by GoTrue, so each must appear once.
  const one = (key) => {
    const all = u.searchParams.getAll(key);
    return all.length === 1 ? all[0] : null;
  };
  return (
    OAUTH_PROVIDERS.includes(one('provider')) &&
    one('redirect_to') === `${appOrigin}/auth/desktop` &&
    (one('code_challenge_method') || '').toLowerCase() === 's256' &&
    CHALLENGE_SHAPE.test(one('code_challenge') || '')
  );
}

function errorKind(code) {
  if (code === 'flow_state_expired' || code === 'otp_expired') return 'expired';
  if (code === 'access_denied') return 'cancelled';
  return 'auth';
}

/**
 * Reads a dsul://auth/callback link into `{ type: 'code', code }` or
 * `{ type: 'error', error: 'expired' | 'cancelled' | 'auth' }`, or null for anything else.
 * No text from the link survives except a code of the expected shape: an error becomes one of
 * three words the login page has its own copy for.
 */
function parseDeepLink(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  const u = parse(raw);
  if (!u || u.protocol !== 'dsul:' || u.host !== 'auth' || u.pathname !== '/callback') return null;
  if (u.username || u.password || u.port) return null;
  const codes = u.searchParams.getAll('code');
  const errors = u.searchParams.getAll('error_code');
  if (codes.length + errors.length !== 1) return null;
  if (codes.length) return CODE_SHAPE.test(codes[0]) ? { type: 'code', code: codes[0] } : null;
  return ERROR_CODE_SHAPE.test(errors[0]) ? { type: 'error', error: errorKind(errors[0]) } : null;
}

/**
 * The dsul: link in a command line, from process.argv or second-instance. Exactly one entry may
 * be a link. None, or several, means the launch carries no link at all.
 */
function deepLinkFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  const links = argv.filter((a) => typeof a === 'string' && a.slice(0, 5).toLowerCase() === 'dsul:');
  return links.length === 1 ? links[0] : null;
}

/**
 * A pending sign-in read back from auth-pending.json, or null once it has lapsed. A window that
 * ends further out than its own length means the clock moved back since it was written, so it
 * is dropped rather than trusted.
 */
function livePending(record, now) {
  if (!record || typeof record !== 'object') return null;
  const { kind, until } = record;
  const span = kind === 'oauth' ? OAUTH_PENDING_MS : kind === 'email' ? EMAIL_PENDING_MS : 0;
  if (!span || typeof until !== 'number' || !Number.isFinite(until)) return null;
  if (until <= now || until - now > span) return null;
  return { kind, until };
}

/**
 * True when a packaged build must refuse this launch. `hasSwitch` is app.commandLine.hasSwitch;
 * `env` is process.env, because Chromium also takes the TLS key log path from SSLKEYLOGFILE.
 */
function blockedLaunch(hasSwitch, env) {
  return BLOCKED_SWITCHES.some((s) => hasSwitch(s)) || !!(env && env.SSLKEYLOGFILE);
}

function semver(v) {
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(typeof v === 'string' ? v.trim() : '');
  return m ? m.slice(1).map(Number) : null;
}

/**
 * The update notice: `{ version, url }` when GitHub's latest release is newer than the running
 * shell, else null. The tray opens `url`, so it must be this repo's own release page.
 */
function newerRelease(release, currentVersion) {
  if (!release || typeof release !== 'object' || release.draft || release.prerelease) return null;
  const latest = semver(release.tag_name);
  const current = semver(currentVersion);
  const page = parse(release.html_url);
  if (!latest || !current || !page) return null;
  if (page.protocol !== 'https:' || page.host !== 'github.com') return null;
  if (!page.pathname.startsWith('/kjswalls/dsul/releases/')) return null;
  for (let i = 0; i < 3; i++) {
    if (latest[i] !== current[i]) {
      return latest[i] > current[i] ? { version: latest.join('.'), url: page.href } : null;
    }
  }
  return null;
}

module.exports = {
  APP_ORIGIN,
  SUPABASE_HOST,
  SUPABASE_ORIGIN,
  OAUTH_PROVIDERS,
  OAUTH_PENDING_MS,
  EMAIL_PENDING_MS,
  RELEASES_API,
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
};
