import { describe, it, expect, vi, afterEach } from 'vitest';
import { settleDay, stakeEligible } from '@/lib/stakes/day';

/** settleDay with "every item is old enough" — the common case under test. */
const settleDay0 = (
  items: Parameters<typeof settleDay>[0],
  dateStr: string,
  activation: Parameters<typeof settleDay>[2],
) => settleDay(items, dateStr, activation, () => undefined);
import { parseAmountCents, pledgeAdapter } from '@/lib/stakes/pledge';
import { parseGoalMap, beeminderAdapter } from '@/lib/stakes/beeminder';
import { partnerAdapter } from '@/lib/stakes/partner';
import { formatMoney, nameList, partnerDigest, pledgeSummary } from '@/lib/stakes/copy';
import { settleOneDay } from '@/lib/stakes/settle';
import { daysToSettle } from '@/lib/reminders/scan';
import type { ActivationContext } from '@/lib/active';
import type { Item, Program } from '@dsul/types';
import type { StakeContext } from '@/lib/stakes/types';

vi.mock('@/lib/push-send', () => ({
  sendPushToUser: vi.fn(async () => ({ sent: 1, expired: 0 })),
  isPushConfigured: () => true,
}));

const TZ = 'America/New_York';
const ctx: ActivationContext = { userTimezone: TZ };
const DAY = '2026-08-10';

const habit = (over: Partial<Item> = {}): Item => ({
  type: 'habit', id: 'h1', title: 'Vitamins', project: 'G', streak: 3, status: 'pending',
  completedDates: [], skippedDates: [], dailyCounts: {}, repeatFrequency: 'daily',
  ...over,
} as Item);

const task = (over: Partial<Item> = {}): Item => ({
  type: 'task', id: 't1', title: 'File taxes', status: 'pending', isScheduled: false, order: 0,
  ...over,
} as Item);

const stakeCtx = (over: Partial<StakeContext> = {}): StakeContext => ({
  userId: 'u1', service: {} as never, timezone: TZ, config: {}, secrets: {}, ...over,
});

/* ── settleDay ────────────────────────────────────────────────────────────── */

describe('settleDay', () => {
  it('counts a completed occurrence as a hit', () => {
    const out = settleDay0([habit({ completedDates: [DAY] })], DAY, ctx);
    expect(out.hits.map((i) => i.id)).toEqual(['h1']);
    expect(out.misses).toEqual([]);
  });

  it('counts an untouched occurrence as a miss', () => {
    const out = settleDay0([habit()], DAY, ctx);
    expect(out.misses.map((i) => i.id)).toEqual(['h1']);
  });

  // The three-way split, and the reason it is not two: charging for a skip
  // makes the honest gesture the expensive one, and teaches people to let
  // things lapse silently instead.
  it('counts a skipped occurrence as NEITHER', () => {
    const out = settleDay0([habit({ skippedDates: [DAY] })], DAY, ctx);
    expect(out.hits).toEqual([]);
    expect(out.misses).toEqual([]);
  });

  it('counts a tallied counted habit as a hit', () => {
    const out = settleDay0([habit({ dailyCounts: { [DAY]: 2 } })], DAY, ctx);
    expect(out.hits).toHaveLength(1);
  });

  it('ignores a day the habit does not occur on', () => {
    // 2026-08-15 is a Saturday.
    const out = settleDay0([habit({ repeatFrequency: 'weekdays' })], '2026-08-15', ctx);
    expect(out.hits).toEqual([]);
    expect(out.misses).toEqual([]);
  });

  // Billing someone for a pause would make the pause button cost money.
  it('never charges for a suppressed day', () => {
    const paused = habit({ pausedAt: '2026-08-01T12:00:00Z', pausedUntil: '2026-09-01' });
    expect(settleDay0([paused], DAY, ctx).misses).toEqual([]);
  });

  it('never charges for a day inside a paused program', () => {
    const program = { id: 'p1', name: 'Summer', state: 'paused', itemIds: ['h1'], routineIds: [] } as Program;
    const out = settleDay0([habit()], DAY, { ...ctx, programs: [program] });
    expect(out.misses).toEqual([]);
  });

  // Habits are un-anchored by design, so occursOn says a daily habit occurred
  // on every matching day back to the beginning of time — and settlement looks
  // at YESTERDAY. Without this guard every habit you create is billed for the
  // day before you created it, and with catch-up, for the week before.
  it('never charges for a day that ended before the habit existed', () => {
    const created = (id: string) => (id === 'h1' ? '2026-08-11' : undefined);
    const out = settleDay([habit()], DAY, ctx, created);
    expect(out.misses).toEqual([]);
    expect(out.hits).toEqual([]);
  });

  it('does settle the day the habit was created on', () => {
    const created = () => DAY;
    expect(settleDay([habit()], DAY, ctx, created).misses).toHaveLength(1);
  });

  // A read failure must not forgive a day permanently — the stamp only advances
  // on a clean settlement, so "unknown" has to mean "do not exclude".
  it('treats an unknown creation day as no exclusion', () => {
    expect(settleDay([habit()], DAY, ctx, () => undefined).misses).toHaveLength(1);
  });

  it('leaves tasks out — a stake needs a lapse, and a one-off has none', () => {
    expect(stakeEligible(task({ startDate: DAY }))).toBe(false);
    expect(settleDay0([task({ startDate: DAY })], DAY, ctx).misses).toEqual([]);
  });
});

/* ── Parsing ──────────────────────────────────────────────────────────────── */

describe('parseAmountCents', () => {
  it('reads what people actually type', () => {
    expect(parseAmountCents('10')).toBe(1000);
    expect(parseAmountCents('10.50')).toBe(1050);
    expect(parseAmountCents('£10.50')).toBe(1050);
    expect(parseAmountCents(5)).toBe(500);
  });

  // Money is integer minor units from the first moment. A ledger a penny out is
  // a ledger someone stops believing.
  it('rounds rather than carrying a float', () => {
    expect(parseAmountCents('0.1')).toBe(10);
    expect(parseAmountCents('19.99')).toBe(1999);
    expect(Number.isInteger(parseAmountCents('19.99'))).toBe(true);
  });

  // Stripping a comma as punctuation turns "10,50" into 1050 — a hundredfold
  // overcharge, and the worst thing this function could do quietly.
  it('reads a comma as the decimal separator, not as noise', () => {
    expect(parseAmountCents('10,50')).toBe(1050);
    expect(parseAmountCents('€10,50')).toBe(1050);
    // With a dot present the comma is a thousands separator instead.
    expect(parseAmountCents('1,000.50')).toBe(100050);
  });

  // Every adapter's rows go in ONE claim insert, so an out-of-range amount
  // would wedge that user's whole settlement — partner digest included — on
  // every tick, forever.
  it('refuses an amount that would overflow the ledger column', () => {
    expect(parseAmountCents('99999999999')).toBeNull();
  });

  it('rejects nonsense instead of guessing', () => {
    expect(parseAmountCents('')).toBeNull();
    expect(parseAmountCents('lots')).toBeNull();
    expect(parseAmountCents(undefined)).toBeNull();
  });
});

describe('parseGoalMap', () => {
  it('reads a comma list and matches case-insensitively', () => {
    const map = parseGoalMap('Vitamins: vitamins, Reading: read');
    expect(map.get('vitamins')).toBe('vitamins');
    expect(map.get('reading')).toBe('read');
  });

  it('ignores malformed pairs rather than throwing', () => {
    expect(parseGoalMap('nonsense, : , a:b').get('a')).toBe('b');
    expect(parseGoalMap(undefined).size).toBe(0);
  });

  // A goal slug cannot contain a colon; a habit title very much can.
  it('splits on the last colon, so a colon in the title survives', () => {
    const map = parseGoalMap('Reading: 30 minutes: read30');
    expect(map.get('reading: 30 minutes')).toBe('read30');
  });
});

/* ── Copy ─────────────────────────────────────────────────────────────────── */

describe('stakes copy', () => {
  it('formats money, and survives a currency it does not know', () => {
    expect(formatMoney(1000, 'USD')).toMatch(/10\.00/);
    expect(formatMoney(1050, 'NOTACURRENCY')).toBe('10.50 NOTACURRENCY');
  });

  it('lists names readably', () => {
    expect(nameList(['a'])).toBe('a');
    expect(nameList(['a', 'b'])).toBe('a and b');
    expect(nameList(['a', 'b', 'c'])).toBe('a, b and c');
  });

  it('names the charity, because that is the mechanism', () => {
    const copy = pledgeSummary(
      { dateStr: DAY, hits: [], misses: [habit({ title: 'Reading' })] },
      1000, 'USD', 'a cause I loathe',
    );
    expect(copy.body).toContain('a cause I loathe');
    expect(copy.title).toMatch(/10\.00/);
  });

  // The digest is read by SOMEONE ELSE. The mechanism is "someone is expecting
  // me", not "someone is disappointed in me".
  it('writes the partner digest in the third person, without scolding', () => {
    const digest = partnerDigest(
      { dateStr: DAY, hits: [habit({ title: 'Reading' })], misses: [habit({ id: 'h2', title: 'Stretch' })] },
      'Kirby',
    );
    expect(digest).toContain("Kirby's");
    expect(digest).toContain('1/2 done');
    expect(digest).not.toMatch(/failed|let .* down|should have|disappoint/i);
  });

  it('reports a clean day too, rather than only ever arriving on failure', () => {
    const digest = partnerDigest({ dateStr: DAY, hits: [habit()], misses: [] }, null);
    expect(digest).toContain('Clean sweep');
  });
});

/* ── Adapters ─────────────────────────────────────────────────────────────── */

describe('adapters plan only what they are configured for', () => {
  it('beeminder plans nothing without a goal map', () => {
    const outcome = { dateStr: DAY, hits: [habit()], misses: [] };
    const configured = stakeCtx({ config: { username: 'me' }, secrets: { authToken: 'tok' } });
    expect(beeminderAdapter.plan(outcome, configured)).toEqual([]);
  });

  // Under claim-then-act a PLANNED row is a CLAIMED row, so planning against a
  // half-configured extension burns the day permanently — the retry finds the
  // row already there and commit's "not configured" reads as success.
  it('beeminder plans nothing while its credentials are missing', () => {
    const outcome = { dateStr: DAY, hits: [habit({ title: 'Vitamins' })], misses: [] };
    const goals = { goals: 'Vitamins: vits' };
    expect(beeminderAdapter.plan(outcome, stakeCtx({ config: goals }))).toEqual([]);
    expect(
      beeminderAdapter.plan(outcome, stakeCtx({ config: { ...goals, username: 'me' } })),
    ).toEqual([]);
    expect(
      beeminderAdapter.plan(outcome, stakeCtx({ config: goals, secrets: { authToken: 't' } })),
    ).toEqual([]);
  });

  it('beeminder plans hits only — a miss is the ABSENT datapoint', () => {
    const outcome = { dateStr: DAY, hits: [habit({ title: 'Vitamins' })], misses: [habit({ id: 'h2', title: 'Reading' })] };
    const drafts = beeminderAdapter.plan(
      outcome,
      stakeCtx({
        config: { goals: 'Vitamins: vits, Reading: read', username: 'me' },
        secrets: { authToken: 'tok' },
      }),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ subject: 'h1', kind: 'hit', detail: 'vits' });
  });

  it('pledge plans one miss row per missed habit', () => {
    const outcome = { dateStr: DAY, hits: [], misses: [habit(), habit({ id: 'h2', title: 'Reading' })] };
    const drafts = pledgeAdapter.plan(outcome, stakeCtx({ config: { amount: '10', currency: 'GBP', charity: 'X' } }));
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({ kind: 'miss', amountCents: 1000, currency: 'GBP' });
  });

  it('pledge plans nothing at a zero amount', () => {
    const outcome = { dateStr: DAY, hits: [], misses: [habit()] };
    expect(pledgeAdapter.plan(outcome, stakeCtx({ config: { amount: '0' } }))).toEqual([]);
  });

  it('partner plans one whole-day row, and none on an empty day', () => {
    const configured = stakeCtx({ config: { webhookUrl: 'https://hooks.example.com/x' } });
    expect(partnerAdapter.plan({ dateStr: DAY, hits: [], misses: [] }, configured)).toEqual([]);
    const drafts = partnerAdapter.plan({ dateStr: DAY, hits: [habit()], misses: [] }, configured);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].subject).toBe('day');
  });

  // Empty `claimed` means the day was already settled. A second "you owe £10"
  // for a debt already recorded is how a ledger loses its authority.
  it('every adapter does nothing when nothing was newly claimed', async () => {
    const outcome = { dateStr: DAY, hits: [habit()], misses: [habit({ id: 'h2' })] };
    for (const adapter of [beeminderAdapter, pledgeAdapter, partnerAdapter]) {
      const result = await adapter.commit([], outcome, stakeCtx());
      expect(result, adapter.slug).toMatchObject({ ok: true, skipped: true });
    }
  });
});

/* ── settleOneDay ─────────────────────────────────────────────────────────── */

/**
 * A stand-in for the two statements settleOneDay actually issues: the claim
 * upsert, and the read-back of everything still uncommitted for the day.
 *
 * `pendingRows` is what the read-back answers — which is the interesting knob,
 * because it is how "already settled" (empty) is distinguished from "claimed
 * earlier and never delivered" (non-empty).
 */
function makeService(pendingRows: unknown[], opts: { error?: unknown } = {}) {
  const upserts: unknown[][] = [];
  const commits: unknown[] = [];

  const chain = (result: { data?: unknown; error?: unknown }): Record<string, unknown> =>
    new Proxy({}, {
      get(_t, prop: string) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            Promise.resolve({ data: result.data ?? null, error: result.error ?? null }).then(resolve);
        }
        return () => chain(result);
      },
    });

  const service = {
    from: () => ({
      upsert: (rows: unknown[]) => {
        upserts.push(rows);
        return chain({ error: opts.error ?? null });
      },
      select: () => chain({ data: opts.error ? null : pendingRows, error: null }),
      update: (payload: unknown) => {
        commits.push(payload);
        return chain({ error: null });
      },
    }),
  };
  return { service: service as never, upserts, commits };
}

describe('settleOneDay — claim then act', () => {
  afterEach(() => vi.unstubAllGlobals());

  const base = {
    userId: 'u1',
    dateStr: DAY,
    timezone: TZ,
    items: [habit({ title: 'Reading' })],
    createdOn: () => undefined,
    activation: ctx,
    configs: { pledge: { amount: '10', currency: 'GBP', charity: 'X' } },
    secrets: {},
  };

  it('records the misses it claimed', async () => {
    const { service, upserts } = makeService([{ subject: 'h1', channel: 'pledge' }]);
    const report = await settleOneDay(service, { ...base, extensionEnabled: { pledge: true } });

    expect(report.misses).toBe(1);
    expect(report.notes).toEqual([]);
    expect(upserts[0]).toHaveLength(1);
    expect(upserts[0][0]).toMatchObject({
      user_id: 'u1', date: DAY, subject: 'h1', channel: 'pledge',
      kind: 'miss', amount_cents: 1000, currency: 'GBP',
    });
  });

  // THE property this whole design exists for. The cron can run twice, retry
  // after a timeout, or catch up after an outage; a second run must charge
  // nothing, because the unique index returns no newly-inserted rows.
  it('a second settlement of the same day acts on nothing', async () => {
    const { sendPushToUser } = await import('@/lib/push-send');
    vi.mocked(sendPushToUser).mockClear();

    // Nothing pending: every row for this day already has a committed_at.
    const { service } = makeService([]);
    const report = await settleOneDay(service, { ...base, extensionEnabled: { pledge: true } });

    expect(report.notes).toEqual([]);
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  // Nothing was claimed, so nothing may be acted on — and the day must NOT be
  // stamped, so the next tick tries again.
  it('a failed claim acts on nothing and reports it', async () => {
    const { sendPushToUser } = await import('@/lib/push-send');
    vi.mocked(sendPushToUser).mockClear();

    const { service } = makeService([], { error: { message: 'deadlock' } });
    const report = await settleOneDay(service, { ...base, extensionEnabled: { pledge: true } });

    expect(report.notes.join()).toMatch(/claim failed/);
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  // Claiming alone is a trap: a retry finds the row already there and does
  // nothing, so an adapter whose commit failed once would never be retried and
  // the day would be stamped settled with the digest never sent. committed_at
  // is what separates "recorded" from "done".
  it('retries a row that was claimed earlier and never delivered', async () => {
    const { sendPushToUser } = await import('@/lib/push-send');
    vi.mocked(sendPushToUser).mockClear();

    // The upsert inserts nothing new (already claimed), but the row is still
    // uncommitted — so it is owed, and must go out.
    const { service, commits } = makeService([{ subject: 'h1', channel: 'pledge' }]);
    const report = await settleOneDay(service, { ...base, extensionEnabled: { pledge: true } });

    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    expect(report.notes).toEqual([]);
    // …and it is marked done, so the NEXT tick leaves it alone.
    expect(commits[0]).toHaveProperty('committed_at');
  });

  it('leaves a failed row uncommitted, and says so, so the day is not stamped', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const { service, commits } = makeService([{ subject: 'day', channel: 'accountability-partner' }]);

    const report = await settleOneDay(service, {
      ...base,
      extensionEnabled: { 'accountability-partner': true },
      configs: { 'accountability-partner': { webhookUrl: 'https://hooks.example.com/x' } },
    });

    expect(report.notes.join()).toMatch(/accountability-partner/);
    expect(commits).toEqual([]);
  });

  it('does nothing at all when no stake extension is on', async () => {
    const { service, upserts } = makeService([]);
    const report = await settleOneDay(service, { ...base, extensionEnabled: {} });
    expect(upserts).toEqual([]);
    expect(report.misses).toBe(1); // still reported, just not acted on
  });

  it('one adapter throwing does not stop the others', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const { service } = makeService([
      { subject: 'h1', channel: 'pledge' },
      { subject: 'day', channel: 'accountability-partner' },
    ]);

    const report = await settleOneDay(service, {
      ...base,
      extensionEnabled: { pledge: true, 'accountability-partner': true },
      configs: {
        ...base.configs,
        'accountability-partner': { webhookUrl: 'https://hooks.example.com/x' },
      },
    });

    // The partner webhook failed; the pledge still recorded and pushed.
    expect(report.notes.join()).toMatch(/accountability-partner/);
    expect(report.misses).toBe(1);
  });
});

/* ── Catch-up ─────────────────────────────────────────────────────────────── */

describe('daysToSettle', () => {
  it('settles yesterday on a first run', () => {
    expect(daysToSettle('2026-08-10', null)).toEqual(['2026-08-09']);
  });

  it('settles nothing when yesterday is already done', () => {
    expect(daysToSettle('2026-08-10', '2026-08-09')).toEqual([]);
  });

  // A day skipped is a day silently forgiven, which a commitment device must
  // not do.
  it('catches up a gap', () => {
    expect(daysToSettle('2026-08-10', '2026-08-06')).toEqual([
      '2026-08-07', '2026-08-08', '2026-08-09',
    ]);
  });

  // …but a first-time user must not be handed a bill for months they never
  // agreed to, so the window is capped and takes the MOST RECENT days.
  it('caps a long gap at the most recent week', () => {
    const days = daysToSettle('2026-08-10', '2025-01-01');
    expect(days).toHaveLength(7);
    expect(days[days.length - 1]).toBe('2026-08-09');
    expect(days[0]).toBe('2026-08-03');
  });

  it('never settles today, however stale the stamp', () => {
    for (const stamp of [null, '2026-08-01', '2026-08-09']) {
      expect(daysToSettle('2026-08-10', stamp)).not.toContain('2026-08-10');
    }
  });
});

describe('birthDays (a type switch is a second birth)', () => {
  it('moves an item’s birth to its latest type switch, and ignores switches for unknown items', async () => {
    const { birthDays } = await import('@/lib/reminders/scan')
    const days = birthDays(
      [{ id: 'a', created_at: '2026-05-01T12:00:00Z' }, { id: 'b', created_at: '2026-09-01T12:00:00Z' }],
      [
        { item_id: 'a', created_at: '2026-09-20T12:00:00Z' },
        { item_id: 'a', created_at: '2026-09-25T12:00:00Z' },
        { item_id: 'ghost', created_at: '2026-09-25T12:00:00Z' },
      ],
      'UTC',
    )
    expect(days.get('a')).toBe('2026-09-25')
    expect(days.get('b')).toBe('2026-09-01')
    expect(days.has('ghost')).toBe(false)
  })
})
