import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/app/devices and DELETE /api/app/devices/:deviceId — the iPhone
 * app's registration and sign-out release (reminders Phase 2d). Bearer only;
 * the registry writes (lib/devices/registry.ts) are mocked here and tested in
 * devices-registry.test.ts.
 */

const USER = '6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';
const DEVICE = 'ios:0b7c2f9a-1d3e-4c5b-9a8f-7e6d5c4b3a21';

const h = vi.hoisted(() => ({
  createClient: vi.fn(),
  registerDevice: vi.fn(),
  releaseOwnDevice: vi.fn(),
  service: { tag: 'service' },
}));

vi.mock('@supabase/supabase-js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
  createClient: h.createClient,
}));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => h.service }));
vi.mock('@/lib/devices/registry', () => ({
  registerDevice: h.registerDevice,
  releaseOwnDevice: h.releaseOwnDevice,
}));

import { POST } from '@/app/api/app/devices/route';
import { DELETE } from '@/app/api/app/devices/[deviceId]/route';

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = () =>
  [b64({ alg: 'HS256' }), b64({ sub: USER, role: 'authenticated', exp: Date.now() / 1000 + 3600 }), 'sig'].join('.');

const phone = {
  deviceId: DEVICE,
  platform: 'ios',
  transport: 'none',
  delivery: 'local',
  os: 'ios',
  form: 'phone',
  label: 'iPhone',
  appVersion: '1.0 (12)',
  osVersion: '27.0',
  timezone: 'America/Los_Angeles',
};

const post = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${token()}` }) =>
  POST(
    new Request('https://do.dsul.app/api/app/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

const del = (deviceId: string, headers: Record<string, string> = { authorization: `Bearer ${token()}` }) =>
  DELETE(new Request(`https://do.dsul.app/api/app/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE', headers }), {
    params: Promise.resolve({ deviceId }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://ref.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
  h.createClient.mockImplementation(() => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: USER } }, error: null })) },
  }));
  h.registerDevice.mockResolvedValue({ ok: true, written: true });
  h.releaseOwnDevice.mockResolvedValue({ ok: true, written: true });
});

describe('POST /api/app/devices', () => {
  it('registers the phone for the bearer’s user through the service client', async () => {
    const res = await post(phone);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.registerDevice).toHaveBeenCalledTimes(1);
    expect(h.registerDevice).toHaveBeenCalledWith(h.service, USER, phone);
  });

  it('refuses a request with no bearer, and never reads a cookie', async () => {
    const res = await post(phone, { cookie: 'sb-access-token=x' });
    expect(res.status).toBe(401);
    expect(h.registerDevice).not.toHaveBeenCalled();
  });

  it.each([
    ['a web device', { ...phone, platform: 'web' }],
    ['a pushed delivery', { ...phone, delivery: 'push' }],
    ['no delivery', Object.fromEntries(Object.entries(phone).filter(([key]) => key !== 'delivery'))],
    ['an APNs token before Phase 3', { ...phone, transport: 'apns', token: 'a'.repeat(64), apnsEnvironment: 'sandbox' }],
    ['a token on a tokenless device', { ...phone, token: 'a'.repeat(64) }],
    ['an unknown key', { ...phone, userId: USER }],
    ['a short device id', { ...phone, deviceId: 'ios:1' }],
  ])('refuses %s with a bare 400', async (_name, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid' });
    expect(h.registerDevice).not.toHaveBeenCalled();
  });

  it('refuses a body that is not JSON', async () => {
    const res = await post('{nope');
    expect(res.status).toBe(400);
    expect(h.registerDevice).not.toHaveBeenCalled();
  });

  it('answers 503 while the registry is missing, so the phone tries again later', async () => {
    h.registerDevice.mockResolvedValue({ ok: false, code: 'unavailable' });
    const res = await post(phone);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
  });

  it('never sends a database message back', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.registerDevice.mockResolvedValue({ ok: false, code: 'failed', detail: 'relation "x" violates check' });
    const res = await post(phone);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'failed' });
    spy.mockRestore();
  });
});

describe('DELETE /api/app/devices/:deviceId', () => {
  it('releases only the bearer’s own row by its device id', async () => {
    const res = await del(DEVICE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.releaseOwnDevice).toHaveBeenCalledWith(h.service, USER, DEVICE);
  });

  it('refuses a request with no bearer', async () => {
    const res = await del(DEVICE, {});
    expect(res.status).toBe(401);
    expect(h.releaseOwnDevice).not.toHaveBeenCalled();
  });

  it('refuses a malformed device id before touching the registry', async () => {
    const res = await del('ios:x y');
    expect(res.status).toBe(400);
    expect(h.releaseOwnDevice).not.toHaveBeenCalled();
  });

  it('is ok with nothing to release', async () => {
    h.releaseOwnDevice.mockResolvedValue({ ok: true, written: false, legacy: true });
    const res = await del(DEVICE);
    expect(res.status).toBe(200);
  });
});
