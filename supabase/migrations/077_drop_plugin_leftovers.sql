-- 077_drop_plugin_leftovers.sql — what the retired OpenClaw plugin left behind
-- (memory/plans/openclaw-browser-chat.md, "The plugin, retired").
--
-- WHY. #528 removed the plugin's chat and its device sign-in. Two things only
-- they used are now read by nothing:
--   * connect_sessions (017): the device sign-in's polling rows, some still
--     holding a copy of an agent key until Unpair expired them.
--   * user_settings.openclaw_chat_url (004): where the plugin's chat lived.
-- Kirby was the only account using either (2026-10-15), so nothing is
-- migrated; the rows go with the table and the column.
--
-- Deploy leads migration: the code that stopped writing both ships first, and
-- an older build still running would 500 on /api/agent/register's chat upsert
-- and on Unpair, so apply this only once that deploy is live.
-- Replays on an empty database; safe to re-run.

drop table if exists public.connect_sessions;

alter table public.user_settings drop column if exists openclaw_chat_url;
