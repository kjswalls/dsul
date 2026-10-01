-- 050_extension_toggle_events.sql
--
-- What the extensions store needs to say "kept on by 81% after 30 days".
--
-- user_extensions holds only the CURRENT switch per user (sparse — a missing row
-- is the manifest default), and neither of its timestamps means "turned on":
-- created_at is the first touch of the toggle OR the config, and updated_at
-- moves on every config save too. So this adds an append-only history of
-- switches, written by a trigger, and one aggregate function the store's route
-- reads through the service role.
--
-- Privacy shape: the history is per-user and readable only by its owner (RLS).
-- Nothing crosses users except extension_adoption(), which returns COUNTS per
-- slug and is executable by the service role only. The route that calls it
-- (/api/extensions/adoption) turns counts into rounded fractions and withholds
-- any figure built on too few people, so a number on a card can never be read
-- back to one account.
--
-- Idempotent, and replays onto an empty database (supabase db reset).

create table if not exists public.extension_toggle_events (
  id bigserial primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  slug text not null,
  enabled boolean not null,
  at timestamptz not null default now(),
  -- Rows written by the one-off backfill below. Their `at` is a guess (the
  -- row's updated_at), and they only exist for people who still have the
  -- extension on — so they would make every backfilled user a "keeper". The
  -- kept-on rate leaves them out entirely.
  backfilled boolean not null default false
);

create index if not exists extension_toggle_events_slug_user_at
  on public.extension_toggle_events (slug, user_id, at);

alter table public.extension_toggle_events enable row level security;

-- Read your own history; nobody writes it but the trigger.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'extension_toggle_events' and policyname = 'Users can read their own extension history'
  ) then
    create policy "Users can read their own extension history"
      on public.extension_toggle_events for select
      using (auth.uid() = user_id);
  end if;
end$$;

-- ─── The writer ──────────────────────────────────────────────────────────────
-- Both client write paths are upserts on (user_id, slug) under RLS
-- (lib/db.ts setUserExtensionEnabled / setUserExtensionConfig). An upsert that
-- hits the conflict fires only the UPDATE trigger; `update of enabled` fires
-- whenever `enabled` is in the SET list, so `is distinct from` is what keeps a
-- same-value re-save out of the history. A config-only save never sends
-- `enabled` and never fires this. A first-touch INSERT logs only when it turns
-- the extension ON: a config-only first touch inserts enabled=false, and that
-- is not a switch anyone flipped.
create or replace function public.log_extension_toggle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.enabled then
      insert into public.extension_toggle_events (user_id, slug, enabled)
      values (new.user_id, new.slug, true);
    end if;
  elsif new.enabled is distinct from old.enabled then
    insert into public.extension_toggle_events (user_id, slug, enabled)
    values (new.user_id, new.slug, new.enabled);
  end if;
  return null;
end;
$$;

revoke all on function public.log_extension_toggle() from public, anon, authenticated;

drop trigger if exists user_extensions_log_toggle on public.user_extensions;
create trigger user_extensions_log_toggle
  after insert or update of enabled on public.user_extensions
  for each row execute function public.log_extension_toggle();

-- ─── Backfill, once ──────────────────────────────────────────────────────────
-- Everyone who has an extension on today gets one `backfilled` event, so the
-- history is never missing a switch that happened before it existed. The
-- not-exists guard keeps a re-run from duplicating anything.
insert into public.extension_toggle_events (user_id, slug, enabled, at, backfilled)
select ue.user_id, ue.slug, true, ue.updated_at, true
from public.user_extensions ue
where ue.enabled
  and not exists (
    select 1 from public.extension_toggle_events e
    where e.user_id = ue.user_id and e.slug = ue.slug
  );

-- ─── The aggregate ───────────────────────────────────────────────────────────
-- Per slug:
--   users_total  confirmed accounts (the denominator; unconfirmed sign-ups are
--                not people using the app)
--   rows_on      confirmed accounts with a saved row that is ON
--   rows_off     … and OFF. Accounts with no row are on the manifest default,
--                which only the app knows, so the route resolves them.
--   tried_30d    accounts whose FIRST switch-on is at least 30 days old, among
--                accounts with no backfilled event for that slug
--   kept_30d     of those, accounts whose latest switch at or before
--                first-on + 30 days left it ON
-- `language sql`, not plpgsql: RETURNS TABLE columns are variables in plpgsql
-- and an unqualified `slug` would be ambiguous.
create or replace function public.extension_adoption()
returns table (
  slug text,
  users_total bigint,
  rows_on bigint,
  rows_off bigint,
  tried_30d bigint,
  kept_30d bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with confirmed as (
    select u.id from auth.users u where u.email_confirmed_at is not null
  ),
  saved as (
    select ue.slug,
           count(*) filter (where ue.enabled) as rows_on,
           count(*) filter (where not ue.enabled) as rows_off
    from public.user_extensions ue
    join confirmed c on c.id = ue.user_id
    group by ue.slug
  ),
  firsts as (
    select e.user_id, e.slug, min(e.at) filter (where e.enabled) as first_on
    from public.extension_toggle_events e
    join confirmed c on c.id = e.user_id
    group by e.user_id, e.slug
    having bool_and(not e.backfilled)
  ),
  cohort as (
    select f.slug,
           (
             select e2.enabled
             from public.extension_toggle_events e2
             where e2.user_id = f.user_id
               and e2.slug = f.slug
               and e2.at <= f.first_on + interval '30 days'
             order by e2.at desc, e2.id desc
             limit 1
           ) as on_at_30
    from firsts f
    where f.first_on is not null
      and f.first_on <= now() - interval '30 days'
  ),
  kept as (
    select k.slug,
           count(*) as tried_30d,
           count(*) filter (where k.on_at_30) as kept_30d
    from cohort k
    group by k.slug
  ),
  slugs as (
    select s.slug from saved s
    union
    select k.slug from kept k
  )
  select sl.slug,
         (select count(*) from confirmed),
         coalesce(s.rows_on, 0),
         coalesce(s.rows_off, 0),
         coalesce(k.tried_30d, 0),
         coalesce(k.kept_30d, 0)
  from slugs sl
  left join saved s on s.slug = sl.slug
  left join kept k on k.slug = sl.slug;
$$;

revoke all on function public.extension_adoption() from public, anon, authenticated;
grant execute on function public.extension_adoption() to service_role;

comment on function public.extension_adoption() is
  'Per-extension adoption counts for the store. Service role only; /api/extensions/adoption withholds small counts.';
