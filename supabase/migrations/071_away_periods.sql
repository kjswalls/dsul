-- ─────────────────────────────────────────────────────────────────────────────
-- 071_away_periods.sql — vacation mode: one row per trip
--
-- WHY. Vacation mode pauses everything that falls on a day except what you
-- keep, and brings it back gently afterwards (memory/plans/vacation-mode.md).
-- It is stored as ONE row per trip, never as a pause written onto every item:
-- lib/away.ts reads it as the outermost, conjunctive layer of isItemActiveOn
-- (lib/active.ts), so every surface that already asks that predicate (the
-- grid, reminders, last calls, stakes, day done, the agent API) follows it.
-- A table rather than a settings key because past trips must keep reading
-- correctly: next month's week view of this one still needs this trip.
--
-- WHAT.
--   starts_on   first day away (a calendar day in the user's zone)
--   ends_on     the day you are back, EXCLUSIVE, like an item's pausedUntil:
--               "until the 20th" is live again ON the 20th. Null = open-ended.
--   keep        {"itemIds":[], "routineIds":[], "projectIds":[]}: what keeps going
--   returns     {"<itemId>": "yyyy-MM-dd"}: the easing-back waves, a habit's
--               return day when it is later than ends_on. Written by the app
--               when the trip starts and again on "I'm back"; {} = all at once.
--   from_trip   {"<itemId>": "yyyy-MM-dd"}: tasks that came due while away and
--               were moved to the braindump on return, with their old day.
--   settled_at  when that move happened. The app claims it with a conditional
--               update (… where settled_at is null) and moves the tasks only if
--               the claim changed a row, so two open tabs move them once.
--
-- ACCOUNT DELETION. user_id cascades from auth.users (063's rule;
-- tests/unit/account-deletion-migration.test.ts). The jsonb maps hold item ids
-- with no foreign key, like routine_items' history: a deleted item is simply
-- never matched.
--
-- Owner-only RLS, like user_mods. Idempotent; replays onto an empty database.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.away_periods (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  starts_on   date not null,
  ends_on     date,
  keep        jsonb not null default '{}'::jsonb,
  returns     jsonb not null default '{}'::jsonb,
  from_trip   jsonb not null default '{}'::jsonb,
  settled_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'away_periods_range_check') then
    alter table public.away_periods add constraint away_periods_range_check
      check (ends_on is null or ends_on > starts_on);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'away_periods_keep_check') then
    alter table public.away_periods add constraint away_periods_keep_check
      check (jsonb_typeof(keep) = 'object' and octet_length(keep::text) <= 65536);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'away_periods_returns_check') then
    alter table public.away_periods add constraint away_periods_returns_check
      check (jsonb_typeof(returns) = 'object' and octet_length(returns::text) <= 65536);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'away_periods_from_trip_check') then
    alter table public.away_periods add constraint away_periods_from_trip_check
      check (jsonb_typeof(from_trip) = 'object' and octet_length(from_trip::text) <= 65536);
  end if;
end$$;

create index if not exists away_periods_user_starts_idx on public.away_periods (user_id, starts_on desc);

drop trigger if exists away_periods_updated_at on public.away_periods;
create trigger away_periods_updated_at
  before update on public.away_periods
  for each row execute function public.update_updated_at();

alter table public.away_periods enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                   and tablename = 'away_periods' and policyname = 'away_periods_own') then
    create policy away_periods_own on public.away_periods
      for all to authenticated
      using      (user_id = (select auth.uid()))
      with check (user_id = (select auth.uid()));
  end if;
end$$;

-- ── Privileges (not left to Supabase's default ALL) ──────────────────────────
-- Revokes first so a re-run lands in the same state. id, user_id and created_at
-- are immutable; updated_at is written only by the trigger.
revoke all on table public.away_periods from public, anon, authenticated;

grant select, delete on table public.away_periods to authenticated;
grant insert (id, starts_on, ends_on, keep, returns) on public.away_periods to authenticated;
grant update (starts_on, ends_on, keep, returns, from_trip, settled_at) on public.away_periods to authenticated;
grant all on table public.away_periods to service_role;

comment on table public.away_periods is
  'Vacation mode: one row per trip. Read by lib/away.ts as the outer layer of isItemActiveOn. ends_on is exclusive.';
