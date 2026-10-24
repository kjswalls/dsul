# iPhone app (ios/)

Status (2026-10-02): PR 1, the shell and the drag spike, on sample data.
PR 2 builds Today on the G board: List, Buckets and Schedule layouts behind
the up-down capsule beside the avatar, the title as a date picker, and the
capture bar as the tab view's bottom accessory, still on sample data with
local toggles.
PR 3 signs in with Google and shows the user's own items: bearer-auth routes
under `/api/app/*`, Today's rules ported to DsulCore against fixtures the TS
writes, and three writes (tick, braindump→hour, capture). "Try with sample
data" on the sign-in screen keeps the PR 2 sample (and the drag spike) one tap
away. One PR for all three parts, so merging deploys the routes and the app
together. Sign in with Apple joins Google and the email link: Apple's button,
GoTrue's id_token grant, and a sign-out when Apple says the Apple ID was
revoked or changed.
Item detail, part 1 adds the item sheet, opened from every surface: what the
item is (read-only) and its verbs, with three more writes (skip, move, pause)
on the same route. Part 2 makes it editable, in seven PRs; the first (2a) edits
the title and the notes and adds Delete, with three more writes (title, notes,
delete), and replaces PlannerSync's slots with a rebase per subject.
Organize, the third tab, is built as its own series (O1 to O15, the design in
the shared folder's `ios-app/organize/design.md`); O1 lists the containers,
O2 and O3 give each its page, read-only but for the tick, O4 adds the
summary cards, O5 and O14 the footer's Item types, Paused (with an
item's Resume) and Trash (with Restore), O8a the first container writes:
a routine's and a season's Status, and Resume on Paused for both, O8b a
goal's Status, a routine's usual time, a season's Runs, a goal's window and
the notes, O9 Rename… and Icon and color… on every page, O10 Delete…
there, O11 the list's + menu, which makes a routine, season, goal or
project from a name, O12 a routine's steps (Edit, reorder, "Add from your
items…", Remove), O13 a season's routines ("Add a routine…" with the
attach confirm, Take out) and O15 Today's project dots, the item sheet's
project chip and its menus in each project's own colour, the web's (see
Organize below).
Designs, the stack comparison and the board images live in the project's
shared folder (`ios-app/`): `stack.md` has a SwiftUI build note for every
interaction, and `expo-vs-swiftui.md` ends with the fact-check.

## Decisions
- **SwiftUI, not Expo** (Kirby, 2026-10-01). The approved boards' native
  details (the item sheet's own navigation, native swipe rows, the up-down
  capsule, the title menu, the search tab, the drag onto an hour) are SwiftUI
  or hand-written Swift in Expo anyway, and the Lock Screen pieces are Swift
  in both. The cost is porting the item logic.
- **Same repo, under `ios/`**, like `electron/`: one PR can change a TS rule,
  its Swift port and the server route the phone needs. The repo is public, so
  GitHub's macOS runners are free.
- **iOS 27 minimum.** The drag APIs (`draggable(containerItemID:)`,
  `dragContainer`, `onDragSessionUpdated`, `onDropSessionUpdated`) are iOS 27
  on iPhone, and iOS 27 runs on every iOS 26 device.
- **XcodeGen** (`ios/project.yml`), so cloud sessions can edit the project as
  text. The `.xcodeproj` is generated and gitignored.

## Layout
- `ios/Dsul`: the app. `ios/DsulTests`: hosted tests (Swift Testing).
- `ios/DsulCore`: Foundation-only Swift package, Linux-testable. Ports:
  `Recurrence.swift` ← `lib/recurrence.ts`; `ScheduleMath.swift` ←
  `lib/schedule-constants.ts` and the snap/autoscroll helpers in
  `components/views/day-schedule.tsx`; `DayBuckets.swift` ← the bucket
  placement in `lib/day-items.ts` and the in-bucket row order in
  `components/views/day-buckets.tsx`; `HabitCompletion.swift` ← the
  optimistic completion step of `toggleHabitStatus` (and the habit branch of
  `setItemsCompleted`) in `lib/planner-store.ts`; clearing the day's skip
  lives with the tick (`ItemToggle.swift`) and the skip's own step
  (`VerbWrites.swift`).
  PR 3 adds `Item.swift` ← packages/types `ItemSchema` (as `itemFromRow`
  builds it) and the `/api/app/planner` payload (lib/app-api.ts), decoded
  leniently; `Registry.swift` ← the slice of `lib/item-registry.ts` Today
  reads; `Active.swift` ← `lib/active.ts`; `DayItems.swift` ←
  `projectItems` (lib/planner-store.ts), `deriveDayItems` and
  `flattenDayRows` (lib/day-items.ts), `deriveTimedEntries`
  (day-schedule.tsx), `lib/braindump-members.ts` and `routineGroups`
  (lib/grouping.ts); `ItemToggle.swift` ← `lib/item-toggle.ts` and the store's
  resolution of it; `AuthCore.swift`, the pure half of sign-in (PKCE, the
  GoTrue requests, refresh verdicts, the callback check of
  app/auth/ios/route.ts, the Apple nonce, the id_token grant and the name
  write).
  Item detail adds `ItemVerbs.swift` ← `lib/item-verbs.ts` (each verb's gate,
  label and detail, `drawnState`/`occurrenceOn`) and `occursOn` from
  `lib/reminders/due.ts`; `RowMoves.swift` ← `lib/row-moves.ts` (the carry)
  with `addDaysToDateStr` from `lib/goals.ts`; `Cadence.swift` ← the chips'
  words (`lib/cadence.ts`, `membershipSummary` from `lib/item-bands.ts`,
  `formatCueTime` from `lib/reminders/copy.ts`, `formatDay` from
  `lib/active.ts`, `weekStartOf` from `lib/container-schedule.ts`);
  `VerbWrites.swift` ← the store's `setItemSkipped`, `moveTaskToDate` and
  `setItemPaused` (through `resolvePauseWrite`, the rule `lib/item-pause.ts`
  applies on the server).
  Item detail, part 2 adds `ItemEdit.swift` ← `lib/item-edit.ts` (which edits
  a row takes, the growth caps, the cleaners, `jsTrim` as
  `String.prototype.trim`, and `editing`, the optimistic step) and the store's
  `deleteTask` / `deleteHabit` (`deleting`, which records each removed item's
  `Place`, and `reinserting`, which puts a failed delete back); and
  `ItemWriteBody.swift`, the wire body of each edit and of Delete (with the
  `null` a cleared field sends, which a missing key is not), checked on Linux
  against the fixture. `Registry.swift` gains the notes gate, the title
  placeholder, Delete's words and a custom type's own label (`ItemTypeLabel`,
  `caps(_:labels:)`). 2b adds `subtaskItem` (the store's `addTask` for a new
  subtask) and `resettingStreak` (`resetHabitStreak`) to `ItemEdit.swift`,
  `canAddSubtask` to `Registry.swift`, `BulkLines.swift` ← `lib/bulk-add.ts`
  (`isBulkPaste`, `splitBulkLinesWithMeta`: the list markers matched by hand,
  with JS's `\s` and ASCII digits, since NSRegularExpression's are
  Unicode-wide) and `EditCopy.swift` ← `EDIT_COPY` and `streakRunText`
  (lib/item-edit.ts). 2c adds the chips' three edits (`priority`,
  `timesPerDay`, `reminder`) to `ItemEdit.swift` and `ItemWriteBody.swift`,
  with `cleanAnchor` (the cue words as the phone sends them) and
  `editAllowed(action:on:caps:)` (the gate by action name, which a chip asks
  before it has a value); `isRemindable(_:caps:)` and `reminderNeedsDate`
  (← `lib/bulk-edit.ts`) to `Registry.swift`; and the reminder sentences to
  `EditCopy.swift`. 2d adds `.time` to `ItemEdit.swift` and
  `ItemWriteBody.swift` (its step ports `timeEditPatch`, the dialog's
  `commitEdit` over the keys sent); `bucketForTime`, `autoCorrectBucket` and
  `bucketStartTime` (← `lib/time-bucket.ts`) to `DayBuckets.swift`;
  `durationPresets` and `durationLabel` (← `lib/item-edit.ts`) to
  `EditCopy.swift`; and `hasDuration` to `Registry.swift`. 2e adds `.repeats`
  to `ItemEdit.swift` and `ItemWriteBody.swift` (its step ports
  `repeatEditPatch`); `repeatFrequencyOrder`, `repeatFrequencyLabel`,
  `weekdayLabel` and `weekdayOrder` to `Cadence.swift`; the two repeat
  sentences to `EditCopy.swift`; and `allowedFrequencies` to `Registry.swift`.
  2f adds `.project` and `sameProjectName` to `ItemEdit.swift` (its step
  ports `projectRefilePatch`), `projectId` and the stash to `Item.swift`,
  `color` and `emoji` to `Project`, `containerKind` and `containerRequired`
  to `Registry.swift`, and `ContainerWords` to `EditCopy.swift`, pinned to
  `CONTAINER_KINDS` through the fixture. 2f-b adds `.collect` to
  `ItemWriteBody.swift` and `settingMembership` (← the store's
  `setItemsCollected`) in `Membership.swift`. Account deletion adds
  `Account.swift` ← `lib/account-types.ts` (the facts, the answer, the body)
  and `lib/account-copy.ts` (the sheet's words and the rules that pick them).
  Reminders' Phase 2a adds `ReminderClock.swift` ← `lib/reminders/clock.ts`,
  `ReminderDue.swift` ← `lib/reminders/due.ts`, `ReminderCopy.swift` ←
  `lib/reminders/copy.ts`, `ReminderSnooze.swift` ← `lib/reminders/snooze.ts`
  and `ReminderPlan.swift` ← `lib/reminders/plan.ts` (which local
  notifications the phone arms and withdraws; nothing schedules one yet, see
  reminders-platforms.md's 2026-10-09 addendum).
  Vacation mode adds `Away.swift` ← `lib/away.ts` (`isDayBound`, `isKeptOn`,
  `returnDayOf`, `awayHoldOn`), asked first by `isItemActiveOn` and
  `inactiveItemIdsOn` through their `away:` argument and `ActivationContext.away`
  (empty by default, so a caller without trips answers as before), and
  `AwayPeriod` / `AwayKeep` in `Item.swift`, decoded from the planner's
  `awayPeriods` (nil from an older server; `trips` reads it as none).
  `PlanInput.away` carries them into the notification plan.
  Organize's O1 adds `Collections.swift` ← `lib/collections.ts` (`countLive`
  and the routine and season state pills), `ActiveExplain.swift` ← the
  explanations in `lib/active.ts` (`seasonResumeDate`, `routineStandingOn`),
  `Goals.swift` ← `lib/goals.ts` (progress, `progressLabel`, the display
  order), `ContainerSchedule.swift` ← `lib/container-schedule.ts`
  (`containerMemberIds`, and `OrganizeKind`) and `ContainerLook.swift` ←
  `lib/accent-colors.ts`, `lib/category-icons.ts` and the colour tokens in
  `app/globals.css` (a container's colour per theme as sRGB, its glyph as an
  SF Symbol), all checked against `tests/fixtures/organize/`; `Item.swift`
  gains `Goal`, the containers' own fields and the Organize and Goals
  switches; `EditCopy.swift` gains `ContainerWords.goal`/`.goals`.
  O2 and O3 add `OrganizeCopy.swift` ← `lib/organize-copy.ts` (the pages'
  sentences) and `ProjectBlock.swift` ← `lib/project-block.ts`
  (`timeBlockSummary`), and fill in `ContainerSchedule.swift`
  (`deriveContainerSchedule`, `todayCount`, `dayRollup`, `todayInOrder`),
  `ActiveExplain.swift` (`suppressionReason`, `suppressionLabel`) and
  `Goals.swift` (the countdown, the elapsed line, the timeline, the
  supporting work and the wind-down); `Registry.swift` gains
  `typeLabelPlural`, and `Project` its `notes`.
  O4, O5 and O14 add `Organize.swift` ← `lib/organize.ts` (`organizeWeek`,
  `nextMilestoneAcross`), `PausedShelf.swift` ← `lib/paused-shelf.ts` (the
  shelf, its words and `pausedNote`) and `Trash.swift` ← the Trash's shapes
  in `lib/app-containers.ts` (the bin, the restore body and its refusal),
  with the cards' and the Trash's words in `OrganizeCopy.swift` and
  `trashWrites` in `PlannerPayload`.
  O8a adds `ContainerIntent.swift` ← `lib/app-containers.ts`
  (`containerIntentPatch`), `lib/active.ts` (`resolvePauseWrite`),
  `lib/app-http.ts` (`pauseZone`) and `lib/gate-toggle.ts` (Paused's way
  back), and `ContainerWriteBody.swift` ← `lib/app-containers.ts` (the
  request bodies), both checked against
  `tests/fixtures/organize/container-writes.json`; `seasonStateForSwitch` in
  `ActiveExplain.swift` ← `lib/scope-rail.ts`; the refusal words in
  `OrganizeCopy.swift`; and `containerWrites` in `PlannerPayload`.
  O8b and O9 extend them: `ContainerIntent.swift` takes every field intent,
  with `projectNameClash`, `refiledItems` and `refiling` (lib/app-containers.ts
  `renameProject`); `Goals.swift` gains `GoalState` and
  `resolveGoalStateWrite` ← `lib/goals.ts`; `ContainerWriteBody.swift`
  encodes the new bodies; `OrganizeCopy.swift` the name refusals
  (`nameTakenSentence`); `ContainerLook.swift` `iconToken`.
  O10 and O11 add `ContainerCreate.swift` ← `lib/app-containers.ts` (the
  create body, `containerCreateRecord`, `ContainerRoutes.create`), checked
  against the same fixture's `creates`; `ContainerIntent.swift` gains the
  `delete` intent (`removesContainer`, `.removed`), and `OrganizeCopy.swift`
  the delete titles, buttons and `deleteConsequence` and the create sheet's
  words (`createCopy`) ← `lib/organize-copy.ts`.
  O12 and O13 add `MembershipIntent` and `MembershipWriteBody`
  ← `lib/app-containers.ts` (a move's and a hold's bodies, checked against
  the same fixture's `moves` and `holds`), `memberMoveResult` and
  `routineHoldResult` (what a move or a hold would change, or why it changes
  nothing), `moveMemberAfter` and `wouldHideAttaching` in `Organize.swift`
  ← `lib/organize.ts`, `placingMember` in `Membership.swift` (the phone's
  own: a failed move's way back, after its anchor or at its old place), and
  in `OrganizeCopy.swift` the attach confirm
  (`attachConfirmTitle`, `attachConfirmDescription`, `attachConfirmLabel`)
  and `changedElsewhere`, the banner for a membership write another device
  got to first.
  Week's PR 1 adds `deriveUntimedRows` to `DayItems.swift` (←
  `components/views/day-schedule.tsx`) and `weekDays` to `Cadence.swift` (←
  `weekStartOf` and `addDaysStr` in `lib/container-schedule.ts`), checked
  against `tests/fixtures/day/week.json` (WeekFixtureTests) and the
  `untimed` rows of `timed.json`.
  Week and blocks' PR 7 adds `BlockMoves.swift` (← `lib/block-moves.ts`:
  `planBlockDrop`, `startTimeOf`), checked against
  `tests/fixtures/day/block-moves.json` (BlockMovesFixtureTests).
  Each cites what it mirrors.
- `ios/Dsul/App`: `DsulApp` (one `AuthStore`), `AppGate` (sign-in screen,
  sample or the user's planner, keyed on `AuthStore.gateKey`), `AppConfig`.
  `ios/Dsul/Auth`: `AuthStore`, `TokenStore` (Keychain, or memory in tests),
  `SignInView`, `AppleAuthorization` (AuthenticationServices' half of Apple,
  kept out of AuthStore), `DeleteAccountSheet` (Delete account, from the
  avatar menu). `ios/Dsul/Data`: `APIClient`, `PlannerSync`.
  `ios/Dsul/Item`: the item sheet (`ItemSheet`, `ItemDetail`, `VerbBar`,
  `ChipFlow`, `StreakChip`, `DayPickSheet`, and from part 2 `TitleField`,
  `NotesEditor`, `SubtaskField` and `StreakPopover`, and from 2c `Editors/`:
  `PropertyMenus` and `ReminderSheet`, which 2d joins with `TimeSheet` and
  `ClockWheel`, the wheel both sheets share, and 2e with `RepeatSheet`) and
  `ItemSheetModel`, which decides what it says and offers apart from the
  views.
  `ios/Dsul/Organize` (O1): `OrganizeView` (the tab: the stack, the list,
  the section headers and the quiet rows), `ContainerRow` (a row and its
  `ContainerTile`), `ContainerColor` (DsulCore's `ContainerAccent` as a
  SwiftUI `Color` that follows dark mode) and `OrganizeModel`, Foundation
  only, which decides what the list shows and says. O2 and O3 add the
  pages: `ContainerPage` (`OrganizeDestination`, the routes' views;
  `OrganizePageHost`, which pops a page whose container goes and puts the
  name in the bar once the header scrolls under it; and the shared header,
  goal ring, chips, section header and member row), `RoutinePage`,
  `SeasonPage`, `GoalPage` (with the milestones' timeline), `ProjectPage`,
  `DayStrip` ("Last 14 days"), and `ContainerPageModel`, Foundation only,
  which decides what each page shows and says. O4 adds `SummaryCards`;
  O5 and O14 the footer's pages, `PausedPage` (with `ShelfPillStyle`, the
  rows' Resume and Restore), `PausedEntryPage`, `ItemTypesPage` and
  `TrashPage`, and `ShelfPageModel`, Foundation only, which decides what
  they show and say; `ContainerRow` gains `TileRow`, the tile row anything
  else wears. O8a adds no file: `ContainerPage` gains `StatusChipMenu` and
  `PageChipLabel`, and the Status menus' rules live in `ContainerPageModel`
  (`StatusMenu`) and `OrganizeModel` (`canEdit`). O8b and O9 add
  `PageEditors` (`ChipSheet`, one sheet slot per chip row; `PageNotesView`;
  `ContainerNotesSheet`; `UsualTimeSheet`; `RangeSheet`), `RenameAlert`,
  `LookSheet`, and `ContainerEditModel`, Foundation only, which decides
  what a page may edit and in what words; `ContainerPage` gains the bar's ⋯
  menu (`PageMenu`), and `NotesText` a VoiceOver hint of the caller's. O10
  adds no file: `PageMenu` gains Delete…, the host its confirm, and
  `ContainerPage` `SettledAnnouncement` (a VoiceOver announcement once a
  push or pop has settled). O11 adds `CreateSheet` (the name sheet), and
  `OrganizeView` the bar's + (`CreateMenu`); what each offers and says is
  `ContainerEditModel`'s (`DeleteEdit`, `CreateEdit`). O12 and O13 add no
  file either: `ContainerPage` gains the bar's Edit button (the host's own
  `editMode`), `PageAddRow` (an add row anything may wear), `onRemove` on
  `MemberRowView` and `onTakeOut` on `ContainerLinkRow`; `RoutinePage` the
  Edit-mode Items list, `StepRowView` and the picker sheet; `SeasonPage`
  "Add a routine…", its list and the attach confirm; and
  `ContainerEditModel` what each offers and says (`StepsEdit`,
  `StepPicker`, `SeasonRoutinesEdit`, `AttachConfirm`, `stepDrag`).
  `ios/Dsul/Today` (Week's PR 2) gains `WeekList`, `WeekBuckets` and
  `WeekDayHeader`; `TodayLayout.swift`, Foundation only (the shim compiles
  it), holds `TodayScope` beside `TodayLayout` and the week's words in
  `PlannerFormat`, pinned by `TodayFormatTests`.
  `ios/Dsul/Schedule` (Week and blocks PRs 4 to 6) gains `ScheduleLayout`,
  Foundation only (the shim compiles it: `DaySchedule`, `ScheduleBlock`,
  `AnytimeBandRules`, `SamplePlanner.daySchedule(on:fieldWidth:)`), and the
  views `ScheduleColumn` (with the drag's own layer), `BlockView`,
  `NowMarker` and `AnytimeBand`; `ScheduleGrid` is the hour gutter and one
  column. `ScheduleLayoutTests` (shim) and `ScheduleRenderTests` (UIKit, the
  runner only) test them. PR 8 adds `ScheduleMoves`, Foundation only (the
  shim compiles it: the block's menu, its VoiceOver actions and words, the
  autoscroll step, and `SamplePlanner.moveBlock`), and the view
  `AnytimeRow`; `BlockMoveTests` (shim) tests them. PR 10 adds
  `WeekScheduleModel`, Foundation only (the shim compiles it:
  `WeekScheduleRules` and `SideAutoscroll`; `ScheduleLayout` gains
  `SamplePlanner.weekSchedule(of:columnWidth:)`), and the view
  `WeekSchedule`; `WeekScheduleTests` (shim) tests them.
  `ios/Dsul/App` gains
  `AvatarMenu` (moved out of `TodayView`, with the tab's own sections passed
  in) and `PlannerBannerOverlay` (`.plannerBanner()`, Today's banner, also on
  Organize, with `BannerView`).
  `SamplePlanner` keeps its name for the views, but holds `[Item]` and asks
  DsulCore what shows; `SampleData` builds the sample.

## Today (PR 2)
- **G over F, provisionally.** The capsule is a `ToolbarItem(.topBarTrailing)`
  beside the avatar: a plain view, not a `Menu` (a menu's tap and a swipe on
  it either never both fire or double-step). A tap steps to the next layout,
  a swipe in either axis steps with `.sensoryFeedback(.selection)` and wins
  outright over the tap (`exclusively(before:)`), long press opens the full
  menu as a context menu (Layout, and Show: Day and Week, see Week),
  and VoiceOver activates or adjusts it. `LayoutSwitcher` is self-contained so it can move
  into the capture bar if Kirby picks F. The layout is `@AppStorage`.
- **Buckets follow the stored bucket, not the hour.** An item shows in its
  `timeBucket` and nowhere if it has none, as `deriveDayItems` does; a drop on
  an hour files it under that hour's bucket. The phone draws Anytime last, as
  the boards do, where the web draws it first.
- **The title is the day.** "Today" on today, the date otherwise; a tap opens
  a graphical date picker, and a Today button jumps back.
- **Capture bar.** A button drawn as a field opens a small capture sheet that
  stays open for rapid entry; the tray count switches Today to Schedule and
  opens the braindump sheet, which only ever opens over Schedule. Capture and
  Go to date are one `PlannerSheet` on the planner (`activeSheet`): RootView
  presents it, or, while the braindump sheet is up, the braindump sheet does,
  stacked, since nothing under a sheet can present. A swipe-down on capture
  keeps what was typed. `today` moves at midnight and on returning to the
  app, carrying the selection only if it was on today. Hidden on
  Ask; a compact rendering for the `.inline` placement. The drag probe moved
  from Today's toolbar into the avatar menu.

## Week
Week PRs 1 and 2 of the shared folder's `ios-app/week-and-blocks/design.md`
(which has every decision, W1 to W17, and the PR plan); the builders' notes
are in `week/w1/` and `week/pr10/`. PR 1 is the data, PR 2 List and
Buckets in Week, PR 10 Week × Schedule (below).

- **One scope, device-local.** `TodayScope` (`day`, `week`) is
  `@AppStorage("today.scope")`, beside the layout's key: add, never rename.
  It is never the web's `default_view`, which would change what the desktop
  opens on (mobile web never writes it either, W9). One rule decides what
  shows, `TodayLayout.effectiveScope(_:)`: the stored scope where the layout
  has a week form (`hasWeek`: all three since PR 10), else Day. The title,
  the content switch and the capsule's VoiceOver value all read it, so a
  stored Week on a layout with no week form would draw Day and say Day (W17;
  Schedule was that layout until PR 10). The capsule's tap and swipe still
  step layouts only (W6); its menu's Show section lists `layout.scopes`
  (Day alone on a layout with no week form) with the effective scope
  checked, and a pick stores it. To VoiceOver the capsule's value is "List, week",
  with a named action, Show week or Show day, only for the one that changes
  something.
- **The anchor is `selectedDay`.** The week is `weekDays(of: selectedDay,
  settings.weekStartDay)` (`selectedWeek`), so Go to date picks a day and the
  week follows. A day's heading selects that day and stores Day, on the same
  layout (W7). In Week the Today button shows only off today's week
  (`isOnTodaysWeek`). The Today button is tinted ink, in Day as well: a
  bordered button takes the tint, the lime accent, for its words.
- **The title (W4).** `PlannerFormat.weekTitle`: This week, Next week, Last
  week, else "Week of Oct 26", with the year when the week starts in another
  year. The subtitle is `weekRange` · the layout: `Date.IntervalFormatStyle`
  with the abbreviated month and the day, and the years when either end is
  off today's year, so the dash and its spacing are iOS's (thin spaces in
  current ICU; the tests read them as plain). VoiceOver hears "This week,
  October 19 to 25, List". Every week date is formatted at noon UTC in a UTC
  formatter: a `DayString` is a calendar day, and no zone may move it.
- **Day-keyed twins (PR 1, design §4.6).** `week(of:)` splits the items once
  (`project`) and runs `derive(on:)`'s pipeline (`inactiveItemIdsOn` with
  trips, then `deriveDayItems`) at each of the seven dates. `dayItems(on:)`,
  `listSections(_:on:)`, `buckets(on:)`, `scheduled(on:)`, `anytime(on:)`
  (DsulCore `deriveUntimedRows`; nothing draws it yet), `isDone(_:on:)`,
  `isSkipped(_:on:)`, `toggleRow(_:on:)` (the row's ungated tick; the sheet
  keeps its gated `toggle(_:on:)`), `count(_:on:)` and `dayProjects(on:)` take
  a day; the selected-day forms wrap them. `SheetDay.on(DayString)` makes a
  week row's sheet act on the row's day (`actingDay`), so its "For …"
  caption, its tick and its Skip are that day's (W13). A render derives the
  week once, `weekRows(of:)` (seven `WeekDayRows`), and the chips and the
  sections are asked of those rows (`count(_:in:)`, `chipProjects(in:)`,
  `listSections(_:rows:on:)`, `buckets(_:)`). Since PR 10 `week(of:)` keeps
  the last week it worked out (Week × Schedule, below), so asking again
  with nothing changed derives nothing.
- **Week × List (W2).** `WeekList`: the filter chips, counting every
  occurrence over the week (a daily habit counts seven, W16), as a
  `safeAreaBar` over the list, so opening on the selected day never scrolls
  them away; then seven day sections in one plain `List`. Each opens with `WeekDayHeader` (the weekday
  and its "Oct 1" side by side, the date under the weekday at the
  accessibility sizes; a 6pt lime dot by today's weekday, with both words in
  ink, W12; a button that opens the day, and a header to VoiceOver that says
  "today"), then that day's own Day sections (routines with done/total, then
  projects with their dot, then No project) as small captions that don't
  fold (`WeekGroupLabel`), rows in Day's order. "Nothing planned." on an
  empty day, Day's "Nothing matches this filter" when the chip hides all of
  it. The list opens on the selected day's heading and goes back to it when
  the selected day moves.
- **Week × Buckets (W3).** `WeekBuckets`: the same seven headings, each over
  one card of the day's filled parts of the day in the phone's order
  (Anytime last), or "Nothing planned."
- **Now (W14).** On today's rows only. `ItemRow`'s "Now ·" is now ink with a
  6pt lime dot before it, in Day as well: it was lime text.
- **The sample (design §8).** Four one-off tasks with no project, appended
  after every other id (55 to 58): Pick up the dry cleaning three days back
  (16:30), Bike service two days back (14:00), Coffee with Priya the day
  after (10:00) and Post the birthday card two days after (Anytime). None is
  on the anchor or the day before it.
- **Where the build departs from the design.**
  - The day headings are list rows, not `Section` headers, because
    `ScrollViewReader` lands on a row's `.id` reliably and not on a header's.
    So they don't stick while their day scrolls.
  - Week × Buckets has no current-part mark on today (§4.4 asks for one):
    Day's Buckets draws none on the phone, so there is nothing to copy; it
    would be a new mark for both.
  - On a device the sample's anchor is the real today, so its four tasks sit
    in today's week only on some weekdays: from a Sunday start a Wednesday or
    Thursday, from Monday a Thursday or Friday. The hosted tests anchor on a
    Thursday, which the design's "all four sit in its week" assumes.
  - The capsule's VoiceOver value names the scope in Day too ("List, day"),
    so the value always says what shows.
  - `weekRange` and `spokenWeekRange` take today, for the year rule.
- **Where Week departs from the web (design §10).**
  - W2: the web's week list groups and orders each day by the user's
    group-by and sort settings, finished rows sinking
    (components/views/week-list.tsx); the phone always groups each day as
    its Day list does (routines, then projects, then No project), since
    grouping options and sinking are Not yet for Day too.
  - W7: on the web a day's heading selects that day in place and stays in
    Week; on the phone it opens the day in Day, since a selected day in
    place would only move a mark.

### Week × Schedule (PR 10)
Design §4.5 and §4.6 and Kirby's Q1 (three days); the builder's notes are in
`week/pr10/notes-app.md`. The PR stays a draft until the README's device
checks pass ("Checking Week × Schedule", W-S1 to W-S3 among them).

- **Geometry.** `WeekSchedule` (WeekSchedule.swift): one vertical
  `ScrollView`, as Day's grid, holding `HourGutter` (Day's, now internal)
  and a horizontal `ScrollView` of seven `WeekColumn`s, each
  `.containerRelativeFrame(.horizontal, count: across, spacing: 0)`: three
  across, two from the first accessibility text size (`WeekScheduleRules`,
  WeekScheduleModel.swift, Foundation only). The columns snap with
  `.viewAligned(limitBehavior: .alwaysByOne)` on a `.scrollTargetLayout()`,
  so a swipe moves one day, and their position is a `ScrollPosition` by
  `DayString`. They open on the selected day as far toward the leading
  edge as the week allows (`openingDay`, W15), and go back to it when the
  selected day moves or the columns across change; the hours open with
  8:00 just under the heads. The whole view caps its text at the second
  accessibility size, the gutter at the first, as Day does.
- **Heads.** Each column's heading ("Thu 1", `PlannerFormat.columnHeading`,
  composed because the locale's skeleton reads "1 Thu"; a 6pt lime dot on
  today, the words in ink) and its Anytime strip are pinned to the top of
  the vertical scroll by a `visualEffect` offset with a z-index, as is the
  opaque cell of the gutter beside them. All seven take one height
  (`WeekHead`, from `WeekScheduleRules.stripLines`): the tallest strip's
  rows, at most three (one at the accessibility sizes, as Day's band), a
  "+N more" line when any day has one, and at least one row, which on an
  empty strip says Anytime, so there is always a strip to drop on.
  `ScheduleDrag.hoursTop` is that height: the hours start that far down the
  scroll's content, and the ghost and every drop read `y - hoursTop`
  (`ScheduleDrag.dropStart`). Day's grid sets it to 0.
- **Blocks.** Each column is Day's `ScheduleColumn` with
  `opensOn: .on(day)` (a block's sheet acts on its column's day) and
  `compact: true`: `BlockView`'s compact words are the title on one line and
  the mono start under it from 45 minutes up (`WeekScheduleRules.startLine`),
  the range in its place while a grip is held. The week is laid out by
  `SamplePlanner.weekSchedule(of:columnWidth:)` from one `week(of:)`, with
  the overlap pass's week variant (a 10pt shingle, ties tiled) at the
  column's width; a tie tiles at half a column, never widening it (§1).
  Ticking, the menu, VoiceOver's actions and Change length are Day's, on
  the column's day.
- **The week, kept (§4.6).** `week(of:)` keeps its answer with what it was
  worked out from (`WeekInputs`: the week's first day, the items, projects,
  routines, seasons, away periods, Show completed and the zone), and hands
  it back while those are equal. ScheduleView's body never reads the drag,
  so a ghost step re-renders each column's drag layer and the haptic and
  derives nothing (WeekScheduleTests `aGhostStepDoesNotDeriveTheWeekAgain`,
  a DEBUG counter: +7, then +0 for repeat asks and ghost steps, +7 after a
  tick; ScheduleRenderTests `aWeekGhostStepDerivesNothing`, hosted).
- **Drops.** Each column's hours and each strip is its own drop
  destination. The hours send every session update to
  `ScheduleDrag.columnUpdate(day:phase:y:x:)` (Day's grid too): `.entering`
  and `.active` put the ghost on that column, or keep it on `confinedTo`
  for a habit or a series (B18); `.exiting` and `.ended` clear it only from
  the column the finger was last over (`overDay`), so two columns' updates
  can come in either order. A drop goes through `SamplePlanner.dropOnHour`
  on the column's day: a one-off moves day and time, a habit or a series
  lands the time on its own day, a braindump row is scheduled there
  (`schedule(_:on:startMin:)`). A strip's drop is `dropOnAnytime`, and its
  proposal `refusesAnytimeDrop`, which refuses another day's block (B22);
  Day's band asks the same two now.
- **Autoscroll.** ScheduleView's tick drives the top edge by hand under the
  pinned heads (`ScheduleAutoscroll.drivesTopEdge(hoursTop:)`), its zone
  starting `hoursTop` down the viewport (`visibleTop`), for a drag and for
  a grip; Day keeps `handDrivesTopEdge`. Week's is behind
  `ScheduleAutoscroll.handDrivesWeekTopEdge` (on), which device check W-S3
  turns off if the hours scroll twice as fast just under the heads.
  Sideways, a drag resting within 32pt of a side of the columns steps them
  one day each 0.6 seconds (`SideAutoscroll`, `ScheduleDrag.sideStep`), and
  the ghost moves to the column then under the finger; a habit or a series
  held to its own column (B18) never steps them. It is behind
  `ScheduleAutoscroll.handDrivesSideEdges` (on), which device check W-S3
  turns off if the system scrolls the columns as well.
- **The rest.** The selection haptic is ScheduleView's `GhostStepHaptic`,
  once for the Schedule (the columns' drag layers lost theirs), at a new
  quarter hour or a new column while a ghost shows. The Day/Week switch
  clears the selected block and ends a stray drag. A heading or "+N more"
  opens its day in Day (W7). To VoiceOver each column is a group named for
  its day (`spokenHeading`); a strip row is the band row's one element.
- **Where it departs from the design.**
  - `.exiting` clears the ghost when the column is the one the finger was
    last over (`overDay`), not when it is `ghostDay` (§4.5): a confined
    drag's `ghostDay` stays its own column, whose late `.exiting` would
    then wipe the ghost another column had just updated.
  - The 8:00 scroll is `8 × hourPx`, not `hoursTop + 8 × hourPx`: the heads
    cover the viewport's top `hoursTop`, so this puts 8:00 just under them.
  - The week is kept by its inputs, compared by value, rather than on an
    items revision the planner bumps (§4.6): no write, fetch, container or
    zone change can be missed. An unchanged array compares in constant time.
  - The haptic is on ScheduleView, for Day and Week, not on WeekSchedule,
    and it no longer plays as the ghost goes away.
  - `columnUpdate` also takes `x`, for the sideways autoscroll, and a
    `ColumnDropPhase` mapped from `DropSession.Phase`, so a test drives it.
  - The sideways autoscroll is a dwell that steps a whole column, not
    `EdgeAutoscroller`'s smooth step, so the columns stay on a day's edge.
  - A strip shows one row at the accessibility sizes (§4.5 says three).
  - A strip row's tick is the row's height (28pt, scaled) and 28pt wide,
    under 44pt, so three rows fit a third of the screen; VoiceOver has the
    tick as an action.
  - The head's height lives in WeekSchedule.swift (`WeekHead`), not
    ScheduleColumn.swift, which only gains `opensOn` and `compact`;
    LayoutSwitcher needed no code (its Show section lists `layout.scopes`).
  - Hosted tests are a new `WeekScheduleTests` (shim), not
    SamplePlannerTests; TodayFormatTests and ScheduleRenderTests gain theirs.
  - The side zones are the columns' own edges, right of the hour labels and
    left of the trailing margin, not the screen's: the gutter and the margin
    are no drop destination (§4.5 has each column's hours read no x), so a
    finger there clears the ghost and steps nothing. If W-S3 finds the zones
    hard to hit, the gutter and the margin become destinations that forward
    to the leading and trailing columns.
  - The integrator's pass (`week/pr10/integration-app.md`): only the copy on
    the lifted day draws hollow (`ScheduleDrag.lifts(_:on:)`, `BlockView`'s
    `day`), so a repeating block's other days stay solid (B8); a confined
    drag never steps the columns; the week's top edge has its own switch;
    the opening scroll, and the title's Today button under Reduce Motion,
    never slide (§5.10); the kept week takes the key it was last asked with,
    so a later compare stays the cheap one; the columns lay out at the kept
    width until they are measured.
- **Where it departs from the web.** Three columns swiped a day at a time,
  not the week's columns side by side (Q1); no widening of a crowded column
  (§1); another day's Anytime refuses a block (B22, two writes that could
  land half); a heading opens its day in Day (W7). The day-count stops, the
  pinch and the hover recede are desktop's (§1).
- **Files.** ios/Dsul/Schedule: WeekSchedule.swift and WeekScheduleModel.swift
  (new), ScheduleView.swift, ScheduleGrid.swift, ScheduleColumn.swift,
  BlockView.swift, ScheduleDrag.swift, ScheduleMoves.swift,
  ScheduleLayout.swift, AnytimeBand.swift; ios/Dsul/Model/SamplePlanner.swift
  (the kept week, `schedule(_:on:startMin:)`); ios/Dsul/Today: TodayLayout.swift
  (`hasWeek`, `columnHeading`), TodayView.swift, LayoutSwitcher.swift
  (comments); ios/DsulTests: WeekScheduleTests.swift (new),
  TodayFormatTests.swift, ScheduleRenderTests.swift; ios/README.md (Checking
  Week × Schedule, and Checking Week's checks 6 and 7).

## Schedule blocks
Week and blocks PRs 4 to 6 of the shared folder's
`ios-app/week-and-blocks/design.md` (§5.1 to §5.3, §5.9, §5.10), built as one
PR; the builders' notes are in `week/pr4/`. PR 4 draws the blocks in the web's
look, PR 5 adds the Anytime band, PR 6 the web's overlap pass and the 34pt pane
floor. PR 8 moves a block (Moving a block, below), and PR 9 changes its length
(Changing a length, below).

- **One derive per change, and the drag reads none of it.** ScheduleView
  lays the day out once in its body (`daySchedule(on:fieldWidth:)`: the timed
  entries as `scheduled(on:)` draws them, the overlap plan over them, each
  block's done, skipped and tick label, and the band's untimed rows, all from
  one `derive`) and hands it down as a value. Only `ScheduleDragLayer` (the
  ghost), `AutoscrollSwitch` (the edge autoscroll's start and stop) and,
  since PR 10, `GhostStepHaptic` (the 15-minute haptic, moved out of the drag
  layer) read `ScheduleDrag`, so a ghost step re-renders those three and
  derives nothing. A `#if DEBUG` count on `derive`
  (`SamplePlanner.derivations`, ignored by Observation) lets
  `ScheduleRenderTests` prove it.
- **The block, after day-schedule.tsx.** A 2pt rail over the true time in the
  project's colour (`projectAccent`, O15's port, no second one), lime with no
  project; a 6pt bead at the start ringed in what it sits on; a pane of radius
  5 with a hairline and a soft shadow (`secondarySystemGroupedBackground`).
  Task-like blocks start with a square check (16pt, 44pt wide, no taller than
  the content band, B25, centred on the title's measured line); habits have
  none. One line of title with the mono length on the right
  (`formatDuration`); a tall content band (56 and up) adds the mono range
  (`formatClockRange`); either way the words centre in the content band, as
  the web's `justify-center`. A pane under 200pt (`PANE_WRAP_PX`, field width
  times the plan's share, DsulCore's `ScheduleMetrics.paneWrapPx`) drops the
  length and range. Done strikes the title, thins the plate to
  `tertiarySystemFill` and turns the rail and bead muted ink; nothing fades,
  so the lime check keeps its strength, its tick in the web's `--lime-ink`.
  A bead on a stepped plate (z above 2: nested or cascaded, the web's
  `beadOnPocket`) is ringed in the plate's colour, else the canvas's. Skipped
  is a 24pt strip with the skip mark and the bead, no check, opening the sheet.
  The check is the row tick on the column's day (`tickBlock(_:in:)`, which
  takes the laid-out day, so a column can't tick the selected day by
  mistake), ungated like the List's circle; VoiceOver's action carries the
  ported label ("Mark done", "Done today").
- **Geometry.** The column is measured (`onGeometryChange`) and the width
  stored in ScheduleView, so the overlap pass runs on the real field (Day's
  `minChannelPx` cap needs it); until the first measure no block draws. Each
  block is its own bounds, offset into the column, so VoiceOver's frame is the
  block; rails and beads let taps through to a host's pane.
- **Gutter and now.** `formatHourLabel` in mono caption, top-aligned 3pt
  under each line, in a gutter that scales with the text up to
  accessibility1. On today the time (`formatClock`) in ink, centred on now,
  and the hour mark it would cover hidden (`eclipsedHour`, its distance scaled
  with the text). In the field a lime diamond on the lane and a 24pt stub.
- **The Anytime band.** Pinned above the hours' ScrollView. Its header is
  always there ("Anytime" or "Anytime · 4"), folds the rows
  (`@AppStorage("schedule.anytimeOpen")`, open by default, add, never rename),
  and shows alone while the braindump sheet is up without writing the
  choice. Up to three rows (one at the accessibility sizes, so the
  hours keep their room), then a capped ScrollView. Rows tick and open on the
  band's day (`tickAnytimeRow(_:in:)`). Since PR 8 the rows are `AnytimeRow`
  (ItemRow's look, opened by a tap gesture so a hold can lift it) and the
  band takes drops (Moving a block, below).
- **Where it departs from the design or the web.**
  - The design lists `ScheduleColumn` holding the drop destination; the
    destination stays on ScheduleGrid's 24-hour content (gutter and column),
    as the spike built it, so drop locations stay in content space.
  - The block's tests live in a new `ScheduleLayoutTests`, not
    `SamplePlannerTests` (which another PR edits at the same time).
  - Hour lines run from the lane's edge to 4pt short of the field's right;
    the web insets them 17. A skipped strip spans the pane's width, not the
    band's from the lane.
  - Block and ghost text stops growing at accessibility2, where a footnote
    line no longer fits a 34pt pane; the text is clipped to its content band
    past that.
  - The check's 44pt target starts at the pane's left edge, so its last 14pt
    sit over the title's first letters: a tap there ticks.
  - A narrow pane keeps its title to one line, centred like a wide one's,
    where the web wraps it from the pane's top and grows it on hover: the
    design keeps block text to one line (§5.10), and a phone has no hover.
  - The web's hover, glass and pocket details of the overlap pass are not
    drawn (§5.3's ported subset only).

## Moving a block
Week and blocks PR 8 of `ios-app/week-and-blocks/design.md` (§5.2, §5.4,
§5.5, §5.8, §5.9, B2, B7, B8, B9, B12, B14, B15, B16, B18, B20, B22, B23),
Day and Week (Week since PR 10); the builders' notes are in `week/pr8/`. A block's hold opens its
menu, a hold and a move drags it, and every drop asks the rule the web asks
(`planBlockDrop`, Dropping a block, below) and writes what it answers
through the routes the phone already had. No new intent, route or migration.

- **One rule, one mapping.** `SamplePlanner.moveBlock(_:from:to:)`
  (ScheduleMoves.swift) asks `planBlockDrop` with the block's `BlockOrigin`
  (its day and whether that occurrence is skipped) and
  `BlockDropContext(milestoneIds: milestoneIds)`, maps the answer through
  DsulCore's `phoneBlockDrop` (`BlockDropWrite.swift`: `place` to
  `schedule`, `retime` to `time`, `anytime` with a null date to
  `time {anytime, null}`, `braindump` to `unschedule`), and steps the
  optimistic row and queues the write on paths the phone already had (the
  braindump drop's `placing` with `schedule`, the sheet's `edit`, Move to
  Braindump's `unschedule`), so a failed write reverts as every write does
  (B10). `none` writes nothing; a refusal, and
  the phone's own two (`pause`, B15; another day's Anytime, B22), write
  nothing and propose the system's forbidden badge where the target can
  propose one. `BlockMoveTests` drives every row of
  `tests/fixtures/day/block-drop-writes.json` (153: 79 land, 74 send
  nothing) through it against `FakeServer` and checks the body, the step
  and the answer.
- **In time only (B7, B18).** A habit, and a dated series on the canvas,
  sends `time` and never its date, so every day moves and earlier weeks
  keep theirs; a series in a project block sends `schedule` with its own
  start date. `confinedDay` keeps such a drag's ghost on its own column
  (`ScheduleDrag.confinedTo`; only Week × Schedule has another, PR 10).
- **The drag.** `ScheduleColumn` is the blocks' `dragContainer` of
  `ItemRef`; a block that can go nowhere (`canLift`: no other quarter hour
  of its day, nor its day's Anytime, nor the braindump takes it; a skipped
  strip among them) has no `draggable`, so its hold is the menu alone
  (`LiftsWhen`). The session's `.initial` calls
  `ScheduleDrag.beginMove` with `source` (`.block(day:)`,
  `.anytime(day:)`), `anchor` (`grabAnchor`: where on the block the finger
  holds it, so it lands where it was held, not centred), `confinedTo` and
  the item's own length; it takes the `DragHold` lease (B20), released by
  the drop or half a second after `.ended`. `source` and the lifted item
  (`liftedID`) outlive `reset()`, since a drop can run after the source's
  `.ended`. The lifted block draws hollow in its column
  (`HollowWhileLifted`, a dashed outline, no fill; B8). Picking from a
  block's menu ends a lift whose session never ended (`endStrayLift`: the
  menu and the drag share one long press, M1). The ghost is unchanged:
  15-minute snap (B14), a selection haptic each step.
- **Targets.** Every drop handler routes through `dropSource`: what the
  drag says of this item (`ScheduleDrag.source(of:)`, nil when the last
  lift was another item's) when it lifted off a day, and otherwise the
  item itself, a braindump member being a braindump row and anything else
  a block of the surface's day. So a missed `.initial` never puts a placed
  series down through the braindump's `schedule`, which would re-anchor
  it. The grid's destination (ScheduleGrid, as the spike built it) sends a
  block or an Anytime row through `moveBlock` and a braindump row through
  the old `schedule`. The Anytime band is a destination for both
  (`moveBlock(... to: .anytime)`, or `placeAnytime`, the date chip's
  `move` gated on `canReschedule`), proposes `.forbidden` when the rule or
  the phone refuses, and its header swaps its words for "Drop here to keep
  it time-free" while a drag is in the air (both texts stacked, faded by
  opacity, so the header never changes height; VoiceOver hears the hint
  after the header's own label, `BlockMoveWords.anytimeHeader`). That hint
  is a hand copy of inline JSX in components/views/day-schedule.tsx: no
  fixture holds the two together, so a web rewording won't fail a test; a
  later copy pass can move it into a lib copy module and copy.json. The
  braindump sheet is a destination on its `NavigationStack`, switched off
  only while one of its own rows is in the air (read off the live drag,
  so an idle sheet stays on and a block's drag never has to switch it on
  mid-session), proposing `.cancel` for a braindump row (so a row let go
  inside still restores its size) and `.forbidden` for a refused block;
  its `onDisappear` resets `sheetTopGlobal` to `.infinity`.
- **The menu (B2, B3).** `blockMenu(for:in:)` asks the sheet's verb gates
  on the block's day: the tick (or Unskip), Skip, Pause (or Resume); Move
  to tomorrow with its day as the subtitle, Reschedule (Today, Tomorrow,
  Next week: `RescheduleRow.quickRows`) and Move to Braindump; then Change
  length (PR 9, Changing a length below) and Move to Anytime
  (`canMoveToAnytime`, through the same rule). Each runs on the block's day;
  only Change length selects, and it writes nothing.
- **VoiceOver (B12).** Named actions only (`spokenActions`): the menu's
  verbs but Reschedule, then "15 minutes later" and "15 minutes earlier"
  (`nudge`: one `moveBlock` to the hour 15 minutes off, never past
  midnight), PR 9's length pair, and Move to Anytime; never the adjustable
  trait. After a move it announces where the block landed
  (`BlockMoveWords.announcement`: "Moved to 10:15 AM", "Moved to Friday at
  10:15 AM", "..., every day it repeats", "Moved to Anytime", "Moved to the
  braindump"); whether it repeats reads a NULL frequency as the type's
  default, as the server does, so a habit stored without one is daily.
- **Anytime rows (B23).** Each `AnytimeRow` lifts when an hour or the
  braindump would take it (`canLiftRow`, which probes 9:00 and the
  braindump), from the band's own `dragContainer`.
- **Autoscroll (B9).** `ScheduleAutoscroll.step` drives the bottom edge (the
  one the sheet covers) by hand, as the spike did; the top edge is the
  system's, with a hand-driven one behind `handDrivesTopEdge` (false) for
  device check M3.
- **Sample.** Walk (a daily habit at 7:45 AM, 20 minutes) and Team sync (a
  weekly task with no project on today's weekday at 4:45 PM, from two weeks
  back), made last so no id moves. Not the design's 7:30 and 10:00: with
  the 34pt pane floor Walk at 7:30 would touch Morning pages and Team sync
  at 10:00 nest in Draft Q4 roadmap.
- **Where it departs from the design.**
  - `moveBlock(_:from:to:)` takes a `BlockTarget` (an hour carries its own
    `startMin`), not the design's `moveBlock(_:from:to:startMin:)`.
  - The grid's destination proposes no operation of its own: a block that
    no hour takes never lifts, and an hour that refuses one that did lift
    (a skipped strip never does) leaves it where it was.
  - The hosted tests live in a new `BlockMoveTests`, not
    `PlannerSyncTests`; they read the fixture from the repo by `#filePath`.
  - The menu's reschedule rows are `RescheduleRow` (`RescheduleChoice` is
    taken by the item sheet).
  - The top-edge autoscroll stays the system's until M3 says otherwise.
  - Design §5.5's "Why these intents" says `time` with both keys takes
    `planTimeEdit`'s `scheduleTask` branch when the bucket differs or the
    item is not scheduled. Not when the bucket and time sent already equal
    the row's: lib/item-edit.ts `timeEditPatch` answers `{}` before
    `planTimeEdit` runs, so five drops (block-drop-writes-fixtures.test.ts
    `UNMOVED`: a series holding a stashed date on its own time, a one-off
    under Anytime not marked scheduled, three rows under Anytime holding a
    stash, each on its own day's Anytime) answer 200 and write nothing.
    They keep the stash, or the row's `isScheduled: false`, which the web's
    `scheduleTask` for the same drop clears. Nothing on screen differs, but
    the stored rows do, and the phone sends nothing for them at all
    (`editing` changes nothing).
  - The rule retimes a habit that has a parent, and the route refuses that
    time with 400 `not_for_subtask` (the fixture's four `habit subtask`
    rows); the phone's `editAllowed` sends nothing for them. No door makes a
    habit with a parent, so it is the rule's edge.
  - A retried `schedule` writes its columns and records an event again
    (the route never asks whether the row is already so; §6.2 keeps the
    intent as it is), where a retried `time` or `unschedule` writes
    nothing. The row converges either way; the fixture's test pins both.
  - The design's PR 8 Files list names no DsulCore or TS file. The phone's
    mapping is DsulCore's `phoneBlockDrop` (BlockDropWrite.swift, beside
    `planBlockDrop`, so a cloud run tests it), pinned by a new server
    fixture, block-drop-writes.json, written through the real route; and
    row-moves.json gains two braindump rows for the band's gate.
- **Files.** ios/Dsul/Schedule: ScheduleMoves.swift and AnytimeRow.swift
  (new), ScheduleColumn.swift, BlockView.swift, ScheduleDrag.swift,
  ScheduleGrid.swift, ScheduleView.swift, AnytimeBand.swift,
  BraindumpSheet.swift; ios/Dsul/Model: SampleData.swift, SamplePlanner.swift;
  ios/DsulTests: BlockMoveTests.swift (new), SamplePlannerTests.swift,
  ScheduleRenderTests.swift; DsulCore BlockDropWrite.swift and
  BlockDropWritesFixtureTests (new); tests/fixtures/day/block-drop-writes.json
  and its writer tests/unit/block-drop-writes-fixtures.test.ts (new);
  tests/fixtures/day/row-moves.json (a braindump row and a done one, read by
  RowMovesFixtureTests) and its writer tests/unit/day-fixtures.test.ts;
  tests/unit/ios-change-filter.test.ts; ios/README.md (Moving a block, and
  the sample paragraph).

## Changing a length
Week and blocks PR 9 of `ios-app/week-and-blocks/design.md` (§5.6, §5.8,
§5.9, B3, B4, B14, B16, B25), Day and Week (Week since PR 10); the builders'
notes are in `week/pr9/`. Change length in a block's menu shows two grips; dragging one
moves the start or the end in 15-minute steps, and letting go writes the
existing `time` edit. No new intent, route, migration or write kind. The PR
stays a draft until the README's device checks pass ("Changing a block's
length", R1 among them).

- **One maths, both clients.** The web's inline resize maths is
  lib/schedule-resize.ts (`resizePreview`, `resizeWrite`,
  `resizeDeltaMin`), which day-schedule.tsx imports back, with DsulCore's
  line-for-line twin in ScheduleMath.swift, checked against
  tests/fixtures/day/resize.json (`ResizeFixtureTests`), and the registry's
  `schedule.resizable` in caps.json. Bottom: `max(15, snap15(duration +
  travel))`, the start kept. Top: the end kept, the start
  `max(0, min(snap15(start + travel), end - 15))`. The one deliberate web
  change is that the day holds both edges: the bottom stops at 24:00, the
  top's end is held to 24:00, a start never goes before 0:00, and an edge
  with nothing in the day to hold to stays put.
- **The write.** `SamplePlanner.resize(_:edge:from:to:)`
  (ScheduleResize.swift) asks `resizeWrite` and sends its `edit` through
  `edit(_:_:)`, the Time chip's path: gated by `canEdit`, stepped by
  `editing`, queued with its snapshot, put back if it fails. The bottom grip
  sends `{"action":"time","duration":n}`; the top one the start, the length
  and the new start's part of day, since a time sent beside a stored Anytime
  is refused (edit-writes.json `time-top-grip-anytime-stored`). Nothing when
  nothing changed. It asks the gate again off the item as it is, ends the
  press's `DragHold` at once, as a drop does, and says the new range to
  VoiceOver ("12:30 to 1:15 PM").
- **The gate (B4, B16).** `canResize`: the type's `resizable`, a start time
  that is not empty (the web's `!!startTime`), not in a project block (whose
  block takes the project's extent), and a server that takes a time edit;
  never a skipped occurrence's strip. A done block keeps it.
- **Selecting (B3).** `BlockResize` (ScheduleResize.swift, owned by
  `ScheduleDrag` as `drag.resize`) holds the selected block, keyed on the day
  of the column that draws it (`BlockSelection`), and the grip in the hand.
  Change length is the only thing that selects. A tap on the hours that no
  block or grip takes clears it (`TapClearsSelection` on ScheduleGrid's
  content, its tap off while nothing is selected); so do any sheet, another
  day and the Schedule going away (ScheduleView's `SelectionClearing` and
  `onDisappear`), the block leaving the day or losing the gate
  (`ResizeGripLayer`), and every lift (`ScheduleDrag`'s `lift`), so a drop
  never leaves grips. Scrolling keeps it; tapping the selected block opens
  its sheet, which clears it.
- **The grips.** Two ink capsules ringed in the canvas, the top one at the
  pane's leading end and the bottom one at its trailing end, each a 44pt
  target centred on the edge and flush with the pane's side
  (`ResizeGrips.placement`), drawn by `ResizeGripLayer` over every block
  (z 25, under the ghost). When a nested child shares an edge, that grip
  goes to the block's lane, as the web's `handleTopLane` and
  `handleBottomLane`. The selected pane's hairline becomes a 1.5pt ink
  outline. Hidden from VoiceOver.
- **The gesture.** `DragGesture(minimumDistance: 0)` as a
  `.highPriorityGesture` on each target, measured in the hours' viewport
  (`ResizeGrips.viewportSpace`, named on ScheduleGrid's ScrollView). Its
  first change is the press: the light impact, the `DragHold` lease, the
  block shown as pressed. The travel is the finger's movement plus the
  grid's scroll since the press (the web's `applyResize`), in minutes at
  75pt an hour, and `resizePreview` is asked only once that travel has
  reached `ResizeGrips.slop` (4pt), so a grip pressed and let go unmoved
  writes nothing even on a block off the quarter (9:10 for 50, where the
  maths alone snaps) and even when the resting finger drifts a point or
  two; once moved it is always asked, as on the web. A `.selection` tick at
  each 15-minute step. The release writes; a gesture reset with no end, or a
  grip gone mid-press, lets go with nothing written. Each press has a number
  (`BlockResize.press` returns it), and a grip's touch follows, releases and
  cancels only its own, so a second finger on the other grip is refused a
  press while one is held, never drives or ends it, and presses from where
  it is once the first is let go (`press(..., translationY:)` takes off the
  travel it made while it waited).
- **What reads what.** A grip's step changes `BlockResize.shown`, which
  only the selected block's reader (`ResizableBlock`, which draws it at the
  grip's span through `ScheduleBlock.resized(to:)` and the plan's
  `bandOnly`) and the grips (`GripPair`) read; the autoscroll switch reads
  only whether a moved grip is held (`drivesAutoscroll`, once at the first
  move and once at the release), every other block only which block is
  selected, and ScheduleView none of it, so a step derives nothing
  (`ScheduleRenderTests.aGripStepDerivesNothing`). While a grip is held, a
  pane with no range line, a narrow one included, says its range where its
  length was.
- **Autoscroll.** While a grip is held and has moved, ScheduleView's `tick`
  drives both edges with the grip's height in the viewport (no system drag
  is running to scroll either) and hands each scroll back to
  `BlockResize.scrolled`, which keeps the edge under a still finger. Not at
  the press: a finger pressed still within the edge zone (56pt) of the top,
  the bottom or the braindump's top would scroll the grid, the scroll would
  move the edge, and letting go would write it.
- **VoiceOver.** "Make 15 minutes longer" and "Make 15 minutes shorter",
  after "15 minutes earlier": the bottom grip a quarter hour through
  `resize`, offered only when that writes (shorter stops at 15 minutes,
  longer at midnight). A length off the quarter lands on one, as a
  quarter-hour drag of the web's handle does (the rule in
  `week/pr9/handoff-app.md`), so it moves by more or less than 15: 50
  minutes made longer is 60 and made shorter is 30, 40 made longer is 60;
  the announcement says the new range. Change length itself is the menu's
  alone.
- **Where it departs from the design or the handoff.**
  - The gesture measures in the scroll view's own frame, not the column's
    space (§5.6): the column scrolls, so its translation would count an
    autoscroll twice.
  - `resize` takes `from` as well as `to` (§9 names `resize(_:edge:to:)`),
    and it lives in ScheduleResize.swift, an extension the shim compiles,
    not in SamplePlanner.swift, which PR 9 leaves alone. Its hosted tests
    are a new `BlockResizeTests`, not `SamplePlannerTests`.
  - The `UIPanGestureRecognizer` fallback (§5.6) is not built: it waits on
    device check R1 (README "Changing a block's length", check 3). If R1
    fails, it is a `UIGestureRecognizerRepresentable` pan on each grip's
    target that the scroll view's pan, the block's menu and its lift wait
    on, driving the same four `BlockResize` calls (`press`, `follow`,
    `release`, `cancel`) with the press number; nothing else changes.
  - A press counts as moved only once its travel reaches `ResizeGrips.slop`
    (4pt), where the handoff says any non-zero travel: a resting finger
    drifts by fractions of a point, which on a block off the quarter would
    snap and write. The web, with a mouse, has no slop.
  - The grip's autoscroll starts at the press's first move, not at the
    press, where the web starts its loop at pointerdown: a 44pt target
    near an edge would otherwise scroll, and so move and write, under a
    still finger.
  - A second finger on the other grip is refused a press while one is held,
    and takes one, from where it is, once that one is let go.
  - A lift clears the selection, beyond §5.6's list, which is what makes
    "a drop never selects" hold when a block is dragged while another is
    selected.
  - The gate also asks for the server's `time` write, so a server without
    it offers no Change length.
  - The grips keep the at-rest plan's lanes for the whole press, where the
    web's `bandOnly` drops them mid-resize, so a grip never jumps from under
    the finger; the block itself draws with `bandOnly`, as the web's.
  - A pane with no range line shows its range in the length's place while a
    grip is held; §5.6 says the mono range updates live, and a short pane
    has none. A narrow pane (under `paneWrapPx`, 200pt: any block sharing
    its time side by side on Day, and every block in PR 10's Week columns)
    shows it too, on the title's line with the title cut short, where the
    web's narrow pane shows no time at all.
  - The announcement is always the range, where a block's label says its
    start alone under an hour, since the length is what changed.
  - The grips are ink, not lime: §11 lists where lime appears, and a grip is
    a control.
  - On a selected short task the top grip's target covers the check, so a
    tap there is a press that writes nothing; a tap elsewhere first clears
    the selection (README check 5 puts it before the device pass). On a pane
    narrower than 88pt the two targets overlap.
  - A layout change clears the selection with the Schedule's
    `onDisappear`; since PR 10 the Day/Week switch clears it too
    (ScheduleView's `onChange(of: scope)`), and in Week × Schedule a block
    is selected on its own column's day, the grips measure in the hours'
    viewport named on the week's vertical scroll, and the grip's top edge
    starts below the pinned heads (`visibleTop: hoursTop`).
  - A sheet clears the selection as it opens, not while it is up: a block
    selected above the braindump at its medium size (background touches
    pass through up to medium) keeps its grips, and the grip's autoscroll
    then scrolls at the edge just above the sheet.
- **Files.** ios/Dsul/Schedule: ScheduleResize.swift (new),
  ScheduleMoves.swift (the menu entry, the length pair, `announceMove`
  internal), ScheduleDrag.swift, ScheduleColumn.swift, BlockView.swift,
  ScheduleGrid.swift, ScheduleView.swift; ios/Dsul/Today/ItemRow.swift
  (`PlannerFormat.spokenRange`, the one way a range is said, which a row's
  label and a length's announcement share); ios/DsulTests:
  BlockResizeTests.swift (new), BlockMoveTests.swift,
  ScheduleRenderTests.swift; ios/README.md
  (Changing a block's length, and Moving a block's checks 1 and 10). The data
  half: lib/schedule-resize.ts (new) and components/views/day-schedule.tsx;
  DsulCore ScheduleMath.swift, Registry.swift, ResizeFixtureTests.swift (new)
  and RegistryCapsFixtureTests.swift; tests/fixtures/day/resize.json (new),
  caps.json and edit-writes.json, with their writers day-fixtures.test.ts and
  edit-writes-fixtures.test.ts; tests/unit/schedule-resize.test.ts (new),
  schedule-resize-pointer.test.tsx and ios-change-filter.test.ts;
  .github/workflows/ios.yml.

## Item detail, part 1
- **One sheet, every surface.** `PlannerSheet.item(UUID, day: SheetDay)` in
  the planner's one slot, raised by `SamplePlanner.open`: over Today from a
  List or Buckets row, a block on the Schedule grid and a Search result, and
  stacked on the braindump sheet from a braindump row. Its own
  `NavigationStack` (a subtask's title pushes the subtask's page), detents
  medium and large (large from the start at accessibility text sizes), Close
  and ⋯ in the toolbar, the verbs in a glass capsule in `.safeAreaBar`, and
  the planner's banner over the content under Close, so a refused write says
  so over the sheet it came from. Today's copy of the banner steps aside
  while an item's sheet is up, so at the medium detent it shows once, and
  `show` has VoiceOver say it (an error at high priority), since it is drawn
  where focus isn't. The sheet stays open after a verb, as the web's panel
  does, and closes when a fetch no longer has its item (`apply` and
  `restore` clear the slot). The slot knows only the first page, so a pushed
  subtask's page whose item a fetch drops takes itself off the stack.
- **Which day.** `SheetDay` is kept by name and read when a verb is tapped
  (`actingDay`): `.selected` from Today's surfaces, so a sheet acts on the day
  its row was drawn on; `.today` from Search, which has no day (`open` first
  brings `today` up to the clock). The tick, Skip and Unskip act on it; Pause
  and Resume read wall-clock today in the planner's zone. Off today the bar
  drops " today" from its words, and a caption over it names the day ("For
  Thu, Oct 8") when it holds a verb that acts on that day (the tick, Skip,
  Unskip); a bar of Pause, Pause until or Resume alone gets none. When the
  title's circle ticks that day and the bar doesn't hold the tick (a habit,
  or a bar given way to Resume), a line under the title names the day too
  (over a habit's Skip or Unskip, the caption and the line both show). On a day a recurring item doesn't fall on (`occurrenceOn` is
  `absent`) a "Not due" line takes the bar's place. Today lists only what
  falls on its day, so in practice that is a Search result on one of the
  item's days off, and the line reads "Not due today"; off today it would
  name the day ("Not due Sat, Oct 3").
- **The bar** follows the approved item-conversations table (Round 3), up to
  three slots:

  | Item | Bar | ⋯ |
  |---|---|---|
  | Paused today | Resume | Delete |
  | Recurring item on a day it doesn't fall on | – ("Not due today" in its place) | Pause, Pause until…, and for a series, Reschedule; Delete |
  | Habit | Skip / Unskip today, Pause, Pause until (its tick is the title's circle) | Delete |
  | One-off task-like | Done, Tomorrow (Next day when it lands later), Reschedule (undated: Schedule, and no Tomorrow) | Pause, Pause until…; Delete |
  | Recurring task-like | Done today, Skip / Unskip today, Pause | Pause until…, Reschedule; Delete |
  | Subtask | Done | Delete |

  The first two rows come first, whatever the item. ⋯ holds whatever of
  Pause, Pause until and a series' Reschedule the bar doesn't, then, after a
  divider, Delete (part 2), last, as the web's verbs declare it. Delete is
  offered on every item, so ⋯ always shows: a habit's is [Delete], a paused
  item's is [Delete] (Kirby, 2026-10-03), and on a day an item doesn't fall
  on it is Pause, Pause until…, divider, Delete. That last row is still the
  only way to pause a habit there, since the web's `pause` is dateless, never
  asking whether the day is absent. Against a server whose `writes` lacks
  `delete`, ⋯ is part 1's, empty and hidden for a habit.

  Only what `SamplePlanner.offers` allows shows: the web's gate
  (`verbEligible`), the server's own where it asks more (no skip or carry for
  a subtask; `isPausable`), and the server's `writes`. A verb and its opposite
  share a slot, so VoiceOver's focus stays put. A series takes Reschedule but
  not Tomorrow (lib/row-moves.ts `canReschedule`, #375): the picked day
  becomes its start, so it waits behind ⋯. Reschedule is a menu (Today,
  Next week by Week starts on, Pick a date…); Pick a date and Pause until open
  `DayPickSheet`, nested in the sheet and never the planner's slot, which
  writes only on its confirm button ("Move to Thu, Oct 8"). Its title is the
  bar's own word, so an undated item's picker is Schedule ("Schedule for Thu,
  Oct 8"). Pause until's starts tomorrow and says under the calendar that
  the item comes back on the day picked; left open across midnight, its
  earliest day moves up and the pick with it, and a confirm on a day no
  longer after today writes nothing and says so in the banner. The mapping
  lives in `ItemSheetModel`, pinned by ItemSheetTests, and every verb
  re-reads its item and asks its gate again before it writes.
- **The chips** are read-only in part 1 and follow the web panel's order, each
  only when set, each asked of the registry (`caps`), never the type's name:
  the streak chip first for a type that keeps one (flame, count, this week's
  seven days by Week starts on); priority | date ("Today", else "Thu, Oct 8"),
  time ("9:00–11:00 am" in the user's 12h or 24h, else the bucket, never
  Anytime), times a day (above 1), repeat (`cadenceLabel`), reminder ("After
  I pour my coffee · 8:00 am") | project (with its colour dot), routines,
  seasons. The planner payload gained `weekStartDay` and `timeFormat` for
  them. Only the item's own pause shows ("Paused until Oct 8"). Beside the
  title, a counted habit's tally on the day ("1/3", the web panel's count),
  so a tap on the circle that counts one without finishing the day still
  shows; VoiceOver hears it in the circle's label ("Count one (1/3)").
- **Opening, and VoiceOver.** A row is two buttons: the circle, hit over 44pt
  around its 22pt drawing so a near miss still ticks, and the rest, which
  opens, hit over the row's full 44pt though a line of title is about 22pt.
  The skipped strip, a braindump row, a subtask's title in the sheet and Show
  all are hit over 44pt too, without changing their layout. To VoiceOver a
  row is one element ("Draft Q4 roadmap, 9 to 11 AM", "Done" as its value,
  the hint "Opens details") whose activation opens, with Mark done as a named
  action. The skipped strip opens too (the only way to Unskip). A grid block
  is a button over the drop target; a braindump row opens on a tap gesture,
  so its long press stays the system drag, and keeps its "Schedule at 9:00"
  action. Each chip is its own element with a spoken label; the streak chip
  is one ("Streak 41; this week: 3 done").
- **Lime.** The sheet sets no tint of its own, because the done tick and
  Now's dot are `Color.accentColor`; its text controls tint themselves in the
  label colour, and anything lime presses by scaling (`PressScaleStyle`),
  never `.plain`'s fade. The banner dropped `.plain` for the same reason, and
  slides in without an opacity transition, which would fade its lime check.
- **The writes.** `POST /api/app/items/:id` takes `skip` (a date and
  `skipped`), `move` (a date, which the phone picks: `nextDayOf`, Today, Next
  week or the picked day) and `pause` (`paused`, an optional exclusive
  `pausedUntil`, and the device's zone for an account with none stored), each
  doing what the web's store action does (`setItemSkipped`, `moveTaskToDate`,
  `setItemPaused` through lib/item-pause.ts) behind the server's copy of its
  gate. The payload's `writes` lists the intents the server takes; absent (an
  older server) means `complete` and `schedule`, and the phone hides any verb
  whose write isn't listed, so an app that ships before the deploy never
  offers a write it would be refused. Part 1 shipped PlannerSync's revert as
  one slot per write (a day, the status, placement, the pause, a capture);
  part 2 replaced it with a rebase per subject (Data, below).
- **Unproven on a device:** the checks in ios/README.md, "Checking the item
  sheet" (a near miss still ticks, a block doesn't swallow a drop, a
  braindump tap versus long press, each verb, another day and "Not due", a
  refused write and VoiceOver hearing its banner, a counted habit's tally,
  VoiceOver, the largest text size, the lime).

## Item detail, part 2
Seven PRs, each shipping its routes with the app: 2a the title, the notes and
Delete (below); 2b Add a subtask and Reset streak (in the streak chip's
popover), and the Streaks switch honoured (below); 2c the chips as controls
and "+ Add property" (priority, times a day, the reminder); 2d date and time;
2e repeat; 2f in two, the project (2f-a), then routines and seasons (2f-b).
An older server's `writes` hides any editor it doesn't take, so the deploy
order doesn't matter: against one without `addSubtask` there is no Add a
subtask row, without `resetStreak` the streak popover has no Reset, and
without `priority`, `timesPerDay`, `reminder`, `time`, `repeat`, `project`
and `collect` those chips stay read-only; the date chip still edits, through
`move`, which every server that sends `writes` takes, so Add property then
holds Date alone, for an undated task.

Decided (Kirby, 2026-10-03): part 1's look stays through part 2, and dsul's
own flavour (square swatches, priority dots, a serif title) comes later as a
view-only pass, since what the sheet says lives in `ItemSheetModel` and
DsulCore and how it looks in small views. A subtask's page edits its title,
notes and priority, and has Delete. A paused item's ⋯ holds Delete. Delete's
words are fixed on every surface, below.

- **Title.** `TitleField` takes the title's place when `canWrite("title")`,
  on every type and on a subtask's page: a vertical `TextField` with the
  type's placeholder, `.submitLabel(.done)`, labelled "Title" and still a
  heading. `ItemSheetModel.titleEntry` reads only the inserted text: an
  insertion whose only line break is its last character is a typed Return
  (an autocorrection may come with it), so the break is dropped and the
  title commits and ends the edit; any other inserted line break (such as
  the one in a two-line paste) becomes a space; and growth past the limit
  is cut. A blank or unchanged title sends nothing, and the field shows
  the stored title again. The counted habit's tally moves to the line under
  the title, before the day note ("1/3 · For Wed, Sep 30").
- **Notes.** `NotesEditor`: part 1's notes text (four lines and Show all),
  or "Notes" in `.secondary` when there are none, both a button to VoiceOver
  with the hint "Edits the notes". A tap swaps in a vertical `TextField`,
  focused from its own `.onAppear` with the caret at the end (SwiftUI can't
  map a tap on a `Text` to an offset). Return is a newline; the nav bar's
  Done commits. Gated on `caps.hasNotes` (the type's schema has notes) and
  `canWrite("notes")`.
- **Seed, draft, commit.** A typed field holds the stored value (read from
  the planner when needed), the seed (what it showed when editing began,
  never cut) and the draft (what it shows now, in the page's `@State`, never
  bound to `planner.items`, which a fetch replaces wholesale). A commit sends
  nothing when the draft is the seed, so focusing a title the web stored
  with a newline or over 500 characters and leaving it never writes;
  otherwise it cleans the draft (`cleanTitle`: newlines to spaces, then trim,
  clamp and trim again; `cleanNotes`: the same without the newlines, and
  empty is none) and sends it only if that differs from what is stored.
  Trimming first keeps leading whitespace from using up the limit, and
  trimming again keeps a cut from leaving a space the server would strip. It commits on Return, the nav bar's Done,
  focus leaving the field, `.onDisappear` (a swipe down, Close, a pushed
  page popping) and the scene going `.inactive` or `.background`. There is
  no idle timer. While a field has focus the sheet goes to `.large`, the
  verb bar hides, Done takes ⋯'s place, and the scroll dismisses the
  keyboard interactively.
- **Caps limit growth only.** A title may grow to 500 UTF-16 units and notes
  to 50,000, and text already longer may stay as long but never grow:
  nothing else in dsul caps these fields, so stored text can be any length,
  and a cap that refused it would make it uneditable or cut it on a save
  that never touched it. The phone clamps typing, and what it sends, at
  `growthLimit` of the stored text (the cap, or the stored length if
  longer), never of the seed, because the server measures the same rule
  against what is stored (`withinGrowthLimit`, 400 `invalid`). A request may
  carry at most 10,000 / 200,000 (the schema); stored text over that makes
  the field read-only, with "Too long to edit on the phone." under it.
  Trimming is JavaScript's (`jsTrim`), not Foundation's, which keeps U+FEFF
  and strips U+0085.
- **Delete.** ⋯ ends with "Delete task" (the type's label, lowercased; a
  custom type's own), destructive, after a divider; a subtask row has it in a
  context menu and as a VoiceOver action (no swipe actions in a
  `ScrollView`); a subtask's page has it in its own ⋯. It always confirms
  (`confirmationDialog`, the phone having no undo): the title is
  `deleteConfirmTitle` ("Delete task?", lib/item-verbs.ts), the message the
  registry's `deleteDescription`, followed by "Its subtask goes with it." or
  "Its N subtasks go with it." when it has live ones, and the buttons Delete
  and Cancel. The step (`deleting`) takes the item and, unless it is a
  habit, its subtasks, as deleteTask does. The sheet keeps drawing its last
  content while it slides away (`lastShown`), a pushed subtask page pops
  itself back to its parent, and VoiceOver hears "Task deleted" (the type's
  label), a beat late so the sheet closing doesn't cut it off. The confirm's
  words are fixed when Delete is asked, since by the time it is answered the
  item may be gone.
- **Delete's words** (Kirby, 2026-10-03). A deleted item goes to the Trash
  for 30 days, restorable on the web, so the registry's
  `form.deleteDescription` says so, on every surface and in a way that still
  holds on a phone, which has no Trash: tasks and custom types `Moves
  "{title}" to Trash for 30 days, then deletes it for good.`, habits `Moves
  "{title}" and its history to Trash for 30 days, then deletes them for
  good.` The web's bulk prompts (the bulk bar, Backspace on a selection) say
  `Moves the selected items (and any subtasks) to Trash for 30 days, then
  deletes them for good.`, and the mobile web's sheet uses the type's own
  words: every one of them soft-deletes through `deleteItem`. caps.json
  carries the words to DsulCore.
- **The server** (lib/app-api.ts, lib/item-edit.ts). `title` (trimmed,
  1-10,000), `notes` (up to 200,000, or null to clear) and `delete` (no
  fields), each `.strict()`. The row read adds only the column the edit
  decides on (`EDIT_COLUMNS`); `editRefusal` answers a type without notes
  (`no_notes`) and growth past a cap (`invalid`), and `editPatch` is the
  dialog's mapper for the one key, `{}` (200, no write, no event) when the row
  already says it. Delete reads the live, task-like subtasks first, then
  calls `deleteItem` on the parent and on each subtask in load order, one
  'delete' event each, as deleteTask does. With no live row it reads again
  without the `deleted_at` filter: an item already in the Trash is 200, and
  its subtasks still live are deleted on the way (`deleteItem`'s own cascade
  only logs a failure, so a retry is what repairs it); no row at all is 404
  `not_found`.
  2b's `addSubtask` (`id`, lowercased, and `title`, trimmed, 1-500: new text,
  so the plain cap) is refused on a habit (400 `no_subtasks`) and under a
  subtask (409 `nested`), creates the task through `createItem` with
  `{notify:false}` and capture's `nextTaskOrder`, and answers 201 `{ok, id}`.
  A retry whose id is taken answers 200 only for this user's live task under
  this parent, else 409 `conflict`. The parent is then read again: one that
  went to the Trash between the reads (on another device) takes the new child
  with it, and the answer is 409 `parent_gone`. `resetStreak` (no fields)
  reads `streak` on top of the shared row (never `completed_dates`), refuses
  a type without a streak counter (400
  `no_streak`), and writes `{streak: 0}`, never the completion history; at 0
  or null it is 200 with no write and no event.
  2c's chips go through the same field handler: `priority` (`low`, `medium`,
  `high`, or null for none), `timesPerDay` (an integer, 1-5,
  `TIMES_PER_DAY_MAX`) and `reminder` (`time`, HH:mm or null to turn it off,
  always sent; `anchor`, the cue words, up to 10,000 or null, sent only when
  they changed and only with a time, else the schema's 400 `invalid`), each
  `.strict()`. Each reads its own columns (`priority`; `times_per_day`;
  `reminder_time, reminder_anchor`). A habit's priority is 400 `no_priority`,
  a count on a type without daily counts (a task, a custom item) 400
  `no_count`, and a reminder on a type that can't take one or on a subtask
  400 `not_remindable`; cue words growing past 500 (after the trim) are 400
  `invalid`. The reminder writes both columns or neither (`reminderPatch`),
  and a time sent alone keeps the stored words. Each is `{}` (200, no write)
  when the row already says it, and a habit with no count stored takes 1 as
  already so, since the dialog seeds it as 1.
  2d's `time` (`timeBucket`, one of the four or null for none; `startTime`,
  HH:mm or null for no specific time; `duration`, an integer 1-1,440,
  `MAX_DURATION_MINUTES`; each optional and sent only when it changed,
  `.strict()`) goes through the same handler. The schema refuses a body with
  none of the three and a time sent beside Anytime or null (400 `invalid`).
  It reads `start_time, is_scheduled, duration` on top of the shared row
  (which already has `start_date`, `time_bucket` and `in_project_block`), and
  is refused under a subtask (400 `not_for_subtask`), on a date-anchored item
  with no date (409 `not_dated`), with a length on a type without one (400
  `no_duration`, which no shipped type reaches) and when the edit would leave
  a time beside Anytime or no part of day, judging the row as it will be once
  written, the sent value or else the stored one for each (400 `invalid`), so
  Anytime or none sent while a time is stored and kept is refused too.
  `timeEditPatch`
  is the dialog's `commitEdit` over the sent keys: the draft seeded as
  `draftFromItem` seeds it (the length at `defaultBlockMinutes` when none is
  stored), a key changed only when it differs from that seed, then the
  mapper's pass with `updateTask` / `updateHabit`'s auto-correct and
  `planTimeEdit`'s pass through the store's own patches
  (`scheduleTaskPatch`, `scheduleHabitPatch`, now in lib/item-edit.ts: the
  store's actions import both, the `schedule` intent imports
  `scheduleTaskPatch`, and the dialog imports `planTimeEdit`). `{}` (200, no
  write) only when nothing moved from the seed; an edit whose end row is the
  stored one still writes, as the web does.
  2e's `repeat` (`frequency`, one of the six; `days`, 0-6, with Custom days
  only; `monthDay`, 1-31, with Monthly only; `.strict()`) goes through the
  same handler. The schema refuses days or a day beside the wrong frequency,
  either missing where its frequency needs it, and days not strictly
  ascending (400 `invalid`: refused, never sorted), and a legacy `weekly`. It
  reads `repeat_days, repeat_month_day` on top of the shared row (which
  already has `repeat_frequency`), and is refused under a subtask (400
  `not_for_subtask`) and with a frequency the type doesn't list (400
  `frequency_not_allowed`, a habit's No repeat). `repeatEditPatch` is the
  dialog's save over the sent keys: the draft seeded as `draftFromItem` seeds
  it, all three keys written through the dialog's own `repeatPatch` (now in
  lib/item-edit.ts, which the dialog's mappers and add path import) whenever
  any moved, `{}` when none did. Then, on the `{}` path too, any goal role the
  new rule left untrue is demoted (lib/goal-roles.ts, moved out of
  lib/agent-api.ts, whose PATCH runs it as before), on the user's client; a
  failure there is logged, and the answer is still `{ok: true}`.
  2f's `project` (`projectId`, a uuid lowercased, or null for No project;
  `.strict()`, so a name in the body is 400 `invalid`) goes through the same
  handler. It reads `project, project_id, previous_start_time,
  previous_start_date` on top of the shared row (which already has
  `in_project_block`), and is refused under a subtask (400
  `not_for_subtask`), on a type with no project axis (400 `no_project`) and,
  for null, on a type whose container is required (400 `project_required`);
  no shipped type meets the last two. Then it reads the project under RLS
  (`id`, the user's, not in the Trash) and answers 409 `project_gone` for no
  row, and for a foreign-key failure on the write (a project purged in
  between). The write is `projectRefilePatch`, the bulk Move to project's
  rule, which the store's `setItemsProject` imports back: the project's own
  name and id, a parked task's release, `{}` when already there by folded
  name and id. A habit's NULL project reads as `''`, so its clear always
  writes (`group` cleared with it by `habitUpdatesToRow`); `group` itself is
  never read.
  2f-b's `collect` (`kind`, `routine` or `season`; `containerId`, a uuid
  lowercased; `member`, a boolean; `.strict()`, so a list in the body is 400
  `invalid`) reads nothing on top of the shared row, which has the type and
  the parent `isCollectible` asks. It is refused under a subtask (400
  `not_collectible`), then reads the routine or season under RLS (`id`, the
  user's, not in the Trash) and answers 409 `container_gone` for no row, and
  for a foreign-key failure on the write (one purged in between). The write
  is one join-table row (lib/db.ts `addContainerMember` /
  `removeContainerMember`), never the container's list: an add is an insert
  at the routine's last place plus one (0 for the first; no place where a
  member has none, so it sorts among those by id), and a member already is
  the key's 23505, answered 200 with its place kept; a remove deletes that
  row, and nothing to remove is 200 too. No item row, no event, no webhook,
  as the browser's membership writes have none.
- **Add a subtask** (2b). The Subtasks section shows whenever the item has
  subtasks or can take one (`canAddSubtask`: a type with subtasks that isn't
  itself a subtask, and `canWrite("addSubtask")`), headed "Subtasks", still a
  heading to VoiceOver on a task with none, with "N of M" only once it has
  some, as on the web. Its last row, "Add a subtask" in `.secondary`, its
  plus in the subtask circles' column so the words line up with the titles
  above and stay put when the field swaps in, is a full-width button that
  swaps in `SubtaskField`: a
  vertical `TextField` labelled "New subtask", with the web's placeholder
  ("Add subtask…"), `.submitLabel(.next)` and the label colour's caret,
  focused from its own `.onAppear`. A Return adds one subtask and keeps the
  keyboard, and the page scrolls the field back into view as each new row
  lands above it. iOS may report a Return as a line break in the text, as
  `.onSubmit`, or as both in either order, so `ItemSheetModel.subtaskEntry` /
  `subtaskSubmit` is a small pure state machine (`SubtaskReturn`) that adds on
  whichever report comes first and lets the other go: one Return, one
  subtask. A Return on an empty field ends entry. A paste of two or more
  lines (`isBulkPaste`) adds one subtask per non-empty line, list markers
  stripped, each clamped to 500 UTF-16 units, up to 500 lines (past that, the
  banner says so in the web's words), and leaves what was already typed in
  the field, where the web clears it. A line pasted with a trailing line
  break is added at once, as a typed Return would be. Leaving the field (a
  tap on another field, Done, a swipe down, Close, dragging the keyboard
  away) adds what was typed, as Reminders does; switching apps never does,
  and leaves the text in the field. VoiceOver moves to the field as entry
  starts, and back to the row as it ends, unless focus went to the title or
  the notes, where VoiceOver stays; it hears "Added Eggs" or "Added 3
  subtasks". The step
  (`subtaskItem`) is the store's `addTask`: a `task` even under a custom
  item, pending, unscheduled, `order` the task count, nothing inherited.
  Each subtask is its own `addSubtask` write to the parent's route, so a
  pasted list's subtasks share one `order` and list by `created_at`
  (load_planner's tiebreak), where the web's `addTasksBulk` writes base+i in
  one INSERT: the same list either way. A paste sent offline fails once per
  line, and `show` says "Couldn't reach dsul. Checking what was saved…" aloud
  once, not once per line: it speaks only a banner that isn't already up with
  the same words.
- **Reset streak** (2b). The streak chip is now a button (a trailing chevron
  after the week's dots, the count in the label colour, in a hit frame at
  least 44pt square; VoiceOver hears the same label, the button trait and the
  hint "Shows this week", plus ", and Reset streak" when it is offered). It
  opens `StreakPopover`: this week's seven days drawn larger, "N days in a
  row" or "No streak yet" (`streakRunText`, the web's flame tooltip), and, when
  offered, Reset streak in red after a divider. At accessibility sizes it is a
  half-height sheet with a grabber (`presentationCompactAdaptation`),
  scrolling when its words need more. The
  confirm is the popover's own `confirmationDialog`, since the page showing
  the popover can't also show a dialog: "Reset streak?", the web's message
  (`EDIT_COPY.resetStreakMessage`), Reset streak and Cancel, in sentence case
  on the phone while the web's dialog keeps "Reset Streak?". It is offered
  (`offers(.resetStreak)`) by the verb's gate (a habit, a streak above 0,
  Streaks on), the server's `streakCounter` and `canWrite("resetStreak")`, and
  never enters the bar or ⋯. The step (`resettingStreak`) sets the streak to
  0 and touches nothing else, so the week's done days stay done. Every chip
  now sits in a slot (`chipSlot()`: 6pt above and below, at least 44pt tall)
  and the flow's line spacing is 0, so the lines stay 12pt apart at every
  text size whichever chip is tallest. The flow takes `.padding(.vertical,
  -6)`, so the capsules keep part 1's distance from the notes above and the
  subtasks below. One overlap is left: under notes long enough for Show all,
  Show all's 12pt overhang (NotesEditor) and the slot's 6pt share 4pt of the
  stack's 14pt gap, and the chip, drawn later and nearer, takes those taps.
  2c kept it, now that most items have an editable chip or Add property on
  that line: the shared band is nearer the chip's capsule, and the fix would
  move every chip row 4pt or cut Show all under 44pt.
- **Streaks** (2b). The payload's `settings.streaksEnabled` is the Streaks
  extension (`resolveEnabled` over the user's `user_extensions` rows, on by
  default), read in its own try/catch, so a failed read answers on rather
  than failing the load; a missing key (an older server) or a non-boolean
  reads on. Off hides the sheet's streak chip, and the flame, the count and
  the spoken "streak N" on Today's List and Buckets rows, as the web hides
  them (task-row.tsx) and as the extension promises ("hides them
  everywhere"). The phone honours the switch but can't turn it on or off.
- **The chips as controls** (2c). The priority, times per day and reminder
  chips edit when the server lists the action in `writes` and DsulCore's
  `editAllowed` takes it for the type (`ItemSheetModel.chipEditor`, asking
  the planner's `canEdit`); a menu writes at once, the reminder opens a
  sheet. From 2d the date and time chips edit too (below, with the hints
  "Changes the date" and "Changes the time"), and from 2e the repeat chip
  (below, with the hint "Changes how it repeats"), and from 2f the project
  chip ("Changes the project"), and from 2f-b the routine and season chips
  ("Changes the routines", "Changes the seasons"). An editable chip keeps
  part 1's look and gains a trailing chevron; its words, symbol and chevron
  draw in the label colour (`ChipView(editable: true)`), never lime, and it
  scales when pressed (`PressScaleStyle`) rather than fading. It is hit over
  at least 44pt square inside its own line (`chipHit()`, the streak chip's
  frame, factored out beside `chipSlot()`). VoiceOver hears part 1's label,
  the button trait and a hint ("Changes the priority", "Changes how many
  times a day", "Changes the reminder"). A read-only chip has no chevron,
  trait or hint.
- **Add property** (2c). The chip row ends in a seed listing the properties
  that are unset and editable, in chip order (`unsetProperties`): Priority ▸
  Low, Medium, High; Times per day ▸ 2× to 5× a day; Remind…. It reads "Add
  property" when the row has nothing else and is a bare plus otherwise, and
  VoiceOver always hears "Add property". A menu property is a submenu set in
  one pick, listing only changes (no None, no 1× a day); Remind… opens its
  sheet with the wheel already up on a time (Kirby, 2026-09-24: adding a
  property opens its picker straight away). Unset properties are never
  dimmed placeholder chips (Q2 a). Emptying a property from its chip (None,
  1× a day, No reminder) removes the chip at once and puts the property back
  in the seed, where the web keeps the emptied chip in view until its panel
  closes. After a pick, or the Remind sheet closing, VoiceOver goes to that
  property's chip, or to Add property when the chip went
  (`voiceOverTarget`), set 600ms later, once the menu or sheet has gone.
- **Priority and times per day** (2c). Menus that write at once, the current
  value checked: None, Low, Medium and High (the web's `PRIORITY_LABELS`) on a
  task, a custom item and a subtask's page (Q7 a), never a habit; and "1× a
  day" to "5× a day" on a habit, the web chip's list, a stored value above 5
  getting its own row (checked; picking it changes nothing). A habit with no
  count reads as 1, so 1× a day there sends nothing.
- **Remind** (2c). The reminder chip and Remind… open `ReminderSheet`, nested
  in the item sheet (`SheetEditor.reminder`; `SheetEditor` is 2b's `DayPick`,
  widened and moved into ItemSheetModel.swift so the Linux shim compiles it):
  a `Form` titled "Remind", with Cancel and Done. "Nudge me at" is a wheel,
  always up, in GMT on a Gregorian calendar, so "08:00" is 8:00 whatever the
  phone's zone and the stored value never shifts, with the hour cycle from
  `timeFormat`. It opens on the stored time or, for a new reminder, the
  item's start time, else 9:00, which Done saves untouched. The seeds and
  drafts are taken once as the sheet opens, so a fetch while it is up
  changes neither, and a sheet whose item went keeps drawing it. "Right
  after" is a one-line field with the web's placeholder and hint
  (`EDIT_COPY`); Return lowers the keyboard and leaves the sheet up. Stored
  words longer than one request may carry (`outerAnchor`, 10,000) show as
  text with "Too long to edit on the phone." and are never sent. The words
  are sent only when typed (the seed rule, P3), and a time-only change keeps
  the stored ones. When only the words changed, the time is sent as
  stored when Done is tapped, not as the sheet opened, so words changed on
  the phone never put back a time changed on the web that a fetch brought
  in while the sheet was up. Without such a fetch the phone sends the time
  it last fetched, since the route requires a time. A dated type
  with no date gets `reminderNeedsDate`'s note under the time. No reminder,
  there only when the item had one as the sheet opened, turns it off at once
  with no confirm. A swipe is refused once anything changed, and Cancel then
  asks "Discard changes?"; a clean sheet, a new reminder's included, closes
  and sends nothing. Two settings lines say when a reminder can't fire
  (Q9 a): Habit reminders off on the web (`settings.remindersEnabled ==
  false`) and no stored time zone (the scan skips one). Both need a live
  planner, so the sample shows neither. `settings.remindersEnabled` is
  `habit_reminders_enabled === true`, read beside `app_icon` among the
  columns a database behind on its migrations may lack, and null when that
  read was retried without them; missing (an older server) or null reads
  unknown and shows no line.
- **Date** (2d). The date chip is a menu: Today, Tomorrow, Next week, each
  with its day under it ("Oct 2", `formatDay`), then Pick a date…, the day
  picker titled "Date", whose confirm takes the Reschedule's verb ("Move to
  Thu, Oct 8", or "Schedule for" on an undated task). A pick writes at once
  through `move`. Gated as the Reschedule verb (`offers(.reschedule)`, Q3 a),
  so a paused task's chip edits though its bar shows Resume alone; elsewhere
  read-only, with no chevron. An undated task gets Date ▸ in Add property.
  Next week is `nextWeekStart` (Q4 a), the first day of next week by Week
  starts on, which is the same day as Tomorrow on the week's last day. No "No
  date". Today and Tomorrow are wall-clock days in the user's zone, where the
  web counts in the browser's.
- **Time** (2d). The time chip and Time… open the Time sheet (a `Form`
  titled "Time"; Cancel and Done; a swipe refused, and Cancel confirming,
  once what it shows moved). Part of day's check shows where the item will
  file (`autoCorrectBucket`'s preview), and a tap that would leave the check
  where it is changes nothing, so what is checked is what is sent: under a
  time only Anytime moves it, and a line says the time sets the part of day.
  A part of day is sent only when a tap moved the check; the wheel crossing
  into another part of day sends the time alone, which the server files there
  and which keeps a project block. Specific time only under Morning,
  Afternoon and Evening, "Add a time" first (a part of day with no time is a
  real state, and the wheel has no empty one), starting at
  `BUCKET_START_TIMES` (5:00 am, 12:00 pm, 5:00 pm, the project time block's
  defaults); Anytime drops the time. Duration's presets plus the stored
  length as its own row, seeded with `defaultBlockMinutes` when none is
  stored, and no clear. Done sends one `time` write with the keys that moved,
  re-read against the item at Done so a change made on the web while the
  sheet was up never makes the body one the server refuses. On a task, a part
  of day sent always writes, as the web's commitEdit does (scheduleTask sets
  `isScheduled` and `inProjectBlock: false`, and most rows hold NULL there),
  releasing a project block. No "No specific bucket" for a habit, which the
  server still takes. An Anytime item's length shows no chip (part 1's rule),
  so a length set from Time… on one shows on the grid and the web only.
- **Repeat** (2e). The repeat chip is a menu of the type's frequencies in the
  web's order and words (`REPEAT_FREQUENCY_LABELS`), the current one checked;
  No repeat (never a habit's), Daily, Weekdays and Weekends write at once, and
  Monthly… and Custom days… open the Repeat sheet, which writes on Done. A
  one-off task's Add property holds Repeat ▸ with the same rows but No repeat.
  Custom days' keys run in Week starts on order and are worded as the web's
  (`WEEKDAY_LABELS`); the stored days are picked, or today's alone when none
  are (the web's pre-selection); none picked shows "Select at least one day"
  and disables Done. Monthly is a 1 to 31 grid with the web's note. From
  xxLarge the keys are rows, and at the accessibility sizes the grid is a list
  scrolled to the picked day. Picked keys and days are the system blue, as
  the day picker's. Gated as `editAllowed(action: "repeat")` (not a subtask,
  more than one frequency). A repeat on an undated task leaves it undated, in
  the braindump. The chip keeps part 1's `cadenceLabel` words ("Monthly · 1",
  "Mon, Wed"), which Today's rows show, where the web's chip reads "Day 1" and
  "Mon Wed"; so seven days picked read "Daily" on the chip while its menu
  checks Custom days….
- **Project** (2f). The project chip is a menu: No project (never on a type
  whose container is required), then the projects in payload order with
  their dots (the web's colours since O15), the current one checked by
  folded name; a name with no project checks nothing, and a stored "none"
  (pre-#373 habits) reads as no project, as the web's dialog reads it. A
  pick writes at once and No project takes the chip away. Add property's
  Project ▸ lists the projects, with at least one. Gated as
  `editAllowed(action: "project")` (not a subtask, a type with the project
  axis). A task parked in its old project's block leaves it, its own time
  and day back and the block's part of day kept, as
  the web's bulk Move to project, and from 2f its item dialog, release it
  (Q6). The dialog keeps a day or a time the same save set itself, and
  files such a time where it falls, as before. The stash (`previousStartTime`,
  `previousStartDate`) now decodes, so the phone's own scheduling steps clear
  it as `scheduleTaskPatch` does: `editingTime` on a parked task, and a
  drop's `placing`.
- **Routines and seasons** (2f-b). Each chip is a menu of toggles, one per
  routine (season), which stays open as you toggle; then one Remove from row
  per membership, which writes and closes. Add property's Routine ▸ and
  Season ▸ list them, with at least one; one pick adds the item and closes.
  Gated as `editAllowed(action: "collect")` (`isCollectible`: not a
  subtask). Each toggle is one `collect` write; an add goes last in a
  routine's order. A toggle reads the membership live when tapped, and the
  one that would empty the chip closes the menu first
  (`.menuActionDismissBehavior(.disabled)` on every toggle but that one,
  which takes `.enabled`; README check 13 confirms both). The sample has a
  season, Autumn (Journal), and an empty routine, Wind down. Organize lists
  them (read-only from O1, see Organize below); making a routine or season
  on the phone waits for Organize's + menu (O11).
- **Labels.** The payload's `itemTypes` is `[{name, label, labelPlural}]`,
  from load_planner or, on the per-table fallback, `fetchItemTypes`, and null
  when the table is unreachable. The planner keeps them as `typeLabels` and
  hands them to `caps(_:labels:)`: a custom item's eyebrow, its title
  placeholder ("Add a side quest…") and its delete words use the user's
  label, while its capabilities stay the template's. With none (the sample,
  an older server) the label is the slug, capitalised.
- **Lime.** Text fields and the nav-bar Done tint in `Color.primary`, so the
  caret and the selection are never a 1.5:1 lime. `DayPickSheet`'s calendar
  tints the system blue instead: it draws the picked day as a white number on
  a disc of the tint and today's number in it, so the label colour hid today
  and, in dark mode, put a picked today white on white (README device check
  12 confirms the blue in both modes). The confirm dialog's Cancel follows
  the window tint, which DsulApp sets to `.label` inside `UIAlertController`
  at launch. Delete is the system red.
- **The fixture.** tests/fixtures/day/edit-writes.json, written by
  tests/unit/edit-writes-fixtures.test.ts from the web's own gesture over the
  real store (the panel's mapper for the one key, then `updateTask` /
  `updateHabit`; `deleteTask` / `deleteHabit`): each case's exact wire body,
  the refusal, the `updateItem` payload, the store's end item and the ids it
  deleted, in order, plus `String.prototype.trim` cases and the caps
  themselves (`limits`: `EDIT_LIMITS`, `OUTER_LIMITS`, `NEW_TITLE_LIMIT` and
  `MAX_BULK_ITEMS`). From 2b a new subtask's case also holds the row the
  store's `addTask` `created` (its id pinned), a reset's runs the verb as the
  phone offers it, and three more keys pin what the phone ports by hand:
  `bulk` (lib/bulk-add.ts on line breaks, every list marker, JS's `\s`, the
  cap), `streakRun` (`streakRunText`) and `copy` (`EDIT_COPY`). Vitest checks
  lib/item-edit.ts and replays every case through the route; DsulCore checks
  `editAllowed`, `editing`, `deleting`, `reinserting`, `subtaskItem`,
  `canAddSubtask`, `resettingStreak`, `ItemWriteBody`, `BulkLines`,
  `EditCopy`, `jsTrim` and `EditLimits` against the same file.
  2c adds the chips' cases, each driven as the panel drives it (the draft
  seeded by `draftFromItem`, the chip's change, the changed `DRAFT_KEYS`, the
  mapper): a priority set, cleared, already so, on a subtask and on a custom
  item, and refused on a habit; times per day changed, back to 1 (written as
  1), already so with none stored, and refused on a task; a reminder set,
  given words, retimed keeping its words, its words cleared, already so,
  turned off, the growth pair, and refused on a subtask. One case,
  `reminder-anchor-without-time`, is the file's only body the schema refuses
  (cue words with no time); both sides exempt it from "every body parses",
  and the phone's encoder can't build it. `limits` gains `anchor`,
  `outerAnchor` and `timesPerDayMax`, and `copy` the three reminder sentences.
  caps.json's item cases gain `reminderNeedsDate` (lib/bulk-edit.ts), hence
  `bulk-edit` in ios.yml's filter.
  2d makes the gesture the dialog's own save, `commitEdit`, both passes, and
  the 2a-2c cases regenerated byte for byte through it. Its cases: a time on
  an unscheduled dated task, a time in its own part of day, a part of day and
  a time, a time that crosses parts of day, Anytime dropping a time, Anytime
  on a dated task with none; a habit's part of day, its time cleared alone,
  both cleared (server-only) and a part of day its time overrules (written
  though the end row is the stored one); the block trio (a part of day
  releases it, a time alone in or across parts of day keeps it); a length
  alone, on an unscheduled task, at the default with none stored (`{}`) and
  on a habit; a custom item's part of day; and the five refusals
  (`not_dated`, `not_for_subtask`, the row's `invalid` for a time under
  Anytime, and the schema's two, `time-refused-anytime-with-a-time` and
  `time-refused-empty`). `limits` gains `durationMax`, and two keys are new:
  `buckets` (`getBucketForTime` and `autoCorrectBucket` on JS's edges, and
  `BUCKET_START_TIMES`) and `durations` (`DURATION_ORDER` and
  `durationLabel`, the lengths' words). caps.json's types gain `hasDuration`.
  2e adds the repeat cases (all three keys together, the unchanged rule, the
  type's frequencies, the schema's refusals) and `repeats`, the frequency and
  weekday words. The unchanged rule is the dialog's seed: stored days in
  another order write, a stale day under Daily sent Daily is `{}` and stays,
  and Monthly with no day stored sent the 1st is `{}`. The refusals are
  `frequency_not_allowed` (a habit's No repeat), `not_for_subtask`, and nine
  bodies the schema refuses (days or a day beside the wrong frequency,
  missing, empty, out of order, twice, or out of range), which the phone's
  gate never builds. `copy` gains the two repeat sentences. caps.json's types
  gain `allowedFrequencies`.
  2f adds the project cases (driven through the bulk Move to project, name
  and id, the release, the habit's always-written clear) with `projects` and
  `containers`, the container words. caps.json's types gain `containerKind`
  and `containerRequired`.
  2f-b adds the collect cases (driven through the store's
  `setItemsCollected`, the bulk bar's Add to / Remove from, which writes the
  same end list as the item panel's chips, item-dialog.tsx `toggleRoutine` /
  `toggleSeason` through `updateRoutine` / `updateSeason`), whose one key
  of their own, `member`, holds the container's `itemIds` before and after:
  an add appended, a remove filtered out, and each no-op, which
  `settingMembership` must reproduce. The refusals are `not_collectible` (a
  subtask) and two bodies the schema refuses (a container that isn't a uuid,
  and a goal).
- **Unproven on a device:** ios/README.md, "Editing an item" (checks 1-13:
  the title, the notes, the keyboard, Delete, adding subtasks, Reset streak
  and Streaks off, Add property, the chips and the Remind sheet, from 2d the
  Date menu and the Time sheet, from 2e the Repeat menu and sheet (checks 7
  and 8), from 2f the project menu and Add property's Project ▸ (checks 7
  and 8, and the 2f lines of 9-13), from 2f-b the routine and season menus
  and Add property's Routine ▸ and Season ▸ (likewise, with a stale web tab
  keeping a phone toggle), offline, VoiceOver, the largest text size, the
  lime, and the platform behaviours they rest on).

## Organize
The third tab, built as a series of small PRs (O1 to O15). The design, with
every decision and the PR plan, is the shared folder's
`ios-app/organize/design.md`; each PR's builders leave notes beside it
(`organize/o1/`, `organize/o2/` for O2 and O3, built as one PR,
`organize/o6/` for O6, O7 and O8a, one PR too, `organize/o8b/` for O8b
and O9, `organize/o10/` for O10 and O11, and `organize/o15/` for O15).

- **O1: the list, read-only.** The payload gains `goals` (null when
  unreadable) and `settings.organizeEnabled` / `settings.goalsEnabled`, from
  the same single `user_extensions` read as `streaksEnabled`. The tab is one
  `NavigationStack` with a large "Organize", the avatar menu and the
  `square.grid.2x2` tab glyph, over an inset-grouped list: Routines, Seasons,
  Goals (then Ended, when an active goal sits above it) and Projects, in the
  payload's order (goals in `sortGoalsForDisplay`'s). Each row is a 30pt tile
  (the container's colour at 18% on the tile, its glyph full strength), the
  name, and a subtitle: a routine's state pill ("Until Oct 30", "Held · Nov
  1"), its usual time in the account's clock and its live items; a season's
  pill, live routines and own live items; a goal's target day and progress
  in the web's words ("1/3", "2/2 so far"), or "Achieved" / "Set aside"; a
  project's items by folded name, subtasks left out. "Nothing in it yet"
  stands for a zero. Headers count rows, Seasons counts the ones on today
  ("1 on"). From O2 each row is a `NavigationLink` to its page (chevron, hint
  "Opens the routine"), and a live routine's row ends in "2/3 today" (the
  web's `todayCount`, only while the routine is in effect and something of
  it is on today); from O3 a project's subtitle adds its time block.
- **O2: the routine and season pages, read-only but for the tick.** The
  stack holds a path of `OrganizeRoute` (`.container(kind, id:)`); tapping
  the tab again pops to the list. A page is an inset-grouped list: the 44pt
  tile, the kind's eyebrow and the name in `.largeTitle` (the name moves
  into the bar once scrolled), its notes (four lines, then Show all), and
  read-only chips. A routine shows "Usually 7:00 am" and Status ("Active",
  "Paused", "Paused until Oct 30"), the web's paused note or its held note
  under it (`localOn && !effectiveOn`, so Active never stands alone over a
  routine a season holds off), "Held by" (each season with "on", "off" or
  "off until Nov 1", pushing its page, or "No season. It answers for
  itself."), Today (its members on today in the routine's own order,
  "2 of 3 done · 1 skipped", the first one still due marked "next", "All
  through for today." or "Nothing from … is on today."), Other days (each
  with its cadence, and why when something hides it: "Daily · Hidden with
  Morning" on a paused routine) and Last 14 days. A season shows Status ("On", "Off",
  "Dates") and Runs under Dates only, the web's sentence for its state, its
  routines in the routines' own order (each pushing its page), its own items
  and the strip over both. One `deriveContainerSchedule` over the strip's 14
  days feeds the checklist, the ticks and the strip.
- **The strip never says a past day was a share.** A past day with anything
  done is a full lime cell, one with only unrecorded occurrences a gray wash,
  one with a skip or nothing on an outline (ranked in that order, so a member
  added today, `open` on every earlier day, turns no recorded day into a
  wash); only today fills, done over done and still due, inside a 1.5pt
  outline. Fourteen VoiceOver elements ("Sep 30, 2 done", "Today, 2 of 3
  done"); nothing says "missed".
- **O3: the goal and project pages.** A goal's header is a 64pt ring (the
  lime arc at the share of milestones reached, the glyph in the middle;
  the tile when there is no milestone), then the why, the countdown ("120
  days to Mar 15", active goals only), the chips (Status, and "Started Oct
  1 · Target Mar 15"), an ended goal's note, the elapsed line (both dates
  and a milestone only), the wind-down list of an ended goal's recurring
  members (display only), Milestones (the timeline: a 22pt node on a 2pt
  rail, reached a lime check, next a 2pt lime ring with its title semibold
  in the label colour, the web's "next up", "still ahead of you",
  "dropped", "No date yet"), Check-ins ("Sun · last Oct 18") and Supporting
  work under each type's plural. The node is the milestone's tick on today
  behind the `tick` gate, whatever its date; every goal row opens its sheet
  and says why when something hides it ("Hidden with Winter"). A project's
  page shows "N items" (subtasks left out, the list's count, equal to its
  rows), its time block or "No time block" (read-only), its notes, its items
  open first, and the strip when anything is in range. Projects are
  ungated, as on the web.
- **Every row on a page is Today's.** The circle ticks only an item on
  today, through `toggle(_:on: today)`, the write Today's circle sends; the
  rest of the row, and the whole of any other row, opens the item's sheet on
  today. A skipped row shows the skip mark, and skipped is the schedule's
  word for today, so a cancelled one-off is skipped on the row as in the
  summary and never offered a tick. One element to VoiceOver, with the tick
  (or a milestone's "Mark … reached") as a named action.
- **Gone, or switched off.** A page whose container goes takes itself off
  the path and keeps drawing what it last showed while it slides away; one
  pushed for a container already gone pops at once. A fetch that couldn't
  read goals is a lost read, not a delete: a goal's page stays, showing what
  it last showed, until a fetch that read goals answers. With Organize (or Goals)
  off the page is the web's sentence ("Organize is switched off. …"), never
  "not found".
- **The switches are display gates.** Organize off hides Routines, Seasons and
  Projects and shows one quiet row saying so, with the phone's way back (the
  web's Settings); Goals off, or goals the server couldn't read, hides Goals.
  "Nothing here yet." shows only once loaded and only when every kind the
  switches allow is empty, naming only those kinds. Before the first fetch the
  list is a spinner ("Loading…") or the fetch's error with Try again
  (`PlannerLoadingRow`, which now takes the tab's words and tints Try again
  the label colour). Pull to refresh is `LiveRefresh`, as on Today.
- **Rules apart from views.** `Organize/OrganizeModel.swift` and
  `Organize/ContainerPageModel.swift` are Foundation only (on the shim's
  list), so `DsulTests/OrganizeTests` pins the sections, counts, subtitles,
  tiles, spoken labels and quiet rows, and `DsulTests/OrganizePageTests`
  every page's parts, the strip's ranking and the ticks, on Linux too.
  `DsulTests/OrganizeLookTests` (Mac runner only) checks every SF Symbol the
  tiles and the pages can draw exists.
- **Lime.** No stack-wide tint. A container coloured Lime (accent-8) gets a
  lime glyph on its tile, a mark at full strength; the ticks, the strip's
  cells, the ring and the timeline's nodes are lime marks too, and no text
  on the list or a page takes a hue.
- **The sample** gives Morning routine, Wind down and Autumn icons, colours
  and usual times, and adds a goal, Run a half marathon (three dated
  milestones, one reached, a weekly check-in, Gym as its supporting work),
  with its items made after Pay rent and off the anchor day so no pinned id
  or count moves. Goals is on in the sample. O2 and O3 give Morning routine
  and Work notes, and Writing a weekday time block (6:30 to 7:30 am) that no
  sample task sits in, so the grid and its pinned counts are unchanged.
- **O4: the summary cards.** Over the sections, THIS WEEK (only with
  Organize on) and NEXT MILESTONE (only with Goals on and the goals known),
  side by side while both fit the row (`ViewThatFits`, each card at least
  150pt scaled), stacked at the accessibility sizes, one alone spanning the
  width; neither shows no section. THIS WEEK is `organizeWeek` over the
  grid's own inputs from the user's Week starts on: "18" in `.title2` bold,
  "of 23 done" gray, and a 5pt lime bar on a gray track; "Nothing on this
  week" with no bar. It counts everything the grid shows this week however
  it is filed (design Q1's default, Kirby's to change), done out of done or
  still due, so a past day with nothing recorded is on neither side. NEXT
  MILESTONE is `nextMilestoneAcross`: the title (two lines), then "Oct 4 ·
  Run a half marathon", or the goal's name alone undated, with no
  countdown. It is one button that pushes the goal (on the tab's path, not a
  `NavigationLink`, so the list never takes the whole row, the week card
  included, as the link). Each card is one VoiceOver element ("This week, 18
  of 23 done").
- **O5: the footer, Paused and Item types.** Under the list, one section:
  Item types (a plum Shapes tile, the count of custom types; only with
  Organize on), Paused (a gray moon; always, as pausing is not gated so its
  way back may not be) and, from O14, Trash (a gray bin). Paused's count is
  the items set aside (`PausedShelf.count`: a routine of four counts four),
  with the soonest return under the title ("Gym back Fri", the web's rail
  note), and nothing at none. The Paused page says what it is for, then
  groups the shelf by return day ("Tomorrow", "Fri, Oct 30", "No date"):
  each row a mark (an item's dashed outline, round for a habit; a container's
  glyph in its colour), the name and `entryKindLine` ("Habit", a custom
  type as the user named it, "Routine · 4 habits"). An item's row opens its
  sheet and carries Resume where the sheet would offer it (`offers(.resume,
  …)` on today), the existing `resume(_:)` write; a routine's or season's
  row pushes its paused detail, and from O8a carries Resume too (below)
  (`.pausedEntry(key)`): the header, `pausedStateLine` under a moon, "Comes
  back with it" (each member with the list's dashed outline, the web's
  ItemMark, opening its sheet) and, with Organize on, "Open in Routines" /
  "Open in Seasons". The detail pops once the entry leaves the shelf. The
  Item types page lists the user's types in the server's order with "N
  items" (live items whose `typeName` is the slug, so a custom item counts),
  inert, "No custom types yet. You make them on the web." at none, and the
  web's sentence when the server couldn't read them. With Organize off the
  web hides its types section, so the page is gone and pops, as the detail
  does. The marks' column grows with Dynamic Type, as a tile does.
- **O14: the Trash, list and restore.** Signed in, against a server that
  sends `trashWrites` with both routes (an older one hides the row, and the
  sample has no bin). The page fetches GET /api/app/trash on each arrival
  and on a pull (which refreshes the planner too, as `LiveRefresh` does
  elsewhere), through `planner.fetchTrash()` → `PlannerSync` → `APIClient`
  (views hold no client), and keeps the rows in its own state, never the
  planner's. Each row is the web's glyph in its colour, the name, the meta
  ("Project · 3 items refile · 3d ago") and Restore (disabled with a
  spinner beside it while out; VoiceOver "Restore project Work", then
  "Restoring"); the footer says the bin keeps things
  30 days. A failed read says "Couldn't load the Trash." with Try again,
  never an empty bin. `planner.restoreFromTrash(row)` sends POST
  /api/app/trash/restore beside the write queue, bumping `writeGeneration`
  when it sends and when its answer arrives, so a fetch out across either
  comes back raced and is made again; a 200 starts a fetch and the row
  leaves the list. A 404 says "It's no longer in the Trash." and the row
  leaves too (purged after the list was read; no retry can land). Any other
  refusal shows in the banner and keeps the row: `name_taken` names the
  live project, `parent_gone` points at the parent, anything else (a 5xx,
  offline) is "Couldn't restore it. Check your connection and try again."
  A thrown `unavailable` (offline mid-request, 502 to 504) may be a lost
  answer, so it starts a fetch, as a failed queued write's drain does.
  `APIClient.send` is now `exchange` (the token,
  the 401 retry, 502 to 504 as unavailable) plus the refusal, so the restore
  can read a 409's whole body.
- **O6 and O7: web only.** A web tab opened before a reorder or a season
  hold made elsewhere (the phone's collect included) no longer puts it back
  when it next writes that container: `reconcileMembership` keeps a
  routine's stored order under `known`, and `updateSeason` passes `known`
  for `routineIds` too. No Swift; nothing on the phone changes.
- **O8a: a routine's and a season's Status, and Resume on Paused.** One
  route, POST /api/app/containers/:kind/:id, takes one intent per call
  (a routine's `pause`, `paused` true with an optional `pausedUntil` or
  false; a season's `state`), and the payload's `containerWrites` lists
  what it takes; a server that sends none hides every container editor.
  On a routine's page the Status chip is a menu (a gray chevron, the label
  colour, never lime) of verbs, as the item sheet's: Pause and Pause until…,
  or Resume and Pause until…. Pause until… opens the item sheet's
  `DayPickSheet` on the page ("Pause until", tomorrow first, on the
  routine's own return day when it has one); there is no way to clear a
  return day but Resume, as the route never clears one. A season's chip is
  its three states, the one it is in checked, sent exactly as picked
  (`seasonStateForSwitch` is Paused's alone). Both menus need the server's
  write and the kind's switch (`OrganizeModel.canEdit`, which the planner's
  `canWrite(kind:action:)` asks too). Paused's Resume, on a routine's or
  season's row and as the detail's "Resume now" / "Turn on now", asks the
  server's list alone, whatever the switches say, as the web's does: the
  planner's `turnOn(_:)`, the web's `setGateOn` (`gateSwitchIntent`), so a
  dated season goes back to following its dates. A container row with
  Resume is a button that pushes its detail (ending in a chevron, as the
  link did), as an item's opens its sheet, so the pill takes its own taps;
  one without (an older server) is still a link. The planner steps at once through DsulCore's `containerIntentPatch`,
  the route's rule, at one instant in the zone the server reads
  (`pauseZone`), and refuses a Pause until not after today itself, with the
  route's words ("That day is no longer after today, so nothing was
  paused."), which a 409 `pause_refused` shows too.
- **The container subject (O8a), which every later write reuses.**
  PlannerSync's `Write.container(ref, intent, refiled:)` names
  `.container(ref)` (and any item it refiles, none yet), and its `Before`
  is the whole container with its index in its kind's list. It never
  covers the member lists: a revert puts back the container's own fields
  over the lists it holds now (`withMembership(of:)`), so a collect that
  landed survives a failed pause. A failure rebases the container
  (`rebaseContainer`) with every landed `.container` write naming it
  replayed at its own `sentAt` (`applyingContainer`, in the zone the server
  read), and the revert puts things back in one order: items, then
  containers' field restores and removals, then containers that come back
  whole (newest failure first), then memberships (newest first). The
  revert's compare covers routines, seasons, projects and goals, so a
  season alone moving back says the change was undone. `Write.itemId` is
  gone: a write names its subjects. A failure's words are
  `PlannerSync.writeFailureText(_:for:)`, the route's own
  (`OrganizeCopy.refusal`) for a container refusal.
- **O8b: a goal's Status, the fields and the notes.** The route takes a
  goal's `state` (Active, Achieved, Set aside, through
  `resolveGoalStateWrite`: the state it has writes nothing, so a goal
  achieved twice keeps its first `achievedAt`; Set aside keeps the stamp,
  Active clears it), a routine's `usualTime`, a season's `dates` and a
  goal's `window` (both ends in one body, either null), and `notes` (a
  goal's `why`), stored trimmed. On the page a goal's Status chip is a menu
  of its three states, the one it is in checked (a stored state that is none
  of them checks Set aside, as the web's ended note reads it). A chip that
  edits (`PageChip.edits`) is a button with the gray chevron that opens its
  sheet: the usual time on the item sheet's `ClockWheel` ("Usually at", with
  "Clear time" where one is stored, 9:00 am where none is; "No usual time"
  on the chip, shown only where it may be set), and a season's Runs (under
  Dates alone, "Runs" with no dates) or a goal's window ("Target" with
  none) as two switches, each with a graphical calendar fenced by the other
  end so the range never inverts, and under Runs the season's own sentence
  for the draft (`seasonStateNote`). The notes, or the web's "Add a note…" /
  "Why this matters…" where there are none, open a `TextEditor` sheet with
  the item sheet's notes rules (cut as typed at what one request carries,
  `cleanNotes` on Done, too long to send shown and never edited). Every
  sheet is a Form with Cancel and Done that sends only what moved, and
  refuses a swipe down once the draft moved (Cancel asks "Discard
  changes?"). The planner's steps (`setUsualTime`, `setSeasonDates`,
  `setGoalState`, `setGoalWindow`, `setNotes`) send nothing when the value
  is what is stored, and go through `editContainer`, behind the page's gate.
- **O9: Rename… and Icon and color….** Every kind takes `rename` (trimmed,
  never blank), `icon` (an `icon:<Name>` token, never cleared; a project's
  is its `emoji`) and `color` (a ramp token, or null for Auto). The
  page's bar carries a ⋯ menu (the label colour, "More" to VoiceOver) while
  the page may write either: Rename… is an alert titled for the kind
  ("Rename project") with the name in its field, Save off while the name
  cleans to nothing (`cleanTitle`) and, on a project, while another live
  project's name folds to it (`projectNameClash`, the route's first step; a
  project changing only its case may save). The route's 409s say why in
  their own words, naming the name sent: `name_taken`, and `name_in_trash`
  for an exact name a project in the Trash holds, which the phone can't
  see. Icon and color… is a sheet: the tile as the draft draws it, the
  web's 36 featured icons as SF Symbols (`lucideToSymbol`), the picked one
  ringed only when it is the stored token exactly, then the eight ramp
  colours by name and Auto, the picked one checked. Nothing is
  written until Done, which sends the icon and then the colour, each only
  if it moved. The host presents the alert and the sheet, so they stay up
  however far the page has scrolled.
- **A project rename re-files its items (O9).** As the route re-files every
  item whose `projectId` is the project's (an item filed by name alone, with
  no id, stays put, on both sides), the planner gives each the new name at
  once (DsulCore `refiledItems`, `refiling`) and records them in the write's
  `refiled`, each with its own `Before`, so the write names them and a
  failed rename puts every member's filing back as it was, case included.
  PlannerSync's `replaying` re-files too: an item whose own edit failed
  before a rename that landed is rebased onto the new name, and a landed
  item edit survives a failed rename's revert. `refiled` is read off the
  phone's list at enqueue, so an item a queued edit was moving out of the
  project counts as a member; if that edit then fails and the rename lands,
  the item goes back to the old name (its Before) though the server re-filed
  it, until the next good fetch. That is by design, and it heals itself. A
  landed rename is never proof that a refiled item exists (`refiledSubjects`):
  the route re-files in one statement and answers 200 whatever it matched,
  so a capture that never landed is still taken back. If the route's
  re-file fails after the project's row was renamed, the route puts the old
  name back before its 500 (best effort), so the refetch shows what the
  phone's revert shows. The revert's compare sees the
  goals and the projects move, so a failed goal or project edit says the
  change was undone. A project's edits ride Organize, as a routine's and a
  season's do (O8a's `canEdit`), though the web's project page edits with
  Organize off.
- **Rules apart from views, O4 on.** The cards and the footer are
  `OrganizeModel.summary` and `.footer`; the pages are `ShelfPageModel`
  (Foundation only, on the shim's list), pinned by `DsulTests/ShelfPageTests`
  with the Trash's PlannerSync tests (`TrashSyncTests`: the strict body, the
  refusals' words, a 404 dropping the row, a lost answer's fetch, the race,
  an older server, the sample, a stopped sync). O8a's Status menus are
  pinned in `OrganizePageTests`, Paused's container Resume in
  `ShelfPageTests`, the container subject (the bodies, the reverts, the
  replay at `sentAt`, the refusal's words, an older server, Resume with
  Organize off) in `PlannerSyncTests`, and the sample's steps and
  `restoreContainer` in `SamplePlannerTests`. O8b's and O9's editors (what
  each page offers, in what words, the rename clash, the look's intents, the
  range drafts) are pinned in `OrganizePageTests`; their bodies, the
  rename's re-file and its reverts, the goal state's replay at `sentAt`, the
  local clash and the 409s, and the switches in `PlannerSyncTests`; and the
  sample's edits in `SamplePlannerTests`. O10's and O11's (each delete
  confirm's words and counts, the + menu's rows, the create clash, the
  sample's creates and deletes) are in `OrganizePageTests`, the nothing-yet
  line in `OrganizeTests`, and the bodies and routes, the revert order, the
  404 rule, the lost create a collect settles and the offline create in
  `PlannerSyncTests`. O12's and O13's (the Edit mode's anchors at both ends,
  the Edit button's two-step gate, the picker's pool, its filter and the
  planner's own copy of it, the gates, the attach confirm's count and words,
  the sample's moves, holds and confirm) are in `OrganizePageTests`, and the
  two bodies, the subjects each names and proves, the rebases, a hold's
  place in the revert order, a landed hold played over failed ones and the
  refusals in `PlannerSyncTests`.
- **O10: Delete….** Every kind takes `{"action":"delete"}` on the
  container route: it puts the row in the Trash and touches no item and no
  join row (a project's members keep their name and id, as after the web's
  delete). The ⋯ menu ends, under a divider, in a destructive "Delete…"
  where the page may delete (`"delete"` in `containerWrites`, behind the
  same gate as the other edits), which opens a `confirmationDialog` with the
  web's title and button for the kind and the phone's sentence:
  `deleteConsequence` without the web's ⌘Z clause, every kind's ending
  naming the kind ("The routine stays in the Trash for 30 days.", so a bare
  "It" after an item's sentence never reads as the item going). Both shells
  count one thing in the singular and say only "“Desk” is removed." of an
  empty routine (the panes said "its 0 items stay" and "the 1 item it holds
  stay"). It counts as the web's pane does: a
  routine's live members, and whether removing it brings any back into view
  (`membersRevealedByRemoving`, with no away, as the pane's ctx); a season's
  live items and routines, and whether it is live today. A project's count
  is its page's (the folded name, subtasks left out), where the web's pane
  counts the exact name with subtasks; the two differ only for a filing in
  another case or a project holding subtasks. The planner takes the
  container off at once, the page pops itself (`OrganizePageHost`), and
  VoiceOver hears "Routine deleted" once the pop has settled. A deleted
  project's items stay filed by name, so the List puts them under No
  project and their chip shows the name (with a gray dot until O15, and
  since then in the name's own colour, as on the web); on the web a
  reload still names the deleted project too (a known web limit).
- **O11: + and the name sheet.** The bar's + (a `Menu` in the label colour,
  "New" to VoiceOver) lists New routine, New season, New goal and New
  project, each the switches show and the server creates (`"create"` in
  `containerWrites`), only after the first fetch, and a goal only once goals
  are read. With none there is no +. Each opens `CreateSheet`: the web
  console's create form as a Form, the kind's eyebrow over one field ("Name
  your routine…"), its hint under it, Cancel and "Create routine". Create is
  off until the name cleans to something (`cleanTitle`) and, for a project,
  while a live project's name folds to it, which the field says, naming the
  project there. Create (or Return) makes it at once
  (`SamplePlanner.createContainer`: a lowercased UUID of the phone's, the
  kind's starting glyph, a goal's window opening today), and the list
  pushes its page once the sheet has gone, VoiceOver hearing "Routine
  created". `POST /api/app/containers/:kind` takes `{id, name, icon?}`,
  and a goal's `startsOn?` too: a retry by id answers 200 and writes
  nothing, a project's name clash is 409 `name_taken`, one the Trash holds
  `name_in_trash`, each worded by the name sent. The list's nothing-yet
  line now reads "Make a routine, season, goal or project with +.", naming
  only the kinds the + offers.
- **Delete and create in PlannerSync (O10, O11).** A delete is a `.container`
  write with `Before.container(snapshot, index)`; a create is its own write,
  `.createContainer(ContainerCreateBody)`, whose Before is
  `.containerAbsent(created:)`. A failed delete puts the container back in
  its old place: re-inserts run newest failure first, after the field
  restores and before memberships, so a failed collect then a failed delete
  bring the routine back without the item, and the re-insert carries the
  membership the latest recorded Before holds (a collect that landed meanwhile
  included). A delete answered 404 `not_found` has landed; any other 404
  fails and reverts. A failed create is taken back unless a later landed
  write names or proves the container: collect's `proves` gains
  `.container(ref)`, since a 200 there proves it exists, so a create whose
  answer was lost and a collect that landed keep it, while a create and a
  collect both offline are both undone.
- **O12: a routine's steps, reordered and added.** The route takes
  `moveMember` on a routine: one step, and the step it now sits after
  (`afterId` null for first), as the web's rail moves one. The page's bar
  carries Edit where it does (`"moveMember"` in `containerWrites`, Organize
  on, and two steps or more, `StepsEdit.reorderable`: an empty routine, one
  of one step, and a server that takes the add but not the order show no
  Edit), and in Edit mode Today and Other days give way to one Items
  list, the web's member-list label, each row with a grip; a drag asks
  `stepDrag` for the step and its new anchor (`Array.move` is SwiftUI's, so
  the anchor is worked out by hand) and sends it. "Add from your items…"
  opens the collectible items the routine doesn't hold, in the planner's
  order, each with its cadence, filtered as the web's picker filters
  ("Nothing matches “cat”." for one that matches nothing); a pick reuses the
  item sheet's own collect write and the sheet stays up, reading the live
  pool, so the picked row leaves and a second pick needs no reopening. A
  swipe Remove on a resting row takes the step out the same way; it is
  never "Delete", because nothing is deleted. Both the add row and Remove
  ask the item write (`"collect"`), not `moveMember`, so an older server
  can reorder and not add. VoiceOver gets Move up, Move down and Remove as
  actions on a step (the design's short names, not the web's long
  aria-labels), with no Move up on the first row and no Move down on the
  last.
- **O13: a season's routines, added and taken out.** The route takes
  `holdRoutine` on a season: one `season_routines` row, in or out. The
  Routines section's last row is "Add a routine…" where the server takes it,
  drawn and disabled with "Every routine is already here" when the season
  holds them all, as the web's pill is always there. A pick whose join would
  take items off today asks first, in the web's words ("This will hide 3
  items for now", `wouldHideAttaching`), with "Add it anyway" against the
  system's Cancel; the confirm comes up once the sheet has gone, because a
  confirm cannot show under a sheet. A swipe Take out hands the routine
  back and asks nothing: nothing the user can see is hidden by it. Only
  live routines are offered and drawn, so neither write names one the Trash
  holds.
- **A membership write is its own subject (O12, O13).** PlannerSync's
  `moveMember` and `holdRoutine` each name ONE membership, never a list: a
  step's place keeps the `.member` subject the item sheet's toggles own (its
  Before is unchanged; the anchor a landed move left lives in the rebase's
  `MemberTarget`), and a season's hold of a routine is its own
  `.hold(seasonId:routineId:)` with `Before.hold(held:index:)`. So a
  container's failed field write can never put back an order or a hold that
  landed, and a failed move or hold never puts a field back. A failed
  move's revert puts the step back after the step a landed move left it
  after (`rebaseMember`, DsulCore `placingMember`), or where it stood
  before its earliest failure; a failed hold goes back in or out at its old
  place (`rebaseHold`), after the containers that come back whole and
  before the memberships, so a hold never lands in a season that isn't back
  yet. A move proves its step and its routine, and a hold its season and
  its routine (no item). The route's
  `member_gone`, `anchor_gone` and `container_gone` are all one sentence on
  the phone ("It changed on another device. Showing the latest."), since a
  move and a hold send no name to quote back.
- **O15: Today's project colours (Kirby picked Switch, 2026-10-24).**
  `ProjectPalette`, the index palette Today had worn since part 2f (a
  project's place in the list picked one of seven system colours, and a
  name no project held was gray), is gone. Every project dot now asks
  `SamplePlanner.projectAccent(for:)`, which is DsulCore
  `projectAccent(_:projects:)` over `projectRecords` (colours and all,
  never `projects`, the names): the web's grid rule (planner-store
  `getProjectColor`, lib/accent-colors.ts `projectColorToken`), so a
  project is one colour on the web's grid and in every one of these
  places. The stored colour of the project the name folds to wins; then
  the legacy `--habit-wellness|work|personal` token for those folded
  names; then the folded name's ramp step. `ContainerColor.swift`'s
  `ContainerAccent.color` turns it into a `Color`, as it does Organize's
  tiles, so there is one colour port. Callers: Today's List section dots
  and filter chips (`ListLayout.swift`), Week × List's project captions
  (`WeekList.swift`), and the item sheet's project chip, read-only or a
  menu, the chip's menu rows and Add property ▸ Project ▸
  (`ItemDetail.swift`, through `PropertyMenus.swift`'s colour closures),
  so the chip and the row under it never disagree. A row with no project
  still wears no dot, and No project and a routine's section none. Colour
  is a mark only: a dot, never text. Because a dot can now be lime (a
  project coloured Lime, or a name that hashes there, as "Errands" does),
  List's section header and the filter chips press with `RowPressStyle`
  and `PressScaleStyle` instead of `.plain`, which faded the label, dot
  and all, on every press. Where the phone and the web part: a free-text
  colour an agent stored (the payload fixture's Admin is "blue") is handed
  to CSS on the web; the phone can't read it and draws the grid's own
  answer for no colour. Where Today and Organize part, as the web's grid
  and Organize part: where no colour the phone can read is stored, a Work,
  Personal or Wellness wears its legacy token on Today and its raw name's
  ramp step on its tile (the sample's Work: a muted blue on Today, plum on
  Organize), and a name whose fold moves its ramp step (U+0100) wears the
  folded name's step on Today and the raw name's on its tile. A name no
  project holds (an agent's "Fitness", a deleted project's members) has
  the grid's no-colour answer now (its legacy token, else its folded
  name's step), not gray, as the web's item dialog draws it. Pinned by `look.json` in DsulCore (`LookFixtureTests`' four O15
  tests), by `SamplePlannerTests`' three (the sample's dots, a recolour
  through Icon and color… against the tile, and a fetch's token, hex and
  free-text colours) and, on the xcode-27 runner only,
  `OrganizeLookTests.aProjectDotIsItsTokenInEachAppearance` (the menu
  row's `UIColor` keeps the light and the dark value); README "Checking
  Organize", checks 82 to 85.
- **Waits for later PRs:** a project's time block stays the web's (the
  project union has no time action).

## CI
`.github/workflows/ios.yml`, on PRs to main and pushes to main. A `changes`
job decides whether anything iOS changed (`ios/` except Markdown, the
workflow, the mirrored TS files and packages/types' `schemas.ts`); the two real jobs skip otherwise, and a
skipped job reports as passed, so the checks could later be made required
without stalling web PRs. `DsulCore (Linux)` runs `swift test` in the
`swift:6.4-bookworm` container. `iOS app (Xcode 27)` runs on the `xcode-27`
image (preview; never `-xlarge`, which is billed), selects Xcode through the
`/Applications/Xcode_27.0.app` symlink, installs XcodeGen 2.46.0 by checksum,
then builds and tests on the iPhone 17 simulator with signing off. Cloud
sessions can't compile Swift, so CI is the compile loop.

The web `Tests` workflow and Vercel still run on iOS-only PRs; they pass and
rebuild the same web code. Gating them is a possible later web-only PR, judged
on saved minutes (mostly the E2E job). Don't add `ios/**` to test.yml's
`paths-ignore`: the required `Unit tests (Vitest)` check would never report
and the PR would stall.

## Sign-in (PR 3)
- **Google only**, through the authorization-code flow with PKCE (S256), in
  an ephemeral `ASWebAuthenticationSession` (SwiftUI's
  `webAuthenticationSession`), so no Safari cookie picks the account. GoTrue's
  `redirect_to` is `https://do.dsul.app/auth/ios` (covered by Step 0's
  `https://do.dsul.app/**`), which 302s a well-formed `?code` or
  `?error_code` to `app.dsul.ios://auth/callback`; the session catches its own
  scheme (the app registers it too since the email link, below). Fallback if
  that hop fails on a device: allow-list `app.dsul.ios://auth/callback` and
  redirect to it directly.
- **Nothing secret in `ios/`.** The Supabase URL and anon key come from
  `GET /api/app/config` on the first sign-in tap, cached in UserDefaults per
  origin and fetched again once if the gateway refuses the key. A signed-out
  launch makes no request.
- **Tokens:** one JSON blob in the Keychain, `AfterFirstUnlockThisDeviceOnly`,
  saved BEFORE the app counts itself signed in and before a refreshed pair is
  handed out (a failed save keeps the pair in memory and retries). An
  install's first launch wipes a leftover from an earlier install; after that
  the Keychain is read only when this install wrote it. Hosted tests (and the
  app as a test host) use an in-memory store: an unsigned simulator build gets
  -34018 from every Keychain call.
- **Refresh:** one at a time (a stored `Task`), because refresh tokens rotate.
  Only GoTrue's verdict that the session is gone signs out
  (`classifyRefreshFailure`; a web sign-out is global, so it arrives here);
  a 5xx, 429 or no network keeps the tokens and retries with the SAME refresh
  token, inside GoTrue's reuse window (about 10s, from memory).
- **Sign-out is `scope=local`**, so the web and the desktop stay signed in.
  The local wipe comes first, whatever the call does.
- Sign in with Apple has its own section below; universal links wait for a
  later PR; the email link is the next section.

## Email link
"Email me a sign-in link" under Google: the link only. A typed 6-digit code
needs `{{ .Token }}` in two hosted email templates and waits on Kirby.
- **The send.** `POST /auth/v1/otp?redirect_to=https://do.dsul.app/auth/ios?via=email&n=<nonce>`
  with `{email, code_challenge, code_challenge_method: "s256"}`; `create_user`
  is GoTrue's default (true), as the web's login form sends. The phone keeps
  an `EmailSignIn` record (address, verifier, nonce, last send) in its own
  Keychain item, saved BEFORE the request, because the link may be opened
  after a quit. ONE verifier and nonce per sign-in, reused by every resend to
  the same address: GoTrue commits a magic-link flow state with the request's
  challenge before its 60-second resend check, and a tap exchanges the user's
  LATEST flow state, so a fresh verifier on a resend (even a 429'd one) would
  orphan the earlier email. A record lives an hour after its last send.
- **The hop.** GoTrue's /verify 303s to `/auth/ios?via=email&n=…&code=…`
  (keeping redirect_to's query; errors go in query and fragment). With
  `via=email` the route always serves its page, never the 302: the script
  forwards `app.dsul.ios://auth/callback?code=…&n=…` and rewrites the address
  to `#via=email&n=…&code=…`, so an in-app browser's "Open in Safari" still
  carries it. It depends on the Site URL or `https://do.dsul.app/**` allowing
  the redirect (Step 0); otherwise GoTrue falls back to the Site URL and the
  phone never hears back.
- **The app** registers `app.dsul.ios` (project.yml), and DsulApp's
  `onOpenURL` hands the URL to `AuthStore.handleOpenURL`, which drops anything
  that isn't the email shape, arrives signed in or mid-sign-in, or lacks the
  pending record's nonce, before it changes anything. A matched link leaves
  the sample. "Signed in as" shows the session's address, never the typed one.
  A failed exchange keeps the record (GoTrue keeps the flow state), and a
  second delivery during the exchange meets `.signingIn`.
- **First-time addresses** with Confirm email on get a signup flow state that
  expires 5 minutes after the SEND, so a slow tap answers flow_state_expired;
  the copy asks for one more link, which then signs straight in (the address
  is confirmed by then).
- **Residual risk: a custom scheme isn't owned.** Another installed app that
  declares `app.dsul.ios` could receive an email code, and PKCE doesn't save
  it: GoTrue binds a magic-link code to the user's latest flow state, which
  anyone can plant with an unauthenticated `/otp` (even a 429'd one) carrying
  their own challenge. Fine on Kirby's own phone; universal links (Associated
  Domains plus an AASA file on do.dsul.app, which need a paid team) are a
  precondition for any wider distribution, and the page's copy meanwhile says
  to tap Open only if the prompt names dsul. The same holds for `dsul://` on
  the Mac.
- **Unproven on a device:** Mail and Safari (prompt accepted, then declined
  and the button), Gmail with each link browser, a cold launch, the older
  email after a refused resend, and Google still caught by its sheet now that
  the app owns the scheme. ios/README.md lists the checks.

## Sign in with Apple
"Continue with Apple" under Google: Apple's own button and sheet, then
GoTrue's id_token grant, with no browser, no redirect and no URL scheme. The
setup in Apple's and Supabase's dashboards is in
memory/plans/sign-in-with-apple.md; the phone needs nothing beyond it, since
`app.dsul.ios` is already among the Apple provider's Client IDs.
- **The button.** `SignInWithAppleButton(.continue)`, so the title
  ("Continue with Apple", the web's words), the logo and the VoiceOver label
  are Apple's. It sits under Google and above the email link, in the same
  branch, so it shows exactly when Google does. Black in Light Mode, white in
  Dark Mode (HIG), full width, as tall as Google's button (measured with
  `onGeometryChange`, never under 44pt), and both are capsules. Its `.id` is
  the colour scheme, so an appearance switch rebuilds it, but from a tap
  until the attempt ends the id holds still: a rebuild drops the object
  Apple's controller reports back to (its delegate is weak), and the attempt
  would never end. While busy it is disabled and also takes no hits: no
  source says the UIKit control under it honours `.disabled`, and a tap that
  got through would open Apple's sheet even when AuthStore refused the
  attempt. While Apple's sign-in runs, the message line says "Signing in…",
  and Google's button keeps its own title.
- **Large text.** Apple's title is 43% of its button's height and can't
  follow Dynamic Type, so the lower stack stops growing at the first
  accessibility size and the Google and email titles stay one line; the
  title block above keeps scaling. The screen is a ScrollView at least as tall
  as the screen, so it lays out as before and scrolls only when it doesn't
  fit.
- **No gate.** The button shows wherever Google does; the phone doesn't ask
  whether Supabase has Apple on. The web gates so its button could ship
  ahead of the setup, and the phone ships after it. A gate would need a
  request on a signed-out launch, which makes none, and /api/app/config is
  cached (in UserDefaults, and publicly for an hour), so it would lag a
  switch anyway. A provider that is off answers `provider_disabled`: "Sign in
  with Apple isn't available right now. Use Google or an email link." A
  missing `app.dsul.ios` among the Client IDs is GoTrue's audience refusal,
  with no code, so the phone says "Couldn't sign in. Try again." while the
  web still signs in. Guideline 4.8 wants a login like Apple's wherever
  Google is offered.
- **The nonce.** One per attempt: `beginAppleSignIn()` makes 32 random bytes
  (base64url, as PKCE's verifier), keeps them in memory only, and hands
  Apple's request their lowercase hex SHA-256. The grant sends the RAW nonce,
  which GoTrue hashes and compares with the token's claim (`token_oidc.go`).
  GoTrue stores no nonce, so a replayed token with its raw nonce works until
  it expires, and the guard is the phone's: `finishAppleSignIn` clears the
  nonce first, whatever happens, and a completion with no attempt under way
  is dropped. Accepted: a second tap that beats `.disabled` can end the live
  attempt with a line, or reach GoTrue with a nonce-less token it refuses.
  Nothing signs in wrongly, and the cost is one more tap.
- **The grant.** `POST /auth/v1/token?grant_type=id_token` with
  `{id_token, nonce, provider: "apple"}` and no Authorization (a sign-in,
  never a link). The answer is the PKCE exchange's token response, kept the
  same way: Keychain first, then signed in, then "Signed in as …" once. No
  client secret: GoTrue checks the token against Apple's public keys, so the
  web's six-monthly rotation never touches the phone. A blank `user.email`
  (GoTrue sends `""` for a user without one) reads as none, for every
  provider. Nothing retries on its own: a tap is a fresh attempt with a fresh
  nonce, as a Google code is good once.
- **The name.** Apple hands it to the app once, on the first consent, and
  never in the token. After the grant, when Apple gave a name and the account
  has none (`full_name`, else `name`, as `sessionUserFrom` in
  lib/session-user-store.ts reads them), one `PUT /auth/v1/user` writes
  `{data: {full_name, name}}`, the two keys GoTrue's own Apple callback
  writes. No retry and no message: a failed write loses the name until the
  user removes dsul from Sign in with Apple and signs in again. The name
  is GoTrue's `TrimSpace(first + " " + last)` with control characters
  dropped, and none at all over 200 UTF-8 bytes, since it rides in every
  access token. A name the account already has (Google's, or one the web
  flow stored) stays. The phone shows no name for any provider; the web's
  user card, profile menu and Ask greeting do.
- **Credential state.** The session keeps the Apple user id it signed in
  with (`Session.appleUserId`, in the same Keychain blob, kept across
  refreshes). At launch, on every return to the front and on Apple's
  `credentialRevokedNotification`, `checkAppleCredential()` asks
  `credentialState(forUserID:)` (a local call) and, on `revoked` or
  `notFound`, signs this phone out as Sign out does, with "You were signed
  out. Sign in again to see your day." `notFound` is Apple's "the user
  changed". `authorized`, `transferred` or an error keep the session, and a
  Google or email session is never asked about. The notification names no
  user, so it runs the same check rather than a blind sign-out. The web and
  the desktop stay signed in: no server-to-server notifications are set up.
- **Errors.** One line, in the message slot Google and the email link use. A
  cancel says nothing. Any other failure of Apple's sheet: "Apple couldn't
  sign you in. Try again." No network: "Couldn't reach dsul. Check your
  connection and try again." Any other refusal: "Couldn't sign in. Try
  again." A failed name write says nothing.
- **Hide My Email.** Supabase finds the account by the Apple ID first, then
  by a matching verified email, so an Apple Account's first sign-in to dsul,
  on the web or the phone, decides: Hide My Email starts a separate, empty
  account, and Share My Email opens the account with that address. After
  that, the same Apple Account opens the same account whatever it shares.
  The phone says nothing beyond "Signed in as …" (the relay address, for an
  account Hide My Email made), as the web says nothing.
- **The entitlement.** project.yml's `entitlements:` has XcodeGen write
  `Dsul/Dsul.entitlements` (`com.apple.developer.applesignin: [Default]`),
  gitignored like `Info.plist`, and set `CODE_SIGN_ENTITLEMENTS`. CI builds
  unsigned, so nothing checks it there. A device build needs the paid team
  (a Personal Team can't sign Sign in with Apple); a profile without the
  capability fails Apple's request at once, as "Apple couldn't sign you in".
- **Where it lives.** DsulCore's `AuthCore.swift`: the nonce and its hash,
  the grant, the name write, the name rule and `displayName(in:)`.
  `AppleAuthorization`: the request's scopes and nonce, the button's result
  as `AppleSignInOutcome`, and the credential state, so AuthStore and its
  tests need none of AuthenticationServices' types (only the
  AppleAuthorization suites beside them import it, Delete account's
  included). `AuthStore`: the attempt, the grant, the name write and the
  check. `SignInView`: the button, and VoiceOver's reading of the message
  line. `AppGate`: the check's three triggers, each in an unstructured Task
  so the view swap a sign-out causes can't cancel its logout.
- **Unproven on a device:** Apple's sheet and its first consent, the held
  colour, the large-text layout, removing dsul from Sign in with Apple, and a
  Hide My Email account made on the web. ios/README.md lists the checks.

**Account deletion** shipped with the web's
(memory/plans/account-deletion.md). Delete account… in the avatar menu opens
`DeleteAccountSheet` (a `PlannerSheet`): it names the account, says what goes
and what dsul can't delete, and asks for DELETE; the server deletes the
account at once, and the sign-in screen says "Your dsul account is deleted.",
which VoiceOver reads. For an account that signs in with Apple, on a phone
whose Apple Account can authorize its Apple ID, the sheet first asks Apple for
a fresh code (Face ID, through SwiftUI's `authorizationController`: no scopes,
`user` set, no nonce), which the server exchanges as `app.dsul.ios` and
revokes after the delete, never before, with a five-minute client secret it
signs itself, so nothing secret is in `ios/` and nothing needs rotating.

**App Review waits for revocation on prod.** Submit the build only once the
four Apple variables are deployed (sign-in-with-apple.md, setup step 8) and an
Apple deletion has answered `revoked`: ios/README.md, "Checking account
deletion", check 6 showed dsul gone from Sign in with Apple, or Vercel's logs
show `[account] deleted revoked`. Reviewers sign up with Apple, and the
guideline's FAQ says such apps "should use the Sign in with Apple REST API to
revoke user tokens"; a build reviewed before that shows the manual line
instead, which says dsul can't. The review notes, in App Store Connect:
"Delete account: sign in first (Continue with Apple makes an account; Try with
sample data has no account). On Today, tap the initials at the top right, then
Delete account… in that menu. It deletes the account at once and, for an
account made with Sign in with Apple, removes dsul from Sign in with Apple."

## Data (PR 3)
- **Routes, not tables.** `GET /api/app/planner` (items, projects,
  routines, seasons, the user's item types, six settings and the `writes` it
  takes, `completedDates` windowed to 400 days), `POST /api/app/items`
  (capture, under the phone's own lowercase id, so a retry is answered 200
  for the same row) and `POST /api/app/items/:id` (`complete` with a date, an
  end state and a counted habit's tally, `schedule` with a date and `HH:mm`,
  or the item sheet's `skip`, `move`, `pause`, `title`, `notes`, `delete`,
  `addSubtask` and `resetStreak`, above). Bearer Supabase access token only;
  RLS on a user-scoped client is the tenant guard; an Auth outage is 503,
  never 401, and the phone never signs out on a 503.
- **The day** is the stored timezone, trimmed, else the device's
  (`timezone?.trim() || device`), as the web resolves it. So is "now" (the
  web's `useNowMinutes(timezone)`), and `today` turns at that zone's
  midnight: `NSCalendarDayChanged` fires at the device's, so RootView also
  checks once a minute.
- **PlannerSync.** Writes are optimistic and go through one FIFO queue of
  chained Tasks: `set_item_completion` moves the streak only when the array
  changes, so a tick and an untick sent side by side can land reversed. A
  fetch is applied only if no write was pending when it started, none was
  queued since (`writeGeneration`), and no braindump row is in the air
  (`DragHold`, set by `ScheduleDrag.begin`, released by the drop or 0.5s after
  the drag ends). The hold is a 60s lease renewed by the drag's own updates,
  so a drag whose view is torn down mid-flight (and never delivers `.ended`)
  can't hold fetches back for good. A discarded fetch is made again, never
  dropped: after the drain, or after a pause that doubles (0.5s up to 4s)
  while ticks keep landing under it. A failed write shows a banner and
  refetches once the queue drains, and the server's answer replaces every
  guess. A payload for another user is never shown.
- **A revert, if that refetch fails too, is per subject** (an item; from 2f
  also a routine's or a season's membership: a failed toggle puts the
  membership back, at its old place in a routine's order, unless a later
  toggle of the same membership landed; several in one revert go back newest
  first, as deletes do, since each place was measured against the list the
  earlier ones left). Part 1 rebased the failed
  write's slot, which part 2's writes cross: a repeat edit changes how later
  ticks read, a reset and a tick both move the streak, and a delete or a new
  subtask changes whether an item exists at all. So each subject with a
  failure goes back to what it was before its earliest failed write (the item
  and its `Place` in the list, or absent for a capture), every write that
  landed after that one and names it is played again on top, in order,
  through the planner's own steps (`replaying`: an edit through `editing`, a
  delete to nothing, a pause resolved again at its own `sentAt`, the instant
  its `perform` started, on the day that instant falls on in the zone the
  pause was sent with, as the server resolved it then), and the result is
  put back: replaced, removed, or reinserted after the item it followed
  (`Place.after`), else at its index, clamped. Each delete recorded its places
  against the list the deletes before it had left, so returning items go back
  newest failed delete first, and in ascending `Place.index` only within one
  delete. A landed delete that cascades
  (anything but a habit's) also removes any subject whose replayed state
  names it as parent, matched as it replays rather than from the list
  recorded at enqueue, so a failed subtask edit can't bring back a child the
  server's cascade took. A subject ends where the server holds it, and
  nothing else moves: a tick that landed is never undone by a carry that
  failed. It is exact because a fetch is applied only with no write pending
  or queued, so between a write's snapshot and its revert only the phone's
  own writes changed the subject, and each phone step matches the server's
  write (the fixtures check it).
  A landed write doesn't moot a failed one: two writes need not set the same
  fields (a carry keeps the time a failed drop set, a skip leaves the tally a
  failed tick set, a resume of an item the server never paused writes
  nothing), so it is replayed, never trusted. A write's 200 can also prove a
  row it hangs on without changing it (`proves`): an `addSubtask` names the
  new child it creates (`.absent(created:)`, so a failed one takes the child
  with it) and proves its parent, so a failed capture takes its item with it
  unless a later write that names or proves it landed: the route answers 404
  for a missing row. A delete answered 404 counts as landed only with the code
  `not_found` (the row is gone either way); a 404 without it (an edge's, an
  HTML page) is a failure. A subject with a write still queued
  (`queuedBySubject` counts subjects and proves), or under a queued delete
  whose cascade would take it (`queuedCascades`: that delete need not name a
  subtask the phone had already taken out on its own), keeps its failures and
  the landed writes that name it until that write is in, and the drain
  refetches; so does one whose write is still out when a fetch fails (a pull
  to refresh). Reverted subjects are dropped from each failure, a failure
  once it is empty, and a landed write once nothing it names or proves is
  waiting and it is not a cascading delete that would take a waiting
  subject's item. The "so that change was undone" banner shows only when a revert
  moved something; otherwise it is the plain "Couldn't reach dsul".
- **Background time.** PlannerSync takes a `BackgroundTime` (two main-actor
  closures; `.foregroundOnly`, which asks for nothing, unless one is passed,
  and a recording fake in the tests) and begins it whenever a write is queued
  and none is held (so a write queued after iOS took the time back asks
  again), and ends it at the drain, on `stop()` or on expiry; AppGate passes
  `UIApplication`'s `beginBackgroundTask` / `endBackgroundTask`, through an
  adapter that ends each task exactly once and ends it itself on expiry if
  its owner didn't (a sync dropped with writes queued). So a tick, a
  title saved on `.background` or a delete just before a swipe home gets the
  half minute or so iOS allows. A write still out at expiry fails on resume
  and is handled as above. The queue lives in memory: an app killed while
  suspended loses whatever was still queued, and the next fetch shows the
  server's state.
- **The first load shows itself on every layout**: List and Buckets put the
  spinner (or the error and Try again) in the list, and Schedule floats it
  over the grid, since an empty grid alone looks like a free day.
- **No polling, no realtime** (the web has neither): a fetch on sign-in, on
  returning to the app at most once a minute, and on pull to refresh in List
  and Buckets (never on the Schedule grid, whose drag owns the gestures).
- **A skipped occurrence is a strip with no checkbox**, and a tick on it
  sends nothing (`tickIntent` is nil), as the web refuses it.
- **Habits can't be dropped on an hour from the phone** (the route answers
  `not_schedulable`); only tasks reach the braindump in practice.
- **The home-screen icon follows the App icon pick** (lib/app-icons.ts,
  `user_settings.app_icon`, migration 056), which the planner payload carries
  as `settings.appIcon`: `'aurora' | 'lime' | null`, an unknown slug read as
  Aurora and null (never chosen, or a database without 056, which the route
  survives by reading the settings again without the column) leaving the icon
  alone. `AppIconSwitcher` calls `setAlternateIconName` only when the pick
  differs from the icon showing, one change at a time, from AppGate (each
  fetch, and again on returning to the app, since iOS refuses a change made
  in the background). Lime is `AppIcon-Lime`, listed in project.yml's
  `ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES`. The web tab's Lime once the
  day is done (lib/day-done.ts) is not ported: iOS alerts on every icon change.
  Picking the icon on the phone waits for a settings write route.

## Writes go through the server
When the app writes, it calls the bearer-auth `/api/app/*` routes (above),
never Supabase directly and never with a cookie. Writes are intents, never
arrays: a tick sends a date and an end state, never `completedDates`, and a
skip a date and `skipped`, never `skippedDates`, because the phone holds a
400-day window and an array written back from a window deletes what it didn't
show.

The routes do what the browser UI's writes do, through the same `lib/db.ts`
functions:
- **Webhooks: none, as in the browser.** The browser has no service key, so
  `notifyPlugins` finds no registrations there and the web UI fires no
  `tasks.updated`/`habits.updated`. The phone matches it: `createItem` with
  `{notify:false}`, and `updateItem` and `deleteItem` without a `userId`.
  (Not every server write is silent: `/api/reminders/act`'s one-off Done
  passes the user and does fire one.)
- **`item_events`** are written by `createItem`/`updateItem`/`deleteItem`
  exactly as the web writes them, a delete's one per item it deletes (the
  parent's, then each subtask's, as deleteTask writes them); a recurring tick
  goes through `set_item_completion` only, with no status write and no event,
  as on the web, and an edit the row already says writes neither.
- **One action per field, never a generic edit.** Each is `.strict()`, so a
  server that doesn't take a field, or a key a newer phone adds, answers 400
  rather than dropping it and answering 200; and the phone hides any editor
  whose action `writes` doesn't list. Caps are on growth only
  (lib/item-edit.ts), so an edit never cuts what is stored.
- **Delete is to the Trash**, as on the web: `deleteItem` stamps
  `deleted_at`, the web's Trash restores for 30 days, and a delete of an item
  already there answers 200.
- **A new subtask is created as the web creates it**: `createItem` with
  `{notify:false}`, a `task` with capture's `order` (`nextTaskOrder`, the
  web's `tasks.length`), one write per subtask. So the lines of a paste tie on
  `order` and keep paste order by `created_at`, unlike the web's one-INSERT
  `addTasksBulk`, which writes base+i. The parent is read again after the
  insert, and a parent deleted in between sends the child to the Trash too
  and answers 409 `parent_gone`.
- **Reset streak writes `streak` alone**, as `resetHabitStreak` does: never
  `completedDates` or `dailyCounts`, and nothing at all at 0.
- **A reminder writes its two columns together**, as the dialog does
  (`reminderPatch`): a time with the cue words trimmed, or off with both
  cleared, and a time sent alone keeps the stored words. Never
  `reminder_sent_key`, so a new time re-arms itself, and never a snooze.
- **A time edit writes as the dialog's Time chip does** (`timeEditPatch`,
  `commitEdit` over the keys sent): one `updateItem` where the web makes up to
  two, the same end row. A part of day picked away from the stored one
  releases a project block (`scheduleTaskPatch`); a new time alone keeps the
  item in its block, its bucket auto-corrected. Never the date: the Date chip
  is `move`.
- **A repeat writes its three keys together**, as the dialog does
  (`repeatPatch`): the days only with Custom days and the day only with
  Monthly, nothing when the item already says it, and never the date, the
  status or the streak. Then it demotes any goal role the new rule left
  untrue (lib/goal-roles.ts, which the agent PATCH runs too), on the user's
  client; a failure there is logged, and the write still answers 200. An
  open web tab doesn't hear of it, and its next membership write puts the
  role back, as after an agent PATCH (memory/plans/long-term-goals.md,
  decision 3 and its 2e ledger line). No repeat on a task whose series
  started before today leaves it a one-off on that first day, as the web's
  panel does; the phone has no overdue tray, so it shows on no list until it
  is given a new day (Search finds it).
- **The live Beeminder post** (`reportLiveCompletion`) runs after every
  `set_item_completion`, as the browser's `reportCompletion` does after a
  tick and `/api/reminders/act` after its own: through `after()` once the
  response is sent, with a service client that scopes the report by user. The
  nightly settlement stays the backstop.
- **A project edit names the project by id**, and the route files the item
  under that project's own name (`projectRefilePatch`, the bulk Move to
  project's rule): nothing when the item is already there by folded name and
  id, a link repair when only the id is stale, and a parked task released from
  the block it leaves. A project in the Trash or gone is `project_gone`. Never
  `group`.
- **A container's own fields are one intent at a time** (O8a, POST
  /api/app/containers/:kind/:id): a routine's `pause` through
  `resolvePauseWrite`, the item pause's rule, and a season's `state` as
  picked, each read live first (a routine or season in the Trash, another
  user's, or a malformed id is 404) and written through `updateRoutine` /
  `updateSeason` only when it changes something, so a retry of a landed
  write answers 200 and writes nothing. No webhook, no `item_events`, as the
  web writes none for these. On a routine not paused today, a Pause until no
  longer after today is 409 `pause_refused` (on one already paused, the route
  takes the day, as `resolvePauseWrite` does); the phone refuses such a day
  locally before sending. The route takes the write with Organize off, as
  the web's own Paused and container menu do.
  From O8b and O9 the same route takes every field a page edits: a goal's
  `state` (`resolveGoalStateWrite`), `usualTime`, `dates`, `window`,
  `notes` or `why`, and on every kind `rename`, `icon` and `color`. Every
  field intent but the two states writes its value again when it already
  has it, so a retry is harmless. A project rename re-files the project's
  members by `projectId` after it renames (`renameProject`, every time, so
  a retry whose first answer was lost still re-files), and a name another
  live project folds to is 409 `name_taken`, one a trashed project holds
  exactly `name_in_trash`.
  From O10 it takes `delete`: the row goes to the Trash and nothing else is
  written; one already there answers 200 and keeps its 30 days, and one
  that isn't there at all is 404 `not_found`, which the phone counts as
  landed. From O11, `POST /api/app/containers/:kind` creates one from the
  phone's own id (`{id, name, icon?}`, and a goal's `startsOn?`, strict):
  an id it already has, live or in the Trash, answers 200 and writes
  nothing, so a retry is harmless, and a project's name clash is the
  rename's two 409s. When the unique key refuses a name, both read the
  folded clash again, so a live project that took the name in between is
  `name_taken`, never the Trash's sentence. Neither
  reads `user_extensions`, writes a webhook or an `item_events` row.
- **Membership is one row at a time** (`collect`): the route adds or removes
  the one row (lib/db.ts `addContainerMember`, `removeContainerMember`) and
  never takes a list, and the web's own whole-list writes carry the list they
  last knew (`reconcileMembership`'s `known`), so a web tab older than a
  phone toggle no longer undoes it. One gap is left and stated: a phone
  removal that lands between a web write's read and its upsert (one round
  trip) is put back by that upsert. A routine or season in the Trash is
  `container_gone`. An add goes last in a routine's order, or, where the
  routine has members with no place, among them by id. The cost of `known`,
  taken (open question 2 of the 2f brief): a web write that failed is no
  longer healed by that tab's next write to the same container, so the tab
  shows the member the database lacks until it reloads.
- **Move to Braindump** (Week and blocks PR 3, design §5.7, §6.2, §7;
  builders' notes in `week/pr3/`): a dated, open, one-off task's ⋯ offers
  it, after Reschedule and before Delete, as the web's row menu and mobile
  sheet offer `unscheduleTask`. The write is `{"action":"unschedule"}` alone
  (strict); the server asks its copy of the web's gate and writes the store's
  `UNSCHEDULE_TASK_PATCH` (not scheduled, no start date, part of day or
  time), 409 `not_unschedulable` for a row the gate refuses and 200 with
  nothing written for one already in the braindump's shape, so a retry
  lands. No webhook, and one `item_events` row, as the browser writes it
  (lib/db.ts `updateItem`); the retry that writes nothing writes no event.
  - The phone's gate (`SamplePlanner.offers(.braindump)`) is three asks and
    `canWrite("unschedule")`: the web's (DsulCore `verbEligible`, through
    `canSendToBraindump`: task-like, a braindump-eligible type, dated, not
    recurring, not in a project block, open on its own date, no goal's
    milestone), the server's (no subtask), and the surfaces' own (design
    B24: `isTaskScheduled`, so a row the braindump already lists, such as a
    dated task with no part of day, never gets it).
  - The milestones are `SamplePlanner.milestoneIds`, DsulCore
    `milestoneItemIds` over the payload's `goals`, whatever the Goals switch
    and a goal's state say, as the web reads the store's raw goals. Nil while
    goals are unread (before the first fetch, or a server that sends none),
    and then the verb is offered nowhere. The sample knows its goals.
  - The step, `SamplePlanner.unschedule(_:on:)`, asks the gate again off the
    item as it is now, applies DsulCore `unscheduling` (the same four
    columns; length, order, project, priority, notes, subtasks and any pause
    kept, so it shows in the braindump at its stored place) and queues
    `PlannerSync.Write.unschedule(id:)`, which names the item alone, proves
    nothing and replays through `unscheduling` (dateless). The sheet stays
    up on the item, now a braindump row. Its symbol is
    `tray.and.arrow.down`; its words are the port's `verbLabel`.
  - Where it departs from the design: the design says main's payload has no
    goals, but it has carried them since O1, so the verb shows signed in
    from this PR, with no payload change. Paused today, ⋯ is Delete alone,
    so Move to Braindump waits for Resume like every other verb, though the
    web's gate has no pause test. No VoiceOver announcement follows it ("Moved to
    the braindump" is PR 8's, for its drops). A goal the lossy goal list
    drops takes its milestones with it, so the phone may offer the verb on
    one; the server refuses it, the banner shows and the refetch puts the
    row back.
  - Files: ios/Dsul/Data/PlannerSync.swift, APIClient.swift;
    ios/Dsul/Model/SamplePlanner.swift; ios/Dsul/Item/ItemSheetModel.swift
    (`SheetVerb.braindump`), ItemDetail.swift; DsulCore RowMoves.swift,
    ItemVerbs.swift, VerbWrites.swift, ItemWriteBody.swift, Goals.swift,
    DayItems.swift; hosted tests in PlannerSyncTests, ItemVerbsTests,
    ItemSheetTests, SamplePlannerTests and ItemEditTests.

## Port order
recurrence → `isPausedOn` / `isOpenLoopOn` → `isItemActiveOn` →
`deriveDayItems` → completion toggles: all done by PR 3, with
`deriveTimedEntries`, braindump membership and routine grouping. The habit
streak stays an opaque stored counter. Item detail ports `lib/item-verbs.ts`'s
gates, labels and details (its `run`s stay the web's; the phone's optimistic
steps are `VerbWrites.swift`, checked against the real store), and part 2
`lib/item-edit.ts` with the store's delete, new subtask and streak reset
(`ItemEdit.swift`), and `lib/bulk-add.ts`'s line splitting (`BulkLines.swift`),
all checked against `edit-writes.json`. Shared JSON fixtures:
Vitest runs the real TS and writes cases and expected results
(`tests/fixtures/recurrence/`, `tests/fixtures/day/`, and
`tests/fixtures/app/planner-response.json` for the payload), DsulCore's tests
read the same files, and CI fails when they disagree. ios.yml's `changes`
filter includes every mirrored TS file and the app routes, so a web edit
re-runs the Swift tests.

## Dropping a block
Week and blocks PRs 7 and 11 of `ios-app/week-and-blocks/design.md` (§5.5,
§6.1, Q3), shipped as one PR; the builders' notes are in `week/pr7/`. What
dropping a schedule block somewhere does is written once, in TS, and both
clients ask it: the web's drops from this PR, the phone's from PR 8
(Moving a block, above).

- **The rule.** `planBlockDrop(item, from, target, ctx)` in
  `lib/block-moves.ts`, pure, keyed on the registry's `dateAnchored` (for a
  custom item, its slug's) and on whether the item repeats, never on task vs
  habit (B21). `from` is the day the block was drawn on and whether that
  occurrence is skipped; the target is an hour (`startMin` on a day), a
  day's Anytime or the braindump; `ctx` holds the goals' milestone ids, null
  while unknown. It answers an end state, never a write: `place {date,
  startMin}`, `retime {startMin}` (its date untouched), `anytime {date}`
  (null keeps its date), `braindump`, `pause`, `none` (already there) or
  `refused` with a reason (`skipped`, `in-block`, `another-day`,
  `not-braindump`, `milestones-unknown`, `not-pausable`, `invalid`).
  - A skipped occurrence is refused wherever it lands.
  - An hour: a one-off (or a series with no start date, or one still in
    the braindump, which is not a block yet) is placed on the hour's day. A
    dated series on the canvas and a type with no date are retimed on their
    own days, whatever column took the drop (B7, B18), except a dated series
    in a project block, which is placed on its own start date so the move
    releases it.
  - Anytime: refused for a task in a project block. What may not change its
    date takes only its own day's Anytime (`another-day` otherwise); a dated
    one-off moves to that day's.
  - The braindump: a row it already lists stays (`none`, B24; a let-go row
    is not listed); a type with no date pauses where the registry lets it; a
    dated row goes back only where PR 3's `canSendToBraindump` takes it (B16,
    B19), with the verb's and the server's checks beside it (a start date,
    not a subtask), so never a series, a done or let-go task, one in a
    project block, a goal's milestone, an undated row or a subtask.
- **Pinned.** `tests/unit/block-moves.test.ts`, and
  `tests/fixtures/day/block-moves.json` (153 cases written from the real TS
  by `block-moves-fixtures.test.ts`: seventeen items by seven targets, then
  skipped origins, unknown or empty milestones, the minute edges, four rows
  stored just off their own place, and twelve for branches the items leave
  out: a stash under Anytime, a habit with no part of day, a let-go,
  undated or subtask row on the braindump, and a series still in the
  braindump).
  DsulCore `BlockMoves.swift` ports it (`planBlockDrop(_:from:target:context:)`,
  `startTimeOf`, `BlockOrigin`, `BlockTarget`, `BlockDropContext`,
  `BlockDrop`, `BlockDropRefusal`), checked by `BlockMovesFixtureTests`,
  which also asks every custom row again as a task and every retime from
  other columns. ios.yml's filter gains `block-moves`.
- **The web follows it (PR 11; Kirby's Q3, Match iPhone, 2026-10-24).**
  `resolveDrop` (lib/dnd/handle-drag-end.ts) asks it for a task on the
  canvas dropped on `hour:`, `weekhour:` or `sidebar`, and maps each answer
  to the store call that writes the same row: `place` and `retime` are
  `scheduleTask` with and without the date, `braindump` is
  `unscheduleTask`, `none` and a refusal write nothing. A move that keeps
  its date carries the day it was let go on (`landsOn`), so the undo toast's
  "hidden where it landed" receipt is judged there, not on the series'
  anchor. `sidebarDropPlan` asks it of each task in a selection dropped on
  the braindump, and says what the group writes (`rewrite`). So on the
  web a repeating task's block dropped on a new time keeps its start date,
  and every earlier day keeps its occurrence; a repeating, done, let-go,
  in-block or milestone task dropped on the braindump stays where it was; a
  placed habit dropped there still pauses; and every other drop ends in the
  row it did before. lib/dnd/CONTRACT.md's table says which ids ask.
- **How the phone maps it (PR 8).** `place` sends `schedule {date,
  startTime}`; `retime` sends `time {timeBucket, startTime}` with the hour's
  part of day, which never carries the date (M1); `anytime` with a null date
  sends `time {timeBucket: "anytime", startTime: null}`; `braindump` sends
  PR 3's `unschedule`. Two answers the web takes are refused on the phone in
  v1, by that mapping and not by the rule: `pause` (B15: the phone's
  braindump never lists a paused habit) and `anytime` with a day (B22:
  another column's Anytime would be two writes that can land half). The
  context is `BlockDropContext(milestoneIds: planner.milestoneIds)`, the set
  Move to Braindump already reads.
- **Where it departs from the design.**
  - The web's Anytime strips (`unscheduled:anytime`, `week:{date}:anytime`)
    don't ask the rule yet, though PR 11's file list names the week's: they
    share their ids with the Buckets cells, where the rule would refuse
    drops that write today (an in-block one-off's, and a series' on another
    day). So a series dropped on the web's Anytime still takes that day as
    its start date.
  - A group dropped on an hour still takes the selected day's date, a
    series' included, since groups were to stay as they were. A group
    dropped on the braindump does ask the rule and leaves out what it
    refuses ("the group path asks the same gate").
  - A let-go task dropped on the braindump stays put as well: the gate's
    "open on its date" refuses it as it refuses a done one.
  - A selection dropped on the braindump whose only canvas tasks are ones
    the rule keeps, with no habit to pause, writes nothing and falls through
    to the dragged row alone, as a refused single drop does, rather than
    rewriting the braindump rows in it with nothing landing.
  - A series still in the braindump is not a block: an hour places it on
    that day and another day's Anytime moves it there, as the web's
    braindump-to-grid drop does (the web itself never asks the rule for a
    braindump row). The braindump answer also asks for a start date and no
    subtask, as Move to Braindump's verb and the server's `unschedule` do.
  - On the web `none` now writes nothing, where it was a schedule to the
    same place with an undo entry; the row is the same.
  - The skip is an input (`from.skipped`): the client knows it drew a
    skipped strip. In the Swift, dates stay strings (a legacy ISO start date
    has to compare as the web's does) and minutes are an `Int`.
- **Files.** lib/block-moves.ts; lib/dnd/handle-drag-end.ts,
  lib/dnd/sidebar-drop.ts and CONTRACT.md; lib/planner-store.ts
  (`scheduleTask`'s `landsOn`); components/shell/app-shell.tsx;
  components/sidebar/braindump.tsx (its landing preview lights only what the
  drop would send back); DsulCore BlockMoves.swift; tests block-moves,
  block-moves-fixtures, block-drop-receipt, handle-drag-end, sidebar-drop,
  braindump-landing and ios-change-filter, the e2e dnd spec's braindump
  refusal, and BlockMovesFixtureTests; .github/workflows/ios.yml. The app's
  side is PR 8's (Moving a block, above).

## The drag spike
The braindump sheet (detents `.peek` = 96pt, `.medium`, `.large`; background
interaction up through `.medium`) sits over the Schedule grid. Rows use the
system drag (`draggable(containerItemID:)` in a `dragContainer` of `ItemRef`,
an in-app-only id payload). The grid's 24-hour content is the drop target, so
drop locations are already in content space, and `snappedStart` gives the
15-minute ghost. A drag that starts at `.large` drops the sheet to `.medium`
(a dimmed grid can't take a drop), and to `.peek` once the finger leaves the
sheet. The bottom edge of the grid sits under the sheet, so a CADisplayLink
autoscrolls it by hand; the top edge is the system's.

Unverified until it runs on a phone: that a drop reaches the grid behind an
undimmed sheet, that changing the detent mid-drag doesn't cancel the drag, and
how often drop updates fire. The probe HUD (Drag probe, in the avatar menu on Today) shows
the readings; ios/README.md lists the five pass/fail checks.

**Fallback if checks 1 or 2 fail:** one `UILongPressGestureRecognizer`
(through `UIGestureRecognizerRepresentable`) on the sheet's root, a drag chip
drawn in a pass-through `UIWindow` above the sheet, and the same snap, ghost
and autoscroll. It works at any detent, at the cost of the system lift and drop
animations.

## Not yet
Density (`DensityMetrics`), swipe actions on rows, the zoom transition
from the bar to the braindump sheet, the rest of Organize (a project's
time block stays the web's), undo right after a delete, an item's
or a container's (Organize's Trash restores either, O14),
Change type, Duplicate and Copy link, the rest of the sheet
(a routine's or a season's hold, the goal chip, which goals in the payload
since O1 make possible, and any word that a repeat took a goal role away (the
web then lists the item as a plain member, with no notice), the Beeminder row,
the Streaks, Organize and Goals switches, which the phone honours but can't
turn on or off, the thread and Ask, Focus), universal links (the email link
uses the custom scheme), two block drops
the web takes and the phone refuses in v1 (a habit dropped on the braindump,
which the web pauses, B15, and a block dropped on another day's Anytime,
B22: both answer the forbidden badge), undo after a move, the overdue tray,
sinking completed rows, filters and `showPausedOnGrid` (the phone uses the
defaults), Focus as a Live Activity,
and a local-stack password grant for development. App Store review will also
want consent before sending data to a model. Notifications shipped
(#446 to #524: the phone plans and arms its own, stores its time zone,
registers as a device and is woken by APNs); what is left of them is in
[reminders-platforms.md](reminders-platforms.md).

The blocks are drawn in the web's look and laid out by its overlap pass (PRs
4 to 6, Schedule blocks above), they move (PR 8, Moving a block above): the
block's menu, VoiceOver's 15-minute actions, and the Anytime band as a drop
target with its rows as drag sources; they change length (PR 9, Changing a
length above): Change length in the block's menu, two grips, and VoiceOver's
length actions; and Week × Schedule draws them in three swiped day columns
(PR 10, Week above). The grip's UIKit fallback waits on device check R1, and
the sideways autoscroll's switch on W-S3.
