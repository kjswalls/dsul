# YouTube Weekly Devlog in dsul

Source: "YouTube Weekly Devlog Plan" doc (2026-10-08). Checked against `main` on 2026-10-08. Nothing was created; this is a proposal.

## The shape

| Plan piece | dsul home | Why |
|---|---|---|
| The channel's work | **Project** "Sunday Softworks" (or "YouTube") | Every item below files under it, so it filters and colours as one. |
| Season 1 (12 episodes) | **Season** "Devlog Season 1", state `paused` until launch, then `auto` with `startsOn` = launch Sunday and `endsOn` ≈ 12 weeks later | dsul's Season is literally this: a stretch of life whose items only show while it's on. Pre-launch, the weekly cycle stays hidden. |
| The weekly cycle | **Routine** "Episode week", members in order: Capture → Record → Edit → Publish → Buffer check | A routine is "things done regularly, in order"; it pauses as one (a holiday week = pause the routine, not five items). |
| Each weekly row | **Habits** with custom weekdays (below) | Habits give per-date completion, streaks, skip, and the streak-at-risk reminder. "Never miss two Sundays" maps onto the Publish habit's streak. |
| Success = shipping every week | **Goal** "Ship Season 1", why: "shipping every week, not views", targetOn = episode 12's Sunday | Milestones = the launch tasks; check-in = the Publish habit. |
| Launch tasks (ordered) | One parent **task** "Launch the devlog" with 7 **subtasks** in order | dsul has no task dependencies; subtask order is the closest fit. "Pick a launch Sunday" and "Launch" also go on the goal as milestones. |
| Buffer and skip rules | Notes on the Sunday "Buffer check" habit and the goal's why | Standing rules, not tasks, as the plan asks. |
| Episode template | Notes on the Friday "Record narration" habit | The four beats live where they're used. |
| Time caps | `duration` (minutes) on each item | Sizes the block on the schedule grid. There's no timer that stops you at the cap (the Focus timer isn't on web yet). |

### The habits

| Habit | Days (`repeatDays`) | Time / duration | Notes |
|---|---|---|---|
| Capture a clip + one-line note | Mon–Thu `[1,2,3,4]` | 5 min | Done when one clip and note are saved |
| Record narration | Fri `[5]` | 60–90 min | Episode template's four beats |
| Edit and package (stop at 2h) | Sat `[6]` | 120 min | Done when uploaded as scheduled/private |
| Publish and share | Sun `[0]` | 15 min | Goal check-in; optional Beeminder stake |
| Buffer check | Sun `[0]` | 5 min | Buffer rules in notes |

### Optional extras

- **Recipe** (Settings → Make, or "Write with AI" there): when "Publish and share" is skipped, create a task "Publish a minimum viable episode (5–10 min unedited)" in the project and toast "A rough episode still counts." Triggers available today: item completed/skipped/created, review saved, day opened, a time of day, ⌘K.
- **Beeminder stake** on "Publish and share" if you want money behind the never-skip-twice rule.
- **Buffer count**: dsul has no number field for "episodes banked". Options: write it in the Buffer check habit's notes each Sunday, or later a small **mod** braindump card with a 0/1/2 counter (mods have their own storage; AI-written mods are #439, not merged yet).

## What MCP can do today

dsul's MCP server is `/api/mcp`, 15 tools in `lib/mcp/tools.ts`, signed in with the pasted agent key (so it works from Claude Code or OpenClaw; Claude.ai connectors probably can't connect yet, #261).

**Can do (roughly 85% of the setup):**
- Habits with custom weekdays, start time, notes, project: `dsul_create_habit` (`group` = project name).
- Launch tasks and subtasks with dates, duration, notes, priority: `dsul_create_task` (`parentItemId` for subtasks).
- Routine with ordered members and usual time, Season with dates/state/routines, Goal with why, target, milestones and check-ins: `dsul_create_collection`.
- Pausing/resuming items or the routine later: `dsul_pause`.
- Week to week: ticking habits, logging skips, editing notes, reading the whole planner (`dsul_get_context`).

**Gaps:**
1. **No create-project tool.** The REST route `POST /api/agent/projects` exists but MCP doesn't expose it, and naming a project that doesn't exist files the item with no project behind it (`lookupContainerId` in lib/db.ts returns null). Workaround: make the project in the app first, one click.
2. **No habit duration over MCP.** The API accepts it, but `HABIT_WRITE_KEYS` drops it, so the time caps on habits need setting in the app.
3. **No recurring tasks over MCP.** `repeatFrequency` is in `TASK_WRITE_KEYS` but not in `dsul_create_task`'s schema, so clients won't send it. Doesn't matter here since habits fit better.
4. **No reminder time over MCP** (`reminderTime` isn't in the write keys). Habits still get their cue at their own start time.
5. **No recipes, mods, stakes or custom item types over MCP.** Those are app-only (Settings → Make / Extensions).
6. **No task dependencies anywhere in dsul**, so "each depends on the one before" is ordering only.

Gaps 1, 2 and 4 are each a few lines in `lib/mcp/tools.ts` if you want them later.

## Suggested order (if done over MCP)

1. In the app: create project "Sunday Softworks".
2. MCP: 5 habits, then "Launch the devlog" + 7 subtasks.
3. MCP: routine "Episode week" (5 habits in order), season "Devlog Season 1" (`state: paused`, routine attached), goal "Ship Season 1" (milestones + Publish as check-in).
4. In the app: habit durations, the optional recipe and stake.
5. On launch day: set the season's `startsOn`/`endsOn` and `state: auto` (MCP can do this).
