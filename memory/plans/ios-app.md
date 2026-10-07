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
together.
Item detail, part 1 adds the item sheet, opened from every surface: what the
item is (read-only) and its verbs, with three more writes (skip, move, pause)
on the same route. Part 2 makes it editable, in seven PRs; the first (2a) edits
the title and the notes and adds Delete, with three more writes (title, notes,
delete), and replaces PlannerSync's slots with a rebase per subject.
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
  app/auth/ios/route.ts).
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
  `setItemsCollected`) in `Membership.swift`.
  Each cites what it mirrors.
- `ios/Dsul/App`: `DsulApp` (one `AuthStore`), `AppGate` (sign-in screen,
  sample or the user's planner, keyed on `AuthStore.gateKey`), `AppConfig`.
  `ios/Dsul/Auth`: `AuthStore`, `TokenStore` (Keychain, or memory in tests),
  `SignInView`. `ios/Dsul/Data`: `APIClient`, `PlannerSync`.
  `ios/Dsul/Item`: the item sheet (`ItemSheet`, `ItemDetail`, `VerbBar`,
  `ChipFlow`, `StreakChip`, `DayPickSheet`, and from part 2 `TitleField`,
  `NotesEditor`, `SubtaskField` and `StreakPopover`, and from 2c `Editors/`:
  `PropertyMenus` and `ReminderSheet`, which 2d joins with `TimeSheet` and
  `ClockWheel`, the wheel both sheets share, and 2e with `RepeatSheet`) and
  `ItemSheetModel`, which decides what it says and offers apart from the
  views.
  `SamplePlanner` keeps its name for the views, but holds `[Item]` and asks
  DsulCore what shows; `SampleData` builds the sample.

## Today (PR 2)
- **G over F, provisionally.** The capsule is a `ToolbarItem(.topBarTrailing)`
  beside the avatar: a plain view, not a `Menu` (a menu's tap and a swipe on
  it either never both fire or double-step). A tap steps to the next layout,
  a swipe in either axis steps with `.sensoryFeedback(.selection)` and wins
  outright over the tap (`exclusively(before:)`), long press opens the full
  menu as a context menu (Layout, and Show with Day only until Week exists),
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
  "Now" are `Color.accentColor`; its text controls tint themselves in the
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
  whose container is required), then the projects in payload order with the
  phone's dots, the current one checked by folded name; a name with no
  project checks nothing, and a stored "none" (pre-#373 habits) reads as no
  project, as the web's dialog reads it. A pick writes at once and No project
  takes the chip away. Add property's Project ▸ lists the projects, with at
  least one. Gated as `editAllowed(action: "project")` (not a subtask, a
  type with the project axis). A task parked in its old project's block
  leaves it, its own time and day back and the block's part of day kept, as
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
  season, Autumn (Journal), and an empty routine, Wind down. No New routine,
  New season or Organize on the phone.
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
- Sign in with Apple and universal links wait for a later PR; the email link
  is the next section.

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
Week, density (`DensityMetrics`), swipe actions on rows, the zoom transition
from the bar to the braindump sheet, creating a project from the phone (the
web's New Project), creating a routine or season from the phone, the
Organize console, undo or restore after a delete (the web's Trash restores it),
Change type, Duplicate and Copy link, the rest of
the sheet (a routine's or a season's hold, the goal chip once goals are in
the payload, and any word that a repeat took a goal role away (the web then
lists the item as a plain member, with no notice), the Beeminder row, the
Streaks switch, which the
phone honours, in the sheet and on Today's rows, but can't turn on or off,
the thread and Ask, Focus), sign-in with Apple,
universal links (the email link uses the custom scheme), unschedule, resize
and moving existing blocks from the phone, the overdue tray, sinking completed rows,
filters and `showPausedOnGrid` (the phone uses the defaults), syncing the
timezone from the phone, notifications, Focus as a Live Activity, a
local-stack password grant for development, and the web-side work the app
still needs (a native push channel). Sign in with Apple is live on the web, and
memory/plans/sign-in-with-apple.md says what the phone's native flow needs. App Store
review will also want in-app account deletion and consent before sending data
to a model. Notifications, the timezone write and the native push channel are
planned in [reminders-platforms.md](reminders-platforms.md) (§2.3 and its
Phase 2: local `UNUserNotificationCenter` triggers computed by a DsulCore port
of `lib/reminders/plan.ts`; APNs follows in its Phase 3 on the paid team Kirby
already holds).
