-- 061_user_mods: the recipes, mods, themes and Looks a person makes (mods build order 3).
--
-- WHY. memory/plans/mods.md: private mods plus no-code recipes, user themes and Looks
-- (Kirby's pick, 2026-10-03; decisions 2026-10-07). This migration is the storage only.
-- Settings → Make lists these rows with a switch and Delete; nothing runs them yet.
--
-- WHAT IS STORED. One row per thing a person made: its kind (recipe, mod, theme, look), a
-- slug and a display name, whether it is on, its manifest (a recipe's trigger, filters and
-- steps; a theme's token values; a Look's layout and themes; a mod's declared uses), a
-- mod's source text (<= 64KB), a mod's own key-value store (<= 64KB), and why the app
-- switched it off, when it did. mod_runs holds one short summary per run, keyed by a claim
-- so a run happens once (claim, then act, as stake_events).
-- NOT STORED: item contents, notes, conversations, keys, tokens, anything another user made.
--
-- ACCESS. Owner-only RLS through the session client (lib/mods-store.ts). No service-role
-- code path reads or writes these tables in this PR; service_role keeps Supabase's default
-- ALL, restated below. authenticated gets exactly the columns the app writes, after a
-- REVOKE ALL (Supabase's default privileges would include TRUNCATE, REFERENCES, TRIGGER).
-- A row's id, user_id, kind, slug and created_at are not updatable. mod_store_set is
-- SECURITY INVOKER with an empty search_path (050) and checks auth.uid() itself.
--
-- OWNER-ASSERTED FIELDS. Because mod_store_set is SECURITY INVOKER, authenticated holds
-- the UPDATE grant on `store` itself, so an owner can write their OWN store directly with
-- their own JWT, skipping the RPC's one-key-at-a-time merge. The 64KB CHECK is what holds
-- it either way. Also owner-asserted: enabled, disabled_reason, manifest and source. The
-- app must Zod-check every manifest at every load (lib/mods/schema.ts) and never trust any
-- of these beyond the owner's own planner. mod_runs rows are owner-asserted too; the
-- composite FK below holds a run to a mod of the same user, so no one can pre-claim a
-- (mod_id, claim_key) against another person's mod.
--
-- NOT EXPOSED. Never in /api/agent/*, MCP or lib/app-api.ts (tests/unit/mods-boundary.test.ts).
--
-- DSUL_TICK DEFERRED. dsul_tick's cheap "is anyone enabled" question (058) is NOT widened
-- here. No recipe can have a timed trigger until build order 6 (the server runner), and
-- that PR widens it.
--
-- DEPLOY ORDER. The app tolerates this migration's absence: 42P01 / PGRST205 latch the mods
-- store "unavailable" and Make says a database update has not landed. Apply to prod only on
-- Kirby's typed OK, after `pnpm db:list` confirms the remote tip. If applied out-of-band,
-- record ledger version 061. 060 (ai_hidden, an open branch) lands separately; the two do
-- not depend on each other.
--
-- Idempotent and replayable onto an empty database (CI's E2E job and local-setup.sh run
-- `supabase db reset`): every object is guarded, or created with "or replace", and the
-- privileges are revoked and re-granted to the same end state on every run.
-- update_updated_at() comes from 000_baseline.sql. tests/unit/mods-migration.test.ts pins
-- the caps and the slug rule against lib/mods/schema.ts.

-- ── user_mods ─────────────────────────────────────────────────────────────────
create table if not exists public.user_mods (
  id              uuid primary key,
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind            text not null check (kind in ('recipe', 'mod', 'theme', 'look')),
  slug            text not null check (slug ~ '^[a-z][a-z0-9-]{0,29}$'),
  name            text not null check (char_length(name) between 1 and 60),
  enabled         boolean not null default false,
  manifest        jsonb not null default '{}',
  source          text check (octet_length(source) <= 65536),
  store           jsonb not null default '{}' check (octet_length(store::text) <= 65536),
  disabled_reason text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, kind, slug)
);

do $$
begin
  -- 057's title rule: not blank, no control characters.
  if not exists (select 1 from pg_constraint where conname = 'user_mods_name_text_check') then
    alter table public.user_mods add constraint user_mods_name_text_check
      check (btrim(name) <> '' and name !~ '[[:cntrl:]]');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_mods_manifest_check') then
    alter table public.user_mods add constraint user_mods_manifest_check
      check (jsonb_typeof(manifest) = 'object' and octet_length(manifest::text) <= 65536);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_mods_store_object_check') then
    alter table public.user_mods add constraint user_mods_store_object_check
      check (jsonb_typeof(store) = 'object');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_mods_disabled_reason_check') then
    alter table public.user_mods add constraint user_mods_disabled_reason_check
      check (disabled_reason is null or char_length(disabled_reason) between 1 and 200);
  end if;
  -- The composite-FK target for mod_runs (036_goals.sql's pattern, as 057).
  if not exists (select 1 from pg_constraint where conname = 'user_mods_id_user_id_key') then
    alter table public.user_mods add constraint user_mods_id_user_id_key
      unique (id, user_id);
  end if;
end$$;

drop trigger if exists user_mods_updated_at on public.user_mods;
create trigger user_mods_updated_at
  before update on public.user_mods
  for each row execute function public.update_updated_at();

-- ── mod_runs ──────────────────────────────────────────────────────────────────
create table if not exists public.mod_runs (
  id        bigint generated always as identity primary key,
  user_id   uuid not null references auth.users (id) on delete cascade,
  mod_id    uuid not null,
  claim_key text not null,
  summary   jsonb not null default '{}',
  at        timestamptz not null default now(),
  unique (mod_id, claim_key)
);

do $$
begin
  -- Same owner by construction; cascades with its mod. A single FK on mod_id alone
  -- would let one user claim a run against another user's mod (an FK check skips RLS).
  if not exists (select 1 from pg_constraint where conname = 'mod_runs_mod_fkey') then
    alter table public.mod_runs add constraint mod_runs_mod_fkey
      foreign key (mod_id, user_id)
      references public.user_mods (id, user_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'mod_runs_claim_key_check') then
    alter table public.mod_runs add constraint mod_runs_claim_key_check
      check (char_length(claim_key) between 1 and 200);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'mod_runs_summary_check') then
    alter table public.mod_runs add constraint mod_runs_summary_check
      check (jsonb_typeof(summary) = 'object' and octet_length(summary::text) <= 4096);
  end if;
end$$;

-- A mod's recent runs (Make's run log), and a user's (the cascade from auth.users).
create index if not exists mod_runs_mod_recent_idx  on public.mod_runs (mod_id, at desc);
create index if not exists mod_runs_user_recent_idx on public.mod_runs (user_id, at desc);

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.user_mods enable row level security;
alter table public.mod_runs  enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                   and tablename = 'user_mods' and policyname = 'user_mods_own') then
    create policy user_mods_own on public.user_mods
      for all to authenticated
      using      (user_id = (select auth.uid()))
      with check (user_id = (select auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public'
                   and tablename = 'mod_runs' and policyname = 'mod_runs_own') then
    create policy mod_runs_own on public.mod_runs
      for all to authenticated
      using      (user_id = (select auth.uid()))
      with check (user_id = (select auth.uid()));
  end if;
end$$;

-- ── Privileges (not left to Supabase's default ALL) ──────────────────────────
-- REVOKE ALL also drops every column grant, so the revokes come first and the grants
-- below re-add exactly what is used: a re-run lands in the same state. user_mods: INSERT
-- on what a new row names (store, disabled_reason and the timestamps take their defaults),
-- UPDATE on what may move (id, user_id, kind, slug and created_at stay immutable;
-- updated_at is written only by the trigger), and no TRUNCATE. `store` is in the UPDATE
-- grant because mod_store_set runs as the caller (see OWNER-ASSERTED FIELDS). mod_runs:
-- INSERT on the four columns a claim names (the identity id and `at` take their defaults),
-- no UPDATE and no DELETE: a run is a record, not a draft, and a deleted claim would let
-- the same (mod_id, claim_key) run twice. Deleting a mod still removes its runs: the FK
-- cascade runs as the table owner. SELECT and INSERT only, as stake_events.
revoke all on table public.user_mods from public, anon, authenticated;
revoke all on table public.mod_runs  from public, anon, authenticated;

grant select, delete on table public.user_mods to authenticated;
grant insert (id, user_id, kind, slug, name, enabled, manifest, source) on public.user_mods to authenticated;
grant update (name, enabled, manifest, source, store, disabled_reason) on public.user_mods to authenticated;

grant select on table public.mod_runs to authenticated;
grant insert (user_id, mod_id, claim_key, summary) on public.mod_runs to authenticated;

grant all on table public.user_mods to service_role;
grant all on table public.mod_runs to service_role;

-- ── mod_store_set: one key of a mod's store ──────────────────────────────────
-- Arguments are p_-prefixed so they never shadow a column in the body; PostgREST matches
-- RPC arguments by name, so callers send {p_mod_id, p_key, p_value}. create or replace
-- cannot rename them: a rename is a drop and a new migration.
-- One key at a time, so two devices writing different keys never overwrite each other.
-- The row lock serialises two writes to one mod: the second waits, then merges into the
-- first one's result. A null (or JSON null) value deletes the key.
-- Returns {"status":"ok","bytes":n}
--       | {"status":"gone"}       (no such mod of yours)
--       | {"status":"too_big"}    (the store would pass 64KB; nothing is written).
create or replace function public.mod_store_set(p_mod_id uuid, p_key text, p_value jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_store jsonb;
begin
  -- 28000, not 42501 (057's reason: 42501 is every privilege and RLS refusal).
  if v_uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if p_key is null or char_length(p_key) not between 1 and 64 or p_key ~ '[[:cntrl:]]' then
    raise exception 'bad key' using errcode = '22023';
  end if;

  select case when p_value is null or p_value = 'null'::jsonb then m.store - p_key
              else jsonb_set(m.store, array[p_key], p_value, true) end
    into v_store
    from public.user_mods m
   where m.id = p_mod_id and m.user_id = v_uid
     for update;
  if not found then
    return jsonb_build_object('status', 'gone');
  end if;
  if octet_length(v_store::text) > 65536 then
    return jsonb_build_object('status', 'too_big');
  end if;

  update public.user_mods m
     set store = v_store
   where m.id = p_mod_id and m.user_id = v_uid;

  return jsonb_build_object('status', 'ok', 'bytes', octet_length(v_store::text));
end;
$$;

revoke all on function public.mod_store_set(uuid, text, jsonb) from public, anon;
grant execute on function public.mod_store_set(uuid, text, jsonb) to authenticated;

comment on table public.user_mods is
  'Recipes, mods, themes and Looks a person made (memory/plans/mods.md). Owner-only RLS. Saved switched off. Never exposed to /api/agent, MCP or lib/app-api.ts. manifest, source, store, enabled and disabled_reason are owner-asserted: validate on every load.';
comment on table public.mod_runs is
  'One row per recipe or mod run, claimed on (mod_id, claim_key) before any step runs. Owner-only RLS; the composite FK holds a run to a mod of the same user.';

-- PostgREST caches the schema; without this a freshly pushed table or function answers
-- PGRST205 / PGRST202 until the next reload, and every client latches "unavailable".
notify pgrst, 'reload schema';
