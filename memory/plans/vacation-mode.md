# Vacation mode

Kirby's pick, 2026-10-11: the slim version. One line in ⌘K, one card, no forms.
The older, fuller plan (the "Here's the plan" sheet, the "Sounds good" first week)
is memory/handoffs/vacation-mode/plan.md, and is superseded where this file differs.

## What it does

- **Going away.** `/vacation until tue` in ⌘K (also "away", "holiday", "trip")
  previews "Vacation mode until Tue, Oct 13" and what keeps going, and Enter starts
  it from today. The row's chip, "Change what's paused", opens the card's keep
  picker instead. The user menu has "Vacation mode…" above Settings, which opens the
  same card (Back on, the keep sentence, the chip, Start vacation). There is no start
  date in the UI: a trip starts today. The store and table take a later start.
- **What rests.** Everything that falls on a day (recurring items, dated tasks)
  except what the keep list names: items, their subtasks, projects, routines. The keep
  list starts as the habits done on each of the last 30 days. Anything added in the
  app while away is kept on its own. Undated braindump items never rest.
- **While away.** One line beside the date: "Away until Tue, Oct 20 · 2 still
  running · I'm back". The review push, cues, last calls and stake settlement all
  skip held items, and no review is invited on a day away.
- **Coming back.** The end is exclusive: "until the 20th" is back on the 20th.
  Habits ease back over as many days as the trip lasted, up to a week, longest streak
  first (waves on days 2, 4 and 6, stored in `returns`). The line then reads "Welcome
  back. Habits return a few a day, all back by Mon. · Bring everything back". Tasks
  that came due while away move to the braindump on the first open after the trip,
  once, and sit in "From the trip" under the day each was due, for two weeks.
- **Beeminder.** Warn only: the card says when a paused habit is on Beeminder, which
  needs 7 days' notice for a break. A held habit sends no datapoint.

## Where it lives

- Rule: `lib/away.ts`, asked first by `isItemActiveOn` and `inactiveItemIdsOn`
  (`lib/active.ts`) as the outermost CONJUNCTIVE layer (seasons are disjunctive).
  Every caller passes `away` in its `ActivationContext`; one that does not answers
  exactly as before.
- Table: migration 071 `away_periods`, one row per trip, owner-only RLS, user_id
  cascades. `settled_at` is claimed with a conditional update before the move, so two
  tabs move the tasks once.
- Client: `lib/away-store.ts` (loaded beside the planner, never in undo),
  `lib/away-actions.ts` (the verbs as screens call them), `lib/away-dates.ts` (reads
  "until tue"). Screens: `components/planner/vacation-dialog.tsx`,
  `components/planner/vacation-menu-item.tsx`, `components/views/away-notice.tsx`,
  braindump's `FromTripSection`, `hooks/use-away-settle.ts`, the `app.vacation*`
  commands.
- Server: `lib/reminders/scan.ts` (review veto and the shared ctx),
  `lib/reminders/page-claim.ts`, `lib/recipes/server/context.ts`,
  `app/api/agent/context/route.ts` (legacy `tasks[]`/`habits[]` only, no new field).

## Not yet following trips

- MCP's `my_work` (`lib/mcp/tools.ts`) reads `items[]` from the agent context and
  can list held items; following trips there needs an additive field or a direct read.
- The iPhone: `/api/app` sends no trips and `ios/DsulCore`'s `Active.swift` has no
  layer yet. That is the next PR, with the shared fixture.
- Mods' `openContext` (`lib/mods/broker-core.ts`) and `planNotifications`
  (`lib/reminders/plan.ts`, which mirrors the Swift port).
