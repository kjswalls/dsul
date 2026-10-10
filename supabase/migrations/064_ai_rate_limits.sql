-- ─────────────────────────────────────────────────────────────────────────────
-- 064_ai_rate_limits.sql — a durable count behind the AI connect and check limits
--
-- WHY. lib/ai-server/rate-limit.ts keeps its buckets in each serverless
-- instance's memory (design R6), so 20 connects an hour is 20 per instance: a
-- caller spread across cold starts gets as many guesses as it gets instances.
-- The two buckets that reach a provider with a key the caller typed (connect)
-- or stored (check) are the key-oracle and forwarder risk, so those two also
-- take a token here, where every instance sees the same count. The memory
-- bucket stays in front as the cheap first gate; the saved-conversation and
-- make buckets stay memory-only (they bound load, not guessing).
--
-- WHAT. One row per user and bucket: when the current hour began and how many
-- tokens it has spent. take_ai_token() starts a new hour once the old one is
-- over, and otherwise adds the cost only when it fits, in ONE statement, so two
-- instances racing on the same row can never both squeeze past the limit. A
-- fixed hour, not the memory bucket's sliding one: it needs no per-call rows
-- and no sweep, and a burst at an hour's edge costs at most twice the limit.
--
-- ACCESS. Service role only, like model_connections (053): RLS on, no policy,
-- every privilege revoked, and the function executable by service_role alone.
-- A user who could reset their own count would have no limit.
--
-- DEPLOY ORDER. Either order works: until this is applied the RPC is missing,
-- and the app falls back to the memory answer (rate-limit.ts). Apply to prod
-- only on Kirby's typed OK; if applied out-of-band, record ledger version 064.
--
-- Idempotent and replayable onto an empty database (CI's E2E job and
-- local-setup.sh run db reset).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.ai_rate_limits (
  user_id      uuid        not null references auth.users (id) on delete cascade,
  bucket       text        not null,
  window_start timestamptz not null default now(),
  hits         integer     not null default 0,
  primary key (user_id, bucket)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_rate_limits_bucket_check') then
    alter table public.ai_rate_limits add constraint ai_rate_limits_bucket_check
      check (bucket ~ '^[a-z_]{1,32}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_rate_limits_hits_check') then
    alter table public.ai_rate_limits add constraint ai_rate_limits_hits_check
      check (hits >= 0);
  end if;
end$$;

alter table public.ai_rate_limits enable row level security;
-- No policy on purpose (053's pattern): RLS with no policy denies anon and
-- authenticated, and the revoke says the same at the grant level.
revoke all on table public.ai_rate_limits from public, anon, authenticated;

-- True when `cost` tokens fit in the user's current hour for `bucket` (and
-- takes them); false, taking nothing, when they don't.
create or replace function public.take_ai_token(
  p_user   uuid,
  p_bucket text,
  p_limit  integer,
  p_cost   integer default 1
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  taken boolean;
begin
  if p_user is null or p_cost is null or p_limit is null or p_cost < 1 or p_cost > p_limit then
    return false;
  end if;

  insert into public.ai_rate_limits as r (user_id, bucket, window_start, hits)
  values (p_user, p_bucket, now(), p_cost)
  on conflict (user_id, bucket) do update
     set window_start = case when r.window_start <= now() - interval '1 hour'
                             then now() else r.window_start end,
         hits         = case when r.window_start <= now() - interval '1 hour'
                             then excluded.hits else r.hits + excluded.hits end
   where (case when r.window_start <= now() - interval '1 hour' then 0 else r.hits end)
         + excluded.hits <= p_limit
  returning true into taken;

  return coalesce(taken, false);
end;
$$;

revoke all on function public.take_ai_token(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.take_ai_token(uuid, text, integer, integer) to service_role;

comment on function public.take_ai_token(uuid, text, integer, integer) is
  'Takes p_cost tokens from the user''s current hour for p_bucket when they fit under p_limit. Service role only; called by lib/ai-server/rate-limit.ts for the connect and check buckets.';

notify pgrst, 'reload schema';
