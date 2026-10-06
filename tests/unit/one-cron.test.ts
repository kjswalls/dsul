// @vitest-environment node
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * One cron route, and it is the reminder scan.
 *
 * There used to be two: /api/cron/eod-notify ran beside /api/cron/reminders,
 * every five minutes each, with its own clock, its own window arithmetic (it
 * wrapped at midnight, so a review set just before it went out again just
 * after, as the next day's) and its own order of operations (deliver, then
 * stamp). The review is Tier 0 of
 * lib/reminders/scan.ts now, and anything else that reaches a person on a
 * schedule, #220's morning check first, joins it as a tier: a claim, a window
 * from lib/reminders/due.ts and deliverNudge, under the one request pg_cron
 * already makes. A second route is a second pg_cron job, a second cold
 * request every five minutes (#276 counted 576 a day for the two), and a
 * second place for "claim, then act" to come out backwards.
 */

const CRON = path.resolve(__dirname, '../../app/api/cron');

describe('app/api/cron', () => {
  it('holds exactly one route: the reminder tick', () => {
    expect(readdirSync(CRON).sort()).toEqual(['reminders']);
    expect(readdirSync(path.join(CRON, 'reminders'))).toContain('route.ts');
  });
});
