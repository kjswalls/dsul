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
  `setItemsCompleted`) in `lib/planner-store.ts`, minus clearing the day's
  skip, which waits for `skippedDates` on iOS.
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
  Each cites what it mirrors.
- `ios/Dsul/App`: `DsulApp` (one `AuthStore`), `AppGate` (sign-in screen,
  sample or the user's planner, keyed on `AuthStore.gateKey`), `AppConfig`.
  `ios/Dsul/Auth`: `AuthStore`, `TokenStore` (Keychain, or memory in tests),
  `SignInView`. `ios/Dsul/Data`: `APIClient`, `PlannerSync`.
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

## CI
`.github/workflows/ios.yml`, on PRs to main and pushes to main. A `changes`
job decides whether anything iOS changed (`ios/` except Markdown, the
workflow, and the mirrored TS files); the two real jobs skip otherwise, and a
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
  scheme, so the app registers no URL type. Fallback if that hop fails on a
  device: allow-list `app.dsul.ios://auth/callback` and redirect to it
  directly.
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
- Email link, Sign in with Apple and universal links wait for a later PR
  (the email link carries every unverified piece: the Safari/Gmail hand-off,
  a persisted verifier, `.onOpenURL`).

## Data (PR 3)
- **Routes, not tables.** `GET /api/app/planner` (items, projects,
  routines, seasons and three settings, `completedDates` windowed to 400 days),
  `POST /api/app/items` (capture, under the phone's own lowercase id, so a
  retry is answered 200 for the same row) and `POST /api/app/items/:id`
  (`complete` with a date, an end state and a counted habit's tally, or
  `schedule` with a date and `HH:mm`). Bearer Supabase access token only;
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
arrays: a tick sends a date and an end state, never `completedDates`, because
the phone holds a 400-day window and an array written back from a window
deletes what it didn't show.

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
streak stays an opaque stored counter. `lib/item-verbs.ts` needs a store-free
split before it can be ported (skip/unskip, carry). Shared JSON fixtures:
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
from the bar to the braindump sheet, item detail, sign-in with Apple and by
email link (universal links), skip/unskip, unschedule, resize and moving
existing blocks from the phone, the overdue tray, sinking completed rows,
filters and `showPausedOnGrid` (the phone uses the defaults), syncing the
timezone from the phone, notifications, Focus as a Live Activity, a
local-stack password grant for development, and the web-side work the app
still needs (a native push channel, Sign in with Apple on the web). App Store
review will also want in-app account deletion and consent before sending data
to a model.
