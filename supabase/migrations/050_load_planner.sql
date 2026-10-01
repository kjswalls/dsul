-- ─────────────────────────────────────────────────────────────────────────────
-- 050_load_planner.sql — the whole planner load in one request
--
-- WHY. initializeStore's first load was six fetchers fanning out to TEN
-- PostgREST requests (items_windowed, projects, item_types, routines +
-- routine_items, seasons + season_items + season_routines, goals +
-- goal_items). On a cold page every one of them pays its own round trip, auth
-- check and connection checkout. This function answers all ten collections in
-- one round trip as a single jsonb object, and loadPlannerData (lib/db.ts) is
-- its only caller.
--
-- MIRRORS THE PER-TABLE FETCHERS — CHANGE ONE, CHANGE BOTH. Every filter and
-- ORDER BY below is a transcription of fetchItems, fetchProjects,
-- fetchItemTypes, fetchRoutines, fetchSeasons and fetchGoals in lib/db.ts.
-- Those fetchers are NOT dead: the reminders cron (lib/reminders/scan.ts) and
-- /api/agent/context read through them with the service client or agent auth,
-- where auth.uid() is null and this function would answer nothing, and the
-- client falls back to them when this function is missing. A filter or order
-- changed in only one place makes the two paths serve different planners.
-- `nulls last` is the SQL spelling of the fetchers' `nullsFirst: false`.
--
-- THE BODY MUST STAY A `$$` STRING, NEVER `BEGIN ATOMIC`. A string body
-- records no pg_depend rows, so it does not pin items_windowed. A
-- BEGIN ATOMIC (SQL-standard) body would, and rebuild_items_windowed() (031)
-- does a NON-cascade `drop view` — every later migration that adds an items
-- column and calls it would then fail. The static test
-- (tests/unit/load-planner-migration.test.ts) refuses `begin atomic`.
--
-- A MIGRATION THAT RENAMES OR DROPS ANY RELATION THIS FUNCTION READS MUST
-- `create or replace` IT IN THE SAME FILE. Nothing else will notice: the
-- function raises 42P01 at call time, the client reads that as "050 not
-- applied", latches onto the ten-request fallback, and the only signal is a
-- console.warn. 046 (programs → seasons) is exactly the kind of rename that
-- would have done this silently. The static test pins the relation list, and
-- an e2e assertion pins that the load actually takes this path.
--
-- SECURITY INVOKER IS LOAD-BEARING, for the same reason 031 built
-- items_windowed with security_invoker: every read below runs under the
-- caller's RLS, so the `user_id = auth.uid()` filters are a mirror of the
-- fetchers' `.eq('user_id', …)`, not the access control. A definer function
-- here would be a second, hand-maintained copy of every table's policy.
-- `(select auth.uid())` is evaluated once as an initPlan rather than per row
-- (Supabase's own RLS guidance), which matters on a cold nano instance.
--
-- `limit 1000` per collection mirrors PostgREST's db-max-rows (Supabase's
-- default), which silently caps each per-table request today. Lifting it here
-- alone would make the two paths truncate at different points.
--
-- anon is revoked: an anon call would answer ten empty arrays, which reads to
-- the client as a successful empty load — and first-run seeding is gated on
-- exactly that (supabase-provider.tsx). Failing loudly is the safe answer.
--
-- Idempotent (`create or replace`, revoke/grant are re-runnable), and replays
-- onto an empty database: items_windowed exists from 031 (rebuilt by later
-- migrations), item_types from 021, routines/seasons from 024 + 046, goals from
-- 036 — all before 050.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.load_planner()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    -- The shape version. The client treats anything but 1 as "unknown shape"
    -- and falls back to the per-table load rather than misreading it.
    'v', 1,
    -- Whose rows these are. The client refuses an answer for a different
    -- session than the one it is loading, which would otherwise land as an
    -- empty "successful" load for the wrong account.
    'uid', (select auth.uid()),
    -- fetchItems: items_windowed (never the base table — 031 trims the date
    -- arrays there), live rows, order asc nulls last, created_at asc.
    'items', coalesce((
      select jsonb_agg(to_jsonb(r) order by r."order" asc nulls last, r.created_at asc)
        from (select w.* from public.items_windowed w
               where w.user_id = (select auth.uid()) and w.deleted_at is null
               order by w."order" asc nulls last, w.created_at asc
               limit 1000) r
    ), '[]'::jsonb),
    -- fetchProjects: live rows, created_at asc, id asc.
    'projects', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at asc, r.id asc)
        from (select p.* from public.projects p
               where p.user_id = (select auth.uid()) and p.deleted_at is null
               order by p.created_at asc, p.id asc
               limit 1000) r
    ), '[]'::jsonb),
    -- fetchItemTypes: no soft delete on this table, created_at asc.
    'item_types', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at asc)
        from (select t.* from public.item_types t
               where t.user_id = (select auth.uid())
               order by t.created_at asc
               limit 1000) r
    ), '[]'::jsonb),
    -- fetchRoutines: live rows, sort_order asc nulls last, created_at asc.
    'routines', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.sort_order asc nulls last, r.created_at asc)
        from (select x.* from public.routines x
               where x.user_id = (select auth.uid()) and x.deleted_at is null
               order by x.sort_order asc nulls last, x.created_at asc
               limit 1000) r
    ), '[]'::jsonb),
    -- fetchRoutines' member read: sort_order asc nulls last, item_id tiebreak.
    'routine_items', coalesce((
      select jsonb_agg(jsonb_build_object('routine_id', m.routine_id, 'item_id', m.item_id, 'sort_order', m.sort_order)
                       order by m.sort_order asc nulls last, m.item_id asc)
        from (select ri.* from public.routine_items ri
               where ri.user_id = (select auth.uid())
               order by ri.sort_order asc nulls last, ri.item_id asc
               limit 1000) m
    ), '[]'::jsonb),
    -- fetchSeasons: live rows, sort_order asc nulls last, created_at asc.
    'seasons', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.sort_order asc nulls last, r.created_at asc)
        from (select x.* from public.seasons x
               where x.user_id = (select auth.uid()) and x.deleted_at is null
               order by x.sort_order asc nulls last, x.created_at asc
               limit 1000) r
    ), '[]'::jsonb),
    -- fetchSeasons' member reads: no sort_order on season membership, so the
    -- member id alone, for stability.
    'season_items', coalesce((
      select jsonb_agg(jsonb_build_object('season_id', m.season_id, 'item_id', m.item_id)
                       order by m.item_id asc)
        from (select si.* from public.season_items si
               where si.user_id = (select auth.uid())
               order by si.item_id asc
               limit 1000) m
    ), '[]'::jsonb),
    'season_routines', coalesce((
      select jsonb_agg(jsonb_build_object('season_id', m.season_id, 'routine_id', m.routine_id)
                       order by m.routine_id asc)
        from (select sr.* from public.season_routines sr
               where sr.user_id = (select auth.uid())
               order by sr.routine_id asc
               limit 1000) m
    ), '[]'::jsonb),
    -- fetchGoals: live rows, sort_order asc nulls last, created_at asc.
    'goals', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.sort_order asc nulls last, r.created_at asc)
        from (select x.* from public.goals x
               where x.user_id = (select auth.uid()) and x.deleted_at is null
               order by x.sort_order asc nulls last, x.created_at asc
               limit 1000) r
    ), '[]'::jsonb),
    -- fetchGoals' member read: sort_order asc nulls last, item_id tiebreak
    -- (which orders the member and checkin arrays, whose sort_order is null).
    'goal_items', coalesce((
      select jsonb_agg(jsonb_build_object('goal_id', m.goal_id, 'item_id', m.item_id, 'role', m.role, 'sort_order', m.sort_order)
                       order by m.sort_order asc nulls last, m.item_id asc)
        from (select gi.* from public.goal_items gi
               where gi.user_id = (select auth.uid())
               order by gi.sort_order asc nulls last, gi.item_id asc
               limit 1000) m
    ), '[]'::jsonb)
  );
$$;

comment on function public.load_planner() is
  'The planner''s first load in one round trip: items (via items_windowed), '
  'projects, item_types, routines + routine_items, seasons + season_items + '
  'season_routines, goals + goal_items for auth.uid(), as one jsonb object '
  '{v:1, uid, ...}. SECURITY INVOKER — RLS applies. Mirrors the per-table '
  'fetchers in lib/db.ts: change one, change both. Keep the body a $$ string '
  '(never BEGIN ATOMIC — see rebuild_items_windowed). A migration that renames '
  'or drops a relation read here must create or replace this function.';

revoke all on function public.load_planner() from public, anon;
grant execute on function public.load_planner() to authenticated;

-- PostgREST caches the schema; without this a freshly pushed function answers
-- PGRST202 until the next reload, and every tab latches onto the fallback.
notify pgrst, 'reload schema';
