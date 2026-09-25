-- ─────────────────────────────────────────────────────────────────────────────
-- 000_baseline.sql — the tables and function the migrations tree assumes
--
-- WHY THIS EXISTS. The project was bootstrapped from supabase/schema.sql before
-- supabase/migrations/ existed, so 001 onward assume objects no migration
-- creates: 001 calls update_updated_at(), and 007/013/014/019 alter or copy
-- tasks, habits, projects and habit_groups. On the live project those came from
-- schema.sql long ago; on an EMPTY database (`supabase db reset`, a local stack,
-- CI) nothing creates them and the replay stops at 001. That is what kept
-- scripts/local-setup.sh from ever working, and why CI's E2E job ran against
-- production instead — which took prod down on 2026-09-24.
--
-- This is schema.sql's pre-007 bootstrap (lines 13–152) made re-runnable.
-- Every later change to these tables is already guarded (`add column if not
-- exists`, DO blocks), so replaying 001+ on top of it is clean.
--
-- ON THE LIVE PROJECT this is a no-op: every statement is `if not exists` or
-- `create or replace` with the same body. It is recorded in the remote ledger
-- as applied rather than run (it sorts before migrations already applied, so
-- `db push` would otherwise refuse it):
--   supabase migration repair --status applied 000
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists "uuid-ossp" with schema extensions;

create table if not exists projects (
  id uuid primary key default extensions.uuid_generate_v4(),
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  emoji text not null default '📁',
  repeat_frequency text default 'none',
  repeat_days int[] default '{}',
  repeat_month_day int,
  time_bucket text,
  start_time text,
  duration int,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, name)
);

create table if not exists habit_groups (
  id uuid primary key default extensions.uuid_generate_v4(),
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  emoji text not null default '⭐',
  color text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, name)
);

create table if not exists tasks (
  id uuid primary key default extensions.uuid_generate_v4(),
  user_id uuid references auth.users(id) on delete cascade not null,
  title text not null,
  priority text default 'medium',
  project text,
  start_date text, -- yyyy-MM-dd
  status text not null default 'pending',
  time_bucket text,
  start_time text, -- HH:mm
  duration int,
  is_scheduled boolean not null default false,
  repeat_frequency text default 'none',
  repeat_days int[] default '{}',
  repeat_month_day int,
  "order" int not null default 0,
  in_project_block boolean default false,
  previous_start_time text,
  previous_start_date text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists habits (
  id uuid primary key default extensions.uuid_generate_v4(),
  user_id uuid references auth.users(id) on delete cascade not null,
  title text not null,
  "group" text not null,
  streak int not null default 0,
  status text not null default 'pending',
  completed_dates text[] default '{}',
  skipped_dates text[] default '{}',
  daily_counts jsonb default '{}',
  time_bucket text,
  start_time text, -- HH:mm
  repeat_frequency text not null default 'daily',
  repeat_days int[] default '{}',
  repeat_month_day int,
  times_per_day int default 1,
  current_day_count int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table projects enable row level security;
alter table habit_groups enable row level security;
alter table tasks enable row level security;
alter table habits enable row level security;

do $$
declare
  t record;
begin
  for t in
    select * from (values
      ('projects',     'Users can manage their own projects'),
      ('habit_groups', 'Users can manage their own habit groups'),
      ('tasks',        'Users can manage their own tasks'),
      ('habits',       'Users can manage their own habits')
    ) as v(tbl, policy)
  loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t.tbl and policyname = t.policy
    ) then
      execute format(
        'create policy %I on public.%I for all using (auth.uid() = user_id) with check (auth.uid() = user_id)',
        t.policy, t.tbl
      );
    end if;
  end loop;
end;
$$;

create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists tasks_updated_at on tasks;
create trigger tasks_updated_at before update on tasks
  for each row execute function update_updated_at();

drop trigger if exists habits_updated_at on habits;
create trigger habits_updated_at before update on habits
  for each row execute function update_updated_at();

drop trigger if exists projects_updated_at on projects;
create trigger projects_updated_at before update on projects
  for each row execute function update_updated_at();

drop trigger if exists habit_groups_updated_at on habit_groups;
create trigger habit_groups_updated_at before update on habit_groups
  for each row execute function update_updated_at();
