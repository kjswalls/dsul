-- 084_planner_realtime.sql — live sync across devices.
--
-- Puts the planner's tables in the `supabase_realtime` publication, so an open
-- planner hears another device's change as it happens (lib/planner-live.ts) and
-- folds it in through the same merge a focus catch-up uses (catchUpPlanner in
-- lib/planner-store.ts). Nothing else changes: Realtime checks each change
-- against the subscriber's own RLS, and the client filters on user_id, so a
-- channel only ever hears its owner's rows.
--
-- Idempotent and safe on an empty database: the publication is created when it
-- is missing (a stack without the Realtime service), and each table is added
-- only when it exists and is not already in it.

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  foreach t in array array[
    'items', 'projects', 'routines', 'seasons', 'goals', 'item_types',
    'routine_items', 'season_items', 'season_routines', 'goal_items'
  ] loop
    if to_regclass('public.' || t) is not null
       and not exists (
         select 1 from pg_publication_tables
         where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
       ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end$$;
