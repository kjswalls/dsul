import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  APNS_CUE_CATEGORY,
  APNS_HOSTS,
  APNS_MAX_PAYLOAD_BYTES,
  apnsConfig,
  apnsRequestOf,
  apnsWakeRequest,
  APNS_WAKE_REASON,
  createApnsTransport,
  mintProviderToken,
  outcomeOf,
  PROVIDER_TOKEN_TTL_MS,
  providerTokens,
  type ApnsConfig,
  type ApnsPost,
  type ApnsResponse,
} from '@/lib/devices/transports/apns';
import { DEFAULT_TTL_S } from '@/lib/push-send';
import type { DeviceRow } from '@/lib/devices/types';

/**
 * The APNs transport (memory/plans/reminders-platforms.md §5.4, Phase 3). The
 * key is generated here, never committed; Apple is an injected post.
 */

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const ENV = { APNS_TEAM_ID: 'TEAM123456', APNS_KEY_ID: 'KEY1234567', APNS_BUNDLE_ID: 'app.dsul.ios', APNS_KEY_P8: PEM };
const CONFIG = apnsConfig(ENV)!;

const NOW = Date.parse('2026-10-11T20:30:00Z');
const ITEM = '44444444-4444-4444-8444-444444444444';
const TOKEN = 'ab'.repeat(32);

const phone = (extra: Partial<DeviceRow> = {}): DeviceRow => ({
  id: 'row-1',
  user_id: 'u1',
  device_id: 'ios:0b7c2f9a-1d3e-4c5b-9a8f-7e6d5c4b3a21',
  platform: 'ios',
  transport: 'apns',
  delivery: 'local',
  os: 'ios',
  form: 'phone',
  token: TOKEN,
  keys: null,
  apns_environment: 'production',
  timezone: 'America/New_York',
  prefs: {},
  registered_at: '2026-10-01T00:00:00Z',
  last_seen_at: '2026-10-11T00:00:00Z',
  ...extra,
});

const lastCall = {
  kind: 'last-call' as const,
  payload: {
    title: 'Last call: Vitamins',
    body: '3 days so far',
    url: `/item/${ITEM}`,
    tag: `dsul-item-${ITEM}`,
    actions: [
      { action: 'done', title: 'Done' },
      { action: 'snooze', title: 'Snooze 15m' },
    ],
    data: { url: `/item/${ITEM}`, itemId: ITEM, dateStr: '2026-10-11', kind: 'last-call', key: 'last-call:2026-10-11', streak: 3 },
    expiresAtMs: NOW + 30 * 60_000,
    urgency: 'high' as const,
    topic: 'lc-20261011',
  },
};

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

describe('apnsConfig', () => {
  it('reads the four settings, with the key as downloaded or with escaped newlines', () => {
    expect(CONFIG).toMatchObject({ teamId: 'TEAM123456', keyId: 'KEY1234567', bundleId: 'app.dsul.ios' });
    expect(apnsConfig({ ...ENV, APNS_KEY_P8: PEM.replace(/\n/g, '\\n') })).not.toBeNull();
  });

  it.each([
    ['no team', { ...ENV, APNS_TEAM_ID: undefined }],
    ['a short key id', { ...ENV, APNS_KEY_ID: 'KEY' }],
    ['no bundle', { ...ENV, APNS_BUNDLE_ID: '' }],
    ['a key that does not parse', { ...ENV, APNS_KEY_P8: '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----' }],
    ['an RSA key', {
      ...ENV,
      APNS_KEY_P8: generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }],
  ])('is off with %s', (_name, env) => {
    expect(apnsConfig(env)).toBeNull();
  });
});

describe('the provider token', () => {
  it('is an ES256 JWT Apple can verify with the public key', () => {
    const jwt = mintProviderToken(CONFIG, NOW);
    const [header, claims, signature] = jwt.split('.');
    expect(decode(header)).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
    expect(decode(claims)).toEqual({ iss: 'TEAM123456', iat: NOW / 1000 });
    const sig = Buffer.from(signature, 'base64url');
    expect(sig).toHaveLength(64);
    expect(verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig)).toBe(true);
  });

  it('is reused for 50 minutes, then minted again', () => {
    const mint = vi.fn((_c: ApnsConfig, at: number) => `t${at}`);
    const tokens = providerTokens(mint);
    expect(tokens.get(CONFIG, NOW)).toBe(`t${NOW}`);
    expect(tokens.get(CONFIG, NOW + PROVIDER_TOKEN_TTL_MS - 1)).toBe(`t${NOW}`);
    expect(tokens.get(CONFIG, NOW + PROVIDER_TOKEN_TTL_MS)).toBe(`t${NOW + PROVIDER_TOKEN_TTL_MS}`);
    expect(mint).toHaveBeenCalledTimes(2);
    expect(PROVIDER_TOKEN_TTL_MS).toBeGreaterThanOrEqual(20 * 60_000);
    expect(PROVIDER_TOKEN_TTL_MS).toBeLessThan(60 * 60_000);
  });
});

describe('apnsRequestOf', () => {
  it('turns a last call into an alert with the phone’s own Done and Snooze', () => {
    const req = apnsRequestOf(lastCall.payload, NOW, 'app.dsul.ios')!;
    expect(req.headers).toEqual({
      'apns-push-type': 'alert',
      'apns-topic': 'app.dsul.ios',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor((NOW + 30 * 60_000) / 1000)),
      'apns-collapse-id': `dsul-item-${ITEM}`,
    });
    expect(JSON.parse(req.body)).toEqual({
      aps: {
        alert: { title: 'Last call: Vitamins', body: '3 days so far' },
        sound: 'default',
        'thread-id': 'dsul.rituals',
        category: APNS_CUE_CATEGORY,
      },
      url: `/item/${ITEM}`,
      itemId: ITEM,
      dateStr: '2026-10-11',
      kind: 'last-call',
      key: 'last-call:2026-10-11',
    });
  });

  it('has no buttons for a notice about no one item, and waits for the phone at normal urgency', () => {
    const req = apnsRequestOf({ title: 'Pledge settled', body: '$5 to the jar' }, NOW, 'app.dsul.ios')!;
    expect(req.headers['apns-priority']).toBe('5');
    expect(req.headers['apns-expiration']).toBe(String(Math.floor(NOW / 1000) + DEFAULT_TTL_S));
    expect(req.headers).not.toHaveProperty('apns-collapse-id');
    expect(JSON.parse(req.body).aps).not.toHaveProperty('category');
  });

  it('takes the sooner of ttl and expiresAtMs, and a window already past is now or never', () => {
    expect(apnsRequestOf({ ...lastCall.payload, ttl: 60 }, NOW, 'b')!.headers['apns-expiration']).toBe(String(NOW / 1000 + 60));
    expect(apnsRequestOf({ ...lastCall.payload, expiresAtMs: NOW - 1 }, NOW, 'b')!.headers['apns-expiration']).toBe('0');
    expect(apnsRequestOf({ ...lastCall.payload, ttl: 0 }, NOW, 'b')!.headers['apns-expiration']).toBe('0');
  });

  it('leaves off a collapse id over 64 bytes, and refuses a payload over 4 KB', () => {
    expect(apnsRequestOf({ ...lastCall.payload, tag: `dsul-${'x'.repeat(80)}` }, NOW, 'b')!.headers).not.toHaveProperty('apns-collapse-id');
    expect(apnsRequestOf({ ...lastCall.payload, body: 'x'.repeat(APNS_MAX_PAYLOAD_BYTES) }, NOW, 'b')).toBeNull();
  });
});

describe('outcomeOf', () => {
  const at = '2026-10-01T00:00:00Z';
  it.each<[string, ApnsResponse, string, ReturnType<typeof outcomeOf>]>([
    ['200', { status: 200 }, at, { ok: true }],
    ['BadDeviceToken', { status: 400, reason: 'BadDeviceToken' }, at, { ok: false, terminal: true, code: 'bad_device_token' }],
    ['DeviceTokenNotForTopic', { status: 400, reason: 'DeviceTokenNotForTopic' }, at, { ok: false, terminal: true, code: 'not_for_topic' }],
    ['another 400', { status: 400, reason: 'BadExpirationDate' }, at, { ok: false, terminal: false, code: 'http_400' }],
    ['410 after the registration', { status: 410, reason: 'Unregistered', timestamp: Date.parse('2026-10-05T00:00:00Z') }, at, { ok: false, terminal: true, code: 'gone_410' }],
    ['410 before a re-registration', { status: 410, reason: 'Unregistered', timestamp: Date.parse('2026-09-01T00:00:00Z') }, at, { ok: false, terminal: false, code: 'unregistered_before' }],
    ['410 with no timestamp', { status: 410, reason: 'Unregistered' }, at, { ok: false, terminal: false, code: 'unregistered_before' }],
    ['403, our key', { status: 403, reason: 'InvalidProviderToken' }, at, { ok: false, terminal: false, code: 'provider_token_rejected' }],
    ['429', { status: 429, reason: 'TooManyRequests' }, at, { ok: false, terminal: false, code: 'throttled' }],
    ['429 token updates', { status: 429, reason: 'TooManyProviderTokenUpdates' }, at, { ok: false, terminal: false, code: 'token_updates' }],
    ['503', { status: 503, reason: 'ServiceUnavailable' }, at, { ok: false, terminal: false, code: 'apns_error' }],
  ])('%s', (_name, res, registeredAt, expected) => {
    expect(outcomeOf(res, registeredAt)).toEqual(expected);
    if (!expected.ok) expect(expected.code).toMatch(/^[a-z0-9_]{1,64}$/);
  });
});

describe('the transport', () => {
  const make = (answers: ApnsResponse[] | Error, config: ApnsConfig | null = CONFIG) => {
    const post = vi.fn<ApnsPost>(async () => {
      if (answers instanceof Error) throw answers;
      return answers.shift() ?? { status: 200 };
    });
    const tokens = { get: vi.fn(() => 'jwt-1'), renew: vi.fn(() => 'jwt-2') };
    return { transport: createApnsTransport({ config: () => config, post, tokens, now: () => NOW }), post, tokens };
  };

  it('is unavailable without a configuration, so its rows are held and never pruned', async () => {
    const { transport, post } = make([], null);
    expect(transport.available()).toBe(false);
    expect(await transport.send(phone(), lastCall)).toEqual({ ok: false, terminal: false, code: 'not_configured' });
    expect(post).not.toHaveBeenCalled();
  });

  it('posts to the host the token belongs to, with the token in the path and the JWT as bearer', async () => {
    const { transport, post } = make([{ status: 200 }, { status: 200 }]);
    expect(transport.available()).toBe(true);
    expect(await transport.send(phone(), lastCall)).toEqual({ ok: true });
    await transport.send(phone({ apns_environment: 'sandbox' }), lastCall);
    expect(post.mock.calls.map((c) => c[0])).toEqual([APNS_HOSTS.production, APNS_HOSTS.sandbox]);
    const [, headers, body] = post.mock.calls[0];
    expect(headers).toMatchObject({ ':path': `/3/device/${TOKEN}`, authorization: 'bearer jwt-1', 'apns-topic': 'app.dsul.ios' });
    expect(JSON.parse(body).aps.alert.title).toBe('Last call: Vitamins');
  });

  it('mints a fresh token once on ExpiredProviderToken, and no more', async () => {
    const { transport, post, tokens } = make([
      { status: 403, reason: 'ExpiredProviderToken' },
      { status: 403, reason: 'ExpiredProviderToken' },
    ]);
    expect(await transport.send(phone(), lastCall)).toEqual({ ok: false, terminal: false, code: 'provider_token_rejected' });
    expect(post).toHaveBeenCalledTimes(2);
    expect(tokens.renew).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[1][1].authorization).toBe('bearer jwt-2');
  });

  it('answers the network as a code, never a throw', async () => {
    const { transport } = make(new Error('ECONNRESET'));
    expect(await transport.send(phone(), lastCall)).toEqual({ ok: false, terminal: false, code: 'network' });
  });

  it('sends nothing for a row with no usable token or no environment', async () => {
    const { transport, post } = make([]);
    expect(await transport.send(phone({ token: 'not-hex' }), lastCall)).toMatchObject({ code: 'no_token' });
    expect(await transport.send(phone({ apns_environment: null }), lastCall)).toMatchObject({ code: 'no_environment' });
    expect(post).not.toHaveBeenCalled();
  });
});

describe('the wake', () => {
  it('is a silent background push at priority 5, now or never', () => {
    const { headers, body } = apnsWakeRequest('app.dsul.ios');
    expect(headers).toEqual({
      'apns-push-type': 'background',
      'apns-topic': 'app.dsul.ios',
      'apns-priority': '5',
      // A held wake would replace a held last call: APNs keeps one per app.
      'apns-expiration': '0',
    });
    expect(JSON.parse(body)).toEqual({ aps: { 'content-available': 1 }, dsul: { reason: APNS_WAKE_REASON } });
    expect(JSON.parse(body).aps).not.toHaveProperty('alert');
    expect(JSON.parse(body).aps).not.toHaveProperty('sound');
  });

  it('goes to the same host, path and bearer as an alert, and reads Apple the same way', async () => {
    const post = vi.fn<ApnsPost>(async () => ({ status: 410, timestamp: Date.parse('2026-10-05T00:00:00Z') }));
    const tokens = { get: vi.fn(() => 'jwt-1'), renew: vi.fn(() => 'jwt-2') };
    const transport = createApnsTransport({ config: () => CONFIG, post, tokens, now: () => NOW });
    expect(await transport.wake(phone({ apns_environment: 'sandbox' }))).toEqual({ ok: false, terminal: true, code: 'gone_410' });
    const [origin, headers, body] = post.mock.calls[0];
    expect(origin).toBe(APNS_HOSTS.sandbox);
    expect(headers).toMatchObject({ ':path': `/3/device/${TOKEN}`, authorization: 'bearer jwt-1', 'apns-push-type': 'background' });
    expect(body).toBe(apnsWakeRequest('app.dsul.ios').body);
    expect(await transport.wake(phone({ token: null }))).toMatchObject({ code: 'no_token' });
  });
});
