-- 062_account_deletion: deleting the auth user deletes everything (memory/plans/account-deletion.md).
--
-- WHY. Account deletion is one call, GoTrue's admin delete (DELETE /auth/v1/admin/users/{id}), and the
-- foreign keys do the rest: every table that holds a user's data cascades from auth.users. Two keys did
-- not, and this changes exactly those two.
--
-- 1. bug_reports.supabase_user_id was ON DELETE SET NULL (006), so a deleted account left a row with
--    its email in user_email. It cascades now. The rows earlier deletions left (a null
--    supabase_user_id beside an email: /api/bug-report writes both from one user, so only a deleted
--    account leaves that shape) are deleted once, here.
-- 2. tasks.parent_task_id (007) had no ON DELETE action. Within one account the cascade deletes parent
--    and child in one statement and passes, but a task whose parent belongs to ANOTHER account (only a
--    forged row can be one: a foreign key check skips RLS) aborted that other account's deletion. It is
--    ON DELETE SET NULL now, as items.parent_item_id has been since 019. tasks is frozen ballast; this
--    changes only its constraint.
--
-- Both are found by column, not by name, so a database whose constraints were named differently is
-- fixed too. Nothing else changes: tests/unit/account-deletion-migration.test.ts pins the rest, and
-- scripts/verify-062.sh replays 000-062 and deletes seeded users.
--
-- DEPLOY ORDER. Either side of the app build. Apply to prod only on Kirby's typed OK, after
-- `pnpm db:list` shows the remote at 061. If applied out-of-band, record ledger version 062.
--
-- Idempotent and replayable onto an empty database.

do $$
declare
  c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
     where con.conrelid = 'public.bug_reports'::regclass and con.contype = 'f'
       and att.attname = 'supabase_user_id' and con.confdeltype <> 'c'
  loop
    execute format('alter table public.bug_reports drop constraint %I', c.conname);
  end loop;
  if not exists (
    select 1
      from pg_constraint con
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
     where con.conrelid = 'public.bug_reports'::regclass and con.contype = 'f'
       and att.attname = 'supabase_user_id'
  ) then
    alter table public.bug_reports add constraint bug_reports_supabase_user_id_fkey
      foreign key (supabase_user_id) references auth.users (id) on delete cascade;
  end if;
end$$;

delete from public.bug_reports where supabase_user_id is null and user_email is not null;

do $$
declare
  c record;
begin
  if to_regclass('public.tasks') is null then
    return;
  end if;
  for c in
    select con.conname
      from pg_constraint con
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
     where con.conrelid = 'public.tasks'::regclass and con.contype = 'f'
       and att.attname = 'parent_task_id' and con.confdeltype <> 'n'
  loop
    execute format('alter table public.tasks drop constraint %I', c.conname);
  end loop;
  if not exists (
    select 1
      from pg_constraint con
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
     where con.conrelid = 'public.tasks'::regclass and con.contype = 'f'
       and att.attname = 'parent_task_id'
  ) then
    alter table public.tasks add constraint tasks_parent_task_id_fkey
      foreign key (parent_task_id) references public.tasks (id) on delete set null;
  end if;
end$$;
