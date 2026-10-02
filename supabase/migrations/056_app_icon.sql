-- ─────────────────────────────────────────────────────────────────────────────
-- 056_app_icon.sql — the app icon
--
-- Adds user_settings.app_icon: the slug of the icon the browser tab and the
-- desktop app's Dock and taskbar wear ('aurora' | 'lime' today — the catalog
-- lives app-side in lib/app-icons.ts). Stored on the server, not per device,
-- because the desktop shell and a second browser can only learn the pick from
-- here.
--
-- Open text, no CHECK, same reasoning as 025, 052 and 055: an unknown slug
-- degrades to Aurora app-side, and a CHECK would turn every new icon into a
-- migration. NULL means "never chosen on any device", so hydration leaves the
-- device's own pick standing.
--
-- App-side: the column starts in PENDING_SCHEMA_COLUMNS
-- (lib/settings-service.ts) until this migration is applied everywhere, prod
-- included. Record 056 in the remote ledger if applied out-of-band.
--
-- Safe to re-run (idempotent guards).
-- ─────────────────────────────────────────────────────────────────────────────

alter table user_settings
  add column if not exists app_icon text;

comment on column user_settings.app_icon is
  'App icon slug (aurora|lime). Null = never chosen; an unknown slug falls back to aurora app-side.';
