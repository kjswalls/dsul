/**
 * AES-256-GCM seal and open for model keys (and the OpenRouter PKCE cookie).
 *
 * Server-only. The key comes from MODEL_KEYS_ENCRYPTION_KEY, read lazily and
 * never at import, so a missing env answers `{available:false}` from the
 * routes instead of crashing the module graph.
 *
 * Format: 'v1:' + b64(iv12) + ':' + b64(tag16) + ':' + b64(ct), standard base64
 * with padding. AAD = JSON.stringify(['dsul', purpose, 'v1', userId, provider ?? '', baseUrl ?? '']),
 * so a sealed key opens only for the user, purpose, provider and base URL it
 * was sealed for.
 *
 * Lengths are pinned in BOTH directions (design 1.3). Node's GCM decipher
 * accepts a truncated tag unless `authTagLength` is passed, which would cut
 * forgery resistance from 2^-128 to 2^-32 per try, and the PKCE cookie is
 * attacker-supplied input to `openSecret`. So the parse is strict: exactly four
 * parts, canonical base64 in each, a 12-byte IV, a 16-byte tag, a non-empty
 * ciphertext, and `authTagLength: 16` on both the cipher and the decipher.
 *
 * Nothing here logs. Plaintext and ciphertext never reach a console.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type KeyLoad = { ok: true; key: Buffer } | { ok: false; reason: 'missing' | 'invalid' };

export interface SealContext {
  userId: string;
  purpose: 'model-key' | 'pkce';
  /** model-key */
  provider?: string;
  /** model-key (custom) */
  baseUrl?: string | null;
}

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** 32 bytes in standard base64 is exactly 43 characters plus one '=' of padding. */
const KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

let memo: { raw: string; result: KeyLoad } | null = null;

/**
 * Lazily reads MODEL_KEYS_ENCRYPTION_KEY. Trims; requires /^[A-Za-z0-9+/]{43}=$/
 * and exactly 32 decoded bytes. Memoized per raw env string. NEVER throws;
 * never runs at import.
 */
export function loadEncryptionKey(env: NodeJS.ProcessEnv = process.env): KeyLoad {
  try {
    const raw = env.MODEL_KEYS_ENCRYPTION_KEY;
    if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, reason: 'missing' };
    if (memo && memo.raw === raw) return memo.result;

    const trimmed = raw.trim();
    let result: KeyLoad = { ok: false, reason: 'invalid' };
    if (KEY_RE.test(trimmed)) {
      const key = Buffer.from(trimmed, 'base64');
      if (key.length === KEY_BYTES && key.toString('base64') === trimmed) result = { ok: true, key };
    }
    memo = { raw, result };
    return result;
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

function aadFor(ctx: SealContext): Buffer {
  return Buffer.from(
    JSON.stringify(['dsul', ctx.purpose, VERSION, ctx.userId, ctx.provider ?? '', ctx.baseUrl ?? '']),
    'utf8'
  );
}

/** 'v1:' + b64(iv12) + ':' + b64(tag16) + ':' + b64(ct). */
export function sealSecret(plaintext: string, ctx: SealContext, key: Buffer): string {
  if (typeof plaintext !== 'string' || plaintext === '') {
    // An empty plaintext seals to an empty ciphertext, which openSecret (and the
    // 053 CHECK) refuse; failing here keeps that from ever being stored.
    throw new Error('sealSecret: nothing to seal');
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: 16 });
  cipher.setAAD(aadFor(ctx));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/** Strict standard base64: decodes, and re-encodes to exactly the same string. */
function strictBase64(s: string): Buffer | null {
  const b = Buffer.from(s, 'base64');
  return b.toString('base64') === s ? b : null;
}

/** null on ANY failure (format, version, length, encoding, tag, AAD). Never throws. */
export function openSecret(sealed: string, ctx: SealContext, key: Buffer): string | null {
  try {
    if (typeof sealed !== 'string') return null;
    const parts = sealed.split(':');
    if (parts.length !== 4 || parts[0] !== VERSION) return null;

    const iv = strictBase64(parts[1]);
    const tag = strictBase64(parts[2]);
    const ct = strictBase64(parts[3]);
    if (!iv || !tag || !ct) return null;
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || ct.length < 1) return null;

    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: 16 });
    decipher.setAAD(aadFor(ctx));
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch {
    return null;
  }
}
