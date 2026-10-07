-- 059_agent_key_to_secrets: the OpenClaw agent key leaves every table the browser can read (#123, #142).
--
-- The agent key (`dsul_…`, the plugin's bearer for /api/agent/*, /api/mcp and the context route) is a
-- plaintext, unscoped, read+write credential. It lived in user_settings.openclaw_api_key, and RLS lets the
-- user's own JWT SELECT that row, so any script running on the page could read it with the anon client and
-- drive the account's agent API from anywhere. The device-auth hand-off left a second copy behind: every
-- consumed connect_sessions row kept api_key, readable by its owner through "Users can read own sessions".
--
-- 1. user_secrets.openclaw_api_key: SERVICE ROLE ONLY (012 revoked anon and authenticated; there are no
--    policies), next to the gateway token. Unique, as on user_settings, because it is the lookup key for
--    resolveUserIdFromApiKey.
-- 2. Every existing key is copied there, then the old column is nulled and CHECKed null, so nothing (the
--    browser's own upsert included) can put a credential back where the browser reads it. The column
--    itself stays, as ballast: a build from before this migration still selects it.
-- 3. connect_sessions becomes service-role only. Only the /api/agent/connect/* routes touch it, all with
--    the service client; the two authenticated policies served nothing. Keys on sessions that are no
--    longer waiting to be polled are cleared (the poll route now clears its own on consume).
--
-- ORDER: apply AFTER the app build that reads user_secrets is live. That build reads the key from
-- user_secrets and falls back to user_settings only while user_secrets has no such column, so it works on
-- either side of this migration; a build from before it reads only user_settings, which this nulls.
--
-- Idempotent and replayable onto an empty database (CI's E2E job and local-setup.sh run db reset).

alter table public.user_secrets add column if not exists openclaw_api_key text;

create unique index if not exists user_secrets_openclaw_api_key_idx
  on public.user_secrets (openclaw_api_key)
  where openclaw_api_key is not null;

-- A key already in user_secrets wins over the legacy copy (a re-run, or a key minted by the new build).
insert into public.user_secrets (user_id, openclaw_api_key)
select s.user_id, s.openclaw_api_key
from public.user_settings s
where s.openclaw_api_key is not null
on conflict (user_id) do update
  set openclaw_api_key = coalesce(public.user_secrets.openclaw_api_key, excluded.openclaw_api_key);

update public.user_settings set openclaw_api_key = null where openclaw_api_key is not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'user_settings_openclaw_api_key_retired') then
    alter table public.user_settings add constraint user_settings_openclaw_api_key_retired
      check (openclaw_api_key is null);
  end if;
end$$;

-- connect_sessions: service role only.
drop policy if exists "Users can authorize pending sessions" on public.connect_sessions;
drop policy if exists "Users can read own sessions" on public.connect_sessions;
revoke all on table public.connect_sessions from anon;
revoke all on table public.connect_sessions from authenticated;

update public.connect_sessions
  set api_key = null
  where api_key is not null and (status <> 'authorized' or expires_at <= now());
