# Instant planner: the look-only preview and its settle

**Status (2026-10-03):** built on `claude/faster-first-load-wpmqt9` in four parts: store
state, snapshot storage and every guard; showing the preview; the settle conductor and
landing shield; e2e and these docs. Read this before touching
[lib/planner-snapshot.ts](../../lib/planner-snapshot.ts),
[lib/planner-snapshot-writer.ts](../../lib/planner-snapshot-writer.ts),
[lib/preview-write-guard.ts](../../lib/preview-write-guard.ts), `lib/settle*.ts`,
[lib/held-captures.ts](../../lib/held-captures.ts),
[hooks/use-deferred-dialog.ts](../../hooks/use-deferred-dialog.ts), anything that reads
`isPreview`, or what `loadPlannerData` returns.

**Goal:** a reload paints the planner at once instead of a skeleton for the 0.6 to 1.7s
the load takes. The fresh load still decides everything. The preview only fills the wait,
and the fresh data replaces it in place, each moved row gliding from where the cache drew
it to where it now belongs.

---

## What the preview is, and what it is not

It is **this browser's copy of the planner as the last session left it**, read from
IndexedDB and painted on `/` while `load_planner` is in flight. The real views render it
(not a picture, not a skeleton), marked `data-preview="true"` and `inert`. When the fresh
load lands it replaces the cached slices in one `set()`, inside the same element tree, and
the settle conductor animates the difference.

It is not:

- **Something you can act on.** Every store write refuses, and nothing on the cached rows
  takes a pointer, focus, drag or hover. Quick capture is held until the load lands; the
  exits and chrome that touches no row stay live.
- **Offline mode.** A failed load drops the preview to today's failure state with Retry.
  Cached rows never survive a failure.
- **On every route.** Only `/`, only on the page's first load attempt, never on Retry.
  The deep-link pages (`/item`, `/goal`, container pages) show "Loading…" while a preview
  reached by client navigation is up.
- **Shared.** It lives in one browser and belongs to one account. No server, other
  device or agent ever reads it.
- **Realtime sync.** There is none. A change made elsewhere arrives with the next load,
  and the settle is how it arrives.

## Lifecycle

1. **Provider mount.** `startPlannerSnapshotWriter()` starts. If `localStateOwner()` is
   null (`/login` after a sign-out), the snapshot is cleared.
2. **Auth effect, before `getSession()`.** On a route that needs items,
   `warmPlannerSnapshot(localStateOwner())` consumes the crash marker if one is present,
   opens the database and prefetches the on-disk owner's record into memory. Nothing is
   painted: the owner stamp is a hint, not a confirmed session.
3. **Adoption.** `adoptLocalState(u)` (a new or different account clears the snapshot,
   which bumps the epoch and voids the prefetch), `identifyUser(u)`, then `loadPlanner(u)`
   calls `initializeStore(u, { preview })`. `loadPlannerData` is called first and
   synchronously, so the fetch starts in the same frame; `offerPreview` then reads the
   snapshot, reusing the prefetch.
4. **Preview applied** (about 5 to 80ms). The read must still own the load (same
   generation and user, still loading, not already previewing, every data slice empty) and
   the apply-time predicate must pass (`pathname === '/'` and no data dialog armed). It
   hydrates the cached custom types, seeds the display-only extension map, sets the crash
   marker, and calls `set({ ...cached, isPreview: true })` under the history suppressor.
   The routers mount the real views, inert. Two frames later SettleHost notes the preview
   as painted. The sync line fades in at 300ms if the preview is still up.
5. **Fresh landing.** `set({ ...fresh, isLoading: false, isPreview: false })`. Inside that
   `set()`, before React commits: the conductor bumps the settle epoch and captures FIRST
   from the preview DOM; the writer removes the crash marker and stamps `base`; the
   deferred-dialog hook promotes; held captures queue their release in a microtask.
6. **Commit.** `inert` lifts and `data-loaded="true"` appears. SettleHost's layout effect
   calls `onLandingCommitted()`: measure LAST, plan, then hold, shield or do nothing. The
   sync line sweeps "done" and unmounts.
7. **About 2s later, at idle,** the writer stores the fresh snapshot.

**Failure:** the catch empties the data slices in the same `set()` as `error`
(`emptyPlannerData()`, after `hydrateCustomTypes([])`). The empty store is then the undo
baseline, so ⌘Z can never replay cached rows against the server. No capture, no settle,
no shield; the sync line vanishes; held captures wait for a successful Retry.

**Crash:** a render that throws while previewing is caught by `PreviewCrashBoundary`,
which calls `dropPreview()` (data empty, `isLoading` still true, so the skeleton shows) and
`clearPlannerSnapshot()`, then renders again. The in-flight load lands normally.

## The state model

`isPreview` sits next to `isLoading` in planner-store and is never persisted.

- It is set in the same `set()` as the cached slices, and only from `offerPreview`
  inside `initializeStore`.
- It is cleared in the same `set()` as the fresh slices, the failure drop,
  `dropPreview()`, or `emptyAccountData()` (sign-out, account switch). No subscriber ever
  sees fresh rows marked as cache, or cached rows marked as fresh.
- `isLoading` stays **true** for the whole preview, so **settled implies not
  previewing**. Everything that already waited for settled or `!isLoading` (the sweep,
  completion filing, the seed, the timezone PATCH, onboarding, the EOD deep link, desktop
  capture, the favicon, Organize create and trash) stays shut with no edits.

[lib/planner-ready.ts](../../lib/planner-ready.ts) gives three readings:

| Reading | Means | Use it for |
|---|---|---|
| settled | the load has finished, success or failure | what it gated before |
| visible | settled, or previewing | mounting views. Display only, never a write gate |
| loaded | settled, no `error`, and `loadFailedUserId !== userId` | every surface that ACTS: captures, notice actions, proposal accept, dialog promotion, the morning check |

Each has a hook (`usePlannerSettled`, `usePlannerVisible`, `usePlannerLoaded`,
`usePlannerPreviewing`), and two have non-reactive reads (`isPlannerPreviewing`,
`isPlannerLoaded`) that tolerate test mocks of the store with no `getState`.

The DOM contract:

- `view-root` keeps `data-loaded` **fresh only**. E2E acts on it, and a persistence spec
  must never pass by reading the cache back.
- `data-preview="true"` and `inert` mark the look-only state.
- Preview to fresh is the same element tree. Never key anything on settled or previewing:
  the settle needs row identity and scroll position to survive the swap.

A store subscriber that infers intent from a slice changing must skip the preview's edges.
`view-store`'s `remapRefs` and `use-trashed-names` both return when `prev.isPreview`: a
landing that replaces cached names with the server's is a load, not a rename.

## The write barrier

[lib/preview-write-guard.ts](../../lib/preview-write-guard.ts) wraps the planner store at
creation: `return guardPreviewWrites(store, () => get().isPreview)`. While previewing,
every function member not in `PREVIEW_ALLOWED_ACTIONS` returns without running (a
dev-only console warning names it). It is **deny by default** and checked at call time, so
an action added tomorrow is refused without anyone remembering this file.

The allowlist is 27 exact names, never a prefix (`setItemsCompleted`, `setItemPaused` and
their siblings share `set*` with the view setters):

- lifecycle: `identifyUser`, `initializeStore`, `clearStore`, `clearUserScopedState`,
  `refreshActionLog`, `dropPreview`;
- readers: `getProject`, `getProjectColor`, `getProjectEmoji`;
- view state: `setSelectedDate`, `setViewMode`, `setGroupBy`, `setFilters`,
  `clearFilters`, `setTimelineItemFilter`, `setNavDirection`, `setHoveredItem`;
- preferences (user settings, never planner rows): `setCompactMode`, `setChillMode`,
  `setShowCurrentTimeIndicator`, `setShowCompletedTasks`, `setShowPausedOnGrid`,
  `setDefaultView`, `setDefaultTimeBucket`, `setAnimationsEnabled`, `setWeekStartDay`,
  `setTimeFormat`.

Undo and redo are refused: they would replay history against cached rows.

A refused action returns `PREVIEW_REFUSALS[name]`, else undefined: `''` for the
id-returning creates, `null` for `addProject`, `'refused'` for the seed, `0` for
`applyProposal`. A caller that uses a returned id must read `''` as nothing made (the item
dialog's inline routine, season and goal creates check it before toggling).

**To allow an action:** it must never write a planner row and never compute anything from
the cached rows. Add the name to `PREVIEW_ALLOWED_ACTIONS` and to the inline literal in
`tests/unit/preview-write-guard.test.ts`, which pins the list so that widening it is a
visible decision in review. A new non-void action that stays refused needs an entry in
`PREVIEW_REFUSALS` whose value its callers already read as "nothing happened".

Not covered, by design: direct `setState` writers (settings hydration in the provider, the
history helpers). None of them is a user verb.

## The guard list

The barrier is the data-safety backstop. The rest makes sure nothing on screen is a
silent no-op, and that nothing decided on cached rows runs after the landing.

### Chokepoints

- **The write barrier**, above.
- **ui-store** ([lib/ui-store.ts](../../lib/ui-store.ts)). While previewing, `openDialog`
  on one of the five data slots (`PREVIEW_DEFERRED_SLOTS`: `add`, `edit-item`,
  `new-container`, `bulk-add`, `organize`) stores the request in `deferredDialog`
  instead; the last request wins. `closeDialog` leaves the deferral alone, because the
  launcher closes itself right after running "Open Organize". `confirm` refuses while
  previewing on `/`, where every confirm guards a data action.
- **Promotion** ([hooks/use-deferred-dialog.ts](../../hooks/use-deferred-dialog.ts)),
  mounted once in AppShell. On the preview's end it opens the request only after a
  successful landing for the same account, into a free slot with no confirm up. An
  `edit-item` is re-resolved to the fresh row (dropped if the row is gone, keeping the
  payload's type stamp); a `new-container` keeps only the `itemIds` that still exist. A
  failure, a crash drop, an account change and leaving `/` all drop it.
- **Commands** ([lib/commands/types.ts](../../lib/commands/types.ts)). While previewing,
  `isAvailable` is false for every command in the `create`, `items`, `rituals` and
  `history` groups, plus `workspace.selectAll` and `goto.overdue`. It is a group rule
  because availability defaults to true. The `app.*` console doors stay live; ui-store
  defers what they open.
- **`inert`** on the canvas view-root (both routers), the braindump's row body and paused
  strip, and Zen's `<main>`. Not on the braindump section, its scroller, the notice slot
  or the quick-add, and not on the Zen room, so the exit stays live. `inert` blocks
  `mouseenter`, so the hovered-item ref stays null and the shell's `e` and `⌫` do nothing.

### Surfaces that act, gated on loaded

- **Quick capture** (the braindump's QuickAddRow Enter, the omnibar's `+`) goes through
  `captureTask()`. See "Held captures".
- **The braindump's ＋**, with text typed and the planner not loaded, keeps the text and
  focuses the field rather than open a dialog that would be deferred or dropped.
- **The sweep receipt and the EOD notice** stay mounted, so nothing is inserted
  mid-settle, but their actions read "Syncing…" with no `onSelect`. Dismiss stays live.
  This also closes a cold-load hole: "Put back" over an empty store spent the only receipt
  on nothing.
- **The morning check** stays hidden until loaded.
- **Proposal accept** returns 0 before `claim()`, so the card stays and can be accepted
  after the landing.
- **The deep-link pages** (`/item/[id]`, `/goal/[id]`, the container pages) look up their
  entity only once settled. The inline editor autosaves and the container toggles write
  at once.

### Deliberately unchanged

The unattended writers already gated on settled or `isLoading`. Drag end, `edit_hovered`
and `delete_hovered` (no drag starts on an inert row, the hovered ref is null, and the
chokepoints backstop them). The bulk bar (no selection can form). Chat send (proposals are
re-validated at accept). Settings hydration (this device's preferences paint the
preview).

## Held captures

[lib/held-captures.ts](../../lib/held-captures.ts). Quick capture is the one write made
without looking at a row first, so it is the one most likely to be typed during a load.
`captureTask(title)` adds at once when loaded. Otherwise it queues `{ userId, title }` and
returns `'held'` (or `'dropped'` when there is no user). The field clears, and "Adds once
synced" (`data-testid="quick-add-held"`) shows while the current account has captures
waiting.

- **A module queue**, so it outlives the field: the launcher closes on Enter, and the phone
  remounts the dock per tab.
- **Bound to the account.** Entries for any other `userId`, sign-out included, are dropped
  on the next store change.
- **Released in a microtask** after the next successful landing, so it runs after
  `initializeStore` releases the history suppressor: each capture gets its own undo entry,
  in the order typed. The settle hold absorbs those commits, so the rows type in with the
  landing. The subscription is made on the first hold and dropped when the queue drains.
- **Title only, on purpose.** No other verb is queued: one decided on cached rows may mean
  something else by the landing.
- It also fixes an older loss: a capture typed during a plain cold load used to be erased
  by the landing `set()`.

Two consequences live outside the module:

- The first-run seed decides on the account's items **without** the captures the release
  filed (`withoutReleasedCaptures`, applied in the provider's seed snapshot). Otherwise a
  capture typed into a brand-new account reads as existing data, and the account latches
  with no starter set.
- `seedStarterContainers` patches **every** history snapshot with the seeded projects, not
  only the current one, so undoing a held capture can never soft-delete the starter set.

## The snapshot

### Storage

[lib/planner-snapshot.ts](../../lib/planner-snapshot.ts). IndexedDB database
`dsul-planner-cache`, version 1, one object store `snapshots`, two keys per account:

- `${userId}`: the record, `{ v, origin, userId, baseAt, savedAt, data }`. `data` is the
  six slices (`items`, `projects`, `itemTypes`, `routines`, `seasons`, `goals`), the three
  availability flags and, optionally, `extensionsEnabled`.
- `${userId}#base`: `{ baseAt }` alone, so the newer-base check never deserializes a
  record that can be a megabyte.

Every write `clear()`s first, so at most one account is on disk. IndexedDB, not
localStorage: a large planner in the shared localStorage quota would make every zustand
`set()` throw on the day it filled.

Nothing in the module throws or rejects, and every entry point is a no-op without
IndexedDB (the server, jsdom, locked-down browsers). It imports only `@dsul/types`, so
local-state and planner-store can both import it. `tests/unit/local-state.test.ts` pins it
as the only file that calls `indexedDB.open` or `indexedDB.deleteDatabase`, and lists its
sessionStorage marker in the `setItem` audit.

### The version, and when to bump SNAPSHOT_FORMAT

`SNAPSHOT_VERSION` is `` `${SNAPSHOT_FORMAT}:${fingerprint}` ``, matched exactly. A cache
discards; it never migrates. The fingerprint is FNV-1a over the field lists in
`@dsul/types` (`TASK_FIELDS`, `HABIT_FIELDS`, `PROJECT_FIELDS`, `ROUTINE_FIELDS`,
`SEASON_FIELDS`, `GOAL_FIELDS` and `ItemTypeDefSchema`'s keys), so a key added, removed or
renamed invalidates every cache by itself.

What a key **means** is `SNAPSHOT_FORMAT`'s job, and a ledger test enforces it. In
`tests/unit/planner-bundle.test.ts`, awkward rows plus one full row per kind run through
the real `loadPlannerData`, and the output's hash must equal
`MAPPER_OUTPUT_BY_FORMAT[SNAPSHOT_FORMAT]`. Any change to that output fails it: a mapper
fold, a new default, a renamed enum value, a new field, or an edit to the fixtures
themselves. When it fails:

1. Bump `SNAPSHOT_FORMAT` in `lib/planner-snapshot.ts` by hand.
2. **Append** the new hash under the new number. Never edit an existing entry: it names
   what old caches on users' disks still carry.

A bump costs every user one cold load and nothing more, so bump when unsure. It is also
the global invalidation switch.

### Ownership, origin, TTL and baseAt

`isValidSnapshot` runs on every read and requires:

- `v` equal to this build's version, and `origin` equal to `NEXT_PUBLIC_SUPABASE_URL` (dev
  can point one browser origin at prod or at the local stack);
- `userId` equal to the account being loaded;
- `baseAt` less than 7 days old and no more than 5 minutes in the future;
- every list an array of objects with a string `id`, and the three flags booleans.

A malformed `extensionsEnabled` is stripped rather than rejecting the planner. A record
that fails is deleted.

`baseAt` is when **this tab** last fetched the planner fresh (stamped on a successful
landing, Retry included), not when it saved. The TTL runs from it, and a write whose base
is older than the stored one is refused inside the same transaction, so a days-old tab
(Electron hides to the tray) cannot overwrite a fresher tab's copy.

A module **epoch**, bumped synchronously by every clear, drops any read, prefetch or
write already in flight. The IndexedDB clear is async and a sign-out's hard navigation can
abort it; the epoch cannot be outrun.

### Writing

[lib/planner-snapshot-writer.ts](../../lib/planner-snapshot-writer.ts), started once by
the provider. A new reference on any data slice, or a change to the extension toggles once
they have loaded, marks it dirty. Two seconds after the last change, at idle
(`requestIdleCallback`, else a macrotask), it writes the store as it stands then. Hiding
the tab or `pagehide` flushes at once.

It writes only when `snapshotWritable` holds: loaded, not previewing, this user owns
local state, `base` belongs to this user, and at most 5000 items. A refused write stays
dirty for the next chance. The extension toggles ride along only once they have loaded for
this user. So it never writes `identifyUser`'s empty store, a lean route, a failed load,
the preview itself, a previous account after a cross-tab switch, or anything a clear has
overtaken.

### Clearing

- `clearPlannerSnapshot` is in local-state's `RAW_CLEARERS`, so it runs from
  `adoptLocalState` (a first or different owner), `clearUserScopedLocalState` (sign-out)
  and the cross-tab `storage` listener.
- The provider clears at mount when nobody owns local state (`/login` after a sign-out
  whose clear the navigation aborted) and on the no-session branch (an expired or revoked
  session).
- The crash boundary and the crash marker clear it.
- A read that finds an invalid record deletes that user's two keys.
- Under `off`, the writer deletes the whole database at start and every clear deletes it.

With no connection open in this page, `clearPlannerSnapshot` **deletes the database**
rather than open it to clear it. An open would create the database in every browser that
never signed in. IndexedDB runs opens and deletes in request order, so a later read still
finds nothing. With a connection open it clears the store instead. Each connection closes
itself on `versionchange`, so another tab's delete is never blocked.

### Crash recovery

Two layers, because a cached planner must never be able to break the app.

- **The boundary.**
  [components/shell/preview-crash-boundary.tsx](../../components/shell/preview-crash-boundary.tsx)
  wraps AppShell in `app/page.tsx`. A throw while previewing drops the preview and the
  snapshot and renders again; the retry has no preview left to drop, so a second throw is
  rethrown. Any other throw is rethrown to the next boundary up, exactly as before.
- **The marker.** sessionStorage `dsul-preview-pending` (tab-scoped, holds `'1'`) is set
  just before the preview `set()` and removed by the writer on every `isPreview` true to
  false edge. If it is still there at the next warm or read, the last preview never ended
  (a throw above AppShell, a hang): the snapshot is purged and the preview skipped once.

## The extensions preview map

Grouping by goal, streak flames and the other extension-gated display would otherwise
paint from defaults and regroup mid-preview, un-animated. The snapshot carries the user's
sparse toggles, and the preview seeds `previewEnabled` in extensions-store (refused once
configs have loaded, when the table is unavailable, or for another user). The display
gates in [lib/extension-gates.ts](../../lib/extension-gates.ts) read
`previewEnabled ?? enabled` through `gateMap`. `isEnabled()`, which Beeminder live and
confetti read, never sees it, and every outcome of `hydrate` sets it back to null.
Seeding `enabled` itself would let a cached toggle beat server truth.

## The settle conductor

[lib/settle.ts](../../lib/settle.ts) (DOM, timing, the shield),
[lib/settle-plan.ts](../../lib/settle-plan.ts) (pure planning),
[lib/settle-epoch.ts](../../lib/settle-epoch.ts) and
[components/shell/settle-host.tsx](../../components/shell/settle-host.tsx). A hand-rolled
WAAPI FLIP with no dependency and no overlay. Transform and clip-path only, fill
`backwards` and never `forwards`, on the participants' own boxes: nothing fades lime,
nothing escapes a scroller's clip, and nothing outlives the run to trip dnd-kit, Zen's
trace or hover-expand.

SettleHost is mounted once at AppShell's top level, outside the desktop, mobile and Zen
swap. It registers the conductor's store subscription (live only while a host is mounted,
and counted, so StrictMode cannot strand it), notes the preview as painted two frames
after it commits, calls `onLandingCommitted()` from a layout effect on the true to false
edge, and holds the one `role="status"` ("Showing your last session. Syncing…").

### Participants

Declarative, tracked by key and never by element, re-queried every pass.

- **Scopes** (`data-settle-scope`): `canvas` on view-root in both routers; `braindump` on
  the whole `<section>`, because the paused strip and the quick-add are its flex siblings;
  `zen` on the room root.
- **Rows** (`data-settle-key`, the default role). TaskRow and ScheduleBlock, both
  variants, key `${dateStr}|${item.id}`: one habit in seven week columns is seven rows,
  and a task timed elsewhere glides from its Anytime row into the grid. Braindump rows key
  `|${item.id}`, since they have no day of their own. Zen ledger rows key `zen:${id}`; the
  hero `h1` keys `zen:hero:${id}` or `zen:hero:none`. Rows carry `data-item-id`, except
  the Zen hero, on purpose: a changed hero should leave and arrive in place, not pair with
  a ledger line.
- **Frames** (`data-settle-role="frame"`): GroupSection `group:*`, BucketCard `bucket:*`,
  ProjectBlock `project:${id}`, the week-list day `day:${date}`, both schedule grids
  `grid`, hour slots and cells `hour:${h}`, now markers `now`, the week gutter (`gutter`,
  `gutter-hour:${h}`, `gutter-now`), Zen's `zen:hero` and `zen:ledger`, and the
  braindump's `braindump:paused` and `braindump:quickadd`.
- A frame's key is qualified by its nearest frame ancestor's key, else its `[data-date]`
  (seven columns each have an `hour:9`). Repeats get `#2`, `#3` in DOM order. On a phone a
  row animates its SwipeRow box (`[data-sink-row]`).
- A row's change signature is its squeezed text plus `data-row-variant`,
  `data-completed`, `data-suppressed`, `data-bucket`, `data-start-time`, `data-start-min`
  and `data-duration`. Never `data-selected`.
- Only visible nodes count or animate: a node must intersect the scope's box, the viewport
  and every clipping ancestor. An 800-row braindump animates the 25 or so on screen. A
  scope with more than 2000 participants is not settled at all.

**To add a participant:** put `data-settle-key` on it (and `data-settle-role="frame"` for a
container that moves as a whole); keep the key stable from preview to fresh and unique in
its scope without the `#n` fallback; give a row `data-item-id`; and extend
`tests/unit/settle-participants.test.tsx`, which mounts the real views and pins key shapes,
uniqueness, and that every signature attribute is written somewhere. Never give a
participant a resting `transform` or `clip-path` the run would have to fight, and never an
opacity.

### Treatments

`planScope(first, last, limits)` runs per scope.

| Change | Treatment |
|---|---|
| Move: matched, own displacement of 1px or more | `translate(dx, dy)` to zero, 420ms, composite `add` |
| A row that grew | a clip reveal of its new extent, alongside the move |
| A frame of rows that grew | a bottom-edge clip reveal on the rows' curve |
| Appear, row | clip type-in left to right plus a 4px lift, 340ms, after 100ms plus 24ms per rank (rank capped at 6) |
| Appear, frame | clip unfold top down plus a 3px drop, 340ms, after 80ms |
| Retype: in place, signature changed | clip type-in from the first changed character, 300ms; the first 12 by position |
| Exit | nothing: counted, never animated; the neighbours glide into the gap |
| Large | lists emptied; the visible top-level nodes rise 6px, 320ms, 24ms cascade (rank capped at 8) |

- A move's own delta is net of its nearest animated ancestor's, so nested moves compose
  exactly: one duration, one curve.
- **A retype starts where the text changed.** Capture keeps each visible row's raw
  `textContent` beside its signature, and the plan carries the first index at which FIRST
  and LAST differ (`SettleRetype.at`). At the hold, with nothing in the scope animating,
  the conductor walks the row's text nodes to that index and reads one character's rect
  with a single Range: the clip starts at that character's left edge (past the end, when
  the text was cut short, at the last character's right edge) and opens to the bleed. The
  checkbox and the unchanged prefix are never blanked: "Draft the Q4 plan" growing "with
  Maya's notes" types in only the addition. A change in a later text node (a duration)
  starts there. A character that is not drawn (inside `display: none`) falls back to where
  the text starts. The whole row types in, as before, when the text is the same and only an
  attribute changed (a tick), or when no Range geometry is available (jsdom).
- A row whose key changed is still a move when its item id is unmatched exactly once on
  each side. A task rescheduled Monday to Wednesday glides across the columns; a recurring
  item drawn on several days stays unpaired.
- Anything under an appearing frame rides that frame's unfold, with no appear and no move
  of its own.
- **Large** when row moves plus row appears plus row exits exceed 48, appears plus exits
  exceed 24, or the animations would exceed 300. Frame moves never count toward the row
  threshold, so a range change that slides some 130 hour cells is still fine.
- The curve is `cubic-bezier(0.22, 1, 0.36, 1)`, spelled-out `--ease-out-soft` (a test
  pins the pair). Moves (the glide, the grow and frame reveals that ride it, a retarget's
  re-aim) read `SETTLE.moveMs` and `EASE_MOVE`, which is `EASE_SETTLE` today and exists so
  the glide can be tuned alone; appears, retypes and rises stay on `EASE_SETTLE`. The
  worst case ends about 584ms after play, and a test keeps it, whatever `moveMs` is, under
  the sink-hold's 700ms. Every number lives in `SETTLE` in `lib/settle-plan.ts`, and a
  test pins each one.

**Stacking, for the run only.** FLIP draws a box where the stacking order of its NEW
place says, which showed twice in a recording of Day × Buckets. Both are inline values
written at the hold (and added to, never taken away, by a retarget) and put back exactly
as found by `finishSettle` or a scope's snap, on every exit. The whole list of what a run
writes outside its animations: `z-index`, `position: relative`, `background-color` and
`background-clip`.

- **Raise.** A row retimed Afternoon → Morning lives in Morning's card from the landing,
  and every card root is `relative isolate`, so the later Afternoon card painted over its
  glide until it surfaced over the Afternoon caption. The raise goes on the OUTERMOST
  ancestor whose LAST box does not hold where the row starts: the child of the lowest
  ancestor that does, which is the box that must paint above whatever sits at the row's
  old place. Each ancestor is judged in its own frame (what the animating boxes between
  add), so a frame that glides with its rows needs nothing. It is raised only when
  something on the way traps the row's paint, a stacking context or a box animating in the
  run (its transform or clip makes it one); otherwise the row already paints where its old
  place does. In Day × Buckets that box is `div[data-dnd-bucket]`, the card's wrapper,
  which is a flex item of the canvas column, so z-index applies with no position.
  Raising the card itself was the second recording's bug: each card is the only child of
  its wrapper, so "above its siblings" compared it with nothing, both cards got
  `z-index: 1`, and tree order put Afternoon (whose own rows had moved too) back over the
  row for three frames.
- **One order per scope.** Every raised and lifted box in a scope is ranked together by how
  far its rows travel, the farthest highest and equal travel sharing a level, above the
  resting z-index of every sibling. Two of them in one stacking context compare by
  z-index wherever they sit in the DOM, so cousins are ranked too.
- **Position.** A static block that is not a flex or grid item takes `position: relative`
  for its z-index. Where that would re-anchor an absolutely positioned descendant (one with
  no positioned box between them), the raise steps down toward the row to the first box it
  is safe on, and is dropped at a stacking context it is not safe on. In the real views it
  never steps: the boxes it lands on are flex items (bucket wrappers, the week's cells and
  columns), already positioned (BucketCard, ProjectBlock), or static blocks with no such
  descendant (GroupSection, the week list's day; TaskRow is `relative`, so nothing under it
  counts).
- **Lift** (`SETTLE.liftRows`, on). Rows have no ground of their own, so a row gliding past
  others overprinted their text. A row whose own move is longer than its height is stacked
  above its siblings and given the background of its nearest painted ancestor inside the
  scope (a row with a ground of its own, like a selected row's wash, keeps it), clipped to
  its content box. TaskRow is a flex row with `py-1.5` (`py-1` compact), centred, with a
  line-clamped title, so its content box is the band its checkbox, title and rail live in;
  a full-height ground sliced the top off the neighbour a row was settling against, in the
  glide's tail (about 160 to 240ms in), where the row sits a few pixels short of its slot.
  Two rows' text bands meet only once they overlap by more than both paddings (12px by
  default), which is where hiding the one beneath is right. The ground goes on the row
  itself and the z-index on its box, which differ on a phone (the SwipeRow, which has no
  padding to clip to). Where nothing inside the scope is painted, as on the plain canvas
  (its ground is `<main>`, outside view-root), it is stacked and given no ground.

Neither touches opacity, filter, transform or a custom property, and nothing is written
where nothing animates.

### Hold, play, retarget

1. **Capture**, inside the landing `set()` and before React commits, only when the preview
   was painted, the landing is loaded for the same user, and the tab is visible. It runs
   whatever the motion setting, because the plan also drives the shield.
2. **Landing**, in the layout effect: clear the hovered-item ref (the rows moved under a
   still pointer), measure LAST, and plan each scope still in the document.
3. **Hold.** Every animation is created and paused at zero, so the first painted frame
   still shows the preview geometry, and `html[data-planner-settling]` goes up. Follow-up
   commits (held-capture adds, the sweep's batch, `useFitHourPx`, the week anytime band's
   ResizeObserver) re-measure and re-plan against the same FIRST. Play starts once two
   frames pass quietly, after 2 to 8 frames. If rAF starves for 400ms the run ends and the
   changed scopes are shielded.
4. **Play**, and **retarget** a scope whose DOM changes mid-glide: measure where its boxes
   are drawn, cancel that scope's translates (its clip reveals keep running), and glide on
   from there over at least 220ms. Twice per scope at most. Past that, or past 300
   animations, the scope snaps (shielded if it was still moving) and the others play on.
5. **Finish** at the last animation's end plus 50ms, and never later than 1400ms after the
   landing: every animation cancelled, observers and listeners dropped, and the attribute
   removed unless a shield is still up.

**A landing that changed nothing still runs.** Its follow-up commits are the only change,
so it watches the hold window and settles them, or shields them under a veto. It raises no
attribute unless something animates.

**What counts as a commit.** One MutationObserver per scope stays connected through the
run, but most records move nothing: a hover writing `--title-mask`, the ScrollArea mounting
its scrollbar or restyling its thumb on a wheel frame. A record re-holds or retargets only
if something moved. Participants are re-resolved only for child-list changes and the
attributes a participant is resolved from; positions are compared net of the run's own
translates and of scrolling since the last pass; signatures are compared during the hold
only.

**Scroll is never an interrupt.** Every animation is relative to its own box. Each pass
records which scrollers carry each box (a sticky box holds its pinned axis, like the week's
Anytime head and hour gutter) and where they stood. A re-hold plans against FIRST as
scrolled since the landing, and a retarget against LAST as scrolled, so scrolling mid-settle
neither jumps a row back nor counts as a change.

### Vetoes and interrupts

Motion is allowed only when all hold: `PREVIEW_MODE === 'on'`; neither reduced-motion veto
(`prefersReducedMotion()` reads the OS query and dsul's `data-reduce-motion`, the in-app
animations toggle); the tab is visible; `element.animate` exists; no drag is active;
`navDirection` is null; Zen is not moving. It is asked at landing, at play and on every
commit, so a veto that lands mid-run snaps the run and shields. Vetoed from the start, the
run still starts but only watches, shielding whatever each follow-up moves.

Interrupts end the run: `pointerdown` (capture phase), `keydown`, `resize`, the tab hiding,
a drag starting, Zen opening, closing or starting to move, `navDirection` set, and
`selectedDate` changing to a different instant.

### The landing shield

A click aimed at a preview row must never tick, or post to Beeminder, on whatever fresh row
is under the cursor now. So a scope that changed with nothing holding its old geometry
swallows pointer activations for 250ms. That covers reduced motion, `static` mode, a veto
at play or mid-run, a large-mode scope, a scope snapped by a retarget, and a starved hold.
A fine scope that is animating is not shielded: its rows are drawn where the eye aims.

- Window capture-phase listeners for `pointerdown`, `mousedown`, `click`, `dblclick`,
  `contextmenu` and `auxclick` call `preventDefault()` and `stopImmediatePropagation()`
  inside a shielded scope. That runs before React's root listeners and dnd-kit, and the
  prevented `mousedown` keeps focus where it was.
- **Each scope keeps its own clock.** A later shield on another scope never stretches it.
- **A press holds its scope.** A `pointerdown` swallowed inside the window keeps that scope
  shielded until its click has passed: 100ms after the `pointerup`, or 2s if it is never
  let go. A `pointercancel` frees it. A shielded press also ends a live run.
- A `pointerdown` that interrupts the run shields its scope only if that scope was still
  moving. A press in a scope the landing left alone just cancels the settle.
- **Exempt:** keyboard clicks (`detail === 0`, Enter or Space on a focused control, aimed
  at the focus ring and never at something that moved) and text fields (textarea,
  contenteditable, inputs that take typing). A text field ticks nothing, and a press that
  could not focus it would hand the typing to the single-key shortcuts.
- The attribute stays up while a shield runs. E2E's `waitForAppReady` waits for
  `html:not([data-planner-settling])` after `data-loaded="true"`, so every `reloadApp`
  exercises the preview and the settle.

### Sink-hold

The completed-sinks hold ([hooks/use-sink-hold.ts](../../hooks/use-sink-hold.ts)) would
take a completion that differs between preview and fresh for a live tick and slide the row
again 700ms later. The conductor bumps the settle epoch on every preview end, whatever the
outcome; on a new epoch the hook adopts every row as it now is, with no hold. The hook's own
slide now uses the shared `prefersReducedMotion()`, so the animations toggle reaches it too.

## The sync line

[components/shell/planner-sync-line.tsx](../../components/shell/planner-sync-line.tsx),
styled under "Planner preview: sync line" in `app/globals.css`. A neutral 2px hairline on
the desktop canvas `<main>`, the mobile content area and the Zen room. It is never lime,
nothing else on the canvas dims, and it is `aria-hidden` (SettleHost makes the one
announcement).

- Invisible for its first 300ms (a CSS delay), so a warm load never flashes it.
- It ends in "done" (a fill sweeps across, then fades) only over a successful landing it
  was visibly up for. A failure, a crash drop, an account change, reduced motion or a
  landing inside 300ms remove it at once.
- Syncing to done happens on the same element in the same render (state adjusted during
  render, not in an effect), so the root's fade-in never restarts. In the done state the
  CSS animates only the track and `::after`, never the root.
- Done ends on the `planner-sync-done` `animationend`. A 420ms timer, started two frames
  after the landing, is only the backstop.

## The kill switch

`NEXT_PUBLIC_PLANNER_PREVIEW`, read once as `PREVIEW_MODE` (trimmed and case-folded;
absent or unknown means `on`). It is a literal `process.env` reference so Next inlines it,
which also means a change is a Vercel env edit plus a redeploy. Set it on Preview
deployments first, then Production.

| Value | Effect |
|---|---|
| `on` | Preview, sync line, settle and shield. |
| `static` | Preview and sync line, an instant swap, and the shield on whatever changed. Use it if the settle misbehaves. |
| `off` | No read and no write; the writer deletes the database at start, and every clear deletes it. Use it if the preview itself misbehaves. |

Bumping `SNAPSHOT_FORMAT` invalidates every cache at once. Per user, the animations toggle
turns the settle off and leaves the shield on.

## The retirement rule

**Never retire this by a plain revert.** Only this code ever deletes `dsul-planner-cache`,
and the database is a disclosive copy of every title and note. A revert strands it in
every browser that ever ran the feature.

1. Ship `NEXT_PUBLIC_PLANNER_PREVIEW=off` and keep it for several weeks, so every active
   browser loads a build that deletes its database.
2. Only then remove the code, and keep a one-line boot shim in the provider:
   `try { indexedDB.deleteDatabase('dsul-planner-cache') } catch {}`.

The database name is an on-disk contract for that shim. Renaming it is a migration, not a
refactor; `tests/e2e/helpers/preview.ts` re-types it rather than importing it so that a
rename breaks loudly.

## Where the build departs from the design

The design went through three critiques before the build. These are the places the code
chose differently, each for a reason found while building or testing it.

**The conductor**

- **A landing that changed nothing still runs** and watches its follow-ups. The design
  returned when every plan was `none`, which let a held capture's row (committed just
  after the landing) appear with no settle and no shield.
- **Vetoed motion still starts a run,** with `animate: false`, purely to shield what each
  follow-up commit moves.
- **The no-op mutation filter.** The design re-held or retargeted on any mutation in a
  scope. Hover writes, the ScrollArea's scrollbar mount and its thumb restyling on every
  wheel frame re-aimed the glide and spent the two retargets, snapping on the third. Now
  only a record that moved something counts.
- **The scroll carry.** The design only removed scroll from the interrupts. Without a
  carry, a re-hold or retarget after a scroll read the scroll as layout motion and jumped
  rows back. Rects are now carried by their scrollers, sticky axes held.
- **Retarget overflow** (past two, or past 300 animations) snaps the scope and shields it
  if it was still moving. The design only cancelled the scope's animations.
- **A starved hold** shields the changed scopes rather than just finishing.
- **A veto that lands mid-run** (the animations toggle arriving from the server, a Zen
  wave) is checked on every commit, not only at play.
- **The pointer interrupt** shields only a scope that was still moving. The design shielded
  any scope the press landed in, which swallowed clicks in scopes the landing never touched.
- **The shield keeps a clock per scope,** tracks presses by pointer id until their click
  has passed (100ms grace, 2s cap), and exempts keyboard clicks and text fields. The
  design used one 250ms window for all scopes, so a long press outlived it and its click
  landed on the fresh row, and Enter on a focused control or a click into a text field
  was swallowed for no reason.
- **SettleHost** calls `onLandingCommitted()` only on a true to false edge. A mount is not
  a landing.

**The plan**

- **The bottom-edge reveal for grown frames.** Not in the design. A frame of rows that
  grew took its new height in one frame, an empty band under rows still gliding in. It now
  uncovers the height on the rows' curve, never more than lies below both its old height
  and where the rows inside it started, and not at all when content would hang out past
  the clip bleed. A shrink cannot be held this way, and is not.
- **Rows ride an appearing frame's unfold.** The design suppressed only their appears; a
  row that moved into an appearing frame now gets no move either, since its glide would
  only show through the unfold's clip.
- The move's own delta is net of the nearest **animated** ancestor; appear ranks are
  counted per role; the key deduper guards against a raw key that already ends in `#n`.
- **Raise and lift** (see Treatments). Not in the design, which kept every write to
  transform and clip-path. A real-browser recording showed a row hidden behind the next
  bucket card for half its glide, and texts overprinting as rows crossed. A second one
  showed the raise tie between cousin cards, and the lift's full-height ground slicing a
  neighbour; the raise moved to the outermost box with one order per scope, and the
  ground to the content box.
- **Retypes start at the first changed character.** The design typed the whole row in,
  checkbox included, so a renamed row went blank at the landing and its unchanged title
  typed in again.

**Participants**

- Braindump rows key on the id alone: their `dateStr` is just the selected day and says
  nothing about the row.
- The Zen hero `h1` carries no `data-item-id`, so a hero that changed leaves and arrives in
  place instead of pairing with a ledger line. The ledger rows carry it.

**The sync line**

- Done ends on the sweep's `animationend`, with the 420ms timer started two frames after
  the landing as a backstop. A timer started at the landing lost its margin to the
  landing's own synchronous work and cut the sweep mid-fade.
- The phase changes during render rather than in an effect, which would have committed a
  frame of nothing between syncing and done and restarted the fade-in.

**The snapshot**

- **`clearPlannerSnapshot` deletes the database when no connection is open** in this page,
  instead of opening one to clear it. The `/login` purge, the no-session purge and a first
  adoption otherwise created an empty database in every browser that never signed in.
- `warmPlannerSnapshot(null)` opens nothing, for the same reason: an unowned browser's
  adoption clears before any read anyway.
- The mode parse trims and case-folds, and reads `process.env.NEXT_PUBLIC_PLANNER_PREVIEW`
  literally: an indirect lookup reads undefined in the browser and silently means `on`.
- `seedPreviewEnabled` also refuses when the extensions table is unavailable, since nothing
  would clear the seed after that branch.

**Captures and the seed**

- **The starter seed ignores released captures.** Not in the design. A capture typed into a
  brand-new account, filed just after the landing, made the seed read the account as
  existing and latch with no starter set.
- The seed patches every history snapshot, not only the current one, so undoing a held
  capture filed before it never soft-deletes the seeded containers.

**Dialogs, confirms and keys**

- **The deferral cleanup survives StrictMode.** Unmounting the promoter drops the
  deferral a microtask later, and only if no promoter came back. Otherwise StrictMode's
  mount, cleanup, mount (on in development) wiped a request deferred by a door off `/`
  (the `/settings` arm-then-push) just as AppShell mounted to open it. A real unmount
  still drops it.
- **`confirm` refuses only on `/`.** The preview outlives a client navigation, and the one
  confirm on `/settings` (disconnecting the model) touches no row.
- **⌘A and `n` are kept from the browser while the preview holds them.** A key whose
  command is greyed only by the preview (`heldByPreview`) is `preventDefault`ed, as a cold
  load with no preview always consumed it. Handed back, ⌘A became a page-wide browser
  selection that outlived the landing. A key whose command would be unavailable anyway
  (⌘Z with no history) is still handed back. `n` opens nothing, not even a deferred add:
  the command gate comes before ui-store.
- The omnibar's empty-title add from the launcher closes the launcher explicitly. While
  previewing, the add is deferred and the launcher stays in the one slot, and promotion
  waits for a free slot.

**E2E**

- `tests/e2e/helpers/preview.ts` opens the database only if `indexedDB.databases()` lists
  it, so a spec asserting "nothing on disk" never creates one.
- The sign-out spec answers `/auth/v1/logout` itself. supabase-js signs out with global
  scope, which would revoke the session every other worker shares.

## Out of scope, and known limits

- **The settings edge.** Layout prefs, `weekStartDay` (which remounts the week views) or a
  timezone changed on another device land separately, un-animated, as before.
- **Numbers.** Counts, the Organize overview and the notice label going from "Syncing…" to
  "Put back" change without animation.
- **The first visit.** With no snapshot the skeleton to content reveal is unchanged.
- **No exit ghosts.** Removed rows vanish while their neighbours glide shut. A follow-up
  would need placement inside the scope, never a body overlay.
- **Cross-scope moves.** Braindump to canvas is a vanish plus a type-in. A row paired across
  week columns is clipped by its new column while it travels.
- **Scrolling the canvas during the preview.** `inert` blocks it for the length of the load.
- **Screen readers** do not read preview rows (they are inert); the status line announces
  the sync.
- **Paused rows** do not settle one by one; the paused strip moves as a whole.
- **Only title-only captures are queued.** Every other verb is unavailable or refused.

## Tests that pin it

- The barrier: `preview-write-guard.test.ts`. The store lifecycle, including capture before
  commit: `planner-preview-store.test.ts`. The readings: `planner-ready.test.ts`.
- The snapshot: `planner-snapshot.test.ts` (with `fake-indexeddb`, imported per file so
  every other suite keeps the no-IndexedDB path), `planner-snapshot-no-idb.test.ts`,
  `planner-snapshot-writer.test.ts`, the ledger in `planner-bundle.test.ts`, the audits in
  `local-state.test.ts`. The provider's offer, warm and purges:
  `planner-load-by-route.test.tsx`.
- The guards: `ui-store-preview`, `commands-preview` (a frozen classification of every
  static command), `held-captures`, `omnibar-capture`, `deep-link-preview`,
  `extension-preview`, `preview-unattended-writers`, plus additions to the existing
  notice, braindump, Zen, Organize and view-store tests.
- Rendering: `planner-skeleton.test.tsx` (the amended contract: skeleton iff not visible,
  `data-loaded` fresh only), `preview-crash-boundary`, `planner-sync-line`,
  `planner-preview-css`, and `week-column-hover` (no ancestor of a lime mark carries
  opacity in the preview).
- The settle: `settle-plan`, `settle-conductor`, `settle-participants`, `use-sink-hold`.
- E2E: `tests/e2e/instant-planner.spec.ts` with `tests/e2e/helpers/preview.ts` (the
  preview held on screen, a capture during it, a failed load, sign-out, reduced motion),
  plus the settle wait in `waitForAppReady`.

## If you touch this next

- **A new planner-store action** needs nothing: it is refused while previewing. If it must
  run then, see "To allow an action".
- **A new command** in a data group is gated by itself; classify it in the frozen table in
  `commands-preview.test.ts`. A data command in a chrome group goes in
  `PREVIEW_GATED_IDS`.
- **A new dialog slot** that seeds from or writes planner rows goes in
  `PREVIEW_DEFERRED_SLOTS`, and in the slot classification in `ui-store-preview.test.ts`.
- **A new surface that acts on data** gates on loaded. Never on visible, and never on
  settled alone, which counts a failed load's empty store.
- **Something that must happen once, at landing,** subscribes to the `isPreview` true to
  false edge and checks `selectPlannerLoaded(s)` and the same `userId`: a failure, a crash
  drop and an account switch all pass that edge too.
- **A store subscriber that diffs slices** to infer what the user did skips transitions
  where `prev.isPreview`.
- **A change to `loadPlannerData` or a mapper** fails the ledger. Bump `SNAPSHOT_FORMAT`
  and append the hash.
- **A new row or frame on the canvas, in the braindump or in Zen** wants a settle key, or it
  will snap while its neighbours glide. See "To add a participant".
- **The run's length** matters to e2e: `waitForAppReady` waits up to 5s for the attribute
  to come down, and `runTimeoutMs` (1400ms) plus the shield bound it.
