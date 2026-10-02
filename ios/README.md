# dsul for iPhone

A native SwiftUI app (iOS 27). It signs in with Google or an emailed link
and shows your own day from do.dsul.app; a tick, a drop on an hour, a capture
and the item sheet's Skip, move (Tomorrow, Reschedule) and Pause are saved to
the server. "Try with sample data" on the sign-in screen opens a made-up day
instead, which needs no account and whose changes last until the app quits.

Today shows one day in three layouts: List (filter chips, then sections per
routine and per project), Buckets (Morning, Afternoon, Evening, Anytime) and
Schedule (the hour grid, with the braindump sheet over it). The capsule top
right switches them: tap for the next, swipe along it to step, long-press for
the menu. Tap the title to pick another day. The capture bar above the tab bar
adds thoughts to the braindump; its count opens the braindump over Schedule.

Tap an item anywhere (a row, a block on the grid, a braindump row, a search
result) to open its sheet: what it is, read-only for now (its notes, its
streak, its chips), and its verbs in a bar along the bottom (tick, Skip,
Tomorrow, Reschedule, Pause, Pause until, Resume, whichever apply). A tap on
a row's circle still just ticks it.

- `Dsul/` is the app. `DsulTests/` tests it in the simulator.
  - `App/`: the app, `AppGate` (sign-in screen, sample or your planner) and
    `AppConfig` (the server's address).
  - `Auth/`: Google and email-link sign-in, the tokens and the Keychain.
  - `Data/`: the calls to `/api/app/*` and `PlannerSync`, which sends your
    changes in order and fetches your day.
  - `Model/`, `Today/`, `Schedule/`: the planner and the screens.
  - `Item/`: the item sheet. `ItemSheetModel` decides what it says and
    offers, apart from the views, so the hosted tests pin it.
- `DsulCore/` is a Swift package with the planner logic ported from the web
  app: which items show on a day, the braindump, routine grouping, what a
  tick means, the item sheet's verbs (when each is offered, what it writes)
  and the words its chips say, and the sign-in requests. It has no UI, so
  `swift test` runs it on Linux as well as macOS.
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

**Email me a sign-in link** asks for your address and sends a link; the
screen then says "Check your email". Open the email on the same iPhone and tap
the link: Safari (or your mail app's browser) opens a dsul page, asks to open
dsul, and the app signs you in. Tap Open only if the prompt names dsul. If
nothing happens, open that page in Safari or tap its Open dsul button.

Send again keeps the same sign-in: if it's refused as too soon, the email
you already have still works; once a new email goes out, only the newest one
does. A link is good for an hour. For an address with no dsul account yet,
open it within about 5 minutes (a slower tap asks for one more link, which
then works at once).

Before the first sign-in on a phone (once, in the Supabase dashboard):
1. **Step 0, Auth → URL Configuration:** Site URL `https://do.dsul.app`, and
   Redirect URLs include `https://do.dsul.app/**`. Without it the Google sheet
   ends on a web page instead of coming back to the app, and an emailed link
   opens the web app instead of the phone.
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
- **The app icon** follows Settings → Look → App icon on the web: pick Lime
  there and the iPhone swaps to the Lime icon the next time it loads your day
  (iOS shows a one-line alert each time an app changes its icon). The web
  tab's Lime-when-the-day-is-done swap stays on the web, since the phone
  would alert every evening.
- **The avatar** (your initials, top right) shows your email and **Sign out**.
  Sign out ends this phone's session only; the web and the desktop app stay
  signed in. On the sample, it says **Leave sample data** instead.
- **Debug builds** can point at another server: Edit Scheme → Run →
  Arguments → `-DsulAPIOrigin http://192.168.1.20:3000` (your Mac's address
  on the same Wi-Fi). Release builds always use do.dsul.app. Sign-in then
  goes through whichever Supabase that server's `/api/app/config` names, which
  needs Google set up and that server's `/auth/ios` in its redirect list; a
  local stack from `scripts/local-setup.sh` has neither.

## Checking the email link

The tests can't open Mail or Safari, so these need your iPhone (after Step 0):
1. Mail, then Safari: tap the link, accept "Open in dsul?", and you're signed
   in with "Signed in as" your address.
2. The same, but decline the prompt, then tap Open dsul on the page.
3. Gmail, with its link browser set to in-app, then Safari, then Chrome. In
   the in-app browser, "Open in Safari" from its menu should finish it.
4. Quit dsul first (swipe it away), then tap the link: the app starts and
   signs in.
5. Send, then Send again within a minute ("Too many sign-in emails"), then tap
   the FIRST email's link: it still signs in.
6. Continue with Google still signs in now that the app owns its link scheme.

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

## Checking the item sheet

The hosted tests pin what the sheet says and what each verb writes, but not
how it feels. Check on the iPhone, signed in once the server's `skip`, `move`
and `pause` writes are deployed (an older server's verbs simply don't show),
or on the sample:

1. **Opening.** A row on List and on Buckets, a block on Schedule, a braindump
   row (the item's sheet stacks on the braindump sheet) and a Search result
   each open the sheet. Swipe it down, or tap Close, and you are back where
   you were.
2. **The circle still ticks.** On a row, tap a few points outside the circle,
   toward the title or above it: it ticks, it doesn't open the sheet. A tap on
   the title opens it.
3. **Drag still works.** Long-press a braindump row: it lifts and drags as
   before; a quick tap opens it instead. Drop a braindump row onto an hour
   that already has a block: it lands, the block didn't swallow the drop.
4. **Each verb.** On a one-off task: Done, Tomorrow (the row moves to
   tomorrow), Reschedule → Today, Next week, Pick a date… (the picker names
   the day on its button; Cancel changes nothing), and ⋯ → Pause until…,
   whose picker starts tomorrow. On a habit: the title's circle ticks, Skip
   today turns into Unskip today in the same place, Pause turns into Resume.
   The sheet stays open after each.
5. **Another day.** Pick tomorrow on Today and open a habit: the bar says Skip,
   not Skip today, under "For" and that day. Open a weekday habit on a
   Saturday: "Not due" and the day in place of the bar.
6. **A refused write.** Its banner shows over the sheet, under Close, and goes
   by itself.
7. **VoiceOver.** A row is one element: it reads the title and the time, the
   hint "Opens details", and the rotor's Actions has Mark done. Each chip reads
   as its own element ("Time: 9:00 to 11:00 am"), the streak chip as one
   ("Streak 41; this week: 3 done"), and each bar slot by its full name ("Mark
   done"; "Move to tomorrow" with its day).
8. **Larger text.** At the largest accessibility size the sheet opens full
   height, the chips wrap (two lines each), and the bar's words stop growing;
   a long press on a slot shows it large.
9. **Lime.** The done tick, in the sheet and on the rows, stays full lime when
   pressed and in dark mode. The sheet's buttons (Close, ⋯, Show all, the
   bar's slots) are in the label colour, not lime.

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
