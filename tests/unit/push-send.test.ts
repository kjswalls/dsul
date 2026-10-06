import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* ── Mocks ────────────────────────────────────────────────────────────────── */

// web-push is the one thing here that leaves the process. Everything this file
// pins is what push-send makes of its answers: which count each status lands
// in, which rows are pruned, and that nothing it hears becomes a throw.
const sendNotification = vi.fn();
const setVapidDetails = vi.fn();
vi.mock('web-push', () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotification(...args),
    setVapidDetails: (...args: unknown[]) => setVapidDetails(...args),
  },
}));

import { DEFAULT_TTL_S, sendPushToUser, sendWebPush } from '@/lib/push-send';
import { makeServiceFake } from './support/service-fake';

/** web-push's rejection for a non-2xx answer: a WebPushError carrying the status. */
const answered = (statusCode: number) =>
  Object.assign(new Error('Received unexpected response code'), { statusCode });

const row = (n: number) => ({ endpoint: `https://push.example/${n}`, p256dh: `p256dh-${n}`, auth: `auth-${n}` });

/**
 * One subscription per status, in order, and a push service that gives each
 * endpoint its own answer — so a count can never be right by accident of
 * which device happened to be asked first.
 */
function devicesAnswering(...statuses: number[]) {
  const rows = statuses.map((_, i) => row(i + 1));
  const byEndpoint = new Map(rows.map((r, i) => [r.endpoint, statuses[i]]));
  sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
    const status = byEndpoint.get(sub.endpoint)!;
    if (status >= 300) throw answered(status);
    return { statusCode: status, body: '', headers: {} };
  });
  return rows;
}

const PAYLOAD = { title: 'Vitamins', body: 'you pour your coffee', tag: 'dsul-item-h1' };

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'test-public');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'test-private');
  sendNotification.mockReset();
  setVapidDetails.mockReset();
});

afterEach(() => vi.unstubAllEnvs());

/* ── sendPushToUser ───────────────────────────────────────────────────────── */

describe('sendPushToUser', () => {
  it('counts every device by what its push service answered', async () => {
    const rows = devicesAnswering(201, 410, 429, 403);
    const { service } = makeServiceFake({ 'push_subscriptions.select': { data: rows } });

    const result = await sendPushToUser(service, 'u1', PAYLOAD);

    expect(result).toEqual({ devices: 4, sent: 1, expired: 1, failed: 2 });
    expect(sendNotification).toHaveBeenCalledTimes(4);
  });

  it('reads only this user\'s subscriptions', async () => {
    const { service, calls } = makeServiceFake({ 'push_subscriptions.select': { data: [] } });
    await sendPushToUser(service, 'u1', PAYLOAD);
    const read = calls.find((c) => c.table === 'push_subscriptions' && c.op === 'select');
    expect(read?.filters).toContainEqual(['eq', ['user_id', 'u1']]);
  });

  // push_subscriptions is unique on (user_id, endpoint), so two accounts in one
  // browser profile hold the same endpoint string. An unscoped delete would
  // sign the OTHER account out of notifications.
  it('prunes a 410 or a 404, scoped to this user', async () => {
    const rows = devicesAnswering(201, 410, 404);
    const { service, writes } = makeServiceFake({ 'push_subscriptions.select': { data: rows } });

    await sendPushToUser(service, 'u1', PAYLOAD);

    expect(writes()).toHaveLength(1);
    const [prune] = writes();
    expect(prune).toMatchObject({ table: 'push_subscriptions', op: 'delete' });
    expect(prune.filters).toEqual([
      ['eq', ['user_id', 'u1']],
      ['in', ['endpoint', [rows[1].endpoint, rows[2].endpoint]]],
    ]);
  });

  // A refused VAPID key is OUR fault and every subscription fails with it at
  // once. Pruning on it would delete them all on the first tick after a bad
  // deploy, and only the user's own browser can subscribe again.
  it('never prunes a 403, a 401, a 429 or a 5xx', async () => {
    const rows = devicesAnswering(403, 401, 429, 503);
    const { service, writes } = makeServiceFake({ 'push_subscriptions.select': { data: rows } });

    const result = await sendPushToUser(service, 'u1', PAYLOAD);

    expect(result).toEqual({ devices: 4, sent: 0, expired: 0, failed: 4 });
    expect(writes()).toHaveLength(0);
  });

  it('answers zeros, without a detail, when the user has no device', async () => {
    const { service } = makeServiceFake({ 'push_subscriptions.select': { data: [] } });
    const result = await sendPushToUser(service, 'u1', PAYLOAD);
    expect(result).toStrictEqual({ devices: 0, sent: 0, expired: 0, failed: 0 });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  // "Push is off", not "the scan 500s for every user" — and not a read the
  // deployment could never act on either.
  it('answers zeros and reads nothing when VAPID is not configured', async () => {
    vi.stubEnv('VAPID_PRIVATE_KEY', '');
    const { service, calls } = makeServiceFake({ 'push_subscriptions.select': { data: [row(1)] } });

    const result = await sendPushToUser(service, 'u1', PAYLOAD);

    expect(result).toStrictEqual({ devices: 0, sent: 0, expired: 0, failed: 0 });
    expect(calls).toHaveLength(0);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  // It used to throw, and only deliverNudge's allSettled caught it. The zero it
  // answers instead carries a detail, so no caller mistakes it for "no device".
  it('answers a read error with zeros and a detail, and never rejects', async () => {
    const { service } = makeServiceFake({ 'push_subscriptions.select': { error: { message: 'connection reset' } } });

    await expect(sendPushToUser(service, 'u1', PAYLOAD)).resolves.toEqual({
      devices: 0,
      sent: 0,
      expired: 0,
      failed: 0,
      detail: 'read failed: connection reset',
    });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('answers a read that REJECTS the same way', async () => {
    const { service } = makeServiceFake(() => {
      throw new Error('fetch failed');
    });

    await expect(sendPushToUser(service, 'u1', PAYLOAD)).resolves.toMatchObject({
      devices: 0,
      sent: 0,
      detail: 'read failed: fetch failed',
    });
  });

  // Every device gets the same headers for the same push, and none of them
  // finds a header in what its service worker decrypts.
  it('sends the delivery fields to every device as options, never in the body', async () => {
    const rows = devicesAnswering(201, 201);
    const { service } = makeServiceFake({ 'push_subscriptions.select': { data: rows } });

    await sendPushToUser(service, 'u1', { ...PAYLOAD, ttl: 1800, urgency: 'high', topic: 'h1' });

    expect(sendNotification).toHaveBeenCalledTimes(2);
    for (const [, body, options] of sendNotification.mock.calls) {
      expect(options).toEqual({ TTL: 1800, urgency: 'high', topic: 'h1' });
      expect(JSON.parse(body as string)).toEqual(PAYLOAD);
    }
  });

  it('keeps its counts when the prune itself rejects', async () => {
    const rows = devicesAnswering(201, 410);
    const { service } = makeServiceFake((call) => {
      if (call.op === 'delete') throw new Error('prune refused');
      return { data: rows };
    });

    await expect(sendPushToUser(service, 'u1', PAYLOAD)).resolves.toEqual({
      devices: 2,
      sent: 1,
      expired: 1,
      failed: 0,
    });
  });
});

/* ── sendWebPush ──────────────────────────────────────────────────────────── */

describe('sendWebPush', () => {
  const target = { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } };

  /** The [body, options] web-push was handed for the one push sent. */
  const sentAs = () => {
    const [, body, options] = sendNotification.mock.calls[0];
    return { body: JSON.parse(body as string) as Record<string, unknown>, options };
  };

  beforeEach(() => {
    sendNotification.mockResolvedValue({ statusCode: 201, body: '', headers: {} });
  });

  it('sends the payload as the body, to the subscription it was given', async () => {
    const result = await sendWebPush(target, PAYLOAD);

    expect(result).toEqual({ outcome: 'sent', status: 201 });
    const [sub] = sendNotification.mock.calls[0];
    expect(sub).toEqual(target);
    expect(sentAs().body).toEqual(PAYLOAD);
  });

  // RFC 8030's TTL, Urgency and Topic are request headers. In the body they
  // would be text the service worker shows nobody, and no push service would
  // ever act on them.
  it('carries ttl, urgency and topic as web-push options, and strips them from the body', async () => {
    await sendWebPush(target, { ...PAYLOAD, ttl: 1800, urgency: 'high', topic: '6f1c2b0e8d4a4c3e9b7a2f5d1e0c9a8b' });

    const { body, options } = sentAs();
    expect(options).toEqual({ TTL: 1800, urgency: 'high', topic: '6f1c2b0e8d4a4c3e9b7a2f5d1e0c9a8b' });
    expect(body).toEqual(PAYLOAD);
    expect(body).not.toHaveProperty('ttl');
    expect(body).not.toHaveProperty('urgency');
    expect(body).not.toHaveProperty('topic');
  });

  // web-push's own default is four weeks (DEFAULT_TTL = 2419200): a phone left
  // in a drawer would wake next month to a push that reads as news.
  it('names a six-hour TTL when the payload names none, and no urgency or topic', async () => {
    await sendWebPush(target, PAYLOAD);
    expect(DEFAULT_TTL_S).toBe(21600);
    expect(sentAs().options).toStrictEqual({ TTL: DEFAULT_TTL_S });
  });

  // web-push THROWS on a topic outside the URL-safe alphabet or over 32
  // characters, and inside sendWebPush that would be a failed send to every
  // device. A topic that cannot go costs the queue its collapse, nothing more.
  it.each([
    ['a character outside the alphabet', 'dsul:item'],
    ['more than 32 characters', 'x'.repeat(33)],
    ['an empty string', ''],
  ])('leaves off a topic with %s, and still sends', async (_label, topic) => {
    const result = await sendWebPush(target, { ...PAYLOAD, topic });
    expect(result.outcome).toBe('sent');
    expect(sentAs().options).not.toHaveProperty('topic');
  });

  it('sends a TTL whose moment has passed as 0, and one that is not a number as the default', async () => {
    await sendWebPush(target, { ...PAYLOAD, ttl: -30 });
    await sendWebPush(target, { ...PAYLOAD, ttl: Number.NaN });
    await sendWebPush(target, { ...PAYLOAD, ttl: 599.7 });
    expect(sendNotification.mock.calls.map(([, , options]) => (options as { TTL: number }).TTL)).toEqual([
      0,
      DEFAULT_TTL_S,
      599,
    ]);
  });

  it.each([
    [404, 'expired', 'gone (404)'],
    [410, 'expired', 'gone (410)'],
    [401, 'failed', 'vapid rejected'],
    [403, 'failed', 'vapid rejected'],
    [429, 'failed', 'push service answered 429'],
    [500, 'failed', 'push service answered 500'],
    [503, 'failed', 'push service answered 503'],
  ])('classifies a %i as %s', async (status, outcome, detail) => {
    sendNotification.mockRejectedValue(answered(status));
    await expect(sendWebPush(target, PAYLOAD)).resolves.toEqual({ outcome, status, detail });
  });

  it('calls a network error failed, with its message, rather than throwing it', async () => {
    sendNotification.mockRejectedValue(new Error('getaddrinfo ENOTFOUND push.example'));
    await expect(sendWebPush(target, PAYLOAD)).resolves.toEqual({
      outcome: 'failed',
      detail: 'getaddrinfo ENOTFOUND push.example',
    });
  });

  it('fails without sending when VAPID is not configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', '');
    await expect(sendWebPush(target, PAYLOAD)).resolves.toEqual({
      outcome: 'failed',
      detail: 'push not configured',
    });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  // setVapidDetails throws on a key it cannot decode — the `""` a Sensitive
  // variable pulls down as, or a truncated paste. A key that cannot be used is
  // a failed send, not a crashed caller. A fresh module, because the key is
  // configured once per process and an earlier test already did it.
  it('fails rather than throws when the VAPID key is malformed', async () => {
    vi.resetModules();
    const { sendWebPush: fresh } = await import('@/lib/push-send');
    setVapidDetails.mockImplementation(() => {
      throw new Error('Vapid public key should be 65 bytes long when decoded.');
    });

    await expect(fresh(target, PAYLOAD)).resolves.toEqual({
      outcome: 'failed',
      detail: 'Vapid public key should be 65 bytes long when decoded.',
    });
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
