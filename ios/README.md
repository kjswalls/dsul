# dsul for iPhone

A native SwiftUI app (iOS 27). It signs in with Google or an emailed link
and shows your own day from do.dsul.app; a tick, a drop on an hour, a capture,
the item sheet's Skip, move (Tomorrow, Reschedule) and Pause, an item's title
and notes, Delete, a new subtask and a streak reset are saved to the server.
"Try with sample data" on the sign-in screen opens a made-up day instead,
which needs no account and whose changes last until the app quits.

Today shows one day in three layouts: List (filter chips, then sections per
routine and per project), Buckets (Morning, Afternoon, Evening, Anytime) and
Schedule (the hour grid, with the braindump sheet over it). The capsule top
right switches them: tap for the next, swipe along it to step, long-press for
the menu. Tap the title to pick another day. The capture bar above the tab bar
adds thoughts to the braindump; its count opens the braindump over Schedule.

Tap an item anywhere (a row, a block on the grid, a braindump row, a search
result) to open its sheet: what it is (its notes, its streak, its chips), its
verbs in a bar along the bottom (tick, Skip, Tomorrow, Reschedule, Pause,
Pause until, Resume, whichever apply), and Delete behind ⋯. Tap the title or
the notes to edit them in place; the chips are read-only for now, except the
streak chip, which opens this week and Reset streak. Add a subtask from the
Subtasks section, one at a time or by pasting a list. A tap on a row's circle
still just ticks it.

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
how it feels. Check on the iPhone, on the sample or signed in once the
server's `skip`, `move` and `pause` writes are deployed (an older server's
verbs simply don't show); a check that needs one or the other says so. The
sample's habits are Meds and Stretch 10 min (daily, already done today),
Journal (daily, not done today), Plan tomorrow (weekdays) and Water the
plants (Sundays and Wednesdays), and its tasks are all one-offs. Draft Q4
roadmap has two subtasks (Pull the September numbers, done, and Write the
three bets), and no sample note runs past four lines.

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
4. **Each verb** (the sample, or signed in), opened from Today on today. On
   a one-off task (Call the dentist on the sample), in this order: Tomorrow
   (the row moves to tomorrow, and the slot then says Next day), Reschedule →
   Today (it comes back), Next week, Pick a date… (the picker names the day on
   its button; Cancel changes nothing), ⋯ → Pause until… (its picker starts
   tomorrow and says the item comes back on the day picked; the bar is then
   Resume alone, so tap it), and Done last, since it takes Tomorrow and
   Reschedule away until Not done brings them back. On a habit not done
   today (Journal on the sample; Meds and Stretch are done, so they have no
   Skip): Skip today turns into Unskip today in the same place (the title's
   circle goes while the day is skipped), then Unskip today, then the title's
   circle ticks it (Skip goes while it is done), then Pause turns into
   Resume. Signed in only, on a repeating task of your own (the sample has
   none): the bar is Done today, Skip today and Pause, and ⋯ → Reschedule
   moves the series to start on the day picked.
   The sheet stays open after each.
5. **Another day** (the sample, or signed in). Pick tomorrow on Today and open
   Journal: the bar says Skip, not Skip today, under "For" and that day, and
   a line under the title names the day too, since its circle ticks it. Pick
   yesterday and open Journal (done yesterday on the sample): with no Skip,
   the bar is Pause and Pause until, which act on today, so no "For" sits
   over it, though the line under the title still names yesterday. Today
   lists only what falls on its day, so for "Not due" use Search, which acts
   on today: on the sample, Plan tomorrow when today is a Saturday or Sunday,
   or Water the plants when it is any day but Sunday or Wednesday. "Not due
   today" takes the bar's place, the title has no circle, and ⋯ holds Pause
   and Pause until…, then Delete.
6. **A refused write** (signed in only: the sample sends nothing, so nothing
   is refused). Turn on Airplane Mode, with Wi-Fi off too, open a habit not
   done today and tap Skip today. "Couldn't reach dsul. Checking what was
   saved…" shows over the sheet, under Close, then "Couldn't reach dsul, so
   that change was undone." as the slot turns back to Skip today. It shows
   once (not again over Today behind the sheet at its medium size), and goes
   by itself after five seconds, or at a tap.
7. **A counted habit** (signed in only; the sample has none). Open a habit you
   do more than once a day: its count sits on the line under the title
   ("0/3"), and each tap on the title's circle counts one ("1/3") until the
   day is done.
8. **VoiceOver.** A row is one element: it reads the title and the time, the
   hint "Opens details", and the rotor's Actions has Mark done. Each chip reads
   as its own element ("Time: 9:00 to 11:00 am"), the streak chip as one
   ("Streak 41; this week: 3 done"), and each bar slot by its full name ("Mark
   done"; "Move to tomorrow" with its day).
9. **VoiceOver hears the banner** (signed in only). With VoiceOver on, do
   check 6: VoiceOver says each banner as it shows (the second can cut the
   first short), and focus stays on the slot.
10. **Larger text.** At the largest accessibility size the sheet opens full
    height, the chips wrap (two lines each), and the bar's words stop growing;
    a long press on a slot shows it large.
11. **Lime.** The done tick, in the sheet and on the rows, stays full lime when
    pressed and in dark mode. The sheet's buttons (Close, ⋯, Show all, the
    bar's slots) are in the label colour, not lime.

## Editing an item

The hosted tests pin what each field sends and what Delete says, but not how
typing feels. Check on the iPhone, on the sample or signed in once the
server's `title`, `notes`, `delete`, `addSubtask` and `resetStreak` writes are
deployed (against an older server the title and notes stay text, ⋯ has no
Delete, there is no Add a subtask row and the streak popover has no Reset); a
check that needs one or the other says so. The sample comes back whole each
time the app starts, so relaunch it to undo a delete or a reset.

1. **Title.**
   - Tap the title: the keyboard rises, the sheet goes full height, the bar
     hides, and Done (a checkmark) takes ⋯'s place. Type and press Return: it
     saves, the keyboard goes, and the row behind the sheet updates.
   - Edit again and swipe the sheet down mid-word: it saves.
   - Signed in: edit, then switch apps straight away. Wait 10 seconds and
     check the web: it shows the new title.
   - Clear the title and close: the old title comes back.
   - Paste two lines: they become one title, joined by a space.
   - A subtask's page edits its own title.
   - Signed in: on a title with a line break, or one over 500 characters,
     tap it and close without typing: nothing is sent, and the web is
     unchanged. The web's title field flattens line breaks, so store that
     title in SQL or through the agent API: `PATCH /api/agent/tasks/:id`,
     with your OpenClaw API key as the Bearer token and the body
     `{"title":"Line one\nLine two"}`.
2. **Notes.**
   - On an item without notes (Call the dentist on the sample), "Notes" shows
     under the title. Tap it, type six lines, tap Done: it saves, and Show all
     appears.
   - Clear the notes: "Notes" comes back.
   - Tapping notes puts the caret at the end, wherever the tap was.
3. **Keyboard.** Scroll the content up a little, then drag down: the keyboard
   follows the finger. At the top, the same drag moves the sheet and saves.
   The bar comes back when no field is focused.
4. **Delete.**
   - ⋯ → Delete task → Cancel changes nothing.
   - Delete: the sheet slides away showing its content (never blank), and the
     row is gone. On Draft Q4 roadmap its two subtasks go too, and the confirm
     said so ("Its 2 subtasks go with it.").
   - Long-press a subtask row → Delete → Delete in the confirm.
   - On a subtask's page, ⋯ → Delete task → Delete returns to the parent,
     showing the subtask's page as it leaves.
   - A habit's ⋯ is Delete habit alone, and so is a paused item's.

5. **Add a subtask.**
   - On a task with none (Call the dentist on the sample), "Subtasks" and then
     "Add a subtask" show under the chips. Tap anywhere along that row, right
     of the words too. Type and press Return five times: five subtasks, each
     Return adding exactly one, the keyboard stays, and the field stays in
     view above it.
   - Press Return on the empty field: the keyboard goes, and the row reads
     "Add a subtask" again.
   - Copy a three-line bulleted list (Notes: "- Eggs", "- Milk", "- Bread")
     and paste it into the field: three subtasks, without the bullets.
     Anything you had typed stays in the field.
   - Type a few letters, then drag the content down until the keyboard goes:
     the letters become a subtask, and the row comes back.
   - Type a few letters and switch apps, then come back: nothing was added,
     and the letters are still in the field.
   - A habit's sheet, and a subtask's page, have no "Add a subtask" row.
   - Signed in: the web shows the new subtasks under the task, in the order
     added.
6. **Reset streak.**
   - Tap Meds' streak chip: a popover with this week's days and "41 days in a
     row", then Reset streak. Tap just above, then just below, the chip's
     capsule: the popover still opens.
   - Reset streak → Reset streak in the confirm: the popover closes, the chip
     reads 0, and this week's done days are still done.
   - Open it again at 0: "No streak yet", and no Reset streak.
   - Signed in, with Streaks off on the web (Settings → Extensions) and a pull
     to refresh: no streak chip, and no flame or count on Today's rows, in
     List or Buckets. Turn it back on and refresh: both are back.
   - At the largest text size the chip opens a sheet, and Reset's confirm
     still appears.
   - Where the chips wrap onto two or more lines (a larger text size makes
     Meds' or Draft Q4 roadmap's wrap), the gaps between the lines are even,
     and the first line sits as far under the notes as before.

Checks 7 and 8 (the chips) come with the PRs that add them, so the numbers
match memory/plans/ios-app.md.

9. **Offline** (signed in only: the sample sends nothing, so nothing fails).
   With Airplane Mode and Wi-Fi off:
   - change a title: the banner shows, and the title turns back;
   - delete a task with subtasks: it comes back, with its subtasks, in its
     place, and the banner ends "so that change was undone";
   - add a subtask: it goes again, with the banner;
   - paste three lines into Add a subtask: all three go again, and VoiceOver,
     if on, says "Couldn't reach dsul. Checking what was saved…" once, not
     three times, then "Couldn't reach dsul, so that change was undone."
     once;
   - on a habit of your own with a streak, not yet done today: reset its
     streak. It turns back, with the banner. Then, back online, tick it today:
     the count is one more than before the reset, and matches the web.
10. **VoiceOver.**
    - The title reads as "Title", a text field and a heading; the notes, and
      "Notes" where there are none, as a button with the hint "Edits the
      notes".
    - The rotor's Actions on a subtask row include Delete.
    - Delete asks to confirm, and once done VoiceOver says "Task deleted".
    - The streak chip reads "Streak 41; this week: N done" (N depends on the
      weekday), a button, with the hint "Shows this week, and Reset streak".
      Reset streak asks to confirm.
    - "Subtasks" is a heading, even on a task with none.
    - "Add a subtask" is a button. Double-tap it: VoiceOver moves to the
      field, which reads "New subtask". Type a subtask and press Return:
      VoiceOver says "Added …". Press Return on the empty field: VoiceOver is
      back on "Add a subtask".
11. **The largest text size.** The title and the notes still edit, and
    Delete's confirm shows all its words. The streak chip opens a sheet, not a
    popover, at half height with a grabber; its week and Reset streak fit, and
    a swipe down closes it.
12. **Lime, in light and dark mode.**
    - The caret, the selection, the nav bar's Done and the confirm's Cancel
      aren't lime.
    - In Pick a date… and Pause until…, the calendar's picked day and today
      are the system blue, not lime, and today is still told apart in dark
      mode, picked and not.
    - Delete is red. The done tick stays full lime.
    - Reset streak is red, in the popover and in the confirm. The subtask
      field's caret isn't lime. The streak chip's count is the label colour,
      at rest and while pressed.
13. **What the code assumes of iOS.**
    - Return in the title (a vertical field with a Done key) ends the edit.
    - Return in the subtask field (a vertical field with a Next key) adds
      exactly one subtask each time and keeps the keyboard; Return on the
      empty field ends entry.
    - The streak chip opens a popover at the default text size
      (presentationCompactAdaptation), and its confirm comes up from inside
      the popover.
    - The title field is still a heading to VoiceOver.
    - A swipe down saves what was typed: `.onDisappear` runs while the
      page's state is still there.
    - The sheet's jump to full height while the keyboard rises keeps the
      field in view.
    - The confirm comes up from ⋯ on the sheet's first page and on a pushed
      subtask's page.
    - Signed in: retitle or delete something, then go to the home screen at
      once: it still reaches the server (the background time the app asks
      for while a write is out).

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
