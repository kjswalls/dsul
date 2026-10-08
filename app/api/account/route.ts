import { createServiceClient } from '@/lib/supabase-service';
import { readAccountFacts } from '@/lib/account-server/facts';
import { accountError, accountJson } from '@/lib/account-server/http';
import { accountSession } from './_shared/session';

/**
 * GET /api/account — what the web's Delete account dialog says before anyone
 * deletes (Settings → dsul; the desktop app loads the same page). The cookie
 * session's twin of GET /api/app/account, with the same answers: the facts,
 * 401, 410 gone, 503 (memory/plans/account-deletion.md).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const caller = await accountSession();
  if (caller instanceof Response) return caller;
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
