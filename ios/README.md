# dsul for iPhone

A native SwiftUI app (iOS 27). This first version is a shell around the drag
spike: the Today tab's Schedule grid with the braindump sheet over it, on
sample data. It doesn't sign in or talk to the server yet.

- `Dsul/` is the app. `DsulTests/` tests it in the simulator.
- `DsulCore/` is a Swift package with the planner logic ported from the web
  app (`lib/recurrence.ts` first). It has no UI, so `swift test` runs it on
  Linux as well as macOS.
- `project.yml` describes the Xcode project. XcodeGen generates
  `Dsul.xcodeproj` from it; the generated project is never committed.

## On your Mac

Once:
1. Install Xcode 27 (it needs macOS 26.6 or later) and open it once.
2. In Xcode → Settings → Accounts, sign in with your developer Apple ID.
3. `brew install xcodegen`, then check `xcodegen --version` says 2.46.0 or
   later (CI uses 2.46.0).
4. On the iPhone: Settings → Privacy & Security → Developer Mode → On.

Each time:
```bash
cd ios
xcodegen generate      # again after every pull that changes project.yml or adds files
open Dsul.xcodeproj
```
Then in Xcode: pick the **Dsul** target → Signing & Capabilities → Team =
your team (once), choose your iPhone as the run destination, and press ⌘R.

## Trying the drag

1. On Today, tap the tray button (top right) to open the braindump.
2. Tap the waveform button (top left) to show the probe readings.
3. Long-press a braindump row and drag it up onto an hour.

The spike passes if:
1. A drop lands on the grid with the sheet at medium and at its small size.
2. The sheet shrinking mid-drag doesn't cancel the drag.
3. The ghost keeps up with your finger (the probe shows about 30 updates a
   second or more).
4. Holding a finger just above the sheet scrolls the grid down, and the ghost
   follows.
5. With "Load 40 blocks", nothing stutters.

If 1 or 2 fails, the next version swaps the system drag for a custom one (see
memory/plans/ios-app.md).

## Rules

- Never commit `Dsul.xcodeproj`. It's generated.
- Never run pnpm in `ios/`; it isn't part of the web app's workspace.
- A Swift file that ports a TypeScript file cites it. Changing the TypeScript
  without the Swift is drift: the phone and the web would disagree.
- CI (`.github/workflows/ios.yml`) builds with signing off on GitHub's
  `xcode-27` runner. The iOS checks aren't required yet, so for a PR touching
  `ios/`, merge only once the iOS workflow is green.
