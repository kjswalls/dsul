# dsul for iPhone

A native SwiftUI app (iOS 27). It signs in with Google and shows your own
day from do.dsul.app; a tick, a drop on an hour and a capture are saved to
the server. "Try with sample data" on the sign-in screen opens a made-up day
instead, which needs no account and whose changes last until the app quits.

Today shows one day in three layouts: List (filter chips, then sections per
routine and per project), Buckets (Morning, Afternoon, Evening, Anytime) and
Schedule (the hour grid, with the braindump sheet over it). The capsule top
right switches them: tap for the next, swipe along it to step, long-press for
the menu. Tap the title to pick another day. The capture bar above the tab bar
adds thoughts to the braindump; its count opens the braindump over Schedule.

- `Dsul/` is the app. `DsulTests/` tests it in the simulator.
  - `App/`: the app, `AppGate` (sign-in screen, sample or your planner) and
    `AppConfig` (the server's address).
  - `Auth/`: Google sign-in, the tokens and the Keychain.
  - `Data/`: the calls to `/api/app/*` and `PlannerSync`, which sends your
    changes in order and fetches your day.
  - `Model/`, `Today/`, `Schedule/`: the planner and the screens.
- `DsulCore/` is a Swift package with the planner logic ported from the web
  app: which items show on a day, the braindump, routine grouping, what a
  tick means, and the sign-in requests. It has no UI, so `swift test` runs it
  on Linux as well as macOS.
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

## Signing in

**Continue with Google** opens Google in a private sheet (no Safari cookies,
so it never signs in as whoever Safari last was). Afterwards the app shows
"Signed in as …" once and loads your day. Nothing secret lives in `ios/`: the
app asks `https://do.dsul.app/api/app/config` for the Supabase address and its
public key the first time you tap the button, and a signed-out launch makes
no network request at all.

Before the first sign-in on a phone (once, in the Supabase dashboard):
1. **Step 0, Auth → URL Configuration:** Site URL `https://do.dsul.app`, and
   Redirect URLs include `https://do.dsul.app/**`. Without it the Google sheet
   ends on a web page instead of coming back to the app.
2. **Auth → Users:** your user should already have a Google identity, or a
   verified Gmail address Google can link to. Otherwise Google signs in to a
   second, empty account.

The phone talks to production, so it can only sign in once `/auth/ios` and
`/api/app/*` are deployed.

- **Your day** loads when you sign in, again when you come back to the app
  (at most once a minute) and when you pull down on List or Buckets. Nothing
  polls.
- **Writes** show at once and are sent one at a time, in order. If the server
  refuses one, a banner says so and the app reloads your day; if it can't be
  reached at all, the change is undone.
- **The avatar** (your initials, top right) shows your email and **Sign out**.
  Sign out ends this phone's session only; the web and the desktop app stay
  signed in. On the sample, it says **Leave sample data** instead.
- **Debug builds** can point at another server: Edit Scheme → Run →
  Arguments → `-DsulAPIOrigin http://192.168.1.20:3000` (your Mac's address
  on the same Wi-Fi). Release builds always use do.dsul.app. Sign-in then
  goes through whichever Supabase that server's `/api/app/config` names, which
  needs Google set up and that server's `/auth/ios` in its redirect list; a
  local stack from `scripts/local-setup.sh` has neither.

## Trying the drag

On the sign-in screen, tap **Try with sample data**. (It works signed in too,
on your own braindump, but every drop is then saved.)

1. On Today, tap the count at the right of the capture bar ("Get it out of
   your head") to open the braindump over Schedule.
2. Tap the avatar (KI, top right) → Drag probe to show the probe readings.
3. Long-press a braindump row and drag it up onto an hour.

The spike passes if:
1. A drop lands on the grid with the sheet at medium and at its small size.
2. The sheet shrinking mid-drag doesn't cancel the drag.
3. The ghost keeps up with your finger (the probe shows about 30 updates a
   second or more).
4. Holding a finger just above the sheet scrolls the grid down, and the ghost
   follows.
5. With "Load 40 blocks" (in the probe, or the avatar menu), nothing stutters.
   Both buttons show on the sample only: its blocks exist nowhere on the
   server.

If 1 or 2 fails, the next version swaps the system drag for a custom one (see
memory/plans/ios-app.md).

## Rules

- Never commit `Dsul.xcodeproj`. It's generated.
- Never run pnpm in `ios/`; it isn't part of the web app's workspace.
- A Swift file that ports a TypeScript file cites it. Changing the TypeScript
  without the Swift is drift: the phone and the web would disagree.
- No keys, tokens or per-environment URLs under `ios/`. The Supabase address
  and public key come from `/api/app/config`; the tokens live in the Keychain.
- The hosted tests never touch the Keychain or the network: they use an
  in-memory token store and a fake server, and the app keeps tokens in memory
  whenever it runs as a test host.
- CI (`.github/workflows/ios.yml`) builds with signing off on GitHub's
  `xcode-27` runner. The iOS checks aren't required yet, so for a PR touching
  `ios/`, merge only once the iOS workflow is green.
