import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceRegistrationSchema } from '@dsul/types';
import {
  DEVICE_ID_KEY,
  registerThisBrowser,
  registrationFor,
  storedDeviceId,
  thisDeviceId,
  uaHints,
} from '@/lib/devices/web-client';
import { coveredByIphoneApp, deviceName, kindOn, withKind, type RosterRow } from '@/lib/devices/roster';

/** This browser as a device (lib/devices/web-client.ts), and the Devices list's words (lib/devices/roster.ts). */

const UA = {
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  ipadDesktop:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  android:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
};

describe('uaHints', () => {
  it.each([
    ['an iPhone', UA.iphone, 0, { os: 'ios', form: 'phone', label: 'Safari on iPhone' }],
    ['an iPad asking for the desktop site', UA.ipadDesktop, 5, { os: 'ios', form: 'tablet', label: 'Safari on iPad' }],
    ['a Mac', UA.mac, 0, { os: 'macos', form: 'desktop', label: 'Chrome on Mac' }],
    ['an Android phone', UA.android, 5, { os: 'android', form: 'phone', label: 'Chrome on Android' }],
    ['Edge on Windows', UA.windowsEdge, 0, { os: 'windows', form: 'desktop', label: 'Edge on Windows' }],
    ['Firefox on Linux', UA.firefoxLinux, 0, { os: 'linux', form: 'desktop', label: 'Firefox on Linux' }],
  ])('%s', (_label, ua, touch, expected) => {
    expect(uaHints(ua, touch)).toEqual(expected);
  });
});

describe('thisDeviceId', () => {
  beforeEach(() => localStorage.clear());

  it('makes one id, keeps it, and it passes 064’s device_id check', () => {
    const id = thisDeviceId();
    expect(id).toMatch(/^[A-Za-z0-9:._-]{8,128}$/);
    expect(thisDeviceId()).toBe(id);
    expect(localStorage.getItem(DEVICE_ID_KEY)).toBe(id);
    expect(storedDeviceId()).toBe(id);
  });

  it('replaces a stored value 064 would refuse', () => {
    localStorage.setItem(DEVICE_ID_KEY, 'no');
    expect(thisDeviceId()).not.toBe('no');
  });
});

const subscription = (keys: Record<string, string> | null = { p256dh: 'BPk', auth: 'au' }) =>
  ({
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: keys ?? undefined }),
  }) as unknown as PushSubscription;

describe('registrationFor', () => {
  it('is a registration POST /api/devices accepts', () => {
    const body = registrationFor(subscription(), uaHints(UA.iphone), 'web-1234-5678');
    expect(body).toMatchObject({
      deviceId: 'web-1234-5678',
      platform: 'web',
      transport: 'webpush',
      delivery: 'push',
      os: 'ios',
      form: 'phone',
      label: 'Safari on iPhone',
      token: 'https://fcm.googleapis.com/fcm/send/abc123',
      keys: { p256dh: 'BPk', auth: 'au' },
    });
    expect(DeviceRegistrationSchema.safeParse(body).success).toBe(true);
  });

  it('is nothing for a subscription without keys', () => {
    expect(registrationFor(subscription(null), {}, 'web-1234-5678')).toBeNull();
  });
});

describe('registerThisBrowser', () => {
  let current: PushSubscription | null;
  beforeEach(() => {
    localStorage.clear();
    current = subscription();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}')));
    vi.stubGlobal('Notification', { permission: 'granted' });
    Object.defineProperty(window, 'PushManager', { value: function PushManager() {}, configurable: true });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: async () => ({ pushManager: { getSubscription: async () => current } }) },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    delete (window as { PushManager?: unknown }).PushManager;
  });

  it("posts the current subscription under this browser's id", async () => {
    expect(await registerThisBrowser()).toBe(true);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/devices');
    expect(JSON.parse(String(init.body))).toMatchObject({ deviceId: thisDeviceId(), token: current!.endpoint });
  });

  it('posts nothing without a subscription, or without permission', async () => {
    current = null;
    expect(await registerThisBrowser()).toBe(false);
    current = subscription();
    vi.stubGlobal('Notification', { permission: 'denied' });
    expect(await registerThisBrowser()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    await expect(registerThisBrowser()).resolves.toBe(false);
  });
});

const roster = (extra: Partial<RosterRow> = {}): RosterRow => ({
  id: 'r1',
  device_id: 'web-0001-0001',
  platform: 'web',
  transport: 'webpush',
  delivery: 'push',
  os: 'macos',
  form: 'desktop',
  label: null,
  prefs: {},
  last_seen_at: '2026-10-10T12:00:00Z',
  last_sent_at: null,
  last_failure: null,
  ...extra,
});

describe('the Devices list', () => {
  it('names a device by its label, else by what it is', () => {
    expect(deviceName(roster({ label: 'Work laptop' }))).toBe('Work laptop');
    expect(deviceName(roster())).toBe('Browser on Mac');
    expect(deviceName(roster({ os: 'ios', form: 'phone' }))).toBe('Browser on iPhone');
    expect(deviceName(roster({ os: null, form: null }))).toBe('Browser');
    expect(deviceName(roster({ platform: 'ios' }))).toBe('dsul on iPhone');
  });

  it('reads an absent kind as on', () => {
    expect(kindOn(roster(), 'cue')).toBe(true);
    expect(kindOn(roster({ prefs: { kinds: { cue: false } } }), 'cue')).toBe(false);
  });

  it('switches one kind and keeps every other key', () => {
    const prefs = { kinds: { eod: false }, quiet: { start: '22:00', end: '07:00' }, claimsLocally: true };
    expect(withKind(prefs, 'cue', false)).toEqual({
      kinds: { eod: false, cue: false },
      quiet: { start: '22:00', end: '07:00' },
      claimsLocally: true,
    });
    expect(withKind(null, 'eod', true)).toEqual({ kinds: { eod: true } });
  });

  it('says the iPhone app covers the Home Screen app on the same phone, and nothing else', () => {
    const pwa = roster({ os: 'ios', form: 'phone' });
    const app = roster({ id: 'r2', platform: 'ios', transport: 'none', os: 'ios', form: 'phone' });
    expect(coveredByIphoneApp(pwa, [pwa, app])).toBe(true);
    expect(coveredByIphoneApp(pwa, [pwa])).toBe(false);
    expect(coveredByIphoneApp(roster({ os: 'ios', form: 'tablet' }), [app])).toBe(false);
  });
});
