-- 080_prep_planner_kinds.sql — five more prep pack kinds (memory/plans/power-mode.md,
-- "Pack kinds that act on the planner"; Kirby's ask 2026-10-21).
--
-- prep_packs.kind takes 'subtasks' (the item broken into rows, added with one
-- tap), 'answer' (what a "find out…" item wanted to know, kept in its notes
-- with one tap), 'place' (where to go: hours, phone, a map link), 'time' (a
-- slot one tap puts on the day grid) and 'pick' (choices side by side, with
-- the AI's pick). The app drops a kind the check refuses and keeps the rest of
-- the batch (app/api/ai/prep), so the order of deploy and apply does not
-- matter.
--
-- Replays on an empty database; safe to re-run, and after 079 or without it.

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'prep_packs_kind_check') then
    alter table public.prep_packs drop constraint prep_packs_kind_check;
  end if;
  alter table public.prep_packs add constraint prep_packs_kind_check
    check (kind in ('email', 'message', 'call', 'steps', 'question', 'options', 'list', 'form', 'draft',
                    'subtasks', 'answer', 'place', 'time', 'pick'));
end$$;
