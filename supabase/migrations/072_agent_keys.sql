-- ─────────────────────────────────────────────────────────────────────────────
-- 072_agent_keys.sql — named, scoped, revocable keys for agents
--
-- WHY. The OpenClaw agent key is one per user, plaintext, unscoped and never
-- expires (ai-vision-decisions.md, decision 1). That is fine for the one
-- gateway that holds it, and the plugin throws on drift, so it stays exactly as
-- it is. What a second agent, a script or a hosted runtime gets is one of
-- these instead: as many as you like, each with a name you chose, either
-- read-only or read-and-change, shown ONCE when made and stored only as a
-- sha256 hash, and revocable from Settings → AI → Agent keys.
--
-- A key reads `dsul_ak_<43 base64url chars>`. The prefix routes it in
-- resolveUserIdFromApiKey (lib/supabase-service.ts) before the legacy lookup,
-- and can never collide with the legacy key, which is `dsul_` and hex.
--
-- WHAT IT OPENS. The routes that take an OAuth app's token take these, at the
-- same two scopes (lib/mcp-oauth/scopes.ts): `planner:read` reaches the
-- context, item history and the MCP tools that read; `planner` reaches every
-- agent route that writes too. Registering a gateway or a webhook stays the
-- OpenClaw key's alone.
--
-- SERVICE ROLE ONLY (RLS on, no policies, grants revoked), the posture of
-- user_secrets and 069's tables. The browser lists, makes and revokes its
-- keys through /api/agent-keys, which checks the session and never returns a
-- hash, let alone a key, except the new key once in the response that made it.
--
-- ACCOUNT DELETION. user_id cascades from auth.users (063's rule;
-- tests/unit/account-deletion-migration.test.ts).
--
-- Idempotent; replays onto an empty database.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.agent_keys (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  name          text not null,
  scope         text not null,
  key_hash      text not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agent_keys_scope_check') then
    alter table public.agent_keys add constraint agent_keys_scope_check
      check (scope in ('planner', 'planner:read'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'agent_keys_name_check') then
    alter table public.agent_keys add constraint agent_keys_name_check
      check (char_length(btrim(name)) between 1 and 60);
  end if;
end$$;

create unique index if not exists agent_keys_hash_idx on public.agent_keys (key_hash);
create index if not exists agent_keys_user_idx on public.agent_keys (user_id, created_at desc);

alter table public.agent_keys enable row level security;
revoke all on public.agent_keys from anon, authenticated;

comment on table public.agent_keys is
  'Named, scoped, revocable agent keys (dsul_ak_). Service role only; key_hash is sha256 hex, the key itself is never stored.';
