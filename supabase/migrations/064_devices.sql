-- ─────────────────────────────────────────────────────────────────────────────
-- 064_devices.sql — every device dsul can reach, one row per device per account
--
-- The reminders plan's "059_devices.sql" (memory/plans/reminders-platforms.md
-- §4.2), renumbered: 059 went to agent_key_to_secrets before this was written.
--
-- WHY. push_subscriptions (009) is web-push shaped, unique per USER on the
-- endpoint, and owner-managed by RLS. It cannot say which platform a row is,
-- when the token was registered (the APNs 410 rule needs it), or that one
-- physical endpoint has ONE owner — the shared-browser leak in #254 is a row
-- that outlives its sign-out because the next account's row sits beside it.
-- Under an owner-RLS policy a session client can never retire another user's
-- row (the insert hits the unique index with 23505), so the cross-tenant
-- write below is service-role, behind a route that first authenticated WHO.
--
-- KEYED TWO WAYS. (transport, token) is unique: a device belongs to whoever
-- proved they hold it last. (user_id, device_id) is unique: a device keeps its
-- prefs and last-seen across token rotation. register_device() is the only
-- writer and keeps both true.
--
-- ONE PATH PER DEVICE. `delivery` says who schedules this device's cues:
-- 'push' (the server sends) or 'local' (the device arms its own triggers and
-- the sender skips cue, snooze and eod kinds for it). Never both. `os`/`form`
-- carry the same rule for a phone that holds both the iOS app and the PWA:
-- the webpush row is skipped for cue, snooze and eod while a live ios row
-- exists (and for last-call once that row's transport is apns).
--
-- The owner reads a COLUMN-RESTRICTED roster — never `token` or `keys` — and
-- may update `prefs` and `label` only. 009 IS NOT DROPPED: frozen ballast,
-- like tasks/habits, backfilled once below.
--
-- DEPLOY ORDER. The build that reads this table ships FIRST and tolerates its
-- absence (42P01/PGRST205): the sender falls back to push_subscriptions and
-- the registration routes write there, for one release. Apply to prod only on
-- Kirby's typed OK; if applied out-of-band, record ledger version 064.
-- scripts/verify-064.sh replays 000..063, then this file twice.
--
-- Idempotent; replays onto an empty database; pg_cron guarded like 058.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.devices (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  device_id         text not null,
  platform          text not null,
  transport         text not null,
  delivery          text not null default 'push',
  -- Hints for the sender's native-wins rule: the registration body's
  -- UA-derived os and form factor.
  os                text,
  form              text,
  token             text,
  keys              jsonb,
  apns_environment  text,
  parent_device_id  text,
  label             text,
  app_version       text,
  os_version        text,
  timezone          text,
  -- {"kinds":{"cue":true,...},"quiet":{"start":"22:00","end":"07:00"}|null,
  --  "muted":false,"claimsLocally":true}. Absent keys inherit the defaults.
  prefs             jsonb not null default '{}'::jsonb,
  -- When THIS token was registered. Moves ONLY when the token changes: the
  -- APNs 410 comparison point.
  registered_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  last_sent_at      timestamptz,
  last_failure      text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'devices_platform_check') then
    alter table public.devices add constraint devices_platform_check
      check (platform in ('web', 'ios', 'watchos', 'android', 'wearos', 'electron'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'devices_transport_check') then
    alter table public.devices add constraint devices_transport_check
      check (transport in ('webpush', 'apns', 'fcm', 'none'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'devices_delivery_check') then
    alter table public.devices add constraint devices_delivery_check
      check (delivery in ('push', 'local'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'devices_os_form_check') then
    alter table public.devices add constraint devices_os_form_check
      check ((os is null or os ~ '^[a-z]{2,16}$')
             and (form is null or form in ('phone', 'tablet', 'desktop', 'watch')));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'devices_token_check') then
    alter table public.devices add constraint devices_token_check
      check (((transport = 'none') = (token is null))
             and (token is null or (length(token) between 16 and 2048 and token !~ '[[:space:][:cntrl:]]')));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'devices_keys_check') then
    alter table public.devices add constraint devices_keys_check
      check (((transport = 'webpush') = (keys is not null))
             and (keys is null or (jsonb_typeof(keys) = 'object' and keys ? 'p256dh' and keys ? 'auth'
                                   and length(keys::text) <= 512)));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'devices_apns_env_check') then
    alter table public.devices add constraint devices_apns_env_check
      check ((transport = 'apns') = (apns_environment is not null)
             and (apns_environment is null or apns_environment in ('production', 'sandbox')));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'devices_device_id_check') then
    alter table public.devices add constraint devices_device_id_check
      check (device_id ~ '^[A-Za-z0-9:._-]{8,128}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'devices_label_check') then
    alter table public.devices add constraint devices_label_check
      check (label is null or (char_length(label) between 1 and 80 and label !~ '[[:cntrl:]]'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'devices_versions_check') then
    alter table public.devices add constraint devices_versions_check
      check ((app_version is null or length(app_version) <= 64)
             and (os_version is null or length(os_version) <= 64)
             and (timezone is null or length(timezone) <= 64)
             and (parent_device_id is null or parent_device_id ~ '^[A-Za-z0-9:._-]{8,128}$'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'devices_prefs_check') then
    alter table public.devices add constraint devices_prefs_check
      check (jsonb_typeof(prefs) = 'object' and length(prefs::text) <= 2048);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'devices_last_failure_check') then
    alter table public.devices add constraint devices_last_failure_check
      check (last_failure is null or last_failure ~ '^[a-z0-9_]{1,64}$');
  end if;
end$$;

-- One physical endpoint, one owner.
create unique index if not exists devices_transport_token_key
  on public.devices (transport, token)
  where token is not null;

-- One row per device per account; what a touch and a rotation upsert on.
create unique index if not exists devices_user_device_key
  on public.devices (user_id, device_id);

-- The fan-out read.
create index if not exists devices_user_idx on public.devices (user_id);

drop trigger if exists devices_updated_at on public.devices;
create trigger devices_updated_at before update on public.devices
  for each row execute function public.update_updated_at();

-- ── Access ────────────────────────────────────────────────────────────────────
alter table public.devices enable row level security;

-- Supabase's default privileges grant anon and authenticated ALL on a new
-- public table (053's note); revoke, then grant back exactly the columns the
-- owner's roster needs. `token` and `keys` are in no grant: a select('*') from
-- a session client answers 42501, which is the point.
revoke all on table public.devices from public;
revoke all on table public.devices from anon;
revoke all on table public.devices from authenticated;
grant select (id, user_id, device_id, platform, transport, delivery, os, form, apns_environment,
              parent_device_id, label, app_version, os_version, timezone, prefs, registered_at,
              last_seen_at, last_sent_at, last_failure, created_at, updated_at)
  on public.devices to authenticated;
grant update (prefs, label) on public.devices to authenticated;
grant select, insert, update, delete on table public.devices to service_role;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'devices' and policyname = 'Users read their own devices') then
    create policy "Users read their own devices"
      on public.devices for select
      using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'devices' and policyname = 'Users set their own device prefs') then
    create policy "Users set their own device prefs"
      on public.devices for update
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end$$;

-- ── register_device(): the one writer ─────────────────────────────────────────
-- Two statements, one transaction. (1) The token decides ownership: any row
-- holding this token under another (user, device) is the previous owner of
-- this physical endpoint and is retired. (2) One row per (user, device): a
-- re-register touches, a rotated token replaces, registered_at moves only
-- when the token does. security invoker, execute revoked from everyone but
-- service_role: the caller is always a route that already authenticated
-- p_user_id.
create or replace function public.register_device(
  p_user_id          uuid,
  p_device_id        text,
  p_platform         text,
  p_transport        text,
  p_delivery         text,
  p_os               text,
  p_form             text,
  p_token            text,
  p_keys             jsonb,
  p_apns_environment text,
  p_parent_device_id text,
  p_label            text,
  p_app_version      text,
  p_os_version       text,
  p_timezone         text
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_token is not null then
    delete from public.devices
     where transport = p_transport
       and token = p_token
       and (user_id <> p_user_id or device_id <> p_device_id);
  end if;

  insert into public.devices (
    user_id, device_id, platform, transport, delivery, os, form, token, keys, apns_environment,
    parent_device_id, label, app_version, os_version, timezone
  ) values (
    p_user_id, p_device_id, p_platform, p_transport, coalesce(p_delivery, 'push'), p_os, p_form,
    p_token, p_keys, p_apns_environment, p_parent_device_id, p_label, p_app_version, p_os_version, p_timezone
  )
  on conflict (user_id, device_id) do update set
    platform         = excluded.platform,
    transport        = excluded.transport,
    delivery         = excluded.delivery,
    os               = coalesce(excluded.os, public.devices.os),
    form             = coalesce(excluded.form, public.devices.form),
    token            = excluded.token,
    keys             = excluded.keys,
    apns_environment = excluded.apns_environment,
    parent_device_id = coalesce(excluded.parent_device_id, public.devices.parent_device_id),
    label            = coalesce(excluded.label, public.devices.label),
    app_version      = coalesce(excluded.app_version, public.devices.app_version),
    os_version       = coalesce(excluded.os_version, public.devices.os_version),
    timezone         = coalesce(excluded.timezone, public.devices.timezone),
    registered_at    = case
                         when public.devices.token is distinct from excluded.token then now()
                         else public.devices.registered_at
                       end,
    last_seen_at     = now(),
    last_failure     = null
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.register_device(uuid, text, text, text, text, text, text, text, jsonb, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.register_device(uuid, text, text, text, text, text, text, text, jsonb, text, text, text, text, text, text)
  to service_role;

-- ── Backfill from 009 ─────────────────────────────────────────────────────────
-- Every existing browser subscription becomes a web device with a placeholder
-- device_id ('web:' + sha256(endpoint); sha256() is core Postgres, no pgcrypto).
-- The browser's first boot after this ships re-registers with its real id and
-- register_device's step (1) moves the row onto it. Where two accounts held one
-- endpoint (the #254 case) the newer row wins — the table's invariant.
--
-- last_seen_at is NOW, not created_at: 009 has only created_at, a re-subscribe
-- keeps the first-ever stamp, and a working subscription older than 180 days
-- would otherwise be born stale and pruned at the first 03:41 — plausibly the
-- EOD subscriber's phone, which may only ever receive. registered_at keeps
-- created_at (nothing compares it for webpush).
--
-- 009 always precedes 064 and is never dropped; this INSERT depends on that
-- ordering and does not guard it (a to_regclass test in a WHERE cannot guard a
-- FROM — the relation is resolved at parse time). scripts/verify-064.sh must
-- create push_subscriptions before applying this file.
insert into public.devices (user_id, device_id, platform, transport, delivery, token, keys, registered_at, last_seen_at, created_at)
select s.user_id,
       'web:' || encode(sha256(convert_to(s.endpoint, 'UTF8')), 'hex'),
       'web', 'webpush', 'push', s.endpoint,
       jsonb_build_object('p256dh', s.p256dh, 'auth', s.auth),
       s.created_at, now(), s.created_at
  from public.push_subscriptions s
 where not exists (select 1 from public.devices d where d.transport = 'webpush' and d.token = s.endpoint)
   and s.created_at = (select max(created_at) from public.push_subscriptions s2 where s2.endpoint = s.endpoint)
   -- The CHECKs above, asked first: `on conflict do nothing` skips a duplicate,
   -- never a check violation, and one malformed 009 row (009 checked nothing)
   -- would otherwise abort the whole migration. Such a row could never be
   -- pushed to anyway; it stays in the ballast and nowhere else.
   and length(s.endpoint) between 16 and 2048
   and s.endpoint !~ '[[:space:][:cntrl:]]'
   and length(jsonb_build_object('p256dh', s.p256dh, 'auth', s.auth)::text) <= 512
on conflict do nothing;

-- ── Nightly prune ─────────────────────────────────────────────────────────────
-- Terminal push-service responses prune inline (lib/devices/send.ts). This is
-- the backstop for rows no response will ever prune: Safari answers 200 for
-- dead subscriptions, APNs never ages a token, FCM calls a token stale after a
-- month. The webpush transport stamps last_seen_at on every accepted send, so
-- a device that only receives is "seen". Tagged quote inside the do block — a
-- nested $$ is a syntax error.
do $$
begin
  if to_regclass('cron.job') is null then return; end if;
  begin perform cron.unschedule('prune-devices'); exception when others then null; end;
  perform cron.schedule(
    'prune-devices',
    '41 3 * * *',
    $job$
      delete from public.devices
       where (transport in ('webpush', 'apns', 'none') and last_seen_at < now() - interval '180 days')
          or (transport = 'fcm' and last_seen_at < now() - interval '60 days')
    $job$
  );
end$$;

comment on table public.devices is
  'Every device dsul can reach, one row per device per account. Written only by register_device() through the service role; owners read their roster without token/keys and may edit prefs and label. delivery says who schedules its cues: push (server) or local (device), never both. push_subscriptions (009) is frozen ballast.';
