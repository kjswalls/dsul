-- ─────────────────────────────────────────────────────────────────────────────
-- 073_item_files.sql — files kept on an item
--
-- WHY. A task often comes with a thing: the form to fill in, the receipt, the
-- photo of the part. dsul's first STORED user files (chat pictures are sent
-- and never kept, 070). A private Storage bucket holds the bytes; one row per
-- file here says whose it is, which item it is on, and what it is called.
--
-- WHAT.
--   storage bucket 'item-files'   private, 10 MB a file. Objects live at
--                                 `<user_id>/<file id>`: no file name in the
--                                 path, so nothing about a file outlives its row.
--   item_files                    the rows. Owner-only RLS, written by the
--                                 browser's session client (lib/item-files.ts),
--                                 never the service role. `ready` turns true
--                                 once the bytes are up; a row still not ready
--                                 a day later is swept.
--   storage_sweep                 paths whose row is gone, waiting for the
--                                 Storage API to delete the bytes. Service role
--                                 only, no user column.
--
-- THE ORDER IS ROW, THEN BYTES. Storage's own policies below let an object be
-- written, read or deleted only where a row of yours names its exact path, so
-- an upload without a row is refused and a file is reachable exactly while its
-- row exists.
--
-- DELETION NEVER WAITS ON STORAGE. Postgres may not delete Storage objects
-- itself (Supabase blocks direct deletes from storage.objects), so every way a
-- row goes (its Delete in the panel, its item purged from the trash after 30
-- days, the account deleted) queues its path in storage_sweep from an AFTER
-- DELETE trigger, inside the same transaction. The reminders cron's sweep tier
-- (lib/item-files-sweep.ts) removes queued bytes through the Storage API every
-- tick. So deleting an account stays ONE call (memory/plans/account-deletion.md):
-- user_id cascades from auth.users (063's rule), the rows go with it, and the
-- bytes follow within minutes.
--
-- Caps (a BEFORE INSERT trigger): 20 files an item, 200 an account, 500 MB an
-- account. `size` is the browser's word, checked against the bucket's 10 MB.
--
-- Idempotent; replays onto an empty database.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── The bucket ───────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit)
values ('item-files', 'item-files', false, 10485760)
on conflict (id) do nothing;

-- ── The rows ─────────────────────────────────────────────────────────────────

create table if not exists public.item_files (
  id          uuid primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  item_id     uuid not null references public.items (id) on delete cascade,
  name        text not null,
  mime        text not null default 'application/octet-stream',
  size        bigint not null,
  path        text not null,
  ready       boolean not null default false,
  created_at  timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'item_files_name_check') then
    alter table public.item_files add constraint item_files_name_check
      check (char_length(name) between 1 and 200);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'item_files_mime_check') then
    alter table public.item_files add constraint item_files_mime_check
      check (char_length(mime) between 1 and 200);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'item_files_size_check') then
    alter table public.item_files add constraint item_files_size_check
      check (size between 1 and 10485760);
  end if;
  -- The path is derived, never chosen: the policies on storage.objects trust it.
  if not exists (select 1 from pg_constraint where conname = 'item_files_path_check') then
    alter table public.item_files add constraint item_files_path_check
      check (path = user_id::text || '/' || id::text);
  end if;
end$$;

create unique index if not exists item_files_path_idx on public.item_files (path);
create index if not exists item_files_item_idx on public.item_files (item_id, created_at);
create index if not exists item_files_user_idx on public.item_files (user_id);

alter table public.item_files enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                   and tablename = 'item_files' and policyname = 'item_files_own') then
    create policy item_files_own on public.item_files
      for all to authenticated
      using (user_id = (select auth.uid()))
      with check (
        user_id = (select auth.uid())
        and exists (select 1 from public.items i where i.id = item_id and i.user_id = (select auth.uid()))
      );
  end if;
end$$;

revoke all on table public.item_files from public, anon, authenticated;
grant select, delete on table public.item_files to authenticated;
grant insert (id, item_id, name, mime, size, path) on public.item_files to authenticated;
grant update (ready) on public.item_files to authenticated;
grant all on table public.item_files to service_role;

-- ── The caps ─────────────────────────────────────────────────────────────────

create or replace function public.item_files_caps()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  on_item  integer;
  on_user  integer;
  bytes    bigint;
begin
  -- One account's writes at a time, so two uploads cannot both pass the caps.
  perform pg_advisory_xact_lock(hashtextextended('item_files:' || new.user_id::text, 0));
  select count(*) into on_item from public.item_files where item_id = new.item_id;
  if on_item >= 20 then
    raise exception 'item_files_limit_item' using errcode = 'P0001';
  end if;
  select count(*), coalesce(sum(size), 0) into on_user, bytes from public.item_files where user_id = new.user_id;
  if on_user >= 200 then
    raise exception 'item_files_limit_files' using errcode = 'P0001';
  end if;
  if bytes + new.size > 524288000 then
    raise exception 'item_files_limit_bytes' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.item_files_caps() from public, anon, authenticated;

drop trigger if exists item_files_caps on public.item_files;
create trigger item_files_caps
  before insert on public.item_files
  for each row execute function public.item_files_caps();

-- ── The sweep queue ──────────────────────────────────────────────────────────

create table if not exists public.storage_sweep (
  bucket     text not null,
  path       text not null,
  queued_at  timestamptz not null default now(),
  primary key (bucket, path)
);

create index if not exists storage_sweep_queued_idx on public.storage_sweep (queued_at);

alter table public.storage_sweep enable row level security;
revoke all on public.storage_sweep from public, anon, authenticated;
grant all on table public.storage_sweep to service_role;

create or replace function public.item_files_queue_sweep()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.storage_sweep (bucket, path)
  values ('item-files', old.path)
  on conflict (bucket, path) do nothing;
  return old;
end;
$$;

revoke all on function public.item_files_queue_sweep() from public, anon, authenticated;

drop trigger if exists item_files_queue_sweep on public.item_files;
create trigger item_files_queue_sweep
  after delete on public.item_files
  for each row execute function public.item_files_queue_sweep();

-- ── Storage's own policies: a file of yours is reachable exactly while its row is ──
-- `objects.name`, qualified: inside the subquery a bare `name` is item_files'
-- own name column (the file's name), and every path check would fail.

drop policy if exists item_files_read on storage.objects;
create policy item_files_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'item-files'
    and exists (select 1 from public.item_files f
                 where f.path = objects.name and f.user_id = (select auth.uid()))
  );

drop policy if exists item_files_write on storage.objects;
create policy item_files_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'item-files'
    and exists (select 1 from public.item_files f
                 where f.path = objects.name and f.user_id = (select auth.uid()) and not f.ready)
  );

drop policy if exists item_files_delete on storage.objects;
create policy item_files_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'item-files'
    and exists (select 1 from public.item_files f
                 where f.path = objects.name and f.user_id = (select auth.uid()))
  );

comment on table public.item_files is
  'Files kept on an item. Bytes in the private item-files bucket at <user_id>/<id>; rows owner-only; a deleted row queues its bytes in storage_sweep.';
comment on table public.storage_sweep is
  'Storage paths whose row is gone. The reminders cron removes them through the Storage API. Service role only.';
