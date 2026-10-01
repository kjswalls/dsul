import { createHash } from 'node:crypto';

/**
 * Where a desktop sign-in that finished in the system browser is handed back to
 * the app.
 *
 * The desktop login sends Google and the email link here instead of to
 * /auth/callback, because the PKCE verifier lives in the app's cookie jar and
 * not the browser's. This page exchanges nothing. It forwards the code to
 * dsul://auth/callback, and the app's main process loads /auth/callback with it
 * in its own window (memory/plans/desktop-app.md, "Sign-in handoff").
 *
 * A Route Handler, not a page: a page would mount SupabaseProvider, whose
 * browser client tries to exchange any `?code=` itself, and Analytics, which
 * would log the URL with the code in it.
 *
 * The body is one constant string, the same for every request, so nothing from
 * the URL is ever written into the HTML. The script reads the URL in the
 * browser and forwards only a code or an error code of a known shape. Never
 * `error_description`, which is server text, and never a token: in the implicit
 * flow those arrive in the hash, and they must not leave the browser.
 */

// The forwarded error code prefers `error_code` (otp_expired,
// flow_state_expired) and falls back to `error` (access_denied), because older
// GoTrue builds put an HTTP status in `error_code`. Errors can arrive in the
// query or the hash, so both are read. The address bar is cleared before the
// hand-off, so the code does not stay in history.
const SCRIPT = `
(function () {
  var CODE = /^[A-Za-z0-9._~-]{8,256}$/;
  var ERROR_CODE = /^[a-z_]{1,64}$/;
  var query = new URLSearchParams(location.search);
  var hash = new URLSearchParams(location.hash.slice(1));

  function pick(name, shape) {
    var fromQuery = query.get(name);
    if (fromQuery !== null && shape.test(fromQuery)) return fromQuery;
    var fromHash = hash.get(name);
    if (fromHash !== null && shape.test(fromHash)) return fromHash;
    return null;
  }

  var code = pick('code', CODE);
  var error = code ? null : pick('error_code', ERROR_CODE) || pick('error', ERROR_CODE);
  var target = code
    ? 'dsul://auth/callback?code=' + encodeURIComponent(code)
    : error
      ? 'dsul://auth/callback?error_code=' + encodeURIComponent(error)
      : null;

  history.replaceState(null, '', location.pathname);

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

// The background pair is the app's own (app/layout.tsx), and the rest are the
// login page's tokens from globals.css, written out as hex: this page loads no
// stylesheet. The lime is the accent, so it keeps full strength in the dark.
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
    height: 40px;
    border: 0;
    border-radius: 10px;
    background: #b8e45c;
    color: #273a0f;
    font: inherit;
    font-size: 13.5px;
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
    <p class="muted">If your browser asks, let it open dsul.</p>
    <button id="open" type="button">Open dsul</button>
    <p class="muted aside">Opened this on your phone or another computer? Go back to the computer where you asked to sign in.</p>
  </div>
  <div id="done" hidden>
    <h1>You can close this tab.</h1>
    <p class="muted">If dsul hasn’t signed you in, go back to it and sign in again.</p>
  </div>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;

// Never prerendered or cached: the headers below have to reach the browser as
// written, and the URL this is fetched with carries a sign-in code.
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return new Response(PAGE, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': CSP,
    },
  });
}
