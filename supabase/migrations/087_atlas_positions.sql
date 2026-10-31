-- ─────────────────────────────────────────────────────────────────────────────
-- 087_atlas_positions.sql — where each container sits on Atlas, per account
--
-- WHY. Atlas (the third view beside Day and Week) shows every project, routine,
-- season and goal as a card. Two of its layouts remember something the user
-- chose: "Your map" keeps where each card was put (x, y), and "Momentum" keeps a
-- card the user pinned to a column (pinned_band) over the app's own sort.
-- Kirby picked per-account positions (2026-10-31), so a card is where you left
-- it on every device. Until this is applied, the app keeps them per device
-- (lib/atlas-positions.ts falls back on 42P01 / PGRST205) and uploads them the
-- first time it finds the table.
--
-- WHAT.
--   atlas_positions   one row per (user, container). Owner-only RLS, written by
--                     the browser's session client, never the service role. No
--                     agent route, MCP tool or chat context reads it.
--   container_kind    'project' | 'routine' | 'season' | 'goal'
--                     (CONTAINER_KINDS in lib/container-registry.ts).
--   container_id      the container's uuid. NO foreign key: one column cannot
--                     reference four tables. The delete triggers below remove a
--                     container's row when the container row is deleted (the
--                     nightly purge of containers trashed over 30 days ago,
--                     Delete forever, a failed-create rollback). A soft delete
--                     is an update, so a trashed container keeps its place for
--                     its restore.
--   x, y              world px on "Your map"; both or neither. Null = never
--                     placed (the app lays it out).
--   pinned_band       Momentum's pin: 'now' | 'soon' | 'resting'; null = the app
--                     sorts it. Unpin writes null; a row with nothing left in it
--                     is deleted by the client, not kept.
--
-- ACCOUNT DELETION. user_id cascades from auth.users (063's rule;
-- tests/unit/account-deletion-migration.test.ts).
--
-- Cap: 2,000 rows an account (a BEFORE INSERT trigger, counted only for a new
-- key, so an upsert of an existing card always passes).
--
-- Idempotent; replays onto an empty database (024 and 036 create the four
-- container tables, 046 renames programs to seasons).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.atlas_positions (
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  container_kind  text not null,
  container_id    uuid not null,
  x               double precision,
  y               double precision,
  pinned_band     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (user_id, container_kind, container_id)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'atlas_positions_kind_check') then
    alter table public.atlas_positions add constraint atlas_positions_kind_check
      check (container_kind in ('project', 'routine', 'season', 'goal'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'atlas_positions_band_check') then
    alter table public.atlas_positions add constraint atlas_positions_band_check
      check (pinned_band is null or pinned_band in ('now', 'soon', 'resting'));
  end if;
  -- Both or neither, and finite: NaN and ±Infinity fail BETWEEN in Postgres.
  -- The IS NOT NULLs are load-bearing: with y null, `y between …` is NULL and a
  -- CHECK passes on NULL, so (1, null) would be stored.
  if not exists (select 1 from pg_constraint where conname = 'atlas_positions_xy_check') then
    alter table public.atlas_positions add constraint atlas_positions_xy_check
      check (
        (x is null and y is null)
        or (x is not null and y is not null
            and x between -1000000 and 1000000 and y between -1000000 and 1000000)
      );
  end if;
end$$;

-- No index beyond the primary key: the only reader by container is the forget
-- trigger below, and it filters on (user_id, container_kind, container_id),
-- which is the key itself. Nothing reads this table across users.

drop trigger if exists atlas_positions_updated_at on public.atlas_positions;
create trigger atlas_positions_updated_at
  before update on public.atlas_positions
  for each row execute function public.update_updated_at();

alter table public.atlas_positions enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                   and tablename = 'atlas_positions' and policyname = 'atlas_positions_own') then
    create policy atlas_positions_own on public.atlas_positions
      for all to authenticated
      using      (user_id = (select auth.uid()))
      with check (user_id = (select auth.uid()));
  end if;
end$$;

-- ── Privileges (not left to Supabase's default ALL) ──────────────────────────
-- Revoke first so a re-run lands in the same state (REVOKE ALL drops column
-- grants too). user_id is never sent (its default is auth.uid()). The UPDATE
-- grant names the key columns because PostgREST's upsert writes
-- ON CONFLICT DO UPDATE SET <every payload column>, keys included.
revoke all on table public.atlas_positions from public, anon, authenticated;
grant select, delete on table public.atlas_positions to authenticated;
grant insert (container_kind, container_id, x, y, pinned_band) on public.atlas_positions to authenticated;
grant update (container_kind, container_id, x, y, pinned_band) on public.atlas_positions to authenticated;
grant all on table public.atlas_positions to service_role;

-- ── Cap ──────────────────────────────────────────────────────────────────────

create or replace function public.atlas_positions_cap()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- An upsert of a card already placed fires this too; it is not a new row.
  if exists (select 1 from public.atlas_positions p
              where p.user_id = new.user_id
                and p.container_kind = new.container_kind
                and p.container_id = new.container_id) then
    return new;
  end if;
  if (select count(*) from public.atlas_positions p where p.user_id = new.user_id) >= 2000 then
    raise exception 'atlas_positions_limit' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.atlas_positions_cap() from public, anon, authenticated;

drop trigger if exists atlas_positions_cap on public.atlas_positions;
create trigger atlas_positions_cap
  before insert on public.atlas_positions
  for each row execute function public.atlas_positions_cap();

-- ── A container that is deleted takes its place with it ──────────────────────
-- SECURITY DEFINER (owned by postgres, as 076's items_request_wake), because
-- of Delete account. auth.admin.deleteUser deletes from auth.users as
-- supabase_auth_admin; the cascade into projects/routines/seasons/goals queues
-- these AFTER triggers, and they run at the end of GoTrue's statement under
-- supabase_auth_admin, which holds no grant on atlas_positions. As the invoker
-- the delete below would fail with "permission denied" and roll the whole
-- account deletion back. It is safe as definer: it deletes only the row whose
-- owner, kind and id match the container row just deleted, a delete that
-- already passed that table's own RLS, and a trigger function cannot be
-- called directly (EXECUTE is revoked as well).

create or replace function public.atlas_positions_forget()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.atlas_positions
   where container_kind = tg_argv[0]
     and container_id = old.id
     and user_id = old.user_id;
  return old;
end;
$$;

revoke all on function public.atlas_positions_forget() from public, anon, authenticated;

drop trigger if exists atlas_positions_forget on public.projects;
create trigger atlas_positions_forget
  after delete on public.projects
  for each row execute function public.atlas_positions_forget('project');

drop trigger if exists atlas_positions_forget on public.routines;
create trigger atlas_positions_forget
  after delete on public.routines
  for each row execute function public.atlas_positions_forget('routine');

drop trigger if exists atlas_positions_forget on public.seasons;
create trigger atlas_positions_forget
  after delete on public.seasons
  for each row execute function public.atlas_positions_forget('season');

drop trigger if exists atlas_positions_forget on public.goals;
create trigger atlas_positions_forget
  after delete on public.goals
  for each row execute function public.atlas_positions_forget('goal');

-- ── The far zoom on Paper: Bloom (null, the default) or Dusk ─────────────────
-- Open text, no CHECK, null = never chosen (056 app_icon's shape): the app
-- coerces, so a value a later build adds never fails an older database.
-- Nothing reads or writes it yet: the Bloom/Dusk pick is per device until this
-- is on prod, and a follow-up then adds it to lib/settings-service.ts. It is NOT
-- in PENDING_SCHEMA_COLUMNS meanwhile, because one missing pending column makes
-- loadSettings fall back to the stable select and drop every pending setting.
alter table public.user_settings add column if not exists atlas_far_paper text;

comment on table public.atlas_positions is
  'Atlas: where each container sits on Your map (x, y) and Momentum pins. Session client only; not in agent reads or MCP.';
comment on column public.user_settings.atlas_far_paper is
  'Atlas far zoom on Paper: ''dusk'' or null (Bloom). Coerced app-side.';
