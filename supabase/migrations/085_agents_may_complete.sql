-- ─────────────────────────────────────────────────────────────────────────────
-- 085_agents_may_complete.sql — may an agent tick off work handed to it?
--
-- WHY. An agent's "done" (items.ai_status) is its report, never the item: the
-- user checks the work and ticks it. But the agent door also carries the
-- planner's own tick (dsul_complete, dsul_update_task), and nothing stopped an
-- agent ticking off the very item it was handed before anyone looked (Kirby,
-- 2026-10-25). Now the agent routes refuse that unless the account says
-- otherwise, and this is where it says so.
--
-- WHAT.
--   user_settings.agents_may_complete: true lets every agent tick off an item
--   handed to it. Off by default. Read by the agent routes (lib/agent-finish.ts)
--   and written by /api/ai/agents/finish (Settings → AI → Connected apps).
--
-- DEPLOY. Until this is applied the routes read the setting as off, so agents
-- are refused (the safe side) and the settings switch says it can't be saved
-- yet. Safe to re-run, and it replays onto an empty database.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.user_settings
  add column if not exists agents_may_complete boolean not null default false;
