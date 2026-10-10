-- ─────────────────────────────────────────────────────────────────────────────
-- 069_mcp_oauth.sql — sign in to /api/mcp with OAuth
--
-- Claude (claude.ai, the desktop and phone apps, Claude Code), Cursor and other
-- MCP clients connect to a remote server through OAuth 2.1: they discover the
-- authorization server from the 401 on /api/mcp, register themselves (dynamic
-- client registration, RFC 7591), send the user to a consent page, and trade
-- the code (with PKCE) for tokens. lib/mcp-oauth/ is the server side of that;
-- memory/plans/mcp-oauth.md says why it is shaped this way.
--
-- It sits BESIDE the OpenClaw agent key, never instead of it: that key is one
-- per user, plaintext, unscoped and never expires, and the plugin throws on any
-- drift, so it is left alone (ai-vision-decisions.md, decision 1). What a
-- third-party app holds is one of these instead: hashed, scoped (read, or read
-- and change), expiring, and revocable from Settings.
--
-- Four tables, all SERVICE ROLE ONLY (RLS on, no policies, grants revoked), the
-- posture of user_secrets and model_connections. The browser lists and revokes
-- its connected apps through /api/oauth/grants, which checks the session.
--
--   mcp_oauth_clients  a registered app: its name and redirect URIs. No user:
--                      registration is anonymous by design in the spec.
--   mcp_oauth_codes    a one-time code, sha256-hashed, ten minutes, PKCE S256.
--   mcp_oauth_grants   one row per (user, client): what the user allowed, and
--                      the row Settings lists and revokes.
--   mcp_oauth_tokens   access (1 hour) and refresh (90 days, rotated on use)
--                      tokens, sha256-hashed; the plaintext is never stored.
--
-- ACCOUNT DELETION. Every user_id cascades from auth.users (063's rule;
-- tests/unit/account-deletion-migration.test.ts), and codes, grants and tokens
-- cascade from their client and grant.
--
-- Idempotent; replays onto an empty database.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.mcp_oauth_clients (
  client_id      text primary key,
  client_name    text not null,
  redirect_uris  text[] not null,
  created_at     timestamptz not null default now()
);

create table if not exists public.mcp_oauth_grants (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  client_id     text not null references public.mcp_oauth_clients (client_id) on delete cascade,
  scope         text not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

create table if not exists public.mcp_oauth_codes (
  code_hash       text primary key,
  user_id         uuid not null references auth.users (id) on delete cascade,
  client_id       text not null references public.mcp_oauth_clients (client_id) on delete cascade,
  grant_id        uuid not null references public.mcp_oauth_grants (id) on delete cascade,
  redirect_uri    text not null,
  code_challenge  text not null,
  scope           text not null,
  resource        text,
  expires_at      timestamptz not null,
  used_at         timestamptz,
  created_at      timestamptz not null default now()
);

create table if not exists public.mcp_oauth_tokens (
  token_hash  text primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  grant_id    uuid not null references public.mcp_oauth_grants (id) on delete cascade,
  kind        text not null,
  scope       text not null,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'mcp_oauth_tokens_kind_check') then
    alter table public.mcp_oauth_tokens add constraint mcp_oauth_tokens_kind_check
      check (kind in ('access', 'refresh'));
  end if;
end$$;

create unique index if not exists mcp_oauth_grants_live_idx
  on public.mcp_oauth_grants (user_id, client_id) where revoked_at is null;
create index if not exists mcp_oauth_tokens_grant_idx on public.mcp_oauth_tokens (grant_id);
create index if not exists mcp_oauth_codes_expires_idx on public.mcp_oauth_codes (expires_at);

alter table public.mcp_oauth_clients enable row level security;
alter table public.mcp_oauth_grants  enable row level security;
alter table public.mcp_oauth_codes   enable row level security;
alter table public.mcp_oauth_tokens  enable row level security;

revoke all on public.mcp_oauth_clients from anon, authenticated;
revoke all on public.mcp_oauth_grants  from anon, authenticated;
revoke all on public.mcp_oauth_codes   from anon, authenticated;
revoke all on public.mcp_oauth_tokens  from anon, authenticated;
