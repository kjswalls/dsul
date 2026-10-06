# Deferred settings features — issue drafts

The settings redesign (see [settings-redesign.md](settings-redesign.md)) removes twelve rows
from the settings UI. Most are removed because nothing reads them. **Six of them are removed
because the feature behind them was never built, and we still want it.**

This file holds the issue text for those six, so the intent survives the deletion. Each states
the *real* blocker, verified against the repo — not the row that was standing in for it.

**Five are issues. One is not.** Default view was settled on 2026-08-12 — last-used wins, the
row is gone for good, and what's left is a small cleanup rather than a feature. Its section
stays here because the reasoning is worth more than the row was.

**Filing:** `gh` 2.97.0 is installed but not authenticated, so nothing has been filed yet.
Once `gh auth login` is done against `kjswalls/dsul`, each `##` section below **except
Default view** is one issue (heading = title, body = everything under it).

Suggested order, most-load-bearing first: the EOD cron (a shipped feature that has never once
run), then item reminders (the largest real gap), then morning check time. Notification
preferences depends on there being notifications worth preferring; sound effects is last.

---

## Item reminders — wire `reminder_at`, which has been unread since migration 007

**Removed row(s):** "Habit reminders", "Task reminders" (both were `useState` behind a disabled
switch, resetting on every dialog open).

### What exists already

- `items.reminder_at timestamptz` — added in `007_future_proofing.sql`, carried through
  `019_unified_items.sql` (lines 64, 132, 143). **Never read by any code.**
- Push delivery works end-to-end: `hooks/use-push-subscription.ts`, the `push_subscriptions`
  table (migration 009), and `app/api/push/`.
- `pg_cron` is enabled and proven in production — `purge-deleted-items` has run daily since
  migration 013, repointed at `items` in 019.

### What's missing

1. Nothing ever *sets* `reminder_at`. There is no UI on the item dialog or the docked panel.
2. Nothing ever *reads* it. No scheduled job scans for due reminders.
3. No per-item reminder policy for recurring items — a habit's reminder has to resolve
   per-date against `completedDates`, not against a scalar.

### Design questions to settle first

- Absolute (`reminder_at`) or relative ("15 min before start")? Scheduled items have a start
  time; braindump items don't, which means a relative-only model can't express a reminder for
  an unscheduled item.
- Does a reminder fire for an item already marked complete? (Almost certainly no.)
- One reminder per item, or many? The column shape says one.

### Settings surface once built

A **Rituals** row: "Item reminders" (master), plus a default lead time. Per-item override lives
on the item, not in settings — configure-from-the-object, per the redesign's own rule.

---

## Sound effects

**Removed row:** "Sound effects" — `useState(false)` behind a disabled switch.

### Reality check

There is **no audio code anywhere in the repo**. This is a from-scratch feature, not a wiring
job. Scope it honestly before committing.

### What it would need

1. An asset set. Completion is the obvious candidate; probably also the EOD review closing and
   a drag-drop settle. Three sounds maximum — a planning app that chirps constantly is worse
   than a silent one.
2. A playback layer that respects the autoplay policy: browsers require a user gesture before
   audio can play, and a PWA restored from a background tab has no gesture. Preload on first
   interaction, not on mount.
3. Coupling to `prefers-reduced-motion`? No — that's the wrong signal. There's no
   `prefers-reduced-sound`, so this needs its own setting and should default **off**.

### Settings surface once built

A **Look** row: "Sound effects", off by default, with a volume chip if there's more than one
sound. Should sit next to Reduce motion — both are sensory-load settings.

---

## Notification preferences — decide what may interrupt, and how

**Removed rows:** the "Notifications" master toggle and its per-kind children.

### Reality check

Push *delivery* works. What doesn't exist is any notion of **what is allowed to notify you**.
Today push has exactly one consumer (the EOD review), so a master switch and three children
were describing a policy layer that has no policies to govern.

This issue is blocked on there being more than one thing that can notify. It unblocks the
moment [Item reminders](#item-reminders) or the morning check lands.

### What it would need

1. A `notification_prefs` shape — per-channel (push / in-app) × per-kind (reminder, morning
   check, EOD review).
2. Quiet hours. This is the one people actually want, and it's the reason the master switch
   felt insufficient in the first place.
3. Honest handling of browser permission state. `use-push-subscription.ts` already models
   unsupported / denied / granted correctly — the prefs UI must not offer a toggle that the
   browser will veto.

### Settings surface once built

A **Rituals** group, not a pane: one row per kind, each with an at-a-glance state dot
(Linear's pattern), plus quiet hours. If it grows past ~6 rows it earns a destination record,
not a seventh pane.

---

## Morning check time — build the morning cron it claims to control

**Removed row:** "Check time" under Daily Reviews.

### Why it was removed

The row's description read "When to send your morning reminder." **There is no morning cron.**
`app/api/cron/` contains only `eod-notify`, and `vercel.json` is `{}`. The value was persisted
to `user_settings.morning_check_time` and read by nothing that schedules anything.

The column and its store field are untouched — restoring the row is one manifest entry once
this issue is done.

### What it would need

1. ~~`app/api/cron/morning-notify/route.ts`, mirroring the existing `eod-notify` route.~~
   **A tier of the reminder scan, not a route** (2026-10-06): `eod-notify` itself has been
   folded into `lib/reminders/scan.ts` as its Tier 0 and deleted, and
   `tests/unit/one-cron.test.ts` holds `app/api/cron/` to the one `reminders` route. The
   morning check would be a claim column (say `morning_check_notified_date`, a migration of
   its own), a window from `lib/reminders/due.ts` and a `deliverNudge` with a new
   `NudgeKind`, which voice and SMS decline unless it is added to `REMINDER_KINDS`.
2. A schedule that actually invokes it — see the sibling issue below, which is a prerequisite.
3. Per-user timezone resolution. `user_settings.timezone` is synced from the client; the cron
   must bucket users by local time, not fire once at a server hour.
4. A dismissal interlock. `morning_check_dismissed_date` already exists and stops the in-app
   bar reshowing; the notification needs the equivalent so it can't nag after you've dealt
   with it.

---

## Nothing invokes the EOD cron — `vercel.json` is empty

**Not a removed row** — this is the bug found while auditing the ones that were.

**Resolved, then superseded.** Option (b) below shipped as migration 035 (pg_cron + pg_net,
renamed by 044). Since 2026-10-06 there is no separate EOD cron at all: the review's push is
Tier 0 of the reminder scan behind `/api/cron/reminders`, and `app/api/cron/eod-notify/` is
deleted. The finding below is kept as written.

### The finding

`app/api/cron/eod-notify/route.ts` exists and is written. `vercel.json` is `{}`. **There is no
`crons` array**, so Vercel has never invoked it. The end-of-day notification has never fired in
production.

The in-app EOD review modal is unaffected — that's client-side and works. Only the *push
notification* half is dead.

### Fix

Either:
- **(a)** add a `crons` entry to `vercel.json` pointing at `/api/cron/eod-notify`; note the
  Hobby-plan limit of one cron per day, which may not be granular enough to serve per-user
  review times, or
- **(b)** schedule it through `pg_cron` + `pg_net` instead, which is already proven in this
  project (`purge-deleted-items`, migration 019 line 260) and has no plan-tier limit.

**(b) is probably right** — it's the same mechanism, it can run every 15 minutes without
burning a Hobby cron slot, and it keeps scheduling next to the data. Whichever is chosen, the
same mechanism should carry the morning check.

Verify the route's auth: a cron endpoint reachable without a shared secret is a public trigger.

---

## ~~Default view~~ — DECIDED: last-used wins. Not an issue; a small cleanup.

**Removed row:** "Default view" under Calendar. **It is not coming back.**

### Why it was removed

It didn't just go unread — **the app overwrote it behind your back.**

- `lib/planner-store.ts:1980-1983` — `setViewMode()` sets `defaultView: viewMode` *and* calls
  `saveSettings(userId, { default_view: viewMode })`.
- `lib/view-store.ts:153-157` — `setScope()` calls `usePlannerStore.getState().setViewMode(scope)`.

So every flip of the day/week capsule rewrote the stored "default". Whatever you picked in
settings survived until the next time you looked at a week.

### The decision (2026-08-12)

**Option (a): last-used wins.** dsul opens where you left off, the setting is gone for good,
and the mechanism stays exactly as it is — which is what Things and Notion Calendar do.

The important part: **the behaviour is already correct, and `default_view` is load-bearing.**
It is not a dead column, it is the *cross-device mirror of the last-used view*, and the chain
that makes it work is not obvious:

1. `view-store.scope` is persisted to localStorage and is the startup view on a known device.
2. On a **new** device localStorage is empty, so `scope` falls back to `'day'`.
3. `supabase-provider` hydrates `planner-store.viewMode` from `default_view`.
4. `adoptLegacyViewPrefs()` — which runs whenever `adoptedLegacy` is false, i.e. on any device
   that has never mounted the new shell — copies `viewMode` into `scope`.

So the column is what carries "where you left off" to a second machine. **Do not drop it, and
do not rename it** — a name in `STABLE_SETTINGS_COLUMNS` that the DB lacks makes `loadSettings`
fall through to `DEFAULT_SETTINGS` and silently reset *every* setting for *every* user. The
name is misleading; a comment is the correct price to pay for that, not a migration.

### The cleanup that remains

Small, and purely about deleting a duplicate that no longer means anything:

- `lib/planner-store.ts` — delete the `defaultView` field, `setDefaultView`, the
  `defaultView: view` writes at 744/1981, and the `partialize` entry at 2324. **It has no
  readers**; `viewMode` does all the work. `setDefaultView` has no callers either.
- `components/providers/supabase-provider.tsx:106` — drop the `defaultView:` hydration line.
  Keep line 109 (`viewMode`), which is step 3 of the chain above.
- `lib/view-store.ts:155` — the comment says "planner-store persists default_view", which is
  true but reads like an aside. Say what it is: the cross-device last-used mirror.

Both halves must land together — the store field and its hydration are one type.

**Not done yet:** at time of writing a second session held `supabase-provider.tsx` and
`view-store.ts` with uncommitted edits, so this was deliberately deferred rather than risk
clobbering it.

### Why not the other option

**(b) a real default** — stop `setScope` writing the column, read it on cold start only — was
rejected. It buys a settings row whose whole job is to answer a question the app already
answers better by watching what you do. Recorded so nobody re-derives it. (If it ever comes
back: WCAG 3.2.2 means changing the setting must **not** switch the view you are currently
looking at — it applies to the next cold start, and the copy has to say so.)

---

## Also worth knowing (no issue needed)

These were removed and are **not** coming back — they're recorded here so nobody re-derives
the question:

- **Compact mode**, **Chill mode** — persisted, hydrated, read by nothing. `TaskRow`'s
  `density="compact"` is a literal prop passed by `week-buckets`/`week-schedule`, never
  derived from the flag. Columns and setters stay per the standing rule on deliberately-unread
  settings; the rows do not.
- **`right_sidebar_hover`** — a column with no store field, no setter, no hydration, no reader.
  Leaving it in `settings-service.ts` is free; touching `STABLE_SETTINGS_COLUMNS` is not.
- **`assistantName`** — defaults to `'Beacon'`, read by nothing; chat computes its own display
  name. Wiring it means auditing every hardcoded "Beacon" string.
- **`profile_md`** — onboarding writes it, nothing reads it. The redesign seeds
  `systemPrompt` from it instead, so the text finally reaches `/api/chat`.
