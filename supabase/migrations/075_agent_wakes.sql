-- ─────────────────────────────────────────────────────────────────────────────
-- 075_agent_wakes.sql — where a connected app is woken when work is handed to it
--
-- An app connected over MCP (Claude, Cursor) can only be CALLED by dsul while
-- the person has a chat open with it; nothing can reach it otherwise, so work
-- handed to it waited until the next time someone opened the app. A Claude Code
-- routine can be started by an HTTP POST to its own /fire URL with its own
-- bearer token (memory/plans/power-mode.md, "Waking an app"), so the person can
-- give dsul that URL and token per app, and the hand-off fires it.
--
-- The token starts a run on the person's Claude account, so it is a credential
-- and lives where credentials live: user_secrets, which only service_role can
-- reach (migration 012). The settings page is told which apps have a wake, never
-- the URL or the token. One jsonb keyed by the app's assignee name, folded
-- (lib/agent-wake.ts), as reminder_secrets is keyed by channel (migration 033):
--   { "claude": { "url": "https://api.anthropic.com/v1/claude_code/routines/…/fire",
--                 "token": "…" } }
-- Validated app-side on read and write; an unknown shape is ignored.
--
-- user_secrets already cascades from auth.users, so this column needs no key of
-- its own. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

alter table user_secrets
  add column if not exists agent_wakes jsonb not null default '{}'::jsonb;
