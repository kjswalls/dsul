-- ─────────────────────────────────────────────────────────────────────────────
-- 047_routine_usual_time.sql — when a routine usually happens
--
-- A routine is things done regularly, together — a morning, a workout week —
-- and until now it had no way to say the "regularly". `usual_time` is that: a
-- local wall-clock 'HH:mm' ("Morning, usually at 7:00"), optional.
--
-- It is a label and an ordering, never a schedule. Members keep their own
-- timing; nothing reads this to move an item, because a routine never writes
-- its members' fields (programs-routines plan decision 8). What reads it: the
-- routine's page and console pane, its Today checklist, and the ⌘K "Run …"
-- commands, which list routines in the order you do them.
--
-- The CHECK is the same shape 032 put on items.reminder_time, so a malformed
-- agent write is a 400 at TimeOfDaySchema rather than a 500 here — but a
-- direct write still cannot store "7am".
--
-- Safe to re-run. No backfill: an unset time is the honest default.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.routines add column if not exists usual_time text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'routines_usual_time_check') then
    alter table public.routines
      add constraint routines_usual_time_check
      check (usual_time is null or usual_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
  end if;
end$$;

comment on column public.routines.usual_time is
  'Local wall-clock HH:mm the routine usually happens at. A label and an ordering only — members keep their own timing.';
