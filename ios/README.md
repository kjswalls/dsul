# dsul for iPhone

A native SwiftUI app (iOS 27). It signs in with Google or an emailed link
and shows your own day from do.dsul.app; a tick, a drop on an hour, a capture,
the item sheet's Skip, move (Tomorrow, Reschedule) and Pause, an item's title
and notes, Delete, a new subtask, a streak reset, an item's priority, times
per day and reminder, and an item's date, part of day, time and length, how
it repeats, and its project, are saved to the server.
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
the notes to edit them in place. Tap the priority, date, time, times per day,
repeat, reminder or project chip to change it, and Add property (a plus once
there are chips) to add one; the other chips are read-only for now, and the
streak chip opens this week and Reset streak. Add a subtask from the Subtasks
section, one at a time or by pasting a list. A tap on a row's circle still
just ticks it.

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
plants (Sundays and Wednesdays), and its tasks are all one-offs but Pay
rent, last in the braindump, which repeats monthly on the 1st and has no day.
Draft Q4 roadmap has two subtasks (Pull the September numbers, done, and
Write the three bets), and no sample note runs past four lines.

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
server's `title`, `notes`, `delete`, `addSubtask`, `resetStreak`, `priority`,
`timesPerDay`, `reminder`, `time`, `repeat` and `project` writes are deployed
(against an older server the title and notes stay text, ⋯ has no Delete,
there is no Add a subtask row, the streak popover has no Reset, and the chips
stay read-only, with no chevrons, but for the date chip, which moves the item
as Reschedule does; Add property then holds Date alone, on an undated task);
a check that needs one or the other says so.
The sample comes back whole each time the app starts, so relaunch it to undo
a delete, a reset or a chip.

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

7. **Add property.**
   - On Call the bank in the braindump (no date, priority or reminder), the
     only chip reads "Add property". On Groceries it is a plus after the
     project chip. VoiceOver reads both as "Add property".
   - Tap it on Groceries: Priority, Time…, Repeat and Remind…, and no Times
     per day (a task has none) or Project (it has one). On Call the bank:
     Priority, Date, Repeat, Remind… and Project, and no Time… (it has no day
     yet). On Journal: Times per day, Remind… and Project, and no Repeat (a
     habit always shows its repeat chip). On Meds: Times per day and
     Project. On Draft Q4 roadmap's subtask Pull the September numbers (its
     own page): Priority alone, with no Date, Time…, Repeat, Remind… or
     Project.
   - Priority ▸ Low on Groceries: one pick, a "Low" chip with a chevron
     appears, and Priority is gone from Add property.
   - Remind… opens the Remind sheet at once, with the wheel already up.
   - Date ▸ on Renew passport, in the braindump: Today, Tomorrow and Next
     week, each with its day under it, then Pick a date…. Pick Today: a
     "Today" chip with a chevron appears, Date leaves Add property, Time…
     joins it, and Renew passport leaves the braindump for today's list.
   - Time… opens the Time sheet at once.
   - Repeat ▸ on Groceries: Daily, Weekdays, Weekends, Monthly… and Custom
     days…, and no No repeat.
   - Project ▸ on Call the bank: Work, Home, Writing, dsul and Health, each
     with its dot, and no No project. Pick Writing: a "Writing" chip with a
     chevron and its dot appears, and Project leaves Add property.
   - Once everything it offers is set, there is no Add property.
8. **The chips.**
   - Priority: on Draft Q4 roadmap, tap "High": None, Low, Medium and High,
     with High checked. Pick Medium: the chip reads Medium at once. Pick None:
     the chip goes, and Priority is back in Add property.
   - Times per day: Add property ▸ Times per day ▸ 3× a day on Journal: a "3×"
     chip. Tap it: 1× a day to 5× a day, with 3 checked. Pick 5×: the chip
     reads 5×. Pick 1× a day: the chip goes, and Times per day is back in Add
     property.
   - Remind: tap Meds' reminder chip. "Nudge me at" shows 8:00 on a wheel,
     then "Right after" with "I pour my coffee" and its note, then No
     reminder. Turn the wheel to 7:30 and tap Done: the chip reads "After I
     pour my coffee · 7:30 am".
   - On Journal, Add property ▸ Remind…: the wheel at 9:00 under "Nudge me
     at", then Right after, and no No reminder. Tap Cancel: it closes with
     nothing asked, and Journal still has no reminder. Again, and this time
     type "I put the kettle on" and tap Done: the chip reads "After I put the
     kettle on · 9:00 am".
   - On Call the dentist (at 3:00 pm), No reminder, then Add property ▸
     Remind…: the wheel opens at 3:00 pm. Tap Done without touching it: the
     chip reads 3:00 pm.
   - Change something, then swipe the sheet down: it stays. Tap Cancel:
     "Discard changes?". Keep editing keeps your change; Discard closes, and
     the chip is as it was. With nothing changed, a swipe or Cancel just
     closes.
   - No reminder: the sheet closes and the chip goes, at once, with no
     confirm.
   - On Call the bank (no date), Add property ▸ Remind…: "Give this a date and
     it will fire…" shows under the wheel.
   - In Right after, Return lowers the keyboard and leaves the sheet up;
     nothing is saved until Done.
   - Signed in, with Time format set to 24-hour on the web (Settings → Your
     day) and a pull to refresh: the wheel runs 0 to 23 with no AM/PM, and the
     chip shows the same clock.
   - Signed in, with Time format set to 12-hour on the web and 24-Hour Time on
     in the phone's Settings (General → Date & Time): the wheel shows AM/PM.
   - Signed in, with Habit reminders off on the web (Settings → Rituals) and a
     pull to refresh: "Habit reminders are off in dsul's settings on the web,
     under Rituals, so this won't fire." Turn it on and refresh: the line
     goes. On the sample, neither line shows.
   - Signed in, on an account first signed in on the phone and never opened on
     the web (the phone never stores a time zone): "Reminders need your time
     zone, which dsul picks up when you open it on the web." Open dsul on the
     web once, then pull to refresh: the line goes.
   - Signed in, on a habit of your own with a reminder and cue words: open its
     Remind sheet on the phone and leave it up. On the web, change its cue
     words. Without refreshing the phone (leave the app in the foreground, so
     no fetch lands), move only the wheel and tap Done: the web shows the new
     time with the words typed on the web.
   - The same the other way round, with a fetch in between: with the sheet
     up, change the habit's time on the web. Leave the phone app for over a
     minute and come back, so the return fetches (the sheet stays up). Change
     only the words and tap Done: the web keeps the time set on the web.
     Without that fetch the phone hasn't seen the new time, and sends the one
     it last fetched, since a reminder edit always carries its time.
   - Date: on Groceries, tap "Today": Today, Tomorrow and Next week, each with
     its day under it ("Oct 2"), then Pick a date…. Pick Tomorrow: the chip
     reads Tomorrow at once, and Groceries leaves today's list. Tap the chip
     and pick Today to bring it back. Next week is the first day of next week
     by Week starts on (Sunday on the sample).
   - On the last day of your week (Saturday on the sample), Tomorrow and Next
     week name the same day.
   - Pick a date… opens a calendar titled "Date" whose button reads "Move to
     Thu, Oct 8" (the day you pick). Cancel it. From Call the bank's Add
     property ▸ Date ▸ Pick a date…, it reads "Schedule for …". Cancel that
     too.
   - There is no No date. Tick Groceries done and tap its date chip: it has
     no chevron and opens nothing. Tap Not done to undo. A subtask's page
     (Write the three bets) has no date chip and no Date in Add property.
   - ⋯ → Pause on Groceries: the bar is Resume alone, and the date chip still
     has its chevron. Pick Tomorrow: the chip reads Tomorrow. Pick Today to
     bring it back, then tap Resume.
   - Time: on Draft Q4 roadmap, tap "9:00–11:00 am": Part of day with Morning
     checked and "The time sets the part of day." under it, Specific time
     with a wheel at 9:00 and No specific time, and Duration with 2 hours
     checked.
   - Turn the wheel to 3:00 pm: Afternoon is checked before Done. Tap Done:
     the chip reads "3:00–5:00 pm", and on Buckets the roadmap is under
     Afternoon.
   - Tap the time chip again and pick Anytime: Specific time and the line
     under Part of day go. Tap Done: the time chip goes, and Time… is back in
     Add property.
   - On Groceries (Anytime, 45 min), Add property ▸ Time…: Anytime checked, no
     Specific time, 45 min checked. Pick Morning: Add a time appears. Tap it:
     the wheel at 5:00 am. Tap No specific time: Add a time again. Tap Done:
     the chip reads "Morning".
   - On Call the dentist, tap its time chip ("3:00–3:15 pm"), pick 45 min and
     tap Done: the chip reads "3:00–3:45 pm", and the dentist stays where it
     was in the list.
   - On Meds, tap "Morning": four parts of day and no "No specific bucket".
     Pick Evening and tap Done: the chip reads Evening, and Meds moves to
     Evening on Buckets.
   - Tap it again, then Add a time: the wheel at 5:00 pm. Turn it to 9:00 am:
     Morning is checked. Tap Done: the chip reads "9:00–9:15 am", and Meds
     is back under Morning. Tap it again and tap Evening: Morning stays
     checked. Swipe the sheet down: it closes with no "Discard changes?", and
     the chip still reads "9:00–9:15 am".
   - Change something, then swipe the sheet down: it stays. Tap Cancel:
     "Discard changes?". Keep editing keeps your change; Discard closes and
     the chip is as it was. With nothing changed, a swipe or Cancel just
     closes.
   - Signed in, with Time format set to 24-hour on the web and a pull to
     refresh: the wheel runs 0 to 23, and the chip shows the same clock.
   - Signed in, on the web's Schedule, drag a task's bottom edge until it
     runs 1 hour 15 minutes. Pull to refresh and open its time chip: Duration
     shows "75 min" as its own row, between 1 hour and 1.5 hours, checked.
   - Signed in, on a task in a project block on the web: change only its
     time, within its part of day or across into another, and the web still
     shows it in the block. Pick Anytime instead (or, on one with no time,
     another part of day), and the web shows it out of the block, on the
     same day.
   - Repeat: open Plan tomorrow (Search finds it on a weekend) and tap
     "Weekdays": Daily, Weekdays, Weekends, Monthly… and Custom days…, with
     Weekdays checked, and no No repeat (a habit always repeats). Pick Daily:
     the chip reads Daily at once.
   - On Groceries, Add property ▸ Repeat ▸ Weekdays: a "Weekdays" chip with a
     chevron appears, and Repeat leaves Add property. Tap the chip: No repeat
     comes first. Pick it: the chip goes, and Repeat is back in Add property.
   - Open Water the plants (Search finds it on any day) and tap "Sun, Wed",
     then Custom days…: a sheet titled "Custom days" with seven keys, Sun and
     Wed picked in blue. Tap Fri, then Done: the chip reads "Sun, Wed, Fri".
   - Open it again and tap the three picked keys: "Select at least one day"
     shows in red under them, and Done is grey. Swipe the sheet down: it
     stays. Tap Cancel: "Discard changes?". Discard: the chip still reads
     "Sun, Wed, Fri".
   - On Stretch 10 min (Daily), pick Custom days…: only today's key is
     picked. Swipe the sheet down: it closes with no "Discard changes?", and
     the chip still reads Daily. Pick Custom days… again and tap Done: the
     chip reads today's day alone (for example "Thu").
   - With the chip on Custom days, open its menu and pick Custom days… again:
     the sheet opens on the days already set.
   - On Water the plants, pick Custom days… and turn on every key, then
     Done: the chip reads "Daily" (seven days read as Daily, as Today's rows
     read them), and its menu has Custom days… checked, not Daily.
   - Open Pay rent, last in the braindump: its chip reads "Monthly · 1". Pick
     Monthly…: a sheet titled "Monthly" with days 1 to 31 in a grid, 1
     picked, and "For months with fewer days, it will occur on the last
     day." under it. Pick 31 and tap Done: the chip reads "Monthly · 31", and
     Pay rent stays in the braindump, with no date.
   - On Call the bank, in the braindump, Add property ▸ Repeat ▸ Daily: a
     Daily chip, and Call the bank stays in the braindump, with no date chip.
   - Write the three bets (a subtask) has no Repeat in Add property.
   - Signed in, set Week starts on to Monday on the web (Settings → Your day)
     and pull to refresh. On a task of your own, pick Custom days… (Add
     property ▸ Repeat, or its repeat chip): the keys run Mon to Sun. The
     sheet opens with today's key picked, or the days already set, so turn
     keys on and off until only Mon and Sun are picked, and tap Done: the
     chip reads "Sun, Mon", the web's Sunday-first order, as Today's rows
     read it.
   - Signed in, on a task that is a milestone of one of your goals on the
     web, pick Daily here, then reload the web: it is a plain member of that
     goal now, with no notice on either side. Pick No repeat here and reload
     the web: it is still a plain member (the role doesn't come back). The
     same for a check-in that is a repeating task (the web's goal pane makes
     check-ins weekly Sunday tasks) set to No repeat.
   - Signed in, on a repeating task of your own whose first day is before
     today, pick No repeat: the date chip reads that first day, the task
     leaves Today and is in no list on the phone, and Search finds it. The
     web shows it in its past-due bar.
   - Project: on Groceries, tap "Home": No project, then, under a line,
     Work, Home, Writing, dsul and Health, each with its dot, Home checked.
     Pick Work: the chip reads Work at once, with Work's dot. Pick Work
     again: the menu closes and nothing changes. Pick No project: the chip
     goes, and Project is back in Add property.
   - On Standup, tap "work" (filed in lowercase, with no link to Work):
     Work is checked. Pick Work: the chip reads "Work".
   - Write the three bets (a subtask) has no Project in Add property.
   - Signed in, file a task of yours under a name none of your projects
     has, the Trash's included, through the agent API:
     `PATCH /api/agent/tasks/:id`, with your OpenClaw API key as the Bearer
     token and the body `{"project":"Fitness"}`. Pull to refresh and tap its
     chip, "Fitness", with a gray dot: nothing is checked, and No project
     and each of your projects can be picked. Then send one of your
     projects' names in lowercase the same way (`{"project":"work"}` for
     Work): pull to refresh, and the menu checks that project.
   - Signed in, on a task of yours timed today (say 2:00 pm) and filed under
     a project with a block today: on the web's Schedule, drag it onto the
     block. Pull to refresh here: on Schedule it sits in the block. Pick
     another project in its chip: at once it is out of the block, at 2:00
     pm again. Reload the web: it is out of the block there too, at 2:00
     pm, under the new project.
   - Signed in, on a habit of yours filed under a project, pick No project
     here, then reload the web: its item panel shows no project (the
     server cleared both the project and the old group column, which the
     web still falls back to).
   - Signed in, put a project of yours in the Trash on a computer, with the
     app left in the foreground so no fetch lands, then pick that project
     here for a task: the chip turns back, with the banner, and once the
     refresh lands the project is gone from the menu.

Check 8's other chips (routines and seasons) come with the PR that makes them
editable.

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
     the count is one more than before the reset, and matches the web;
   - change a priority, a times per day and a reminder: each turns back, with
     the banner;
   - pick a date, and change a time: each turns back, with the banner;
   - change a repeat: it turns back, with the banner;
   - change a project: it turns back, with the banner.
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
    - Type "Milk" in the field without pressing Return, then close the sheet.
      Milk is added, and VoiceOver says "Added Milk" after the sheet has gone.
    - An editable chip reads its words, "button" and a hint: "High priority,
      button, Changes the priority"; "3 times a day, button, Changes how many
      times a day"; "Reminder: After I pour my coffee, 8:00 am, button,
      Changes the reminder". A read-only chip (a routine) has no hint.
    - "Add property" is a button. Pick None on a priority chip: VoiceOver
      moves to Add property.
    - On Pull the September numbers' page, Add property ▸ Priority ▸ Low: Add
      property goes, and VoiceOver lands on the new chip, "Low priority".
    - On Journal, Add property ▸ Times per day ▸ 3× a day: VoiceOver lands on
      "3 times a day".
    - In the Remind sheet, "Nudge me at" and "Right after" are read before
      their rows, the wheel is "Time", and No reminder is a button. After No
      reminder, VoiceOver is on Add property. After Done on a new reminder
      from Add property, it is on the new reminder chip.
    - In the times menus, the choices read "3 times a day".
    - Relaunch the sample first: check 8 moved the roadmap and Meds,
      unfiled Groceries and relinked Standup.
    - The project chip on Groceries reads "Project: Home, button, Changes
      the project". In its menu Home is read as selected, and no dot is
      read.
    - Pick No project: VoiceOver is on Add property. Add property ▸ Project
      ▸ Home: VoiceOver lands on the new chip.
    - The date chip reads "Date: Today, button, Changes the date"; the time
      chip "Time: 9:00 to 11:00 am, button, Changes the time". Tick Groceries
      done: its date chip has no hint and is not a button. Tap Not done.
    - The date menu reads "Tomorrow, Oct 2". After a pick, VoiceOver is on
      the date chip. After Pick a date… closes, it is on the date chip too.
    - In the Time sheet, "Part of day", "Specific time" and "Duration" are
      read before their rows. The checked part of day is read as selected,
      and "The time sets the part of day." is read under the four. Add a
      time is a button; after it, VoiceOver is on the wheel ("Time"). After
      No specific time, it is on Add a time. The lengths read "45 minutes"
      and "1.5 hours".
    - A tap on a part of day that changes nothing leaves VoiceOver where it
      is.
    - After Done on Anytime, VoiceOver is on Add property. After Done on
      Time… from Add property, it is on the new time chip.
    - The repeat chip on Plan tomorrow (Search finds it on a weekend) reads
      "Repeats: Weekdays, button, Changes how it repeats". In its menu the
      checked frequency is read as selected.
    - On Plan tomorrow, pick Daily: VoiceOver is on the repeat chip. On
      Groceries, Add property ▸ Repeat ▸ Weekdays: VoiceOver lands on the new
      chip. Then the chip's No repeat: VoiceOver is on Add property.
    - In the Custom days sheet each key reads its full day ("Wednesday"), and
      a picked one is read as selected. Turn off the last picked key:
      VoiceOver says "Select at least one day" at once, the line is read
      under the keys, and Done is dimmed.
    - In the Monthly sheet each day reads "Day 12", the picked one as
      selected, and the note is read under the grid.
    - After Done in either sheet, VoiceOver is on the repeat chip.
    - At the largest text size, a picked Custom days row reads "Wednesday,
      selected", with no "checkmark".
    - With Voice Control on (and VoiceOver off), in the Custom days sheet "Tap
      Wed" toggles Wed, and in the Monthly sheet "Tap 12" picks 12.
11. **The largest text size.** The title and the notes still edit, and
    Delete's confirm shows all its words. The streak chip opens a sheet, not a
    popover, at half height with a grabber. The flame and the count sit above
    the week's seven days, the week and Reset streak fit, and a swipe down
    closes it. Every chip still opens its menu, Add property's submenus fit,
    and the Remind sheet scrolls to its wheel, Right after, its notes, the
    settings lines and No reminder. The date menu's days fit under their
    words, and the Time sheet scrolls to Duration with every part of day, the
    line under them, the wheel and No specific time on the way. The Custom
    days sheet shows seven rows with the full day names and a check, and the
    Monthly sheet a list from Day 1 to Day 31; each scrolls to its footer.
    The project menu and Add property's Project ▸ open, and the names wrap
    rather than truncate. On Pay rent, pick Day 31 in Monthly… and tap Done,
    then open Monthly… again: it opens with Day 31 checked and in view.
    (Check 10 relaunched the sample, so Pay rent is back on the 1st.)
    - At xxxLarge, the largest size below the accessibility sizes (Larger
      Text with Larger Accessibility Sizes off, the slider at its end): the
      Custom days keys are seven rows with the full names; the Monthly sheet
      is still a grid, every number whole.
    - At xLarge (one step above the default), with Display Zoom set to
      Larger Text (Settings → Display & Brightness): the seven keys share one
      row, every word whole (none reads "W…"), each 44pt tall, and each still
      toggles alone.
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
    - The chips' words, symbols and chevrons, and Add property's plus, are the
      label colour or gray, not lime, at rest and while pressed, and a press
      scales them. The menus' checkmarks, the wheel, the Remind sheet's Cancel
      and Done, and Right after's caret aren't lime. No reminder and Discard
      are red.
    - On Call the dentist with six lines of notes (check 2), a tap on the
      words Show all expands the notes, and a tap in the gap just above the
      Medium chip opens its menu: the few points between them go to the chip,
      which is nearer.
    - The date and time chips' words, symbols and chevrons are the label
      colour or gray, not lime, at rest and while pressed. In the Time sheet
      the checks, Add a time, No specific time, the wheel, Cancel and Done
      aren't lime; Discard is red. Pick a date…'s calendar is the system
      blue.
    - The repeat chip's words, symbol and chevron are the label colour or
      gray, not lime, at rest and while pressed. In the Repeat sheets the
      picked keys and the picked day are the system blue with white text, in
      light and dark mode, and the rest gray or the label colour; Cancel and
      Done aren't lime; Select at least one day and Discard are red.
    - The project chip's words and chevron are the label colour or gray, not
      lime, at rest and while pressed, and its dot is its colour. The
      project menu's checks aren't lime.
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
    - A pick in a chip's menu, and in an Add property submenu, writes once:
      signed in, the edit history at the foot of the web's item panel shows
      one new entry.
    - Remind… in Add property opens the Remind sheet (a sheet presented from
      a menu action).
    - The wheel runs in GMT. Signed in, on a habit of your own with a
      reminder at 8:00, with the phone set to another time zone (Settings →
      General → Date & Time): the wheel shows 8:00, and Done without touching
      it sends nothing (the web's edit history has no new entry).
    - The wheel's 12- or 24-hour clock follows the locale's hour cycle.
    - A swipe on a changed Remind sheet is refused
      (interactiveDismissDisabled), and the discard confirm comes up over the
      nested sheet.
    - Return in Right after (a one-line field with a Done key) lowers the
      keyboard and leaves the sheet up.
    - VoiceOver moves where the code sends it once a menu or the Remind sheet
      has closed (`@AccessibilityFocusState`, set 600 ms later), and iOS's own
      return of focus to the menu's source doesn't win.
    - A date menu entry shows its day as a subtitle under its word (a menu
      button's second Text).
    - Pick a date… in the date menu, and Time… in Add property, open their
      sheets (a sheet presented from a menu action).
    - Each part of day's check follows the wheel as it turns (each row's
      check reads the preview, so a turn of the wheel redraws the rows).
    - VoiceOver lands on the wheel after Add a time, and on Add a time after
      No specific time (focus set on the next turn, not 600 ms later). If it
      doesn't land on the wheel, Add a time hands focus to No specific time
      instead, a one-line change, and this line says so.
    - A swipe on a changed Time sheet is refused, and the discard confirm
      comes up over the nested sheet.
    - The Time sheet's wheel runs in GMT: signed in, on a habit of your own at
      9:00, with the phone in another time zone, the wheel shows 9:00 and Done
      without touching it sends nothing.
    - Each Custom days key toggles alone: the seven share one row, and each
      is a borderless button, so a tap fires only the one under it.
    - Picking Custom days… or Monthly… in the repeat chip's menu opens its
      sheet even when that row is already checked (the Picker's binding is
      set again on a re-pick). If it doesn't, the menu's rows become toggles,
      which run on every tap and still read as selected (check 10 stays as
      it is), and this line says so.
    - Custom days… and Monthly…, in the chip's menu and in Add property's
      Repeat submenu, open their sheet (a sheet presented from a menu action).
    - A swipe on a changed Repeat sheet is refused, and the discard confirm
      comes up over the nested sheet.
    - With Increase Contrast on, the picked keys' blue is darker.
    - In the project menu, and in Add property's Project ▸, each project's
      dot shows in its colour, not gray (an image drawn as is). If it is
      gray, the rows drop the dot, and this line says so.
    - Picking the checked project runs its action (a Toggle's setter runs on
      every tap): on Standup, filed "work" with no link, the menu checks
      Work; pick Work and the chip reads "Work". On Draft Q4 roadmap,
      picking its checked Work closes the menu and changes nothing.

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
