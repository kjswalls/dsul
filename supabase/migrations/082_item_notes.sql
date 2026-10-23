-- ─────────────────────────────────────────────────────────────────────────────
-- 082_item_notes.sql — notes on an item's timeline
--
-- WHY. The item conversations design, option B: a note is something you write
-- on an item from the same box as Ask ("Ask / Note"). It is saved to the item
-- and never sent to a model. It sits on the timeline at the time you wrote it;
-- the one you pin stays at the top as "Note · pinned". The description under
-- the title (items.notes) is unchanged: that is the field you and the agents
-- share; these are yours.
--
-- NOT item_events. That table is a trace: purged at 180 days (030), served to
-- agents unfiltered (/api/agent/items/:id/events, MCP dsul_item_activity), and
-- read 50 rows at a time. A note is user content and outlives all three. No
-- event is written for a note, its edit, its pin or its delete, and no agent
-- route, MCP tool, chat context or model call reads this table.
--
-- WHAT.
--   item_notes      one row per note. Owner-only RLS, written by the browser's
--                   session client (lib/item-notes.ts), never the service role.
--                   item_id cascades from items: notes follow their item into
--                   the trash (soft delete keeps them) and go with its purge.
--                   user_id cascades from auth.users (063's rule).
--   one pinned      a partial unique index on (item_id) where pinned_at is set.
--   item_note_pin   unpins the item's other note and pins this one in one
--                   transaction under a per-item lock (a one-statement swap can
--                   trip the unique index row by row). SECURITY INVOKER: RLS
--                   applies. It is the only way to pin: the touch trigger
--                   refuses a pin it did not flag (dsul.pin).
--
-- Caps (a BEFORE INSERT trigger): 200 notes an item, 5,000 an account, counted
-- only for an item of the caller's (RLS refuses the rest, and a count must not
-- answer for another user's item).
-- Body: 1 to 10,000 characters (code points), at least one non-space; the
-- client refuses past it, never clips. The touch trigger stamps updated_at,
-- edited_at (body changes only) and pinned_at (now(), whatever the client
-- sent). On a purged item an insert fails the policy (42501) before the FK.
--
-- Idempotent; replays onto an empty database.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.item_notes (
  id          uuid primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  item_id     uuid not null references public.items (id) on delete cascade,
  body        text not null,
  pinned_at   timestamptz,
  edited_at   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'item_notes_body_check') then
    alter table public.item_notes add constraint item_notes_body_check
      check (char_length(body) between 1 and 10000 and body ~ '\S');
  end if;
end$$;

create unique index if not exists item_notes_one_pinned
  on public.item_notes (item_id) where pinned_at is not null;
create index if not exists item_notes_item_idx on public.item_notes (item_id, created_at);
create index if not exists item_notes_user_idx on public.item_notes (user_id);

alter table public.item_notes enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                   and tablename = 'item_notes' and policyname = 'item_notes_own') then
    create policy item_notes_own on public.item_notes
      for all to authenticated
      using (user_id = (select auth.uid()))
      with check (
        user_id = (select auth.uid())
        and exists (select 1 from public.items i where i.id = item_id and i.user_id = (select auth.uid()))
      );
  end if;
end$$;

-- REVOKE ALL drops every column grant too, so a re-run lands in the same state.
revoke all on table public.item_notes from public, anon, authenticated;
grant select, delete on table public.item_notes to authenticated;
grant insert (id, item_id, body) on public.item_notes to authenticated;
grant update (body, pinned_at) on public.item_notes to authenticated;
grant all on table public.item_notes to service_role;

-- ── Touch: updated_at always, edited_at on a new body, pinned_at = now() on a pin ──

create or replace function public.item_notes_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  if new.body is distinct from old.body then
    new.edited_at := now();
  end if;
  if new.pinned_at is not null and old.pinned_at is null then
    -- Only item_note_pin pins: it holds the per-item lock and swaps the old pin
    -- off first. A bare client update cannot set dsul.pin (no RPC exposes
    -- set_config), so it is refused here.
    if coalesce(current_setting('dsul.pin', true), '') <> 'on' then
      raise exception 'item_notes_pin_via_rpc' using errcode = '42501';
    end if;
    new.pinned_at := now();
  elsif new.pinned_at is not null then
    new.pinned_at := old.pinned_at;   -- a pin is stamped once, never moved by a client
  end if;
  return new;
end;
$$;

revoke all on function public.item_notes_touch() from public, anon, authenticated;

drop trigger if exists item_notes_touch on public.item_notes;
create trigger item_notes_touch
  before update on public.item_notes
  for each row execute function public.item_notes_touch();

-- ── Caps ─────────────────────────────────────────────────────────────────────

create or replace function public.item_notes_caps()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  on_item integer;
  on_user integer;
begin
  -- A new note is never born pinned or edited: pinning is item_note_pin's job.
  new.pinned_at := null;
  new.edited_at := null;
  -- Not the caller's item (or no such item): count nothing and let RLS refuse
  -- the row, so this definer function never reports on another user's item.
  if not exists (select 1 from public.items i
                  where i.id = new.item_id and i.user_id = new.user_id) then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('item_notes:' || new.user_id::text, 0));
  select count(*) into on_item from public.item_notes where item_id = new.item_id;
  if on_item >= 200 then
    raise exception 'item_notes_item_limit' using errcode = 'P0001';
  end if;
  select count(*) into on_user from public.item_notes where user_id = new.user_id;
  if on_user >= 5000 then
    raise exception 'item_notes_account_limit' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.item_notes_caps() from public, anon, authenticated;

drop trigger if exists item_notes_caps on public.item_notes;
create trigger item_notes_caps
  before insert on public.item_notes
  for each row execute function public.item_notes_caps();

-- ── Pin: one per item, swapped in one transaction ────────────────────────────

create or replace function public.item_note_pin(p_note uuid)
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_item uuid;
  v_at   timestamptz;
begin
  -- RLS: only a note of yours is found.
  select item_id into v_item from public.item_notes where id = p_note;
  if v_item is null then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('item_notes_pin:' || v_item::text, 0));
  -- Transaction-local: the touch trigger lets this transaction's pin through.
  perform set_config('dsul.pin', 'on', true);
  update public.item_notes set pinned_at = null
    where item_id = v_item and pinned_at is not null and id <> p_note;
  update public.item_notes set pinned_at = coalesce(pinned_at, now())
    where id = p_note
    returning pinned_at into v_at;
  return v_at;
end;
$$;

revoke all on function public.item_note_pin(uuid) from public, anon;
grant execute on function public.item_note_pin(uuid) to authenticated;

comment on table public.item_notes is
  'Notes a user writes on an item''s timeline. Session client only; never sent to a model; not in agent reads or MCP.';
