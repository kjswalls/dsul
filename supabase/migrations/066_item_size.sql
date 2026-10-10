-- ─────────────────────────────────────────────────────────────────────────────
-- 066_item_size.sql — how big an undated thing is
--
-- WHY. A braindump that sits for weeks reads as one undifferentiated pile: a
-- two-minute email and "plan the trip" look the same weight, so nothing gets
-- picked. The Do stuff extension sorts the braindump by size and walks the
-- quick ones first (memory/handoffs/stale-braindump.md). The size is the
-- user's own call, made once and kept, so it lives on the item.
--
-- WHAT. items.size: 'quick' | 'errand' | 'big' | 'fuzzy', or null for "not
-- sized yet". Optional for every type and read by nothing outside the
-- braindump. No backfill: unsized is the honest default.
--
-- READS. The planner reads items through the items_windowed view (031), which
-- froze its column list when it was built, so this ends by rebuilding it, as
-- 041 and 048 do. Without that the column exists and the app never sees it.
--
-- DEPLOY. Until this runs, a write naming size is retried without it
-- (DEFERRABLE_WRITE_COLUMNS in lib/db.ts), so editing still works and only the
-- size is not kept. Safe to re-run, and it replays onto an empty database.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.items add column if not exists size text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'items_size_check') then
    alter table public.items
      add constraint items_size_check
      check (size is null or size in ('quick', 'errand', 'big', 'fuzzy'));
  end if;
end$$;

comment on column public.items.size is
  'How big an undated item is: quick | errand | big | fuzzy, or null when not sized. Set by the user in the braindump (Do stuff).';

do $$
begin
  if to_regprocedure('public.rebuild_items_windowed()') is not null then
    perform public.rebuild_items_windowed();
  end if;
end$$;
