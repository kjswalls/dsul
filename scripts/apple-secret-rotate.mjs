#!/usr/bin/env node
// Renews the client secret Supabase's Apple provider holds, unattended. Run by
// .github/workflows/apple-secret-rotate.yml every two months, so a secret (180 days) is always
// replaced with four months to spare and one failed run never lets it lapse.
//
// It mints a fresh secret with apple-client-secret.mjs, has Apple confirm it accepts it, checks
// Supabase's Apple provider is the one it expects, and only then writes the one field
// `external_apple_secret` through Supabase's Management API. Nothing else in the auth config is
// touched, and the secret is never printed.
//
//   APPLE_TEAM_ID=… APPLE_KEY_ID=… APPLE_PRIVATE_KEY="$(cat AuthKey_….p8)" \
//   SUPABASE_ACCESS_TOKEN=… node scripts/apple-secret-rotate.mjs [--dry-run]
//
// --dry-run (or DRY_RUN=true) does every check and skips the write.

import { pathToFileURL } from 'node:url';
import { appleClientSecret } from './apple-client-secret.mjs';

export const DEFAULTS = {
  servicesId: 'app.dsul.web',
  projectRef: 'ctcspcferkdlzdcqlozq',
};

const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const authConfigUrl = (ref) => `https://api.supabase.com/v1/projects/${ref}/config/auth`;

/**
 * Asks Apple to redeem a code that cannot exist. Apple checks the client first, so a secret it
 * accepts gets `invalid_grant` (the code is bad) and one it refuses gets `invalid_client`.
 */
export async function checkWithApple({ clientId, secret, fetch }) {
  const res = await fetch(APPLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: secret,
      grant_type: 'authorization_code',
      code: 'dsul-secret-rotation-probe',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (body.error === 'invalid_grant') return;
  if (body.error === 'invalid_client') {
    throw new Error(
      'Apple refused the new secret (invalid_client). Check APPLE_TEAM_ID, APPLE_KEY_ID and ' +
        'APPLE_PRIVATE_KEY, and that the key is still active in Apple’s portal.'
    );
  }
  throw new Error(`Apple answered the probe unexpectedly (${res.status} ${body.error ?? 'no error'}).`);
}

export async function rotateAppleSecret({
  teamId,
  keyId,
  privateKey,
  accessToken,
  servicesId = DEFAULTS.servicesId,
  projectRef = DEFAULTS.projectRef,
  dryRun = false,
  fetch = globalThis.fetch,
  now = Date.now(),
}) {
  const { secret, exp } = appleClientSecret({ teamId, keyId, clientId: servicesId, privateKey, now });

  await checkWithApple({ clientId: servicesId, secret, fetch });

  const headers = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };
  const current = await fetch(authConfigUrl(projectRef), { headers });
  if (!current.ok) throw new Error(`Supabase refused to read the auth config (${current.status}).`);
  const config = await current.json();
  // The web client_id is the first of the provider's Client IDs.
  const webClientId = String(config.external_apple_client_id ?? '').split(',')[0].trim();
  if (config.external_apple_enabled !== true || webClientId !== servicesId) {
    throw new Error(
      `Supabase's Apple provider isn't the one expected (enabled: ${config.external_apple_enabled}, ` +
        `first Client ID: "${webClientId}", expected "${servicesId}"). Nothing was written.`
    );
  }

  if (!dryRun) {
    const res = await fetch(authConfigUrl(projectRef), {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ external_apple_secret: secret }),
    });
    if (!res.ok) throw new Error(`Supabase refused the new secret (${res.status}).`);
  }
  return { exp, written: !dryRun };
}

async function main() {
  const env = process.env;
  const required = ['APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY', 'SUPABASE_ACCESS_TOKEN'];
  const missing = required.filter((k) => !env[k]?.trim());
  if (missing.length) {
    console.error(`Missing ${missing.join(', ')}. See memory/plans/sign-in-with-apple.md, "Rotation".`);
    process.exit(1);
  }
  const dryRun = process.argv.includes('--dry-run') || env.DRY_RUN === 'true';
  const { exp, written } = await rotateAppleSecret({
    teamId: env.APPLE_TEAM_ID.trim(),
    keyId: env.APPLE_KEY_ID.trim(),
    privateKey: env.APPLE_PRIVATE_KEY,
    accessToken: env.SUPABASE_ACCESS_TOKEN.trim(),
    servicesId: env.APPLE_SERVICES_ID?.trim() || undefined,
    projectRef: env.SUPABASE_PROJECT_REF?.trim() || undefined,
    dryRun,
  });
  const until = new Date(exp * 1000).toISOString().slice(0, 10);
  console.log(
    written
      ? `Apple accepted the new secret and Supabase now holds it. It expires ${until}.`
      : `Dry run: Apple accepts a new secret and Supabase's provider checks out. Nothing was written.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
