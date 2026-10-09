# Vacation mode: plan

Planning only, 2026-10-08. Grounded in main at f21a40c. Nothing is built.

## Recommendation in one paragraph

Vacation mode is **one account-level pause interval with a keep list**, added as the
outermost layer of the one "is this item live?" predicate, `isItemActiveOn`
(lib/active.ts). It is stored as one row (start day, end day, what to keep), never as a
write to every item. Because every surface that hides, nags, charges or sweeps already
asks that predicate, vacation mode reaches the grid, reminders, last calls, stakes,
the end-of-day review, the tab's lime "day done" icon, recipe filters and MCP almost for
free. It ends on its own on the end date (read-side, like a pause: no cron, no cleanup),
or early with "I'm back".

## What dsul already has (and why it fits)

| Piece | Where | What it gives vacation mode |
|---|---|---|
| Item pause `[pausedAt, pausedUntil)` | lib/active.ts `isPausedOn`, `resolvePauseWrite` | The exact interval shape: read-side auto-resume, history before the start stays visible, exclusive end ("until the 20th" means back ON the 20th). |
| Routine pause | same columns on routines | A container-wide pause is ONE row write (programs-routines decision 8: never write member items). |
| Seasons (active / paused / auto with dates) | `isSeasonActiveOn` | Date-ranged gate. But seasons are **disjunctive** (a second live path keeps an item visible), so a season cannot be "pause everything". Vacation must be a **conjunctive** outer gate. |
| "Suppression hides open loops, never history" | `isOpenLoopSuppressedOn` | A habit ticked on day 1 of the trip keeps its tick; only unanswered obligations hide. |
| Streaks | stored counter, moves only on a tick (planner-store ~4651) | Pausing needs no streak handling at all, and neither does vacation. Nothing breaks a streak at midnight. |
| Reminders cron | lib/reminders/due.ts, scan.ts | Cues and streak-at-risk last calls already skip inactive items. |
| Stakes (Beeminder, partner) | lib/stakes/day.ts | "A suppressed day is not a missed day": settlement skips inactive items, so no pledge is charged. |
| Day done (lime tab) | lib/day-done.ts | Skips inactive items, so a vacation day reads as done. |
| Recipes | lib/recipes/filters.ts `openToday`; server tick (#407, 062) | Item filters honour suppression; but a **timed** recipe still fires. Needs its own rule (below). |
| Auto-age sweep grace | hooks/use-overdue-sweep.ts `resumedRecently` (:77), decision 9 | Written with "the morning after a 35-day vacation" in mind: resume dates within the trailing window stop the mass unschedule. Vacation's end date becomes one more stored resume boundary. |
| iPhone | ios/DsulCore Active.swift (ports active.ts, checked by tests/fixtures/day/active.json) | One port to extend; the shared fixture keeps web and phone agreeing. |

## How it works

### Turning it on
- Settings has a "Vacation" row, and ⌘K gets "Go on vacation" (the pause command already
  lists "vacation" as a keyword in lib/commands/registry.ts). Phone: Settings row.
- A sheet asks: **from** (today or a later day), **until** (a day you're back, or "until
  I turn it off"), and **keep** (below). One Save, one undo entry.
- While away, a quiet line at the top of the canvas (and the phone's top row) says
  "on vacation until Oct 20" with "I'm back".

### What pauses (everything not kept)
- Habits and recurring items: hidden from the grid and Today, no cues, no last calls,
  no stake settlement, streak untouched.
- Dated tasks inside the trip: hidden while away (open loops only), back on return.
- Routines' Today checklists, goal check-ins (they are recurring items), milestones due
  in the trip (hidden; target date unchanged).
- End-of-day review push and the morning check: off on vacation days.
- Recipes with a time trigger: skipped on vacation days unless kept. Item-trigger
  recipes still run, since they only fire when you do something.
- Mods: nothing to do. Mod timers are in-session only (lib/mods/protocol.ts, limits.ts),
  and item events fire only when you act.
- OpenClaw: the agent's queue (`selectAssignedWork`, lib/mcp/tools.ts) and `canHandOff`
  take an `inactiveIds` set, so they stop seeing paused items once their callers pass the
  away period in. A kept item still goes.
- The in-app end-of-day notice and the `?eod=` auto-open, not just the push.
- Subtasks follow their parent: kept with it, hidden with it.
- Goals: the "behind / ahead" pace (lib/goals.ts `timeElapsed`, `goalProgress`) leaves
  trip days out, so a goal doesn't come back looking behind.
- AI: chat keeps working; unprompted openers stay quiet.

### What keeps working, always
- The braindump. Vacation only hides things that fall on a day (habits, recurring items,
  dated tasks); undated braindump items stay where they are. Without this rule the
  braindump's Paused section (components/sidebar/braindump.tsx:630) would swallow it.
- Capture: ⌘K add, quick capture, the dock. **Anything you add in the app while away is
  kept**: the add appends its id to the trip's keep list, so planning one thing on the
  trip just works. Items an agent or recipe adds are not auto-kept. (Items carry no
  `createdAt` in the app, so a "created after the start" rule would need new plumbing
  everywhere; the keep list doesn't.)
- The "show paused items on the grid" setting applies to vacation too: on, they show
  dimmed like any paused item.
- History: past weeks, ticks made during the trip, the ledger.
- Items you already paused keep their own pause; vacation never rewrites it.

### Picking what to keep (recommended: option A)
- **A. A keep list of routines, projects and single items.** Three short pickers in the
  sheet: "Keep these routines", "Keep these projects", "Keep these items", with search.
  A habit like "take meds" is one tap. Kept is decided per item at read time: kept if the
  item, its project, or any routine holding it is on the list.
- B. Presets only ("pause everything", "pause work only", "keep habits"). Faster, but
  "work only" needs a project rule anyway, so it ends up as A with fewer controls.
- Remembered: the last keep list is offered next time.

### Ending
- On the end day it is simply over (exclusive end, read-side, no cron needed).
- "I'm back" ends it today (writes `ends_on = today`, like a manual resume).
- Open-ended trips are allowed; the banner stays until turned off.
- "I'm back" (or Cancel) on a trip that hasn't started deletes it. One trip at a time,
  future ones included, so periods never overlap.
- Coming back: a **welcome-back card** on Today: "you were away 9 days. 4 tasks came
  due while you were out", with Today / Braindump / Leave them per row or for all.
  The auto-age sweep does not unschedule anything whose day fell inside the trip until
  the trailing window passes (sweep grace, arm "a resume boundary within autoAgeDays").

## Coming back gently (added 2026-10-08 after Kirby's note)

Kirby finds getting back into a routine after a break the hard part, so the return is
designed as its own feature rather than "everything reappears". Mockups:
https://claude.ai/artifact/S8x5r4wGBUgtPC14Wfweke

1. **Decide the return before leaving.** The trip sheet asks for a pace: *ease back in*
   (suggested: waves over a week), *over 3 days*, or *all at once*. Deciding while calm
   beats deciding on a tired first morning.
2. **Habits come back in waves.** Day 1 brings back one habit, then the rest return on
   days 3, 5 and 7. dsul makes the first draft (easiest first: short ones and long
   streaks lead) and you can drag habits between days. Data: the trip row gains
   `ramp: { "<date>": [itemIds | routineIds | projects] }`. A habit stays inactive until
   its wave's date, through the same predicate, so reminders and stakes follow.
3. **Day one asks for one thing.** The welcome-back card opens the first time you open
   dsul after the trip. It shows: "welcome back! nothing was missed: your streaks waited
   and nothing went overdue". Then (1) pick the one habit to restart today (the suggested
   one has the longest streak waiting), and (2) "N things came up while you were out:
   pick up to 3 for this week". Picked tasks are spread one a day this week; the rest go
   to the braindump under "from the trip". Nothing is deleted and nothing turns red.
   "Bring everything back now" skips it all.
4. **The easing week is softer.** Today shows "easing back, day 3 of 7" with what came
   back that day. A returning habit gets no last-call nudge until it has been back two
   days, the end-of-day review is one line, and missed days during the ramp are just days.
5. Phone: the same card, compact, with the task picking one tap away.

## dsul decides, you confirm (Kirby, 2026-10-08)

Kirby wants no forms on either end: dsul makes every choice and shows it as a plan with
"Change" links. Copy is sentence case (not all lowercase).

**Going away** asks only for the dates (⌘K "going away until Tue" works too). Then a
"Here's the plan" summary, every line pre-decided:
- Everything else pauses (counts of habits, routines, tasks in the trip).
- Keeps going: suggested from habits ticked every day for the last 30 days, weekends
  included (meds, plants); next time, last trip's keep list. Change opens the picker.
- Coming back: eased in over a week by default; a trip of 3 days or less comes back over
  3 days, 1 day or less all at once. Change opens the waves.
- Beeminder line only when a paused habit is wired to it.

**Coming back** asks nothing. The welcome-back card shows a plan already made:
- Today, two things: the habit with the longest waiting streak, and the oldest task
  that came due during the trip.
- The rest of the week: one trip task a day (up to 3, oldest due first), and the habit
  waves (easiest first: shortest and longest-streak habits lead).
- The other trip tasks wait in the braindump under "From the trip".
- One button, "Sounds good"; "Change something" opens the waves.

This supersedes the earlier "pick one habit / pick up to 3 tasks" steps below.

## Storage

New table `away_periods` (one migration, next free number at build time):
`id, user_id, starts_on date, ends_on date null (exclusive), keep jsonb
{routineIds, projects, itemIds, recipeIds}, created_at`, RLS owner-only, at most one
open period per user (partial unique index). A table rather than user_settings columns
because past trips must keep reading correctly: next month's week view of September
still needs September's trip, the same reason a pause keeps its interval on the row.
Edits to a running trip (end it, add a keep) update its row.

## The code change in outline

1. `ActivationContext` gains `away?: AwayPeriod[]`. `isItemActiveOn` and
   `inactiveItemIdsOn` check it first: on a day inside a period, an item is inactive
   unless kept or created on or after that period's start. Callers that omit it behave
   exactly as today.
2. Feed it everywhere a ctx is built: planner store, reminders scan, stakes settle,
   recipe server tick, MCP, agent context, `/api/app` (phone), day-done.
3. EOD push, morning check, timed recipes, mod scheduled events: one `isAwayOn(day)`
   check each.
4. Sweep grace: a period's `ends_on` is a resume boundary in `resumedRecently`.
5. Agent context: an additive `away` field (schema version bump). The plugin's schema
   strips unknown keys, so nothing breaks, but its `renderPaused`
   (openclaw-plugin/src/context.ts) would list every vacation-hidden item as "paused"
   until the plugin learns `away` and is republished.
6. iPhone: `/api/app`'s payload carries the away periods (the phone works out visibility
   itself, lib/app-api.ts), port the layer in Active.swift, extend the shared fixture,
   add the banner and the Settings row. Local notifications don't exist on the phone yet;
   when they come (reminders-platforms plan) they read it too.
7. Desktop needs nothing of its own (it loads do.dsul.app).

## Things to know
- **Beeminder runs its own clock.** dsul not posting is not the same as Beeminder not
  charging: a Beeminder goal still derails unless a break is scheduled on Beeminder,
  and Beeminder only lets you schedule one at least 7 days out. Recommended: when a kept
  list excludes a habit wired to Beeminder, the sheet says so plainly and links to the
  goal. Scheduling the break through Beeminder's API is a later, separate step (it is an
  outward write).
- Accountability partners: their nightly check skips paused habits already; maybe tell
  them "away until Oct 20" (later).
- Timezones: days are the user's days, same as pause.

## Decisions for Kirby (picks 1-3 approved 2026-10-08: A, welcome-back card, warn only)
1. Keep list: A (routines, projects, items) or B (presets). Recommended A.
2. Dated tasks in the trip: leave them to come back with a welcome-back card (recommended),
   or offer at the start to move them past the trip.
3. Beeminder: warn only for now (recommended), or schedule breaks through its API.

## Build order (when it's time)
1. Migration + `away` layer in lib/active.ts with tests (no UI).
2. Server: scan tiers, stakes, recipe tick, agent/MCP, sweep grace.
3. Web: sheet, banner, ⌘K, welcome-back card.
4. iPhone: DsulCore port, fixture, banner, Settings row.
