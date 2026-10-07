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
  takes a pointer, focus, drag or hover. Quick capture is held while the load is in flight;
  the exits and chrome that touches no row stay live.
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
   The routers mount the real views, inert. When the preview commits, SettleHost takes a
   hold (`notePreviewRendered`), released when the preview ends or SettleHost unmounts,
   which tells the crash marker the preview rendered cleanly. Two frames later SettleHost
   notes the preview as painted, which is the settle's concern only. The sync line fades
   in at 300ms if the preview is still up, and the waiting shimmer with it (see The
   waiting shimmer): SettleHost starts it in a layout effect on the preview's commit.
5. **Fresh landing.** `set({ ...fresh, isLoading: false, isPreview: false })`. Inside that
   `set()`, before React commits: the conductor bumps the settle epoch and captures FIRST
   from the preview DOM; the writer removes the crash marker and stamps `base`; the
   deferred-dialog hook promotes; held captures queue their release in a microtask (a
   failed load releases them too). Last, the shimmer's subscriber picks the landing's
   pass of light, the plain ease or nothing.
6. **Commit.** `inert` lifts and `data-loaded="true"` appears. SettleHost's layout effect
   calls `shimmerLandingCommitted()` (each fresh title's rise delayed by its x), then
   `onLandingCommitted()`: measure LAST, plan, then hold, shield or do nothing. The sync
   line sweeps "done" and unmounts.
7. **About 2s later, at idle,** the writer stores the fresh snapshot.

**Failure:** the catch empties the data slices in the same `set()` as `error`
(`emptyPlannerData()`, after `hydrateCustomTypes([])`). The empty store is then the undo
baseline, so ⌘Z can never replay cached rows against the server. No capture, no settle,
no shield; the sync line vanishes. Held captures are filed the moment the load fails
(`addTask` over the empty store, written at once, as before this queue), and a capture
typed after the failure is added at once. Each row filed over the failure, a pasted
list's included, is kept as the person last left it until a landing confirms it or files
it again (see Held captures).

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
| loaded | settled, no `error`, and `loadFailedUserId !== userId` | every surface that ACTS: notice actions, proposal accept, the Paused scopes rows, dialog promotion, the morning check |

Two act on settled instead, because a failed load has finished too: quick capture holds
only while a load is in flight (the preview included), and a pasted list's promotion
waits for settled, not loaded.

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
  instead, stamped with the account it was made under (`deferredFor`); the last request
  wins, except over a waiting pasted list (`isWaitingPaste`: a `bulk-add` carrying text),
  which only a newer pasted list replaces: any other data request asked for after it, an
  empty `bulk-add` ("Add many items…") included, is refused, since losing a deferred click
  costs far less than losing typed text. A data slot opened on real data clears a waiting
  deferral, except that same pasted list, which an empty `bulk-add` no longer supersedes
  either: it opens once that one closes. `closeDialog` leaves the deferral alone, because the launcher closes itself
  right after running "Open Organize". `confirm` refuses while previewing on `/`, where
  confirms guard data actions, unless the request declares `touchesPlanner: false`: its
  `onConfirm` reads and writes no planner row. Two do today, deleting a conversation (the
  Ask title menu) and disconnecting the model. Absent means it may touch rows, so a new
  confirm is refused there until someone has checked; every other confirm (Organize, the
  bulk bar, the row and sheet deletes, the item verbs) acts on rows and stays unmarked.
- **Promotion** ([hooks/use-deferred-dialog.ts](../../hooks/use-deferred-dialog.ts)),
  mounted once in AppShell. On the preview's end it opens the request only after a
  successful landing for the same account, into a free slot with no confirm up. An
  `edit-item` is re-resolved to the fresh row (dropped if the row is gone, keeping the
  payload's type stamp); a `new-container` keeps only the `itemIds` that still exist. A
  failure, a crash drop, an account change and leaving `/` all drop it. It opens the
  dialog before it clears the request, and a data slot opened on real data clears it in
  the same `set()`, so a subscriber watching the request sees it become the open dialog.
  - **At mount** too, by the same rules, for a request whose preview ended before
    AppShell mounted (the `/settings` arm-then-push whose landing came first). The account
    is checked by the stamp, and off the edge a request with no stamp never opens.
  - **A pasted list** is never dropped for a busy slot or a confirm: the field consumed
    the paste, so the request is the only place its text exists. It opens once both are
    free, opens over a failed load (as a paste made after the failure would), and waits
    out a crash drop until the load finishes. Only another account, sign-out or leaving
    `/` drops it. The rows it files over a failed load are kept by held-captures until a
    landing confirms them, as a capture's are: `addTasksBulk` reports every row it files
    through [lib/filed-rows.ts](../../lib/filed-rows.ts), a slot held-captures fills at
    import.
- **The phone's Ask tab.** While it is mounted, `openEditFor` hands an item to rail-store's
  interceptor, which pushes it over Ask as an autosaving inline ItemDialog instead of
  opening the drawer. While previewing, `openStampedEdit` (ui-store) skips the
  interceptor, so the open goes to the slot and is deferred like any other; promotion
  opens an `edit-item` through `openStampedEdit` too, so a promoted item still lands over
  Ask.
- **An item's conversation on the phone** ([lib/open-chat.ts](../../lib/open-chat.ts)
  `openConversation`, from Ask's history rows and the AI activity rows). It pushes the
  conversation's item over Ask when the item is there. Before the planner settles it pushes
  the item whatever the cached rows say, with the conversation as `fallbackConversation`,
  and PhoneItemView ([components/mobile/ask-tab.tsx](../../components/mobile/ask-tab.tsx))
  looks the item up only once settled, as the deep-link pages do: "Loading…" until then,
  then the autosaving editor seeded from the fresh row. Not found in that mount, the
  conversation shows in its place (a push, which the level rule lets replace the item);
  found and later deleted, the view pops. Settled rather than loaded, so a failed load's
  empty store shows the conversation instead of loading for ever. The conversation view
  says its item is gone only on loaded rows. On desktop the item goes through
  `openEditFor`, deferred and re-resolved like any edit, and its reveal (rail-store's
  `pendingReveal`, which scrolls to the conversation) is armed only when that held open
  is the one promoted (`revealWhenOpened`): a dropped or replaced open leaves nothing
  armed to scroll the item's next open unasked. `askAboutItem` does the same.
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

- **Quick capture** (the braindump's QuickAddRow Enter, the omnibar's `+`) is the
  exception: it goes through `captureTask()`, which holds only while a load is in flight
  and adds at once over a failed load. See "Held captures".
- **The braindump's ＋**, with text typed and the planner not loaded, keeps the text and
  focuses the field rather than open a dialog that would be deferred or dropped.
- **The sweep receipt and the EOD notice** stay mounted, so nothing is inserted
  mid-settle. While a load is in flight their verbs read "Syncing…" with no `onSelect`;
  after a failed load they show no verb and no `onSelect`, and the Retry notice is the way
  on. ✕ stays live. This also closes a cold-load hole: "Put back" over an empty store
  spent the only receipt on nothing.
- **The Display menu's Paused scopes rows** turn a routine or season back on, a planner
  write. While a load is in flight each row is disabled with "Syncing…" on its rail; after
  a failed load the section is not drawn.
- **The morning check** stays hidden until loaded.
- **Ask home's Needs you** stays hidden until loaded. Answering records a reply on the
  item's trail and then re-queues it through `updateTask`, which the barrier refuses while
  previewing; `answerAgentQuestion` also returns false then, writing nothing, so a reply
  can never land without its re-queue. The rest of Ask home (the load line, With AI
  activity, the chips) only displays or opens, and paints from the preview.
- **Proposal accept** returns 0 before `claim()`, so the card stays and can be accepted
  after the landing. The ProposalCard disables accept and says why beside it
  (`proposal-accept-reason`, linked by `aria-describedby`): "Syncing…" while a load is in
  flight, "Can’t apply until your data loads" after a failed load. With no account at all
  it stays enabled and the store's guard is the whole story.
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
`captureTask(title)` adds at once when the load has finished, landed or failed. It holds
only while a load is in flight (the preview included): it queues `{ userId, title }` and
returns `'held'` (or `'dropped'` when there is no user). The field clears, and "Adds once
synced" (`data-testid="quick-add-held"`) shows while the current account has captures
waiting. Holding past a failure kept the text in this module and nowhere else, so a
reload, a closed tab or a sign-out lost it. Over a failed load's empty store a capture is
added and its write attempted, as before this queue.

- **Kept until confirmed.** The write over a failed load is attempted, not guaranteed:
  an outage fails the insert too (`persistNewItem` only logs it), and the Retry's
  landing replaces the store, row and all. So each row filed before its account's data
  has landed, by a capture or by `addTasksBulk` (a pasted list, the palette's "Add many
  items…", a subtask paste; reported through `lib/filed-rows.ts`, so the store imports
  nothing of this module), stays in the queue as `{ userId, title, item, filed }`, a
  list's rows sharing a `batch`, and "Adds once synced" keeps counting it. That is over
  a failed load, and while a load is in flight: a Retry leaves the failed load's rows on
  screen (no preview is offered on a retry), and neither the item panel nor the bulk-add
  dialog waits on it, so a list filed there is kept like one filed over the failure (a
  capture there is held, as on any load). Never during the preview, which refuses the add. Up
  to the landing set() itself, the Retry's window included, the entry follows its row:
  `item` is the row as the person last left it (notes, dates, bucket, type, project,
  order), `filed` the row as first filed, and while the row is off the store (deleted,
  or its add undone) the entry is marked `gone`, not dropped, and not counted. The mark
  is recomputed on every pass, so a restore (the undo strip, ⌘Z, a redo of the add)
  clears it; that matters because the restore's own write is an UPDATE of
  `deleted_at`, which finds nothing when the insert never committed.

  Wherever the database turns out to hold the row, what the person changed since
  filing (`filed` to `item`) is laid over the database's copy and only that is
  written (`layOver` and `writeOver` in the store): a field they never touched keeps
  the database's value, which may be an edit made on another device while this tab
  was failing. A date list takes the dates they added and removed. A type switch is
  the whole row, sent as `changeItemType` and followed by the date lists, which the
  switch leaves out (`applyHistoryState` replays them the same way). The next landing
  for that account settles every entry:
  - one marked `gone` is the person's removal. It is not filed again, and if the
    landing brought it back (its delete failed with the load) it is deleted again,
    its subtasks with it (`settleLandedRows`);
  - a row the landing brought back takes the person's changes since filing, so an
    edit whose UPDATE failed with the load survives (`settleLandedRows`). Its order
    stays the landing's;
  - for the rest the database is asked first (`fetchItemsAnyState`: the rows under those
    ids, the bin included, which the own-rows policy allows), once this tab's own first
    inserts of them have settled (`awaitItemCreates`; asked while one is in flight, the
    answer is "no row" and the insert sent again races it), for 4 seconds at most in
    all (`ASK_TIMEOUT_MS`): until it answers the rows are off the planner and only in
    this module, where a reload loses them, and supabase-js sets no timeout of its own.
    An id with no row is filed again, whole, under the SAME id (`refileItems`), so an
    insert that commits late fails on the primary key instead of making a second row;
    an insert refused that way is read and settled as a row the database holds
    (`settleAlreadySaved`: live, the person's changes are written over it; in the bin,
    it leaves the store and every snapshot). A row in the bin was deleted on another
    device and stays there: filed again, the insert failed on the primary key while
    the store and the snapshot kept a row the database had trashed. So does a subtask
    whose parent will not exist (not on the planner, not filed again, not live): its
    parent's remote delete cascaded only to subtasks that existed. A live row the
    landing missed was inserted after the Retry's read began (its first insert was
    still in flight). It is not inserted again, but the person's changes go over it.
    If the question fails or goes unanswered, every row is filed again: the id still
    guards against a duplicate, and a late answer finds the queue already empty.

  Every row going back has its project id stamped again against the landed store, and a
  task row its order: after the landed rows, in the order the person last left them
  across the whole pass, so a drag over the failed load survives. A list's task rows go
  back as one insert, as the paste did, and a custom-type list one row at a time, so
  each keeps its own created_at, the order such types sort by. A list is filed again as
  the one undo entry it was ("Bulk add: N items", or "Add task: …" when one line is
  left), a capture as its own, unless the person has acted since the landing (the
  history moved while the database was asked): then the rows are folded into every
  snapshot with no entry, as `seedStarterContainers` folds its projects, because an
  entry pushed on top of theirs would take their next ⌘Z. Settling a row the landing
  brought back adds no entry either: it is what the person had before the landing. A
  Retry that fails too keeps the entries waiting.

  A subtask's insert waits for its parent's when that is in flight, for every add
  (`insertWaitsFor`, through `persistNewItem` and `addTasksBulk`'s one statement):
  sent in the same tick, a subtask reached the table first most of the time and failed
  `items_parent_item_id_fkey` (23503), and a pasted list failed whole. Subtasks added
  in that window also wait for each other, in the order added, since they share an
  `order` and created_at sorts them. An insert that waited is held (`heldItemCreates`),
  and every write to that item, a tick, an edit, a delete, a type switch, waits behind
  it at the store's item doors (`dbUpdateItem` and its five siblings wrap the raw
  writes): sent first, it matched no row and was lost, and the insert then wrote the
  row as it was. An insert that left at once opens no window, so an ordinary add and
  the writes after it keep the timing they always had.

- **A module queue**, so it outlives the field: the launcher closes on Enter, and the phone
  remounts the dock per tab.
- **Bound to the account.** Entries for any other `userId`, sign-out included, are dropped
  on the next store change.
- **Released in a microtask** once the load finishes, success or failure, so it runs after
  `initializeStore` releases the history suppressor: each held capture gets its own undo
  entry, in the order typed. The settle hold absorbs those commits, so the rows type in
  with the landing. Rows filed over an earlier failure and missing from the landing are
  filed again only once the database has answered, a round trip later, as ordinary adds
  after the captures typed during the Retry. The subscription is made on the first entry
  and dropped when the queue drains.
- **Typed text only, on purpose.** A capture's title while a load is in flight, and until
  a landing the rows a capture or a list filed. No other verb is queued: one decided on
  cached rows may mean something else by the landing.
- It also fixes an older loss: a capture typed during a plain cold load used to be erased
  by the landing `set()`.

Two consequences live outside the module:

- The first-run seed decides on the account's items **without** the captures the release
  filed (`withoutReleasedCaptures`, applied in the provider's seed snapshot). Otherwise a
  capture typed into a brand-new account reads as existing data, and the account latches
  with no starter set. A capture or a list filed before a landing is recorded the same way
  (`noteFiledBeforeLanding`), so when a Retry brings its row back the seed still does not
  count it.
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
finds nothing. With a connection open it clears the store instead. A clear chained onto an
open that resolves null (failed, blocked, or the 3s timeout), or whose transaction throws
or aborts, deletes the database instead: the epoch keeps the record off the page, and only
the delete removes it from disk. Each connection closes itself on `versionchange`, so
another tab's delete is never blocked.

### Crash recovery

Two layers, because a cached planner must never be able to break the app.

- **The boundary.**
  [components/shell/preview-crash-boundary.tsx](../../components/shell/preview-crash-boundary.tsx)
  wraps AppShell in `app/page.tsx`. A throw while previewing drops the preview and the
  snapshot and renders again; the retry has no preview left to drop, so a second throw is
  rethrown. Any other throw is rethrown to the next boundary up, exactly as before.
- **The marker.** sessionStorage `dsul-preview-pending` (tab-scoped) is absent or `'1'`.
  - **Armed** by `offerPreview` just before the preview `set()`, and again by the writer
    on `visibilitychange` to visible and on `pageshow` while `isPreview`.
  - **Removed** by the writer on every `isPreview` true to false edge; by `offerPreview`'s
    rollback when the preview `set()` threw and the preview never took; by the writer on
    `pagehide` and on `visibilitychange` to hidden, when `isPreview` and
    `previewRenderedCleanly()`; and by consuming it.
  - **`previewRenderedCleanly()`** is true while SettleHost holds at least one hold
    (`notePreviewRendered`, from the preview's commit until it ends or SettleHost
    unmounts) and `notePreviewThrew()` has not been called. `PreviewCrashBoundary` calls
    that on every catch, and the flag lasts for the life of the page. Off `/` it is also
    true for a page whose preview committed once: a client navigation unmounts AppShell,
    and the hold with it, while the preview stays up, and nothing off `/` renders it. On
    `/` a released hold under a live preview can only be a throw, so it never counts
    there; a throw above AppShell unmounts the provider too, and so the writer.
  - **Consumed** when `warmPlannerSnapshot` or `readPlannerSnapshot` finds it: removed,
    `clearPlannerSnapshot()` (a fresh page deletes the database), and the preview skipped
    once.
  - **What each exit does.** A reload, navigation, ⌘R, pull-to-refresh, tab close or
    bfcache entry with a clean preview removes it, and the next page previews again,
    including from a route the person navigated to mid-preview (`/settings`). A tab
    hidden and then discarded or killed lost it at hidden, so the restored page previews
    again. A hung page runs no handlers, so `'1'` survives and the next page purges. A throw
    above AppShell means the hold was never taken or was released by the unmount, so
    `'1'` survives `pagehide` and the next page purges. A throw the boundary catches drops
    the preview and the snapshot at once; one it cannot drop is rethrown, `'1'` survives,
    and the next page purges.
  - Hidden counts as leaving because it is the last event a page killed in the background
    is sure to get. The commit, not the painted moment, takes the hold: rAF does not run in
    a background tab, and the commit is the evidence that the render did not throw.

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
trace or hover-expand. The one exception is a lifted row's set-down (see Release under
Stacking): a `box-shadow` fade with `fill: forwards`, cancelled at the release in the
same task as the inline shadow it covers comes off.

SettleHost is mounted once at AppShell's top level, outside the desktop, mobile and Zen
swap. It registers the conductor's store subscription (live only while a host is mounted,
and counted, so StrictMode cannot strand it), holds `notePreviewRendered()` from the
preview's commit for the crash marker (see Crash recovery), notes the preview as painted
two frames after it commits, calls `onLandingCommitted()` from a layout effect on the true
to false edge, and holds the one `role="status"` ("Showing your last session. Syncing…").

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
- **Plates** (`data-settle-plate`): a row's surface drawn on a child of it, which a lift
  makes solid in place of grounding the row. ScheduleBlock's pane and the skipped block's
  strip carry it. A row that paints its own background (TaskRow) needs none.
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
| Move: matched, own displacement of 1px or more | `translate(dx, dy)` to zero, 420ms, composite `replace` (or `add`, below) |
| A row that grew | a clip reveal of its new extent, alongside the move |
| A frame of rows that grew | a bottom-edge clip reveal on the rows' curve |
| Appear, row | clip type-in left to right, its text paced (below), plus a 4px lift, 380ms, after 100ms plus 24ms per rank (rank capped at 6) |
| Appear, frame | clip unfold top down plus a 3px drop, 380ms, after 80ms |
| Retype: in place, signature changed | clip type-in from the first changed character, its text paced, 340ms; the first 12 by position |
| Exit | nothing: counted, never animated; the neighbours glide into the gap |
| Large | lists emptied; the visible top-level nodes rise 6px, 320ms, 24ms cascade (rank capped at 8) |

- A move's own delta is net of its nearest animated ancestor's, so nested moves compose
  exactly: one duration, one curve.
- **A translate replaces unless it has something to add to.** The design said `add`, so a
  box's own transform would carry through the glide. Chromium runs only `replace`
  animations on the compositor; an `add` runs on the main thread, and a recording showed
  the landing's own work (follow-up commits, the fresh rows' effects) stalling the first
  frames of every glide for 70 to 130ms, then jumping it. Tailwind's translate utilities
  (the gutter live-time's `-translate-y-1/2`) set the separate `translate` property, which
  a transform animation leaves alone, so a box whose computed `transform` is `none`, with
  no second translate in the same pass or a lift a retarget keeps, takes `replace` and
  draws exactly the same. A box with a transform of its own keeps `add`.
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
- **A type-in paces the text.** On `EASE_SETTLE` in one stroke across the row's full width,
  a title was uncovered in its first few tens of ms and read as a swap. With the same Range
  (one per animated row, read at LAST before any of the scope's animations exist), the
  conductor also reads where the row's text ends: its first text node with anything in it,
  which in every planner row is the title (`settle-participants.test.tsx` pins it), as
  drawn (a wrapped title's widest line) and only as far as its own box shows it (a
  truncated title ends at its ellipsis). The clip then runs three keyframes on a linear
  effect: from its start to the text's end by `typeTextAt` (0.8) on `EASE_TYPE`
  (`cubic-bezier(0.3, 0.4, 0.5, 1)`, close to an even pace, easing into the last
  character), then the rest of the row (the empty space, a right-aligned chip) on
  `EASE_SETTLE`. Appearing rows are paced too, including one new since the landing at a
  retarget (its glides are cancelled before it reads; the clips it keeps move no rect, and
  the lifts it keeps move rows only up or down, while a type-in's insets are all
  horizontal). Where the text does not run on past where the clip starts (a change in a
  right-hand duration, a title cut short), or nothing could be measured, it opens in one
  stroke as before. Frames still unfold in one stroke.
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
  the glide can be tuned alone; appears, retypes and rises stay on `EASE_SETTLE` (a type-in
  that paces its text carries `EASE_TYPE` and `EASE_SETTLE` on its keyframes instead). The
  worst case ends about 624ms after play, and a test keeps it, whatever `moveMs` is, under
  the sink-hold's 700ms. Every number lives in `SETTLE` in `lib/settle-plan.ts`, and a
  test pins each one.

**Stacking, only while its rows move.** FLIP draws a box where the stacking order of its NEW
place says, which showed twice in a recording of Day × Buckets. Both are inline values
written at the hold (and added to, never taken away, by a retarget) and put back exactly
as found: each element as the rows that asked for it land (Release, below), and whatever
is left by `finishSettle` or a scope's snap, on every exit. The whole list of what a run
writes outside its animations: `z-index`, `position: relative`, `background-color`,
`background-clip`, `background-image` and `box-shadow`. Each pass is judged as the scope
rests: the last pass's writes come off first, so a re-hold no longer reads a lifted row's
own ground as a ground of its own and drops it. A retarget carries the last pass's wants
forward on top of its own.

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
  scope (a row with a ground of its own, like a selected row's wash, keeps it), over its
  whole box (`background-clip: border-box`, written so no class can narrow it): the box
  its shadow outlines, so it reads as a card passing over its neighbours. An earlier pass
  clipped it to the content box, because before the shadow a full-height ground sliced the
  top off the neighbour a row was settling against with no visible edge; once the shadow
  drew that edge, the content-box clip left a see-through ring inside it, and crossed text
  showed sliced in the ring. The ground goes on the row itself and the z-index on its box,
  which differ on a phone (the SwipeRow). Where nothing inside the scope is painted, as on
  the plain canvas (its ground is `<main>`, outside view-root), it is stacked and given no
  ground. Nor is a row that transitions its `background-color` (named, or `all`): the
  write would fade the ground in under the glide. It is still stacked, with no
  `background-clip` and, unless it has a fill of its own, no shadow.
- **Solid.** A raised or lifted box whose OWN fill is translucent (a skipped row's
  `bg-surface-3/60`, a selected row's wash, a raised card's) showed what it crossed
  through it. Its fill is redrawn for the run as it reads at rest: `background-image`
  layers, `linear-gradient(c, c)` for its own colour, then each painted ancestor's
  (`display: contents` skipped), down to the first opaque one. Image layers only, never its
  `background-color`: the schedule pane transitions that for 150ms, so a write would fade
  it in and out. A box that already draws an image (`hover-wash`) is left alone, as is
  one whose fill is opaque or absent, or with nothing opaque under it at all. The task
  asked for the own colour over a written `background-color` ground; the layers do the
  same without that write.
- **Plates.** A schedule block draws its surface on a child, the pane (and the skipped
  block's strip), marked `data-settle-plate`. A lifted block takes no ground across its
  whole band (lane, rail and bead included); each of its own plates is made solid
  instead, and casts the lift's shadow if it has none of its own (the live pane has
  `--sched-shadow`, so in practice only the skipped strip takes one). A plate inside a
  nested row belongs to that row.
- **Shadow.** A lifted box casts `var(--shadow-elev-sm)` (`LIFT_SHADOW`, exported from
  `lib/settle-plan.ts`), when the row has a surface (its own fill or the ground) and the
  box casts no shadow of its own, which is kept. A row with no surface gets none: it would
  outline nothing. It is the floating surfaces' elevation, re-tuned per theme in
  `globals.css` and read, never written: a crisp drop in light, an inset light-catch over
  a deeper drop in dark, a 1px hairline ring in Studio and Terminal. It was
  `--shadow-soft-sm`, the lightest token, until a recording measured it 2 to 4 grey levels
  under the row, so a crossed row read as text cut by an edge nobody could see.
  `settle-plan.test.ts` pins the token and its `:root` and `.dark` definitions.
- **Release.** Each raised or lifted element comes off when the last move that asked for
  it lands (its "movers"), not when the run ends, which can be 250ms later while new rows
  type in: a row that has landed rests exactly as it will. Where the nearest painted
  ancestor is what shows behind the row at rest (every view but Zen, below), the ground
  and a solid fill read as the row's own surface does, so taking them off shows nothing.
  The shadow would snap, so it is set down over the last `SETTLE.liftSetDownMs` (180ms) of
  the move, on `EASE_SET_DOWN` (ease-in-out), from where `EASE_MOVE` has the row a few
  pixels from its slot: a `box-shadow` fade from its computed value to none with
  `fill: forwards`, cancelled in the same task as the inline shadow comes off. (At 120ms on
  `EASE_SETTLE` it started on a row that had visibly stopped and went in two frames.) It is
  the run's only animation of anything but transform and clip-path; it runs on the main
  thread, on the handful of lifted boxes, while they are nearly still.
- **Release across a retarget.** A retarget re-times every release from the re-aimed
  moves. A mover it leaves where it was (under a pixel from its slot, so no new move) has
  landed: its element keeps the time it was due (or comes off at once, if that has
  passed), never held to the run's end. A set-down the retarget interrupts goes on from the
  shadow as it is drawn at that moment, at once, over whatever time is left, so the
  shadow never shows full again. An element with a mover that never ran a move is held to
  the run's end, as before.
- **No lift in Zen** (`data-settle-lift="off"` on its scope root, pinned by
  `zen-room.test.tsx`). Zen's rows sit on the fixed frost layer and under the folded
  ledger's veil, neither of them an ancestor, so a ground read from the ancestors (the
  room's `bg-surface-0`) knocked the frost out of the row while it moved, and its z-index
  carried a row over the veil until it landed, where it dimmed all at once. A Zen row
  glides unlifted, as every row did before the lift.

None of it touches opacity, filter, transform or a custom property; nothing is written
that would start a CSS transition (a property named in the element's own
`transition-property`, or `all`, with a duration; the ground included, see Lift); and
nothing is written where nothing animates.

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
   are drawn, cancel that scope's glides only, and glide on from there over at least
   220ms. Its clip reveals, and the lifts that appears and rises come in on, keep running,
   so an appear's lift stays paired with its type-in. Layout is measured net of the kept
   lifts, and stacking counts their offsets. A glide given to a row with a kept lift sums
   with it (`add`, since `replaces()` counts kept translates), and a lift is never fed to
   stacking as a glide, so it pulls in no raise. Twice per scope at most. Past that, or
   past 300 animations, the scope snaps (shielded if it was still moving) and the others
   play on.
5. **Finish** at the last animation's end plus 50ms, and never later than 1400ms after the
   landing: every animation cancelled, observers and listeners dropped, and the attribute
   removed unless a shield is still up.

**Ends follow the engine's start** (`followStarts`). Play and a retarget time each
animation from the call, then, once its `ready` resolves, re-read its end as `startTime`
plus its effect's `endTime` (the document timeline shares `performance.now()`'s origin).
The releases and the finish are re-timed in one microtask for everything that started
together: the finish is the last real end plus 50ms, still capped at 1400ms from the
landing. A set-down not yet begun whose end no longer matches its release is remade with
the corrected delay; one under way, or not yet started by the engine, is left. `r.playedAt`
becomes the glides' real start, so a retarget's `moveMs − elapsed` is measured from it.
With no `ready` or `startTime`, or once the run, the scope or the animation is gone, the
call's clock is kept. A recording measured 8 to 108ms of start lag with screen capture
attached (23 to 26ms without): timed from the call, a lifted row lost its lift and its
set-down before it landed, and past about 50ms of lag the finish cut the type-ins short.

**A landing that changed nothing still runs.** Its follow-up commits are the only change,
so it watches the hold window and settles them, or shields them under a veto. It raises no
attribute unless something animates or a shield starts.

**What counts as a commit.** One MutationObserver per scope stays connected through the
run, but most records move nothing: a hover writing `--title-mask`, the ScrollArea mounting
its scrollbar or restyling its thumb on a wheel frame. A record re-holds or retargets only
if something moved. Participants are re-resolved only for child-list changes and the
attributes a participant is resolved from; positions are compared net of the run's own
translates and of scrolling since the last pass; signatures are compared during the hold
only.

A layout change OUTSIDE the scope (the docked Ask rail recentring the canvas, the header
row growing) moves every participant alike, with no record in the scope. When every
record is inside a participant, and every participant is off by the same displacement at
the same size, the last pass's LAST and FIRST are carried by that displacement and
nothing re-aims or re-holds. A record outside every participant (a band growing above the
rows) still re-aims. Not covered: a real commit after a painted outside shift is still
judged from before it (only sampling every frame would see the shift alone), and a scope
with a `display: none` participant never qualifies.

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
nothing on the canvas is faded (the one thing that dims is title text, the waiting
shimmer below), and it is `aria-hidden` (SettleHost makes the one announcement).

- Invisible for its first 300ms (a CSS delay), so a warm load never flashes it.
- It ends in "done" (a fill sweeps across, then fades) only over a successful landing it
  was visibly up for. A failure, a crash drop, an account change, reduced motion or a
  landing inside 300ms remove it at once.
- Syncing to done happens on the same element in the same render (state adjusted during
  render, not in an effect), so the root's fade-in never restarts. In the done state the
  CSS animates only the track and `::after`, never the root.
- Done ends on the `planner-sync-done` `animationend`. A 420ms timer, started two frames
  after the landing, is only the backstop.
- Its travelling bar is the shimmer's band: the same keyframe stops in viewport terms, the
  same 1.2s period, linear, from the same 300ms start, as wide as the band, offset by the
  track's own left edge (`--planner-shimmer-x`, measured in a layout effect and on resize).
  It crosses the canvas under the light crossing the titles, and goes on alone once the
  shimmer's three passes are spent.

## The waiting shimmer

Kirby's ask on 2026-10-07, option A of three: while the preview waits, its titles wait
too, the way Claude's own "working" status text shimmers, and the landing keeps today's
glide with one last pass of light. A wipe or a View Transition swap was ruled out.
[lib/planner-shimmer.ts](../../lib/planner-shimmer.ts) decides the phase, on
`<html data-planner-shimmer="wait|land|ease">`, and supplies the geometry CSS cannot read;
the paint is CSS, "Planner preview: waiting shimmer" in `app/globals.css`.

**What dims, and why it is allowed.** Row title TEXT and nothing else: the element marked
`data-row-title="open"` (TaskRow, ScheduleBlock, ProjectBlock's name and its tasks; the
phone renders TaskRow) under a preview root, which is view-root and the braindump
`<section>` (it carries `data-preview` beside its rows' `inert`). The ink is the title's
own background clipped to its own glyphs (`background-clip: text`), so nothing
composites: no opacity on any container, never a checkbox, rail, chip, count, label or
anything lime. A title that rests muted (done, skipped, set aside, receded) is marked
`data-row-title="muted"` and keeps its own ink with no band, so a waiting open row is
always more prominent than a muted one, and a muted one never outshines it. Everything
else keeps the canvas rule that nothing dims at rest: this dims only text whose meaning is
"not confirmed yet", only while that is true, and it ends with the load.

**Emoji keep their colours.** Through a clipped ground a colour glyph is only a mask, so
an emoji in a waiting title would turn into a flat silhouette in the ink.
`RowTitleText` ([components/primitives/row-title-text.tsx](../../components/primitives/row-title-text.tsx))
renders every open title (TaskRow, the schedule blocks, ProjectBlock's name, its tasks and
its preview task) with each emoji run in a `data-row-emoji` span, and the CSS gives that
span back its own fill, drawn over the ground. A text-style symbol (a bare heart, a
trademark sign) is not an emoji and takes the ink like the letters around it. A title with
no emoji renders as the bare string, exactly as before. Runs are cut on grapheme
boundaries (`Intl.Segmenter`, with a regex fallback that cuts the same where it is
missing), so an emoji is never split: a skin tone (✍🏽), a text-default symbol asked to
draw as an emoji (🏋️, ❤️, a keycap), a ZWJ sequence and a flag each stay one span with
nothing left over in the ink. The spans are part of the title to everything that reads it:
Zen's `findSourceTitle` takes a title whose only children are emoji spans as the title's
own text, and the settle's type-in measures the whole `[data-row-title]` for where the text
ends, not its first text node (which stopped the paced clip at the first emoji's edge; on
the build a fresh "🧺 Pick up the dry cleaning" now paces to x 668, its title's end, where
the first node ended at 528).

**The floor.** The waiting ink is `--planner-shimmer-level` of `--foreground` mixed into
`--muted-foreground` (in oklab), at the lowest level where every waiting title is at least
4.5:1 on its own surface, at least 1.25 times the contrast of `--muted-foreground` on that
same surface, and at least 1.05 times the best contrast any muted-ink text (the labels,
chips, counts and "Add item") reaches on ITS own ground. The last one is what holds the dark
looks, and it was missing from the first cut: their labels sit on the darker page and their
titles on lighter cards, so the same muted ink reads stronger as a label. At the first
cut's 25% in Night the current bucket's name ("Morning", `text-muted-foreground`) was
7.14:1 on the phone's page against 6.3:1 for a habit's title on its card, so the labels
outranked the titles that are the content. Secondary ink (`ink-1`: the Display shelf) and
headers are not labels and may outrank a waiting title; an empty pane's hint is not a label
either. Surfaces were measured from pixels in Day buckets, schedule and list, Week and the
phone, light and dark, every theme and tint, and solved with the browser's own color-mix:

| Theme | Level | Held by | On the build |
|---|---|---|---|
| Paper, and Slate, Dune, Iris on it | 30% | 4.5:1 (4.52:1, a project block's task under Slate) | 4.67:1 at worst, 1.5x the best label |
| Studio | 13% | 4.5:1 (4.52:1) | |
| Sorbet | 30% | 4.5:1 (4.56:1) | |
| Night, and its Slate, Dune, Iris tints | 45% | 1.05x the phone's current bucket name (7.14 to 7.21:1); Day needs 42 to 44% | 1.053 to 1.075x |
| Terminal | 24% | 1.05x Day's current bucket name (5.8:1) | 1.058x Day, 1.078x phone |
| Dusk | 51% | 1.05x the phone's current bucket name (7.14:1) | 1.059x phone, 1.087x Day |

The other views need no more: Night's Week buckets 44% once its empty pane's hint is left
out, and Week schedule and Day schedule less (Night 28% and 20%, Dusk 33% and 24%,
Terminal Week 13%), counting that hint. Light themes are held by 4.5:1 (their labels are 2
to 3:1). The worst waiting titles in the dark looks are a habit on its bucket card on the
phone and a project block's name in Day. A muted row's title is 2.1:1 in Paper.

**The dim.** Past the 300ms delay the ink goes down to the floor over 360ms on
`--ease-roll` (`SHIMMER.inkMs`; `INK_CURVE` is the same curve, for the ease's computed
depth), settled 0.66s into the wait. The first cut took 240ms on `--ease-out-soft`, which
is three quarters of the way down by its first quarter, so even a load that came back just
past the delay dimmed every title all the way and brought it back: on the build, a load
released 450ms into the wait (landing at about 535ms) took the titles to the full waiting
depth, more than 5% down for 350 to 370ms. On `--ease-roll` the same load takes them 37 to
43% of the way down, more than 5% down for about 250ms. The cost is the landing's
threshold, which is the end of the dim (below): a load landing 540 to 660ms in, which had
the light, now has the ease.

**One light.** Each title's gradient is a band (`2 x --planner-shimmer-band`, the band
`clamp(32px, 9vw, 140px)`: wide on a desktop, a sliver on a phone) offset by
`--planner-shimmer-x`, the title's own left edge in the viewport, which the module writes
when the title's sweep starts and again on a resize or a scroll. So every title is a
window onto one band, and the sync line's bar is another: one clock, one period (1.2s,
linear). The bar is painted the titles' way, a full-track box whose background is the
band, moved by the same `background-position` keyframes (`planner-sync-travel` and
`planner-shimmer-sweep` have the same body) offset by the track's own
`--planner-shimmer-x`. The first cut moved a band-wide box with a transform, and on the
build it ran about 470px ahead of the band on a 1440px Day: the compositor kept a stale
value of the `var()` in its keyframes, and even placed right it drew one frame ahead of
the titles' main-thread paint, about 50px at the band's speed. Painted the same way, the two
are drawn in the same frame: on the build, bar minus band in single screenshots was -8 to
+10px across a long canvas title, and -7 and +21px on the standard Day, where the band
is read off short titles' edges (`background-position-x` is the one non-transform,
non-opacity animation the preview's CSS test allows, for this bar only). A sweep or bar
that starts later (a mobile tab switch) is moved onto the first pass's start time, and so
is its mute: a title that joins the wait late restarts both, and would otherwise show full
ink for 300ms and then ink out on its own. Such a title is put on the clock in the frame it
is first styled, before that frame paints: one scrolled back into view in the measure that
un-marks it, and one mounted mid-wait (a tab switch, a view change) from a
MutationObserver on the body, whose records arrive after React's commit and before the
browser renders. If no sweep has reported yet (inside the delay), the clock is the first
waiting title's sweep that has a start time (one with none yet is passed over), and with no
such title left (a phone tab switch inside the delay replaces every title) the sync line's
bar, which started with them and outlives the tab. On the build a swipe to Braindump 10 to
180ms into the wait mounts its titles 380 to 460ms in (the tab cross-fades), past the
delay, and in six runs every joined title's sweep and mute started on the bar's start
exactly, the ink settling with the bar's clock, not the mount's. The bar fallback itself is
reached only by a mount inside the delay, and is pinned by a unit test. Filmed on the
build: a 400px braindump scroll at 1.5s and a phone tab switch at 3.5s, every title on
screen at the waiting ink in every frame, and one band. Each pass parks the band off the
left edge until 0.47s, crosses the viewport to 1.04s, then parks it off the right until the
next pass; it never enters from the right. On a 1440px Day it reaches the braindump at about
0.55s, with the ink most of the way down (settled at 0.66s), and has crossed the canvas by
about 0.95s, so a 0.6 to 1.1s load sees it cross the canvas titles. Filmed on the final build: braindump 0.60 to 0.68s and canvas
0.77 to 0.83s in screencast time (about 40ms late); at 1920px Week, x 620 at 0.75s to x
1800 at 1.07s. `background-attachment: fixed` would draw the same picture with no
measuring, but it re-rasters the planner at about 11 frames a second.

**The cap.** Three passes (`3 both`, done 3.9s after the preview commits), then the band
stops and the ink holds at the waiting level while the sync line goes on syncing.

**Away.** A waiting title outside the viewport is marked `data-shimmer-away` by the
module: it holds the waiting ink with no animation and no band, and sits the landing out
in plain full ink. No band, because with no animation the band sits at position 0, its
left edge, and a title scrolled into view showed it there until the next measure. A CSS
animation ticks and paints off screen too; on a 165-row planner the marking took the wait
from 39% to 23% main-thread busy at 1x.

**The landing.** The phase changes inside the landing `set()`, from a planner-store
subscriber registered after the conductor's (so the conductor's capture reads the
preview's rects before anything re-styles the titles), before React commits, so the fresh
rows' first frame is already styled and no title snaps.

- A real landing at least 660ms into the wait (`LIGHT_AFTER_MS`, the delay plus the
  dim), on the shimmer's own clock (the first frame that styled the titles, so 360ms after
  the shimmer first showed, not 660ms after it showed): `land`, the pass of light. The light needs a settled ink to rise from; a
  landing sooner catches the ink still going down, and gets the ease. Each title rises
  from the waiting ink to full ink in 150ms on `--ease-roll`, delayed by its x, 0 to 180ms
  across the viewport, so the light crosses left to right in about 330ms beside the glide.
  A column of titles shares one x, so a column rises together: in Day the canvas rises a
  beat after the braindump (about 55ms behind it, all risen by about 220ms), and on the
  phone the one column rises at once. The light does cross the viewport, but there is
  nothing to the right of a column to show it. A wipe across each title at the light's
  speed would cross a title in 30 to 60ms, a harder edge than a rise. The delay is set on
  each title's rise animation (`updateTiming`) in SettleHost's landing layout effect,
  before the conductor holds. The sweep carries on, so a band mid-crossing goes on until
  the rising ink overtakes it. Titles are never settle participants: the type-in clips row
  boxes and the lift writes a row's ground and shadow, never the title, so the two
  compose.
- 300 to 660ms: `ease`, every title up at once in 170ms on the same rise, from the
  depth its ink had reached (the ink's own curve, computed; a `<style>` rule for the
  titles, never a property on the root).
- Under 300ms (it never showed), either motion veto, a hidden tab, or another account's
  rows: nothing. The attribute comes off and the titles are text.
- A failed load or a dropped preview empties the planner in the same `set()`, so the
  layout effect finds no title to raise and ends the phase: the ink returns plainly, with
  no pass of light.

**Every rise ends on plain text.** Glyphs drawn as a clipped ground carry a little less
ink than the same colour drawn as text, so a rise that ended on the clipped ground snapped
heavier when the attribute came off. The rise is `--ease-roll` split at its midpoint into
its two halves (per-keyframe timing functions, the animation itself `linear`): the first
half raises the clipped ground, and at the midpoint, the rise's fastest moment, the title
turns into plain text of the same colour, whose own `color` then eases up to rest
(`-webkit-text-fill-color` does not interpolate; it flips). The band is drawn in
`currentColor`, so over the first half it comes down to the ground as the ground comes up,
and they meet where it goes. On the build, inside every title rect: the frame just before
the attribute comes off and the frame just after are identical in Day buckets, Day
schedule, Week and the phone, light and dark (0 of 26,000 to 141,000 pixels), and the end
equals the rest frame from before the reload.

The attribute comes off 60ms after the first rise's run ends, timed from that
`animationstart`'s own timestamp, or by a 1.5s backstop, and every title's inline
`--planner-shimmer-x` and away mark go with it.

**Nothing before the light.** Through the 300ms delay the mute holds plain text (no ground,
the title's own fill), not the clipped ground at full ink, which drew lighter glyphs. A
warm load that lands inside the delay never sees the shimmer: filmed on the build, every
frame from the preview to rest identical in every title.

**Off.** Reduced motion, the OS setting or the app's animations switch
(`html[data-reduce-motion]`, gated in the CSS too, so turning it off mid-wait stops the
shimmer at once); forced colours (the system's colours replace the ink, and a clipped
background is not one of them); and `static` and `off`, where the module never sets the
attribute (`static` keeps the preview still but for its sync line). The module asks the
same vetoes (`shimmerAllowed()`) before it starts a wait, so under any of them it sets no
attribute, measures nothing, writes no x, watches for no joins and sets no timer, and a
veto that arrives mid-wait (the animations switch landing from the server) ends the phase
at the next measure. On the build, a held reload under the OS setting and under the
switch: no attribute, no x, no away mark and no shimmer animation in any frame from the
preview to rest. **Zen** takes no
shimmer, deliberately: the room's titles carry no mark, so it stays still but for its sync
line. Zen is one item in large type in a calm room, and a band of light crossing it would
be the only motion on the screen.

**Lime.** Every lime pixel of the rest frame before a reload was compared byte for byte
at 450, 700, 900, 1600 and 4500ms into the wait, at the landing and after it, in Day
buckets, Day schedule, Week and the phone, light and dark. Identical, but for the app's own
animated marks (the now bucket's breathing glow, the braindump's empty-state tiles), which
differ the same with the shimmer suppressed, and one Chromium partial-raster artefact: 8
edge pixels of a lime checkbox, 2/255 off for the landing's 330ms, gone under
`--disable-partial-raster`. Repeated after the repair (the app's own ambient motion held
still): every lime pixel in the planner identical in the delay, at 1.5 and 2.7s, at the
landing's end and at rest, in Day buckets and schedule and Week, light and dark (12,312
of them in Week dark).

**Measured cost.** Production build on the local stack, Chromium, Day buckets at
1440x900, with the shimmer against the same page with its attribute suppressed, real
speed and a 4x CDP CPU throttle.

- The load does not land later. Load answering 800ms after it is asked, navigation to
  `data-loaded`, 6 pairs: 1465 against 1480ms at 1x, 3125 against 3152ms at 4x (means).
  A held load, release to `data-loaded` at 4x, 8 pairs: 372 against 381ms. A 165-row
  planner at 4x, 10 pairs: 2361 against 2216ms mean, 2187 against 2436ms median, inside
  that run's own spread (navigation to the preview, which the shimmer cannot touch,
  differed by 182ms between the same two groups).
- Waiting: main thread 15% busy against 11% at 1x, 55 to 60% against 42 to 51% at 4x;
  raster 60 to 80ms a second on the tile workers (none without); worst compositor frame
  gap 19ms at 1x, and at 4x 28 to 31ms with it against 26 to 30ms without. Longer
  main-frame gaps in the wait are Blink skipping frames while every band is parked, not
  jank.
- Landing, its first 600ms: 24% busy against 15% at 1x (longest task 9 against 6ms,
  worst frame gap 21 against 18ms); 70 to 75% against 49 to 57% at 4x, longest task 34 to
  67 against 15 to 26ms, worst compositor frame gap 28 to 33 against 21 to 29ms. The extra
  is style for the 16 to 18 animating titles while their rises run, 5 to 15ms a frame at 4x.
- After the repair (the clock join, the plain delay, the split rise), the same harness:
  navigation to `data-loaded` 1514 against 1464ms at 1x (navigation to the preview, which
  the shimmer cannot touch, 566 against 517), and at 4x, 8 pairs, 2876 against 2857ms,
  preview to loaded 1342 against 1345. A held load at 4x, release to `data-loaded`, two
  runs of 6 and 8 pairs: 325 and 326 against 287 and 322ms mean. The wait 12% busy against
  8% at 1x and 55% against 30 to 36% at 4x; the 700ms from the release 25% against 21% at
  1x and about 70% against 60 to 64% at 4x, worst frame gap 17ms at 1x either way and 33
  to 50ms against 33 to 42ms at 4x.
- Cut on the way, each measured: the ease's depth as a property on `<html>` (re-styled the
  whole document inside the landing; +150ms to `data-loaded` at 4x), animation reads in
  the event handlers (each flushes style), a per-title property for the landing delay
  (styled every title twice), and animating off-screen titles.

## The kill switch

`NEXT_PUBLIC_PLANNER_PREVIEW`, read once as `PREVIEW_MODE` (trimmed and case-folded;
absent or unknown means `on`). It is a literal `process.env` reference so Next inlines it,
which also means a change is a Vercel env edit plus a redeploy. Set it on Preview
deployments first, then Production.

| Value | Effect |
|---|---|
| `on` | Preview, sync line, waiting shimmer, settle and shield. |
| `static` | Preview and sync line (no shimmer), an instant swap, and the shield on whatever changed. Use it if the settle misbehaves. |
| `off` | No read and no write; the writer deletes the database at start, and every clear deletes it. Use it if the preview itself misbehaves. |

Bumping `SNAPSHOT_FORMAT` invalidates every cache at once. Per user, the animations toggle
turns the settle and the shimmer off and leaves the shield on.

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
  ground to the content box. A third gave the lift its shadow, which moved the ground
  back to the whole box (see Lift), and released each lift as its row lands.
- **Retypes start at the first changed character.** The design typed the whole row in,
  checkbox included, so a renamed row went blank at the landing and its unchanged title
  typed in again.
- **Type-ins pace their text, and run longer** (appear 340 to 380ms, retype 300 to
  340ms). On one stroke of `EASE_SETTLE` the text was uncovered too fast to read as typed.
- **Solid fills, plates and the lift's shadow** (see Treatments). The settle once wrote
  only stacking and a ground.

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
  confirm on `/settings` (disconnecting the model) touches no row; it now says so too.
- **A row-free confirm is raised on `/` anyway** (`touchesPlanner: false`). Refused, Ask's
  "Delete conversation" did nothing at all during the preview. The opt-out is explicit
  and per request, so a new confirm is refused until someone has checked it.
- **⌘A and `n` are kept from the browser while the preview holds them.** A key whose
  command is greyed only by the preview (`heldByPreview`) is `preventDefault`ed, as a cold
  load with no preview always consumed it. Handed back, ⌘A became a page-wide browser
  selection that outlived the landing. A key whose command would be unavailable anyway
  (⌘Z with no history) is still handed back. `n` opens nothing, not even a deferred add:
  the command gate comes before ui-store.
- The omnibar's empty-title add, search-result pick and multi-line paste from the
  launcher each close the launcher explicitly (`closeLauncher()`). While previewing, the
  dialog is deferred and the launcher stays in the one slot, and promotion waits for a
  free slot. Outside the preview the call does nothing: the dialog has already replaced
  the launcher.

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
- **A card that lost a row** (a bucket card or group whose row moved out or left) takes
  its new, shorter height at once: its bottom edge jumps up while the rows inside it are
  still gliding, visible for about 75ms. Transform and clip-path cannot draw a box taller
  than its layout box, so it cannot be held, and nothing tries. The grown case is the
  bottom-edge reveal above.
- **An item's conversation on desktop, during the preview, for an item deleted since the
  snapshot,** opens nothing: the item's deferred edit is dropped at promotion, and the
  conversation is not shown in its place (the phone shows it). Data-safe; a second click
  after the landing opens the conversation.
- **A pasted list during the preview** is kept over a later deferred item or organizer
  request, which is refused (only another pasted list replaces it, never an empty
  `bulk-add`), and is still dropped by
  leaving `/` before the landing. A waiting paste may open later than the landing, when a
  docked item panel or another dialog closes.
- **Filing again after a landing** is as good as the database's answer. A row the
  person deleted and restored over the failed load whose delete committed but whose
  restore did not (the outage began between them) reads as deleted elsewhere and stays
  in the bin. A field changed both by the person over the failed load and on another
  device takes the person's value; a type switched both ways takes the person's whole
  row. A row the landing brought back keeps the landing's order, so a drag of it over
  the failed load is not kept (one filed again keeps it). A live list the landing
  missed is placed after the landed rows with one order UPDATE per row: no batched
  item write exists (it would need a new RPC, a migration), every reorder verb already
  writes one row at a time, and only a list pasted during a cold load whose insert
  commits after the read began takes this path.
- **A subtask added while its parent's insert is in flight** waits for that insert's
  answer, success or failure, and so does every write to it. supabase-js sets no
  timeout, so a tab closed before the parent's insert answers never sent the subtask's.
  Sending it early instead trades that for a 23503 whenever the parent is merely slow.
- **The crash marker's edges.** Chrome's Duplicate Tab copies sessionStorage, so a tab
  duplicated mid-preview inherits `'1'` from a page that is still alive and purges the
  snapshot for every tab. A preview that commits in a tab hidden from the start, then is
  discarded without ever being shown, keeps `'1'`, and the restored page comes up cold
  once. A browser crash or force-quit mid-preview also purges once.

## Tests that pin it

- The barrier: `preview-write-guard.test.ts`. The store lifecycle, including capture before
  commit: `planner-preview-store.test.ts`. The readings: `planner-ready.test.ts`.
- The snapshot: `planner-snapshot.test.ts` (with `fake-indexeddb`, imported per file so
  every other suite keeps the no-IndexedDB path), `planner-snapshot-no-idb.test.ts`,
  `planner-snapshot-writer.test.ts`, the ledger in `planner-bundle.test.ts`, the audits in
  `local-state.test.ts`. The provider's offer, warm and purges:
  `planner-load-by-route.test.tsx`. The marker across a reload, end to end (the real
  snapshot module, writer, store, SettleHost and boundary over `fake-indexeddb`, each page
  a fresh set of modules): `planner-snapshot-reload.test.tsx`.
- The guards: `ui-store-preview` (including the `touchesPlanner: false` opt-out, and a
  row-acting verb's confirm still refused), `commands-preview` (a frozen classification
  of every static command), `held-captures`, `omnibar-capture`, `deep-link-preview`,
  `extension-preview`, `preview-unattended-writers`, plus additions to the existing
  notice, braindump, Zen, Organize and view-store tests. An item's conversation over the
  preview: `open-chat` (what the phone pushes), `ask-tab` (loading, the fresh editor from
  both a history row and an AI activity row, the fallback conversation, a delete, a
  failed load) and `ask-views` (a conversation deleted over the preview). A held open's
  reveal: `open-chat-preview-reveal`. The failed-load and waiting-paste rules: additions to
  `ui-store-preview` (the stamp, promotion at mount, the waiting paste), `omnibar-capture`
  (a launcher pick or paste over the preview), `display-menu`, `proposal-card` and
  `held-captures`.
- Rendering: `planner-skeleton.test.tsx` (the amended contract: skeleton iff not visible,
  `data-loaded` fresh only), `preview-crash-boundary`, `planner-sync-line`,
  `planner-preview-css`, and `week-column-hover` (no ancestor of a lime mark carries
  opacity in the preview).
- The waiting shimmer: `planner-shimmer` (the phases: on mode only, the light, the ease
  and nothing by elapsed time, a failed load and a dropped preview, another account, both
  motion vetoes, forced colours, a hidden tab, away titles, one clock, every timer and
  listener gone with the last host), `planner-shimmer-css` (title text only, scoped to the
  preview and the settle scopes, inside the motion and forced-colours media query and the
  app's switch, no opacity, nothing lime, the cap, every number against the module's, the
  sync bar on the same keyframes, a level for every theme, the plain delay, the rise split
  at its midpoint onto plain text, the away rule with no band, the emoji rule) and
  `planner-shimmer-marks` (open and muted titles, on the title's own text element, emoji
  runs in their own span). `planner-shimmer` also pins the late joiners: a title scrolled
  back into view and one mounted mid-wait put on the clock before they paint, the clock
  taken from a running sweep, the mount observer gone with the wait, and no inline x or
  away mark left at the end.
- The settle: `settle-plan` (every constant, `EASE_TYPE`, the 624ms worst case),
  `settle-conductor` (the paced type-ins; the stacking writes, pinned as a list, with
  solid fills, plates and the shadow, each put back exactly on every exit; ends from the
  engine's start, the outside shift, a lift kept through a retarget), whose fake engine
  reports `ready` and `startTime`, a start lag that differs for composited and
  main-thread animations, progress that respects the fill mode, and a running fade's
  computed box-shadow part-way down,
  `settle-participants` (a row's first text is its title; one plate per schedule block),
  `use-sink-hold`.
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
