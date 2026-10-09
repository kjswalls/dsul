# Handoff: vacation mode

Thread: "vacation mode" in the dsul project. Updated 2026-10-09. **Planning and design only so far; nothing is built** (no branch, PR or migration).

## Goal
A vacation mode that pauses everything in dsul except what you choose to keep, and makes coming back from time away easy and not overwhelming. Kirby finds getting back into a routine after a break the hardest part, so the return gets as much design as the pause. Kirby wants dsul to make the choices on both ends, so there are no forms to fill in. Copy is sentence case (not all lowercase), with no em dashes.

## Where things are
- Plan, with grounding in main at f21a40c: memory/handoffs/vacation-mode/plan.md. Read the "dsul decides, you confirm" section first; it supersedes the earlier pick-steps.
- Mockups canvas (Design artifact, 6 artboards): https://claude.ai/artifact/S8x5r4wGBUgtPC14Wfweke
- Copies of the mockup source files: memory/handoffs/vacation-mode/mockups/. They are the canvas's `project/` files; publish edits to the same canvas url with `root` set to a folder holding `project/`.
- Team memory: vacation-mode-2026-10.

## Decided by Kirby
1. Exclusions are a keep list of routines, projects and single items, not presets.
2. Tasks dated during the trip are left in place and handled by a welcome-back plan, not moved when the trip starts.
3. Beeminder: warn only (it charges on its own clock and needs 7 days' notice for a break). No API calls.
4. No forms. Going away asks only for dates, then shows "Here's the plan" with Change links. Coming back shows a ready-made first week with one "Sounds good" button.
5. Easing back in over a week is the default return pace.

## Design in one paragraph
One `away_periods` row per trip (starts_on, exclusive ends_on, keep jsonb, ramp jsonb of date to items/routines/projects) becomes the outermost, conjunctive layer of `isItemActiveOn` in lib/active.ts. Every surface that already asks that predicate (reminders, stakes, day-done, recipe filters, MCP, agent context) follows it. Undated braindump items stay visible. Items added in the app during a trip are auto-kept. Streaks need no handling because they only move on a tick. The plan lists every surface that needs the trip passed in, as found by an adversarial review: braindump's Paused section, showPausedOnGrid, the EOD notice and ?eod=, sweep grace in hooks/use-overdue-sweep.ts, goals pace, subtasks, /api/app for the iPhone, and the OpenClaw plugin's renderPaused.

## Open questions for Kirby
- None blocking. Smaller calls he hasn't been asked yet: how the keep-list suggestion is worded, the rule for short trips (3 days or less comes back over 3 days, 1 day or less all at once), and whether to add an opt-in "back tomorrow" evening nudge.

## Next steps
1. Wait for Kirby's reaction to the latest mockups (no-forms version).
2. When he says build: this is multi-PR, adds a migration and changes web, server and iPhone together, so it qualifies for the ultracode workflow under the project rules. Build order is in plan.md: migration plus the active.ts layer with tests, then server surfaces, then web UI (sheet, banner, ⌘K, welcome back, easing week), then the iPhone (DsulCore Active.swift port plus the shared fixture).
3. Check main, prod's ledger and open branches for the next free migration number at build time.
