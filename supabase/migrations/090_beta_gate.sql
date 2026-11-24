-- ─────────────────────────────────────────────────────────────────────────────
-- 090_beta_gate.sql — invite-only sign-up for the beta, off until Kirby turns it on
--
-- WHY. Anyone who reaches do.dsul.app/login can make an account today: a magic
-- link, Google or Apple, and GoTrue creates the user. For a closed beta the
-- door should open only for people Kirby has let in, and the list of people who
-- asked is already here: 088's waitlist_signups.
--
-- WHAT.
--   1. waitlist_signups.invited_at: when Kirby let that address in. Null means
--      still waiting. Inviting someone is setting it; un-inviting is clearing it.
--   2. source 'invite': a row Kirby adds by hand for someone who never filled in
--      the form (a friend, a tester). The page's own route still writes only
--      'hero' and 'closer'.
--   3. public.hook_beta_gate(event): a Supabase Auth "before user created" hook.
--      It runs once per NEW account, before GoTrue inserts it, and lets the
--      sign-up through only when the address is on the list with invited_at
--      set. Existing accounts never pass through it: signing in, and linking a
--      second provider to an account that exists, create no user.
--
-- OFF UNTIL SWITCHED ON. Creating the function changes nothing. The gate is live
-- only once the hook is enabled in the dashboard (Authentication → Hooks →
-- Before User Created → Postgres function public.hook_beta_gate), and switching
-- it off there opens sign-up again at once. No app deploy either way. Local
-- stacks and CI's E2E stack never enable it, so their sign-ups are untouched.
--
-- SIGN IN WITH APPLE. "Hide My Email" hands GoTrue a relay address
-- (…@privaterelay.appleid.com), which is never the address on the list, so the
-- gate refuses it. The refusal says to choose "Share My Email" or use the
-- address that was invited. A relay address can also be let in directly, by
-- adding it as an 'invite' row once Kirby knows it.
--
-- ACCESS. The function is SECURITY DEFINER with an empty search path, so it can
-- read the service-role-only list without granting supabase_auth_admin the table,
-- and it names every object in full. Only supabase_auth_admin may execute it; a
-- browser calling /rest/v1/rpc/hook_beta_gate gets a permission error, so the
-- list can't be probed one address at a time.
--
-- ALSO HERE. rls_auto_enable(), the event-trigger function behind the
-- dashboard's "enable RLS on new tables" switch, was created on prod outside the
-- migrations and is executable by anon and authenticated. An event-trigger
-- function cannot be called through the API, so nothing was reachable, but the
-- grant has no reason to exist: it is revoked, guarded, since an empty database
-- has no such function. The event trigger itself keeps working: a trigger
-- function is never checked for EXECUTE when it fires.
--
-- Idempotent, and replays onto an empty database.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.waitlist_signups add column if not exists invited_at timestamptz;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'waitlist_signups_source_check'
      and pg_get_constraintdef(oid) not like '%invite%'
  ) then
    alter table public.waitlist_signups drop constraint waitlist_signups_source_check;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'waitlist_signups_source_check') then
    alter table public.waitlist_signups add constraint waitlist_signups_source_check
      check (source in ('hero', 'closer', 'invite'));
  end if;
end$$;

create or replace function public.hook_beta_gate(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  addr text := lower(btrim(coalesce(event -> 'user' ->> 'email', '')));
begin
  if addr <> '' and exists (
    select 1 from public.waitlist_signups w
    where w.email = addr and w.invited_at is not null
  ) then
    return '{}'::jsonb;
  end if;

  if addr like '%@privaterelay.appleid.com' then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403,
      'message', 'dsul is invite-only for now. With Apple, choose "Share My Email" so we can find your invite, or sign in with the email you were invited with.'
    ));
  end if;

  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'dsul is invite-only for now, and this email isn''t on the list yet. Join the waitlist at dsul.app and we''ll let you in soon.'
  ));
end;
$$;

revoke all on function public.hook_beta_gate(jsonb) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant execute on function public.hook_beta_gate(jsonb) to supabase_auth_admin;
  end if;
end$$;

do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke all on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end$$;

notify pgrst, 'reload schema';
