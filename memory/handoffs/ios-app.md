# Hand-off: dsul iPhone app ("iOS app, continued" thread, updated 2026-10-09)

**Status: PAUSED.** Kirby paused dsul work on 2026-10-09 at 04:20 UTC ("ok let's pause dsul work again for now"). Nothing resumes until Kirby says so. This file is for a session that picks the work up afterwards.

## Goal
dsul's native iPhone app, built in SwiftUI under `ios/` (iOS 27; XcodeGen generates the project from `ios/project.yml`, never commit `*.xcodeproj`). It mirrors the web planner: Today in List, Buckets and Schedule; the capture bar and braindump sheet; item detail; Organize; and notifications. Ask, week views and widgets come later.

How it is built:
- **Ported logic.** Pure planner logic is ported to Swift in `ios/DsulCore`, which is Linux-testable. Vitest runs the real TS and writes shared JSON fixtures, DsulCore's tests read the same files, and CI fails when they disagree. A Swift port cites the TS it mirrors.
- **Writes.** Phone writes go through the `/api/app/*` routes.
- **Design.** The agreed design is boards D, E, G and H in `/mnt/project-files/ios-app/` (PNGs; single phones in `screens/`). The HTML sources, `mockups-*-source.html`, are copied to `memory/handoffs/ios-app/`. Boards A to C are superseded.

## Shipped (all merged to main)
| PR | What |
|---|---|
| #356 | SwiftUI shell, the DsulCore package, the braindump-to-hour drag spike |
| #358 | Today List and Buckets layouts, layout switcher, capture bar |
| #367 | Google sign-in, real items |
| #368 | Home Screen icon follows the App icon pick |
| #370 | Sign in with an emailed link |
| #378 | Item detail part 1: tap an item to see it and act on it |
| #379 | 2a: edit title and notes, delete |
| #387 | 2b: subtasks, reset a streak |
| #389 | 2c: priority, times a day, reminders |
| #391 | 2d: date and time |
| #393 | 2e: how an item repeats |
| #410 | 2f-a: file under a project |
| #417 | 2f-b: add to routines and seasons |
| #424 | Sign in with Apple |
| #430 | Delete account, iPhone and web (merged as 9e9bb33f, 2026-10-08) |

## Update (2026-10-09, later)
- **Reminders Phase 2a merged as #446.** The section below is history.
- **Phase 2b (server) merged as #450.**
- **Phase 2c (the phone's own notifications) is in a PR from `claude/project-thread-32mqp1`**: `ios/Dsul/Notifications/`, the AppDelegate, the background refresh and the Remind sheet's lines. The plan's Phase 2c addendum lists where it departs (no `PlannerCache` yet). Its device checks are `ios/README.md`'s "Checking reminders". 2d (device registry) needs Phase 1 first.

## Was in progress: Reminders Phase 2a (merged as #446)
**Branch:** `claude/ios-app-9p05kw` at `92ebd7b2`, pushed to origin.
- It has 3 commits on top of 9e9bb33f (#430's merge): `2ae4fc84` (WIP snapshot), `8d049536` (the planner, fixtures and Swift port) and `92ebd7b2` (review round 2's fixes and the plan addendum).
- main has moved on to `89aa5466` (#442, #443), which is **not merged into the branch yet**.

**What it is.** This is the pure half of Phase 2 (iPhone local notifications) in `memory/plans/reminders-platforms.md`, its §5.3. Nothing on the phone schedules a notification yet.

**TS:**
- `lib/reminders/clock.ts`:
  - `localClock` moved here, and `scan.ts` re-exports it.
  - New: `instantOf`, `addDays`, `weekdayOf`, `changeoverMinutes`.
- `lib/reminders/snooze.ts`: `snoozeFireInstant`, `ringsOnDay`.
- `lib/reminders/plan.ts`: `planNotifications(input) → {requests, withdraw, notes}`, `identifiers(itemId)` and `eodIdentifiers()`, with a budget of 60. Its header ("THE SHAPES", "What is left") is the spec.
- `lib/recurrence.ts` now caches an `Intl.DateTimeFormat` per zone in `toDateStr`, a performance fix.

**Tests and fixtures:**
- `tests/unit/reminders-plan.test.ts`, `reminders-snooze.test.ts`, `notification-plan-fixtures.test.ts` and `ios-change-filter.test.ts`.
- `day-fixtures.test.ts` now also writes `due.json` and `copy.json`.
- The fixtures are `tests/fixtures/day/{due,copy,notification-plan}.json`.

**Swift:**
- `ios/DsulCore/Sources/DsulCore/Reminder{Clock,Due,Copy,Snooze,Plan}.swift`.
- Tests: `DueFixtureTests`, `CopyFixtureTests`, `SnoozeFixtureTests` and `NotificationPlanFixtureTests`.

**CI:** `.github/workflows/ios.yml`'s `changes` regex now covers `lib/reminders/(plan|snooze|clock|due|copy|channels/push)`, `lib/verb-gates` and `lib/eod`.

**Docs:**
- `memory/plans/reminders-platforms.md` has a new "Addendum (2026-10-09): what Phase 2a changed on the way in". It lists the 14 places 2a departs from the plan body.
- The biggest departure: there is no repeating interval trigger, because iOS's `UNTimeIntervalNotificationTrigger` has no start date. A held slot becomes a weekday split, a one-off, or a series of one-offs instead.
- The addendum also covers the lapse rule (`LAPSE_DAYS` = 31, Kirby's to move), quiet days rather than a ring on a wrong day, the identifiers, days of the month after the 28th, and the DST changeover minutes.
- `memory/plans/ios-app.md` and `ios/README.md` each gained a line about the reminder ports.

**Review state:**
- It went through two adversarial review rounds (Ultracode).
- Round 1's fixes were retested: Vitest 12,105 passing, lint 0 errors, DsulCore 442 passing, and the fixtures idempotent.
- **Round 2's fixes are committed but NOT retested.** They cover the lapse rule, changeover minutes, days 29 to 31, the anchored series start, the budget and the snooze day gate.

### Resume checklist for 2a
1. Run `git fetch origin`, check out `claude/ios-app-9p05kw`, then `git merge origin/main`. Merge, don't rebase.
2. Run `pnpm install`, `pnpm test`, `pnpm lint`, and `pnpm exec tsc --noEmit`. main has tsc errors of its own in files this branch doesn't touch.
3. Check fixture stability: run `UPDATE_FIXTURES=1 pnpm test` twice. After the second run, `git status --short tests/fixtures` must be empty.
4. Run DsulCore's tests with the Swift recipe below. Also run the shim if any app file changed.
5. Commit and push.
6. Open the PR ("Reminders Phase 2a: the notification planner and its Swift port"):
   - assign it to kjswalls and call `subscribe_pr_activity`;
   - wait for Claude Code Review and fix every finding;
   - squash-merge once Unit tests AND the iOS checks are green. The iOS checks aren't required, so check them by hand.
7. After the merge, restart the branch from `origin/main` and keep the same name.

### After 2a
Notifications counts as big work, so each phase runs as a Workflow with an adversarial review between phases.
- **2b, server:**
  - a snooze intent on `PATCH /api/app/items/:id`, and `complete` clears the snooze columns;
  - `POST /api/app/timezone`;
  - the planner payload gains the reminder settings (`lastCallEnabled`/`Time`, `eodReviewEnabled`/`Time`, `lastEodReviewDate`, `reminderGraceMinutes`) and the items' snooze projection.
  
  Pin all of it three ways: the route test, the fixture and the Swift decoder.
- **2c, phone:**
  - the hosted scheduler, `ios/Dsul/Notifications/*`, using `UNUserNotificationCenter` with the Done and Snooze 15m actions;
  - an AppDelegate;
  - in `project.yml`, `UIBackgroundModes` fetch and the BGTask id `app.dsul.ios.reconcile`;
  - the Remind sheet's Settings line, worded as in the addendum's item 3.
- **2d:** register the device. This needs Phase 1, the `devices` registry (`lib/devices`), which is not built.
  - The plan's `059_devices` number was taken, so its migration needs the next free number. That is 064 as of 2026-10-09; check main, the prod ledger and open branches first.
- **Phase 3:** APNs, on Kirby's paid team.
- **Later:** see the "Not yet" list in `memory/plans/ios-app.md`. It includes week views, density, swipe rows, Ask and the item thread, Focus as a Live Activity, universal links, and creating projects, routines and seasons from the phone.
  - Kirby may want the iPhone Schedule to keep the web's schedule-block flavour. Wait until mobile web settles that look; the coordinator will say when.

## Waiting on Kirby
1. **Migration 063 on prod (account deletion).**
   - Kirby typed "Go" on 2026-10-09 at 00:40. The connector write was refused, and the SQL was posted inline in the thread.
   - The SQL is also at `memory/handoffs/ios-app/063-account-deletion-for-sql-editor.sql`. It is wrapped in begin/commit and inserts ledger row `'063'`.
   - It was still not applied on 2026-10-09.
   - Once Kirby pastes it and says "done", verify with a read: `list_migrations` should show 063.
   - The prod ledger holds 000 to 058 and 060 to 062. 059 is missing, so `db push` would stop; 063 goes in alone.
2. **Vercel Production env vars:** `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, and `APPLE_IOS_CLIENT_ID=app.dsul.ios`. Account deletion revokes Sign in with Apple with these; see `memory/plans/account-deletion.md`.
3. **Apple setup:**
   - pick the paid team in Xcode on the Mac;
   - add `app.dsul.ios` to the Client IDs of Supabase's Apple provider;
   - make sure Supabase's redirect URLs allow `https://do.dsul.app/**`.
4. **On-device checks in `ios/README.md`:** none has run yet as far as this thread knows. They are Sign in with Apple, account deletion (use throwaway accounts), the email link, the drag spike's five checks, and the item sheet.
5. **The iPhone:** the iMac can't see it.
   - Kirby plugs it in with a data cable, taps Trust, and checks Xcode → Window → Devices and Simulators, then says "phone ready".
   - Don't install anything before that.
6. **Old habits filed under a project literally named "none".** #373 fixed new saves; old rows need this SQL. It is a prod write, so it needs Kirby's typed OK:
   ```sql
   update items set project = null, "group" = null
   where type = 'habit' and project = 'none' and project_id is null;
   ```

## Running things
**Swift in a cloud container.** A cloud container has no Swift toolchain, but it can run CI's own swift:6.4 image through chroot. The scripts are in `memory/handoffs/ios-app/swift-toolchain/`; `SP` below is your scratchpad.
1. Pull the image:
   ```
   mkdir -p $SP/swiftimg && cd $SP/swiftimg && bash memory/handoffs/ios-app/swift-toolchain/pull.sh
   ```
   The image is pinned by digest. The download is about 1.4 GB and extracts to about 5.7 GB.
2. Set up the rootfs:
   ```
   R=$SP/swiftimg/rootfs
   mkdir -p $R/work
   cp .../swift-toolchain/test-*.sh $R/
   cp -r .../swift-toolchain/shim $R/shim
   ```
3. Run DsulCore's tests, always under flock and always unmounting. A live bind mount means deleting the scratchpad would delete the repo.
   ```
   export R TREE=/home/claude/dsul
   flock "$SP/swiftimg.lock" bash -c 'mount --bind "$TREE" "$R/work" && mount -t proc proc "$R/proc" && mount --bind /dev "$R/dev"; chroot "$R" /test-core.sh; rc=$?; umount "$R/dev" "$R/proc" "$R/work"; exit $rc'
   mount | grep swiftimg || echo unmounted
   ```
4. For the app's non-UI files and their hosted tests:
   - run `bash $R/shim/sync-tree.sh` (edit its `I=` path if the repo lives elsewhere);
   - then the same command with `/test-shim.sh`.
   
   The shim stubs the Accessibility and SwiftUI bits those files touch.

**SwiftUI views and AppGate** compile only on GitHub's `xcode-27` runner (`.github/workflows/ios.yml`), which runs on every push.

**On a device:** use Remote Control on Kirby's iMac.
- The folder is `~/Projects/Code/dsul`, approved 2026-10-02.
- It was 63 commits behind main when last checked, so `git pull` there first.
- The Mac session never commits or pushes.

## Key files
- **Plans:**
  - `memory/plans/ios-app.md`: the app, the port order and "Not yet";
  - `memory/plans/reminders-platforms.md`: read its addendums first;
  - `memory/plans/account-deletion.md`;
  - `memory/plans/sign-in-with-apple.md`: the Apple client secret must be re-minted every six months.
- `ios/README.md`: run steps and every on-device check.
- `lib/reminders/plan.ts` and `ios/DsulCore/Sources/DsulCore/ReminderPlan.swift`.
- **Earlier briefs** in `/mnt/project-files/ios-app/`: `account-deletion-brief.md`, `sign-in-with-apple-brief.md`, `item-detail-*-brief.md`, `item-detail-part2-design.md`, `stack.md` (SwiftUI build notes, copied to `memory/handoffs/ios-app/stack.md`) and `expo-vs-swiftui.md` (why SwiftUI).
  - `wip/2f-a-paused.patch` is superseded; #410 shipped it.

## Rules this work runs under
- **Ultracode** (a Workflow per phase, with adversarial review between phases) only for big work: multi-PR features, migrations or stored data, sign-in, keys or security, and cross-platform changes. Everything else runs in one thread with one self-review. Keep subagents and screenshots frugal.
- **PRs:**
  - open, fix review comments and merge without asking;
  - merge a PR that touches `ios/` only when the iOS checks are green;
  - develop only on `claude/ios-app-9p05kw`.
- **Prod writes** (the Supabase database or dashboard) need Kirby's typed OK in the thread. If one is refused, say so, offer one retry, then give the SQL inline in a code block. Kirby can't open project files on the phone.
- **Secrets:** never put a secret in `ios/`, a log line or chat.
- **Frozen tables:** never query `tasks`, `habits` or `habit_groups`.
- **Copy:** app copy has no em dashes and no AI-isms, and the AI has no name.
