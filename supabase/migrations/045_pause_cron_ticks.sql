-- ─────────────────────────────────────────────────────────────────────────────
-- 045_pause_cron_ticks.sql — park the two */5 ticks while the API latency is
-- investigated
--
-- WHY THIS EXISTS. Measured on the live project over 24h: the two `*/5` jobs
-- were the ONLY traffic the database saw — 576 of 578 API requests — and every
-- one of them took ~1.9 s at the gateway (p95 4.1 s, max 9.2 s) for a query
-- Postgres itself answers in 3.9 ms:
--
--   Seq Scan on user_settings (actual time=2.762..2.762 rows=0 loops=1)
--   Buffers: shared hit=4   Planning: 10.696 ms   Execution: 3.854 ms
--
-- So >99% of the latency is ABOVE Postgres, in the PostgREST/gateway layer —
-- which in the same window logged 194 `Warp server error: Thread killed by
-- timeout manager`, five schema-cache reloads, two pool re-inits, and one
-- schema-cache query taking 1,860 ms. Nothing here is fixed by an index.
--
-- This migration does not fix that. It stops paying for it 576 times a day
-- while the compute/PostgREST side is diagnosed, and it stops the ticks from
-- being the sole thing keeping the instance awake (checkpoints were firing
-- every 5 minutes to write four dirty buffers).
--
-- WHAT IT COSTS, EXACTLY. At the time of writing, of four accounts:
--   habit_reminders_enabled = 0, habit_last_call_enabled = 0, stakes_enabled = 0
--   eod_review_enabled      = 1
-- So `dsul-reminders` served nobody and pausing it is free. `dsul-eod-notify`
-- has ONE subscriber, who stops receiving the nightly review until this is
-- reverted — accepted deliberately, not overlooked.
--
-- THE STAKES CAVEAT. lib/stakes/live.ts still posts to Beeminder the instant a
-- habit is ticked, so the live path is unaffected. What is paused is the
-- NIGHTLY SETTLEMENT — the backstop for completions that never pass through a
-- browser. That is safe ONLY while stakes_enabled = 0 across the board.
-- **Before anyone enables stakes, this migration must be reverted**, or a day
-- can settle with a pledge uncharged and the ledger claiming otherwise.
--
-- PAUSED, NOT UNSCHEDULED. `active = false` keeps the job rows, their ids and
-- their bodies intact, so bringing them back is one flag — no re-deriving the
-- schedule or the tick function. The three DAILY jobs (purge-deleted-items,
-- prune-cron-log, reap-stale-sessions) are deliberately left running: they fire
-- 3 times a day, not 576, so they are not the load — and pausing prune-cron-log
-- would re-create the unbounded cron.job_run_details growth that 037 exists to
-- prevent.
--
-- TO REVERT: `select cron.alter_job(jobid, active := true) from cron.job where
-- jobname in ('dsul-reminders','dsul-eod-notify');` — then land a migration
-- saying so, rather than leaving the tree disagreeing with the project.
--
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  j record;
begin
  -- A database without pg_cron (a bare local Postgres, the verify-039 fixture)
  -- has no jobs to pause. Not an error — there is simply nothing to do.
  if to_regclass('cron.job') is null then
    return;
  end if;

  -- Both the post-044 names and the pre-rename ones. 044 schedules the `dsul-`
  -- pair unconditionally, so the `anchor-` arm only ever matches a database
  -- where 044 was interrupted between scheduling the new and dropping the old.
  for j in
    select jobid, jobname
    from cron.job
    where jobname in (
      'dsul-reminders',   'dsul-eod-notify',
      'anchor-reminders', 'anchor-eod-notify'
    )
  loop
    perform cron.alter_job(j.jobid, active := false);
    raise notice '045: paused cron job % (%)', j.jobname, j.jobid;
  end loop;
end$$;
