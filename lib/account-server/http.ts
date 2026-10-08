import { NextResponse } from 'next/server';
import type { createServiceClient } from '@/lib/supabase-service';
import { ACCOUNT_CONFIRM_WORD, type AccountErrorCode } from '@/lib/account-types';

/**
 * How the four account routes answer, and the delete body they all take
 * (memory/plans/account-deletion.md).
 *
 * Every answer is JSON and `no-store`: the facts name the account and the
 * services it used, and a deletion's answer must never be replayed from a
 * cache. An error body is `{"error":"<code>"}` and nothing else, so no
 * GoTrue, Postgres or Apple text ever reaches a client.
 *
 * Server-only, like everything under lib/account-server: imported only from
 * app/api/** (tests/unit/account-server-boundary.test.ts).
 */

/** lib/supabase-service.ts declares this alias but doesn't export it. */
export type ServiceClient = ReturnType<typeof createServiceClient>;

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export function accountJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** A 503 also says when to come back, as lib/app-auth.ts's `unavailable()` does. */
export function accountError(status: number, error: AccountErrorCode): NextResponse {
  const headers: Record<string, string> = { ...NO_STORE };
  if (status === 503) headers['Retry-After'] = '5';
  return NextResponse.json({ error }, { status, headers });
}

/**
 * lib/app-auth.ts's refusal (a 401 or a 503, without `no-store`), re-answered
 * the account routes' way. It never carries more than its status.
 */
export function accountRefusal(res: Response): NextResponse {
  return res.status === 503 ? accountError(503, 'unavailable') : accountError(401, 'unauthorized');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const APPLE_CODE = /^[\x21-\x7E]{1,1024}$/;

export interface DeleteBody {
  /** Lower-cased: the id the confirmation was opened for. A guard, never a target. */
  account: string;
  appleCode?: string;
}

/**
 * The delete body, strictly, or null for a 400. `confirm` is the constant the
 * client sends whatever was typed; `account` is required; `appleCode` is
 * allowed only on the phone's route; any other key is refused, so a body can
 * never name a different user to delete.
 */
export function parseDeleteBody(raw: unknown, opts: { appleCode: boolean }): DeleteBody | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const allowed = opts.appleCode ? ['account', 'appleCode', 'confirm'] : ['account', 'confirm'];
  if (Object.keys(body).some((key) => !allowed.includes(key))) return null;

  if (body.confirm !== ACCOUNT_CONFIRM_WORD) return null;
  if (typeof body.account !== 'string') return null;
  const account = body.account.toLowerCase();
  if (!UUID.test(account)) return null;

  if (!('appleCode' in body)) return { account };
  const code = body.appleCode;
  if (typeof code !== 'string' || !APPLE_CODE.test(code)) return null;
  return { account, appleCode: code };
}
