# iOS stack for dsul (2026-09-29)

**Update 2026-09-29: Kirby has a Mac and an Apple developer account, so the recommendation is now SwiftUI.** The only things Expo had over it were no Mac and no fee, and neither applies now. SwiftUI gets the last 10% of native feel: glass morphing, Maps-style sheets, real swipe actions, and C's drag from the sheet onto the grid. The cost is that the shared logic (item registry, "is this active today", recurrence) has to be ported to Swift and kept in step with the web app. Building and running happen on Kirby's Mac through Remote Control, because cloud threads can't compile Swift.

Original recommendation, for a setup without a Mac: Expo (React Native) with expo-router native tabs.

| Option | Feels native | Needs a Mac | Reuses web code | Cost |
|---|---|---|---|---|
| **Expo / React Native** | Yes: real iOS tab bar with Liquid Glass (`expo-router/native-tabs`), native sheets with detents, real SwiftUI menus/pickers via `@expo/ui` | No: EAS builds iOS in the cloud; Expo Go runs it on your iPhone | Yes: TypeScript, `@dsul/types`, Zustand store logic, supabase-js | $0 to start (Expo Go). $99/yr Apple Developer Program once you want a dev build, TestFlight or the App Store. EAS free plan has a small monthly build quota (exact number unconfirmed, check expo.dev/pricing) |
| SwiftUI | The most native (glass morphing, Maps-style sheets, drag across a sheet) | Yes. Xcode is macOS-only; Xcode Cloud gives 25 free hours/month but is set up from Xcode | No: rewrite in Swift (supabase-swift exists) | $99/yr plus a Mac |
| Capacitor (wrap the PWA) | No: web controls in a web view | Yes, for Xcode | All of it | $99/yr plus a Mac |

Trade-off to know: in Expo, a native sheet is a separate screen, so direction C's "drag a braindump item from the sheet onto an hour" can't cross from a native sheet to the grid. Either use a JS sheet there (loses some native feel) or redesign it as long-press, then Schedule, then place. Everything else in A, B and C builds natively in Expo.

Sources checked: docs.expo.dev (native tabs, @expo/ui, billing), developer.apple.com (program fee, Xcode Cloud hours), Supabase Expo guide.

## Build notes for the combined direction (D), SwiftUI on iOS 26
- Braindump bar: `.tabViewBottomAccessory`, drawn as a button that looks like a field (a real TextField there gets caught under the keyboard). Tapping it opens a small capture sheet with the field focused. Also design the `.inline` placement for when the tab bar minimizes.
- Braindump sheet: `.sheet` with detents `[.height(96), .medium, .large]` and `.presentationBackgroundInteraction(.enabled(upThrough: .medium))`. It opens by a swipe on the bar or a tap on the count, with a zoom transition from the bar. It always opens over Schedule.
- Drag onto an hour: iOS 26 drag APIs (`.draggable(containerItemID:)`, `.onDragSessionUpdated` to drop the sheet to its small detent). On the grid, a `DropDelegate` for a live, 15-minute-snapped ghost, and manual edge autoscroll. This is the riskiest interaction, so prototype it first.
- Density: one row view and one list. A `DensityMetrics` environment value changes only spacing, insets and list style, never features. Snapshot-test both densities from the same data.
- Today's layouts (E boards): `.toolbarTitleMenu` on the Today title, with one Picker for List / Buckets / Schedule and a second for Day / Week, plus Go to date. You can hold and slide on native menus, which is the Linear gesture. Don't attach gestures to TabView items or the search tab: iOS 26 doesn't pass them through.
- Tabs: Today, Ask, Organize, plus the `.search` role tab. Hide the braindump bar on Ask with `tabViewBottomAccessory(isEnabled:)` (iOS 26.1).
- Up-down layout capsule (F board): our own view inside `tabViewBottomAccessory`, next to the capture field. A vertical `DragGesture` steps through List, Buckets and Schedule with `.sensoryFeedback(.selection)`. It's wrapped in a `Menu` with a `primaryAction` so a long-press opens the full menu. It's exposed to VoiceOver as `.accessibilityAdjustableAction`. It works because the accessory is app-owned; tab items aren't.
- Top-row variant (G board): the same capsule as a `ToolbarItem(placement: .topBarTrailing)` custom view; toolbar items keep their gestures. The title's tap opens a date picker.

## H boards (2026-09-30): item detail, notifications, sign-in

- Item detail is a sheet (detents medium/large) with property chips, subtasks, the item's thread and a verb bar. Verbs come from lib/item-verbs.ts so the phone and web agree on what each type allows.
- Notifications use the copy in lib/reminders/copy.ts and the same Done / Snooze 15m actions as the web push (UNNotificationCategory; actions call /api/reminders/act).
- Focus is new: an ActivityKit Live Activity (Lock Screen + Dynamic Island) started from an item, with App Intents for Done, +15 min, End focus. Nothing on the web backs it yet.
- Sign in with Apple is new on both web and iOS (guideline 4.8, because Google is offered): Supabase's Apple provider. The email link needs universal links (Associated Domains on do.dsul.app) and a native redirect URL so it opens the app, not Safari.
- First run: density, then reminders / morning check / evening review, all off (turning reminders on is what asks iOS for permission), then optional model setup.

## Stack pick revised (2026-09-30): Expo

Kirby's clawboy-expo chat (github.com/kjswalls/clawboy-expo) was judged solid enough to build on by the App AI vision thread: 124 test files, typecheck and lint; src/components/input has no OpenClaw imports; about 5 of the 46 chat components use the live connection. Reuse means a neutral message type, the connection passed in as props, and a new data hook against dsul's API in place of useChat.ts, which is tied to OpenClaw. AI cards use the [clawboy-options] format (type-your-own on by default), shared with the web app.

So the pick is now Expo: the chat plus the web app's TypeScript item logic carry over. Native feel comes from Expo UI's SwiftUI views (glass, menus, sheets) where it matters. The drag from the braindump sheet onto an hour is a custom Swift module and still the riskiest piece. The mockups don't change. SwiftUI remains the option if feel matters more than reuse. Waiting on Kirby.

## Expo vs SwiftUI comparison (2026-10-01, partial)
See expo-vs-swiftui.md. Only the drag/grid area is fact-checked so far; the stack is not decided. One correction to the build notes above: `.draggable(containerItemID:)` and `.onDragSessionUpdated` are iOS 27 on iPhone, not iOS 26 (iOS 26 has `.onDrag`, `dropDestination`, `DropDelegate.dropUpdated`). iOS 27 shipped 2026-09-14 and supports every iOS 26 device.

## Stack decided (2026-10-01): SwiftUI
Kirby picked SwiftUI once the fact-check (end of expo-vs-swiftui.md) found nothing big against it. Compile and test on free GitHub macOS runners; device runs and signing on Kirby's Mac through Remote Control. The app lives in the dsul repo under ios/. iOS writes go through server routes with bearer auth, not straight to Supabase, so webhooks and the live Beeminder post still fire. Shared JSON test cases run through the TypeScript and the Swift logic in CI. Open: Xcode 27 needs an Apple silicon Mac on macOS 26.6+ (unverified); asked Kirby for his Mac model.
