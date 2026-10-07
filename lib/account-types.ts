/**
 * account-types.ts — the shapes the account routes and their clients share
 * (memory/plans/account-deletion.md).
 *
 * Client-safe on purpose: nothing here imports `node:*`, Supabase, or anything
 * under `lib/account-server`, so the web dialog and /login can read these
 * without dragging server code into the bundle. A boundary test holds that line.
 * ios/DsulCore/Sources/DsulCore/Account.swift mirrors these shapes for the
 * phone; changing one without the other is drift.
 *
 * The facts are names and booleans, never a value: a key dsul held for another
 * service shows up only as that service's name in `keyServices`.
 */

/** The word the person types. The client sends this constant, whatever was typed. */
export const ACCOUNT_CONFIRM_WORD = 'DELETE';

/**
 * What became of the account's Sign in with Apple tokens. `none`: the account
 * had no Apple id. `unknown`: an earlier call already deleted the account, so
 * this one cannot say.
 */
export type AppleRevocation = 'revoked' | 'not_revoked' | 'none' | 'unknown';

export type KeyService = 'Beeminder' | 'Twilio' | 'Home Assistant' | 'OpenClaw';
export const KEY_SERVICES: readonly KeyService[] = ['Beeminder', 'Twilio', 'Home Assistant', 'OpenClaw'];

/** GET /api/app/account and GET /api/account. Every key is always present. */
export interface AccountFacts {
  /** The verified caller's id; the delete body sends it back as `account`. */
  userId: string;
  email: string | null;
  /** The provider ids of the account's Apple identities (the credential's `user`). */
  appleIds: string[];
  /** The server can revoke Sign in with Apple (its Apple variables are set and the key parses). */
  appleRevocable: boolean;
  beeminder: boolean;
  ledger: boolean;
  openclaw: boolean;
  /** A subset of KEY_SERVICES, in that order. */
  keyServices: KeyService[];
  /** The model connection's provider label, or a custom connection's host. */
  modelProviderName: string | null;
}

/** POST /api/app/account/delete and POST /api/account/delete, on 200. */
export interface AccountDeleted {
  deleted: true;
  apple: AppleRevocation;
}

/** The one word an error body carries: `{"error":"<code>"}` and nothing else. */
export type AccountErrorCode =
  | 'invalid'
  | 'unauthorized'
  | 'forbidden'
  | 'unsupported_media'
  | 'too_large'
  | 'changed'
  | 'gone'
  | 'unavailable'
  | 'failed';

const APPLE_REVOCATIONS: readonly AppleRevocation[] = ['revoked', 'not_revoked', 'none', 'unknown'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(raw: unknown): Record<string, unknown> | null {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function nonBlank(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** Null when `userId` isn't a UUID (nothing can be deleted without it); otherwise lenient, as the
 *  phone reads it: a missing or wrong key reads as none, an unknown key service is dropped. */
export function parseAccountFacts(raw: unknown): AccountFacts | null {
  const body = record(raw);
  if (!body) return null;
  const userId = body.userId;
  if (typeof userId !== 'string' || !UUID.test(userId)) return null;

  const appleIds = Array.isArray(body.appleIds)
    ? body.appleIds.filter((id): id is string => typeof id === 'string' && id !== '')
    : [];
  const listed = Array.isArray(body.keyServices) ? body.keyServices : [];

  return {
    userId,
    email: nonBlank(body.email),
    appleIds,
    appleRevocable: body.appleRevocable === true,
    beeminder: body.beeminder === true,
    ledger: body.ledger === true,
    openclaw: body.openclaw === true,
    keyServices: KEY_SERVICES.filter((s) => listed.includes(s)),
    modelProviderName: nonBlank(body.modelProviderName),
  };
}

/** Any 200 is a deletion; an unreadable `apple` is 'unknown'. */
export function parseAccountDeleted(raw: unknown): AccountDeleted {
  const apple = record(raw)?.apple;
  return {
    deleted: true,
    apple: APPLE_REVOCATIONS.includes(apple as AppleRevocation) ? (apple as AppleRevocation) : 'unknown',
  };
}
