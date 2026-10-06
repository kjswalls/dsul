-- ─────────────────────────────────────────────────────────────────────────────
-- 058_resume_cron_tick.sql — one tick again: resume dsul-reminders, retire
-- dsul-eod-notify, and stop paying for a tick that serves nobody
--
-- WHY. 045 paused both */5 jobs after #276 measured ~1.9 s at the gateway per
-- tick for a 4 ms query — 576 requests a day, 2 jobs reading the same
-- user_settings row in the same second, returning zero rows almost every time.
-- #278 tracked bringing them back and named the two fold-ins this lands.
--
-- DEPLOY LEADS MIGRATION. The app must already be deployed with:
--   · /api/cron/eod-notify gone; EOD is Tier 0 of /api/cron/reminders;
--   · the push channel reporting `unreached`; cue pushes carrying a TTL.
--
-- WHAT. 1. dsul_tick(route, force) asks the cheap question in SQL before the
-- HTTP request: any account with a time zone and ANY of habit_reminders_enabled
-- / stakes_enabled / eod_review_enabled on? If not it returns — unless `force`,
-- which the daily keepalive passes so a Free project sees one real API request
-- a day. A database behind on migrations (no such column) FAILS OPEN. NO TIME
-- ARITHMETIC HERE: Postgres `time + interval` wraps modulo 24 h, so a window
-- written in SQL silently closes after 23:30; the route decides windows
-- (lib/reminders/due.ts). 2. dsul-eod-notify is unscheduled. 3. dsul-reminders
-- is active again — the revert 045 asked for, applied by db push and recorded
-- in the ledger; if someone unscheduled it by hand instead of pausing it, it is
-- re-created first (cron.schedule is upsert-by-name).
--
-- SEARCH PATH. 035/044 set `public, vault, net`; this one sets '' (057's rule).
-- The body qualifies every object, pg_net's own functions are qualified, and a
-- security definer function is where an open path matters. The old one-arg
-- function is dropped rather than overloaded: with a default on `force`, a
-- call with one argument would be ambiguous between the two.
--
-- Replays on an empty database (035/044 scheduled the jobs, 045 paused them);
-- on a bare Postgres without pg_cron every cron.* call is guarded. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. The tick, with the short-circuit ─────────────────────────────────────
drop function if exists public.dsul_tick(text);

create or replace function public.dsul_tick(route text, force boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  app_url text;
  secret  text;
  anyone  boolean := true;
begin
  -- Flags only, never a window: this is a coarse superset of "someone is owed
  -- something this minute", and the route still decides who actually is.
  if not force then
    begin
      select exists (
        select 1
          from public.user_settings
         where timezone is not null
           and (coalesce(habit_reminders_enabled, false)
             or coalesce(stakes_enabled, false)
             or coalesce(eod_review_enabled, false))
      ) into anyone;
    exception
      -- Behind on migrations: ask the route rather than go quiet.
      when undefined_column or undefined_table then
        anyone := true;
    end;

    if not anyone then
      return;
    end if;
  end if;

  -- 044's names first, 035's as the fallback: prod still holds anchor_cron_secret.
  select decrypted_secret into app_url from vault.decrypted_secrets where name = 'dsul_app_url';
  if app_url is null then
    select decrypted_secret into app_url from vault.decrypted_secrets where name = 'anchor_app_url';
  end if;

  select decrypted_secret into secret from vault.decrypted_secrets where name = 'dsul_cron_secret';
  if secret is null then
    select decrypted_secret into secret from vault.decrypted_secrets where name = 'anchor_cron_secret';
  end if;

  if app_url is null or secret is null then
    return;
  end if;

  perform net.http_get(
    url     := rtrim(app_url, '/') || route,
    headers := jsonb_build_object('Authorization', 'Bearer ' || secret),
    timeout_milliseconds := 55000
  );
end;
$$;

revoke all on function public.dsul_tick(text, boolean) from public, anon, authenticated;

comment on function public.dsul_tick(text, boolean) is
  'Calls one of dsul''s /api/cron routes with the Bearer secret from Vault. Returns without a request when no account has a ritual switched on (unless force), or when the Vault names are unset.';

-- ─── 2. Retire the second job (its route no longer exists) ───────────────────
do $$
begin
  if to_regclass('cron.job') is null then return; end if;
  begin perform cron.unschedule('dsul-eod-notify');   exception when others then null; end;
  begin perform cron.unschedule('anchor-eod-notify'); exception when others then null; end;
end$$;

-- ─── 3. Resume the tick — the revert 045 asked for ───────────────────────────
-- 045 paused by alter_job, so the row normally exists. If it was unscheduled or
-- renamed by hand, re-create it (upsert-by-name) so this migration cannot
-- "succeed" with nothing resumed and leave E1 red with no statement to fix it.
do $$
declare
  j record;
begin
  if to_regclass('cron.job') is null then return; end if;
  if not exists (select 1 from cron.job where jobname = 'dsul-reminders') then
    perform cron.schedule('dsul-reminders', '*/5 * * * *',
                          $job$select public.dsul_tick('/api/cron/reminders')$job$);
    raise notice '058: dsul-reminders was missing; re-created';
  end if;
  for j in
    select jobid, jobname from cron.job where jobname = 'dsul-reminders'
  loop
    perform cron.alter_job(j.jobid, active := true);
    raise notice '058: dsul-reminders (%) active', j.jobid;
  end loop;
end$$;

-- ─── 4. Keepalive — ONLY if the runbook's A-dash says the project is on Free.
-- A gate that goes quiet must never let a Free project auto-pause. The call
-- passes force := true, so it is one real request to the route (and so to
-- PostgREST) a day — the kind of activity Supabase's pausing doc names; a bare
-- `select 1` inside pg_cron is not known to count. Uncomment when Decision 1
-- says so; harmless on Pro. Decision 1 was read on 2026-10-05: the project is
-- on Pro, so this stays commented out — it is for a Free fork or preview.
-- do $$
-- begin
--   if to_regclass('cron.job') is null then return; end if;
--   begin perform cron.unschedule('dsul-keepalive'); exception when others then null; end;
--   perform cron.schedule('dsul-keepalive', '17 4 * * *',
--                         $job$select public.dsul_tick('/api/cron/reminders', true)$job$);
-- end$$;
