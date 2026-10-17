-- 078: stamp prep_packs.updated_at from the database, not the client.
--
-- /api/ai/prep saved packs with an upsert whose payload named `updated_at`.
-- 074 grants `authenticated` INSERT on (item_id, kind, body, made_for, model)
-- only, and Postgres checks the privilege of every column an INSERT names, so
-- the save failed with 42501 on every run: prep packs never reached the table
-- from the app (found 2026-10-17). The route no longer sends the column; the
-- default covers an insert, and this trigger covers an update, the same way
-- 071 did for away_periods. Idempotent and replayable onto an empty database.

drop trigger if exists prep_packs_updated_at on public.prep_packs;
create trigger prep_packs_updated_at
  before update on public.prep_packs
  for each row execute function public.update_updated_at();
