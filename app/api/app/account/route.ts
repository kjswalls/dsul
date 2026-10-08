import { authenticateAppCaller } from '@/lib/app-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { readAccountFacts } from '@/lib/account-server/facts';
import { accountError, accountJson, accountRefusal } from '@/lib/account-server/http';

/**
 * GET /api/app/account — what the iPhone's Delete account sheet says before
 * anyone deletes: the account, and which "dsul can't delete this for you" lines
 * apply (memory/plans/account-deletion.md). Bearer Supabase access token only
 * (lib/app-auth.ts), never a cookie.
 *
 * 401 unauthorized, 410 gone (the account is already deleted: a sheet reopened
 * after a delete whose answer was lost), 503 unavailable. Names and booleans
 * only: no key, token or secret value is ever in the answer.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const caller = await authenticateAppCaller(req);
  if (caller instanceof Response) return accountRefusal(caller);
  if ('gone' in caller) return accountError(410, 'gone');

  let svc;
  try {
    svc = createServiceClient();
  } catch {
    return accountError(503, 'unavailable');
  }
  const facts = await readAccountFacts(svc, caller.userId);
  if (facts === 'gone') return accountError(410, 'gone');
  if (facts === 'unavailable') return accountError(503, 'unavailable');
  return accountJson(facts);
}
