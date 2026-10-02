-- 053_model_connections: each user's own AI model connection (AI vision step 1, "Honest setup").
--
-- One row per user; switching provider replaces the row. The provider key is sealed APP-SIDE with
-- AES-256-GCM under MODEL_KEYS_ENCRYPTION_KEY (lib/ai-server/secret-box.ts); the database only ever sees
-- 'v1:<iv>:<tag>:<ct>'. Never encrypt or decrypt in SQL: a key handed to Postgres lands in statement logs.
--
-- SERVICE ROLE ONLY, like user_secrets (012) and plugin_registrations (042). The non-secret columns
-- reach the browser only through /api/ai/connection, which never returns key_ciphertext, a mask, or a
-- last-four.
--
-- Idempotent and replayable onto an empty database (CI's E2E job and local-setup.sh run db reset).

create table if not exists public.model_connections (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  provider       text not null,
  -- Custom (OpenAI-compatible) hosts only. https + public host is enforced app-side on save AND before
  -- every request; the CHECK below is a backstop, not the policy.
  base_url       text,
  -- Null until chosen (a host that lists nothing, or an empty filtered list).
  model          text,
  -- Per-model facts captured at connect / model change, e.g. {"effortLow": true} for Anthropic models
  -- whose capabilities.effort.low.supported is true. Never secret.
  model_meta     jsonb not null default '{}'::jsonb,
  auth_method    text not null default 'key',
  key_ciphertext text not null,
  -- 'failing' only after the provider itself refused the key. A decrypt failure is NEVER written here:
  -- preview and prod can share this table while holding different encryption keys.
  status         text not null default 'ok',
  -- A short code in our own words ('key_rejected'), never a provider error body.
  last_error     text,
  checked_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.model_connections add column if not exists model_meta jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'model_connections_provider_check') then
    alter table public.model_connections add constraint model_connections_provider_check
      check (provider in ('openai', 'anthropic', 'gemini', 'openrouter', 'custom'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'model_connections_base_url_check') then
    alter table public.model_connections add constraint model_connections_base_url_check
      check (((provider = 'custom') = (base_url is not null))
             and (base_url is null or (base_url ~ '^https://[^/?#@[:space:]]+' and length(base_url) <= 2048)));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'model_connections_model_check') then
    alter table public.model_connections add constraint model_connections_model_check
      check (model is null or (length(model) between 1 and 200 and model !~ '[[:space:][:cntrl:]]'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'model_connections_model_meta_check') then
    alter table public.model_connections add constraint model_connections_model_meta_check
      check (jsonb_typeof(model_meta) = 'object' and length(model_meta::text) <= 1024);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'model_connections_auth_method_check') then
    alter table public.model_connections add constraint model_connections_auth_method_check
      check (auth_method in ('key', 'oauth') and (auth_method = 'key' or provider = 'openrouter'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'model_connections_status_check') then
    alter table public.model_connections add constraint model_connections_status_check
      check (status in ('ok', 'failing'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'model_connections_last_error_check') then
    alter table public.model_connections add constraint model_connections_last_error_check
      check (last_error is null or last_error ~ '^[a-z_]{1,64}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'model_connections_ciphertext_check') then
    alter table public.model_connections add constraint model_connections_ciphertext_check
      check (key_ciphertext ~ '^v[0-9]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$'
             and length(key_ciphertext) <= 4096);
  end if;
end$$;

alter table public.model_connections enable row level security;
-- No policy on purpose: RLS with no policy denies anon and authenticated; the service role bypasses RLS.
-- The revokes say the same at the grant level (Supabase's default privileges grant both roles everything
-- on new public tables), so neither mechanism is load-bearing alone.
revoke all on table public.model_connections from public;
revoke all on table public.model_connections from anon;
revoke all on table public.model_connections from authenticated;
grant select, insert, update, delete on table public.model_connections to service_role;

drop trigger if exists model_connections_updated_at on public.model_connections;
create trigger model_connections_updated_at before update on public.model_connections
  for each row execute function update_updated_at();

comment on table public.model_connections is
  'Each user''s own AI model connection. Service-role only: key_ciphertext is an app-sealed provider key (AES-256-GCM, MODEL_KEYS_ENCRYPTION_KEY). Never returned to a browser, not even masked.';
comment on column public.model_connections.key_ciphertext is
  'v1:<iv>:<tag>:<ct>, base64. AAD binds user id, provider and base_url. Sealed and opened only in lib/ai-server/secret-box.ts.';
