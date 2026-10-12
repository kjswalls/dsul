-- ─────────────────────────────────────────────────────────────────────────────
-- 074_prep_packs.sql — what the AI got ready for an item (Do stuff's
-- "done for you" lane, memory/plans/power-mode.md, build order 3)
--
-- WHY. Power mode's prep packs: for a braindump thing the user's own model can
-- get ready (an email or message draft, a call script, the first few steps),
-- it writes the draft once and the user takes it from there with one tap.
-- Nothing leaves the app without that tap. Kept, so a pack made on the laptop
-- is there on the phone and is not paid for twice.
--
-- WHAT.
--   prep_packs   one row per item at most (the item is the key). `kind` names
--                the shape, `body` holds its fields (lib/prep-packs.ts is the
--                schema, re-checked on every read), `made_for` is the title the
--                pack was written for, so a renamed item can say its pack is
--                stale. Owner-only RLS; written by /api/ai/prep through the
--                session client, never the service role.
--
-- Deleting the item deletes its pack, and deleting the account deletes both
-- (user_id cascades from auth.users, 063's rule).
--
-- Cap: 200 packs an account (a BEFORE INSERT trigger), so a loop in a client
-- cannot fill a table nobody reads.
--
-- Idempotent; replays onto an empty database.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.prep_packs (
  item_id     uuid primary key references public.items (id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind        text not null,
  body        jsonb not null,
  made_for    text not null,
  model       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'prep_packs_kind_check') then
    alter table public.prep_packs add constraint prep_packs_kind_check
      check (kind in ('email', 'message', 'call', 'steps'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'prep_packs_body_check') then
    alter table public.prep_packs add constraint prep_packs_body_check
      check (jsonb_typeof(body) = 'object' and octet_length(body::text) <= 16000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'prep_packs_made_for_check') then
    alter table public.prep_packs add constraint prep_packs_made_for_check
      check (char_length(made_for) <= 500);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'prep_packs_model_check') then
    alter table public.prep_packs add constraint prep_packs_model_check
      check (model is null or char_length(model) <= 200);
  end if;
end$$;

create index if not exists prep_packs_user_idx on public.prep_packs (user_id, updated_at);

alter table public.prep_packs enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                   and tablename = 'prep_packs' and policyname = 'prep_packs_own') then
    create policy prep_packs_own on public.prep_packs
      for all to authenticated
      using (user_id = (select auth.uid()))
      with check (
        user_id = (select auth.uid())
        and exists (select 1 from public.items i where i.id = item_id and i.user_id = (select auth.uid()))
      );
  end if;
end$$;

revoke all on table public.prep_packs from public, anon, authenticated;
grant select, delete on table public.prep_packs to authenticated;
grant insert (item_id, kind, body, made_for, model) on public.prep_packs to authenticated;
grant update (kind, body, made_for, model, updated_at) on public.prep_packs to authenticated;
grant all on table public.prep_packs to service_role;

-- ── The cap ──────────────────────────────────────────────────────────────────

create or replace function public.prep_packs_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  on_user integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('prep_packs:' || new.user_id::text, 0));
  -- An upsert over an existing pack replaces it; it never counts as a new one.
  if exists (select 1 from public.prep_packs where item_id = new.item_id) then
    return new;
  end if;
  select count(*) into on_user from public.prep_packs where user_id = new.user_id;
  if on_user >= 200 then
    raise exception 'prep_packs_limit' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.prep_packs_cap() from public, anon, authenticated;

drop trigger if exists prep_packs_cap on public.prep_packs;
create trigger prep_packs_cap
  before insert on public.prep_packs
  for each row execute function public.prep_packs_cap();
