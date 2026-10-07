/**
 * The sandbox frame's Content-Security-Policy (memory/plans/mods.md, build
 * order 8). Plain .mjs, so scripts/build-mod-runtime.mjs can import it with
 * node: the policy is part of what the runtime version hashes.
 *
 * - `sandbox allow-scripts` and never `allow-same-origin`: the frame runs in
 *   an opaque origin with no cookies, storage or app origin to reach.
 * - The one inline script is pinned by its hash. No `'self'` (an opaque
 *   origin makes it mean nothing reliable) and no `'unsafe-inline'`.
 * - `'wasm-unsafe-eval'` lets QuickJS instantiate; a blob worker inherits
 *   this policy, so it covers the worker too.
 * - `connect-src 'none'` and no `blob:` in script-src stop a dynamic
 *   import(), which a worker cannot have deleted.
 * - `child-src blob:` is for Safari versions that fall back from worker-src.
 *
 * @param {string} bootHash base64 sha256 of the frame's inline script
 * @returns {string}
 */
export function sandboxCsp(bootHash) {
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    `script-src 'sha256-${bootHash}' 'wasm-unsafe-eval'`,
    'worker-src blob:',
    'child-src blob:',
    "connect-src 'none'",
    "img-src 'none'",
    "style-src 'none'",
    "font-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}
