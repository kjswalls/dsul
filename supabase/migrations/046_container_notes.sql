-- ─────────────────────────────────────────────────────────────────────────────
-- 046_container_notes.sql — a free-text note on routines, programs and projects
--
-- WHY. The container panes were redrawn in a Linear-like grammar (2026-09-27):
-- a title, a row of properties, then a plain document block saying what the
-- thing is for. Goals already have that block — `goals.why` (036) — and the
-- other three containers had nowhere to put it. One nullable text column each,
-- the same shape as `why`: optional, never required, and empty means "no note"
-- (the pane shows "Add a note…").
--
-- Nothing reads these server-side: no RLS change, no index, no trigger. The
-- agent API's container schemas gain an OPTIONAL `notes`, which is additive —
-- the OpenClaw plugin's safeParse strips unknown keys and requires none of it.
--
-- Idempotent, and replays onto an empty database (000_baseline creates
-- `projects`; 024 creates `routines` and `programs`).
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.routines add column if not exists notes text;
alter table public.programs add column if not exists notes text;
alter table public.projects add column if not exists notes text;
