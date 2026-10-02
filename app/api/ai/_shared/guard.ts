/**
 * The checks every `/api/ai/*` route (and `/api/chat`) makes before it does
 * anything: who is asking, from where, with what body — and the one way they
 * all answer, uncached.
 *
 * Lives under `app/api` rather than `lib/` because `.auth.getUser(` is banned
 * everywhere else (tests/unit/no-mount-getuser.test.ts scans lib). A `_` folder
 * is not routed, so nothing here is reachable as an endpoint.
 */

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase-server';
import type { ApiErrorCode } from '@/lib/ai-types';

/**
 * Status must never be served stale after a disconnect, and no response here
 * may sit in a shared cache. Every response from these routes carries it.
 */
export const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * The signed-in user, validated by the auth server, and the cookie client that
 * validated them. Null on any failure.
 *
 * `db` runs as that user: RLS and SECURITY INVOKER functions are the tenant
 * guard on everything a route does with it (the saved conversations). It is
 * never the service role.
 */
export async function requireSession(): Promise<{ user: { id: string }; db: SupabaseClient } | null> {
  try {
    const db = await createClient();
    const {
      data: { user },
      error,
    } = await db.auth.getUser();
    if (error || !user) return null;
    return { user: { id: user.id }, db };
  } catch {
    return null;
  }
}

/** The signed-in user, validated by the auth server. Null on any failure. */
export async function requireSessionUser(): Promise<{ id: string } | null> {
  return (await requireSession())?.user ?? null;
}

/**
 * A state-changing request that came from this app's own pages.
 *
 * `Sec-Fetch-Site` absent, `same-origin` or `none`; and `Origin`, when sent,
 * not `null` and naming this host. Defense in depth on top of SameSite=Lax:
 * the JSON content-type requirement in `readJson` already forces a preflight
 * on any cross-site fetch.
 */
export function isSameOrigin(req: Request): boolean {
  const site = req.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') return false;

  const origin = req.headers.get('origin');
  if (origin === null) return true;
  if (origin === 'null') return false;
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

/**
 * A top-level GET navigation that arms state (OpenRouter `/start`).
 *
 * `Sec-Fetch-Site` `same-origin` or `none`, or absent (pre-2023 browsers; the
 * callback's state check still binds the flow). `same-site` and `cross-site`
 * fail: a sibling subdomain or another site must not be able to start a flow
 * in the user's name.
 */
export function isSameOriginNavigation(req: Request): boolean {
  const site = req.headers.get('sec-fetch-site');
  return site === null || site === 'same-origin' || site === 'none';
}

type ReadJsonResult<T> =
  | { ok: true; body: T }
  | { ok: false; status: 400 | 413 | 415; error: 'invalid' | 'too_large' | 'unsupported_media' };

/**
 * The request body as JSON, read with a byte cap.
 *
 * The cap is enforced on the bytes actually read, not only on a declared
 * `Content-Length`, so a chunked body cannot walk past it. The parsed value is
 * returned UNVALIDATED: the caller owns its shape.
 */
export async function readJson<T>(req: Request, maxBytes: number): Promise<ReadJsonResult<T>> {
  const type = req.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(type.trim())) {
    return { ok: false, status: 415, error: 'unsupported_media' };
  }

  const declared = req.headers.get('content-length');
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) return { ok: false, status: 413, error: 'too_large' };
  }

  if (!req.body) return { ok: false, status: 400, error: 'invalid' };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        return { ok: false, status: 413, error: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, error: 'invalid' };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { ok: true, body: JSON.parse(text) as T };
  } catch {
    return { ok: false, status: 400, error: 'invalid' };
  }
}

/** `{ error, ...extra }` with `Cache-Control: no-store`. `error` cannot be overridden by `extra`. */
export function jsonError(
  status: number,
  error: ApiErrorCode,
  extra?: Record<string, unknown>
): NextResponse {
  return NextResponse.json({ ...extra, error }, { status, headers: NO_STORE });
}

/** A JSON body with `Cache-Control: no-store`. */
export function jsonOk(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}
