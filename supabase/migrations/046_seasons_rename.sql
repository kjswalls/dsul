-- ─────────────────────────────────────────────────────────────────────────────
-- 046_seasons_rename.sql — the "program" container is now a "season"
--
-- The noun never said what the thing is for. A program is a stretch of life —
-- a summer, a school term, a training block — that switches whole routines on
-- and off, and "season" says that in one word: it comes back (every summer),
-- several overlap naturally ("marathon season" inside "busy season"), and "out
-- of season" is exactly the suppressed state. The code had already been
-- reaching for it: "Plan a season", the season heatmap, "out of season" in the
-- agent tool copy. Plan decision 12 (memory/plans/programs-routines.md) made
-- the old name code-deep, so the new one is too — this is the catalog half.
--
-- Pure renames: no row is read or rewritten, ids survive, the composite FKs
-- and RLS keep enforcing exactly what they did. `alter table … rename` carries
-- constraints, indexes, policies and triggers along under their OLD names, so
-- those are renamed after it for anyone reading the catalog later.
--
-- Safe to re-run, and replays onto an empty database (024 creates the
-- `program*` tables, this renames them): every step checks the old name is
-- present and the new one absent.
--
-- DEPLOY ORDER: apply together with the app build that reads `seasons`. The
-- tolerance 024 built in holds in both directions — fetchSeasons returns null
-- on a missing table and the store gates the feature off — so the window
-- shows no seasons rather than an error, but it is a window; keep it short.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. Tables and the join tables' foreign-key column ───────────────────────

do $$
begin
  if to_regclass('public.programs') is not null and to_regclass('public.seasons') is null then
    alter table public.programs rename to seasons;
  end if;
  if to_regclass('public.program_items') is not null and to_regclass('public.season_items') is null then
    alter table public.program_items rename to season_items;
  end if;
  if to_regclass('public.program_routines') is not null and to_regclass('public.season_routines') is null then
    alter table public.program_routines rename to season_routines;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'season_items' and column_name = 'program_id'
  ) then
    alter table public.season_items rename column program_id to season_id;
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'season_routines' and column_name = 'program_id'
  ) then
    alter table public.season_routines rename column program_id to season_id;
  end if;
end$$;

-- ─── 2. Constraints and indexes still wearing the old name ───────────────────
-- Found, not listed: the PK and FK names Postgres generated in 024 are an
-- implementation detail, and a hand-written list is one that misses one.
-- Renaming a constraint that owns an index renames the index with it, so the
-- index loop only meets the plain ones (programs_user_idx and the two
-- user/member lookups).

do $$
declare
  c record;
begin
  for c in
    select con.conname, rel.relname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public'
      and rel.relname in ('seasons', 'season_items', 'season_routines')
      and con.conname like '%program%'
  loop
    execute format(
      'alter table public.%I rename constraint %I to %I',
      c.relname, c.conname, replace(c.conname, 'program', 'season')
    );
  end loop;

  for c in
    select idx.relname
    from pg_index i
    join pg_class idx on idx.oid = i.indexrelid
    join pg_class rel on rel.oid = i.indrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public'
      and rel.relname in ('seasons', 'season_items', 'season_routines')
      and idx.relname like '%program%'
  loop
    execute format('alter index public.%I rename to %I', c.relname, replace(c.relname, 'program', 'season'));
  end loop;
end$$;

-- ─── 3. Policy and trigger ────────────────────────────────────────────────────
-- The join tables' policy is "Users can manage their own memberships", which
-- names no kind, so only the parent's needs renaming.

do $$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'seasons'
      and policyname = 'Users can manage their own programs'
  ) then
    alter policy "Users can manage their own programs" on public.seasons
      rename to "Users can manage their own seasons";
  end if;

  if exists (
    select 1 from pg_trigger t
    join pg_class rel on rel.oid = t.tgrelid
    where rel.relname = 'seasons' and t.tgname = 'programs_updated_at'
  ) then
    alter trigger programs_updated_at on public.seasons rename to seasons_updated_at;
  end if;
end$$;

-- ─── 4. Trash purge ───────────────────────────────────────────────────────────
-- The job names its tables in its body text, which a table rename does not
-- reach: left alone, the nightly purge would fail on `programs` from tonight
-- on — and since it is one statement list, every table after it would stop
-- being purged too. Replaced whole, so every table 036's version purged is
-- re-listed; dropping one would silently strand its trash forever.
--
-- Guarded on cron.job, like 045: a bare Postgres with no pg_cron has no job to
-- repoint, and that is not an error.

do $$
begin
  if to_regclass('cron.job') is null then
    return;
  end if;

  begin
    perform cron.unschedule('purge-deleted-items');
  exception when others then
    null; -- job absent — nothing to unschedule
  end;

  perform cron.schedule('purge-deleted-items', '0 0 * * *', $job$
    DELETE FROM items WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days';
    DELETE FROM habit_groups WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days';
    DELETE FROM projects WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days';
    DELETE FROM routines WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days';
    DELETE FROM seasons WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days';
    DELETE FROM goals WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days';
    DELETE FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days';
    DELETE FROM habits WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days';
    DELETE FROM item_events WHERE created_at < NOW() - INTERVAL '180 days';
  $job$);
end$$;

-- ─── 5. Comments ──────────────────────────────────────────────────────────────

comment on table public.seasons is
  'Stretches of life (summer, a school term, a training block) that switch whole routines on and off. Hold items directly (season_items) and/or routines (season_routines). Named "program" until 046.';
comment on table public.routines is
  'Sets of things done regularly, in order (a morning, a workout week). Members join via routine_items; a routine may belong to several seasons (season_routines) or none.';
