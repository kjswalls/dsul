-- ─────────────────────────────────────────────────────────────────────────────
-- 081_item_files_added_by.sql — who added a file kept on an item
--
-- WHY. An agent (OpenClaw, a connected app, a named agent key) can now attach a
-- file it made or found to one of the user's items (MCP `dsul_attach_file`), and
-- the item's timeline says who added each file ("OpenClaw attached Draft.pdf").
-- The card is drawn from the item_files row, never from item_events: an event's
-- payload is served to agents unfiltered, outlives the file by up to 180 days,
-- and would turn an agent's file back into "You" once it was purged.
--
-- WHAT.
--   item_files.added_by   NULL: you, through the session client. Otherwise the
--                         agent's name: its queue name ('openclaw', an app's
--                         assignee value), or a single space for an agent with
--                         no name (lib/item-files.ts UNNAMED_AGENT; no real
--                         name can be blank).
--   item_files_added_by   a BEFORE INSERT OR UPDATE trigger: for any role but
--                         service_role, a new row's added_by is forced to NULL
--                         and an update keeps the old value. So a browser can
--                         never claim to be an agent, whatever a later grant
--                         says (a column REVOKE would not do this: it does not
--                         subtract from a table-level grant).
--
-- THE ONE SERVICE-ROLE WRITER. 073 says item_files rows are written by the
-- session client, never the service role. The deliberate exception is the one
-- agent route, POST /api/agent/items/:id/files (lib/item-files-server.ts), which
-- writes as the service role with the user id taken from the key, the path
-- built from a server UUID (073's path CHECK and unique index hold it to
-- `<user_id>/<id>`), and row, then bytes, then ready. 073's caps trigger fires
-- for it too, and its sweep trigger queues the bytes of every deleted row.
--
-- 073 is not edited. No user column is added, so account deletion is unchanged.
--
-- Idempotent; replays onto an empty database (073 runs first).
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.item_files add column if not exists added_by text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'item_files_added_by_len') then
    alter table public.item_files
      add constraint item_files_added_by_len
      check (added_by is null or char_length(added_by) between 1 and 200);
  end if;
end$$;

-- SECURITY INVOKER on purpose: current_user is the caller's role, service_role
-- only for the service key (PostgREST sets the role from the key).
create or replace function public.item_files_added_by()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'service_role' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.added_by := null;
  else
    new.added_by := old.added_by;
  end if;
  return new;
end;
$$;

revoke all on function public.item_files_added_by() from public, anon, authenticated;

drop trigger if exists item_files_added_by on public.item_files;
create trigger item_files_added_by
  before insert or update on public.item_files
  for each row execute function public.item_files_added_by();

comment on column public.item_files.added_by is
  'NULL: added by the user. Else the agent (queue name, or a single space for an unnamed agent) that added it through POST /api/agent/items/:id/files. Only service_role can set it (trigger item_files_added_by).';
