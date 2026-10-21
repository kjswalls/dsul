-- 079_prep_research_kinds.sql — prep packs from research (memory/plans/power-mode.md,
-- "Research"; Kirby's ask 2026-10-20).
--
-- prep_packs.kind takes four more: 'options' (things found to choose between,
-- each with its link), 'list', 'form' (a form's answers to paste, never
-- submitted) and 'draft' (longer writing). The app drops a kind the check
-- refuses and keeps the rest of the batch (app/api/ai/prep), so the order of
-- deploy and apply does not matter. A pack's `sources` live in its body and
-- need nothing here.
--
-- Replays on an empty database; safe to re-run, and after 078 or without it.

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'prep_packs_kind_check') then
    alter table public.prep_packs drop constraint prep_packs_kind_check;
  end if;
  alter table public.prep_packs add constraint prep_packs_kind_check
    check (kind in ('email', 'message', 'call', 'steps', 'question', 'options', 'list', 'form', 'draft'));
end$$;
