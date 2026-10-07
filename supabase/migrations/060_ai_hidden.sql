-- ─────────────────────────────────────────────────────────────────────────────
-- 060_ai_hidden.sql — "No AI, thanks", remembered for the account; and when a
-- free key's daily limit resets
--
-- WHY. With nothing connected, the Ask key shows unlit as "Set up AI" and the
-- tour points at it, so a new account learns AI exists without finding a
-- settings pane. Someone who says "No AI, thanks" must never be invited again,
-- on any device, so the answer lives on the account, not in a browser.
--
-- WHAT.
--   user_settings.ai_hidden: true hides Ask and every invitation to set AI up,
--   everywhere. It is a pause, not a delete: the saved model key, the OpenClaw
--   pairing, webhooks and transcripts are untouched. Read and written by
--   /api/ai/connection (GET answers it with the rest of the gate; PATCH
--   {hidden} writes it).
--
--   model_connections.limited_until: when a free key's daily limit resets, so
--   the AI pane and the chat error can say when AI is back. model_connections
--   stays service-role only (053); this adds a column and no policy.
--
-- DEPLOY. The app reads ai_hidden as unknown while this is missing, and an
-- unknown answer invites nobody (an invitation with a "No AI" that cannot be
-- saved would be the nag this exists to prevent). Safe to re-run, and it
-- replays onto an empty database.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.user_settings
  add column if not exists ai_hidden boolean not null default false;

alter table public.model_connections
  add column if not exists limited_until timestamptz;
