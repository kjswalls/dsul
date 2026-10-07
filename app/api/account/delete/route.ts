import { isSameOrigin, readJson } from '@/app/api/ai/_shared/guard';
import { createServiceClient } from '@/lib/supabase-service';
import { deleteAccount } from '@/lib/account-server/delete';
import { accountError, accountJson, parseDeleteBody } from '@/lib/account-server/http';
import type { AccountDeleted } from '@/lib/account-types';
import { accountSession } from '../_shared/session';

/**
 * POST /api/account/delete — the web (and the desktop app) deletes the
 * signed-in account and everything in it, at once
 * (memory/plans/account-deletion.md).
 *
 * Body: {"account":"<uuid>","confirm":"DELETE"}, JSON, at most 1024 bytes.
 * `account` is the id the dialog was opened for. It matters most here: a
 * browser can switch accounts under an open tab (an email link for another
 * account opened in a second tab), so the server deletes nothing unless the
 * session is still that account (409 changed).
 *
 * In order: same origin (403), the cookie session (401/503, or gone), the body
 * (415/413/400), the guard (409), a gone caller's 200, then the service client
 * and the delete. The web never revokes Sign in with Apple (it has no fresh
 * code from Apple), so the body takes no appleCode; the dialog tells an Apple
 * account how to remove dsul there themselves.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** At most three GoTrue calls; no Apple call from the web. */
export const maxDuration = 30;

const MAX_BODY_BYTES = 1024;

export async function POST(req: Request): Promise<Response> {
  if (!isSameOrigin(req)) return accountError(403, 'forbidden');

  const caller = await accountSession();
  if (caller instanceof Response) return caller;

  const read = await readJson<unknown>(req, MAX_BODY_BYTES);
  if (!read.ok) return accountError(read.status, read.error);
  const body = parseDeleteBody(read.body, { appleCode: false });
  if (!body) return accountError(400, 'invalid');

  if (body.account !== caller.userId.toLowerCase()) return accountError(409, 'changed');
  if ('gone' in caller) return accountJson({ deleted: true, apple: 'unknown' } satisfies AccountDeleted);

  let svc;
  try {
    svc = createServiceClient();
  } catch {
    return accountError(503, 'unavailable');
  }
  const result = await deleteAccount(svc, { userId: caller.userId });
  if (!result.ok) return accountError(result.error === 'failed' ? 500 : 503, result.error);
  return accountJson({ deleted: true, apple: result.apple } satisfies AccountDeleted);
}
