import { createHash } from 'node:crypto';

/**
 * Where the iPhone app's sign-in is handed back to the app: Google, and the
 * emailed link.
 *
 * The app opens Supabase's /authorize inside ASWebAuthenticationSession with
 * `redirect_to` set here, and holds its own PKCE verifier. This route exchanges
 * nothing. It forwards the code to app.dsul.ios://auth/callback, which the
 * auth session catches and returns to the app, and the app exchanges the code
 * with GoTrue itself (memory/plans/ios-app.md).
 *
 * AN EMAILED LINK (`?via=email&n=…`, from GoTrue's /verify in whatever browser
 * the mail app uses) ALWAYS GETS THE PAGE. Its script forwards the code with
 * the nonce `n`, which the app matches against the sign-in it started, and
 * keeps both in the fragment rather than dropping them, so an in-app browser
 * that won't open the app can still "Open in Safari". The fragment never
 * reaches a server or a Referer, and the code is useless without the verifier
 * in the phone's Keychain.
 *
 * THE COMMON CASE IS A 302. A well-formed `?code` (or an error code) in the
 * query answers with a redirect straight to the scheme: a plain HTTP redirect
 * is the case the auth session is built to catch, where a script navigation is
 * not proven to be. Only the shapes below are ever written into the Location,
 * and never `error_description`, which is server text.
 *
 * EVERYTHING ELSE GETS ONE CONSTANT PAGE, the /auth/desktop pattern: the same
 * bytes for every request, a script allowed by hash, and the script reads the
 * URL in the browser. It exists for what the server never sees, an error
 * carried in the hash, and as the "Open dsul" button if the hand-off stalls. A
 * token in the hash is never forwarded: in the implicit flow those arrive
 * there, and they must not leave the browser.
 *
 * A Route Handler, not a page, for /auth/desktop's reasons: a page would mount
 * SupabaseProvider, whose browser client tries to exchange any `?code=`
 * itself, and Analytics, which would log the URL with the code in it.
 */

const SCHEME_CALLBACK = 'app.dsul.ios://auth/callback';
const CODE = /^[A-Za-z0-9._~-]{8,256}$/;
const ERROR_CODE = /^[a-z_]{1,64}$/;

// The script's code and error shapes are the constants above, spelled again
// because the script is a string: the route test runs both and checks they
// agree.
// The forwarded error code prefers `error_code` (otp_expired,
// flow_state_expired) and falls back to `error` (access_denied), because older
// GoTrue builds put an HTTP status in `error_code`. The address bar is cleared
// before the hand-off, so the code does not stay in history; an emailed link's
// moves to the fragment instead (see above). The nonce's shape is the app's
// (`parseEmailCallback`, ios/DsulCore AuthCore.swift).
const SCRIPT = `
(function () {
  var CODE = /^[A-Za-z0-9._~-]{8,256}$/;
  var ERROR_CODE = /^[a-z_]{1,64}$/;
  var NONCE = /^[A-Za-z0-9_-]{16,64}$/;
  var query = new URLSearchParams(location.search);
  var hash = new URLSearchParams(location.hash.slice(1));

  function pick(name, shape) {
    var fromQuery = query.get(name);
    if (fromQuery !== null && shape.test(fromQuery)) return fromQuery;
    var fromHash = hash.get(name);
    if (fromHash !== null && shape.test(fromHash)) return fromHash;
    return null;
  }

  var email = pick('via', /^email$/) !== null;
  var nonce = email ? pick('n', NONCE) : null;
  var code = pick('code', CODE);
  var error = code ? null : pick('error_code', ERROR_CODE) || pick('error', ERROR_CODE);
  var item = code
    ? 'code=' + encodeURIComponent(code)
    : error
      ? 'error_code=' + encodeURIComponent(error)
      : null;
  if (email && !nonce) item = null;
  var target = item ? 'app.dsul.ios://auth/callback?' + item + (email ? '&n=' + nonce : '') : null;

  history.replaceState(null, '', location.pathname + (email && item ? '#via=email&n=' + nonce + '&' + item : ''));

  if (email) document.getElementById('email-help').hidden = false;

  if (!target) {
    document.getElementById('opening').hidden = true;
    document.getElementById('done').hidden = false;
    return;
  }

  function open() {
    location.replace(target);
  }
  document.getElementById('open').addEventListener('click', open);
  open();
})();
`;

// Computed here rather than pasted into the policy, so an edit to the script
// can never leave a stale hash that silently blocks it.
const SCRIPT_HASH = createHash('sha256').update(SCRIPT, 'utf8').digest('base64');

// Nothing on this page loads from anywhere, so everything but the one script
// and the inline styles is refused outright, and no other site may frame it.
const CSP = [
  "default-src 'none'",
  `script-src 'sha256-${SCRIPT_HASH}'`,
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// /auth/desktop's page with the phone's copy. The background pair is the app's
// own (app/layout.tsx), and the rest are the login page's tokens from
// globals.css, written out as hex: this page loads no stylesheet. The lime is
// the accent, so it keeps full strength in the dark.
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>dsul</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: #fbfaf9;
    color: #1d1f24;
    font: 14px/1.55 Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { width: 100%; max-width: 20rem; }
  .mark { margin: 0 0 28px; font-size: 15px; font-weight: 600; letter-spacing: -0.02em; }
  .mark span {
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-left: 2px;
    border-radius: 50%;
    background: #b8e45c;
  }
  h1 { margin: 0 0 8px; font-size: 22px; font-weight: 600; line-height: 1.15; letter-spacing: -0.028em; }
  p { margin: 0; }
  .muted { color: #8b92a5; font-size: 13.5px; }
  .aside { margin-top: 24px; font-size: 12.5px; }
  button {
    margin-top: 20px;
    width: 100%;
    height: 44px;
    border: 0;
    border-radius: 10px;
    background: #b8e45c;
    color: #273a0f;
    font: inherit;
    font-size: 15px;
    font-weight: 500;
    cursor: pointer;
  }
  button:focus-visible { outline: 2px solid #b8e45c; outline-offset: 2px; }
  @media (prefers-color-scheme: dark) {
    body { background: #0e1014; color: #f0f0f1; }
    .muted { color: #9e9ea3; }
    .mark span, button { background: #b8e948; }
    button { color: #1a2906; }
    button:focus-visible { outline-color: #b8e948; }
  }
</style>
</head>
<body>
<main>
  <p class="mark" aria-hidden="true">dsul<span></span></p>
  <div id="opening">
    <h1>Opening dsul…</h1>
    <p class="muted">If your iPhone asks, let it open dsul.</p>
    <p class="muted aside" id="email-help" hidden>Tap Open only if the prompt names dsul. Nothing happened? Open this page in Safari.</p>
    <button id="open" type="button">Open dsul</button>
    <p class="muted aside">Opened this somewhere else? Go back to the dsul app on your iPhone and sign in from there.</p>
  </div>
  <div id="done" hidden>
    <h1>You can close this page.</h1>
    <p class="muted">If dsul hasn’t signed you in, go back to the app and sign in again.</p>
  </div>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;

// Never prerendered or cached: the headers below have to reach the browser as
// written, and the URL this is fetched with carries a sign-in code.
export const dynamic = 'force-dynamic';

const COMMON_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
} as const;

/** The scheme URL for this query, or null when it carries nothing to forward. */
function callbackTarget(search: URLSearchParams): string | null {
  const code = search.get('code');
  if (code !== null && CODE.test(code)) {
    return `${SCHEME_CALLBACK}?code=${encodeURIComponent(code)}`;
  }
  for (const name of ['error_code', 'error']) {
    const value = search.get(name);
    if (value !== null && ERROR_CODE.test(value)) {
      return `${SCHEME_CALLBACK}?error_code=${encodeURIComponent(value)}`;
    }
  }
  return null;
}

export function GET(request: Request): Response {
  const search = new URL(request.url).searchParams;
  // An emailed link always gets the page (see above); Google's code gets the 302.
  const target = search.get('via') === 'email' ? null : callbackTarget(search);
  if (target) {
    return new Response(null, {
      status: 302,
      headers: { Location: target, ...COMMON_HEADERS },
    });
  }
  return new Response(PAGE, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      ...COMMON_HEADERS,
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': CSP,
    },
  });
}
