import { describe, expect, it, vi } from 'vitest';
import { makeServiceFake, OUTSIDE, type FakeCall } from './support/service-fake';
import { sendWakes, wakeOwed, WAKE_COLUMNS, WAKE_THROTTLE_MS, type WakeRow, type WakeSender } from '@/lib/devices/wake';
import type { TransportOutcome } from '@/lib/devices/types';

/**
 * sendWakes (lib/devices/wake.ts, migration 076): one silent push to each
 * iPhone whose items changed elsewhere, at most one per phone per 30 minutes,
 * claimed before it is sent.
 */

const NOW = Date.parse('2026-10-15T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

const row = (n: number, extra: Partial<WakeRow> = {}): WakeRow => ({
  id: `row-${n}`,
  user_id: 'u1',
  token: 'ab'.repeat(32),
  apns_environment: 'production',
  registered_at: '2026-10-01T00:00:00Z',
  wake_requested_at: iso(NOW - 2 * MIN),
  last_background_push_at: null,
  ...extra,
});

function setup(rows: WakeRow[], outcomes: TransportOutcome[] = [], claimed: (call: FakeCall) => boolean = () => true) {
  const fake = makeServiceFake((call) => {
    if (call.table !== 'devices') return undefined;
    if (call.op === 'select') return { data: rows };
    if (call.op === 'update' && 'last_background_push_at' in (call.payload as object)) {
      return { data: claimed(call) ? [{ id: 'x' }] : [] };
    }
    return undefined;
  });
  const sender: WakeSender = {
    available: () => true,
    wake: vi.fn(async (device) => {
      fake.mark('wake', (device as WakeRow).id);
      return outcomes.shift() ?? { ok: true };
    }),
  };
  return { fake, sender };
}

describe('wakeOwed', () => {
  it('is owed when asked for and never pushed', () => {
    expect(wakeOwed({ wake_requested_at: iso(NOW), last_background_push_at: null }, NOW)).toBe(true);
  });

  it('waits out the 30 minutes after the last push, then sends what was asked for inside them', () => {
    const last = NOW - 10 * MIN;
    const asked = { wake_requested_at: iso(NOW - 5 * MIN), last_background_push_at: iso(last) };
    expect(wakeOwed(asked, NOW)).toBe(false);
    expect(wakeOwed(asked, last + WAKE_THROTTLE_MS)).toBe(true);
  });

  it('is not owed when nothing was asked for since the last push', () => {
    expect(wakeOwed({ wake_requested_at: iso(NOW - 40 * MIN), last_background_push_at: iso(NOW - 35 * MIN) }, NOW)).toBe(false);
    expect(wakeOwed({ wake_requested_at: null, last_background_push_at: null }, NOW)).toBe(false);
  });
});

describe('sendWakes', () => {
  it('reads nothing when APNs is not configured', async () => {
    const fake = makeServiceFake();
    const summary = await sendWakes(fake.service, { nowMs: NOW, sender: { available: () => false, wake: vi.fn() } });
    expect(fake.calls).toEqual([]);
    expect(summary).toMatchObject({ asked: 0, sent: 0 });
  });

  it('reads the apns rows with a wake asked for', async () => {
    const { fake, sender } = setup([]);
    await sendWakes(fake.service, { nowMs: NOW, sender });
    expect(fake.calls[0]).toMatchObject({ table: 'devices', op: 'select', payload: WAKE_COLUMNS });
    expect(fake.calls[0].filters.slice(0, 2)).toEqual([
      ['eq', ['transport', 'apns']],
      ['not', ['wake_requested_at', 'is', null]],
    ]);
  });

  it('claims each owed row, naming the stamp it read, before it sends', async () => {
    const last = iso(NOW - 45 * MIN);
    const { fake, sender } = setup([row(1), row(2, { last_background_push_at: last, wake_requested_at: iso(NOW - MIN) })]);
    const summary = await sendWakes(fake.service, { nowMs: NOW, sender });
    expect(summary).toMatchObject({ asked: 2, sent: 2, waiting: 0, failed: 0, pruned: 0 });

    const claims = fake.calls.filter((c) => c.op === 'update');
    expect(claims.map((c) => c.payload)).toEqual([{ last_background_push_at: iso(NOW) }, { last_background_push_at: iso(NOW) }]);
    expect(claims[0].filters).toEqual([
      ['eq', ['id', 'row-1']],
      ['is', ['last_background_push_at', null]],
      ['select', ['id']],
    ]);
    expect(claims[1].filters).toEqual([
      ['eq', ['id', 'row-2']],
      ['eq', ['last_background_push_at', last]],
      ['select', ['id']],
    ]);
    for (const id of ['row-1', 'row-2']) {
      const claim = fake.calls.findIndex((c) => c.op === 'update' && c.filters[0][1][1] === id);
      const sent = fake.calls.findIndex((c) => c.table === OUTSIDE && c.payload === id);
      expect(claim).toBeGreaterThanOrEqual(0);
      expect(claim).toBeLessThan(sent);
    }
  });

  it('sends nothing for a row inside its 30 minutes, or one another tick claimed first', async () => {
    const { fake, sender } = setup(
      [row(1, { last_background_push_at: iso(NOW - 10 * MIN) }), row(2)],
      [],
      () => false,
    );
    const summary = await sendWakes(fake.service, { nowMs: NOW, sender });
    expect(sender.wake).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ asked: 2, sent: 0, waiting: 2 });
    // The waiting row is not even claimed.
    expect(fake.writes()).toHaveLength(1);
  });

  it('prunes a row whose token Apple calls gone, and records any other failure', async () => {
    const { fake, sender } = setup(
      [row(1), row(2)],
      [
        { ok: false, terminal: true, code: 'bad_device_token' },
        { ok: false, terminal: false, code: 'provider_token_rejected' },
      ],
    );
    const summary = await sendWakes(fake.service, { nowMs: NOW, sender });
    expect(summary).toMatchObject({ sent: 0, failed: 1, pruned: 1 });
    const after = fake.writes().filter((c) => !(c.op === 'update' && 'last_background_push_at' in (c.payload as object)));
    expect(after).toEqual([
      expect.objectContaining({ op: 'delete', filters: [['eq', ['id', 'row-1']]] }),
      expect.objectContaining({ op: 'update', payload: { last_failure: 'provider_token_rejected' }, filters: [['eq', ['id', 'row-2']]] }),
    ]);
  });

  it('is quiet until 076 is applied, and says so when the read fails otherwise', async () => {
    const sender = { available: () => true, wake: vi.fn() };
    const missing = makeServiceFake({ 'devices.select': { error: { code: '42703', message: 'column does not exist' } } });
    expect(await sendWakes(missing.service, { nowMs: NOW, sender })).toEqual({
      asked: 0, sent: 0, waiting: 0, failed: 0, pruned: 0, notes: [],
    });
    const broken = makeServiceFake({ 'devices.select': { error: { code: '57014', message: 'timeout' } } });
    expect((await sendWakes(broken.service, { nowMs: NOW, sender })).notes).toEqual(['read failed: timeout']);
    expect(sender.wake).not.toHaveBeenCalled();
  });
});
