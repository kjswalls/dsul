# Long-term Goals — an aspiration container over unified items

**Status (2026-08-20): BUILDING. Phase 0 shipped and reviewed** (see the phase
ledger). Round-1 design review folded in below. Product direction from Kirby's brief ("long term
learning plans and goals with milestones, habits, certain things that need to be
scheduled, date check-ins — like learning Chinese with fluency goals along the way,
or building a $3m business in 3 years"). **All eight open questions answered by Kirby
2026-08-20: the recommendations stand as written** — the noun is **Goal**; membership
is many-to-many; milestones are items-with-a-role; behind-on-a-milestone rides the
normal past-due machinery quietly; no numeric targets in v1; no auto-achieve;
check-ins default weekly with the item owning its recurrence; no ScopeRail or
Display-menu presence. The pre-build review ran 2026-08-20 (5 lenses; 2 blockers,
~18 should-fixes, ~12 notes — all folded in below; see the review section at the
end). Read [unified-items.md](unified-items.md) and
[programs-routines.md](programs-routines.md) first — this plan builds on their
locked decisions and amends none of them.

**Goal:** A **Goal** is a long-horizon container — "Learn Chinese", "Build a $3m
business by 2029" — that holds the work serving it: **milestones** (the achievement
checkpoints along the way and at the end), **habits** (daily practice), **tasks and
scheduled items** (book the exam, register the LLC), and **check-ins** (recurring
review dates). A goal shows derived progress, a target date, and the reason it
exists. It never hides work and never rewrites it — it is the WHY layer over items
whose WHAT and WHEN stay exactly where they are today.

---

## The core modeling decision: a fifth container, third role

Three shapes were considered. The first two lose on the codebase's own arguments.

**Not an item type.** unified-items.md floats `goal` as the canonical example of a
future custom type, and a user can create one today — but item-type machinery gives
a goal exactly the wrong things. A type gets a scalar status, grid blocks,
occurrences, a row in day columns; a goal has none of those. What a goal needs is
*containment* — habits AND tasks together, which no item can hold (subtasks are
task-only, undated, invisible on every grid surface by design — item-surface-growth
Phase 2 excludes them from the `tasks` projection precisely so they never float
free). Milestones need dates, completion, past-due pressure, Beacon narration —
all machinery items already have and subtasks deliberately don't. A goal-as-item
would rebuild containment badly; a goal-as-container gets item machinery for its
members for free.

**Not a program, and not suppression.** Programs answer WHEN WORK COUNTS — membership
switches items off (container-registry.ts's `gate` role). A goal answers WHY WORK
MATTERS. Conflating them breaks both: pausing "Learn Chinese" must not erase today's
practice habit from the grid (the habit may also serve "Morning routine"), and a goal
you're behind on is the *last* thing that should quietly hide its work. An item can
sit in a goal AND a program simultaneously — the Chinese habit inside the school-year
program, serving the fluency goal. So goals join the container registry as a **third
role** — neither `classify` (one per item, the filter/group axis) nor `gate`
(activation) — call it **`aspire`**: many-to-many, no suppression, no unset state.

**Not a project.** Projects are `classify`: exactly one per item, and habits don't
carry the axis at all (they classify by group). A goal must hold habits and tasks
together, and an item may serve two goals ("morning run" serves both Health and
Marathon). That is the join-table shape routines/programs already built — composite
FKs, RLS, soft-delete-survives-membership, reconciliation, the dangling-id rule —
and goals reuse all of it.

**How touchpoints are actually found (corrected by review).** The draft claimed
"adding the kind is a type error at every exhaustive switch." That is nearly
vacuous: there are ZERO switches over `ContainerKind` in the codebase — every
consumer narrows to `ClassifyKind` or `GateKind` first (which is exactly why
filters/grouping/ScopeRail need no edits). The compile-forced edit is the
`Record<ContainerKind, …>` entry alone. The real tripwires are:
`tests/unit/container-registry.test.ts:39-51` (asserts the two role lists and that
every kind has exactly one of the two roles — all three assertions fail on `aspire`
and must be updated to assert the THREE-way partition), and a hand-wired list this
plan carries so nothing is discovered by accident: the console section vocab
(`console-rail.tsx` `CONSOLE_SECTIONS` + `ConsoleSection`), ui-store's `organize`
dialog payload, `Memberships` and the history-baseline literal (store plan below),
the omnibar channel, and the plugin. Also: `lib/agent-api.ts:519` declares its OWN
unrelated `ContainerKind = 'routine' | 'program'` driving `CONTAINER_API` — Phase 4
must rename one of the two before adding goals there, or the identical name with
different meanings will mislead every later reader.

## Locked design decisions

1. **Goals are a new container table (`goals`) + one join table (`goal_items`),
   id-referenced.** The modern container pattern (programs-routines locked decision
   1): rename from day one, composite `(id, user_id)` FKs so cross-tenant membership
   is unrepresentable, membership survives member soft-delete (restore-intact),
   arrays pruned only by the purge CASCADE.

2. **Milestones and check-ins are ordinary items wearing a membership role, not new
   entities.** `goal_items.role ∈ ('member','milestone','checkin')`. A milestone is a
   one-shot task-like item whose `startDate` is its target date — it renders on the
   grid that day, goes past-due when missed (being behind on a milestone *should*
   show up in the past-due bar), completes through the normal paths, narrates through
   Beacon, and undoes through the normal history. A check-in is a *recurring* item
   ("Weekly Chinese review", every Sunday) — recurrence, per-date completion, and
   skips: all existing machinery. (NOT reminders: `reminder_at` is a dead column —
   migrations 007/019 only, read by no code — so the honest nag story is the EOD
   review on the due day and nothing else. Guilt-free silence is the v1 posture,
   claimed rather than implied; a reminder would be a new subsystem and is
   deliberately out of scope.) A dedicated `milestones` table was rejected because
   it would re-implement dates, completion, overdue, Beacon, undo, and grid presence.
   - The PK `(goal_id, item_id)` means an item holds exactly ONE role per goal —
     it can't be both member and milestone of the same goal, by construction.
   - Role is a property of the MEMBERSHIP, not the item: "HSK 3 exam" can be a
     milestone of Learn Chinese and a plain member of Q3 Admin. No item column, no
     schema drift, nothing for the OpenClaw plugin to choke on.

3. **Role shape is enforced at grant time AND survives item edits by demotion, never
   by blocking.** (Review blocker, found by two lenses independently.) The registry
   predicates guard the role WRITE — `isMilestoneEligible(item)` = capability
   (`milestoneEligible`: task true, habit false, custom-template true) AND NOT
   `isRecurring(item)`; check-in role requires `isRecurring(item)`; plain `member`
   reuses `isCollectible` with its subtask exclusion. But a predicate asked at
   role-write time cannot see a LATER item edit, and the item dialog + agent PATCH
   freely flip `repeatFrequency`. A recurring item's scalar status is frozen by
   design (migration 016 semantics), so a milestone made recurring becomes
   permanently un-achievable (or stays stale-'completed' forever) and progress lies
   silently. The mechanism, decided pre-build: **an item write that invalidates a
   held role auto-demotes that role to `member`, with a standard receipt toast
   naming the goal** ("No longer a milestone of Learn Chinese — it repeats now").
   Blocking the edit would make goals constrain their members (against decision 4's
   spirit); tolerating leaves progress lying. Demotion is one join-row write, rides
   the normal undo, and fires from the store's item-update path (which must consult
   a memoized item→roles index — the same index the milestone row flag needs) and
   from the agent item PATCH handler. Symmetric: a check-in edited to
   `repeatFrequency: 'none'` demotes to `member`. `switchType` in the add dialog
   drops a draft role the target type is ineligible for (keeping the plain
   membership) — the Phase-3 "switchType discarding membership" lesson, extended to
   roles.

4. **Goals never suppress and never write member fields — with two narrow,
   protective exceptions to "zero special casing" in the past-due machinery.**
   No `lib/active.ts` changes, no `inactiveItemIdsOn` involvement, no ScopeRail row.
   Goal state changes are one container row (one undo entry); no goal operation ever
   touches member `status`/`streak`/`completedDates`/`startDate`/`repeat*`/
   `timeBucket`. But the review found the converse hazard: the past-due machinery
   WRITES `startDate`, which for a milestone is semantic goal data, not stale
   scheduling residue. So:
   - **The auto-age sweep excludes milestone-role items.** `unscheduleTasks` sets
     `startDate: undefined` — it would silently erase a milestone's target date, and
     with it the plan's whole behind-ness story (the overdue milestone leaves the
     bar, demotes to undated in `nextMilestone`, and the goal timeline has nothing
     to annotate). The exclusion is safe against the sweep's hydration hazard only
     because goals load in `initializeStore`'s same `Promise.all`/`set()` as items
     (the documented use-overdue-sweep gate contract) — moving goals out of that
     Promise.all would silently unprotect every milestone; recorded as a trap.
   - **Bulk date verbs skip milestone-role items** the way they already skip
     recurring ones: EOD "Move all to tomorrow", morning "Move all to today".
     Single-item date edits (the dialog's date chip, the tray's "pick a new date")
     remain fully allowed — deliberately rescheduling a milestone is legitimate —
     with the decision-11-style receipt ("Moved the Learn Chinese milestone to
     Jul 15").

5. **Goal lifecycle is its own tri-state, with pinned `achieved_at` semantics and a
   wind-down step.** `state ∈ ('active','achieved','abandoned')`, default `active`.
   - `achievedAt` is IN the schema and IN the update allowlist, stamped by
     `setGoalState` app-side (UI path) and derived server-side on the agent path
     (never client-supplied there — the `pausedAt` doctrine). Allowlisted
     deliberately, against the `updatedAt`-stays-out pattern: it sits in GOAL_FIELDS
     and therefore in undo's container diff, which is exactly what makes undo of
     "Mark achieved" restore `state: 'active'` AND clear the stamp in one replay.
     Idempotence rules, pinned now because retried PATCHes are expected traffic:
     a state write to a goal ALREADY in that state is an empty patch (never
     restamps — a retry must not move a multi-year goal's achievement date);
     `state: 'active'` clears `achieved_at`. (`updatedAt` is dropped from GoalSchema
     entirely — programs carry it solely for the sweep grace, which goals don't
     grant; a field no consumer reads is a field that drifts.)
   - **Achieving or abandoning runs a wind-down step.** Ended goals leave the active
     lists and chips — but their recurring members (the check-in this goal created,
     the practice habit) keep firing forever with the WHY stripped away: a
     contextless weekly nag in every Sunday EOD. The achieve/abandon flow therefore
     lists the goal's recurring members with keep / delete / "move to a program to
     pause" affordances (writes are the user's, per-item, through normal actions —
     the goal itself still writes nothing). And the item side keeps the thread: the
     Goal chip lists ended-goal memberships under a muted "Ended" divider, so a
     still-scheduled milestone of an abandoned goal is never an unexplained row.
   - Ended goals stay browsable in the console list, sunk below active goals under
     a quiet divider (the Trash rail-rule precedent) — not interleaved in
     `sort_order` where they read as clutter by year two.
   - Completing the last milestone does NOT auto-achieve. **The celebrate prompt is
     a toast-style receipt, not a dialog** (`ActiveDialog` is a single slot — a
     dialog fired during EOD would destructively replace it), with a "Mark
     achieved" action. It fires only on a live user completion (never on agent
     writes, never on undo/redo replay), only when the goal has ≥1 milestone and no
     un-achieved dated milestone remains, and its copy respects a distant
     `targetOn` ("All 2 milestones so far — target is 2029" offers review, not
     achievement).
   - Soft-delete + 30-day purge are a separate axis from `abandoned`. **Accepted
     decay, stated so it never reads as a bug:** an achieved goal's history is
     stored in deletable item rows; trash an achieved milestone and after the purge
     its join row CASCADEs — 7/7 becomes 6/6, and the timeline entry vanishes.
     `item_events` survives purge but carries no role, so it cannot reconstruct the
     list. An achievement snapshot at achieve-time is the fix if this chafes;
     recorded under Deferred.

6. **Progress is derived, never stored — with display rules, because the fraction is
   the only signal.** `achieved / total` over live (dangling-id-filtered),
   non-cancelled milestone-role items; achieved = scalar status === the type's
   `doneStatus` (truthful because decision 3 keeps milestones one-shot).
   - **Cancelled milestones leave BOTH sides of the fraction** — a cancelled
     milestone is a dropped checkpoint, not a failure to count forever: it is
     status-writable by the agent API, excluded from `selectOverdue`, and reversible
     from no UI, so counting it in the denominator makes the goal read permanently
     behind with no visible cause and no exit. The timeline shows it quietly as
     dropped (never struck-through — struck-through means done).
   - **Zero milestones suppresses the bar** ("No milestones yet" copy) — every goal
     is born 0/0 and a habit-only goal stays there legitimately; "0/0" reads as
     broken.
   - **"All done" is not "done":** while `state` is active and `targetOn` is ahead,
     a full fraction renders as "2/2 so far" — the plan's own $3m example defines
     2 near-term milestones and would otherwise flash a full bar years early.
     `timeElapsed(goal, todayStr)` renders beside the fraction on the goal surface
     as the behind/ahead read; the two are never merged into one number.

7. **External surface is additive-only, on the established schedule — with the wire
   rules pinned.** `goals[]` (optional) joins `/api/agent/context` at
   **schemaVersion 5** (4 is current, taken by programs; "+1" was ambiguous against
   this plan's own phase numbering). `tasks[]`/`habits[]`/`items[]` untouched; goal
   membership travels ONLY in `goals[]` (member ids + roles), never as item fields.
   **`goals[]` is OMITTED, never `[]`, when the table is unreachable** — `[]`
   asserts "you have no goals" to an agent whose natural repair is "shall I set some
   up?" (the routines/programs spread-omit rule, verbatim). No new webhook event
   names. Agent write routes follow Kirby's Phase-4 posture but land in their own
   phase; their refusal doctrine is specified in the Phase 4 section.

8. **The Organize console is the goal's management home; the goal's *reading* home
   is its own surface.** Goals become a console section (which also solves the
   no-unconditional-entry-point failure programs shipped with — the console has
   permanent doors, reachable at zero goals via the braindump folder button, the
   palette, and settings). But a goal is the one container whose DETAIL is a
   destination in itself, so it also gets a deep-linkable page, `/goal/[id]`,
   following the `/item/[id]` precedent (Beacon can answer with a URL). The console
   detail pane and the page render the same sections — growth is a presentation,
   not a fork.

## Target DB shape (migration 036)

**APPLIED and ledger-recorded 2026-08-22** (details in the Phase 0 entry).

**Renumbered 029 → 036 on 2026-08-22, exactly as this section warned.** 028's own
header records the same thing happening — "ledger first, directory second" — and
it happened twice over here. `origin/main` had grown 029_set_item_skip,
030_item_events_retention and 031_items_windowed while this branch was in flight,
so 029 was taken; and the REMOTE LEDGER was further ahead still, at 035
(032_habit_reminders, 033_reminder_channels, 034_stakes, 035_reminder_cron) —
four versions applied out-of-band that exist in no worktree. Reading the
directory alone would have collided; reading main alone would have collided
again. 036 is the first free version above the ledger tip.

All idempotent, house RLS pattern, dates as `yyyy-MM-dd` text, tz app-side.
`updated_at` trigger on `goals` ONLY — never the join table.

- `goals`: id uuid PK gen_random_uuid(), user_id uuid NOT NULL FK auth.users
  CASCADE, name text NOT NULL, `why` text (the motivation line), icon text,
  color text, state text NOT NULL default 'active' CHECK (state in
  ('active','achieved','abandoned')), starts_on text, target_on text,
  achieved_at timestamptz, sort_order int, created_at/updated_at now(), deleted_at.
  Guarded `UNIQUE (id, user_id)` in a DO block (composite-FK target — the 024
  lesson about `create table if not exists` skipping inline constraints).
- `goal_items`: goal_id uuid NOT NULL, item_id uuid NOT NULL, user_id uuid NOT NULL
  FK auth.users CASCADE, role text NOT NULL default 'member', sort_order int
  (milestone ordering), PK (goal_id, item_id), composite FKs
  `(goal_id, user_id) → goals(id, user_id)` and `(item_id, user_id) →
  items(id, user_id)`, both ON DELETE CASCADE (join rows are derived data; RESTRICT
  would abort the nightly purge). **The role CHECK goes in a guarded DO block, NOT
  inline** (review finding): on a partially-applied table a skipped inline PK fails
  loudly at the first upsert, but a skipped inline CHECK fails SILENTLY — junk role
  strings become storable and the three-way split quietly drops those rows. 024 put
  `programs_state_check` in a DO block for exactly this reason. Index
  `(user_id, item_id)`. No timestamps, no trigger.
- Purge cron: extend `purge-deleted-items` with the `goals` line (re-list all seven
  existing DELETEs — the job is replaced whole).
- No `items` columns. Nothing item-side changes — that is the point of role-on-join.
- Ledger: if applied out-of-band, record the version immediately.

**Deploy-order tolerance, by construction (the 024 rule):** `fetchGoals` returns
null on a missing table ⇒ `goalsAvailable = false` gates every goal surface off; no
item-write path changes at all this time (no new item columns), so there is no
PGRST204 hazard to guard. Do not "simplify" the availability gate away.

## Membership write semantics (pinned by review — do not improvise these)

The three role arrays are a READ convenience; the write side must treat the join
table as ONE set. Four rules, each closing a found defect:

1. **One union reconcile per goal, never three per-role passes.** Read all of the
   goal's rows once; build the desired union as `{itemId, role, sortOrder}`; upsert
   with `onConflict: 'goal_id,item_id'`; delete only ids absent from the WHOLE
   union. Three per-role passes make a milestone→member demotion order-dependent
   (the milestone pass DELETEs the row before the member pass re-inserts — a
   failure between the two loses the membership, inverting add-before-remove's
   superset guarantee) and let one role's unscoped DELETE remove a row another pass
   just role-updated. The bulk upsert's rows must carry homogeneous keys —
   `sort_order` present on EVERY row, explicitly null for non-milestone roles, so a
   demoted milestone doesn't keep a stale sort_order perturbing fetch order.
2. **Cross-array overlap is rejected at the boundary, never resolved by
   precedence.** The PK guarantees disjointness only DB→arrays; arrays→DB, the
   same id in two role arrays is two contradictory instructions — as one upsert
   batch it aborts with 21000 ("cannot affect row a second time"), as separate
   statements it's last-write-wins roulette. Store actions throw; the agent route
   400s naming both arrays (reject-don't-pick, the `rejectResumeWithDate`
   doctrine). Per-array dedupe stays too (the existing 21000 guard).
3. **Trashed-member keeping is per-role.** `withTrashedMembersKept` re-adds members
   invisible to the caller; for goals its current-rows read must select `role` and
   route each kept id back into its CURRENT role — applied at the union level with
   a defaulted role, a restore would demote every trashed milestone to `member`,
   silently changing the progress denominator.
4. **The trash bin's goal arm fetches roles.** The console's `listDeleted` joins
   membership because a trashed container has no other member source (the recorded
   Phase-4 near-miss); a goal bin arm copied from the routine arm gets ids WITHOUT
   roles, and restore-then-reconcile rewrites every milestone and check-in as
   `member` while the visible gate stays green. The bin snapshot for goals is
   `{itemId, role, sortOrder}[]`.
5. **Fetch ordering is deterministic for all three arrays**, not just milestones:
   `order('sort_order', nullsLast).order('item_id')` across the goal's rows — the
   024 heap-order finding; ids reshuffling between identical fetches read to the
   membership diff as a real change and get written back.

## packages/types (same commit as the migration, dist rebuilt)

- `GoalSchema`: id, name, why?, icon?, color?, state, startsOn?, targetOn?,
  achievedAt?, plus the three role arrays — `memberIds`, `milestoneIds` (ordered),
  `checkinIds`. Three arrays rather than `{id, role}[]`: every consumer wants one
  role's ids and disjointness holds on read. `achievedAt` IS in the shape and the
  update allowlist (decision 5's undo argument); `updatedAt` is NOT in the shape at
  all. db.ts maps join rows ↔ arrays per the membership-semantics section.
- Goal date fields validate through `DateOnlySchema` at the agent boundary, and an
  inverted range (`targetOn < startsOn`) is refused (the programs
  `rejectInvertedRange` precedent) — every derived helper compares these LEXICALLY
  against `toDateStr` output, so a sloppy date doesn't error, it lands on the wrong
  side of every comparison forever.
- `DsulContextResponseSchema`: optional `goals[]`, schemaVersion 5 (Phase 4;
  extend the version-meaning comment chain).
- **No item-shape changes.** TASK_FIELDS/HABIT_FIELDS untouched; db.ts item
  allowlists untouched; the OpenClaw plugin parses today's payloads unchanged until
  Phase 4 (verified: the response schema is strip-mode, so a current build strips
  `goals[]`).

## Store plan

- New slice: `goals: Goal[]`, CRUD + `setGoalState` (stamps/clears `achievedAt` per
  decision 5), hydrated in `initializeStore`'s Promise.all. **~20 unit-test files
  hand-enumerate `lib/db` in vi.mock factories and import planner-store — update
  them FIRST** (the "six" in programs-routines.md is stale; a builder who fixes six
  and sees the suite still red will assume something else broke).
- **The history-baseline literal at planner-store.ts:3370 is untyped and must gain
  `goals` by hand** — `HistoryState` and `saveToHistory` force the other sites via
  types, but the module-load `prevStateJson = JSON.stringify({...})` literal does
  not; missed, undoing to session start reads every goal as deleted and
  `syncContainers` soft-deletes them all (the exact failure the file's own comment
  records shipping once for routines).
- `goalsAvailable` availability flag, item_types/collections precedent.
- Membership writes per the membership-semantics section. Role changes are an
  upsert on the PK — one write, no delete+insert window.
- `HistoryState` gains `goals`; `syncContainers` gains the goal callback pair (join
  reconciliation, NOT a column mapper).
- Create-with-membership: `Memberships` gains `goalIds?` (plain id array, role
  supplied alongside as a single `goalRole?` for the whole payload — the two
  designed flows are "add member from chip" and "inline-create milestone from the
  console"; mixed-role creation is not a flow). **Do NOT "generalize" `Memberships`
  into `{id, role}[]`** — the routine/program chips and `withMembership` (generic
  over single-`itemIds` containers) depend on the flat shape; goals get their own
  optimistic helper and a role-aware `persistNewItem` arm.
- **The item-update path consults a memoized item→goal-roles index** to fire the
  decision-3 demotion; the same index drives the row flag and the sweep exclusion.
  The sweep exclusion is safe ONLY because goals ride the same Promise.all/set() as
  items — recorded in use-overdue-sweep.ts alongside the existing routines note.
- Dangling-id rule extends verbatim: all three arrays may name trashed items;
  consumers filter against the live index; progress counts live milestones only.
- Derived helpers in pure **`lib/goals.ts`**: `goalProgress` (decision 6's rules),
  `nextMilestone` (earliest un-achieved by target date, undated after dated, then
  sort_order), `checkinStanding`, `timeElapsed`. Every surface asks this module.

## UI plan

- **Organize console — "Goals" section** in the CONTAINERS group: add `'goals'` to
  `ConsoleSection` + `CONSOLE_SECTIONS` (console-rail.tsx) and one SectionBody arm.
  Openers use the REAL API: `openDialog({ type: 'organize', section: 'goals' })`
  (the draft's `{type:'console', tab}` was fiction — that variant does not exist).
  List rows: CategoryIcon + name + quiet progress fraction + state pill (Achieved /
  Abandoned — active goals wear nothing); ended goals sink below active under a
  quiet divider. Empty state gets its one-sentence definition per the console's
  empty-state law; **no seeded example goal** — a goal is the most personal
  container in the app, and an example one would be noise a user has to delete
  (recorded as a decision, since the console's seeding law exists to prevent empty
  sections). Detail pane: name (`useNameDraft`), why, icon/color, starts/target
  date pickers, state control (+ wind-down per decision 5), progress bar (decision
  6's display rules), **Milestones** (ordered, by-id swap-reorder — the touch-sized
  24px controls from the scope-rail review, visible below `md`; add via the entity
  picker with its pool filter PARAMETERIZED — it currently hardcodes
  `isCollectible` — or inline-create a dated task pre-linked as milestone, **seeded
  with `timeBucket: 'anytime'`**: deriveDayItems drops bucketless tasks from every
  bucket, so without it the milestone is invisible on its own target day),
  **Members**, **Check-ins** (Phase 3). Delete → AlertDialog saying what actually
  happens: members and milestones are ordinary items and SURVIVE — only the goal
  and its links go to the trash.
- **`/goal/[id]` page**: the reading surface. Header (name, why, state, progress
  fraction + time-elapsed read, target countdown), milestone timeline (achieved ✓ /
  next highlighted / overdue quietly annotated / cancelled shown as dropped —
  never struck-through, never a warning color), member list grouped by type,
  check-in history. Console detail and page share section components. **Members
  suppressed by a paused routine/program are annotated** with the existing
  `suppressionLabel` line (quiet, guilt-free) — the goal surface is a brand-new
  reading surface for exactly the items the programs checklist warned about; a
  timeline naming "due Friday" for an item rendering on no Friday column is a
  silent lie. The annotation is read-only; goal surfaces stay activation-BLIND for
  writes (goals never suppress).
- **Item dialog/panel — "Goal" PropertyChip**, cloned from the Routine chip with
  ONE deliberate divergence, stated so the implementer doesn't copy the template's
  gate: **the chip renders at zero goals** (gated on `isCollectible` +
  `goalsAvailable` ONLY — the Routine chip's `routines.length > 0` gate is the
  programs no-entry-point failure, and on mobile, where there is no palette or
  omnibar, the chip's "Manage goals…" row is a load-bearing door). The popover's
  check-rows carry each goal's **next milestone + date** as a quiet second line —
  the one permitted ambient forward-pressure surface (a dated milestone is
  otherwise invisible between creation and its target day, and the first
  unprompted encounter would be the waiting tray after it is already missed).
  Ended-goal memberships render under a muted "Ended" divider (decision 5).
- **Role marking on rows:** a small flag glyph for milestone-role items, a small
  loop glyph for check-in-role items, both resolved against LIVE goals via the
  item→roles index. Desktop attribution via RailTooltip (hover); **on touch the
  glyph is inert and attribution lives in the edit sheet's Goal chip** — stated
  because RailTooltip never fires on touch and an unexplained glyph is the
  alternative. Not a rail column (the rail is budgeted).
- **The check-in bridge (review blocker):** the check-in's value — note, history,
  pull-back to the goal — must reach the surface where check-ins are actually
  completed, which is the grid row and the EOD review, NOT the goal page. So:
  completing a check-in-role item ANYWHERE fires a receipt toast — "Checked in on
  Learn Chinese · Add a note · View goal" — whose actions capture the note inline
  and deep-link `/goal/[id]`. Without this bridge, Phase 3 ships a recurring task
  with extra bookkeeping and its differentiating features reachable only by users
  who spontaneously visit the goal page first.
- **Undated milestones live in the braindump, deliberately.** They pass the
  braindump's membership predicate today and the alternative — excluding them —
  recreates "hidden entirely = data loss wearing a feature's clothes" (the Paused
  section's own lesson): an undated milestone of a rarely-opened goal would exist
  nowhere ambient. They wear the flag; the goal page is their primary home; if
  braindump squatting chafes, a quiet sub-grouping is the follow-up, not exclusion.
- **Omnibar: goals get a PARALLEL result channel, not a `groupResults` section.**
  `groupResults` is typed to `Item`s, keyed by item type, rendered with
  `data-item-type`/`doneStatus`/`openEditFor` — a goal is none of that, needs a
  navigate action, and the section key `'goal'` would collide with a user's custom
  item type literally named `goal`. A `goalResults` channel beside it, rendered as
  its own section with a navigate row, keeps both namespaces honest.
- **Vocabulary cleanup ships in Phase 1, unconditionally** (not the draft's hedge —
  which also mis-aimed at a "seed" that doesn't exist; nothing seeds item types):
  the Types section's create placeholder literally coaches "New type… (e.g. Goal)"
  (labels.tsx:273), and `goal` is the canonical custom-type example in the search
  grammar docs, palette entity copy, and Beacon's system prompt. Once the container
  ships, a user following the app's own example creates exactly the wrong thing.
  Change the placeholder (e.g. "New type… (e.g. Errand)") and sweep the
  user-facing example copy; for users who ALREADY have a custom type named `goal`,
  both keep working (disjoint namespaces) and Beacon's noun list already speaks
  hydrated labels — no migration, just stop coaching the collision.
- **Palette:** static `app.goals` (opens the console section); dynamic "Open goal:
  X" per goal (customTypeCommands pattern). `goal:<name>` search grammar stays
  deferred.
- **On mobile** (one paragraph, per the house rule that every surface decision
  needs a touch path): the console's Goals section renders in the existing vaul
  bottom sheet (fit is pre-existing console behavior; milestone reorder uses the
  visible 24px arrow controls); role glyphs are inert, attribution via the edit
  sheet's Goal chip; `/goal/[id]` is reachable from the console row's open-as-page
  affordance (the `/item/[id]` ⤢ precedent) since mobile has no palette or omnibar;
  the completion receipt toast is the check-in bridge there too.
- **Copy rules:** article + name ("your Learn Chinese goal"). "Milestone" and
  "Check-in" are membership words, never type names.
- **The console detail wears the item edit pane's look (2026-09-25, Kirby).** A
  whisper ("Goal" + colour square) with "Open as page" and a ⋯ menu that holds
  Delete (no filled red zone); an icon + serif title; one chip row — status
  (Active / Achieved / Set aside), the Started → Target range as ONE chip fenced
  start ≤ target, colour; the why as borderless serif notes; then one
  `OrganizerSection` per role ("Milestones · 1 of 3", "Check-ins · 1",
  "Supporting work · 2") with a "Link existing" pill by the heading and an
  "Add …" row at the foot. Empty sections are heading + add row only. The
  wind-down sits in the item pane's paused-note strip, above the chips. The
  console's "+ New" asks for the why and the window too, in the one `addGoal`.
  **A milestone row can be ticked** — the one exception to "member rows are
  addresses, not editors" (organize-console.md): reaching a checkpoint is the
  gesture a goal exists to record, so the row's checkbox calls the item's own
  `toggleTaskStatus`. A reached milestone is checked and muted, never struck
  through. Every other member row still only links out.

## Beacon + agent (Phase 4)

- Beacon context gains a `### Goals` section — guarded on **active goals with
  rendered content**, double-guarded like `### Paused` (the draft's "when goals
  exist" would print a header over nothing for a user whose only goals are
  achieved). Per goal: name, why, progress fraction, next milestone + date, days to
  target, check-in standing. **Suppression-aware:** `nextMilestone` and the
  check-in line SKIP items currently suppressed by a paused routine/program, or
  annotate the cause — otherwise `### Goals` recommends the exact item `### Paused`
  forbids three sections earlier, two contradictory instructions in one prompt.
  The **focused-item section names goal membership**: a per-item thread on "HSK 3
  exam" must know it is the next milestone of Learn Chinese — that is the single
  most relevant fact about it, and the addition is additive (base no-focus output
  stays byte-identical; the pinned tests pass no goals).
- `/api/agent/context` serves `goals[]` at schemaVersion 5; omitted, never `[]`,
  when the table is unreachable (decision 7).
- Agent writes: `POST/PATCH/DELETE /api/agent/goals`, membership with roles.
  Refusals, each because the silent alternative is worse than a 400:
  - **`paused`/`pausedUntil` are carried on the goal schemas solely to be
    REFUSED**, with a message naming `state` and pointing shelving at programs —
    the exact `rejectProgramPauseVerb` pattern, because `paused: true` works on
    items and routines and a goal is precisely what an agent will try to "shelve";
    Zod's silent strip would 200-and-do-nothing, the bug class the programs review
    escalated.
  - Role writes validate through the registry predicates (recurring item as
    milestone → 400 naming the rule); cross-array overlap → 400 (membership
    semantics rule 2); `achieved_at` derived server-side, empty-patch on same-state
    writes, cleared by `state:'active'` (decision 5); dates through
    `DateOnlySchema` + inverted-range refusal; ownership pre-checks per
    `verifyContainerOwnership` (service role bypasses RLS); per-role
    `withTrashedMembersKept`.
  - Rename the `lib/agent-api.ts` `ContainerKind` type before extending
    `CONTAINER_API` (it shadows the registry union with a different meaning).
- OpenClaw plugin: goals in context + a `kind: 'goal'` arm on the collections
  tools; ships on the next deliberate republish (0.2.0 already sits unpublished —
  do not force a release).

## Phasing (app must work at every step)

- [x] **Phase 0 — foundations** (built 2026-08-20). Migration 036 (both CHECKs in
  guarded DO blocks); `GoalSchema`/`GoalRoleSchema`/`GoalStateSchema` + `GOAL_FIELDS`
  + committed dist rebuilt (achievedAt in, updatedAt out); db.ts goal CRUD with
  `goalMemberRows` + `reconcileGoalMembers` (one union reconcile, cross-array
  refusal, homogeneous sort_order, deterministic fetch order for all three arrays);
  container-registry `aspire` role + `goal` kind + `ASPIRE_KINDS`, with the
  discovery note corrected in the header; registry `milestoneEligible` +
  `isMilestoneEligible`/`isCheckinEligible`; tests/unit/goals.test.ts (11) and the
  three-role partition rewrite in container-registry.test.ts. All 22 db-mock
  factories carry `fetchGoals` so Phase 1's `initializeStore` wiring does not break
  the suite at module-mock resolution. Zero UI; app behavior unchanged.
  **Gates:** 1332 unit tests green (77 files), lint 0 errors, `pnpm build` clean,
  types dist matches src, tsc error count unchanged from baseline — 23 both sides,
  distributed identically file-by-file. (Two files this commit edits carry
  pre-existing errors, `pause.test.ts` and `sweep-receipt.test.ts`; the claim is
  that nothing was introduced, not that the touched files were clean.)
  **Renumbered to 036 and APPLIED 2026-08-22.** The ledger was read live before
  applying: tip still 035, four versions ahead of `origin/main`'s directory, so
  036 was still the first free version. See the migration-number note above.
  Deploy order is safe either way: no existing table gains a column, so every
  pre-existing write path is byte-identical against a pre-036 database.

  Applied out-of-band through the Supabase MCP (no `supabase` CLI and no
  `.env.local` in that environment), so version `036`/`goals` was written to
  `supabase_migrations.schema_migrations` in the same session, as this file's
  header instructs. Verified after the fact rather than assumed, because every
  structural piece in this file is in a guarded DO block and a skipped guard is
  silent by construction: `pg_constraint` shows both composite FKs
  (`(goal_id,user_id)→goals`, `(item_id,user_id)→items`, both CASCADE), the
  `goal_items` PK, and both CHECKs (`goals_state_check`, `goal_items_role_check`)
  present with the intended definitions; both tables have `relrowsecurity` true
  and their policy; `goals_user_idx` and `goal_items_user_item_idx` exist; and
  `goals_updated_at` is the ONLY non-internal trigger across the two tables —
  `goal_items` correctly has none, which is the invariant that would otherwise
  make every role change throw at runtime.

  **The cron re-list was correct, and that was worth checking.** 032–035 landed
  out-of-band while this branch was in flight, so the live `purge-deleted-items`
  body was read back one more time immediately before applying. Those four
  versions added two SEPARATE jobs (`dsul-reminders`, `dsul-eod-notify`) and
  never touched the purge job, so the eight DELETEs this file re-lists still
  matched the live body exactly. Post-apply the job is jobid 7, active, `0 0 * * *`,
  with nine DELETEs — the eight plus goals — and the `item_events` 180-day line
  still present.

  **The constraints were then exercised, not just read.** `pg_constraint` proves a
  constraint EXISTS; it does not prove the live table behaves. Since the review's
  sharpest Phase-4 finding was that the unit fake's fake-DB hid four real
  violations, the schema was probed with actual writes inside a DO block that
  ends in `raise exception`, so the whole probe rolls back (verified after: both
  tables back to 0 rows). Results, all against the live tables:
  default role `member`; junk `role` rejected 23514; junk `state` rejected 23514;
  a duplicate `(goal_id,item_id)` rejected 23505; a membership row whose `user_id`
  does not match the goal's rejected 23503 — the cross-tenant forgery the composite
  FKs exist to make unrepresentable; `state='achieved'` accepted; a **role UPDATE
  succeeding**, which is the positive control for `goal_items` having no
  `updated_at` trigger (with one, every role change throws at runtime); and 0
  orphaned join rows after deleting the goal, so the nightly purge cannot strand
  membership.

  `notify pgrst, 'reload schema'` was sent after the DDL. Supabase's own event
  trigger normally reloads PostgREST on DDL, but a stale cache here fails in the
  worst available way: `fetchGoals` treats PGRST205 as "table missing" and latches
  `goalsAvailable = false`, which disables the entire feature silently rather than
  erroring. The reload could not be confirmed over HTTP from the build environment
  (see the gates note below), so first load in a real browser is what proves it.

  **The cron body was wrong, and silently.** 036's purge rewrite was authored
  against 024's job — seven DELETEs — but 030 had since added
  `item_events … 180 days` to the same job, and `cron.schedule` replaces a job
  whole. Applying the original would have retired the activity-feed purge with
  no error anywhere, which is precisely the failure 030's own header warns any
  later migration about. The body now matches the LIVE job (read back from
  `cron.job`) plus the goals line. Nothing in 036 adds a column to `items`, so
  031's `rebuild_items_windowed()` is not needed.
  **Carried into Phase 1, deliberately:**
  - the untyped history-baseline literal at planner-store.ts:3370 must gain
    `goals` in the SAME commit as the store slice — it cannot be fixed earlier
    (the field does not exist yet) and missed later, undo to session start
    soft-deletes every goal;
  - **`goalsAvailable`** — the store flag the whole feature gates on, analogue of
    `collectionsAvailable`. `fetchGoals` already returns null on a missing table,
    which is the contract it is built from, but the flag itself is a planner-store
    field and lands with the slice;
  - `listDeleted`'s goal arm, whose bin snapshot must carry `{itemId, role,
    sortOrder}` and not bare ids — it ships with the console's Trash section.
- [x] **Phase 1 — goals end-to-end, console section** (built 2026-08-20, `89120ec`
  + `5a150e8`). `lib/goals.ts` (progress with the cancelled/zero/all-done-early
  rules, nextMilestone, checkinStanding, timeElapsed, goalRolesByItem,
  milestoneItemIds, resolveGoalStateWrite, roleStillValid); store slice with CRUD,
  `setGoalState`, `goalsAvailable`, goals in HistoryState/syncContainers/
  applyHistoryState, and the history-baseline literal now a TYPED `historySlice()`
  helper; the demotion mechanism in `updateItemAction`; milestone exclusions on
  `moveTasksToDate` and `unscheduleTasks`; create-with-membership (`goalIds` +
  `goalRole`); console Goals section with the wind-down notice; role-aware trash
  arm end-to-end; the Goal chip; the member picker's pool parameterised by role;
  the vocabulary cleanup. 1362 unit tests green, lint 0 errors, build clean, dist
  matches src, tsc at baseline 23.

  **Found by its own test, and it was new:** `unscheduleTasks` filtered its DB
  writes by the milestone exclusion but re-derived its optimistic `set()` from
  the caller's raw id set — so a milestone would have cleared in the store,
  written nothing, and silently come back on reload. The two lists had been
  interchangeable until this commit made them different. `moveTasksToDate` was
  already safe (it keys its set() off the same `targets`).

  **The typed history slice paid for itself immediately:** annotating the
  literal turned up three more snapshot sites the compiler could now check, one
  of which (`applyHistoryState`'s hand-repeated structural copy of HistoryState)
  was a second place to forget a slice. It is now `HistoryState` itself.

  **Deferred out of Phase 1, deliberately:** the celebrate receipt and the role
  glyphs on rows ship with Phase 2's goal surface — both want `/goal/[id]` to
  exist to point at. The `member-list` picker gained an `eligible` prop rather
  than a role-aware rewrite, since milestone/check-in pickers differ only in
  which items they admit.

  **Deferred, and NOT originally recorded — the review caught the omissions:**
  - **The agent PATCH path has no demotion.** Decision 3 requires it "from the
    store's item-update path AND from the agent item PATCH handler"; only the
    store half shipped, so an OpenClaw write can make a milestone recurring
    server-side today with nothing taking the role back. It lands with Phase 4's
    agent surface, where the rest of the goal write-path validation lives.
  - **Inline-create-a-milestone from the goal.** `Memberships.goalRole` was
    built in 1a for exactly this and has no producer, so the only way to make a
    milestone is to pick an item that already exists. It is the shortest path to
    the plan's headline journey and belongs with Phase 2's surface (it also
    needs the `timeBucket: 'anytime'` seed the UI plan records).
  - **The wind-down is a NOTICE, not the step decision 5 describes.** It names
    the recurring members an ended goal leaves running; it does not offer the
    keep / delete / move-to-a-program affordances. The naming is the load-bearing
    half (nothing else in the app will ever mention the goal again), so the
    affordances follow with Phase 2.
  - **`checkinStanding` has no consumer yet** — it is Phase 3/4's, and its
    timezone handling (it round-trips a constructed Date through `toDateStr`,
    and does not consult `isSkippedOnDate`) should be settled before Beacon
    reads it server-side.
- [x] **Phase 2 — the goal surface** (built 2026-08-21). `components/planner/
  goal-sections.tsx` carries what more than one surface renders — the fraction's
  wording, the progress track with its separate elapsed hairline, the milestone
  timeline, member groups, and the rule that every rendered member says whether
  it will actually appear on a day (`suppressionReason` at today, per the goal
  surfaces' dateless contract). `/goal/[id]` follows `/item/[id]` exactly:
  client route, deep-linkable so Beacon can answer with a URL, editing left in
  the console. The console's local progress copy was deleted in favour of the
  shared one, and its detail gained an "Open as page" link — which on mobile is
  the only route to the page, since there is no palette or omnibar there.

  Role glyphs land INLINE with the title, not as a rail column: the rail's five
  columns each reserve width on every row of both types, so a sixth would cost
  20px on every row in the app to say something true of a handful. Muted ink,
  never honey — being a milestone is an identity, not a warning, and this is the
  row of a checkpoint that may well be late. On touch the tooltip never fires,
  so the glyphs are ones a reader can place unaided (a flag, a loop) with full
  attribution one tap away in the edit sheet's Goal chip.

  `app.goals` + one navigation command per ACTIVE goal (ended ones would push
  the running one down a list that exists to be fast). The omnibar gets the
  PARALLEL channel the review demanded rather than a `groupResults` section —
  a goal is not an Item, needs a navigate action, and the key `goal` would
  collide with a custom item type of that name.

  The celebrate offer is a toast, never a dialog: `activeDialog` is a single
  slot, so a dialog fired from a completion inside the EOD review would
  destructively replace the review. It fires only from the user-facing
  completion verb — never from `applyHistoryState` (which writes through
  `dbUpdateItem`) or the agent routes (which never touch the store) — so a redo
  cannot re-fire it and a background write cannot fire it at a screen nobody is
  looking at. Its copy respects a distant target: "All 3 milestones so far" is
  the honest reading of a three-year goal with two near-term checkpoints.

  **One Phase-1 deferral closed here:** inline milestone creation, which gives
  `Memberships.goalRole` its first producer — undated AND unbucketed, so it
  lands in the braindump where the plan says undated milestones live. (The
  first version bucketed it on backwards reasoning; see the review below.)

  **Still deferred, each with a home now** — the Phase-2 ledger originally said
  "Phases 3/4" for two of these without either bullet carrying them, which is
  how a commitment loses its owner:
  - **Wind-down affordances** (decision 5's keep / delete / move-to-a-program
    controls on an ended goal) → **Phase 3**, alongside the check-in UI, since
    the members it acts on are mostly recurring ones.
  - **The agent-PATCH demotion** (decision 3's second enforcement point) →
    **Phase 4**, with the rest of the agent write-path validation.

  **Gates:** 1375 unit tests green (78 files), lint 0 errors, `pnpm build`
  clean, tsc at baseline 23. The `/goal/[id]` route builds and is listed.

  **Phase 2 implementation review (2026-08-21).** Three lenses (the new
  surfaces; the integration points; store + scope). **Two blockers, both mine,
  both about a surface that looked right and did nothing.**

  *The inline-created milestone was visible on no planner surface at all* — and
  the bucket I called load-bearing is what put it there. `deriveDayItems` tests
  `startDate` BEFORE it looks at a bucket, so the bucket bought nothing on a day
  column; the braindump excludes on `isScheduled || timeBucket`, and `addTask`
  derives `isScheduled` from the bucket — so bucketing removed it from the one
  list undated work lives in and added it to none. The commit message, the
  ledger entry and the new test all asserted the inverse. Dropping the bucket
  fixes it, and the timeline's rows are now links, because before this the goal
  offered no route at all to giving a checkpoint the date it needs.

  *The goal page's Organize button was inert* (2 lenses). `OrganizeConsole` is
  mounted once, in AppShell, which this route deliberately does not render — so
  the click set a field nothing here reads. Worse than a no-op: ui-store is a
  module singleton, so the armed dialog survived and the breadcrumb home then
  sprang the console open unasked. Arm-then-push, exactly as the settings page
  does — a precedent that was already in the repo with a comment explaining it.

  **The should-fixes worth recording.** `checkinStanding` — whose first consumer
  this phase created — was wrong by a whole occurrence, not a day: it built a
  Date in the RUNTIME's zone and read it back in the user's, so for a user more
  than 12h east the page reported next week for a check-in due now; and it
  ignored `isSkippedOnDate`, so it said "Due today" for an occurrence struck off
  the grid an hour earlier. Both were flagged in Phase 1 as "settle before
  Beacon reads it"; they acquired a UI consumer first. The role glyph sat inside
  a `line-clamp`ed (`overflow: hidden`) paragraph, so it vanished on exactly the
  narrow week rows where scanning matters, and under that paragraph's `title`
  attribute it fired a native tooltip on top of the Radix one — it is a sibling
  now, with an sr-only name. Every goal matched TWICE in the omnibar (the
  parallel channel and the per-goal command, same destination, no dedupe —
  three lines from where the file already solves this for `create.task`), and
  all three routes to the page did a full document reload, tearing down the
  store, in a codebase where every other internal navigation is `router.push`.
  Decision 5's word DATED was not implemented, which mattered precisely because
  this phase's inline creation makes undated milestones — two jotted ideas would
  have silenced the offer permanently. And the toast's action trusted an
  eight-second-old snapshot, so ⌘Z-then-click could achieve a goal with an open
  checkpoint.

  Smaller, all fixed: the elapsed hairline was clipped away at exactly 100%;
  the timeline rendered membership order under a heading claiming date order,
  and ranked `overdue` above `next` so a slipped goal highlighted no row at all;
  `milestoneState` re-derived `isAchieved` in the one module whose header
  promises nobody does; `Repeat` meant two things one commit apart; the
  countdown said "1 days"; the goal channel ran in `/`, `+` and `?` modes;
  `searchGoals` matched `why` text the row never shows; ended goals could crowd
  the live one out of the omnibar's four-row cap; and the per-row index
  contradicted its own docblock at a measured 34ms for a two-year account (now
  memoized on the goals array identity).

  **Refuted and not to be re-raised:** hook order across all five new
  components; dangling ids in the timeline (store `items` is already
  `deleted_at`-filtered, so `itemsById` IS the live index); the not-found gate;
  `GoalSummary`'s UTC day math; `goal-${id}` colliding with the item rows'
  value namespace; `cachedGoals` needing a day key like programs (goal liveness
  is `state` alone); RailTooltip inside a `<p>` being invalid DOM; and the
  `goals` palette alias colliding with anything.
- [x] **Phase 3 — check-ins, and the wind-down** (built 2026-08-21).

  **The bridge is the phase.** A check-in is completed where every recurring
  item is completed — a row on the grid, a line in the EOD review — and NOT on
  the goal page, so the note, the history and the trip back to the goal come to
  the completion rather than waiting at a surface the user has no reason to
  visit. `offerCheckinNote` fires from the two SINGLE-item completion verbs —
  the recurring branch of `toggleTaskStatus` and `toggleHabitStatus` — which
  between them cover the grid row, the day schedule, project blocks, the EOD
  review, the morning tray and the palette (a habit can serve as a check-in;
  `isCheckinEligible` asks only that the item recurs). It does NOT fire from
  `setItemsCompleted`, the multi-select bulk verb, which skips
  `celebrateCompletion` too — the house posture for a verb acting on twenty
  items at once, and a limit worth stating rather than the "every completion
  surface" this bullet first claimed. The toast carries both halves the plan
  pins: "Add a note", and "View goal" — the trip back is the part a completion
  cannot otherwise offer, and it was briefly dropped.

  **The note is written against the OCCURRENCE date, not the moment of typing.**
  `recordCheckin` puts `dateStr` in the payload; `created_at` is when the note
  was typed, and the two part company the moment someone completes Sunday's
  check-in on Wednesday. Keyed on `created_at` a note would file itself into the
  wrong week, silently and forever. Rides `item_events` with `action:
  'checkin'` — additive, because 023 made that column open text for exactly this.

  **A note whose occurrence is later un-completed is annotated, never deleted.**
  Undoing a completion says "that did not happen today"; it does not say "I
  never wrote this". `CheckinHistory` marks those "· since un-marked" and keeps
  them, and `checkin` events also read in the item's own ActivitySection — an
  item whose notes live exclusively on another surface is an item whose own page
  lies about its history.

  **Check-in creation seeds weekly-on-Sunday** (Kirby's answer to open question
  7), and it is a DEFAULT, not a policy: the cadence lives on the item and its
  own repeat control edits it afterwards. Sunday because a weekly review wants
  the seam between weeks — a weekday would put it inside the week it reviews.
  Bucketed, unlike a milestone and for the exact reason a milestone is not:
  a recurring item lands on a column with no `startDate` at all, so the bucket
  is what decides WHERE in that column, and without one deriveDayItems drops it.

  **The wind-down affordances land here**, carried from Phase 1 via Phase 2. An
  ended goal's notice now lists each still-recurring member with a link to the
  item and a Delete, and performs NEITHER on the goal's behalf — Delete is the
  ordinary store action and the link goes to the item surface, where the Program
  chip is how you park something without losing its history. The confirm says
  so. A goal that quietly deleted a year of habits because you marked it
  achieved would be the single worst thing this feature could do.

  **`tests/e2e/goals.spec.ts` — six cases, and it is UNRUN.** There is no
  `.env.test` in this environment and migration 036 is not applied, so it cannot
  execute here; every prior phase's review recorded that running an e2e is what
  finds its defects, and that step has not happened. What IS verified: `tsc`
  and eslint clean, every one of its fifteen `getByTestId` selectors audited
  against the source, and the helpers/`specScope` conventions matched. Treat it
  as unproven until it runs. It carries its own `goal` prefix (the
  two-files-sharing-a-DELETE lesson) and globalSetup's litter sweep now covers
  `goals`. The cases were chosen for the boundary the unit suite cannot see, and
  two of them exist because a shipped blocker lived exactly there: the goal
  page's Organize button responding at all, and an inline milestone being
  findable in the braindump.

  **Gates:** 1381 unit tests green (78 files), lint 0 errors, `pnpm build`
  clean, tsc at baseline 23.

  **Phase 3 implementation review (2026-08-21).** Three lenses (check-in
  mechanics; the unrun e2e spec, read statically; scope + wind-down + fidelity).
  **Three blockers — one in the feature, two in the spec.**

  *The seeded check-in rendered on no planner surface* — Phase 2's milestone bug
  with the sign flipped, and found independently by two lenses. It shipped
  bucketed-but-undated on the premise that "a recurring item lands on a column
  with no startDate at all". That is true of HABITS. A recurring TASK is gated by
  its anchor: `deriveDayItems` returns false on `!task.startDate` BEFORE it
  reaches `shouldShowOnDate`, and the bucket simultaneously excluded it from the
  braindump — the one combination the item dialog itself cannot produce. Twelve
  lines above it, `createMilestone`'s docblock states the rule correctly and
  records having already paid for this exact mistake. Now anchored at today.

  *The e2e spec would have failed on its first run for reasons unrelated to the
  feature*, which is the whole argument for reading it against the house's
  earned lessons rather than shipping it unread. `fetchTestGoal` had no
  `deleted_at` filter, so the delete case polled a soft-deleted row that is
  still there — it could never observe a delete. And `closeConsole` pressed
  Escape once against `role=dialog`, where three existing specs press up to four
  times against the OVERLAY and pre-check the alert overlay first: the omnibar's
  Escape handler stops propagation, so the first press can be spent on the
  palette, and a confirm still animating holds the layer. programs.spec's
  docblock says that one cost an hour of a real run.

  **Assertions that passed for the wrong reason, also caught by reading.** The
  achievement case matched `getByText(/milestone/i)` — satisfied by the row's own
  `sr-only` "Milestone of …" label, which Tailwind keeps as a 1×1 visible box —
  so it was green whether or not the offer ever appeared; and its "still active"
  poll read the value the insert had just written. The delete case never
  reloaded, so it proved only that `removeGoal` does not touch `items[]` in
  memory, while the failure it exists to catch lives entirely in the database.
  Both fixed, plus the bridge case the plan's own gates name by name, which the
  spec did not have.

  **Feature should-fixes:** a note was filed under whichever goal sorted first,
  so a check-in shared by two goals left the second's history permanently empty
  — it now records for every active goal the item serves, re-read at click time.
  `fetchCheckins` read through `goal.checkinIds`, which handed back
  `item_events`' founding property: the join row cascades on the item's purge,
  the id leaves the array, and the notes become unqueryable — exactly the path
  the wind-down's own Delete puts a user on. It queries `payload->>goalId` now,
  which also fixes a 50-row cap applied before the goal filter. The toast had
  lost the "View goal" half the plan pins by name. `CheckinHistory` painted the
  previous goal's private notes under the next goal's heading while its fetch
  was in flight. And decision 5's third affordance — park it in a program rather
  than end it — was prose reachable only by opening a dialog whose button says
  Delete; it is a labelled control now.

  **Recorded rather than fixed:** `window.prompt` is the only native dialog in
  the app. `ui-store` does carry a second modal slot (`confirmRequest`), so a
  modal raised while EOD is open is a solved problem here — but that slot
  confirms, it does not capture text, and building the surface that does is the
  guided check-in flow, already a recorded deferral. Consequence to know: a
  browser that has suppressed dialogs returns null and the note is silently not
  saved.


- [x] **Phase 4 — external/AI** (built 2026-08-21). Beacon's `### Goals` section
  (active-only, double-guarded, suppression-aware `next`) + the `- Serves:` line in
  the focused-item block, with the byte-pinned no-focus output unchanged; `goals[]`
  on `/api/agent/context` at **schemaVersion 5**, spread-or-omit so an unreachable
  table sends nothing rather than `[]`; `GoalCreateSchema`/`GoalUpdateSchema` with
  the three refusals (`paused`/`pausedUntil` → pointer at `state` and at programs,
  caller-chosen `achievedAt`, inverted window) plus the cross-array role overlap
  rejection; `POST/PATCH/DELETE /api/agent/goals` with ownership pre-checks,
  registry-predicate role validation, per-role `withTrashedMembersKept`, and
  server-derived `achievedAt`; **decision 3's second enforcement point** — the
  agent item PATCH now demotes a role its own `repeatFrequency` edit invalidated,
  gated on `'repeatFrequency' in fields` exactly as the store's `updateItemAction`
  is, reported as `{ success: true, demoted: [...] }` and never able to fail the
  caller's edit; `lib/agent-api.ts`'s `ContainerKind` renamed to
  `GatedContainerKind` (the plan's own pre-build finding — goals do NOT get a row
  in `CONTAINER_API`, they have three role arrays and no pause verb); plugin arm —
  `goals` on the cache, a `## Goals` context section that lists facts and derives
  no fraction, and a `kind: 'goal'` arm on all three collection tools with the
  per-kind key allowlist replacing the routine-only delete list.
  **Gates:** 1434 unit tests green (80 files), lint 0 errors, `pnpm build` clean,
  types dist matches src, tsc error count unchanged from baseline (23 both sides).
  New: `agent-goal-write.test.ts` (21 — the schema refusals and the two pure
  resolvers) and `agent-goal-routes.test.ts` (23 — the handlers against a
  filter-aware in-memory Postgres stand-in), plus `goals[]` additivity cases in
  `agent-schemas.test.ts` and a goals block in `plugin-context.test.ts`.
  **The plan's live-server gate is NOT met and is still owed** — this container
  has no Supabase credentials, so no goal route has ever spoken to a database.
  The route tests are the substitute, and they are honest about being one: a fake
  cannot catch a PostgREST behaviour nobody modelled. The first live call should
  be a create-with-membership, since that is the path where a wrong column name
  would be silent.
  **Phase 4's review** (five lenses: refusals, handlers-vs-db, the demotion,
  the two prompts, the tests).

  **Two live bugs, each reproduced before it was fixed.** Moving a TRASHED item
  between roles was an unavoidable 500: the arrays are replaced independently
  but write ONE join table, so `{milestoneIds: [], memberIds: [X]}` had the
  milestone pass put the trashed X back and `goalMemberRows` then refused the
  body for naming X twice. The request is legal by every stated contract — the
  context publishes the id, the overlap refine passes, validation counts trashed
  items as existing — and the caller had no way to succeed short of the 30-day
  purge. The keeping is cross-array aware now. And the demotion left a stale
  `sort_order`, which `goalMemberRows`' own docblock forbids by name ("a demoted
  milestone that kept its old sort_order would perturb the order its new array
  comes back in"): three lenses found it independently.

  **The refusal set had a fourth hole, found by two lenses.** `itemIds` is the
  membership key on both other containers, goals are the only container that
  renamed it, and membership is the commonest goal write — so a model asked to
  add work to a goal reaches for it, Zod strips it, `updateGoal` finds an empty
  patch and issues no statement, and the caller is told 200. Exactly the
  bug class the plan carries `paused` to prevent. `itemIds`, `routineIds` and
  `endsOn` are now refused with a pointer at the right key. The plugin's
  `itemIds` was the one parameter with no kind qualifier, and its allowlist
  dropped stray keys silently; it refuses them instead.

  **Decision 3's predicate was weaker than the grant predicate.** Making a
  milestone a SUBTASK strands it just as thoroughly as making it recurring — it
  leaves the tasks projection, so it drops off the grid and out of
  `selectOverdue` (decision 2's past-due promise quietly stops holding) while
  `goalProgress` goes on counting it. `roleStillValid` asks the grant predicates
  now, and the agent gate widened to `parentItemId`.

  **The prompts.** Beacon dropped the next-milestone line when the candidate was
  suppressed instead of ADVANCING to the next visible one, leaving a goal with a
  milestone count and no milestone; the heading is `### Long-term goals` because
  a user may define a custom item type whose plural is "Goals" and the registry
  renders one section per type. The plugin marked every completed and cancelled
  milestone "overdue" — a mature goal that is going well rendered as a wall of
  late work — and listed suppressed items with no annotation, directly under a
  "Set aside … do not suggest these" block. Both fixed; `nextMilestoneVisible`
  is the shared derivation.

  **The test fake was the sharpest finding.** It was a JavaScript object store
  with filter syntax: no projection, no column check, no NOT NULL, no unique
  key, and `.order()` a no-op — so a wrong `onConflict` (42P10 on every
  membership write), a `startsOn`/`starts_on` typo, a dropped `user_id`, and the
  reconcile's historical read-a-column-it-never-selected bug were all green.
  Worse, it was measurably weaker than the fake two files away in
  `goals.test.ts`, whose docblock names that last bug as the reason it projects.
  Rebuilt with declared per-table schemas and real ordering; all four mutations
  now fail. Also added: a second goal in every PATCH fixture (cross-goal
  scoping was structurally unreachable with one), real uuids for goal ids, a
  query log so "does not scan" asserts the scan rather than the outcome, a
  round-trip through `fetchGoals` (every other assertion read `db.goal_items`
  directly, which is how the stale ordinal hid), and the subtask and
  duplicate-id paths.

  **And a false claim I wrote.** `agent-goal-write.test.ts`'s header said the
  handler "is exercised live against a running server, per the plan's Phase 4
  gate" — copied from `agent-pause-write.test.ts` and never updated. It flatly
  contradicted the routes file and this ledger. Corrected. `ai-context-goals.test.ts`
  (10) closes the gate this section named and Phase 4 missed: the byte-pinned
  context tests verified the goals section only by never reaching it.
  Two dropped `error` destructures (`verifyContainerOwnership`, `goalStatePatch`)
  turned a missing table into a silent 404; they throw now.

  **Recorded rather than fixed.** The store's demotion scans live goals only,
  so trashing a goal, making its milestone recurring, and restoring inside 30
  days brings back a recurring milestone that can never be achieved — the agent
  path is a superset and handles it; the fix belongs at goal RESTORE and is
  Phase-1 surface. An agent demotion is invisible to an open tab, and the next
  UI membership write (which sends all three arrays from memory) reverts it —
  general agent-vs-open-tab staleness, not specific to roles. The store fires
  its demotion write BEFORE the item write, so a failed item write strands the
  role. Nothing re-runs a swallowed demotion. `createGoal`'s compensating delete
  ignores its own error. There is no agent restore verb for a soft-deleted goal.
  A subtask can still hold plain membership: dropping it would be a REMOVAL, not
  a demotion, and removing membership the user did not ask to remove is a bigger
  promise than this rule makes. **And the published `@dsul/types` may be
  far behind `src` — the plugin's `workspace:*` resolves to whatever was last
  released, so the plugin-smoke gate ("context parses with the OLD published
  schema") is still unmet and needs the actual tarball, not a simulated omit.**
- Each phase gets the house adversarial review before its commit lands.

## Behavioral invariants to preserve (regression traps)

- **Goals never suppress.** No goal state or membership ever feeds
  `inactiveItemIdsOn` / `isOpenLoopSuppressedOn`. If "shelve goal hides work" ever
  ships, it goes through lib/active.ts as a first-class path.
- **No goal operation writes member item fields** — except the decision-3 role
  DEMOTION, which writes only the join row (never the item), and the wind-down
  step's per-item actions, which are the USER's writes through normal actions.
- **Milestones are one-shot; check-ins are recurring** — at grant time via the
  registry predicates, and across later item edits via the demotion mechanism
  (never by blocking the item edit).
- **The sweep and bulk date verbs never touch a milestone's startDate**; single
  deliberate date edits always may, with a receipt. The sweep exclusion depends on
  goals hydrating in initializeStore's Promise.all — moving that fetch silently
  unprotects every milestone.
- **Progress is derived and live-filtered** — never stored, never counts trashed or
  cancelled milestones, never reads `completedDates` for one-shot status (and never
  scalar status for anything recurring).
- tasks[]/habits[]/items[] element shapes unchanged; goal membership travels only
  in `goals[]`; `goals[]` omitted (not `[]`) when unreachable; schemaVersion bumps
  additive-optional.
- `goal_items` has no updated_at column and must never get the house trigger.
- Membership writes are ONE union reconcile per goal; cross-array overlap is
  rejected, never resolved; trash-keeping and the bin arm are role-aware.
- `achievedAt` restamps never (same-state writes are empty patches); undo of
  achieve round-trips state AND stamp.
- Frozen e2e text contracts survive all new UI; role glyphs add no rail column.
- Dist-matches-src CI gate: every types change rebuilds the committed dist in the
  same commit.

## Verification gates

Unit: NEW tests/unit/goals.test.ts (table-driven: progress rules incl. cancelled/
zero/all-done-early; nextMilestone ordering; demotion on recurrence flip both
directions; union reconcile incl. demotion-no-delete-window and overlap rejection;
per-role trash keep); container-registry.test.ts three-role partition; the ~20
repaired vi.mock files stay green; db-allowlists auto-covers GoalSchema;
ai-context.test.ts extended with a goals fixture (re-read deliberately if pinned
output changes). E2E: goals.spec (create goal → inline-create dated milestone →
complete it on the grid → progress updates → celebrate receipt → achieve →
wind-down; TEST_TITLE_PREFIX fixtures, its OWN cleanup prefix — the
two-files-sharing-a-DELETE lesson), check-in bridge case in Phase 3. Phase 4: live
calls against a running server (the programs 39-call standard) + plugin-context
tests in THIS repo (CI does not gate the plugin — the ten-tests precedent). Plugin
smoke: context parses with the OLD published schema while goals[] is present.
CLAUDE.md's Plans paragraph names this plan alongside unified-items.md
(done 2026-08-21 — four phases have shipped, so a reader landing in
lib/goals.ts or the store's goal slice needs the pointer).

**State of the gates as of Phase 3:** tests/unit/goals.test.ts (31) and
goals-store.test.ts (28) cover the predicates, the membership write semantics,
progress, check-in standing, the demotion rule, the bulk-verb exclusions and
the bridge's goal selection. tests/e2e/goals.spec.ts exists with seven cases
INCLUDING the check-in bridge case named above — and has **never been
executed**. Its first real run is still owed, and three of its defects were found
by static review rather than by running it (a soft-delete poll that could never
observe a delete, a one-press Escape where the house helpers press four, and an
achievement assertion satisfied by an sr-only label). Treat the remainder as
unproven.

**Updated 2026-08-22, after the first four real runs.** Migration 036 is applied
and verified (see Phase 0), and **goals.spec.ts has now executed** — not from
this build environment, which still cannot reach the database, but in CI, whose
`e2e-tests` job holds the five secrets as job-level env. Opening the PR was
what ran it: that job is gated `if: pull_request || workflow_dispatch`, so a
direct push to main would have skipped the gate entirely.

**Result: six of the seven cases pass. One does not.**

Two defects were found by running it, both in the TEST rather than the app, and
both of the kind static review cannot see:

- `an ended goal names the work it leaves running` waited for
  `goal-checkin-member-row`. member-list renders each row as
  `${testPrefix}-member`, so the id is `goal-checkin-member`; the `-row` suffix
  exists nowhere in `components/`, `app/` or `lib/`. Fixed, and now passing.
  Every other `getByTestId` in the file was then resolved against the
  components — this was the only unmatched one.
- the seven-day `ArrowRight` walk sat INSIDE `expect.poll`, whose callback
  re-runs until the poll times out, so it pressed on well past a week and could
  pass on an occurrence outside the range its own failure message describes.
  Bounded outside the assertion now.

**Still failing: `completing a check-in offers the note and the trip back`** —
the check-in bridge, which the Verification gates above name as the case Phase 3
exists for. It fails at the day walk: `[data-testid="item-card"]` filtered by
the check-in title is never found, on all three attempts, across three separate
runs. What is known:

- It is not the app. The sibling case creates a check-in identically and passes,
  and `goalProgress`/membership assertions elsewhere in the file confirm the row
  reaches the database.
- **The first hypothesis was wrong, and the record should say so.** `item-card`
  is emitted by `task-row.tsx` alone — the Schedule layout renders
  `schedule-block` — and layout is per-user state that `view-matrix.spec`
  corrupts when it dies inside `pickDisplay`. That explained why the case passed
  at 21:40 and failed at 22:09 with no relevant change. Both day-walking cases
  now pin scope and layout through the helpers that assert `data-view-scope` /
  `data-view-layout`. **The symptom is identical with the pin in place**, so
  layout was not the cause, or not the only one.
- The pin is kept regardless: scope genuinely matters here, because an arrow key
  steps SEVEN days under Week and would stride the walk past the occurrence.
- Unverified suspicion for whoever picks this up: the walk drives navigation with
  `page.keyboard.press('ArrowRight')`, which needs canvas focus. Radix returns
  focus to the trigger when a dropdown closes, and `waitForTimeout(150)` between
  presses is a race either way. `navigateToDate` in `helpers/app.ts` asserts
  `data-date` after each step instead of assuming the keypress landed, and is
  probably what this walk should use.

**Why it was left failing rather than fixed:** it cannot be reproduced from this
environment (see the two blockers below), so every hypothesis costs a ~30-minute
blind CI round trip — and the suite is degrading independently while that runs:
24.1m/7 failed/120 passed → 26.0m/7/122 → 31.8m/9/119, with `organize:460` and
`pause:99` newly failing, neither touched by this branch. Kirby's call
(2026-08-22) was to land the rest and fix this in a follow-up. It is documented,
NOT skipped or quarantined — the test still runs and still fails, which is the
only honest way to leave it.

**Six pre-existing failures are not this branch's** and were not fixed here:
`sidebar-resize` (3), `view-matrix` (1), `week-scale` (2). They survive two
retries at `workers: 1`, so they are deterministic rather than the shared-user
flake `playwright.config.ts` describes. `view-matrix` deserves its own PR for a
reason beyond being red: it corrupts shared display settings for everything that
runs after it.

**And the e2e job is `continue-on-error: true`, so every one of these has been
invisible behind a green check.** Demonstrated on this very PR: run 407 reported
`conclusion: success` at the run level while its E2E job concluded `failure` with
seven red tests. Making that job gate is worth doing once the six are fixed;
doing it before then would just make every PR red on failures that predate it.

**Still owed, and still blocked here:** the Phase-4 live agent calls (the
programs 39-call standard). Two independent blockers, and the second is the one
that matters:

1. No `.env.test`, and it cannot be synthesised here. `testEnv()` demands five
   vars. Two are recoverable from the Supabase MCP (project URL, anon key); three
   are not — `SUPABASE_SECRET_KEY` (service-role; the MCP exposes publishable keys
   only, by design) and the dedicated Playwright user's `TEST_USER_EMAIL` /
   `TEST_USER_PASSWORD`. There is no `vercel` CLI here either, so
   `vercel env pull` is not a route.
2. **The sandbox's network policy denies outbound HTTPS to `*.supabase.co`.**
   Measured, not inferred: `registry.npmjs.org` 200, `github.com` 400, the project
   host 000 with `CONNECT tunnel failed, response 403` from the agent proxy. So
   even handed all five secrets, `next dev` could not reach the database. The
   Supabase MCP works only because it routes through Anthropic's relay rather
   than container egress — which is why the migration could be applied from an
   environment that cannot run anything against it.

Do not read "036 applied" as "the gates passed". One e2e case is red and the
live agent calls have not run.

## Deferred for a decision (recorded, not designed)

- **Shelving a goal to hide its work** — use a program (an item can be in both).
  Revisit if users keep creating shadow programs mirroring goals.
- **Achievement snapshot at achieve-time** — freezes the milestone list against the
  purge decay decision 5 accepts. Add if the decay chafes.
- **Goals holding routines/projects** — items-only in v1; the join-table precedent
  makes this cheap later.
- **Numeric key results** ("$1.2m of $3m") — v1 milestones carry it in the title; a
  `target_value`/`current_value` pair on the join row would be additive.
- **Reminders for check-ins** — `reminder_at` is a dead column; a real reminder is
  a new subsystem (push machinery exists, the wiring doesn't).
- **Guided check-in flow** (EOD-style dialog) — after Phase 3's receipt+note proves
  the cadence.
- **Sub-goals / hierarchy** — milestones cover the first level.
- **`goal:<name>` search grammar** — still deferred. (Display-menu group-by-goal was
  deferred beside it and SHIPPED 2026-08-26, with the first-claim-wins rule this entry
  called for and a goal FILTER alongside it; the search grammar did not have to come
  with it, because a filter row and a query token are different affordances and only the
  grouping needed the rule. See the addendum in display-menu.md, and note the product
  decision below — "no ScopeRail or Display-menu presence" — which this reverses for the
  Display menu and leaves standing for the scope rail: a goal still suppresses nothing.)
- **Braindump sub-grouping for undated milestones** — if squatting chafes.

## Product decisions (Kirby, 2026-08-20)

All eight open questions resolved as recommended: the noun is **Goal** (vocabulary
cleanup shipped unconditionally in Phase 1 instead of the original conditional
hedge); many-to-many membership; milestones are items-with-a-role; behind-ness
rides normal past-due quietly (amended by review: sweep/bulk-verb exclusions
protect the target date, see decision 4); no numeric targets in v1; no
auto-achieve (celebrate receipt, gated); check-ins default weekly, the item owns
its recurrence; no ScopeRail or Display-menu presence.

## Phase 0 implementation review (2026-08-20)

Four lenses over the committed diff (SQL correctness — which dry-ran the migration
against a real PostgreSQL 16 cluster with a pg_cron stub, fresh / twice / twice in
one transaction / three partial states; db.ts runtime; type + registry coherence;
scope audit and plan fidelity). **No blocker. 1 defect found by three lenses
independently, plus 9 smaller findings — all fixed in the follow-up commit.**

**The one that mattered, and it was latent rather than live.** `updateGoal` threw
unless a patch carried all three role arrays. The caller that consumes it in Phase
1 is `syncContainers`, which builds a patch of only the fields that DIFFER and
fires it as `update(...).catch(console.error)` — so undoing "added a milestone"
would have arrived as `{ milestoneIds }` alone, thrown, been swallowed, and left
membership undo a silent no-op. That is the exact failure the comment three lines
above the routines call site records having already shipped once. The fix is
better than the guard it removes: `reconcileGoalMembers` was already reading the
rows it needed and discarding their `role` (`select('item_id')`), so reading the
role lets deletions be **scoped to the roles the caller actually named**. A
partial patch is now correct, a demotion still reconciles as one union with no
delete window (it always changes two arrays, so both roles are in scope), and a
full three-array write behaves exactly as before.

**The migration's own idempotency argument did not cover its worst case.** The
file argues at length that `create table if not exists` skips inline constraints
silently, pulls the UNIQUE and both CHECKs into guarded blocks on that basis — and
left `goal_items`' primary key and both composite FKs inline. Verified by
execution rather than reading: over a hand-made `goal_items`, the committed
version exited 0 having applied only the role CHECK, with **no primary key, no
foreign keys and no `sort_order` column**. By the file's own loud/silent taxonomy
those FKs are the worst thing to lose — a missing PK raises 42P10 at the first
upsert, a missing FK fails silently, and the two composite FKs are the entire
reason a membership row cannot be forged across tenants. Now every structural
piece is guarded, and the repair is proven: the same partial table comes out with
all four constraints plus the column, and a cross-tenant insert is refused with
23503. (This deliberately departs from 024, which has the same gap for
`routine_items`/`program_items`.)

**Three claims in prose that the code did not support** — the class this codebase
punishes hardest, since a later reader trusts them rather than re-deriving:
`unavailable()` hardcoded "migration 024 … programs/routines disabled", so a
missing `goals` table pointed the operator at the wrong migration and the wrong
feature during exactly the deploy window the header spends ten lines on (now
parameterised); the migration header claimed the store gates the write path off,
which is Phase 1 code (now says so); `isCheckinEligible`'s docblock claimed it
asked the registry so "a future type that forbids recurrence answers correctly for
free" while the body only read the item's own `repeatFrequency` (now it asks
`allowedFrequencies`, making the sentence true rather than deleting it); and the
LEDGER paragraph justified itself with 025/026 "not in this worktree" when both
files are (`7cfeb4a`, an ancestor) — the instruction was right, the reason stale.

**Smaller, all fixed:** `updateGoal` committed the column half before validating
membership, so a rename-plus-contradiction persisted the rename (validation
hoisted, matching `createGoal`); `state` lost the `!= null` guard its sibling
`updateProgram` carries on the identical NOT NULL column, so `{ state: undefined }`
would serialise to an empty body and drop the write silently; `fetchGoals` spread
one hoisted `empty` object into every memberless goal, sharing three array
references across all of them; and the read-side unknown-role degradation now
records the write-side consequence it cannot avoid rather than implying
permanence.

**Tests added for the two behaviors the ledger claimed but nothing pinned** —
`reconcileGoalMembers`'s union diff and role scoping, and `fetchGoals`'s splitting
and null-on-missing-table — against a fake PostgREST that honours projection, so
a function cannot look correct while reading a column its own query never asked
for (which is precisely how the fixed defect hid). Plus `milestoneEligible` on the
custom-type and deleted-type-fallback configs. 24 tests in the file, from 11.
**One of the new tests failed on first run and the code was right**: a fixture
dropped a milestone from its array without naming it anywhere else, and the
reconcile correctly removed it from the goal. That semantic — "an unmentioned
ROLE is left alone, but an id dropped from a SUPPLIED array is gone" — is now
pinned as its own case.

**Refuted and not to be re-raised** (each checked against the code, several by
execution): the one-union property itself holds for demotion, promotion, add,
remove, reorder and no-op; cross-array refusal is symmetric; the three-array fetch
ordering IS deterministic despite two roles carrying a null `sort_order`, because
`(sort_order NULLS LAST, item_id)` restricted to one goal is a total order;
`createGoal` really does validate before inserting and its compensating hard
delete matches `createRoutine`; composite-FK ordering within the file is correct;
the cron DELETE list drops nothing 024 purged; the index set covers every query
db.ts issues; no external contract moved (`DsulContextResponseSchema`,
`TaskSchema`/`HabitSchema`, both FIELDS lists and the plugin's payload are
byte-identical); no goal leaks into filters, grouping, the scope rail, search,
commands, the console or trash — verified by grep AND by the fact that every
consumer narrows to `CLASSIFY_KINDS`/`GateKind` first; the "widening
ContainerKind produces exactly one compiler error" claim in the registry header is
empirically true (a sixth kind yields precisely one TS2741); no goal path reads or
writes `items` or any item field; and all 22 mock edits are additive and change no
existing assertion.

## Pre-build adversarial review (round 1, 2026-08-20)

Five lenses over the approved draft (data model & schema integrity; external
contract safety; codebase fit / stale premises; product-UX coherence; completeness
& phasing), each instructed to refute its own candidates against the live code
before reporting. **2 blockers, ~18 should-fixes, ~12 notes survived; all folded in
above.** The two blockers converged across lenses independently — cross-lens
convergence again beat any single lens's severity guess:

- **The role-shape invariant had no enforcement against item-side writes** (2
  lenses): the predicates guarded role grants, but the item dialog and agent PATCH
  flip `repeatFrequency` freely, and a recurring milestone's scalar status is
  frozen by design — progress would lie forever, in either direction. Resolved
  with the demotion mechanism (decision 3).
- **The check-in's entire value lived on a surface check-ins never route to**
  (UX lens): they are completed on the grid and in EOD, while the note/history
  lived only on the goal page. Resolved with the completion receipt bridge.

The instructive should-fixes: the past-due machinery WRITES startDate (sweep
erases it, bulk verbs restamp it) — the milestone target date needed protecting
from the very machinery decision 2 opts into; three role arrays over one join
table needed one-union-reconcile semantics or role demotions race; the goal write
surface would have repeated the `paused:true` 200-and-do-nothing bug the programs
review already paid for; `achieved_at` needed the pausedAt idempotence rules or
retries move a multi-year achievement date; the bin arm and trashed-member keeping
needed to be role-aware or restores demote milestones silently; ended goals
orphaned their recurring members with the why stripped away (wind-down step);
sparse/empty progress misled ("2/2" on a 3-year goal — display rules); and the
plan had NO mobile section while its one attribution affordance was hover-only.

Stale premises corrected (the #205 lesson, again): `openDialog({type:'console'})`
does not exist (`organize`/`section` does); "six vi.mock files" is now ~20;
"exhaustive-switch errors find every touchpoint" finds exactly one (the real
tripwire is container-registry.test.ts plus a hand-wired list); `groupResults`
cannot host goals (typed to Items, and the `'goal'` key collides with the
custom-type slug); nothing seeds an item type named `goal` (the collision surface
is the placeholder + example copy, now a Phase-1 task); `reminder_at` is a dead
column, so decision 2's reminder claim was vaporware.

Refuted, and not to be re-raised (each checked against the code by the reporting
lens): the deploy-order PGRST204 hazard (no item columns — the claim's logic holds);
one-shot scalar status being unreliable (it is truthful while the item stays
one-shot — the blocker was about it not staying so); far-future milestones leaking
into today's views; trashed items polluting the live index; check-ins colliding
with EOD/morning bulk verbs (recurring rows are already excluded); the guilt-free
law being unimplementable for overdue milestones (today's past-due surfaces are
already warning-free); from-zero users hitting the programs dead end (the console
has permanent doors; the surviving risk was only the chip gate, fixed); goal-slug
DB collision (items.type and the goals table are disjoint namespaces); the purge
cron, composite-FK, updated_at-trigger, and 23503-swallow patterns all inheriting
cleanly from 024.
