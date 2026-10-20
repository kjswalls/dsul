-- 078_prep_questions_and_ai_mode.sql — background prep (memory/plans/power-mode.md,
-- "AI work badges"; Kirby's pick 2026-10-20: agents join it prepare-only from
-- day one).
--
-- 1. prep_packs.kind takes 'question': the one thing the AI needs to know
--    before it can get an item ready. The app drops question packs until this
--    lands (app/api/ai/prep), so the order of deploy and apply does not matter.
--
-- 2. items.ai_mode: how a handed-off item may be worked. NULL is the hand-off
--    as it always was (the agent does the task). 'prepare' is background
--    prep's hand-off: draft, research, plan and ask, report what was got ready,
--    and never send, book, pay or delete. The agent reads it through MCP's
--    dsul_my_work. The app writes the column only once it has seen it on a
--    read (lib/db.ts), so a build ahead of this migration never names it.
--
-- Replays on an empty database; safe to re-run.

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'prep_packs_kind_check') then
    alter table public.prep_packs drop constraint prep_packs_kind_check;
  end if;
  alter table public.prep_packs add constraint prep_packs_kind_check
    check (kind in ('email', 'message', 'call', 'steps', 'question'));
end$$;

alter table public.items
  add column if not exists ai_mode text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'items_ai_mode_check') then
    alter table public.items add constraint items_ai_mode_check
      check (ai_mode is null or ai_mode in ('prepare'));
  end if;
end$$;

comment on column public.items.ai_mode is
  'How a handed-off item may be worked: NULL does the task, ''prepare'' only gets it ready (drafts, steps, questions) and never sends, books, pays or deletes.';
