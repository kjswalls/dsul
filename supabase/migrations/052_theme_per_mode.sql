-- ─────────────────────────────────────────────────────────────────────────────
-- 052_theme_per_mode.sql — the theme picked for each mode
--
-- Adds user_settings.theme_light and user_settings.theme_dark: the slug of the
-- theme used while the app is light, and the one used while it is dark
-- ('paper' | 'studio' | 'sorbet' and 'night' | 'terminal' | 'dusk' today — the
-- catalog lives app-side in lib/theme-looks.ts, the CSS blocks in
-- app/globals.css). Two columns, not one, because both picks are remembered at
-- once: switching mode shows the other pick, and switching back finds this one.
-- `theme` (light|dark|system) is untouched and stays the mode.
--
-- Open text, no CHECK, same reasoning as 025 (theme_palette): unknown slugs
-- degrade to the default look app-side, and a CHECK would turn every new theme
-- into a migration.
--
-- App-side: both columns start in PENDING_SCHEMA_COLUMNS
-- (lib/settings-service.ts) until this migration is applied everywhere, prod
-- included. Record 052 in the remote ledger if applied out-of-band.
--
-- Safe to re-run (idempotent guards).
-- ─────────────────────────────────────────────────────────────────────────────

alter table user_settings
  add column if not exists theme_light text;

alter table user_settings
  add column if not exists theme_dark text;
