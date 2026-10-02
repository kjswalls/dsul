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
on the same route. Part 2 makes it editable (see Not yet).
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
  Each cites what it mirrors.
- `ios/Dsul/App`: `DsulApp` (one `AuthStore`), `AppGate` (sign-in screen,
  sample or the user's planner, keyed on `AuthStore.gateKey`), `AppConfig`.
  `ios/Dsul/Auth`: `AuthStore`, `TokenStore` (Keychain, or memory in tests),
  `SignInView`. `ios/Dsul/Data`: `APIClient`, `PlannerSync`.
  `ios/Dsul/Item`: the item sheet (`ItemSheet`, `ItemDetail`, `VerbBar`,
  `ChipFlow`, `StreakChip`, `DayPickSheet`) and `ItemSheetModel`, which
  decides what it says and offers apart from the views.
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
  so over the sheet it came from. It stays open after a verb, as the web's
  panel does, and closes when a fetch no longer has its item (`apply` and
  `restore` clear the slot).
- **Which day.** `SheetDay` is kept by name and read when a verb is tapped
  (`actingDay`): `.selected` from Today's surfaces, so a sheet acts on the day
  its row was drawn on; `.today` from Search, which has no day (`open` first
  brings `today` up to the clock). The tick, Skip and Unskip act on it; Pause
  and Resume read wall-clock today in the planner's zone. Off today the bar
  drops " today" from its words and a caption names the day ("For Thu,
  Oct 8"); on a day a recurring item doesn't fall on (`occurrenceOn` is
  `absent`) a "Not due Sat, Oct 3" line takes the bar's place.
- **The bar** follows the approved item-conversations table (Round 3), up to
  three slots:

  | Item | Bar | ⋯ |
  |---|---|---|
  | Paused today | Resume | – |
  | Habit | Skip / Unskip today, Pause, Pause until (its tick is the title's circle) | – |
  | One-off task-like | Done, Tomorrow (Next day when it lands later), Reschedule | Pause, Pause until… |
  | Recurring task-like | Done today, Skip / Unskip today, Pause | Pause until…, Reschedule |
  | Subtask | Done | – |

  Only what `SamplePlanner.offers` allows shows: the web's gate
  (`verbEligible`), the server's own where it asks more (no skip or carry for
  a subtask; `isPausable`), and the server's `writes`. A verb and its opposite
  share a slot, so VoiceOver's focus stays put. A series takes Reschedule but
  not Tomorrow (lib/row-moves.ts `canReschedule`, #375): the picked day
  becomes its start, so it waits behind ⋯. Reschedule is a menu (Today,
  Next week by Week starts on, Pick a date…); Pick a date and Pause until open
  `DayPickSheet`, nested in the sheet and never the planner's slot, which
  writes only on its confirm button ("Move to Thu, Oct 8"); Pause until starts
  tomorrow. The mapping lives in `ItemSheetModel`, pinned by ItemSheetTests,
  and every verb re-reads its item and asks its gate again before it writes.
- **The chips** are read-only in part 1 and follow the web panel's order, each
  only when set, each asked of the registry (`caps`), never the type's name:
  the streak chip first for a type that keeps one (flame, count, this week's
  seven days by Week starts on); priority | date ("Today", else "Thu, Oct 8"),
  time ("9:00–11:00 am" in the user's 12h or 24h, else the bucket, never
  Anytime), times a day (above 1), repeat (`cadenceLabel`), reminder ("After
  I pour my coffee · 8:00 am") | project (with its colour dot), routines,
  seasons. The planner payload gained `weekStartDay` and `timeFormat` for
  them. Only the item's own pause shows ("Paused until Oct 8").
- **Opening, and VoiceOver.** A row is two buttons: the circle, hit over 44pt
  around its 22pt drawing so a near miss still ticks, and the rest, which
  opens. To VoiceOver it is one element ("Draft Q4 roadmap, 9 to 11 AM",
  "Done" as its value, the hint "Opens details") whose activation opens, with
  Mark done as a named action. The skipped strip opens too (the only way to
  Unskip). A grid block is a button over the drop target; a braindump row
  opens on a tap gesture, so its long press stays the system drag, and keeps
  its "Schedule at 9:00" action. Each chip is its own element with a spoken
  label; the streak chip is one ("Streak 41; this week: 3 done").
- **Lime.** The sheet sets no tint of its own, because the done tick and
  "Now" are `Color.accentColor`; its text controls tint themselves in the
  label colour, and anything lime presses by scaling (`PressScaleStyle`),
  never `.plain`'s fade. The banner dropped `.plain` for the same reason.
- **The writes.** `POST /api/app/items/:id` takes `skip` (a date and
  `skipped`), `move` (a date, which the phone picks: `nextDayOf`, Today, Next
  week or the picked day) and `pause` (`paused`, an optional exclusive
  `pausedUntil`, and the device's zone for an account with none stored), each
  doing what the web's store action does (`setItemSkipped`, `moveTaskToDate`,
  `setItemPaused` through lib/item-pause.ts) behind the server's copy of its
  gate. The payload's `writes` lists the intents the server takes; absent (an
  older server) means `complete` and `schedule`, and the phone hides any verb
  whose write isn't listed, so an app that ships before the deploy never
  offers a write it would be refused. In PlannerSync each write has a slot (a
  day for `complete` and `skip`, placement for `schedule` and `move`, the
  pause, a capture): a failed write is moot only if a later one in the same
  slot landed, and the revert puts back only its own fields.
- **Unproven on a device:** the checks in ios/README.md, "Checking the item
  sheet" (a near miss still ticks, a block doesn't swallow a drop, a
  braindump tap versus long press, each verb, VoiceOver, the largest text
  size, the lime).

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
  routines, seasons, five settings and the `writes` it takes,
  `completedDates` windowed to 400 days), `POST /api/app/items` (capture,
  under the phone's own lowercase id, so a retry is answered 200 for the same
  row) and `POST /api/app/items/:id` (`complete` with a date, an end state and
  a counted habit's tally, `schedule` with a date and `HH:mm`, or the item
  sheet's `skip`, `move` and `pause`, above). Bearer Supabase access token only;
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
  while ticks keep landing under it. A failed write shows a
  banner and refetches once the queue drains; if that refetch fails too, the
  item goes back to its copy from before the write unless a later write for it
  is queued or has landed. A payload for another user is never shown.
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
  `{notify:false}`, and `updateItem` without a `userId`. (Not every server
  write is silent: `/api/reminders/act`'s one-off Done passes the user and
  does fire one.)
- **`item_events`** are written by `createItem`/`updateItem` exactly as the
  web writes them; a recurring tick goes through `set_item_completion` only,
  with no status write and no event, as on the web.
- **The live Beeminder post** (`reportLiveCompletion`) runs after every
  `set_item_completion`, as the browser's `reportCompletion` does after a
  tick and `/api/reminders/act` after its own: through `after()` once the
  response is sent, with a service client that scopes the report by user. The
  nightly settlement stays the backstop.

## Port order
recurrence → `isPausedOn` / `isOpenLoopOn` → `isItemActiveOn` →
`deriveDayItems` → completion toggles: all done by PR 3, with
`deriveTimedEntries`, braindump membership and routine grouping. The habit
streak stays an opaque stored counter. Item detail ports `lib/item-verbs.ts`'s
gates, labels and details (its `run`s stay the web's; the phone's optimistic
steps are `VerbWrites.swift`, checked against the real store). Shared JSON
fixtures:
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
from the bar to the braindump sheet, item detail part 2 (editing the chips,
title and notes; Add a subtask; Reset streak, which Round 5 moves into the
streak chip's popover; Delete), the rest of the sheet (a routine's or a
season's hold, the goal chip once goals are in the payload, the Beeminder
row, the Streaks switch, the thread and Ask, Focus), sign-in with Apple,
universal links (the email link uses the custom scheme), unschedule, resize
and moving existing blocks from the phone, the overdue tray, sinking completed rows,
filters and `showPausedOnGrid` (the phone uses the defaults), syncing the
timezone from the phone, notifications, Focus as a Live Activity, a
local-stack password grant for development, and the web-side work the app
still needs (a native push channel, Sign in with Apple on the web). App Store
review will also want in-app account deletion and consent before sending data
to a model.
