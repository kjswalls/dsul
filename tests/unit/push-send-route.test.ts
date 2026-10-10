import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { PushResult } from '@/lib/push-send';

/**
 * POST /api/push/send — the HTTP surface over lib/push-send.ts, for the
 * browser and for OpenClaw.
 *
 * sendPushToUser used to THROW when it could not read the user's
 * subscriptions, and the route's catch turned that into a 500. It answers
 * now, with zeros and a `detail`, so the 500 comes from one branch that reads
 * it. Without that branch the route would say `{ ok: true, sent: 0 }`, "no
 * devices", about a question nobody answered.
 */

const sendPushToUser = vi.fn(async (): Promise<PushResult> => ({ devices: 1, sent: 1, expired: 0, failed: 0 }));
vi.mock('@/lib/push-send', () => ({
  isPushConfigured: () => true,
  sendPushToUser: (...args: unknown[]) => sendPushToUser(...(args as [])),
}));

// /api/push/send sends through the device registry (lib/devices/send.ts).
// It is stood in for here by the PushResult-shaped mock above, translated, so
// every count below still reads as devices, sent, expired and failed.
vi.mock('@/lib/devices/send', () => ({
  sendToUser: async (service: unknown, userId: string, message: { payload: unknown }) =>
    reportOf(await (sendPushToUser as unknown as (...a: unknown[]) => Promise<PushResult>)(service, userId, message.payload)),
}));
function reportOf(r: PushResult) {
  return {
    devices: r.devices,
    eligible: r.devices,
    accepted: r.sent,
    failed: r.failed,
    pruned: r.expired,
    held: 0,
    perDevice: [],
    ...(r.detail !== undefined ? { detail: r.detail } : {}),
  };
}

const SERVICE = { stand: 'in for the service client' };
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => SERVICE }));

// The cookie gate: signed in as u1.
vi.mock('@/lib/supabase-server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
  }),
}));

import { POST } from '@/app/api/push/send/route';

const post = (body: Record<string, unknown>) =>
  POST(
    new Request('https://do.dsul.app/api/push/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as NextRequest,
  );

beforeEach(() => {
  sendPushToUser.mockReset();
  sendPushToUser.mockResolvedValue({ devices: 1, sent: 1, expired: 0, failed: 0 });
});

afterEach(() => vi.restoreAllMocks());

describe('POST /api/push/send', () => {
  it('a read nobody answered is a 500 that says so, never "no devices"', async () => {
    sendPushToUser.mockResolvedValue({ devices: 0, sent: 0, expired: 0, failed: 0, detail: 'read failed: x' });

    const res = await post({ userId: 'u1', title: 'Hi' });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'read failed: x' });
  });

  // Zero devices with no detail IS the answer: the user has nowhere to push.
  it('no devices, read cleanly, is a 200 with sent: 0', async () => {
    sendPushToUser.mockResolvedValue({ devices: 0, sent: 0, expired: 0, failed: 0 });

    const res = await post({ userId: 'u1', title: 'Hi' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sent: 0 });
  });

  it('pushes as the signed-in user, with the service client, and names no TTL of its own', async () => {
    const res = await post({ userId: 'u1', title: 'Hi', body: 'there', url: '/x' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sent: 1 });
    const [service, userId, payload] = sendPushToUser.mock.calls[0] as unknown as [unknown, string, Record<string, unknown>];
    expect(service).toBe(SERVICE);
    expect(userId).toBe('u1');
    expect(payload).toMatchObject({ title: 'Hi', body: 'there', url: '/x' });
    // Its body has no field for one, so DEFAULT_TTL_S applies in push-send.
    expect(payload).not.toHaveProperty('ttl');
    expect(payload).not.toHaveProperty('expiresAtMs');
  });

  it('refuses a push to someone else', async () => {
    const res = await post({ userId: 'u2', title: 'Hi' });
    expect(res.status).toBe(401);
    expect(sendPushToUser).not.toHaveBeenCalled();
  });
});
