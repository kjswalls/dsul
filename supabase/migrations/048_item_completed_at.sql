-- 048_item_completed_at: when a one-off item was completed.
--
-- A one-off task records completion as `status = 'completed'` and nothing else.
-- Recurring items carry per-date `completed_dates`; one-offs never have. That
-- was enough while "done" only had to be drawn, but finished items in the
-- braindump now get filed onto the day they were finished
-- (lib/completion-filing.ts), and "which day" is a question the row could not
-- answer. `updated_at` is not that answer on its own: any later edit moves it.
--
-- STAMPED BY A TRIGGER, NOT BY THE APP. Completion reaches this table through
-- the store's toggle, the bulk verb, the EOD review, undo/redo, the agent API
-- and the OpenClaw plugin — a list that would be wrong within a month if each
-- writer had to remember a companion column. The trigger also sees OLD, which
-- the app's row mappers do not: the item dialog's whole-item save names
-- `status` on every edit, and a companion write would re-date a task finished
-- last week to the moment someone fixed a typo in it. Here only a TRANSITION
-- into 'completed' stamps, and any other status clears.
--
-- Kept out of the shared Item schema (packages/types) on purpose, for the
-- reasons TrashEntry gives for `deletedAt` in lib/db.ts: a field in taskShape
-- enrols in TASK_FIELDS, so undo would carry it and the frozen `tasks[]`
-- projection would publish it. The one reader fetches it by id
-- (fetchCompletedAt in lib/db.ts). Idempotent, per the repo rule.

alter table public.items
  add column if not exists completed_at timestamptz;

comment on column public.items.completed_at is
  'When status last became completed. Trigger-maintained (items_completed_at); cleared when status leaves completed.';

-- BACKFILLED FROM updated_at, unlike 041's ai_status_at, and the difference is
-- the cost of a wrong number. There a stale seed under-reported a stuck agent
-- and hid the very thing the column exists to surface. Here the alternative to
-- a seed is that every item finished before today stays in the braindump
-- forever — the exact pile this change exists to clear — while a seed that is
-- off by an edit files a finished item a few days late. For a completed row
-- the last edit is usually the completion itself. Runs before the trigger
-- exists, and the trigger fires only on `update of status` anyway.
update public.items
  set completed_at = coalesce(updated_at, created_at, now())
  where status = 'completed'
    and completed_at is null;

create or replace function public.stamp_item_completed_at()
returns trigger as $$
begin
  if new.status = 'completed' then
    if tg_op = 'INSERT' then
      new.completed_at := coalesce(new.completed_at, now());
    elsif old.status is distinct from 'completed' then
      new.completed_at := now();
    end if;
    -- status named but unchanged: the stamp stands.
  else
    new.completed_at := null;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists items_completed_at on public.items;
create trigger items_completed_at
  before insert or update of status on public.items
  for each row execute function public.stamp_item_completed_at();

-- items_windowed freezes its column list; 031's rule is that any migration
-- adding a column to items ends by rebuilding it. Guarded so the file still
-- applies to a database predating 031.
do $$
begin
  if to_regprocedure('public.rebuild_items_windowed()') is not null then
    perform public.rebuild_items_windowed();
  end if;
end$$;
