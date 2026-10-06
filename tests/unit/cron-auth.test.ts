import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkCronAuth } from '@/lib/cron-auth';

/**
 * lib/cron-auth.ts — the gate in front of the one route that can push to every
 * user on demand.
 *
 * The half worth pinning is the FAIL-CLOSED one: an unset CRON_SECRET waves a
 * request through in development and nowhere else, NODE_ENV=test included.
 * Inverted, that clause is a public endpoint that sends notifications to
 * everyone. The bodies are pinned too: net._http_response keeps them for six
 * hours, and they are what someone reads there to tell a missing secret from
 * a wrong one.
 */

const req = (authorization?: string) =>
  new Request(
    'https://do.dsul.app/api/cron/reminders',
    authorization === undefined ? {} : { headers: { authorization } },
  );

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('checkCronAuth with no CRON_SECRET', () => {
  it.each(['production', 'test'])('fails closed under NODE_ENV=%s: 500, and says why', async (nodeEnv) => {
    vi.stubEnv('CRON_SECRET', '');
    vi.stubEnv('NODE_ENV', nodeEnv);

    const denied = checkCronAuth(req('Bearer anything'));

    expect(denied?.response.status).toBe(500);
    expect(await denied!.response.json()).toEqual({ error: 'CRON secret not configured' });
  });

  it('waves the request through in development, and only there', () => {
    vi.stubEnv('CRON_SECRET', '');
    vi.stubEnv('NODE_ENV', 'development');
    expect(checkCronAuth(req())).toBeNull();
  });
});

describe('checkCronAuth with a CRON_SECRET', () => {
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', 's3cret');
  });

  it('lets the exact header through', () => {
    expect(checkCronAuth(req('Bearer s3cret'))).toBeNull();
  });

  // An exact comparison: the scheme's case, the one space, the whole secret.
  // (A trailing space never reaches it: the Headers API trims values.)
  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['the bare secret', 's3cret'],
    ['a lowercase scheme', 'bearer s3cret'],
    ['another scheme', 'Basic s3cret'],
    ['two spaces', 'Bearer  s3cret'],
    ['a prefix of the secret', 'Bearer s3cre'],
    ['the secret and more', 'Bearer s3cret2'],
    ['the secret in another case', 'Bearer S3CRET'],
  ])('401s %s', async (_, authorization) => {
    const denied = checkCronAuth(req(authorization));
    expect(denied?.response.status).toBe(401);
    expect(await denied!.response.json()).toEqual({ error: 'Unauthorized' });
  });

  // Development only forgives a secret that is MISSING. One that is set is
  // checked everywhere, so a dev server with the real .env.local is not open.
  it('checks a secret that is set even in development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const denied = checkCronAuth(req('Bearer wrong'));
    expect(denied?.response.status).toBe(401);
  });
});
