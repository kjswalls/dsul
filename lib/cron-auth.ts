/**
 * cron-auth.ts — the shared gate on every scheduled route.
 *
 * Extracted when the reminder scan became the second cron endpoint and the
 * nightly settlement was about to be the third. The rule it encodes is the one
 * /api/cron/eod-notify already had (that route has since been folded into the
 * scan, which leaves /api/cron/reminders as the one caller), and the reason it
 * is worth centralising is the FAIL-CLOSED half: an unset CRON_SECRET must 500
 * in production and only wave the request through in development. Copied by
 * hand a third time, that is the clause someone eventually inverts, and the
 * result is a public endpoint that will happily send notifications to every
 * user on demand.
 */

import { NextResponse } from 'next/server'

export type CronAuthFailure = { response: NextResponse }

/**
 * Returns null when the caller may proceed, or the response to return.
 *
 * The scheduled caller is Postgres, not the host: pg_cron runs
 * public.dsul_tick, which sends `Authorization: Bearer <secret>` through
 * pg_net's http_get, the secret read from Vault (`dsul_cron_secret`, or the
 * pre-rename `anchor_cron_secret` that 044 falls back to; migrations 035 and
 * 044). Vercel's own cron, which would set this header
 * from the project's CRON_SECRET by itself, has never called these routes:
 * the Hobby plan runs it once a day at most. So the two copies of the secret,
 * Vault's and the deployment's, are kept equal by hand, and a mismatch reads
 * here as a 401 on every tick.
 *
 * The comparison is exact: the scheme's case, the single space and the whole
 * secret. Anything else is a 401.
 */
export function checkCronAuth(req: Request): CronAuthFailure | null {
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret) {
    if (process.env.NODE_ENV !== 'development') {
      return {
        response: NextResponse.json({ error: 'CRON secret not configured' }, { status: 500 }),
      }
    }
    return null
  }

  if (req.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  return null
}
