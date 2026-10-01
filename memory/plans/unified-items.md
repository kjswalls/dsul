# Unified Items Plan — merge Tasks + Habits into one Item entity

**Goal:** One `items` table / one `Item` entity with a user-selectable `type` property
(`task`, `habit`, and later user-defined types like `goal`), with per-type behavior driven
by a **type-capability registry** instead of parallel code paths.

**Status (2026-08-26):** decision 4 superseded — the container unification it deferred
shipped as migration 039 (see below). Everything under it still stands.

**Status (2026-07-27):** Phases 0–5 shipped. Migrations 019 + 020 are APPLIED to the
live Supabase DB (backfill verified: 1,466 tasks + 231 habits); store rewritten on
`items[]` with `tasks`/`habits` projections (commit `3afc527`); Phase 4 replaced the
three dialogs with one registry-driven ItemDialog; Phase 5 put the agent routes behind
one Zod-validated handler (`lib/agent-api.ts`), added `items[]` + schemaVersion 3 to the
context response, moved the Beacon context/prompt onto registry renderers, and added the
dist-matches-src CI gate. Deliberately deferred: mixed-type `order` interleaving policy
for unfiltered `fetchItems` (`order` only meaningful within a type — items[] consumers
must not assume cross-type ordering); a dated deadline for the frozen-table drop
(cleanup migration); EOD/morning full genericization (they use registry capabilities and
constants, but their section logic still enumerates task/habit — Phase 6 work if custom
types should appear there). Next: Phase 6.

---

## Locked design decisions

1. **Status vocabularies stay per-type.** Task `pending|completed|cancelled`, habit
   `pending|done|skipped`. Both are external contracts (openclaw plugin `safeParse`s the
   context response and **throws** on drift — `openclaw-plugin/src/cache.ts:55-61`). The
   unified `ItemSchema` is a Zod **discriminated union** on `type`; the DB gets a
   type-conditional status CHECK. No merged status enum, no value translation.
2. **Streak migrates as-is** (opaque stored counter, `+1`/`-1` on toggle). It is NOT
   recomputable from `completedDates` without changing user-visible numbers.
   `resetHabitStreak` must reset counter fields only — never `completedDates`.
3. **Habits stay un-anchored** (`start_date` stays NULL for migrated habits). Tasks gate
   recurring occurrences by `startDate <= date`; habits render on every matching day.
   `dateAnchored` is a registry capability, not inferred from code path.
4. **Containers stay split in v1 — SUPERSEDED 2026-08-26 by migration 039.** The
   follow-up refactor this decision deferred has landed: the two CLASSIFY kinds
   (`project`, `group`) are ONE kind, `project`. `habit_groups` and `items."group"` are
   frozen rollback ballast like `tasks`/`habits`; nothing reads them. The registry still
   declares `containerKind` per type — it is just that every type now answers
   `'projects'`. `containerRequired` used to be what still distinguished a habit;
   since 2026-10-01 (Kirby) a habit's project is optional too and no shipped type
   sets it — the capability stays for a future type. The legacy `habits[].group`
   still goes out as a required string: `''` when unfiled (`toLegacyHabit`).

   The three container ROLES are untouched: one classify kind, two gates (routine,
   program), one aspire (goal). Collapsing a kind is not collapsing a role, and
   `ClassifyKind` stays a union so `containerRef`/`foldRef`/`containerRefOf` keep
   refusing a gate or a goal.

   Three things about it are load-bearing and not obvious from the diff:

   - **The noun is provisional, and renaming it needs no migration.** 'Project' won
     because it is already the DB column, the agent field and every shipped string.
     `kind`, `itemField` and the column are machine names and never move; the label
     lives in `CONTAINER_KINDS.project.label` / `labelPlural` / `unsetLabel` /
     `newLabel`. About eight user-visible strings still spell it by hand
     (`sections/labels.tsx`, `sections/trash.tsx`, `bulk-add-dialog.tsx`,
     `day-list.tsx`), all pre-dating 039 — listed in that record's own note. Moving
     them is a copy refactor with no behaviour in it and was deliberately kept out of
     the data migration.
   - **The merged kind FOLDS CASE.** It inherited the habit-group half's policy, not the
     project half's: `makeAddDraft` writes a lowercase `'personal'` against a seeded
     `'Personal'` whenever the container list has not loaded, so taking the exact half
     would have re-opened that bug on the day the kinds merged. The cost, accepted and
     tested: an account holding both `Work` and `work` as containers now resolves both
     to one row. 039 rewrites `items.project` to its container's canonical spelling so
     the fold is a backstop rather than the only thing holding a reference together.
   - **The collision rule is MERGE, project wins.** A user holding a project and a habit
     group whose names fold equal ends with one container: the project row survives with
     its own id, glyph and colour, and the group's members adopt it.
     `projects_user_id_name_key` is `UNIQUE (user_id, name)` and the ref grammar has no
     way to tell two same-named containers apart, so the alternative was renaming one
     without being asked.

     It does NOT cover project-vs-project, which is the case it cannot repair: two LIVE
     `projects` rows folding equal are indistinguishable to every lookup once folding is
     on, and `removeProject` would unfile BOTH rows' members. A migration cannot choose
     which glyph, colour and name survive, so **039 refuses to run** against such an
     account (section 1b) rather than proceeding. `scripts/verify-039.sh` exercises the
     refusal; `tests/unit/container-case-policy.test.tsx` pins the damage it prevents.

   - **The migration is verified against a real Postgres**, not only against its own
     text. `scripts/verify-039.sh` stands up a throwaway cluster, reconstructs the
     pre-039 schema, and asserts on the resulting rows — merge, id preservation, binned
     containers carried with their members, live-beats-binned, text-only refs, ballast
     untouched, three runs producing an identical snapshot, and the pre-flight refusing.
     `tests/unit/collapse-classify-kind.test.ts` covers the same file in CI but only as
     TEXT, which cannot catch a syntax error or a wrong join; the two are complements,
     and the text half exists because CI has no Postgres.
5. **Projects-as-item-type is deferred** (edit-project has a quasi-item time-block form;
   candidate future type, out of scope).
6. **External API projections live indefinitely.** `/api/agent/context` keeps serving
   `tasks[]` / `habits[]` as exact-legacy-schema projections of items (future custom types
   omitted from both). Webhooks keep emitting `tasks.updated`/`habits.updated` with
   `{task}`/`{habit}` payload keys mapped from `item.type` — `notifyPlugins` drops
   unregistered event names, so `items.updated` would silently never arrive
   (`lib/openclaw-registry.ts:46`).
7. **Old tables freeze, not drop.** Migration copies ALL rows (including soft-deleted —
   30-day trash must survive), keeps UUIDs, leaves `tasks`/`habits` untouched as rollback
   for a bake window. Drop is a later cleanup migration.
8. **DB `type` column is open** (`text NOT NULL`), v1 CHECK `('task','habit')`; the CHECK
   is dropped when the custom-types phase adds a per-user `item_types` table.
9. **Migrations are authoritative; `supabase/schema.sql` is stale** (missing `deleted_at`,
   `tasks.completed_dates`, all 007 columns, CHECKs, RPC, cron). Author all SQL against
   migration state, never schema.sql.

## Target DB shape (migration 019)

`items` = superset of both tables, kind-specific columns nullable, plus:

- `type text NOT NULL` (CHECK task|habit for now)
- Shared: id, user_id, profile_id, title, status, notes, time_bucket, start_time,
  repeat_frequency (nullable — defaults move to app code per type: task `none`, habit
  `daily`), repeat_days, repeat_month_day, completed_dates, sort_order, created_at,
  updated_at, deleted_at
- Task-side: priority, project, start_date, duration, is_scheduled, "order",
  in_project_block, previous_start_time, previous_start_date, assignee, ai_result,
  ai_status, parent_item_id (was parent_task_id), reminder_at, external_id,
  calendar_source, completed_at, duration_minutes
- Habit-side: "group", streak, skipped_dates, daily_counts, times_per_day,
  current_day_count, color
- One RLS policy, one updated_at trigger, type-conditional status CHECK, shared repeat
  CHECK
- **Habit `order` backfill** from current insertion order (created_at per group) so the
  unified order-by doesn't reshuffle; tasks keep their existing global sequence.
- New RPC `toggle_item_completed_date(item_id, date_str)` + legacy-named
  `toggle_task_completed_date` wrapper delegating to it (deployed clients mid-rollout).
- `cron.unschedule('purge-deleted-items')` + recreate purging `items` (and containers).

## Type-capability registry (`lib/item-registry.ts`)

Per type: `allowedStatuses`, `doneStatus`, `defaultFrequency`, `allowedFrequencies`,
`dateAnchored`, `dateAddressable` (DnD dateStr), `orderable`, `containerKind`
(`projects`|`habitGroups`) + required?, `counters` (streak/dailyCounts/timesPerDay),
`schedulable`/`resizable`/`defaultBlockDuration`, `braindumpEligible`,
`carryForwardEligible` (EOD/morning), rail-slot policy (priority glyph vs StreakFlame),
confirm copy. Custom types later = rows in an `item_types` table hydrated into this shape.

**`skippable` + `skipStatus` (added 2026-07-30, issues #194/#195).** `skippable`
says a type's occurrences can be skipped; `skipStatus` says whether that skip is
*also* denormalized into scalar `status` (`'skipped'` for habits, `null` for tasks
and custom types). The split exists to protect the pinned legacy projection: task
status vocabulary stays `pending|completed|cancelled`, so a skipped task is only a
date in `skippedDates` and never a new status value.

Ask `isSkippable(item)` rather than the capability flag directly — it ANDs the
flag with `isRecurring(item)`, because a skip is a date in `skippedDates` and only
means something when there is another occurrence to skip. Habits satisfy both by
construction (their allowed frequencies exclude `'none'`), so this reproduces the
old habit-only predicate exactly while extending it to recurring tasks and
recurring custom types.

`skippedDates` moved into `RecurrenceFieldsSchema` alongside `completedDates`, so
it lands on every recurring-capable type at once. It is additive and optional, so
older OpenClaw plugin builds strip it as an unknown key rather than throwing —
but note `/api/agent/context`'s `tasks[]` projection does now carry it.

## Phasing (app must work at every step)

- **Phase 0 — stabilize:** fix latent bugs unification amplifies: habit toggle timezone
  null → RangeError (`planner-store.ts:650` — use task path's `?? Intl` fallback);
  `reorderTasks` silently drops items missing from the id list (`:567-574`); `restore*`
  missing client param (`db.ts:134-138`); annotate schema.sql as stale. Habit undo
  partial-sync bug is absorbed by the Phase 3 rewrite.
- **Phase 1 — types:** `ItemSchema` discriminated union in `packages/types` (branches
  structurally identical to today's Task/Habit + `type`); keep `TaskSchema`/`HabitSchema`
  exports unchanged for the plugin; apply the `weekly→custom` preprocess to the habit
  branch too (it only existed on tasks); add registry. Rebuild committed `dist/`.
- **Phase 2 — DB:** migration 019 as above; collapse `lib/db.ts` to one mapper trio + one
  CRUD set parameterized by type, **per-type update allowlists kept separate** (a merged
  allowlist would let habit fields write onto tasks — the allowlist is the only field
  filter for agent PATCH routes), webhook names/payloads mapped from type; agent routes'
  service-role ownership pre-checks point at `items` (do NOT lose these — they exist
  because the service client bypasses RLS).
- **Phase 3 — store:** single `items: Item[]` in planner-store with `tasks`/`habits`
  exposed as projections (limits component churn to zero initially); unified action set
  dispatching via registry; one `getBucketForTime` helper (kills 6 copies); both types'
  per-date completion through the atomic RPC (habit read-modify-write was race-prone);
  undo/redo unified with schema-derived field list (kills hardcoded lists at
  `planner-store.ts:1043,1137` and the habit status-gate bug at `:1060-1075`); history
  reset at cutover; persisted `timelineItemFilter` migration; `deriveDayItems` keeps its
  `tasksByBucket`/`habitsByBucket` output shape as a projection.
- **Phase 4 — UI (SHIPPED):** one ItemDialog (add/edit) driven by the registry; unified
  sentinel handling (`''` vs `'none'`); local-date parsing kept verbatim (off-by-one
  guard, now in `item-dialog.tsx` `draftFromItem`); `ui-store` single `edit-item` dialog;
  edit-habit's legacy emoji grid migrated to IconPicker; rows keep per-kind testids for
  now. See "Phase 4 deliberate behavior changes" below.
- **Phase 5 — external/AI (SHIPPED):** context endpoint adds `items[]` + schemaVersion 3
  additively (optional in the schema — a required key would brick old-plugin safeParse);
  `/api/agent/tasks|habits` are facades over `lib/agent-api.ts` (shared auth, Zod
  write-body schemas in packages/types, 400s at the boundary); Beacon chat context +
  system prompt render per-type via `ITEM_TYPES[type].ai.renderContextSection` /
  labelPlural (byte-parity locked by tests/unit/ai-context.test.ts — NOTE the original
  plan said "streak-ranked" but no surface ever sorted by streak; habits are
  streak-ANNOTATED in store order, preserved verbatim); morning-check gates on
  carryForwardEligible+dateAnchored over items[]; EOD uses registry label/streak
  constants; dist-matches-src CI gate + publish-ordering docs in packages/types/README.
  See "Phase 5 deliberate behavior changes" below.
- **Phase 6 — extensibility:** `item_types` table + CRUD + manage-types UI (create
  "goal" etc.); drop the type CHECK; registry hydrated from DB; dynamic `TYPE_OPTIONS`,
  `create.<type>` palette commands, `type:<name>` search grammar (keep `task:`/`habit:`);
  `data-item-type` attributes app-side (e2e selector migration moved to the separate
  e2e-repair effort); after bake: drop legacy tables, retire RPC wrapper.

  **Phase 6 settled design (written 2026-07-27; typing REVISED during 6a):**
  - *Typing:* custom items use a CLOSED envelope `{ type: 'custom'; customType: string;
    ...taskShape }` — an open `type: string` union branch was tried first and destroys
    discriminated narrowing at every `item.type === '…'` site (then- AND else-branches
    keep the custom member). `ItemType` = 'task'|'habit'|'custom';
    `KnownItemType = 'task' | 'habit'`. The DB stores the SLUG in items.type; the app
    maps slug ↔ envelope in itemFromRow/itemToRow, and db-layer `type` params stay the
    DB slug (`.eq('type', slug)`). Registry lookups go through
    `getItemTypeConfig(name: string)` (built-in → hydrated custom → default template,
    never undefined) with `itemTypeName(item)` = type==='custom' ? customType : type.
    'custom' joins task/habit as a reserved slug in the migration CHECK.
  - *Zod:* `CustomItemSchema` = the envelope above; `ItemSchema` stays a
    discriminatedUnion(task, habit, custom). MUST land in the types package before any
    plugin build parses `items[]`, or a custom item bricks the plugin cache.
  - *DB (migration 021):* `item_types` table (id uuid, user_id FK cascade, name slug
    UNIQUE per user + CHECK not in ('task','habit'), label, label_plural, icon, color,
    config jsonb default '{}', timestamps, RLS + updated_at trigger); DROP
    items_type_check; RELAX items_status_check to: task vocab for task, habit vocab for
    habit, task vocab (pending|completed|cancelled) for everything else.
  - *Custom-type capability template (v1):* task statuses/doneStatus, defaultFrequency
    'none', task frequency list, dateAnchored+dateAddressable true, orderable FALSE
    (order writes are per-type; custom sorts by created_at), containerKind null,
    counters none, schedule resizable + 60min, braindumpEligible true,
    carryForwardEligible FALSE (morning-check rollover uses updateTask which type-guards
    to no-op on non-tasks — flip only when the store gains generic updateItem),
    webhookEvent 'tasks.updated'/payloadKey 'task' (trigger-only; plugin ignores
    payloads and the context tasks[]/habits[] projections EXCLUDE custom types — locked
    decision #6; custom items travel in items[] only).
  - *Store:* item_types rows load with fetch; hydrated configs in a store slice; generic
    `addItem(type, partial)`/`updateItem(id, type, updates)`/`deleteItem(id, type)`
    actions for custom types (task/habit keep their named actions); db.ts itemFromRow/
    itemToRow/updatesToRow gain a generic (task-shaped) branch for unknown types.
  - *Beacon prompt:* becomes `buildBeaconSystemPrompt(types)` + the existing const for
    the built-in default (pinned test unchanged); chat-store passes hydrated types.
  - *Agent API:* custom types NOT exposed in v1 (routes stay task/habit; items[] serves
    reads).
  - *Slices:* 6a foundation SHIPPED (d88f242); 6b SHIPPED (106c2e8 task-pipeline ride +
    a2c015a manage-types UI); 6c search grammar (`type:<name>`) + `data-item-type` row
    attrs SHIPPED. Migration 021 APPLIED to prod 2026-07-27 and verified (item_types +
    RLS live, items_type_check dropped, status CHECK carries the custom else-branch).
    DEFERRED from 6c: dynamic `create.<type>` palette
    commands — the command registry is a static array by design and dynamic commands
    belong with command-palette round 2's registry work (custom types are fully
    creatable via the add-dialog tabs meanwhile). The Phase-6-wide adversarial review
    ran post-push (3 lenses, 16 confirmed findings): FIXED — applyHistoryState now
    resolves the DB slug (blocker: every custom-item undo/redo write silently no-opped;
    regression-tested), addItem rejects reserved/unhydrated slugs, edit-mode renderForm
    resolves the registry name (was rendering the 'custom' fallback config), row
    delete-confirm copy comes from the registry, add-reseed effect deps narrowed back
    (typeNames/habitGroups re-fires were clobbering open drafts), pre-migration write
    guard (fetchItemTypes null ⇒ itemTypesAvailable=false gates type creation — the
    read-path-only "deploy-safe" claim was insufficient), type:<slug> parser +
    custom-undo unit tests added. KNOWN/ACCEPTED v1 gaps (documented, not fixed):
    manage-types UI has no
    label-rename or plural editing; items of a deleted type keep working on the
    fallback template (by design); a plugin built from the Phase-5 types (items[]
    without the custom branch) would brick on the first custom item — always build
    the plugin from current types. buildBeaconSystemPrompt(types) SHIPPED post-review:
    the default prompt announces custom-type nouns from the hydrated store; a
    user-customized prompt wins untouched.

    **Deferred ledger CLOSED (2026-07-28).** All three custom-type follow-ups are
    shipped: `create.<type>` palette commands landed with command-palette round 2
    (`f73ebfa`, the `customTypeCommands` provider in lib/commands/registry.ts —
    memoised on the type-list identity, alias guarded against static commands);
    Beacon nouns in `ee1ec07`; omnibar per-type search sections in `1278432`
    (lib/search.ts `groupResults`, rows sharing round 2's itemIcon/itemContainer).
    Nothing custom-type-shaped is outstanding except the manage-types rename gap
    above and the e2e suite, which is its own effort.

  **Follow-up (Kirby, 2026-07-27): ItemDialog type selector redesign — SHIPPED
  2026-07-28 as a full dialog redesign.** No Figma frame existed, so the design was
  settled in two artifacts (four type-selector studies, then a full redesign with
  every state + spec + build plan) and built from those. What landed:
    - `components/primitives/property-chip.tsx` — the load-bearing primitive.
      Chip + Popover, `children` is a render prop taking `close`. The rule the
      layout rests on: an UNSET chip shows the noun ("Priority"), a SET chip shows
      the value ("High"). That is what let the labels go without hiding meaning.
    - item-dialog render replaced: type chip (add) / type badge (edit) in the
      header, borderless title, ONE wrapping chip row, hairline footer. Which
      chips exist is capability config — a new custom type needs no dialog work.
      Duration folded into the Time chip; the weekday cards and the 31-day grid
      moved INTO the repeat popover (they used to push Save 60px down the page).
    - Delete + reset-streak moved to a `...` overflow menu; the streak gradient
      panel became a honey strip carrying 14 days of history in the row's own
      `--day-on`/`--day-off` dot vocabulary.
    - Weekday toggles are the project dialog's 36px `rounded-md` cards wearing
      the omnibar's `--shadow-key-rest`/`-pressed` pair: off raised, on pressed.
    - DECIDED: per-type drafts do NOT survive a type switch as isolated forms.
      `switchType()` carries the draft across (title, priority, dates, buckets,
      repeat), deliberately NOT the container (projects and habit groups are
      different namespaces), and clamps a frequency the target type forbids to
      its default. With one form and a switcher, losing the title you just typed
      reads as a bug — which it did not with tabs.
    - DECIDED: edit mode shows the type as a BADGE, not a switcher. Converting an
      item is a data decision (streaks, completion history), not a control.
    - State layer untouched: latch, per-type draft map, render-phase edit
      seeding, and both save adapters are byte-identical.
    - Preserved on purpose so the e2e suite does not rot further: the `Add Task`
      / `Add Habit` button labels, `Save Changes`, the `${type}-title` /
      `edit-${type}-title` input ids, the `What needs to be done?` placeholder,
      `data-sub-input`, and the sr-only `Add New` dialog title.
    - Side change: `manage-categories` gained an optional `tab`, so the type
      picker's "Manage types…" row lands on the Types panel. Keyed `<Tabs>`,
      because the dialog stays mounted and `defaultValue` only applies once.

    ADVERSARIAL REVIEW (6 dimensions x refute-pass, 10 of 32 claims confirmed),
    all fixed before commit. The instructive ones:
      - `switchType` was copying fields the SOURCE type never rendered, so its
        defaults overwrote the target draft. A hop through Habit erased a task's
        payload-seeded date (day-buckets "+" passes `selectedDate`) AND made the
        next task `repeatFrequency: 'daily'` — a silently recurring task, from
        two clicks that touched neither control. Now a field travels only if the
        source type exposed it (`fromConfig.fields`), and a frequency travels
        only if it differs from the source type's own default.
      - Seeding `activeType` in an effect was a one-frame flicker with tabs and
        a FUNCTIONAL bug with one form: the title input mounts once, `autoFocus`
        only fires on mount, so opening Add Task right after Add Habit mounted
        the input unfocused and React ignored the later prop flip — focus parked
        on the type chip. Seeding moved render-phase (matches the edit path).
      - Radix menu items `preventDefault` their Enter but do not stop
        propagation, and portalled content still bubbles through React's tree:
        Enter on "Delete" opened the confirm AND saved+closed the dialog, leaving
        the confirm floating over nothing with an inert button (its handler bails
        on the now-null `state`). The dialog's Enter handler now respects
        `e.defaultPrevented`.
      - Chip pickers are portalled outside the modal, so react-remove-scroll
        preventDefaults wheel over them — a long project list could not be
        scrolled. PropertyChip carries the same ref-callback wheel listener
        IconPicker already documents.
      - `--day-off` is a RING token (its 72%/50% per-theme alpha is tuned for a
        1px hairline); as a 5px fill it made missed days the loudest marks in the
        streak strip in light mode. Done beads are `bg-warning-text`, misses are
        `border-day-off` rings — the row's own DayDots vocabulary.
      - `max-w-[460px]` never applied (DialogContent ends in `sm:max-w-lg`;
        tailwind-merge keeps both, later source order wins) — so the dialog had
        silently been 512px, and the old 425 was equally dead. Now
        `sm:max-w-[460px]`, which is the first time the chip row renders at the
        width it was designed for.
      - `dark:bg-input/30` on Input outranks `bg-transparent`; the borderless
        title needed `dark:bg-transparent`. Same latent miss exists at
        chat-conversation.tsx:287 on a Textarea — house-wide gap, not fixed here.
    Deliberate consequence, claimed and refuted: duration is only reachable once
    a date is set (it lives in the Time chip, which appears with the date). The
    old form always showed a duration select for a date-anchored type. Undated
    items keep the 30-minute default until they are scheduled.

  **Phase 6b settled scope (decided during 6a):** custom items ride the TASK pipeline
  instead of a parallel one. (1) planner-store generalizes the task action set to
  "task-like" items (`findTaskLike(id)` = non-habit): updateTask / deleteTask /
  toggleTaskStatus / scheduleTask / assignTaskToBucket / unscheduleTask resolve the DB
  slug via `itemDbType(found)` (updateItemAction's dbUpdateItem call must switch off the
  literal action-type too, or custom writes no-op against .eq('type','custom')); adds
  `addItem(customType, draft)`. (2) The store's `tasks` projection widens to non-habit
  items (runtime objects keep type/customType since projections are filters, not maps)
  so every view/DnD/EOD surface renders customs with zero churn — the app-internal
  projection is NOT the pinned API projection (db.ts fetchTasks stays type==='task').
  (3) Registry template flips carryForwardEligible to TRUE — its false value existed
  only because updateTask used to no-op on non-tasks; with generalized actions,
  morning/EOD carry-forward of dated customs is correct behavior. reorderTasks stays
  task-only (orderable false). moveTask*ProjectBlock stays task-only (no containers).
  (4) ItemDialog: tabs render from the hydrated type list (store `itemTypes`
  subscription; TabsList grid-cols via inline style for n>2), add-mode dispatches
  `addItem` for custom slugs, edit-mode already flows the generalized task path.
  Add-drafts rebuild when the type list changes. (5) Manage-types UI lives in
  ManageCategoriesDialog (natural home next to projects/groups): create (name slug +
  label + plural + IconPicker), rename label, delete (items fall back to default
  template — copy must say so). (6) 6c: `create.<type>` palette commands from hydrated
  types, `type:<name>` search grammar keeping task:/habit:, data-item-type attrs on
  TaskRow (e2e selector migration stays with the separate e2e-repair effort).

## Phase 3 deliberate behavior changes (reviewed + documented 2026-07-27)

The store rewrite is behavior-preserving EXCEPT these conscious changes:

1. **Completion writes are intent-based + atomic** (migration 020
   `set_item_completion(id, type, date, completed, adjust_streak)`): one
   statement sets the desired end state and moves streak only when the date
   array actually changes. Fixes the old read-modify-write races, the
   parity-toggle intent inversion under stale clients, and streak/date desync
   under partial failure. Streak is server-owned on live toggles; the store's
   companion habit update excludes completedDates AND streak. Undo/redo
   replays completion diffs as per-date intents with adjust_streak=false and
   restores streak via the normal patch.
2. **`updateTask`/`updateHabit` persist the auto-corrected timeBucket** (old
   code corrected only local state, so the correction vanished on reload).
3. **Store-miss = full no-op**: actions on ids absent from the store no longer
   issue blind DB writes (old code could mutate soft-deleted trash rows).
4. **`resetHabitStreak` sends `{streak: 0}` only** — completedDates AND
   dailyCounts survive (history, not counters). Confirm-dialog copy updated
   to match.
5. **Undo/redo diffs ALL fields for both types** (old habit sync fired only on
   status change — title/group edits never persisted their undo) and
   **containers diff by id, not name** (a name-keyed diff turned rename-undo
   into soft-deleting the only copy). `restoreProject`/`restoreHabitGroup`
   are id-based now; a restore also re-pushes the full snapshot shape.
6. Action labels added for scheduleHabit/moveTask*ProjectBlock (previously
   inherited stale labels).

Deferred, recorded here on purpose: persisted `timelineItemFilter` migration
(needed only when the filter vocabulary opens up in Phase 6); `projectItems`
rebuilds both projection arrays per mutation (extra cross-kind re-renders,
verified loop-free — memoize only if profiling ever demands it); db allowlist
↔ schema-fields drift is now guarded by tests/unit/db-allowlists.test.ts.

## Phase 4 deliberate behavior changes (reviewed + documented 2026-07-27)

One `ItemDialog` (add + edit) replaced AddTaskDialog/EditTaskDialog/
EditHabitDialog; registry gained a `form` section (titlePlaceholder,
editDescription, containerLabel, newContainerLabel, newContainerIcon,
deleteDescription). Behavior-preserving EXCEPT these conscious changes
(4-lens adversarial review, 15 findings verified, 2 should-fixes fixed):

1. **Sentinels unified on `'none'` + explicit None items** — add mode can now
   clear priority and unassign project (edit behavior won).
2. **Edit dialogs are ResponsiveModal** — bottom drawer on mobile (desktop
   unchanged). New `ResponsiveModalFooter` primitive.
3. **edit-habit's legacy 30-emoji grid replaced by IconPicker** — new groups
   store `icon:` tokens; legacy raw-emoji values still render via
   CategoryIcon. Group select rows also render through CategoryIcon now.
4. **Inline container creators in EDIT mode seed the default icon token**
   (Briefcase/Star) instead of `''`.
5. **Shell hovered-delete confirm copy comes from the registry** — habit
   delete now warns "and all its history" (was task copy for both).
6. Cosmetic: Calendar popover `align="start"` in add mode; a few class-level
   unifications (`truncate`, `w-full overflow-hidden` wrapper, gap-3);
   dateless edit-task Time select shows the `--` placeholder (was blank);
   a successful add resets the uncommitted creator icon pick (was kept).
7. **Latch hardening (regression fixes over the originals' semantics):**
   save/delete/reset handlers guard on the LIVE dialog state so the close
   animation can't re-fire a save (double-Enter), confirm flags disarm when
   the dialog payload changes (stranded "Reset Streak?" could otherwise fire
   on the wrong habit), and the edit draft seeds render-phase so switching
   edit targets across types never paints a stale frame.

Old add-dialog dead code (unreachable project/group delete AlertDialog,
`EMOJI_OPTIONS`) dropped. E2E text contracts preserved: 'Add New',
'What needs to be done?', 'Add Task'/'Add Habit', 'Edit Task'/'Edit Habit',
'Save Changes', input ids `task-title`/`habit-title`/`edit-task-title`/
`edit-habit-title`, `data-sub-input` Enter routing, `__new__` sentinels.

## Phase 5 deliberate behavior changes (reviewed + documented 2026-07-27)

Agent-route behavior is preserved for every payload the deployed OpenClaw
plugin's tools actually send (verified against openclaw-plugin/src/tools.ts),
EXCEPT these conscious changes (4-lens adversarial review; 13 findings
verified, 2 blockers fixed pre-commit):

1. **Invalid write bodies 400 instead of 500** — malformed JSON, junk
   status/repeatFrequency (used to 500 on DB CHECKs), null on NOT-NULL
   fields, non-uuid ids, fractional values on integer columns.
2. **Junk priority/timeBucket 400 instead of being silently STORED** (these
   two columns have no CHECK — the old routes stored e.g. 'urgent' verbatim).
3. **Legacy 'weekly' frequency normalizes to 'custom'** instead of 500ing;
   custom-frequency writes (create AND update) require non-empty repeatDays
   in the same body — a stored custom-without-days item fails the plugin's
   whole-context safeParse and bricks its cache. Consequence: a "switch back
   to custom" PATCH must resend repeatDays. (Pre-existing residual hazard: a
   PATCH nulling repeatDays while the stored frequency is already custom
   still reaches the bad state — existed identically before.)
4. **Create title is required non-empty**; notes + the schedule-internal
   fields (completedDates/inProjectBlock/previousStart*) are now accepted on
   task create (PATCH always accepted them; create silently dropped them).
5. **Habit create defaults (streak 0, empty arrays/counts) are seeded by the
   shared handler** (AGENT_API createDefaults) — items.streak has no column
   default and the completion RPC skips NULL streaks, so this is
   load-bearing, not cosmetic. 201 echo shape matches the legacy routes.
6. **Update webhooks broadcast the VALIDATED body** (unknown keys stripped)
   instead of the raw request body. The plugin ignores webhook payloads
   (full refetch on any event), so this is unobservable today.
7. schemaVersion 2 → 3; `items[]` served (optional in the schema).

## Post-Phase-6: habits carry a duration (Kirby, 2026-07-29)

The first capability change made *because* the types are unified rather than to
preserve pre-unification behavior. `duration` joined `habitShape`, so a habit has a
real length ("30 minutes of reading a day" is the habit, not a default someone
tolerates) and its blocks resize on the grid like any other type's.

- **No migration.** `items.duration int` has existed and been nullable since 019 with
  no CHECK; habits were simply never written to it. Existing habits read `null` →
  the registry's `defaultBlockMinutes`, so nothing changed for existing data.
- **Additive for the pinned contract.** `toLegacyHabit` is spread-minus-discriminator,
  so `/api/agent/context` `habits[]` carries `duration` automatically, and
  `HabitCreateSchema` (which spreads habitShape) / `HabitUpdateSchema` accept it —
  int-constrained like the task side, `clearable` on update since the column is
  nullable. Verified against the pre-change published schema straight out of git: an
  already-deployed plugin build `safeParse`s the new payload and **strips** the key
  (Zod objects are non-strict), so locked decision #6 holds and no plugin rebuild is
  forced. Duration-less habits still parse.
- **`schedule.resizable` / `defaultBlockMinutes` were dead config** — declared since
  Phase 1, read nowhere. Now consumed by `deriveTimedEntries` (both branches; the
  habit one had a hardcoded 30) and by `ScheduleBlock`'s `canResize`, which asked
  `isTask` and therefore could never honor a custom type that declared
  `resizable: false`.
- **`defaultBlockMinutes` corrected 60 → 30 for task/custom.** The 60 was
  aspirational: the ItemDialog seeds `'30'` and the grid rendered duration-less
  blocks at 30, so consuming the declared value as-written would have silently
  doubled every such block. Value follows behavior. The dialog's two `'30'`
  literals now read the registry too.
- **The resize write dispatches per type.** `onResizeUp` called `updateTask`, which
  the store narrows to task-like (non-habit) items — a habit resize would have
  previewed and then silently no-opped on release.
- **The dialog's duration gate is now purely capability-based.**
  `config.dateAnchored && fields.includes('duration')` → `fields.includes('duration')`.
  The `dateAnchored` half did two jobs: keeping duration behind a date for tasks,
  which the enclosing Time chip already does (`showTime`), and hiding it from habits,
  which had no field. Un-anchored types reach duration through the chip that is
  always open to them. The Phase-4 note "duration is only reachable once a date is
  set" still holds for date-anchored types.
- Consequence to watch: habit blocks can now be tall, so `deriveGridRange` windows
  can widen on habit-only days. `switchType` will also carry duration across a
  task↔habit switch, which `exposed('duration')` now permits — correct, since both
  types expose the field.

**Row rail follow-on (same day).** Showing habit duration in rows forced the quiet
rail's two shared columns to be re-cut, because the quantity slot held duration for
tasks and the streak count for habits — one column, two units, scannable as neither:

- **QUANTITY (48px) is now duration for every type.** One unit down the column.
- **GLYPH went 16px → 36px** and holds flame + streak count for habits, priority
  bars for tasks. Both types start their ink on the slot's left edge, so the bars
  occupy exactly the first 16px as before and nothing that was already in the rail
  moved; the slot only grew rightward, and the quantity column didn't shift. The
  streak numeral stays `text-muted-foreground` rather than picking up the flame's
  honey — pills.tsx quarantines colour to glyphs, never body text.
- The `item-streak` testid moved with the count (habits.spec asserts bare numbers
  against it) and renders even at streak 0, so it stays resolvable in every state.
  `item-duration` is now on both types' quantity slot.
- Only default-density rows carry the rail (week/compact and braindump gate it off),
  and every default-density caller is full-canvas-width, so the +20px lands nowhere
  tight.
- **Every rail column now answers on hover** via `RailTooltip` (pills.tsx): an
  eyebrow naming the column over the value in words, wearing `TooltipContent`'s
  popover shell so it matches the DayDots keycap panel and the History popover.
  The native `title` attributes on PriorityGlyph and TagDot are gone — they fired a
  second, unstyleable tooltip in a system font at the OS's delay. The identity
  column's eyebrow is the registry's `form.containerLabel`, so a task says
  "Project" and a habit says "Group" without either being hardcoded. RailTooltip
  adds no DOM around its trigger (Radix `asChild`), so the rail's flex children are
  unchanged.

## Behavioral invariants to preserve (regression traps)

- Priority/project filters hide ALL habits (day-items, search, braindump) — once habits
  *can* carry those fields this must stay explicit, not accidental.
- `showCompletedTasks` gates tasks only; habits-before-tasks bucket ordering is implicit
  concatenation — preserve via projection ordering.
- Habit drops in week view are global (no dateStr) — a unified DnD path must keep
  `dateAddressable=false` for habits or week drops become single-date moves.
- Sidebar drop relies on `unscheduleTask` no-oping for habit ids
  (`handle-drag-end.ts:79-81`) — make the no-op explicit via `braindumpEligible`.
- StreakFlame at streak 0 is the only visual habit marker in rows.
- Recurring tasks NEVER mutate scalar `status` (migration 016 semantics; per-date
  `completed_dates` is truth); habit `status` is a denormalized "last toggle" snapshot.
- Habit UI forbids `repeatFrequency: 'none'`; add-dialog uses `''` sentinel vs
  edit-dialog `'none'` sentinel — don't leak either into the DB.

## Verification gates

Unit: `tests/unit/*` (recurrence, day-items, search-parser, handle-drag-end, commands,
grid-range). E2E (needs migrated DB + running app): dnd, recurring, undo-redo, smoke,
view-matrix, omnibar, settings, eod-review. Plugin smoke: `GET /api/agent/context` parses
with the **old** published `DsulContextResponseSchema`. Every `lib/dnd/CONTRACT.md`
change lands with its e2e spec in the same commit.

## Supabase access + applying the migration

Official Supabase MCP (OAuth, project-scoped `ctcspcferkdlzdcqlozq`) is configured in
`.mcp.json`. First use: run `/mcp` → authenticate in browser. Then Claude can
`apply_migration` directly. Until then: paste `supabase/migrations/019_unified_items.sql`
into the SQL editor (same workflow as migrations 001–018). **The app must not run against
the DB until 019 is applied** once the db-layer cutover lands.
