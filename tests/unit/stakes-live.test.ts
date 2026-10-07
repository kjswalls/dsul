import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reportLiveCompletion, stakeEligibleRow } from '@/lib/stakes/live';
import { decodeDetail, encodeDetail, datapointIdFrom } from '@/lib/stakes/beeminder';
import { makeServiceFake } from './support/service-fake';

/**
 * The shared fake, answering the way the live path needs.
 *
 * Every read is a table → result lookup and every write is recorded, which is
 * what the assertions below are actually about: this feature's correctness is
 * almost entirely about WHICH writes happen and in what order, not about what
 * PostgREST returns.
 */
function makeService(tables: Record<string, unknown>, vanished = false) {
  // The ledger row the code reads back after its own claim. Modelled, because
  // read-after-claim is the step the whole idempotency story turns on: a stub
  // that always answered "no row" would make every post look like a lost claim.
  let ledgerRow: unknown = tables.stake_events ?? null;

  return makeServiceFake((call) => {
    switch (call.op) {
      case 'select':
        return { data: call.table === 'stake_events' ? ledgerRow : (tables[call.table] ?? null) };
      case 'upsert':
        if (!ledgerRow) {
          const first = (call.payload as Record<string, unknown>[])[0];
          ledgerRow = { id: 'e1', detail: first.detail, committed_at: null };
        }
        return {};
      case 'update':
        // The stamp reads back its own row, so the code can tell "updated" from
        // "the row is gone". `vanished` models the row being deleted underneath.
        return { data: vanished ? [] : [{ id: 'e1' }] };
      default:
        return {};
    }
  });
}

const DAY = '2026-08-10';

/** Everything switched on and correctly configured — the happy path. */
const configured = (over: Record<string, unknown> = {}) => ({
  user_settings: { stakes_enabled: true, timezone: 'America/New_York' },
  user_extensions: [{ slug: 'beeminder', enabled: true, config: { username: 'kirby', goals: 'Vitamins: vits' } }],
  user_secrets: { reminder_secrets: { beeminder: { authToken: 'tok' } } },
  items: {
    id: 'h1', type: 'habit', title: 'Vitamins', parent_item_id: null, completed_dates: [DAY],
  },
  ...over,
});

const input = { userId: 'u1', itemId: 'h1', dateStr: DAY, completed: true };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'dp-1' }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('stakeEligibleRow', () => {
  it('accepts a streak-bearing type', () => {
    expect(stakeEligibleRow('habit', null)).toBe(true);
  });

  // A dated one-off has no lapse to denominate a stake in — the same rule
  // stakeEligible() applies to hydrated items.
  it('refuses a task', () => {
    expect(stakeEligibleRow('task', null)).toBe(false);
  });

  it('refuses a subtask whatever its type', () => {
    expect(stakeEligibleRow('habit', 'parent-1')).toBe(false);
  });
});

describe('reportLiveCompletion — posting', () => {
  it('claims the ledger row, posts, and stamps the datapoint id', async () => {
    const { service, writes } = makeService(configured());
    const result = await reportLiveCompletion(service, input);

    expect(result).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const claim = writes().find((w) => w.op === 'upsert');
    expect((claim?.payload as Record<string, unknown>[])[0]).toMatchObject({
      user_id: 'u1', date: DAY, subject: 'h1', channel: 'beeminder', kind: 'hit', detail: 'vits',
    });

    const stamp = writes().find((w) => w.op === 'update')?.payload as Record<string, unknown>;
    expect(stamp.detail).toBe('vits#dp-1');
    expect(stamp.committed_at).toEqual(expect.any(String));
  });

  it('sends the day as the daystamp, not today', async () => {
    const { service } = makeService(configured());
    await reportLiveCompletion(service, input);
    const body = String(fetchMock.mock.calls[0][1].body);
    expect(body).toContain('daystamp=20260810');
    expect(body).toContain('requestid=dsul-2026-08-10-h1');
  });

  // Claim-then-act: a row somebody already committed is a datapoint already up.
  it('posts nothing when the row is already committed', async () => {
    const { service } = makeService(
      configured({ stake_events: { id: 'e1', detail: 'vits#dp-9', committed_at: '2026-08-11T03:00:00Z' } }),
    );
    const result = await reportLiveCompletion(service, input);
    expect(result).toMatchObject({ ok: true, skipped: true, detail: 'already posted' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('reportLiveCompletion — the gates', () => {
  const refuses = async (tables: Record<string, unknown>, detail: string) => {
    const { service, writes } = makeService(configured(tables));
    const result = await reportLiveCompletion(service, input);
    expect(result).toMatchObject({ ok: true, skipped: true, detail });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  };

  // The master switch is read from the DATABASE, not from the caller's claim —
  // an extension that kept posting while "Settle the day" was off would make
  // that switch a control that visibly does nothing.
  it('refuses when stakes are off', () =>
    refuses({ user_settings: { stakes_enabled: false, timezone: 'UTC' } }, 'stakes off'));

  it('refuses when the extension is off', () =>
    refuses({ user_extensions: [{ slug: 'beeminder', enabled: false, config: {} }] }, 'beeminder off'));

  it('refuses when the credentials are missing', () =>
    refuses({ user_secrets: { reminder_secrets: {} } }, 'beeminder not configured'));

  it('refuses a title with no goal mapped to it', () =>
    refuses(
      { items: { id: 'h1', type: 'habit', title: 'Unmapped', parent_item_id: null, completed_dates: [DAY] } },
      'title not mapped to a goal',
    ));

  it('refuses a type that carries no streak', () =>
    refuses(
      { items: { id: 'h1', type: 'task', title: 'Vitamins', parent_item_id: null, completed_dates: [DAY] } },
      'type not staked',
    ));

  // The database decides whether the day is complete, not the caller's flag.
  it('refuses when the completion did not actually land', () =>
    refuses(
      { items: { id: 'h1', type: 'habit', title: 'Vitamins', parent_item_id: null, completed_dates: [] } },
      'completion state moved on',
    ));

  // A goal satisfied a day early is a goal that did not do its job.
  it('refuses a date in the future', async () => {
    const { service, writes } = makeService(configured());
    const result = await reportLiveCompletion(service, { ...input, dateStr: '2999-01-01' });
    expect(result).toMatchObject({ skipped: true, detail: 'future date' });
    expect(writes()).toEqual([]);
  });

  it('refuses an item that is not this user’s', () =>
    refuses({ items: null }, 'no such item'));
});

describe('reportLiveCompletion — retraction', () => {
  const unticked = { ...input, completed: false };
  const notDone = {
    items: { id: 'h1', type: 'habit', title: 'Vitamins', parent_item_id: null, completed_dates: [] },
  };

  it('withdraws the datapoint and drops the ledger row', async () => {
    const { service, writes } = makeService(
      configured({
        ...notDone,
        stake_events: { id: 'e1', detail: 'vits#dp-1', committed_at: '2026-08-10T12:00:00Z' },
      }),
    );
    const result = await reportLiveCompletion(service, unticked);

    expect(result).toMatchObject({ ok: true, detail: 'datapoint withdrawn' });
    expect(fetchMock.mock.calls[0][0]).toContain('/datapoints/dp-1.json');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
    expect(writes().map((w) => w.op)).toEqual(['delete']);
  });

  // The row IS the claim on the datapoint, so releasing an uncommitted claim
  // must not call Beeminder at all — there is nothing up there to withdraw.
  it('releases an uncommitted claim without calling Beeminder', async () => {
    const { service, writes } = makeService(
      configured({ ...notDone, stake_events: { id: 'e1', detail: 'vits', committed_at: null } }),
    );
    const result = await reportLiveCompletion(service, unticked);

    expect(result).toMatchObject({ ok: true, detail: 'claim released' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writes().map((w) => w.op)).toEqual(['delete']);
  });

  // Says what is true rather than reporting a retraction that did not happen.
  it('admits it when the datapoint id was never recorded', async () => {
    const { service } = makeService(
      configured({ ...notDone, stake_events: { id: 'e1', detail: 'vits', committed_at: '2026-08-10T12:00:00Z' } }),
    );
    const result = await reportLiveCompletion(service, unticked);
    expect(result.detail).toMatch(/not withdrawn/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing when there is no row', async () => {
    const { service, writes } = makeService(configured({ ...notDone, stake_events: null }));
    const result = await reportLiveCompletion(service, unticked);
    expect(result).toMatchObject({ skipped: true, detail: 'nothing posted' });
    expect(writes()).toEqual([]);
  });
});

describe('reportLiveCompletion — the tick/un-tick race', () => {
  // A tick and an un-tick in the same second: the retraction reads the
  // uncommitted claim and deletes it while the post is in flight. Left alone,
  // that strands a datapoint on the graph with no row pointing at it — and the
  // settlement will never re-claim a day the user un-ticked, so nothing would
  // ever withdraw it.
  it('withdraws a datapoint whose claim was released mid-post', async () => {
    const { service } = makeService(configured(), true);
    const result = await reportLiveCompletion(service, input);

    expect(result.detail).toMatch(/claim released mid-post/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].method).toBe('DELETE');
    expect(fetchMock.mock.calls[1][0]).toContain('/datapoints/dp-1.json');
  });

  it('says so, rather than claiming a retraction, when it has no id to withdraw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>ok</html>', { status: 200 })));
    const { service } = makeService(configured(), true);
    const result = await reportLiveCompletion(service, input);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/left in place/);
  });
});

describe('reportLiveCompletion — failure', () => {
  // Never throws: every caller is a side path hanging off a write that already
  // succeeded, and a Beeminder outage must not surface as a failed checkbox.
  it('reports a network failure instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const { service } = makeService(configured());
    const result = await reportLiveCompletion(service, input);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/network down/);
  });

  it('reports a bad date rather than posting anything', async () => {
    const { service, writes } = makeService(configured());
    const result = await reportLiveCompletion(service, { ...input, dateStr: 'yesterday' });
    expect(result).toMatchObject({ skipped: true, detail: 'bad date' });
    expect(writes()).toEqual([]);
  });
});

describe('the ledger detail encoding', () => {
  it('round-trips a goal and its datapoint id', () => {
    expect(decodeDetail(encodeDetail('vits', 'dp-1'))).toEqual({ goal: 'vits', datapointId: 'dp-1' });
  });

  // Rows written before the id existed must still yield the right goal.
  it('reads a bare goal as having no datapoint', () => {
    expect(decodeDetail('vits')).toEqual({ goal: 'vits', datapointId: null });
  });

  it('is empty for a null detail', () => {
    expect(decodeDetail(null)).toEqual({ goal: null, datapointId: null });
  });

  it('takes the id from a numeric response', () => {
    expect(datapointIdFrom(JSON.stringify({ id: 12345 }))).toBe('12345');
  });

  // A 2xx with a body we cannot read still means the datapoint is up.
  it('answers null on an unreadable body rather than throwing', () => {
    expect(datapointIdFrom('<html>ok</html>')).toBeNull();
  });
});
