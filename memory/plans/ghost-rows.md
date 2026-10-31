# Ghost rows on Today

What was left undone on an earlier day shows up faded at the top of today, until
the person says what happens to each one. Designed with Kirby over three mockup
rounds and a playground (2026-10-30 to 2026-10-31; handoff in
`/mnt/project-files/handoffs/evening-ghost-rows.md`). It replaces two rituals:
the dock's waiting notice (now) and the end of day review (phase 2).

Code: [lib/ghost-rows.ts](../../lib/ghost-rows.ts) (which items, in what order),
[components/planner/ghost-fold.tsx](../../components/planner/ghost-fold.tsx) (the
fold, its rows and the phone's sheet), [hooks/use-overdue-today.ts](../../hooks/use-overdue-today.ts)
(the predicate's inputs, shared with the waiting notice), the `[data-ghost-row]`
rules in [app/globals.css](../../app/globals.css) beside the row rules.

## Decisions

- **Shape B: one quiet fold at the top of Today.** Not A (each ghost in its old
  bucket) and not C (one card at a time). The fold is the first child of the Day
  view's `canvas-container` in all three day layouts (List, Buckets, Schedule;
  in Schedule it sits above Anytime), so it shares the rows' left edge. Not in
  the week views for now, and not in the Do stuff desk's day column.
- **Caption** in GroupSection's canvas-heading voice: "From earlier", a muted
  tabular count, a ChevronDown that collapses. Hovering (or focusing) the caption
  shows two text buttons, "Keep all" and "Send all to sidebar". With more than
  five ghosts (`GHOST_PILE_THRESHOLD`) the fold starts collapsed and those two
  stay on screen. "Starts" is decided by the count at first sight, so a pile
  shrinking to five never springs the fold open under the pointer.
- **Rows are the real row's geometry.** TaskRow's 16px box column, the title,
  the start-time slot, the reserved day-dots slot, tag / priority / duration
  rails at reduced opacity. The title is muted ink. The box is a **dashed
  outline, no fill**, that closes into a solid box with a Plus on hover; the
  item's original weekday ("Thu") sits in the start-time slot, its full date in
  the tooltip. Clicking the title opens the item (`openEditFor`) and writes
  nothing.
- **Motion: arrive + breathe** (Kirby, 2026-10-31; drift was the runner-up and
  is one CSS swap away). Arrive: each row fades in from opacity 0 and a 2.5px
  blur over 1.1s, `cubic-bezier(.25,.1,.25,1)`, staggered 120ms, no transform,
  with `will-change: opacity, filter` left on so the end does not snap (the snap
  was text re-rasterising when a layer dropped). Breathe: the dashed box alone,
  opacity 1 to 0.6 and back over 8s, staggered with negative delays, paused while
  the row is hovered. Both off under `prefers-reduced-motion` and the app's own
  reduce-motion switch.
- **Verbs**, on hover in the existing RowControlGroup capsule where TaskRow's
  sits, each an existing store action so undo history and the undo strip come
  with it (hooks/use-undo-toast.ts already lists every label):

  | Verb | Control | Store action | Label prefix |
  |---|---|---|---|
  | Keep for today | Plus (and the box) | `moveTaskToDate(id, today)` | `Move task to` |
  | Move to tomorrow | Redo2 | `moveTaskToDate(id, tomorrow)` | `Move task to` |
  | Reschedule | RescheduleControl | `moveTaskToDate(id, picked)` | `Move task to` |
  | Send to sidebar | ArrowLeftToLine | `unscheduleTask(id)` | `Unschedule task:` |
  | Let it go | X ("Kept in history") | `letGoItems([id])` | `Let go:` |
  | Keep all | caption | `moveTasksToDate(ids, today)` | `Move all tasks` |
  | Send all to sidebar | caption | `unscheduleTasks(ids)` | `Unschedule task:` |

  Each control is gated by lib/row-moves.ts on the ghost's own day (and Let it
  go by the type's `allowedStatuses`), so a control never no-ops. Keep all is
  the bulk carry, which keeps each item's bucket and drops its stale clock time
  (its contract); one gesture, one undo.
- **Copy.** "From earlier", "Keep all", "Send all to sidebar", "Keep for today",
  "Move to tomorrow", "Reschedule", "Send to sidebar", "Let it go", and after the
  last ghost "All sorted, you got this" with one small lime dot (`bg-primary`,
  never faded) for a few seconds (`GHOST_DONE_MS`), then nothing. No em dashes,
  no red, no overdue words.
- **Phone.** MobileShell draws the same day views, so the fold is there too.
  No hover, so a ghost row shows the same trailing ellipsis a real row does; it
  opens a drawer with the five verbs as large rows, "Keep for today" the ink
  primary, Reschedule opening a calendar in place. The caption's two bulk
  buttons stay visible on touch. Swipes are out of scope.
- **The switch.** The account setting `morning_check_enabled`
  (`rituals.morningCheck`, `useMorningStore().morningCheckEnabled`) is the
  fold's switch, relabelled "Leftovers on Today". The ⌘K toggle follows the
  label, and `goto.overdue` ("Show leftovers") now goes to today's Day view
  rather than opening the tray. The auto-age sweep still depends on it and is
  unchanged.
- **It replaces the waiting notice now.** While the switch is on, the dock's
  waiting line (`useWaitingNotice`, components/ai/morning-check.tsx) no longer
  renders (and while it is off it never did). The tray code stays, unreached,
  until phase 2 deletes it.

## Rules

- **Ghosts are a view.** Nothing is written by showing one: no flag on the item,
  no table, no settle. The rows are recomputed from the store on every render,
  and only a picked verb writes.
- **`selectOverdue` is the one predicate.** `selectGhostRows` is
  `selectOverdue(items, today, inactiveIds)` (lib/overdue.ts) with milestones
  taken out and the order changed to newest first. `inactiveIds` comes from
  `inactiveItemIdsOn` at TODAY through hooks/use-overdue-today.ts, the same
  inputs the waiting notice used. Never re-derive "is this left from earlier".
- **Milestones and recurring items never ghost.** A recurring item's misses are
  per-date state (selectOverdue already refuses it). A milestone's date is its
  target, and the bulk verbs would walk or erase it (lib/goals.ts
  `milestoneItemIds`, over the raw goals). Habits, subtasks, done and cancelled
  items, and anything set aside today never ghost either, by the predicate.
- **Today only.** The fold renders only when the day drawn is today in the
  user's saved timezone (`toDateStr`), and only once the planner has LOADED
  (`usePlannerLoaded`): a pile counted from the preview's cached rows, or a
  failed load's empty store, is not the pile.

## Phases

1. **Web (this build).** The fold, its verbs and sheet, the switch relabelled,
   the waiting notice stood down.
2. **Retire the evening review and the tray.** Delete the waiting tray
   (morning-check.tsx, morning-triage-list.tsx), retire the end of day review
   (modal, dock line, the EOD push in lib/reminders, `rituals.eod*` settings),
   replace the `review.saved` recipe trigger, and turn `/eod` into "go to
   leftovers". Read habit-reminders.md and reminders-platforms.md before
   removing the push.
3. **iPhone.** Port lib/ghost-rows.ts to ios/DsulCore and draw the fold in the
   SwiftUI day view.

## Open question

- **On by default for new accounts?** Recommended in the handoff, not decided.
  It needs a migration changing `morning_check_enabled`'s column default plus
  the settings-service default (and `defaultValue` in the manifest,
  `ritual-defaults.test.ts`, the morning store's initial state). Phase 1 changes
  no default and writes no migration.
- Later pass: hovered-row keys (K / T / S / B / Backspace).
