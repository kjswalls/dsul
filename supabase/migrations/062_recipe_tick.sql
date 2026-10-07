-- ─────────────────────────────────────────────────────────────────────────────
-- 062_recipe_tick.sql — the tick wakes for a recipe at a time of day
--
-- WHY. memory/plans/mods.md build order 6: a recipe can run "at a time of day",
-- on dsul's server, even with dsul closed. It rides the one tick 058 resumed
-- (/api/cron/reminders, a tier after the reminder scan). But dsul_tick asks a
-- cheap question in SQL before it sends the request at all, and 058's question
-- names only the three ritual switches, so someone whose only switch is a timed
-- recipe would never be woken for: the job succeeds, no request goes out, and
-- nothing errors. 061 deferred this widening to the PR that adds timed triggers.
--
-- WHAT. 1. A partial index on user_mods for the one lookup the gate and the
-- route's tier make: switched-on recipes whose trigger is a time. 2. dsul_tick
-- re-created with the same signature (no drop): the gate is 058's, OR any
-- switched-on timed recipe whose owner has a time zone. NO TIME ARITHMETIC
-- HERE, as 058: whether a recipe is due this minute is decided in TypeScript
-- (lib/recipes/server/window.ts), in minutes of day. The gate is a coarse
-- superset; the route decides who is owed what.
--
-- The new clause has no coalesce(…, false): `enabled` is NOT NULL, and
-- tests/unit/reminders-scan.test.ts reads the coalesced flags of the latest
-- dsul_tick as exactly TICK_FLAGS, which this clause is not one of.
--
-- DEPLOY ORDER. App first: the route's recipe tier tolerates no timed recipes,
-- and a missing user_mods (061 not applied) fails this gate OPEN, as 058's
-- missing columns do. Apply to prod only on Kirby's typed OK, after
-- `pnpm db:list` confirms the remote tip; if applied out-of-band, record ledger
-- version 062.
--
-- Replays onto an empty database (CI's E2E job and local-setup.sh run
-- `supabase db reset`): 061 creates user_mods, 058 the function this replaces.
-- Safe to re-run: `create index if not exists`, `create or replace`, and the
-- revoke restated to the same end state.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. The lookup ───────────────────────────────────────────────────────────
create index if not exists user_mods_timed_recipe_idx
  on public.user_mods (user_id)
  where kind = 'recipe' and enabled and (manifest -> 'trigger' ->> 'on') = 'time';

-- ─── 2. The tick, with the wider short-circuit ───────────────────────────────
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
      ) or exists (
        select 1
          from public.user_mods m
          join public.user_settings s on s.user_id = m.user_id
         where m.kind = 'recipe'
           and m.enabled
           and (m.manifest -> 'trigger' ->> 'on') = 'time'
           and s.timezone is not null
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
  'Calls one of dsul''s /api/cron routes with the Bearer secret from Vault. Returns without a request when no account has a ritual switched on or an enabled recipe that runs at a time of day (unless force), or when the Vault names are unset.';
