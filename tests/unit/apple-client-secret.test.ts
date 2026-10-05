import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LIFETIME_S, appleClientSecret } from '../../scripts/apple-client-secret.mjs';

/**
 * The secret Supabase's Apple provider is given, minted by
 * scripts/apple-client-secret.mjs. Apple checks exactly these claims and an
 * ES256 signature in JWT (r||s) form, and refuses one living past six months.
 */

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const P8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

describe('appleClientSecret', () => {
  const { secret, exp } = appleClientSecret({
    teamId: 'TEAM123456',
    keyId: 'KEY1234567',
    clientId: 'app.dsul.web',
    privateKey: P8,
    now: NOW,
  });
  const [header, payload, signature] = secret.split('.');

  it('names the key and the algorithm Apple expects', () => {
    expect(decode(header)).toEqual({ alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' });
  });

  it('carries the team, the Services ID and Apple as the audience', () => {
    const iat = NOW / 1000;
    expect(decode(payload)).toEqual({
      iss: 'TEAM123456',
      sub: 'app.dsul.web',
      aud: 'https://appleid.apple.com',
      iat,
      exp: iat + LIFETIME_S,
    });
    expect(exp).toBe(iat + LIFETIME_S);
  });

  it('lives under Apple’s six-month ceiling', () => {
    expect(LIFETIME_S).toBeLessThanOrEqual(15_777_000);
  });

  it('is signed by the key, in JWT form', () => {
    const sig = Buffer.from(signature, 'base64url');
    expect(sig).toHaveLength(64);
    expect(
      verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig)
    ).toBe(true);
  });
});
