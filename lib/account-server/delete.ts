import { isAuthApiError } from '@supabase/supabase-js';
import type { AppleRevocation } from '@/lib/account-types';
import {
  AppleCallError,
  appleConfigStatus,
  appleIdTokenSubject,
  exchangeAppleCode,
  revokeAppleToken,
  type AppleRevocationConfig,
  type AppleTokens,
} from './apple';
import { appleIdsOf } from './facts';
import type { ServiceClient } from './http';

/**
 * Deleting an account (memory/plans/account-deletion.md). The only caller of
 * GoTrue's admin delete in the tree (tests/unit/account-server-boundary.test.ts).
 *
 * ONE CALL, AND THE FOREIGN KEYS DO THE REST. `deleteUser` (never soft: a soft
 * delete keeps the row, which App Review calls deactivation) deletes the
 * auth.users row, and every table that holds the user's data cascades from it,
 * inside GoTrue's one transaction: the account and every row go, or nothing
 * does. tests/unit/account-deletion-migration.test.ts holds that rule for every
 * table, so nothing here lists tables.
 *
 * EXCHANGE, DELETE, THEN REVOKE. With a code from Apple's sheet the tokens are
 * fetched first (the code lives five minutes and works once), but revoked only
 * after a delete that went through: revoking first and then failing to delete
 * would leave an account Apple has already cut off. Nothing Apple does can
 * stop or undo a deletion; every Apple failure is one log line and
 * `not_revoked`.
 *
 * A DELETE THAT DIDN'T ANSWER SUCCESS IS ASKED ABOUT, NOT TRUSTED. A gateway's
 * 500 or a lost answer can follow a transaction GoTrue committed, so the user
 * is read once more: gone is deleted, still there is `failed` (nothing was
 * deleted), and a read that fails too is `unavailable` (a retry settles it).
 *
 * Logs carry codes only: never an id, an email, Apple's code, a token or the
 * client secret.
 */

export type DeleteAccountResult =
  | { ok: true; apple: AppleRevocation }
  | { ok: false; error: 'unavailable' | 'failed' };

interface DeleteDeps {
  fetch?: typeof fetch;
  now?: () => number;
  env?: Record<string, string | undefined>;
}

const notFound = (error: unknown): boolean => isAuthApiError(error) && error.status === 404;

const appleCodeOf = (err: unknown): string => (err instanceof AppleCallError ? err.code : 'unexpected');

function errorFields(err: unknown): [string, number | string] {
  if (typeof err !== 'object' || err === null) return [typeof err, ''];
  const { name, status } = err as { name?: unknown; status?: unknown };
  return [typeof name === 'string' ? name : 'Error', typeof status === 'number' ? status : ''];
}

/** Never throws. */
export async function deleteAccount(
  svc: ServiceClient,
  input: { userId: string; appleCode?: string },
  deps: DeleteDeps = {},
): Promise<DeleteAccountResult> {
  const { userId, appleCode } = input;
  const apple = { fetch: deps.fetch, now: deps.now };
  let deleted = false;
  let appleIds: string[] = [];
  let config: AppleRevocationConfig | null = null;
  let tokens: AppleTokens | null = null;

  try {
    // 1. Who is being deleted, and their Apple ids. Gone already is a retry
    //    whose first answer was lost.
    const first = await svc.auth.admin.getUserById(userId);
    if (first.error) {
      if (notFound(first.error)) return { ok: true, apple: 'unknown' };
      console.warn('[account] delete failed', ...errorFields(first.error));
      return { ok: false, error: 'unavailable' };
    }
    const user = first.data?.user;
    if (!user) return { ok: false, error: 'unavailable' };
    appleIds = appleIdsOf(user);

    // 2. Apple's tokens, while the code is still good. Nothing here can stop 3.
    if (appleCode && appleIds.length > 0) {
      try {
        const status = appleConfigStatus(deps.env ?? process.env);
        if (typeof status === 'string') {
          console.warn('[account] apple', 'config', status);
        } else {
          config = status;
          const fetched = await exchangeAppleCode(config, appleCode, apple);
          const subject = appleIdTokenSubject(fetched.idToken, config.clientId);
          // Tokens for a different Apple ID are dropped, never revoked.
          if (subject !== null && appleIds.includes(subject)) tokens = fetched;
          else console.warn('[account] apple', 'subject', 'mismatch');
        }
      } catch (err) {
        console.warn('[account] apple', 'exchange', appleCodeOf(err));
      }
    }

    // 3. The delete.
    let failure: unknown = null;
    try {
      const { error } = await svc.auth.admin.deleteUser(userId);
      if (error && !notFound(error)) failure = error;
    } catch (err) {
      failure = err ?? new Error('deleteUser threw');
    }
    if (failure === null) {
      deleted = true;
    } else {
      console.warn('[account] delete failed', ...errorFields(failure));
      const again = await svc.auth.admin.getUserById(userId);
      if (again.error && notFound(again.error)) deleted = true;
      else if (!again.error && again.data?.user) return { ok: false, error: 'failed' };
      else return { ok: false, error: 'unavailable' };
    }
  } catch {
    if (!deleted) return { ok: false, error: 'unavailable' };
  }

  // 4. Deleted. From here on the answer is { ok: true }, whatever Apple says.
  let revoked = false;
  if (tokens && config) {
    try {
      const hint = tokens.refreshToken ? 'refresh_token' : 'access_token';
      const token = tokens.refreshToken ?? tokens.accessToken;
      if (token) {
        await revokeAppleToken(config, token, hint, apple);
        revoked = true;
      } else {
        console.warn('[account] apple', 'revoke', 'no_token');
      }
    } catch (err) {
      console.warn('[account] apple', 'revoke', appleCodeOf(err));
    }
  }

  // 5.
  const result: AppleRevocation = appleIds.length === 0 ? 'none' : revoked ? 'revoked' : 'not_revoked';
  console.info('[account] deleted', result);
  return { ok: true, apple: result };
}
