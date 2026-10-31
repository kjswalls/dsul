-- 086_leftovers_default_on: the leftovers on Today are ON for NEW accounts.
--
-- morning_check_enabled is the switch for the ghost rows (memory/plans/ghost-rows.md), relabelled
-- "Leftovers on Today". They replaced both the morning waiting line and the end of day review
-- (ghost rows phase 2), and Kirby decided on 2026-10-31 that a new account starts with them on.
--
-- Only the column DEFAULT moves, so only rows inserted from here on are affected. Existing rows are
-- NOT flipped: an account that has it off keeps it off, whether it chose that or got 054's default.
-- lib/settings-service.ts DEFAULT_SETTINGS, the app's own first-run seed, says true too.
-- 054 is applied and is not edited.
--
-- Idempotent (setting a default is), and safe on an empty database: 008 creates the column.

alter table public.user_settings alter column morning_check_enabled set default true;
