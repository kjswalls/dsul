import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { DeviceRegistration } from '@dsul/types';
import { DeviceRegistrationSchema } from '@dsul/types';
import { makeServiceFake, type FakeCall, type FakeResult } from './support/service-fake';

/**
 * The registry's writes (lib/devices/registry.ts) and POST /api/devices,
 * /api/devices/rotate and the /api/push/subscribe alias.
 */

let respond: (call: FakeCall) => FakeResult | undefined = () => undefined;
let fake = makeServiceFake((c) => respond(c));
const rpc = vi.fn<(name: string, args: unknown) => Promise<{ data: unknown; error: unknown }>>(async () => ({
  data: 'new-id',
  error: null,
}));
const service = () => ({ ...(fake.service as object), rpc }) as never;

vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => service() }));
const getUser = vi.fn(async () => ({ data: { user: { id: 'u1' } as { id: string } | null } }));
vi.mock('@/lib/supabase-server', () => ({ createClient: async () => ({ auth: { getUser } }) }));

import { TOUCH_THROTTLE_MS, registerArgs, registerDevice, rotateWebPushToken } from '@/lib/devices/registry';
import { placeholderDeviceId } from '@/lib/devices/routes';
import { POST as postDevices } from '@/app/api/devices/route';
import { POST as postRotate } from '@/app/api/devices/rotate/route';
import { POST as postSubscribe } from '@/app/api/push/subscribe/route';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';
const REG: DeviceRegistration = {
  deviceId: 'web-0b6f1c2e-device',
  platform: 'web',
  transport: 'webpush',
  delivery: 'push',
  os: 'macos',
  form: 'desktop',
  token: ENDPOINT,
  keys: { p256dh: 'BPk', auth: 'au' },
  label: 'Chrome on Mac',
  timezone: 'Europe/London',
};

/** The row register_device left last time, as registerDevice reads it. */
const existing = (extra: Record<string, unknown> = {}) => ({
  id: 'row-1',
  platform: 'web',
  transport: 'webpush',
  delivery: 'push',
  os: 'macos',
  form: 'desktop',
  token: ENDPOINT,
  keys: { p256dh: 'BPk', auth: 'au' },
  apns_environment: null,
  parent_device_id: null,
  app_version: null,
  os_version: null,
  timezone: 'Europe/London',
  last_seen_at: new Date(NOW - 60_000).toISOString(),
  last_failure: null,
  ...extra,
});

beforeEach(() => {
  respond = () => undefined;
  fake = makeServiceFake((c) => respond(c));
  rpc.mockClear();
  rpc.mockResolvedValue({ data: 'new-id', error: null });
  getUser.mockClear();
  getUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
});

describe('registerArgs', () => {
  it("passes register_device's fifteen arguments, in its own order", () => {
    expect(Object.keys(registerArgs('u1', REG, null))).toEqual([
      'p_user_id',
      'p_device_id',
      'p_platform',
      'p_transport',
      'p_delivery',
      'p_os',
      'p_form',
      'p_token',
      'p_keys',
      'p_apns_environment',
      'p_parent_device_id',
      'p_label',
      'p_app_version',
      'p_os_version',
      'p_timezone',
    ]);
  });
});

describe('registerDevice', () => {
  it('registers a new device with its suggested name, through the rpc', async () => {
    const result = await registerDevice(service(), 'u1', REG, NOW);
    expect(result).toEqual({ ok: true, written: true });
    expect(fake.calls[0].filters).toEqual([
      ['eq', ['user_id', 'u1']],
      ['eq', ['device_id', REG.deviceId]],
      ['maybeSingle', []],
    ]);
    expect(rpc).toHaveBeenCalledWith('register_device', registerArgs('u1', REG, 'Chrome on Mac'));
  });

  it('writes nothing for an unchanged registration seen within 12 hours', async () => {
    respond = (c) => (c.op === 'select' ? { data: existing() } : undefined);
    expect(await registerDevice(service(), 'u1', REG, NOW)).toEqual({ ok: true, written: false });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('touches an unchanged registration once the throttle has passed', async () => {
    respond = (c) => (c.op === 'select' ? { data: existing({ last_seen_at: new Date(NOW - TOUCH_THROTTLE_MS - 1).toISOString() }) } : undefined);
    expect(await registerDevice(service(), 'u1', REG, NOW)).toEqual({ ok: true, written: true });
    // Never the suggested name over an existing row: the owner may have renamed it.
    expect(rpc).toHaveBeenCalledWith('register_device', registerArgs('u1', REG, null));
  });

  it.each([
    ['a new endpoint', { token: 'https://fcm.googleapis.com/fcm/send/rotated' }],
    ['new keys', { keys: { p256dh: 'other', auth: 'au' } }],
    ['a new zone', { timezone: 'Asia/Tokyo' }],
    ['local delivery', { delivery: 'local' as const }],
  ])('writes at once for %s', async (_label, change) => {
    respond = (c) => (c.op === 'select' ? { data: existing() } : undefined);
    await registerDevice(service(), 'u1', { ...REG, ...change }, NOW);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('writes at once for a row carrying a failure: a registration says the device works again', async () => {
    respond = (c) => (c.op === 'select' ? { data: existing({ last_failure: 'throttled' }) } : undefined);
    await registerDevice(service(), 'u1', REG, NOW);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('before 065, a web push registration is the old push_subscriptions upsert', async () => {
    respond = (c) => (c.table === 'devices' ? { error: { code: 'PGRST205', message: 'missing' } } : undefined);
    expect(await registerDevice(service(), 'u1', REG, NOW)).toEqual({ ok: true, written: true, legacy: true });
    expect(fake.writes()).toEqual([
      expect.objectContaining({
        table: 'push_subscriptions',
        op: 'upsert',
        payload: { user_id: 'u1', endpoint: ENDPOINT, p256dh: 'BPk', auth: 'au' },
        options: { onConflict: 'user_id,endpoint' },
      }),
    ]);
  });

  it('before 065, a tokenless device is unavailable', async () => {
    respond = () => ({ error: { code: '42P01', message: 'missing' } });
    const result = await registerDevice(service(), 'u1', { deviceId: REG.deviceId, platform: 'electron', transport: 'none' }, NOW);
    expect(result).toEqual({ ok: false, code: 'unavailable' });
  });
});

describe('rotateWebPushToken', () => {
  it("moves the row holding the old endpoint onto the new one, keeping its device id", async () => {
    respond = (c) =>
      c.op === 'select' && c.payload === 'device_id, platform, delivery'
        ? { data: { device_id: REG.deviceId, platform: 'web', delivery: 'push' } }
        : undefined;
    const next = { token: 'https://fcm.googleapis.com/fcm/send/rotated', keys: { p256dh: 'n', auth: 'm' } };
    expect(await rotateWebPushToken(service(), 'u1', ENDPOINT, next, NOW)).toEqual({ ok: true, written: true });
    expect(fake.calls[0].filters).toEqual([
      ['eq', ['user_id', 'u1']],
      ['eq', ['transport', 'webpush']],
      ['eq', ['token', ENDPOINT]],
      ['maybeSingle', []],
    ]);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_device_id: REG.deviceId, p_token: next.token, p_keys: next.keys });
  });

  it('no row holds the old endpoint: not found, and nothing written', async () => {
    const result = await rotateWebPushToken(service(), 'u1', ENDPOINT, { token: ENDPOINT + 'x', keys: { p256dh: 'n', auth: 'm' } });
    expect(result).toEqual({ ok: false, code: 'not_found' });
    expect(rpc).not.toHaveBeenCalled();
  });
});

const post = (handler: (req: NextRequest) => Promise<Response>, body: unknown) =>
  handler(
    new Request('https://do.dsul.app/api/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }) as unknown as NextRequest,
  );

describe('POST /api/devices', () => {
  it('needs a session', async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    expect((await post(postDevices, REG)).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('registers the session user', async () => {
    const res = await post(postDevices, REG);
    expect(res.status).toBe(200);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_user_id: 'u1', p_device_id: REG.deviceId });
  });

  it.each([
    ['an unknown key', { ...REG, userId: 'u2' }],
    ['webpush without keys', { ...REG, keys: undefined }],
    ['none with a token', { ...REG, transport: 'none', keys: undefined }],
    ['a bad device id', { ...REG, deviceId: 'no' }],
    ['a token with a space', { ...REG, token: 'https://x.example/a b c d e f g' }],
    ['not JSON', 'nope'],
  ])('refuses %s with a 400', async (_label, body) => {
    expect((await post(postDevices, body)).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  // A native token belongs to a bearer-authenticated app (Phase 2d's /api/app/devices).
  it.each(['apns', 'fcm'] as const)('refuses an %s registration', async (transport) => {
    const body = { deviceId: REG.deviceId, platform: 'ios', transport, token: 'a'.repeat(64), ...(transport === 'apns' ? { apnsEnvironment: 'production' } : {}) };
    expect(DeviceRegistrationSchema.safeParse(body).success).toBe(true);
    expect((await post(postDevices, body)).status).toBe(400);
  });

  it('answers 503 unavailable when the registry is missing and the device needs it', async () => {
    respond = () => ({ error: { code: '42P01', message: 'missing' } });
    const res = await post(postDevices, { deviceId: REG.deviceId, platform: 'electron', transport: 'none' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
  });
});

describe('POST /api/devices/rotate', () => {
  const body = { oldToken: ENDPOINT, token: ENDPOINT + '-new', keys: { p256dh: 'n', auth: 'm' } };

  it('needs a session', async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    expect((await post(postRotate, body)).status).toBe(401);
  });

  it('a rotation with no old endpoint is not found, and the next boot heals it', async () => {
    expect((await post(postRotate, { ...body, oldToken: null })).status).toBe(404);
  });

  it('refuses a body with anything else in it', async () => {
    expect((await post(postRotate, { ...body, deviceId: 'x' })).status).toBe(400);
  });
});

describe('POST /api/push/subscribe, the alias', () => {
  it('registers the endpoint under the placeholder id 065 backfills it with', async () => {
    const res = await post(postSubscribe, { endpoint: ENDPOINT, p256dh: 'BPk', auth: 'au' });
    expect(res.status).toBe(200);
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_user_id: 'u1',
      p_device_id: placeholderDeviceId(ENDPOINT),
      p_platform: 'web',
      p_transport: 'webpush',
      p_token: ENDPOINT,
    });
    expect(placeholderDeviceId(ENDPOINT)).toMatch(/^web:[0-9a-f]{64}$/);
  });

  it('refuses a missing key', async () => {
    expect((await post(postSubscribe, { endpoint: ENDPOINT, p256dh: 'BPk' })).status).toBe(400);
  });
});
