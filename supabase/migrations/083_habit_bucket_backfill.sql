-- ─────────────────────────────────────────────────────────────────────────────
-- 083_habit_bucket_backfill.sql — give bucketless repeating habits 'anytime'
--
-- WHY. Switching a braindump task to a habit (lib/item-convert.ts) carried the
-- task's empty time bucket across. The day views only show a habit that has a
-- bucket (lib/day-items.ts), and the braindump only keeps a habit with no
-- repeat (lib/braindump-members.ts), so the switched habit showed up nowhere.
-- The conversion now lands such a habit in 'anytime'; this puts the ones
-- already switched there too.
--
-- Data only, and idempotent: a second run matches no rows. It replays on an
-- empty database as a no-op.
-- ─────────────────────────────────────────────────────────────────────────────

update items
   set time_bucket = 'anytime'
 where type = 'habit'
   and time_bucket is null
   and coalesce(repeat_frequency, 'none') <> 'none';
