// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { called, eqOf, fakeService, op, type FakeQuery, type FakeResult } from './helpers/fake-service';

/**
 * POST /api/reminders/ack (cue_log, migration 067; reminders PR-1b): a device
 * says it showed a cue. Cookie first, then a SERVICE write of acked_at and
 * acked_device only, filtered by the session's user_id and the key, first
 * ack only. `authenticated` has no write on the ledger at all.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const KEY = 'cue:44444444-4444-4444-8444-444444444444:2026-10-10T07:30';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abcdef-0001';

const h = vi.hoisted(() => ({ session: null as unknown, service: null as unknown }));
vi.mock('@/lib/supabase-server', () => ({ createClient: async () => h.session }));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => h.service }));

import { POST } from '@/app/api/reminders/ack/route';

let user: { id: string } | null;
let logResult: FakeResult;
let deviceResult: FakeResult;
let svc: ReturnType<typeof fakeService>;
let sessionFake: ReturnType<typeof fakeService>;

const ack = (body: unknown) =>
  POST(new Request('https://do.dsul.app/api/reminders/ack', { method: 'POST', body: JSON.stringify(body) }) as unknown as NextRequest);

beforeEach(() => {
  user = { id: USER };
  logResult = { data: [{ id: 'row-1' }], error: null };
  deviceResult = { data: { device_id: 'web-device-0001' }, error: null };
  svc = fakeService((q: FakeQuery) => (q.table === 'cue_log' ? logResult : q.table === 'devices' ? deviceResult : { data: null, error: null }));
  sessionFake = fakeService(() => ({ data: null, error: { message: 'the session client writes nothing here' } }));
  h.service = svc.service;
  h.session = { ...sessionFake.service, auth: { getUser: async () => ({ data: { user } }) } };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const write = () => svc.queries.find((q) => q.table === 'cue_log')!;

describe('POST /api/reminders/ack', () => {
  it('401 without a session, and nothing written', async () => {
    user = null;
    expect((await ack({ key: KEY, deviceId: 'web-device-0001' })).status).toBe(401);
    expect(svc.queries).toEqual([]);
  });

  it('400 on a body that is not one of the two strict shapes', async () => {
    expect((await ack({ key: 'whatever', deviceId: 'web-device-0001' })).status).toBe(400);
    expect((await ack({ key: KEY })).status).toBe(400);
    expect((await ack({ key: KEY, deviceId: 'web-device-0001', endpoint: ENDPOINT })).status).toBe(400);
    expect((await ack({ key: KEY, endpoint: 'http://insecure.example/x-0001' })).status).toBe(400);
    expect(svc.queries).toEqual([]);
  });

  it('a page’s ack: acked_at and acked_device, on this user’s row with this key, first ack only', async () => {
    const res = await ack({ key: KEY, deviceId: 'web-device-0001' });
    expect(await res.json()).toEqual({ ok: true, logged: true });
    const q = write();
    expect(op(q)).toBe('update');
    const payload = called(q, 'update')[0][0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['acked_at', 'acked_device']);
    expect(payload.acked_device).toBe('web-device-0001');
    expect(eqOf(q, 'user_id')).toBe(USER);
    expect(eqOf(q, 'key')).toBe(KEY);
    expect(called(q, 'is')).toContainEqual(['acked_at', null]);
    // Through the service role, never the session client.
    expect(sessionFake.queries).toEqual([]);
  });

  it('the worker’s ack: its endpoint is looked up among this user’s own devices', async () => {
    await ack({ key: KEY, endpoint: ENDPOINT });
    const lookup = svc.queries.find((q) => q.table === 'devices')!;
    expect(eqOf(lookup, 'user_id')).toBe(USER);
    expect(eqOf(lookup, 'token')).toBe(ENDPOINT);
    expect((called(write(), 'update')[0][0] as Record<string, unknown>).acked_device).toBe('web-device-0001');
  });

  it('an endpoint no device of this user holds acks with no device', async () => {
    deviceResult = { data: null, error: null };
    await ack({ key: KEY, endpoint: ENDPOINT });
    expect((called(write(), 'update')[0][0] as Record<string, unknown>).acked_device).toBeNull();
  });

  it('logged: false when no row has the key yet, or it was acked already', async () => {
    logResult = { data: [], error: null };
    expect(await (await ack({ key: KEY, deviceId: 'web-device-0001' })).json()).toEqual({ ok: true, logged: false });
  });

  it('503 while 067 is not applied', async () => {
    logResult = { data: null, error: { code: 'PGRST205', message: 'no cue_log' } };
    expect((await ack({ key: KEY, deviceId: 'web-device-0001' })).status).toBe(503);
    logResult = { data: null, error: { code: '42P01', message: 'no cue_log' } };
    expect((await ack({ key: KEY, deviceId: 'web-device-0001' })).status).toBe(503);
  });

  it('500 on any other write failure', async () => {
    logResult = { data: null, error: { code: 'XX000', message: 'down' } };
    expect((await ack({ key: KEY, deviceId: 'web-device-0001' })).status).toBe(500);
  });
});
