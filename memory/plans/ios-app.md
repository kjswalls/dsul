# iPhone app (ios/)

Status (2026-10-01): PR 1, the shell and the drag spike, on sample data.
PR 2 builds Today on the G board: List, Buckets and Schedule layouts behind
the up-down capsule beside the avatar, the title as a date picker, and the
capture bar as the tab view's bottom accessory, still on sample data with
local toggles.
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
  Each cites what it mirrors.

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

## Writes go through the server
When the app writes, it calls bearer-auth server routes, never Supabase
directly. The web's writes run side effects in the browser (`notifyPlugins`,
the live Beeminder post `reportCompletion`, `recordItemEvent`), and a direct
write would silently skip them. The routes accept cookies only today.

## Port order
recurrence (done) → `isPausedOn` / `isOpenLoopOn` → `isItemActiveOn` →
`deriveDayItems` → completion toggles. The habit streak stays an opaque stored
counter. `lib/item-verbs.ts` needs a store-free split before it can be ported.
PR 2 adds shared JSON fixtures: Vitest writes cases and expected results,
DsulCore's tests read the same files, and CI fails when they disagree.

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
from the bar to the braindump sheet, item detail, sign-in (Apple, Google, email link via universal
links), notifications, Focus as a Live Activity, and the web-side work the app
needs (bearer auth, a native push channel, Sign in with Apple on the web).
App Store review will also want in-app account deletion and consent before
sending data to a model.
