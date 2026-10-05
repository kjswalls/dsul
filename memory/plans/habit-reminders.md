# Habit Reminders — getting a habit actually done, not merely recorded

**Goal:** close the gap between "the habit exists in dsul" and "the habit happened".
dsul could already reach a device — migration 009's push subscriptions, the eod-notify
cron — but only ever for one moment a day: the end-of-day review, which fires *after* the
day is decided. This adds the moments that can still change it.

**Status (2026-08-23):** All three tiers shipped. Tiers 2 and 3 are **optional
extensions**, off by default, on the migration-026 `user_extensions` surface. An
adversarial review after Phase 1 produced fourteen fixes, folded in before Phase 3
landed — decisions 9–12 below are its output.

Since then, the two follow-ons the first pass deferred have landed: the **pledge
ledger has a reader** (`/ledger`, decision 17) and **Beeminder posts at completion
time** rather than only at settlement (decisions 14–16). Neither needed a
migration.

**Cross-platform (2026-10-05):** [reminders-platforms.md](reminders-platforms.md) is the plan
for reminders on every surface — web/PWA, the Electron desktop, the native iPhone app, Android
and the Apple Watch — and its Phase 0 brings back the two ticks that migration 045 paused, as
one merged job. Nothing in it has shipped; its locked decisions (18 onward) continue the list
below. Read it before touching the scan, the channels, `push_subscriptions` or
`/api/reminders/act`.

---

## The evidence this is built on, and what it rules out

Worth stating, because several obvious features are deliberately absent and the reasons
are not aesthetic.

1. **Forgetting is rarely the failure mode.** For a daily habit, the usual failure is
   seeing the prompt and dismissing it. Louder and more frequent prompts therefore have a
   low ceiling, and fixed-schedule prompts measurably habituate within weeks. This is why
   the last call is *one differently-framed message* rather than a second copy of the cue.
2. **Context cues beat clock cues.** Habits form by pairing a behavior with a stable
   context, not a time. This is the entire reason `reminder_anchor` exists and why it is
   rendered *into* the notification body rather than stored as metadata.
3. **Implementation intentions** ("when X, I will Y") are among the best-replicated
   effects in the literature. The anchor field is one, written in the user's own words.
4. **Friction dominates motivation.** Marking a habit done from the lock screen without
   opening the app is worth more than any wording change — hence the notification action
   buttons and `/api/reminders/act`.
5. **Self-monitoring and loss aversion work; shame does not.** Punishment reliably teaches
   avoidance *of the punisher*, so a scolding notification trains people to disable
   notifications. See the copy contract in `lib/reminders/copy.ts`, which is enforced by
   test, not by good intentions.

**Ruled out on the evidence, not on taste:** escalating nag sequences; guilt copy;
anything aversive (shock wearables and similar have thin evidence and high abandonment —
they teach people to take the device off).

---

## Locked design decisions

0. **The ticks are scheduled by Postgres, not by the host.** `pg_cron` + `pg_net`
   (migration 035) call the two `/api/cron` routes every five minutes, with the app URL
   and the shared secret in Vault. Vercel's Hobby plan rejects any cron more frequent than
   daily *at deploy time*, and five-minute resolution is not a nicety: both jobs exist to
   catch a moment in the USER's local day, so a daily job is right for one timezone and
   wrong for every other. pg_cron was already this project's scheduler (013, re-pointed by
   019 and 024) and is indifferent to hosting plans. The routes stay ordinary
   authenticated GETs, so any other scheduler can still drive them.

1. **`reminder_time` is a local wall-clock string, never a timestamp.** "07:30, every
   weekday, wherever I am standing" is not an instant. `items.reminder_at` (a timestamptz
   inherited by migration 019 and read by nothing) was deliberately left alone rather than
   reused. The one genuine instant in the feature — `reminder_snooze_until` — *is* a
   timestamptz, because "15 minutes from when I tapped it" really is a duration from a
   moment.
2. **NULL means off.** No `reminder_enabled` companion column. A boolean/time pair has a
   fourth state nothing can render (enabled, no time) and, per-item, thousands of rows to
   keep consistent instead of one.
3. **The reminder never re-derives "does this want doing".** `lib/reminders/due.ts`
   composes `isOpenLoopOn` + `isItemActiveOn` from `lib/active.ts`. A notification about a
   habit the grid has already hidden is not a cosmetic bug — it is the app nagging someone
   about a decision they made.
4. **Stamp before delivering.** The opposite of `/api/cron/eod-notify`, on purpose.
   Deliver-first survives a failed write by re-sending, which is nearly free for a push
   (the tag collapses it) and very much not free once a channel rings a phone or costs
   money. The failure is pointed at the cheaper side: one missed cue, not six calls.
5. **The window clamps at midnight, never wraps.** A wrapping window plus a same-day
   dedupe stamp is a double-send: 23:50 fires and stamps day N; at 00:05 the window is
   still open, the date has rolled, and the cue goes out again for yesterday.
6. **The last call names streak-bearing types only.** Its whole frame is what today's miss
   costs; a dated task has nothing to lose by that argument, and including one turns a
   sharp message back into the generic evening nag.
7. **Channels are declarative and isolated.** A channel is a manifest entry plus a
   `deliver()`. It may not throw to signal failure, and one misconfigured integration can
   never stop the push that has worked every day.
8. **A snooze belongs to a DAY, not just an instant.** `reminder_snooze_until` is
   paired with `reminder_snooze_date`, and a snooze whose day is not today is refused
   and swept. Without that gate a snooze goes stale the moment the user completes the
   habit in the app instead of on the notification — and because a matured snooze
   deliberately bypasses both the day stamp and the window, the stale row would fire at
   the first tick after midnight on the next day the habit is due AND stamp that day,
   suppressing the real cue. It also means a snooze tapped at 23:55 expires rather than
   arriving at 00:10 to credit the wrong day: "in 15 minutes" that late is, in practice,
   "not tonight".
9. **Delivery claims, it does not stamp.** Each cue is taken with a conditional update
   (`reminder_sent_date != today`, or a compare-and-swap on the exact snooze value read),
   and only rows the database actually changed are delivered. A blind write is not
   exclusive: two overlapping ticks — which a slow push endpoint and an at-least-once
   cron make possible — would both succeed and both deliver.
10. **`occursOn` mirrors `deriveDayItems` exactly**, including the rule that a
    date-anchored recurring item with no `startDate` occurs on NO day. Unscheduling a
    recurring task to the braindump produces precisely that row, and the looser reading
    nudged daily about something no view renders.
11. **A counted habit is discharged by reaching its target, not by being touched.**
    `isOpenLoopOn` read `dailyCounts[day] > 0`, so one tally of a 3×-a-day habit closed
    the day everywhere — while the row still drew 1/3 and the streak still broke at
    midnight. It now compares against `timesPerDay ?? 1`, which leaves every ordinary
    habit unchanged and makes the grid, the reminder, the EOD review, Beacon and the
    settlement finally agree about what "done" means. Fixed in the predicate, never
    locally in reminders — a second opinion about "done" is worse than the symptom.
12. **One user's failure costs only that user.** The per-user loop has an error boundary;
    the route returns 200 with notes rather than 500, which would silently drop everyone
    later in the list.
13. **Secrets never reach the browser.** Non-secret channel config lives in
   `user_extensions.config` (user-readable by RLS); credentials live in `user_secrets`,
   which is service-role only (migration 012's posture). The settings UI shows *set / not
   set*, never the value.

14. **A Beeminder datapoint goes up when the box is ticked, not when the day
    settles — and the settlement stays anyway.** The settle-only version was
    wrong in a way that costs money: a goal's deadline defaults to midnight and
    the settlement to 03:00, so every completion was reported three hours after
    the goal had already derailed. The graph ended up correct (the `daystamp`
    is right) and the charge did not un-happen. `lib/stakes/live.ts` posts on
    the tick; the settlement is kept as the BACKSTOP for every completion that
    never passes through a browser — the lock-screen action, the agent API, an
    offline tab. The two never coordinate: both claim the SAME ledger row, so
    whichever arrives first does the work and the other finds it committed.
15. **An un-ticked completion withdraws its datapoint.** The ledger row carries
    the datapoint id (encoded into `detail` as `goal#id`, so no migration), and
    an un-tick deletes the datapoint and then the row. Deleting rather than
    tombstoning is deliberate: the row IS the claim on the datapoint, so a
    tombstone would make a re-completion the same day permanently unpostable.
    Without this, a completion taken back leaves a datapoint satisfying the
    goal's rate — which defeats the mechanism far more thoroughly than a late
    datapoint did.
16. **The completion hook lives at the DB boundary, not in the store.** There
    are at least five ways to tick a habit (grid checkbox, bulk verb, item
    panel, EOD review, undo/redo) and every one lands on `setItemCompletion` in
    lib/db.ts. Hooking them individually is a list that would be wrong within a
    month. Browser-only, through a dynamic import, so the two zustand stores it
    gates on never reach the server bundle — `/api/reminders/act` calls
    `reportLiveCompletion` directly with the service client instead, which is
    the lib/push-send.ts rule about not fetching our own deployment.
17. **The ledger is a route, and it is read-only.** `/ledger`, not a settings
    pane and not a dialog: the pledge notification asserts a number and has to
    link to the rows behind it, a pane would make the record a preference, and
    a dialog could not be linked to at all. `stake_events` grants the owner
    SELECT and nothing else (migration 034) — a ledger the subject can edit is
    not a ledger, and there is no "mark as paid" for the same reason there is
    no payment rail. Only PLEDGE MISSES are summed into money: a Beeminder row
    is a datapoint that went up and a partner row is a digest that went out.

---

## Phase 1 — Tier 1, in-app (shipped)

- **Migration 032.** `items.reminder_time` / `reminder_anchor` / `reminder_sent_date` /
  `reminder_snooze_until`; `user_settings.habit_reminders_enabled` /
  `habit_last_call_enabled` / `habit_last_call_time` / `habit_last_call_date`.
- **Registry capability** `remindable` + `isRemindable()` (subtask rule, as `isPausable`).
- **`lib/reminders/due.ts`** — the one definition of "is a nudge owed". Pure.
- **`lib/reminders/copy.ts`** — the words, and the copy contract, under test.
- **`lib/reminders/scan.ts`** — the tick: local clock per user, dedupe, fan-out.
- **`/api/cron/reminders`** — every 5 minutes, registered in `vercel.json`.
- **`/api/reminders/act`** — Done / Snooze from the notification, cookie-authed so RLS
  scopes the write.
- **`app/sw.ts`** — action buttons, tag-collapse, a visible failure when an action does
  not land, and a fixed focus-existing-tab path (the old comparison never matched).
- **`lib/push-send.ts`** — extracted so the scan does not HTTP-POST to its own deployment;
  `eod-notify` was moved onto it in the same change.

## Phase 2 — Tier 2, delivery channels (extensions)

Every one is off by default and gated on a `user_extensions` slug.

- **`voice-announcements`** — Home Assistant `tts.speak` to chosen speakers. The nudge
  lands in the room where the habit happens, which is a better *cue* than a phone.
- **`phone-call`** — Twilio Voice. Materially harder to dismiss without processing than a
  notification.
- **`sms-nudge`** — Twilio SMS. Read rates far exceed push.

## Phase 3 — Tier 3, stakes (extensions)

Where the evidence says the power actually is, once attention is not the bottleneck.

- **`beeminder`** — datapoints per completion; a miss costs real money on their rail.
- **`pledge`** — an anti-charity commitment ledger. **dsul does not move money**; it
  records what is owed and tells you (and optionally a witness). Stated plainly in the UI.
- **`accountability-partner`** — a digest to a person who is expecting it. The mechanism is
  "someone is waiting", not volume.

**The reader.** `/ledger` shows every settled day and what it came to, with the
outstanding pledge total per currency and who it is payable to. Reachable from the
pledge notification (which is the point — the notification asserts a number), from
Rituals → Ledger, and from settings search on "owe". Read-only, by RLS and by design.

**The live path.** `lib/stakes/live.ts` posts a Beeminder datapoint the moment a habit
is ticked, and withdraws it if the tick is taken back. Hooked at `setItemCompletion` in
lib/db.ts (browser) and called directly by `/api/reminders/act` (lock screen). The
nightly settlement stays as the backstop; both claim the same ledger row, so only one of
them ever posts.

---

## Known limitations (accepted, not oversights)

- **iOS does not render notification actions.** WebKit reports `Notification.maxActions
  === 0` and drops the array, so Done / Snooze do not exist on an iPhone PWA — a tap just
  opens the app. Nothing in the platform fixes this; the SMS and call channels are the
  answer for an iPhone-first user.
- **DST spring-forward can drop one cue.** A reminder whose entire `[target, target+grace)`
  window falls inside the vanished hour (e.g. 02:30 in a zone jumping 02:00 → 03:00) is
  skipped that day. Catching it would mean firing the cue at a materially different time,
  which is the thing decision 5 refuses to do. Twice a year, for cues set in one hour.
- **DST spring-forward** is the only clock case left unhandled — see above.

## Deferred / open

- **Counted habits get one cue, not N.** With the predicate fixed, a 3×-a-day habit now
  stays open all day and is named by the last call — but its single `reminder_time` still
  fires once. Most counted-habit apps solve this with either several reminder times per
  item or an interval ("every 3h between 09:00 and 21:00"). `reminder_time` would become
  `reminder_times text[]`; the scan already loops candidates, so the change is mostly the
  picker. Worth doing only if one cue plus the last call turns out not to be enough.

- Whether `remindable` should stay true for `task` (it is today — the cost is zero, since
  the scan gates on `reminder_time is not null`, and the dialog now says so when a task
  has no date for a cue to land on).
- Vercel cron plan limits: two crons at `*/5` needs a paid plan. Phase 3's settlement folds
  into the reminder tick rather than claiming a third slot.
- A per-item "snoozed until" indicator in the UI. The column exists; nothing renders it.
- **Marking a pledge paid.** The ledger reads; it has no way to record that a debt was
  settled, so the running total only ever grows. Doing it properly is NOT an RLS update
  policy (a ledger the subject can edit is not a ledger) — it is a `paid_at` stamp written
  through a service-role route, i.e. a migration plus an endpoint. Worth doing once the
  total is large enough to need clearing.
- The ledger reads the last 180 days with no pagination. A year of daily misses is ~365
  rows, which renders fine; it will want a bound eventually.
- **`/api/reminders/secrets` PUT is a read-modify-write of one jsonb.** The store now
  serialises its writes, which closes the reachable path (it is the only writer, and
  tabbing between two credential fields is what used to race). A second client would still
  race it; the durable fix is a `jsonb_set` RPC.
