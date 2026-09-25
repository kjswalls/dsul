-- ============================================================
-- Migration 002: User Settings + EOD Review
-- Run this after 001 (or alongside the initial schema if
-- user_settings doesn't exist yet).
-- ============================================================

-- Create user_settings table if it doesn't already exist
create table if not exists user_settings (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references auth.users(id) on delete cascade not null unique,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table user_settings enable row level security;

-- Policy (safe to re-run; will error if duplicate — wrap in DO block)
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'user_settings' and policyname = 'Users can manage their own settings'
  ) then
    execute $policy$
      create policy "Users can manage their own settings"
        on user_settings for all
        using (auth.uid() = user_id)
        with check (auth.uid() = user_id)
    $policy$;
  end if;
end;
$$;

-- Trigger (reuse the existing update_updated_at function from the main schema).
-- 001 already creates this trigger, so a clean replay (`supabase db reset`)
-- stopped here until the drop was added; applied databases never re-run this.
drop trigger if exists user_settings_updated_at on user_settings;
create trigger user_settings_updated_at before update on user_settings
  for each row execute function update_updated_at();

-- EOD review columns (idempotent)
alter table user_settings add column if not exists eod_review_enabled boolean default false;
alter table user_settings add column if not exists eod_review_time text default '21:00'; -- HH:mm local time
alter table user_settings add column if not exists last_eod_review_date text default null; -- yyyy-MM-dd
