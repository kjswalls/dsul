# Ghost rows on Today

What was left undone on an earlier day shows up faded at the top of today, until
the person says what happens to each one. Designed with Kirby over three mockup
rounds and a playground (2026-10-30 to 2026-10-31; handoff in
`/mnt/project-files/handoffs/evening-ghost-rows.md`). It replaces two rituals:
the dock's waiting notice (phase 1) and the end of day review (phase 2).
Both are gone everywhere, the iPhone's own review included (phase 3).

Code: [lib/ghost-rows.ts](../../lib/ghost-rows.ts) (which items, in what order),
[components/planner/ghost-fold.tsx](../../components/planner/ghost-fold.tsx) (the
fold, its rows and the phone's sheet), [hooks/use-overdue-today.ts](../../hooks/use-overdue-today.ts)
(the predicate's inputs), the `[data-ghost-row]`
rules in [app/globals.css](../../app/globals.css) beside the row rules. On the
iPhone: ios/DsulCore `Overdue.swift` and `GhostRows.swift` (the ports),
ios/Dsul/Model/GhostRowsModel.swift (the planner's side) and
ios/Dsul/Today/GhostFold.swift (the fold, its rows and sheet).

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
  rails at reduced opacity. The title is muted ink. **No lime in a ghost row**:
  a low priority's bars are lime, so the priority glyph is drawn `muted` (never
  faded through opacity), and arrive's fade composites no accent. The box is a
  **dashed outline, no fill**, that closes into a solid box with a Plus on hover
  (never on a box that cannot keep, e.g. inside a project block); the
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
  never faded) for a few seconds (`GHOST_DONE_MS`), then nothing. Only when a
  verb in the fold emptied it: a pile emptied by the auto-age sweep, a catch-up
  from another device or a pause goes quietly. No em dashes,
  no red, no overdue words.
- **Phone.** MobileShell draws the same day views, so the fold is there too.
  No hover, so a ghost row shows the same trailing ellipsis a real row does; it
  opens a drawer with the five verbs as large rows, "Keep for today" the ink
  primary, Reschedule opening a calendar in place. The caption's two bulk
  buttons stay visible on touch. Swipes are out of scope.
- **The switch.** The account setting `morning_check_enabled`
  (`rituals.morningCheck`, `useMorningStore().morningCheckEnabled`) is the
  fold's switch, relabelled "Leftovers on Today". The ⌘K toggle follows the
  label, and `goto.overdue` ("Show leftovers") goes to today's Day view. The
  auto-age sweep (hooks/use-overdue-sweep.ts) still depends on it and is
  unchanged. **On by default for a new account** (Kirby, 2026-10-31):
  migration 086 moves the column default to true without flipping a row, and
  settings-service's first-run seed and the manifest default say true. The
  store's own default and the provider's reading of a NULL stay off, so the
  fold never flashes in before an account's settings land.
- **It replaced the waiting notice and the end of day review.** Kirby's call:
  one surface for what was left, and it waits to be opened.

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

1. **Web (done, #633).** The fold, its verbs and sheet, the switch relabelled,
   the waiting notice stood down.
2. **Retire the evening review and the tray (done).** What went, what stayed
   and why is below.
3. **iPhone (done).** lib/ghost-rows.ts and lib/overdue.ts ported to
   ios/DsulCore, the fold drawn in the SwiftUI day views, and the iPhone's own
   end of day review retired. Notes below.

## Phase 2: what was removed

- **The waiting tray.** components/ai/morning-check.tsx (the dock line and
  `WAITING_LINE_RETIRED`), components/ai/morning-triage-list.tsx, the tray's
  parts of lib/morning-store.ts (`isOpen`/`open`/`close`/`toggle`, `dismiss`,
  `resetDismissal`, `isDismissedToday`, `morningCheckDismissedDate`; a blob an
  older build persisted has the last two stripped on merge), and
  lib/overdue.ts's `summarizeOverdue` / `OverdueSummary` /
  `OVERDUE_COHORT_LABELS`. Kept: the switch, `morningCheckTime` (a setting
  nothing reads, left alone), and the sweep with its receipt.
- **The end of day review.** The modal (components/ai/eod-review.tsx),
  lib/eod-store.ts, lib/eod-link.ts and AppShell's `?eod=` handler (an old
  notification's `/?eod=<day>` now just opens home), the dock's "Today's review
  is waiting" line, the ⌘K `rituals.eod` and `settings.eodReview` commands, the
  `rituals.eodTime` settings record (`rituals.eod` stayed until phase 3), the Devices list's
  "End-of-day review" switch, Ask home's "N free" (it counted to the review's
  hour; there is no day end now), and the rituals nudge's review half (it now
  introduces the leftovers alone). The `dsul-eod-store` blob is removed by
  lib/local-state.ts's raw clearers.
- **The server's push.** lib/reminders/scan.ts's Tier 0 (claim on
  `last_eod_notified_date`, `eodNudge`), build.ts's `eodNudge`, the summary's
  `eod` count, and the retry of an `eod` cue_log row (closed `not_wanted`, never
  re-sent). `eod_review_enabled` stays in `TICK_FLAGS` because dsul_tick (058)
  names it and the two are held to each other by a test; a user there for it
  alone is read and skipped.
- **Ids.** No shortcut id was involved. Command and settings ids are not
  frozen, so the ⌘K `rituals.eod` and the rest are deleted rather than
  repointed, and `eod` became an alias of `goto.overdue`, so /eod lands on the
  leftovers. The settings record `rituals.eod` was kept under its own id until
  phase 3 removed it with the iPhone's review.
- **Columns stay**: `eod_review_enabled`, `eod_review_time`,
  `last_eod_notified_date`, `last_eod_review_date`,
  `morning_check_dismissed_date`, `morning_check_time`. settings-service still
  selects and seeds them.

## Phase 2: the `review.saved` stand-in

Stored recipes and mods name `review.saved`, so the kind, its schema and its
payload (`{ kind: 'review.saved', date }`) are unchanged, and it now fires at
the "All sorted, you got this" moment: the fold emptied by the person's own
verbs, never by the sweep, a catch-up or a pause. ghost-fold.tsx calls
lib/morning-store.ts `noteLeftoversCleared(userId, today)`, which raises it
through the bus at most once per account and day on this device
(`leftoversClearedByUser`, local, self-pruning, pruned to the incoming account
on a switch). `date` is today, the only day the fold is drawn on. The trigger
reads "I sort the last leftover on Today" in the recipe builder, "when the last
leftover on Today is sorted" in a mod's hooks, and Make's prompt describes the
moment. The review's Done raised it only when the reviewed date moved; this is
the same once-a-day shape.

## Phase 3: the iPhone

- **Where.** The first section of List (below the filter chips, which never
  filter it), the first card of Buckets, and a card above Anytime in Schedule,
  in Day on today only (`isOnToday`, the user's zone). Not in Week, as the
  web's week views have none. Schedule shows three rows, then they scroll, so
  the hours keep their room; while the braindump sheet is up it shows the
  caption alone, as the Anytime band does.
- **When.** `SamplePlanner.ghostRows` is DsulCore `selectGhostRows` at TODAY,
  over `inactiveItemIdsOn` and `milestoneItemIds`, and answers none before the
  first fetch lands, with `leftoversOnToday` off, and while the goals are
  unread (`milestoneIds` nil, a server that couldn't read them): a milestone
  must never ghost, and failing closed hides the fold rather than risk one.
- **The switch.** The payload carries `settings.leftoversOnToday`, the
  account's `morning_check_enabled` (lib/app-api.ts: the row's value, true with
  no row, matching the new-account default). Swift decodes it leniently and
  reads a missing field as true, so a server one version behind still shows the
  fold; the phone has no switch of its own (the web's Rituals pane is it).
- **Rows.** The real row's geometry, muted: a dashed box in the secondary ink
  where the tick is (a tap is Keep for today), the title in the secondary ink,
  and the ghost's weekday ("Thu", `ghostWeekday`) where the time is. No lime
  anywhere in a ghost row, so nothing lime is ever under arrive's or breathe's
  opacity.
- **Motion.** Arrive: opacity 0 and a 2.5pt blur to rest over 1.1s on the web's
  curve, staggered 120ms, once per planner (`ghostsHaveArrived`, so a layout
  switch draws the rows at rest). Breathe: the box alone, 1 to 0.6 and back
  over 8s (4s each way, autoreversed), staggered. Both off under Reduce Motion.
- **Gestures.** Swipe right is Keep for today, swipe left Move to tomorrow:
  List's own `swipeActions` (full swipe runs it), and a horizontal-only drag
  (`GhostSwipe`, 80pt) in Buckets and Schedule, which have no List row to hang
  them on. A side whose verb the gate refuses doesn't move. A tap on the row
  opens `GhostSheet` (through the planner's one sheet slot, `PlannerSheet.ghost`):
  the title, "Planned for Thu, Oct 15", then Keep for today (the ink primary),
  Move to tomorrow (with today's tomorrow beside it), Reschedule (DayPickSheet
  over the sheet, "Move to …"), Send to sidebar and Let it go ("Kept in
  history"), each only where it lands, the drawer's order. VoiceOver hears each
  row as one element ("Call the bank, from Tuesday") with the verbs as named
  actions.
- **Caption.** "From earlier", the muted count and a chevron; Keep all and Send
  all to sidebar always on screen (touch has no hover). Over five ghosts the
  fold starts collapsed, decided at first sight, as on the web.
- **Writes.** Every verb is a write the phone already made, asked through the
  same gates the web's fold asks on the ghost's own day (DsulCore
  `ghostVerbAllowed`, checked against ghost-rows.json) plus `canWrite`: Keep,
  Move to tomorrow and Reschedule are `move` (`moveTaskToDate`), Send to
  sidebar is `unschedule` (`unscheduleTask`). Let it go had no phone route, so
  POST /api/app/items/:id gained `letGo` (lib/item-intents.ts `applyLetGo`:
  `{status:'cancelled'}` behind `letGoItems`' filter, 409 `not_let_go`, 200 and
  no write for a row already cancelled) and the payload's `writes` lists it,
  so a server without it never shows the verb.
- **Keep all differs from the web on one point.** The phone has no bulk item
  route, so Keep all is one `move` per ghost, which keeps each item's clock
  time, where the web's `moveTasksToDate` drops a stale one. Each lands on
  today in its own bucket either way. A bulk route that drops the time is the
  fix if it matters.
- **"All sorted, you got this"** with the one lime dot, at full strength and
  with no transition, for four seconds (`ghostsSortedAt`, stamped only when the
  person's own verb or bulk verb took the fold from some to none). A fetch, a
  pause, or a change on another device that empties it goes quietly. The phone
  raises no `review.saved`: recipes and mods run on the web.

## Phase 3: what went with the iPhone's review

- lib/eod.ts (and its test), lib/reminders/plan.ts's review (`EOD_IDENTIFIER`,
  `EOD_CATEGORY`, `eodIdentifiers`, the `eod` input and requests),
  lib/reminders/copy.ts `EOD_COPY`, and their Swift mirrors in
  ReminderPlan.swift and ReminderCopy.swift; the fixtures were regenerated
  without them.
- The planner payload's `eodReviewEnabled` / `eodReviewTime` /
  `lastEodReviewDate`, replaced by `leftoversOnToday`.
- The `eod` NudgeKind, CueLogKind, `dayKey('eod')`, push channel entry,
  `DeviceSendKind` 'eod' and LOCAL_KINDS entry. Stored data still names it, so
  `DevicePrefsSchema.kinds` keeps accepting an `eod` key (a parse failure would
  drop a device's mute and quiet hours), a `cue_log` row of kind `eod` is still
  closed `not_wanted`, and electron's key pattern still reads one.
- The settings record `rituals.eod` ("Evening nudge on iPhone"),
  reminder-store's `iphoneEveningNudge`, and the `shownWhen` SettingRecord
  field it alone used.
- On the phone: the `DSUL_EOD` category (only the cue's is registered now), and
  NotificationScheduler removes any pending or delivered `dsul-eod` /
  `dsul-eod#…` request an older build left, and never presents one.

## Open question

- Later pass: hovered-row keys (K / T / S / B / Backspace).
