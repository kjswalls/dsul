-- 054_morning_check_default_off: rituals are opt-in for NEW accounts.
--
-- Existing values are untouched. Every reader used to treat a NULL morning_check_enabled as ON
-- (`?? true` in supabase-provider and morning-store); those readers now say `?? false`, so any NULL row is
-- pinned to true FIRST, or this change would silently switch the morning check off for that account.
-- 008 is applied and is not edited; this only moves the column DEFAULT, which affects rows inserted from
-- here on (lib/settings-service.ts DEFAULT_SETTINGS, the app's own first-run seed, now says false too).
-- eod_review_enabled has defaulted to false since 002/010; restated so both rituals read the same here.
--
-- Idempotent: the update is a no-op on re-run; setting a default is idempotent.

update public.user_settings set morning_check_enabled = true where morning_check_enabled is null;
alter table public.user_settings alter column morning_check_enabled set default false;
alter table public.user_settings alter column eod_review_enabled set default false;
