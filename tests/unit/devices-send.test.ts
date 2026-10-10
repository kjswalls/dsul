import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeServiceFake } from './support/service-fake';

/**
 * sendToUser (lib/devices/send.ts): one notification to every device that
 * wants it, and every row answering for itself afterwards.
 */

const sendNotification = vi.fn();
vi.mock('web-push', () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotification(...args),
    setVapidDetails: () => {},
  },
}));

import { SENDERS, sendToUser, type Transport } from '@/lib/devices/send';
import { DEVICE_SEND_COLUMNS } from '@/lib/devices/db';
import type { DeviceRow } from '@/lib/devices/types';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const AT = new Date(NOW).toISOString();

const device = (n: number, extra: Partial<DeviceRow> = {}): DeviceRow => ({
  id: `row-${n}`,
  user_id: 'u1',
  device_id: `device-${n}-000`,
  platform: 'web',
  transport: 'webpush',
  delivery: 'push',
  os: null,
  form: null,
  token: `https://push.example/${n}`,
  keys: { p256dh: 'p', auth: 'a' },
  timezone: null,
  prefs: {},
  registered_at: AT,
  last_seen_at: AT,
  ...extra,
});

const message = { kind: 'cue' as const, payload: { title: 'Vitamins', body: 'Now' } };

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'test-public');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'test-private');
  sendNotification.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201, body: '', headers: {} });
});
afterEach(() => vi.unstubAllEnvs());

describe('sendToUser', () => {
  it("reads the user's rows through the service role, the one reader of token and keys", async () => {
    const fake = makeServiceFake({ 'devices.select': { data: [] } });
    await sendToUser(fake.service, 'u1', message, { nowMs: NOW });
    expect(fake.calls[0]).toMatchObject({ table: 'devices', op: 'select', payload: DEVICE_SEND_COLUMNS });
    expect(fake.calls[0].filters).toEqual([['eq', ['user_id', 'u1']]]);
  });

  it('pushes to each eligible device with its endpoint and keys, and stamps the ones that took it', async () => {
    const fake = makeServiceFake({ 'devices.select': { data: [device(1), device(2)] } });
    const report = await sendToUser(fake.service, 'u1', message, { nowMs: NOW });

    expect(report).toMatchObject({ devices: 2, eligible: 2, accepted: 2, failed: 0, pruned: 0, held: 0 });
    expect(sendNotification.mock.calls.map(([sub]) => sub)).toEqual([
      { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } },
      { endpoint: 'https://push.example/2', keys: { p256dh: 'p', auth: 'a' } },
    ]);
    // Seen as well as sent: a device that only ever receives is never pruned as unseen.
    expect(fake.writes()).toEqual([
      expect.objectContaining({
        op: 'update',
        payload: { last_sent_at: AT, last_seen_at: AT, last_failure: null },
        filters: [
          ['eq', ['user_id', 'u1']],
          ['in', ['id', ['row-1', 'row-2']]],
        ],
      }),
    ]);
  });

  it('prunes a gone endpoint by id, records a failure code, and keeps the failing row', async () => {
    sendNotification
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }))
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { statusCode: 503 }))
      .mockResolvedValueOnce({ statusCode: 201 });
    const fake = makeServiceFake({ 'devices.select': { data: [device(1), device(2), device(3)] } });
    const report = await sendToUser(fake.service, 'u1', message, { nowMs: NOW });

    expect(report).toMatchObject({ eligible: 3, accepted: 1, failed: 1, pruned: 1 });
    expect(report.perDevice).toEqual([
      { deviceId: 'device-1-000', transport: 'webpush', outcome: 'pruned', code: 'gone_410' },
      { deviceId: 'device-2-000', transport: 'webpush', outcome: 'failed', code: 'push_service_error' },
      { deviceId: 'device-3-000', transport: 'webpush', outcome: 'accepted' },
    ]);
    const writes = fake.writes().map((w) => [w.op, w.payload, w.filters]);
    expect(writes).toContainEqual(['update', { last_failure: 'push_service_error' }, [['eq', ['user_id', 'u1']], ['in', ['id', ['row-2']]]]]);
    expect(writes).toContainEqual(['delete', undefined, [['eq', ['user_id', 'u1']], ['in', ['id', ['row-1']]]]]);
  });

  // A rotated or malformed VAPID pair is every device failing at once; pruning
  // on it would delete every row the deployment holds.
  it('never prunes on a refused VAPID key', async () => {
    sendNotification.mockRejectedValue(Object.assign(new Error('nope'), { statusCode: 403 }));
    const fake = makeServiceFake({ 'devices.select': { data: [device(1)] } });
    const report = await sendToUser(fake.service, 'u1', message, { nowMs: NOW });
    expect(report).toMatchObject({ failed: 1, pruned: 0 });
    expect(fake.writes().map((w) => w.op)).toEqual(['update']);
  });

  it('holds every row, and fails none, when there is no VAPID pair', async () => {
    vi.stubEnv('VAPID_PRIVATE_KEY', '');
    const fake = makeServiceFake({ 'devices.select': { data: [device(1)] } });
    const report = await sendToUser(fake.service, 'u1', message, { nowMs: NOW });
    expect(report).toMatchObject({ devices: 1, eligible: 0, held: 1, failed: 0 });
    expect(report.perDevice[0]).toMatchObject({ outcome: 'held', code: 'transport_off' });
    expect(sendNotification).not.toHaveBeenCalled();
    expect(fake.writes()).toEqual([]);
  });

  it('holds a device on a transport this build cannot send on', async () => {
    const native = device(1, { platform: 'ios', transport: 'apns', keys: null, token: 'a'.repeat(64) });
    const report = await sendToUser(makeServiceFake({ 'devices.select': { data: [native] } }).service, 'u1', {
      kind: 'last-call',
      payload: message.payload,
    }, { nowMs: NOW });
    expect(report.perDevice).toEqual([{ deviceId: 'device-1-000', transport: 'apns', outcome: 'held', code: 'no_sender' }]);
  });

  it('a transport that throws costs that device, never the others or the caller', async () => {
    const throwing: Transport = { available: () => true, send: async () => Promise.reject(new Error('boom')) };
    const fake = makeServiceFake({ 'devices.select': { data: [device(1), device(2, { transport: 'fcm' })] } });
    const report = await sendToUser(fake.service, 'u1', message, { nowMs: NOW }, { ...SENDERS, fcm: throwing });
    expect(report).toMatchObject({ accepted: 1, failed: 1 });
    expect(report.perDevice).toContainEqual({ deviceId: 'device-2-000', transport: 'fcm', outcome: 'failed', code: 'threw' });
  });

  it('answers a failed read with zeros and a detail, never a throw', async () => {
    const errored = await sendToUser(
      makeServiceFake({ 'devices.select': { error: { code: '57014', message: 'timeout' } } }).service,
      'u1',
      message,
    );
    expect(errored).toMatchObject({ devices: 0, eligible: 0, detail: 'read failed: timeout' });
    const thrown = await sendToUser(
      makeServiceFake(() => {
        throw new Error('fetch failed');
      }).service,
      'u1',
      message,
    );
    expect(thrown.detail).toBe('read failed: fetch failed');
  });

  // Deploy leads migration: the build ships before 064 is applied.
  it.each(['42P01', 'PGRST205'])('falls back to push_subscriptions while the table is missing (%s)', async (code) => {
    const fake = makeServiceFake({
      'devices.select': { error: { code, message: 'no devices' } },
      'push_subscriptions.select': { data: [{ endpoint: 'https://push.example/9', p256dh: 'p', auth: 'a' }] },
    });
    const report = await sendToUser(fake.service, 'u1', message, { nowMs: NOW });
    expect(report).toMatchObject({ legacy: true, devices: 1, accepted: 1 });
    expect(sendNotification.mock.calls[0][0]).toEqual({ endpoint: 'https://push.example/9', keys: { p256dh: 'p', auth: 'a' } });
  });
});
