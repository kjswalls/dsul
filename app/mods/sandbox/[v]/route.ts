import { MOD_RUNTIME_VERSION, SANDBOX_CSP, SANDBOX_PAGE } from '@/lib/mods/sandbox/generated/page';

/**
 * The mod sandbox frame (memory/plans/mods.md, build order 8): one
 * self-contained page per runtime version, written by
 * scripts/build-mod-runtime.mjs. It holds the frame script, LOCKDOWN, the
 * worker and the wasm, and no account data.
 *
 * Only the current version exists (`dynamicParams = false`), so a page from
 * an older deploy is a 404, never a stale page cached as immutable. Outside
 * the proxy's matcher (proxy.ts), so loading it costs no getUser() and a
 * signed-out moment can never put the login page inside the frame. No
 * X-Frame-Options: the app frames it, and the CSP's frame-ancestors 'self'
 * says who may.
 */
export const dynamic = 'force-static';
export const dynamicParams = false;

export function generateStaticParams() {
  return [{ v: MOD_RUNTIME_VERSION }];
}

export function GET() {
  return new Response(SANDBOX_PAGE, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': SANDBOX_CSP,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
