import crypto from 'node:crypto';

/**
 * Sign in with Apple's REST API, for one job: revoking dsul's tokens when an
 * account that signs in with Apple is deleted on the iPhone
 * (memory/plans/account-deletion.md; App Review guideline 5.1.1(v) asks for
 * it, and the HIG's "Deleting accounts" says to revoke the tokens).
 *
 * THE PHONE SENDS A FRESH CODE, THE SERVER DOES THE REST. Apple's sheet gives
 * the phone a single-use authorization code (five minutes). The server
 * exchanges it at /auth/token for a refresh token, checks the ID token is the
 * account's own Apple ID, deletes the account, and only then revokes at
 * /auth/revoke. A native authorization's client is the bundle ID, so
 * `client_id` is APPLE_IOS_CLIENT_ID (`app.dsul.ios`), and no `redirect_uri` is
 * sent ("Generate and validate tokens": only if the original request had one).
 *
 * THE SERVER MINTS ITS OWN CLIENT SECRET, per request, five minutes long, from
 * the Sign in with Apple key (APPLE_PRIVATE_KEY, the .p8's text). The header
 * and claims are scripts/apple-client-secret.mjs's but `exp`: nothing to paste,
 * and nothing that lapses in six months and quietly stops revocation.
 *
 * NOTHING HERE MAY STOP A DELETION. Apple is never a reason to keep an account
 * (TN3194 sanctions deleting without revoking), so every failure is an
 * AppleCallError with one short code the route logs, and the route deletes
 * anyway. Each call has its own 5 s timeout. No code, token, secret or key is
 * ever put in an error, a log line or a response.
 */

export interface AppleRevocationConfig {
  teamId: string;
  keyId: string;
  privateKey: string;
  clientId: string;
}

export const APPLE_SECRET_LIFETIME_S = 300;
export const APPLE_TIMEOUT_MS = 5000;

const APPLE_ORIGIN = 'https://appleid.apple.com';
const TOKEN_URL = `${APPLE_ORIGIN}/auth/token`;
const REVOKE_URL = `${APPLE_ORIGIN}/auth/revoke`;

type ConfigProblem = 'apple_not_configured' | 'apple_key_unreadable';

/**
 * The last configuration read, so a key is parsed once per instance rather
 * than per request, and each problem is logged once per instance rather than
 * per deletion. Keyed by the variables' own values, so a change (a test's
 * stubbed env, a redeploy) is read afresh. Held in memory only, never logged.
 */
let cached: { inputs: string; result: AppleRevocationConfig | ConfigProblem } | null = null;

/**
 * The Apple configuration, or the problem with it. appleRevocationConfig is the
 * contract; this is what the delete path reads, to log which problem it met.
 */
export function appleConfigStatus(
  env: Record<string, string | undefined> = process.env,
): AppleRevocationConfig | ConfigProblem {
  const teamId = env.APPLE_TEAM_ID?.trim() ?? '';
  const keyId = env.APPLE_KEY_ID?.trim() ?? '';
  const clientId = env.APPLE_IOS_CLIENT_ID?.trim() ?? '';
  // A PEM pasted as one line into a dashboard keeps its line breaks as a
  // literal backslash-n.
  const privateKey = (env.APPLE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n');

  const inputs = JSON.stringify([teamId, keyId, clientId, privateKey]);
  if (cached?.inputs === inputs) return cached.result;

  let result: AppleRevocationConfig | ConfigProblem;
  if (!teamId || !keyId || !clientId || !privateKey.trim()) {
    result = 'apple_not_configured';
  } else {
    result = 'apple_key_unreadable';
    try {
      const key = crypto.createPrivateKey(privateKey);
      if (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1') {
        result = { teamId, keyId, privateKey, clientId };
      }
    } catch {
      // Not a key at all: unreadable, as a key on the wrong curve is.
    }
  }
  if (typeof result === 'string') console.warn('[account]', result);
  cached = { inputs, result };
  return result;
}

/** All four variables non-empty, literal "\n" in the key turned into newlines, and the key parses
 *  (createPrivateKey) as an EC key on P-256 (`asymmetricKeyType === 'ec'`,
 *  `asymmetricKeyDetails.namedCurve === 'prime256v1'`); otherwise null, logged once per instance as
 *  "apple_not_configured" or "apple_key_unreadable". Never throws. */
export function appleRevocationConfig(
  env: Record<string, string | undefined> = process.env,
): AppleRevocationConfig | null {
  const status = appleConfigStatus(env);
  return typeof status === 'string' ? null : status;
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

/** Header {alg:'ES256', kid, typ:'JWT'}; claims {iss, iat, exp: iat + 300, aud:'https://appleid.apple.com',
 *  sub: clientId}; ECDSA P-256 SHA-256, dsaEncoding 'ieee-p1363'. May throw: only the two calls below use it. */
export function mintAppleClientSecret(config: AppleRevocationConfig, nowMs: number = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: config.keyId, typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iss: config.teamId,
      iat,
      exp: iat + APPLE_SECRET_LIFETIME_S,
      aud: APPLE_ORIGIN,
      sub: config.clientId,
    }),
  );
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: crypto.createPrivateKey(config.privateKey),
    // A JWT's ES256 signature is r||s, not the DER that Node signs by default.
    dsaEncoding: 'ieee-p1363',
  });
  return `${header}.${payload}.${b64url(signature)}`;
}

export interface AppleTokens {
  idToken: string;
  refreshToken: string | null;
  accessToken: string | null;
}

/** Apple's closed `error` word, or 'network' | 'timeout' | 'malformed' | 'secret' | 'status_<n>'. */
export class AppleCallError extends Error {
  readonly code: string;
  constructor(code: string) {
    // The code is the whole message: nothing Apple or the caller sent is kept.
    super(code);
    this.name = 'AppleCallError';
    this.code = code;
  }
}

/** ErrorResponse's `error`, exactly one of these ("ErrorResponse"). */
const APPLE_ERRORS: ReadonlySet<string> = new Set([
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
]);

interface AppleDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * One form POST to Apple, under its own 5 s timer that covers the body too, and
 * the parsed JSON of a 2xx (undefined when empty or not JSON). Every failure is
 * an AppleCallError.
 *
 * The timer is an AbortController aborted by a setTimeout, cleared on every
 * path, not AbortSignal.timeout (the house pattern elsewhere), because vitest's
 * fake timers advance the one and not the other. The abort is also raced, so a
 * fetch that ignores its signal still ends at 5 s.
 */
async function postForm(url: string, form: Record<string, string>, deps: AppleDeps): Promise<unknown> {
  const fetcher = deps.fetch ?? fetch;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AppleCallError('timeout'));
    }, APPLE_TIMEOUT_MS);
  });
  // Never left unhandled when the call settles first.
  timedOut.catch(() => {});

  const call = async (): Promise<unknown> => {
    let res: Response;
    try {
      res = await fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(form).toString(),
        signal: controller.signal,
        cache: 'no-store',
      });
    } catch {
      throw new AppleCallError(controller.signal.aborted ? 'timeout' : 'network');
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new AppleCallError(controller.signal.aborted ? 'timeout' : 'network');
    }
    // A 2xx's body is the caller's to judge (a revoke's is empty); an error
    // that isn't Apple's JSON ErrorResponse is malformed.
    let body: unknown = undefined;
    if (text.trim() !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        if (!res.ok) throw new AppleCallError('malformed');
      }
    }
    if (res.ok) return body;
    if (body === undefined) throw new AppleCallError('malformed');
    const word = (body as { error?: unknown } | null)?.error;
    if (typeof word === 'string' && APPLE_ERRORS.has(word)) throw new AppleCallError(word);
    throw new AppleCallError(`status_${res.status}`);
  };

  try {
    return await Promise.race([call(), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

function secretFor(config: AppleRevocationConfig, deps: AppleDeps): string {
  try {
    return mintAppleClientSecret(config, (deps.now ?? Date.now)());
  } catch {
    throw new AppleCallError('secret');
  }
}

function asError(err: unknown): AppleCallError {
  return err instanceof AppleCallError ? err : new AppleCallError('network');
}

const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Every throw inside, a mint's included ('secret'), comes out as an AppleCallError. */
export async function exchangeAppleCode(
  config: AppleRevocationConfig,
  code: string,
  deps: AppleDeps = {},
): Promise<AppleTokens> {
  try {
    const body = await postForm(
      TOKEN_URL,
      {
        client_id: config.clientId,
        client_secret: secretFor(config, deps),
        code,
        grant_type: 'authorization_code',
      },
      deps,
    );
    const tokens = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const idToken = nonEmpty(tokens.id_token);
    if (!idToken) throw new AppleCallError('malformed');
    return {
      idToken,
      refreshToken: nonEmpty(tokens.refresh_token),
      accessToken: nonEmpty(tokens.access_token),
    };
  } catch (err) {
    throw asError(err);
  }
}

/** Every throw inside comes out as an AppleCallError. A token already invalid is a 200 too. */
export async function revokeAppleToken(
  config: AppleRevocationConfig,
  token: string,
  hint: 'refresh_token' | 'access_token',
  deps: AppleDeps = {},
): Promise<void> {
  try {
    await postForm(
      REVOKE_URL,
      {
        client_id: config.clientId,
        client_secret: secretFor(config, deps),
        token,
        token_type_hint: hint,
      },
      deps,
    );
  } catch (err) {
    throw asError(err);
  }
}

/** The ID token's `sub` when `iss` is Apple's and `aud` (a string or a list) holds clientId; else null.
 *  Claims only: the token came straight from Apple over TLS. Never throws. */
export function appleIdTokenSubject(idToken: string, clientId: string): string | null {
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) return null;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) return null;
    const { iss, aud, sub } = claims as { iss?: unknown; aud?: unknown; sub?: unknown };
    if (iss !== APPLE_ORIGIN) return null;
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (!audiences.includes(clientId)) return null;
    return typeof sub === 'string' && sub !== '' ? sub : null;
  } catch {
    return null;
  }
}
