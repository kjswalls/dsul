-- ─────────────────────────────────────────────────────────────────────────────
-- 088_waitlist.sql — the pre-launch waitlist behind dsul.app
--
-- WHY. dsul.app (the apex) becomes the marketing page, public/site/index.html,
-- with an email form: "get early access". The list lives in dsul's own
-- Supabase rather than a mailing-list service (recommended 2026-10-10, built on
-- Kirby's go 2026-11-02): nothing new to sign up for, and the list goes to a
-- sender only for the launch email.
--
-- WHAT. One row per address that asked to hear when dsul opens.
--   email        trimmed and lowercased by the route; the CHECK holds it to
--                that, so the unique key is the whole dedupe.
--   source       which of the page's two forms: 'hero' or 'closer'.
--   planner      the optional answer to "which planner did you quit last?",
--                one of the page's chips (PLANNERS in lib/waitlist.ts).
--   why          the optional one line after it, at most 280 characters.
--   ticket       a random handle the signup response carries back to the page,
--                so the answer is saved by ticket and never by email: knowing
--                someone's address is not enough to write on their row.
--   answered_at  when the answer was last saved.
--
-- ACCESS. Written only by POST and PATCH /api/waitlist (app/api/waitlist/
-- route.ts) through the service role. RLS is on with NO policies and every
-- grant to anon and authenticated is revoked, so no browser, signed in or not,
-- can list who signed up. Kirby reads it from the dashboard.
--
-- ACCOUNTS. No user column: a signup is not an account, and the person may
-- never make one. Account deletion has nothing to cascade here; taking someone
-- off the list is a delete by email.
--
-- Idempotent, and replays onto an empty database.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.waitlist_signups (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  source      text not null default 'hero',
  planner     text,
  why         text,
  ticket      uuid not null default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  answered_at timestamptz
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'waitlist_signups_email_key') then
    alter table public.waitlist_signups add constraint waitlist_signups_email_key unique (email);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'waitlist_signups_ticket_key') then
    alter table public.waitlist_signups add constraint waitlist_signups_ticket_key unique (ticket);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'waitlist_signups_email_check') then
    alter table public.waitlist_signups add constraint waitlist_signups_email_check
      check (email = lower(btrim(email)) and char_length(email) between 3 and 254 and email like '%_@_%');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'waitlist_signups_source_check') then
    alter table public.waitlist_signups add constraint waitlist_signups_source_check
      check (source in ('hero', 'closer'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'waitlist_signups_planner_check') then
    alter table public.waitlist_signups add constraint waitlist_signups_planner_check
      check (planner is null or planner in ('todoist', 'notion', 'reminders', 'paper', 'brain', 'all'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'waitlist_signups_why_check') then
    alter table public.waitlist_signups add constraint waitlist_signups_why_check
      check (why is null or char_length(why) <= 280);
  end if;
end$$;

alter table public.waitlist_signups enable row level security;

-- Supabase's default privileges grant every new public table to anon and
-- authenticated. RLS with no policies already refuses them; the revoke means a
-- policy added by mistake later still opens nothing.
revoke all on table public.waitlist_signups from public, anon, authenticated;

notify pgrst, 'reload schema';
