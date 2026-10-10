import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

/**
 * GET /api/cron/reminders — auth, a clock, one log line and a JSON summary.
 *
 * Its status codes are its monitoring. pg_net calls it, never retries, and
 * keeps each response for six hours, so a 5xx in net._http_response is the
 * cheapest alarm there is. That only works while a 500 means one thing: the
 * scan could not start (memory/plans/reminders-platforms.md §7, decision 7).
 * A tick that reached some users and not others is a 200 with notes.
 */

const runReminderScan = vi.fn();
vi.mock('@/lib/reminders/scan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reminders/scan')>();
  return { ...actual, runReminderScan: (...args: unknown[]) => runReminderScan(...args) };
});

const runRecipeTick = vi.fn();
vi.mock('@/lib/recipes/server', () => ({ runRecipeTick: (...args: unknown[]) => runRecipeTick(...args) }));

const SERVICE = { stand: 'in for the service client' };
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => SERVICE }));

import { GET, maxDuration } from '@/app/api/cron/reminders/route';
import { ReminderScanError, type ScanSummary } from '@/lib/reminders/scan';

const SECRET = 'tick-secret';

const get = (authorization?: string) =>
  GET(
    new Request(
      'https://do.dsul.app/api/cron/reminders',
      authorization === undefined ? {} : { headers: { authorization } },
    ) as unknown as NextRequest,
  );

const summary = (over: Partial<ScanSummary> = {}): ScanSummary => ({
  users: 2,
  cues: 3,
  lastCalls: 1,
  eod: 1,
  unreached: 1,
  daysSettled: 0,
  notes: [],
  ...over,
});

const RECIPES = { users: 1, runs: 2, notes: [] as string[] };

let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET);
  runReminderScan.mockReset();
  runReminderScan.mockResolvedValue(summary());
  runRecipeTick.mockReset();
  runRecipeTick.mockResolvedValue(RECIPES);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('GET /api/cron/reminders', () => {
  // A cue CLAIMED but not delivered is lost for the day, and the default
  // serverless budget is short enough for one dead Home Assistant to end the
  // invocation partway through the fan-out.
  it('asks for sixty seconds', () => {
    expect(maxDuration).toBe(60);
  });

  it('runs the gate before the scan: no secret, no scan', async () => {
    const res = await get();
    expect(res.status).toBe(401);
    expect(runReminderScan).not.toHaveBeenCalled();
  });

  it('a missing CRON_SECRET outside development is a 500, and still no scan', async () => {
    vi.stubEnv('CRON_SECRET', '');
    const res = await get(`Bearer ${SECRET}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'CRON secret not configured' });
    expect(runReminderScan).not.toHaveBeenCalled();
  });

  it('scans with the service client and the current instant', async () => {
    const before = Date.now();
    await get(`Bearer ${SECRET}`);

    expect(runReminderScan).toHaveBeenCalledTimes(1);
    const [service, options] = runReminderScan.mock.calls[0] as [unknown, { now: Date }];
    expect(service).toBe(SERVICE);
    expect(options.now).toBeInstanceOf(Date);
    expect(options.now.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('answers 200 with the summary, notes included, for a partial tick', async () => {
    const partial = summary({ notes: ['u1: cue via sms-nudge failed — 401', 'u2: skipped — fetch failed'] });
    runReminderScan.mockResolvedValue(partial);

    const res = await get(`Bearer ${SECRET}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ...partial, recipes: RECIPES });
  });

  // A database without migration 032 degrades to silence, not to an alarm
  // every five minutes about a migration that has simply not run yet.
  it('answers 200 for a scan that found its migration missing', async () => {
    runReminderScan.mockResolvedValue(summary({ users: 0, cues: 0, lastCalls: 0, eod: 0, unreached: 0, migrationMissing: true, notes: ['migration 032 not applied'] }));
    const res = await get(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
  });

  it('answers 500 with { error, notes } when the scan could not start', async () => {
    runReminderScan.mockRejectedValue(
      new ReminderScanError('Gateway Timeout', ['migration 034 not applied — settling is off, reminders continue']),
    );

    const res = await get(`Bearer ${SECRET}`);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'Gateway Timeout',
      notes: ['migration 034 not applied — settling is off, reminders continue'],
      recipes: RECIPES,
    });
    expect(error).toHaveBeenCalledWith('[cron/reminders] scan failed:', expect.any(ReminderScanError));
  });

  it('answers 500 with empty notes for any other throw', async () => {
    runReminderScan.mockRejectedValue(new Error('supabaseUrl is required.'));
    const res = await get(`Bearer ${SECRET}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'supabaseUrl is required.', notes: [], recipes: RECIPES });
  });

  // One line per tick, in the function log, whatever the tick held: the
  // counts, and how many notes there are rather than the notes themselves.
  it('logs one line per tick', async () => {
    runReminderScan.mockResolvedValue(summary({ notes: ['u1: eod via push unreached — push: no device subscribed'] }));

    await get(`Bearer ${SECRET}`);

    // The tick's line, unchanged, then the recipe tier's own.
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenNthCalledWith(
      1,
      '[cron/reminders] users=2 cues=3 lastCalls=1 eod=1 unreached=1 daysSettled=0 notes=1',
    );
    expect(log).toHaveBeenNthCalledWith(2, '[cron/recipes] users=1 runs=2 notes=0');
  });

  it('logs no tick line for a tick that never ran', async () => {
    runReminderScan.mockRejectedValue(new ReminderScanError('Gateway Timeout', []));
    await get(`Bearer ${SECRET}`);
    await get();
    const lines = log.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines.filter((l: string) => l.startsWith('[cron/reminders]'))).toEqual([]);
  });
});

/**
 * The timed-recipe tier (lib/recipes/server/tick.ts) rides the same request,
 * after the scan, and is isolated from it both ways: a recipe never costs a
 * reminder its status, and a failed scan never costs a recipe its run.
 */
describe('GET /api/cron/reminders: the recipe tier', () => {
  it('runs after the scan, with the same service client, clock and a deadline inside maxDuration', async () => {
    const order: string[] = [];
    runReminderScan.mockImplementation(async () => {
      order.push('scan');
      return summary();
    });
    runRecipeTick.mockImplementation(async () => {
      order.push('recipes');
      return RECIPES;
    });
    await get(`Bearer ${SECRET}`);
    expect(order).toEqual(['scan', 'recipes']);
    const [service, options] = runRecipeTick.mock.calls[0] as [unknown, { now: Date; deadlineMs: number }];
    const [, scanOptions] = runReminderScan.mock.calls[0] as [unknown, { now: Date }];
    expect(service).toBe(SERVICE);
    expect(options.now).toBe(scanOptions.now);
    expect(options.deadlineMs - options.now.getTime()).toBeLessThan(maxDuration * 1000);
  });

  it('a scan that throws still runs the recipes, and the answer is still the scan\'s 500', async () => {
    runReminderScan.mockRejectedValue(new ReminderScanError('Gateway Timeout', []));
    const res = await get(`Bearer ${SECRET}`);
    expect(runRecipeTick).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
  });

  it('a recipe tier that throws costs the tick nothing: 200, the scan summary, the same first line', async () => {
    runRecipeTick.mockRejectedValue(new Error('boom'));
    const res = await get(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      ...summary(),
      recipes: { users: 0, runs: 0, notes: ['recipe tier failed'] },
    });
    expect(log).toHaveBeenNthCalledWith(
      1,
      '[cron/reminders] users=2 cues=3 lastCalls=1 eod=1 unreached=1 daysSettled=0 notes=0',
    );
  });

  it('runs no recipe for a request the gate refused', async () => {
    await get();
    expect(runRecipeTick).not.toHaveBeenCalled();
  });
});
