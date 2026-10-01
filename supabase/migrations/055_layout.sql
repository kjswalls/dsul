-- ─────────────────────────────────────────────────────────────────────────────
-- 055_layout.sql — the desktop layout
--
-- Adds user_settings.layout: the slug of the layout the desktop shell is put
-- together with ('classic' | 'console' today — the catalog lives app-side in
-- lib/layout-themes.ts). One column, not one per mode like 052's themes: a
-- layout moves whole surfaces, and a per-mode pick would rearrange the screen
-- at sunset for anyone on System.
--
-- Open text, no CHECK, same reasoning as 025 and 052: an unknown slug degrades
-- to Classic app-side, and a CHECK would turn every new layout into a
-- migration.
--
-- App-side: the column starts in PENDING_SCHEMA_COLUMNS
-- (lib/settings-service.ts) until this migration is applied everywhere, prod
-- included. Record 055 in the remote ledger if applied out-of-band.
--
-- Safe to re-run (idempotent guards).
-- ─────────────────────────────────────────────────────────────────────────────

alter table user_settings
  add column if not exists layout text;
