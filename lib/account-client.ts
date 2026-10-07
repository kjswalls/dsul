/**
 * The web's half of Delete account: the two calls the dialog makes, and the
 * note that carries the outcome to /login (memory/plans/account-deletion.md).
 *
 * The routes are cookie-session and same-origin (app/api/account/**). Every
 * answer comes back as a result, never a throw, in the words the dialog needs:
 *
 *   a fetch that throws, or 503    'unreachable'
 *   401                            'signed_out'  (the session is gone; sign out here too)
 *   409                            'changed'     (this browser is another account now)
 *   410                            'gone'        (an earlier call already deleted it)
 *   anything else, or facts with   'failed'
 *   no UUID userId
 *
 * Any 200 from the delete route is a deletion, whatever its body says.
 *
 * The note. The moment the delete answers 200 the dialog calls
 * `rememberDeletion`, before anything else, because the page may not live to
 * Done: another dsul tab whose refresh is refused broadcasts SIGNED_OUT, and
 * this tab's provider replaces the page with a bare /login at once
 * (lib/signed-out-redirect.ts). The note lives in sessionStorage, which the
 * SIGNED_OUT handler never clears (it clears localStorage stores), so /login
 * reads it once with `takeDeletionNotice` and shows the same done line. It
 * holds the Apple outcome and nothing about the account.
 *
 * Client-safe: imports nothing from the server and no Node builtin
 * (tests/unit/account-server-boundary.test.ts).
 */

import { doneMessage } from './account-copy';
import {
  ACCOUNT_CONFIRM_WORD,
  parseAccountDeleted,
  parseAccountFacts,
  type AccountFacts,
  type AppleRevocation,
} from './account-types';

export type AccountClientError = 'unreachable' | 'signed_out' | 'failed' | 'changed' | 'gone';

type Failure = { ok: false; error: AccountClientError };

const FACTS_URL = '/api/account';
const DELETE_URL = '/api/account/delete';

/** A non-2xx answer, in the dialog's words. */
function failureOf(status: number): Failure {
  switch (status) {
    case 401:
      return { ok: false, error: 'signed_out' };
    case 409:
      return { ok: false, error: 'changed' };
    case 410:
      return { ok: false, error: 'gone' };
    case 503:
      return { ok: false, error: 'unreachable' };
    default:
      return { ok: false, error: 'failed' };
  }
}

async function bodyOf(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** GET /api/account: what this account holds that dsul can't delete for it. */
export async function fetchAccountFacts(): Promise<{ ok: true; facts: AccountFacts } | Failure> {
  let res: Response;
  try {
    res = await fetch(FACTS_URL, { cache: 'no-store', credentials: 'same-origin' });
  } catch {
    return { ok: false, error: 'unreachable' };
  }
  if (!res.ok) return failureOf(res.status);
  const facts = parseAccountFacts(await bodyOf(res));
  return facts ? { ok: true, facts } : { ok: false, error: 'failed' };
}

/**
 * POST /api/account/delete. `account` is the `facts.userId` the dialog opened
 * with: a guard, never a target. The server deletes the verified caller, and
 * nothing at all (409) if that is no longer this account.
 */
export async function requestAccountDeletion(
  account: string,
): Promise<{ ok: true; apple: AppleRevocation } | Failure> {
  let res: Response;
  try {
    res = await fetch(DELETE_URL, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account, confirm: ACCOUNT_CONFIRM_WORD }),
    });
  } catch {
    return { ok: false, error: 'unreachable' };
  }
  if (!res.ok) return failureOf(res.status);
  return { ok: true, apple: parseAccountDeleted(await bodyOf(res)).apple };
}

export const DELETION_NOTICE_KEY = 'dsul-account-deleted';

const APPLE_REVOCATIONS: readonly string[] = ['revoked', 'not_revoked', 'none', 'unknown'];

/** sessionStorage[DELETION_NOTICE_KEY] = {"apple":…,"hadApple":…}. Never throws. */
export function rememberDeletion(apple: AppleRevocation, hadApple: boolean): void {
  try {
    window.sessionStorage.setItem(DELETION_NOTICE_KEY, JSON.stringify({ apple, hadApple }));
  } catch {
    // Private mode or blocked storage: /login simply shows no line.
  }
}

/**
 * Reads the note and removes it, and gives the web's done line, or null with
 * no note or one that doesn't read. Once only: a reload of /login shows
 * nothing. Never throws.
 */
export function takeDeletionNotice(): string | null {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(DELETION_NOTICE_KEY);
    if (raw === null) return null;
    window.sessionStorage.removeItem(DELETION_NOTICE_KEY);
  } catch {
    return null;
  }
  try {
    const note: unknown = JSON.parse(raw);
    if (typeof note !== 'object' || note === null) return null;
    const { apple, hadApple } = note as { apple?: unknown; hadApple?: unknown };
    if (typeof apple !== 'string' || !APPLE_REVOCATIONS.includes(apple) || typeof hadApple !== 'boolean') {
      return null;
    }
    return doneMessage(apple as AppleRevocation, hadApple, { web: true });
  } catch {
    return null;
  }
}
