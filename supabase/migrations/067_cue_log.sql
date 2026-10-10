-- ─────────────────────────────────────────────────────────────────────────────
-- 067_cue_log.sql — what actually went out, once per logical cue
--
-- The reminders plan's "060_cue_log.sql" (memory/plans/reminders-platforms.md
-- §4.3), renumbered: 060 to 066 were taken first. It lands with PR-1b, whose
-- ack route (POST /api/reminders/ack) writes `acked_at` and `acked_device`,
-- ahead of PR-1d's writer in the scan. Until that writer lands no row exists,
-- and an ack is a recorded no-op.
--
-- WHY. net._http_response keeps six hours; Vercel Hobby logs keep less. "Did
-- it fire last Tuesday" has had no answer, and "push reported ok at zero
-- devices" was invisible forever. One row per (user, key), written by the
-- service role on claim and on each delivery result; a device acks a delivery
-- it displayed (POST /api/reminders/ack, cookie-checked, service write).
-- Owner SELECT only — a ledger the subject can edit is not a ledger (034's
-- posture). Also the retry input: a claimed cue whose window is still open and
-- that no transport accepted is re-sent at the top of the next tick, through
-- DEVICE TRANSPORTS ONLY (never the channel fan-out, which would re-text or
-- re-call), after a CONDITIONAL claim on `attempts` (`… where id = $1 and
-- attempts = $read returning id`; a blind increment is not exclusive, scan.ts
-- says why) and a re-check of wantsDoingOn — the maxDuration-kill case, which
-- #276's lossless 500s were not.
--
-- THE KEY is lib/reminders/cue-log.ts's: 'cue:<itemId>:<yyyy-MM-ddTHH:mm>',
-- 'snooze:<itemId>:<ISO instant>', 'last-call:<date>', 'eod:<date>',
-- 'pledge:<date>'.
--
-- ACCOUNT DELETION. user_id cascades from auth.users (063's rule;
-- tests/unit/account-deletion-migration.test.ts). item_id is deliberately no
-- foreign key: the ledger outlives a deleted item, as stake_events does.
--
-- Idempotent; replays onto an empty database; pg_cron guarded like 058.
-- scripts/verify-067.sh replays it twice on a bare Postgres.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.cue_log (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  key           text not null,
  kind          text not null,
  item_id       uuid,
  date_str      text not null,
  collapse_id   text not null,
  window_end    timestamptz not null,
  claimed_at    timestamptz,
  delivered_at  timestamptz,
  attempts      int  not null default 0,
  -- [{channel|deviceId, transport?, ok, code?, at}]
  results       jsonb not null default '[]'::jsonb,
  acked_at      timestamptz,
  acked_device  text,
  acted_at      timestamptz,
  action        text,
  created_at    timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cue_log_kind_check') then
    alter table public.cue_log add constraint cue_log_kind_check
      check (kind in ('cue', 'snooze', 'last-call', 'eod', 'pledge'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cue_log_date_check') then
    alter table public.cue_log add constraint cue_log_date_check
      check (date_str ~ '^\d{4}-\d{2}-\d{2}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cue_log_key_check') then
    alter table public.cue_log add constraint cue_log_key_check
      check (char_length(key) between 1 and 200);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cue_log_acked_device_check') then
    alter table public.cue_log add constraint cue_log_acked_device_check
      check (acked_device is null or acked_device ~ '^[A-Za-z0-9:._-]{8,128}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cue_log_action_check') then
    alter table public.cue_log add constraint cue_log_action_check
      check (action is null or action in ('done', 'snooze', 'skip', 'open', 'dismiss'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cue_log_results_check') then
    alter table public.cue_log add constraint cue_log_results_check
      check (jsonb_typeof(results) = 'array' and length(results::text) <= 8192);
  end if;
end$$;

create unique index if not exists cue_log_user_key_idx on public.cue_log (user_id, key);
create index if not exists cue_log_open_idx on public.cue_log (window_end)
  where delivered_at is null and attempts < 5;

alter table public.cue_log enable row level security;
revoke all on table public.cue_log from public;
revoke all on table public.cue_log from anon;
revoke all on table public.cue_log from authenticated;
grant select on table public.cue_log to authenticated;
grant select, insert, update, delete on table public.cue_log to service_role;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'cue_log' and policyname = 'Users read their own cue log'
  ) then
    create policy "Users read their own cue log"
      on public.cue_log for select
      using (auth.uid() = user_id);
  end if;
end$$;

do $$
begin
  if to_regclass('cron.job') is null then return; end if;
  begin perform cron.unschedule('prune-cue-log'); exception when others then null; end;
  perform cron.schedule(
    'prune-cue-log',
    '53 3 * * *',
    $job$delete from public.cue_log where created_at < now() - interval '180 days'$job$
  );
end$$;
