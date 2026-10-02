// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  loadEncryptionKey,
  openSecret,
  sealSecret,
  type SealContext,
} from '@/lib/ai-server/secret-box';

/**
 * The model key at rest (design 1.3). The box is the only thing between a
 * database read and a user's provider key, and the PKCE cookie is attacker-
 * supplied input to `openSecret`, so the parse is pinned as hard as the seal:
 * exactly four parts, canonical base64, a 12-byte IV, a full 16-byte tag.
 */

const KEY = randomBytes(32);
const CTX: SealContext = { userId: 'user-1', purpose: 'model-key', provider: 'openai', baseUrl: null };
const SECRET = 'sk-test-SENTINEL-9876';

/** The 053 CHECK on key_ciphertext. */
const CIPHERTEXT_CHECK = /^v[0-9]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

const parts = (sealed: string) => sealed.split(':');
const b64 = (b: Buffer) => b.toString('base64');
/** A bare env object; the app's ProcessEnv typing demands NODE_ENV, which loadEncryptionKey never reads. */
const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

function flipByte(sealed: string, index: 1 | 2 | 3): string {
  const p = parts(sealed);
  const buf = Buffer.from(p[index], 'base64');
  buf[0] ^= 0x01;
  p[index] = b64(buf);
  return p.join(':');
}

describe('sealSecret / openSecret', () => {
  it('round-trips, matches the 053 CHECK, and never seals the same way twice', () => {
    const a = sealSecret(SECRET, CTX, KEY);
    const b = sealSecret(SECRET, CTX, KEY);
    expect(openSecret(a, CTX, KEY)).toBe(SECRET);
    expect(openSecret(b, CTX, KEY)).toBe(SECRET);
    expect(a).toMatch(CIPHERTEXT_CHECK);
    expect(a.startsWith('v1:')).toBe(true);
    expect(a).not.toBe(b);
    expect(a).not.toContain('SENTINEL');
    expect(a.length).toBeLessThanOrEqual(4096);
  });

  it('round-trips unicode', () => {
    const s = 'clé-🔑-ключ';
    expect(openSecret(sealSecret(s, CTX, KEY), CTX, KEY)).toBe(s);
  });

  it('refuses to seal an empty string', () => {
    expect(() => sealSecret('', CTX, KEY)).toThrow();
  });

  it.each([1, 2, 3] as const)('a flipped byte in part %i opens to null', (i) => {
    expect(openSecret(flipByte(sealSecret(SECRET, CTX, KEY), i), CTX, KEY)).toBeNull();
  });

  it('a different key opens to null', () => {
    expect(openSecret(sealSecret(SECRET, CTX, KEY), CTX, randomBytes(32))).toBeNull();
  });

  it.each<[string, Partial<SealContext>]>([
    ['user', { userId: 'user-2' }],
    ['provider', { provider: 'anthropic' }],
    ['baseUrl', { baseUrl: 'https://evil.example/v1' }],
    ['purpose', { purpose: 'pkce' }],
  ])('a different %s (AAD) opens to null', (_label, change) => {
    const sealed = sealSecret(SECRET, CTX, KEY);
    expect(openSecret(sealed, { ...CTX, ...change }, KEY)).toBeNull();
  });

  it('binds the custom base URL: a row moved to another host cannot be opened there', () => {
    const custom: SealContext = { ...CTX, provider: 'custom', baseUrl: 'https://api.groq.com/openai/v1' };
    const sealed = sealSecret(SECRET, custom, KEY);
    expect(openSecret(sealed, custom, KEY)).toBe(SECRET);
    expect(openSecret(sealed, { ...custom, baseUrl: 'https://attacker.example/v1' }, KEY)).toBeNull();
  });

  it('a v2: prefix opens to null', () => {
    const sealed = sealSecret(SECRET, CTX, KEY);
    expect(openSecret(`v2:${sealed.slice(3)}`, CTX, KEY)).toBeNull();
  });

  describe('pinned lengths (review 3)', () => {
    it.each([4, 12])('a tag cut to %i bytes opens to null', (n) => {
      const p = parts(sealSecret(SECRET, CTX, KEY));
      p[2] = b64(Buffer.from(p[2], 'base64').subarray(0, n));
      expect(openSecret(p.join(':'), CTX, KEY)).toBeNull();
    });

    it('an 8-byte IV opens to null', () => {
      const p = parts(sealSecret(SECRET, CTX, KEY));
      p[1] = b64(Buffer.from(p[1], 'base64').subarray(0, 8));
      expect(openSecret(p.join(':'), CTX, KEY)).toBeNull();
    });

    it('an empty ciphertext opens to null', () => {
      const p = parts(sealSecret(SECRET, CTX, KEY));
      p[3] = '';
      expect(openSecret(p.join(':'), CTX, KEY)).toBeNull();
    });

    it('non-canonical base64 (whitespace, url-safe, missing padding) opens to null', () => {
      const p = parts(sealSecret(SECRET, CTX, KEY));
      const withSpace = [...p];
      withSpace[3] = ` ${p[3]}`;
      expect(openSecret(withSpace.join(':'), CTX, KEY)).toBeNull();

      // The 16-byte tag always encodes with '==' padding.
      const unpadded = [...p];
      unpadded[2] = p[2].replace(/=+$/, '');
      expect(unpadded[2]).not.toBe(p[2]);
      expect(openSecret(unpadded.join(':'), CTX, KEY)).toBeNull();

      const urlSafe = [...p];
      urlSafe[2] = Buffer.from(p[2], 'base64').toString('base64url');
      expect(openSecret(urlSafe.join(':'), CTX, KEY)).toBeNull();
    });

    it('a url-safe alphabet part with - or _ opens to null', () => {
      // Find a seal whose ciphertext uses + or / so the url-safe form differs.
      for (let i = 0; i < 200; i++) {
        const sealed = sealSecret(`${SECRET}-${i}`, CTX, KEY);
        const p = parts(sealed);
        if (!/[+/]/.test(p[3])) continue;
        p[3] = p[3].replace(/\+/g, '-').replace(/\//g, '_');
        expect(openSecret(p.join(':'), CTX, KEY)).toBeNull();
        return;
      }
      throw new Error('no seal with + or / in 200 tries');
    });

    it('3 or 5 colon parts open to null', () => {
      const sealed = sealSecret(SECRET, CTX, KEY);
      const p = parts(sealed);
      expect(openSecret(p.slice(0, 3).join(':'), CTX, KEY)).toBeNull();
      expect(openSecret(`${sealed}:AAAA`, CTX, KEY)).toBeNull();
    });

    it('never throws on garbage', () => {
      for (const junk of ['', ':', 'v1:::', 'v1:a:b:c', 'not sealed at all', '\u0000', 'v1:' + 'A'.repeat(5000)]) {
        expect(openSecret(junk, CTX, KEY)).toBeNull();
      }
      expect(openSecret(undefined as unknown as string, CTX, KEY)).toBeNull();
      expect(openSecret(sealSecret(SECRET, CTX, KEY), CTX, Buffer.alloc(3))).toBeNull();
    });
  });
});

describe('loadEncryptionKey', () => {
  const good = randomBytes(32).toString('base64');

  it('accepts 32 bytes of standard base64', () => {
    const load = loadEncryptionKey(env({ MODEL_KEYS_ENCRYPTION_KEY: good }));
    expect(load.ok).toBe(true);
    if (load.ok) expect(load.key.length).toBe(32);
  });

  it('trims a trailing newline (a pasted env value)', () => {
    const load = loadEncryptionKey(env({ MODEL_KEYS_ENCRYPTION_KEY: `${good}\n` }));
    expect(load.ok).toBe(true);
  });

  it('missing or blank → missing', () => {
    expect(loadEncryptionKey(env({}))).toEqual({ ok: false, reason: 'missing' });
    expect(loadEncryptionKey(env({ MODEL_KEYS_ENCRYPTION_KEY: '   ' }))).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it.each([
    ['31 bytes', randomBytes(31).toString('base64')],
    ['33 bytes', randomBytes(33).toString('base64')],
    ['url-safe alphabet', Buffer.alloc(32, 0xfb).toString('base64url') + '='],
    ['no padding', good.replace(/=$/, '')],
    ['inner whitespace', `${good.slice(0, 20)} ${good.slice(20)}`],
    ['hex', randomBytes(32).toString('hex')],
  ])('%s → invalid', (_label, value) => {
    expect(loadEncryptionKey(env({ MODEL_KEYS_ENCRYPTION_KEY: value }))).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('reads process.env lazily and never throws without it', async () => {
    const saved = process.env.MODEL_KEYS_ENCRYPTION_KEY;
    delete process.env.MODEL_KEYS_ENCRYPTION_KEY;
    try {
      const mod = await import('@/lib/ai-server/secret-box');
      expect(mod.loadEncryptionKey()).toEqual({ ok: false, reason: 'missing' });
      process.env.MODEL_KEYS_ENCRYPTION_KEY = good;
      expect(mod.loadEncryptionKey().ok).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.MODEL_KEYS_ENCRYPTION_KEY;
      else process.env.MODEL_KEYS_ENCRYPTION_KEY = saved;
    }
  });
});
