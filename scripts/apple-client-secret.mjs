#!/usr/bin/env node
// Mints the client secret Supabase's Apple provider needs for web sign-in: a JWT signed with the
// Sign in with Apple key (.p8). Apple refuses one that lives longer than six months, so this is
// rerun before it lapses and pasted into Supabase again (memory/plans/sign-in-with-apple.md).
//
//   node scripts/apple-client-secret.mjs --team ABCDE12345 --key-id XYZ987ABCD \
//     --client-id app.dsul.web --p8 ~/Downloads/AuthKey_XYZ987ABCD.p8
//
// Prints the secret on stdout and the date it stops working on stderr. Nothing is sent anywhere,
// and the .p8 never belongs in the repo.

import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

// 180 days, under Apple's ceiling of 15,777,000 seconds.
export const LIFETIME_S = 180 * 24 * 60 * 60;

const b64url = (data) => Buffer.from(data).toString('base64url');

/** The secret, and when it expires (seconds since the epoch). */
export function appleClientSecret({ teamId, keyId, clientId, privateKey, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  const exp = iat + LIFETIME_S;
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ iss: teamId, iat, exp, aud: 'https://appleid.apple.com', sub: clientId })
  );
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: createPrivateKey(privateKey),
    // A JWT's ES256 signature is r||s, not the DER that Node signs by default.
    dsaEncoding: 'ieee-p1363',
  });
  return { secret: `${header}.${payload}.${b64url(signature)}`, exp };
}

function main() {
  const { values } = parseArgs({
    options: {
      team: { type: 'string' },
      'key-id': { type: 'string' },
      'client-id': { type: 'string' },
      p8: { type: 'string' },
    },
  });
  const missing = ['team', 'key-id', 'client-id', 'p8'].filter((k) => !values[k]);
  if (missing.length) {
    console.error(`Missing ${missing.map((k) => `--${k}`).join(', ')}.`);
    console.error(
      'Usage: node scripts/apple-client-secret.mjs --team <Team ID> --key-id <Key ID> ' +
        '--client-id <Services ID> --p8 <path to AuthKey_….p8>'
    );
    process.exit(1);
  }
  const { secret, exp } = appleClientSecret({
    teamId: values.team,
    keyId: values['key-id'],
    clientId: values['client-id'],
    privateKey: readFileSync(values.p8, 'utf8'),
  });
  console.log(secret);
  console.error(`Expires ${new Date(exp * 1000).toISOString().slice(0, 10)}. Mint a new one before then.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
