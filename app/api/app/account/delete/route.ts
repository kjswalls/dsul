import { readJson } from '@/app/api/ai/_shared/guard';
import { authenticateAppCaller } from '@/lib/app-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { deleteAccount } from '@/lib/account-server/delete';
import { accountError, accountJson, accountRefusal, parseDeleteBody } from '@/lib/account-server/http';
import type { AccountDeleted } from '@/lib/account-types';

/**
 * POST /api/app/account/delete — the iPhone deletes the signed-in account and
 * everything in it, at once (memory/plans/account-deletion.md).
 *
 * Body: {"account":"<uuid>","confirm":"DELETE"}, plus "appleCode" when Apple's
 * sheet gave one. `account` is the id the sheet was opened for: a guard, never
 * a target. The account deleted is always the verified caller's, and only if
 * it is still the one on screen (409 changed otherwise).
 *
 * In order, so nothing is built or read for a caller or a body that fails: the
 * bearer (401/503, or gone), the body (any problem is 400 invalid), the guard
 * (409), a gone caller's 200 (a retry whose first answer was lost: nothing is
 * left to delete), then the service client and the delete. 500 failed means
 * nothing was deleted; 503 means a retry will settle it.
 *
 * Bearer Supabase access token only (lib/app-auth.ts). No agent key, MCP,
 * cron or service-role path reaches this.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Two Apple calls of at most 5 s each and at most three GoTrue calls. */
export const maxDuration = 30;

const MAX_BODY_BYTES = 2048;

export async function POST(req: Request): Promise<Response> {
  const caller = await authenticateAppCaller(req);
  if (caller instanceof Response) return accountRefusal(caller);

  const read = await readJson<unknown>(req, MAX_BODY_BYTES);
  const body = read.ok ? parseDeleteBody(read.body, { appleCode: true }) : null;
  if (!body) return accountError(400, 'invalid');

  if (body.account !== caller.userId.toLowerCase()) return accountError(409, 'changed');
  if ('gone' in caller) return accountJson({ deleted: true, apple: 'unknown' } satisfies AccountDeleted);

  let svc;
  try {
    svc = createServiceClient();
  } catch {
    return accountError(503, 'unavailable');
  }
  const result = await deleteAccount(svc, { userId: caller.userId, appleCode: body.appleCode });
  if (!result.ok) return accountError(result.error === 'failed' ? 500 : 503, result.error);
  return accountJson({ deleted: true, apple: result.apple } satisfies AccountDeleted);
}
