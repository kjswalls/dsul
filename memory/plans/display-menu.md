# Display Menu Plan — one filter/sort/group surface for the braindump and the canvas

**Goal:** Replace the two duplicated filter popovers with one **Display** menu per surface
(Grouping · Ordering · Filter · Show), built on a real Radix `DropdownMenu`; fix the three
copies of the habits-vanish bug underneath them; expose grouping (which exists in the store
but has no UI) and ordering (which does not exist at all) on every surface that can honour
them.

**Status (2026-08-15): LANDED ON `main`.** Phases 0–5b and Step 6's A + A′ shipped on
`feat/display-menu-impl`, each followed by an adversarial review, and the branch
fast-forwarded `main` from `a1c03c2` to `f68a3d1` — 27 commits. **The plan is complete
here** — Phase B belongs to `feat/organize-console`, which shipped it as migration 027
plus its app half. See the ledger for what that means and what NOT to rebuild.

**Merge gate, for whoever lands the next branch off this base.** The branch had never
been pushed, so that was the first CI run over all 27 commits. What was checked: 944
unit tests over 56 files, lint clean, `packages/types` dist rebuilt with no drift (the
one thing CI actually gates besides vitest), and `next build` green. What was NOT
checked, because nothing in this repo checks it: **types.** `next.config.mjs` sets
`typescript: { ignoreBuildErrors: true }` and the workflow runs only the dist check and
vitest, so `tsc --noEmit` reports 30 errors that have been accumulating unobserved. All
30 predate this branch — verified file-by-file against the touched list, and for
`lib/planner-types.ts` (the one overlap) the erroring declarations are byte-identical to
`main`, just shifted 27 lines. Two are live: `edit-project-dialog.tsx:147,303` compares
`repeatFrequency` against `'weekly'`, which is not in the union, so those branches are
dead code.

**`DEFAULT_PROJECTS` / `DEFAULT_HABIT_GROUPS` do not satisfy their own declared types** —
both are missing `id` (`planner-types.ts:114-124`). That is the same defect
organize-console's Phase 0 met from the data side: 223 of its 228 unlinked group
references belong to one account with **zero `habit_groups` rows**, because those groups
have only ever existed as a client-side constant. The type error and the backfill miss
are one bug seen from two ends; Phase 6 of that plan is where it resolves.

Full spec, with the menu and the schedule lanes rendered at true size in dsul's own
tokens: <https://claude.ai/code/artifact/2de4b068-d090-4f72-9ff4-2109c0e8a848>

---

## What is actually wrong today

dsul answers "what am I looking at" in four unrelated places — a type dropdown, a filter
popover, a group-by reachable only from the command palette, and a sort that does not
exist. Verified against `a1c03c2`:

1. **Habits vanish.** `day-items.ts:102-104`, `braindump.tsx:404-406` and `search.ts:105`
   each set the habit list to `[]` the moment a priority or project filter is active.
   Habits carry neither field, so the filter silently means "and also hide all habits".
   The comment at `day-items.ts:99-101` states it as intended. **No test covers it**, so
   nothing breaks when it goes.
2. **Tasks vanish too.** `day-items.ts:82-85` rejects any item whose priority is *unset* —
   and priority is usually unset.
3. **Two popovers, one body.** `braindump.tsx:31-177` and `primitives/filter-popover.tsx`
   are the same markup. One concept has four type declarations, two of which disagree
   (`priorities: string[]` vs `Priority[]`).
4. **`persist` has no `merge`.** `view-store.ts:207-216` declares only `name` and
   `version`. Zustand's default merge is shallow, so a persisted payload replaces the
   nested filter objects **wholesale** — adding a field yields `undefined` in production.
   **The e2e suite cannot catch this**: `tests/e2e/helpers/session.ts:114-130` seeds a blob
   that omits both filter objects, so every spec rehydrates fresh defaults and stays green.
5. **`created_at` never reaches the client.** `ItemRow` (`db.ts:27-65`) declares neither it
   nor `updated_at`; `fetchItems` orders by it and the mapper drops it. So "recently added"
   is not sortable without data work — and `TASK_FIELDS` feeds undo's diff, so a new field
   must be kept out of the update allowlists (`ProgramSchema.updatedAt` is the precedent).
6. **There is no drag-to-reorder.** No `useSortable`/`SortableContext`/`arrayMove` anywhere;
   `reorderTasks` has a declaration (`planner-store.ts:167`), an implementation (`:1356`)
   and **zero call sites**. `items."order"` is written once at creation. So no sort
   conflicts with any gesture. What drag *does* depend on is time order — see decision 4.

---

## Locked design decisions

1. **The pass-through rule.** A predicate on field *F* may only exclude items of a type that
   *carries* F. Types where `getItemTypeConfig(name).fields.includes(F)` is false pass
   through untouched. `fields` is `Object.keys(taskShape)`/`Object.keys(habitShape)`, so it
   cannot drift from the schemas, and ItemDialog already interrogates it this way. Its
   companion: an item that carries the field with the value **unset** belongs in an explicit
   "None" value, not in oblivion — `buildListGroups` already mints those buckets for
   *grouping*; the filter path never learned about them.
2. **Container is one axis, not two.** Resolved per item through `containerKind`: task-like
   items answer with their project, habits with their group. Habits are not container-less;
   they were never asked. Values are stored **prefixed** (`project:Work`, `group:health`) so
   a project and a habit group sharing a name cannot collide. `itemFromRow` maps
   `group: row.group ?? ''` (`db.ts:108`), so **No group** is a real reachable value.
3. **Ordering is applied post-derivation**, in `day-list` / `week-list` / `braindump` only —
   never inside `deriveDayItems`, which is shared by all six canvas surfaces and whose
   comparator two of them depend on.
4. **Grouping may label the timed zone; it may never partition or reorder it.**
   `inferDropTime` (`lib/dnd/infer-drop-time.ts:42-69`) resolves a drop as "30 minutes
   before/after *that item's* time", not as a slot index. "The gap above row X" only means
   "just before X" while the row above it is earlier in the day. So in a bucket's timed zone
   DOM order is `startTime` order, always.
5. **Schedule grouping is lanes in Day, focus/recede in Week.** Lanes **nest inside** overlap
   resolution rather than replacing it — `placeSiblings(sibs, area: Band, depth)`
   (`schedule-overlap.ts:461`) already derives its channel budget from `area`, with only two
   hardcoded roots. Week gets focus because at every derived default a week column is
   arithmetically *exactly one* 140px channel; there is nothing to divide. **Lanes ship
   read-only on x — drops stay time-only** (see the deferred list).
6. **"Hide finished" hangs off the Display toggle, not `showCompletedTasks`.** That global's
   manifest entry promises "Tasks only — habits always stay", and skips are overwhelmingly a
   habit gesture. It hides completed-on-date, `doneStatus`, and **skipped** occurrences. It
   deliberately does **not** hide `cancelled` — nothing else would bring those back.
7. **One canvas filter set shared by all six canvas surfaces; the braindump keeps its own.**
   Each surface renders only the axes it can honour and ignores the rest. Strictly better
   than today, where the palette offers five group-by values that do nothing in four of six
   views.
8. **`version` stays 1.** `view-store.ts:208-213` forbids a bump, and
   `tests/e2e/helpers/session.ts` seeds a literal `version: 1` blob. A custom `merge` is
   independent of `version`, so it needs no bump.
9. **Containers get a capability registry, but not yet and not all of them.**
   `role: 'classify' | 'gate'` over the *existing five tables*; projects + habit groups
   classify, routines + programs gate, `item_types` stays out. The seam is enforced by code:
   `ActivationContext` takes only routines and programs, `ScopeKind` is only those two.
   Custom container kinds are **not v1**. See `organize-console.md` — its Phase 0 and this
   plan's Phase B are the **same migration**; schedule it once.

---

## Deliberately not offered

| Option | Why |
|---|---|
| Routine / program filters | The scope rail already does the durable version, per-date, through the DB, with a resume date. Program membership resolves disjunctively through routines, so a checkbox would misrepresent it. |
| Overdue | On the canvas an overdue item is by definition not on the day you are looking at. The past-due bar owns it. |
| Duration, assignee, aiStatus, has-notes, has-subtasks | Near-always empty. A permanently blank control is worse than none. |
| Sort by recently-added | `created_at` does not reach the client (see problem 5). |
| Group by status | Done in 5a: the union member is gone, and a stale value is coerced at BOTH doors — `view-store`'s persist `merge` and `adoptLegacyViewPrefs`. `planner-storage` partializes `groupBy`, so the legacy mirror is a second live source, not a theoretical one. |
| Saved views / presets | Correct end state, premature — there is not yet one honest filter menu to save from. |
| An "Other" lane past the lane budget | A lane naming groups it cannot spatially distinguish is a channel that lies. Overflow groups stay in the cap row, reachable by focus. |

---

## Phase ledger

| Phase | Content | Size | Status |
|---|---|---|---|
| **Step 1** | `containerKind: 'projects'` on the custom template + the two sweeps that tested `type === 'task'` | <1 h | **shipped** `a81018a` |
| **0** | One `ViewFilters`; custom `merge`; legacy read-time normalizer; `Priority[]` convergence | ~½ d | **shipped** `dba554f` + `cb82e05` |
| **1** | `lib/filters.ts` — the pass-through rule; delete all three habits-wipes; explicit None values; project-block rules | ~1.5 d | **shipped** `0d36efc` + `adf944d` |
| **2** | Fold `week-schedule.tsx:325-361` (a verbatim copy of `use-day-items.ts:34-63`) into the hook | ~½ d | **shipped** — `useDayItemsForDates` |
| **3** | `components/primitives/display-menu.tsx`; delete `filter-popover.tsx`; mount on canvas, sidebar **and mobile header** | ~3 d | **shipped** — Ordering deferred to 4 |
| **4** | `lib/sort-rows.ts`, applied post-derivation on the three list surfaces; repair the degenerate habit comparator (`day-items.ts:121` returns 0 whenever either `startTime` is missing) | ~1 d | **shipped** |
| **5a** | Extract `buildListGroups` into a pure `lib/grouping.ts`; grouping in Day×Buckets, Week×Buckets, Week×List and both Schedules' Anytime strips | ~6 d | **shipped** |
| **5b** | Schedule lanes + Week focus/recede | ~5 d | **shipped** |

**Carried into 5b from the 5a review and done:** the strip's own "Anytime" heading now
gives way to the group headings rather than sitting above them, so grouping by Time bucket
no longer renders "Anytime › Anytime".
| **A** | `lib/container-registry.ts` over the existing five tables | ~1 d | **shipped** `dbe2960` |
| **A′** | Case-sensitivity normalization, split out — it changes which colour resolves for an account holding both `Work` and `work` | ~½ d | **shipped** `2fe86a0` |
| **B** | container ids + backfill + dual-write + undo wiring + rename | ~2 d | **DONE ELSEWHERE** — migration 027 + app half on `feat/organize-console` |

**Phase B is not this plan's work and never should have been.** Decision 9 said so —
*"its Phase 0 and this plan's Phase B are the **same migration**; schedule it once"* —
and it was scheduled once, on `feat/organize-console`, which shipped it on 2026-08-12:
`7e12c2d` (migration 027, applied and verified against the live DB), `c24e92b` (the
rename fan-out), `61c9a8f` (the rename UI), `81c5c21` (agent writes reach the id) and
`0a38733` (the trash-blind rename guard, and undo unlinking members). Do not build any
part of it here.

**The design there is TWO columns — `items.project_id` and `items.group_id` — not one
`container_id`.** Each carries a real FK with `ON DELETE SET NULL`, which a single
column pointing at either of two tables cannot. This plan's "one axis, two namespaces"
framing argues for one column; 027 weighed that against referential integrity and chose
integrity. The axis stays one axis app-side regardless — that is what `itemField` is for.

**What the live database revealed** (worth keeping, whoever asks next): 206 items name
a container that has no row. 194 habits are in a `Personal` group that does not exist in
`habit_groups` at all — written by `orphanContainerFallback: 'Personal'` and the two
`|| 'Personal'` fallbacks in `removeHabitGroup` / `cleanupOrphanedReferences` — and 12
tasks name a deleted project, `Housework`. Both backfills correctly leave those null.
That is the whole argument for id references in one number.

**A shipped four kinds, not five.** `role: 'classify' \| 'gate'` over projects +
habit groups (classify) and routines + programs (gate); `item_types` stays out per
decision 9. The seam is types, not convention: `ClassifyKind` is what a ref can name
and what `containerRefOf` returns, `GateKind` is what `ScopeKind` now *is* (aliased,
not re-declared).

**A′ turned out to be mostly a STORE phase, not a data phase.** Normalizing stored
data is a migration and belongs to B. What A′ fixed was the app-side inconsistency:
three lookups folded by hand while the two verbs that *repair* references compared
exactly, so `removeHabitGroup` left a habit stored as `personal` pointing at a
deleted `Personal`. It also took `GroupSection`'s glyph off the label — see the
gotcha below.

Phases 0–2 are pure correctness and are worth landing even if the redesign stops.

---

## Gotchas that cost time to find

- **`deriveDayItems` used to read the weekday in the BROWSER's zone and the date in the
  USER's** — fixed in 5a by DELETING the input. Tasks and habits go through
  `shouldShowOnDate(row, dateStr, timezone)`, which is tz-resolved; project blocks went
  through `date.getDay()` / `date.getDate()`, which are not, so when the two zones
  differed a Thursday block rendered on Wednesday. `DayItemsInput` no longer carries a
  `Date` at all — `calendarParts(dateStr)` builds the weekday, the month-day and the
  month's length through `Date.UTC`, so the disagreement is unrepresentable rather than
  merely corrected. Note what that costs: the fix is **structural, not pinned by a
  red-then-green mutation**, because there is no longer an API through which to reproduce
  the bug. `tests/unit/day-items.test.ts` pins the resolution itself instead, and those
  cases would have passed before the fix given a Date that agreed with its dateStr.
- **That also dissolved the `getTime()` memo key question.** `use-day-items` keyed on the
  exact instant because two instants could share a `dateStr` and disagree on `getDay()`.
  With the Date gone the mapping is total, so the key is the resolved `dateStr` list —
  provably the derivation's whole input. The gotcha that said this needed a
  zone-divergence test is retired: there is nothing left to diverge.
- **The mobile shell renders `MobileHeader` above every `activeTab` guard**
  (`mobile-shell.tsx:55`), so anything mounted there rides all three tabs. Gate on
  `useMobileNavStore(s => s.activeTab)`, not on the header's own existence.
- **Mobile never reads `view.scope`.** `MobileViewRouter` dispatches on `layout` alone and
  hardcodes `data-view-scope="day"` (`mobile-view-router.tsx:34`); `commands/registry.ts`
  hides both scope commands there for the same reason. But `scope` PERSISTS across the
  768px breakpoint, and `useIsMobile` is a live `matchMedia` listener — a narrowed window,
  a snapped half-screen or a rotated tablet all reach the phone shell carrying whatever
  scope was last set. Any mobile surface deriving behaviour from `scope` must state its
  own instead, or it answers for a view nobody is looking at, with nothing on that surface
  able to correct it.
- **Nothing clears `canvasGroupBy` on a scope or layout change** (`view-store.ts:154-167`).
  So a control that HIDES itself when the current view cannot honour grouping strands the
  clause: the trigger keeps counting it with no row to account for it. Unhonoured values
  stay visible and disabled with the reason on the rail — the same grammar Buckets already
  uses. Phase 4's Ordering is the second axis with this shape; use the same rule.
- **Don't derive an ARIA role from close-behaviour.** `ValueRow` mapped
  `keepOpen ? menuitemcheckbox : menuitemradio`, which made the "Switch to List" ACTION a
  sixth unselected radio among five real grouping values — in the default view, so it is
  what a first-run screen-reader user hears. Action rows take `role="menuitem"` explicitly.
- **A props-level test passes while the MOUNT is wrong.** Both mobile defects above lived
  in `mobile-header.tsx`, not in `DisplayMenu`, and every component test stayed green.
  `tests/unit/display-menu.test.tsx` now renders `MobileHeader` itself; it needs
  `next/navigation` and `@/lib/supabase` (with an `auth` object) mocked to do so.
- **Grouping and Ordering are independent axes, and grouping owns the outer order.**
  `day-list.tsx` sorts WITHIN each group, after `buildListGroups`. Because `sortRows(rows,
  'default')` returns the same array, routine grouping keeps `routine_items.sort_order` —
  the only place that sequence is visible outside the manager — until the user picks an
  ordering, which then wins.
- **`sortRows` returns its input array unchanged for `'default'`.** The derivation's own
  order IS the default, so there is nothing to do. Callers must not mutate the result.
- **Group FIRST, then sort within each group — on every surface.** The braindump shipped
  the other way round for one commit, and the failure is instructive: its grouping map is
  filled by walking the row list, so `[...groups.entries()]` returns whichever group owned
  the first row. Sorting the flat list first made the SECTION HEADINGS reorder while the
  rows inside each stayed correct. `lib/grouping.ts` takes unsorted rows and returns them
  in arrival order; every caller applies `sortRows` per group afterwards.
- **`'none'` is one unlabelled section, not a per-view default.** Day × List's
  HABITS / TASKS / PROJECTS and a bucket card's HABITS / TASKS are presentation choices
  for those views, so they stay local (`defaultListGroups`, `defaultBucketGroups`) — the
  shared core would otherwise have to know which surface was asking. Callers that render
  `g.label ? <GroupSection> : flat` get the flat default for free; the two that want
  something richer branch on `groupBy === 'none'` BEFORE calling, or they render a
  section with an empty heading.
- **Grouping resolves the container axis through the registry, so habits section by their
  own group.** `buildListGroups` hoisted every habit into one "Habits" section and grouped
  only the tasks, which made "group by Project" answer a question about tasks and then
  file the rest of the day under its own type name. Priority lost the same hoist: a type
  that does not carry the field lands in "No priority" beside everything else that has
  none, which is the call `sortRows` already made. Section keys are the PREFIXED refs, so
  a project and a habit group sharing a name stay two sections — the seeds collide, so
  that is the shipped state of a fresh account. Unset is kind-tagged (`none:project` /
  `none:group`) rather than reusing the filter's single `NO_CONTAINER`: the filter needs
  one checkbox catching both sides, a heading has room to say which side it is.
- **Habits carry no `order`.** `habitShape` omits it (`packages/types/src/schemas.ts:206`),
  `itemFromRow`'s habit branch never reads it, `reorderTasks` early-returns on
  `type !== 'task'`, and the registry says `orderable: false`
  (`item-registry.ts:319`). So `byTimeThenOrder`'s `order` tail is inert for habits —
  two untimed habits compare equal and hold their load order (`ORDER BY "order",
  created_at`). Do not write a test that supplies `order` on a habit fixture through a
  cast: it asserts behaviour production cannot reach, and it typechecks only because of
  the cast.
- **Re-run `tsc` AFTER adding test files, not just after touching source.** Four errors
  shipped in Phase 4 because the typecheck ran before the new test file existed and never
  again. `pnpm test` does not typecheck, and neither CI nor the Vercel build gates on it
  (`next.config.mjs` sets `ignoreBuildErrors`).
- **`view.clearFilters` in the palette and Reset display now differ.** Reset clears the
  filters, the grouping AND the type filter; the palette command clears `canvasFilters`
  only, which its own label ("Clear canvas filters") states honestly. Phase 6 owns parity —
  when it lands, both should route through one function.
- **`@testing-library/user-event` is not a dependency.** Component tests use `fireEvent`.
  Radix's `DropdownMenuTrigger` opens on **pointerdown**, not click, so `fireEvent.click` on
  a trigger leaves the menu shut and every query beneath it fails for the wrong reason. Sub
  triggers and items do respond to click. jsdom also needs `PointerEvent`,
  `hasPointerCapture`, `scrollIntoView` and `ResizeObserver` shimmed — see the top of
  `tests/unit/display-menu.test.tsx`, which carries them locally rather than editing the
  shared `tests/unit/setup.ts`.
- **A test named for a guard must assert a field that guard can write.** `removeProject`
  has one `set()` and writes exactly `projects` and `project: undefined`. A case titled
  "leaves a habit alone" that asserted `group` was true under every implementation,
  including one with the guard deleted — `group` belongs to `removeHabitGroup`. Before
  writing an assertion, name the write the verb actually performs.
- **"Blocked" was the wrong shape for grouping; support has THREE states.** 5a made
  "partly honoured" the common case — Buckets groups its untimed rows, Schedule its
  Anytime strip — so `groupByBlockedBy(): string | null` became
  `groupBySupport(): { honoured, note }`. A partly-honoured value stays ENABLED with the
  part it reaches on its rail; disabling it would say it does nothing. Exactly one
  combination is inert now (Time bucket on Buckets, where the view already IS that
  partition), and the "Switch to List" escape row renders only while the current value is
  inert — it used to ride every non-List layout, resolving nothing.
- **A test asserting the TAIL of a list survives a mutation that DUPLICATES rows.** The
  first version of "leaves the timed spine ungrouped" checked `slice(-3)` and stayed green
  when the timed rows were handed to the grouping pass, because that renders them inside
  the groups AND leaves the spine below intact. Assert the whole sequence: six rows, this
  order, once each.
- **Time bucket gets NO answer on Schedule — not lanes, not focus.** y already is the
  bucket, and `autoCorrectBucket` (`planner-store.ts:596-602`) forces a timed item's bucket
  to match its `startTime`, so bucket lanes are mutually exclusive on y *by construction*:
  a literal staircase with two thirds of the field dead at every height. 5b shipped
  dividing by it for one commit — the rule was written in `view-options.ts` and implemented
  nowhere, and `planLanes` never saw the value. A rule stated in a comment is not a rule.
- **A raw arbitrary shadow and a var-shaped one land in DIFFERENT tailwind-merge groups.**
  `cn('shadow-[var(--sched-shadow)]', 'shadow-[0_0_0_1px_var(--x)]')` emits BOTH — verified
  by calling `twMerge` directly — and Tailwind then orders same-utility candidates by string
  compare, so `'0'` sorts before `'v'` and the base wins. The receded hairline never
  painted, in either theme, while the token had exactly one consumer and looked wired. Wrap
  every composite shadow in its own `--sched-shadow-*` token so the two collide in one
  group. `--sched-shadow-done` worked only because it was already var-shaped.
- **A sticky box is constrained to its CONTAINING BLOCK — including the cap row.** The
  week's cap row spent a commit in an 18px wrapper of its own: zero travel, on the one
  variant that is *always* focus and where the caps are the only way to clear one. It is
  the same rule `week-schedule.tsx` spells out for the pinned hour gutter. It also needs
  `LANE_CAP_Z` (22) — above `WEEK_GUTTER_Z`, or the gutter's opaque background slides over
  the captions on the first scroll.
- **A wrapper that pads unconditionally around a component that renders `null`** moves the
  whole view. `LaneCapRow` returns null when nothing is grouped; its `pt-6` did not.
- **`preview` invalidates a block's EXTENTS, not its lane.** `const L = preview ? undefined
  : layout` predates lanes and was right then. Once every block carries a band, dropping
  the layout on pointer-down threw the block to the field's left edge across every lane
  until pointer-up. `bandOnly()` keeps the x half and clears what the new extents stale.
- **Lanes are one `layoutOverlaps` call PER LANE, not one call with lanes in it.** That is
  semantics, not tuning: two blocks in different lanes may share a time but never a column,
  so they must not cluster, column-pack or occlude each other. `LayoutOptions.root` supplies
  the lane's band and every existing rule then runs against the lane's width. Passing a root
  changes one other thing deliberately — **every** entry gets a layout, including
  un-overlapped ones, because the ABSENCE of a layout means "the whole field" to the
  renderer, which is exactly the wrong default once a block belongs to a lane.
- **`isReceded` must return false for a row the plan never saw.** The obvious
  `laneKeyOf(...) !== active` gives the opposite, and did — caught on the first test run,
  against a docstring three lines above asserting the safe behaviour. The failure modes are
  not symmetric: a stray at full strength stands out; a receded stray is work greyed out
  for a reason nothing on screen can explain.
- **Focus is resolved against the current plan, never cleared on a group-by change.** A
  key held in a store that knows nothing about grouping outlives the lanes that named it.
  Resolving makes it stop applying; clearing it would need a cross-store hook on every
  writer of `canvasGroupBy` and would still miss a rehydrate.
- **A ref written during render is a lint error** (`Cannot access refs during render`), so
  `useFieldWidth`'s freeze holds the EXPOSED value in state instead. Gating the observer on
  a `freeze` dep is not the alternative: it tears down and re-attaches, which fires an
  immediate measurement — the one thing the freeze exists to prevent.
- **A render test can pass because of a missing input rather than the rule it names.**
  `WeekSchedule` passes no `fieldWidth` at all, so its "never divides" case stayed green
  with the `variant === 'day'` rule deleted. The rule is pinned in the pure test, which
  hands week an explicit width; the render test now says plainly what it does and does not
  cover.
- **Deleting a RULE can hollow out a test that used to guard it.** The two cases pinning
  the phone's `scope` prop were real red-green guards while `groupByBlockedBy` answered
  'Day only' for every value on week. 5a deleted that rule, and since both cases seeded
  `layout: 'list'` — the one layout whose answer does not vary by scope — they went on
  passing with the prop ignored entirely. Every previous tautology in this project was one
  I wrote badly; this one I wrote well and then broke from the other end. When a phase
  changes a predicate, re-run the tests that name it **with the predicate stubbed**, not
  just green.
- **`BucketCard`'s own collapse toggle carries `aria-expanded` too.** A
  `button[aria-expanded]` sweep for section headings inside a bucket picks it up first —
  filter on `group/heading`, which is `GroupSection`'s own class, rather than slicing the
  first result off.
- **`toDateStr` builds an uncached `Intl.DateTimeFormat` per call** (`recurrence.ts:47-49`,
  ~50µs against ~0.05µs for `getTime()`). Week × Buckets mounts 28 cells that each call
  `useDayItems`, and dnd-kit re-renders every droppable on each collision-target change
  with the planner deps untouched — so resolving dates in a render body costs ~1.3ms on
  every one of those. `use-day-items` memoizes the resolution on the INSTANT key, which is
  strictly finer than the dateStr key it feeds and so cannot serve a stale string.
- **Habit-group refs case-fold; project refs do not — and grouping has to agree.**
  `sameContainer` (`filters.ts:149`), `getHabitGroupColor` and `GroupSection`'s glyph
  lookup all fold `group:` refs, because `makeAddDraft` writes a lowercase 'personal'
  against DEFAULT_HABIT_GROUPS' 'Personal' whenever the groups list has not loaded yet.
  `lib/grouping.ts` keyed on the raw ref for one commit, which split one habit group into
  two sections that the menu's single checkbox selects together. Phase A′ still owns the
  general normalization; this is only the grouping key.
- **Day × Buckets groups its untimed rows; Week × Buckets groups the whole cell.** Not an
  oversight — the day card has `scheduled:{bucket}:before|after:{type}:{id}` drop zones
  between its timed rows and `inferDropTime` reads the neighbours' times, so that spine
  cannot be partitioned. A week cell has ONE droppable (`week:{date}:{bucket}`) and
  renders every habit before every task, so it was never in one time order for a
  partition to disturb. `groupBySupport` encodes the asymmetry: 'Untimed rows only' on
  day, no note on week.
- **`lib/item-container.ts` was planned and not written.** The artifact's 5a sketch had a
  ~30-line module for container resolution, but `lib/filters.ts` already owns
  `containerRefOf` / `containerName` / `containerKindOf` — the same question, answered
  through the same registry field, for the filter path. A second module would have been a
  second answer to drift from. `lib/grouping.ts` calls the existing one; only the
  unset-label split (which SIDE of the axis is empty) is new, and it lives with the
  grouping that needs it.
- **Don't `git checkout --` a file you haven't staged.** The Phase 2 hook is a new
  function in an existing file; reverting a mutation-test edit that way restored HEAD's
  version and silently discarded the work. Copy to the scratchpad first, or stage before
  mutating.

- **A label is not an identity, and `GroupSection` treated it as one.** It matched the
  heading TEXT against projects first and habit groups second, so a project named
  "Morning" put its icon on the Time bucket › Morning heading, and (once the braindump
  carries habits) a habit group would borrow a same-named project's icon — the seeds
  disagree on two of three: 🧘/💚 Wellness, 🏠/⭐ Personal. It takes `groupKey`
  (`RowGroup.key`, which carries the namespace) now. **Why it went unnoticed:** a stored
  EMOJI is not an icon token, so `resolveCategoryIcon` falls through to the name-derived
  icon either way — only a *picked* `icon:dsul` ever reached the wrong heading. Any
  test of this has to pick an icon explicitly or it asserts nothing.
- **A fold applied on BOTH sides needs a fixture that differs on both.**
  `cleanupOrphanedReferences` folds building its set of live names and folds again
  asking about the item. A habit stored `personal` against a group stored `Personal`
  catches an unfolded SET and leaves an unfolded LOOKUP green — `'personal'` already
  equals its own folded form. Both spellings, always. Caught by its own mutation run,
  not by review; this is the sixth distinct shape of tautological test in this project.
- **`sameContainerName(kind, …)` is the store's API; `foldRef` is the ref path's.** They
  are the same policy (`foldRef` is built from `foldContainerName`) because the store
  holds BARE NAMES — `items.group` is `'personal'`, `habitGroups[i].name` is
  `'Personal'` — and nine identity lookups in `planner-store.ts` compare those directly.
  A ref-only API would have left every one of them spelling its own comparison.
- **View-layer project filters were deliberately left exact.** `week-buckets.tsx:120`,
  `project-block.tsx:143`, `day-schedule.tsx:232`, `day-buckets.tsx:221` and
  `app-shell.tsx:321` all compare `t.project === project.name`. Projects do not fold, so
  routing them through the registry is churn with no behaviour delta — but if
  `project.caseFold` ever flips, these five are the sites that will NOT follow.
- **A mutation run with a FILE FILTER does not measure the suite, and must not be
  reported as if it did.** A′'s commit claims flipping `project.caseFold` "turns five
  tests red across two files". It turns **16 red across 7** — the two extra files at
  that commit were `grouping.test.ts` and `filters-pass-through.test.ts`, and Phase B's
  schedule-lane render tests joined later, because folding project keys MERGES two lanes
  and the lane assertions notice. The number was wrong because the run was
  `vitest run <the two files I was editing>`. The code was better pinned than claimed,
  which is the benign direction — but the same habit reported in the other direction is
  a phase that looks verified and is not. **Mutation runs go through the whole suite.**
  Found by the Step 6 review; it was the only one of 23 findings to survive.
- **A fixture has to REACH the branch it names.** Two of these now. A′'s orphan sweep
  folds on both sides and the fixture differed on one. B's "does not sweep up another
  container's items when renaming ONTO its name" seeded that item WITH a `containerId`,
  so it took the id branch and never reached the name comparison the test is about —
  green under the exact mutation it is named for. Both were caught by mutation runs,
  neither by review. When a predicate has two branches, the fixture must say which one
  it is exercising.
- **`db-allowlists.test.ts` proves a field is not DROPPED, not where it LANDS.** Adding
  `containerId` to the shapes turned it red before `lib/db.ts` was touched — it did its
  job. But it probes with a truthy value and only counts keys, so a guard copied from
  `group` (`&& updates.containerId != null`) passes it while making "remove this item
  from its project" a no-op that reverts on reload. Any nullable field needs its own
  clearing case.
- **CHECK `git log --all` AND THE REMOTE LEDGER BEFORE AUTHORING A MIGRATION.** This
  worktree branches from `a1c03c2`; `supabase/migrations/` here stops at 024, and that
  was read as "024 is the latest". It is not — it is only the latest *on this branch*.
  The remote ledger already held 025 `theme_palette`, 026 `user_extensions` and 027
  `container_ids`, none of them in this tree. A duplicate `container_id` column was
  authored, applied to the shared database, and dropped again an hour later; the ledger
  insert silently no-opped on `on conflict do nothing` because 025 was taken, so the
  column existed with no ledger row — precisely the drift CLAUDE.md warns about. The
  directory is the source of truth for *schema*; the ledger is the record of what is
  *applied*, and other branches move it. `select version, name from
  supabase_migrations.schema_migrations order by version` costs one query.
- **Container ids are not agent-writable, on either design.** `feat/organize-console`
  `.omit()`s `projectId`/`groupId` from both create schemas, and this plan reached the
  same call independently for `containerId`: during dual-write the id and the name are
  two spellings of one fact, so a body carrying both can contradict itself — and an id is
  guessable where a name is not, while RLS covers `items` rather than the value in that
  column. Agents send the NAME; the route resolves the id (`81c5c21`).
- **An id field must enter `taskShape` AND `habitShape`** in `packages/types`, or undo
  silently reverts a container change. `diffItem` (`planner-store.ts`) iterates
  `getItemTypeConfig(...).fields` = `Object.keys(taskShape)`, so a field outside the
  shape never enters an undo patch: undo sends the *label* back and leaves the id on the
  new container. UI shows success; next reload shows the revert. Additive-optional is
  safe — the `parentItemId`/`assignee`/`aiStatus` precedent — but CLAUDE.md makes the
  committed `dist/` a CI gate. 027's app half does this with `projectId`/`groupId`.
- **`projects` and `habit_groups` DO exist in the live database, but no migration
  creates them.** Verified by query, not inference: `to_regclass` returns both. They were
  created out-of-band and survive in the tree only in the stale `supabase/schema.sql`, so
  a fresh Supabase project provisioned from migrations alone would have neither — which
  is why any SQL touching them still needs `to_regclass` guards, the mirror of the
  `unavailable()` pattern 024 uses app-side. Worth settling separately how `.env.test`
  and a fresh project get provisioned.
- **Undoing a rename is O(N) unbatched PATCHes.** `planner-store.ts:2274-2299` runs one
  `dbUpdateItem` per restored item with no batching.
- **`ScrollArea` silently drops `max-h`** — every scroll box in the menu is plain
  `overflow-y-auto`.
- **Do not use `DropdownMenuCheckboxItem`/`RadioItem`.** Both render their indicator on the
  left (`pl-8`, `absolute left-2`) against a trailing-check house grammar. Use plain items
  with `role="menuitemcheckbox"` and explicit `aria-checked`, as `CollectRow` does.
- **`shadow-[var(--shadow-elev-md)]`, never `shadow-md`.** Tailwind inlines theme shadows
  into `--tw-shadow` and never sees the `.dark` re-tune; `components/ui/tooltip.tsx` already
  fixed this for itself and documents why.
- **`header-capsule.tsx:75`** renders the selected check as `text-primary-foreground` — that
  is `--lime-ink`, dark-green ink meant to sit *on* a lime fill. Nearly invisible on the dark
  popover. Becomes `text-foreground`.
- **Lime budget: exactly one mark per surface**, the trigger dot, and it has **no
  transition** — `transition-opacity` on the wrapper would fade lime, which is forbidden.
- **Recession must be subtractive, never a wrapper `opacity`.** `day-schedule.tsx:922-926`
  already refused that once: three lime things live inside a block's wrapper. And
  `--grp-off-pane` needs its own value — aliasing it to the done token makes every receded
  *incomplete* block read as finished.

---

## Deferred, with the reasoning recorded so v2 does not re-derive it

- **Cross-lane drop assignment.** `closestCenter` compares the dragged element's rect centre,
  not the cursor (`CONTRACT.md:117-120`), against a 192px ghost aimed at a ~161px lane — a
  systematic one-lane error. Pointer-x is the right v2 mechanism, but `TouchSensor` is
  registered alongside `PointerSensor` and a `TouchEvent` has no `clientX`, so a naive
  implementation lands **every touch drop in lane 0**. And a gesture writing two fields at
  once is a data-loss class this app does not have. **If a reorder gesture ever ships, it
  arms only under `Ordering: Default`** — never auto-switch the sort on drop.
- **Routine lanes are never assignable, in any version.** Membership is many-to-many and the
  grouping branch is first-claim-wins (`day-list.tsx:105-131`), so x cannot express
  insert-into-B vs move-to-B. Routine is focus-only on the schedule.
- **A Type filter in the braindump.** Its corpus is single-type today; grouping by Type
  answers "what is in here" at that size. Revisit when habit drafts land.
- **Habit drafts in the braindump.** The branch at `braindump.tsx:405-419` is **kept**, not
  deleted, because drafts are intended to live there — but a draft habit cannot satisfy its
  own type's invariants (`group` is non-optional on the wire, `containerRequired: true`), so
  it needs its own pass: is a draft a real row in an unpromoted state or a distinct shape,
  what is the promotion gesture, and should the frozen `habits[]` projection see drafts at
  all (today it would — the projection is `delete type` over every non-custom item).

---

## Addendum (2026-08-23): gate grouping + the "Paused scopes" list

The braindump group-by vocabulary widened from `none | type | project` to add **Routine**
and **Program** (`BraindumpGroupBy` in [lib/view-store.ts](../../lib/view-store.ts), which
also gained the `isBraindumpGroupBy` merge coercion it never had); the canvas gained
**Program** (`GroupBy` in [lib/planner-types.ts](../../lib/planner-types.ts)). These are the
GATE axis — grouping-WITH-A-SWITCH, still never a FILTER (the "deliberately not offered"
rule holds: a gate's real answer is the resolver, not a client-side checkbox).

A gate group's header carries a pause switch, and the menu gained a **"Paused scopes"**
section (`PausedScopesSection`) below the separator — the off scopes, each one click from
back on. This is the reversibility home for a scope with no visible members, and it
replaces the retired Scope Rail (see `programs-routines.md`'s 2026-08-23 addendum). It sits
below the Structure/Filter line because turning a scope on reveals work — a Show-region
action, not a Structure one — and is app-wide (like Show paused), so Reset display leaves it
alone.

## Addendum (2026-08-26): the touch shell — one sheet, two levels

**The menu ships in two shells now.** Pointer keeps the Radix `DropdownMenu` this
plan built, unchanged. Touch (`useIsMobile`, the 768px `matchMedia` listener) gets a
vaul bottom `Drawer` that **drills in**: the root lists the sections with their current
value on the rail, tapping one replaces the sheet's body with that section — titled,
with a back affordance — and picking a value writes exactly what its pointer twin
writes.

**What was wrong.** Five of the eight sections open a second tier, all of them
`DropdownMenuSub` + `DropdownMenuSubTrigger` + `DropdownMenuSubContent`: Grouping,
Ordering, Type, Priority and Project / Group. (Hide finished, Show paused and the
Paused scopes rows are flat, and the two "Switch to List" escapes live *inside* the
first two tiers.) A Radix submenu is a hover-and-aim pattern — it opens on
pointer-enter, aims at a 240px panel beside its trigger, and has no dismissal of its
own. On a phone that panel lands off-screen or under the thumb that opened it, and
there is no way back to the tier it came from short of closing the whole menu.

**Drill-in, not one flattened sheet, and the deciding number is that one section is
unbounded.** Grouping is 7 values, Ordering 3, Type 3, Priority 4 — all of which
would flatten comfortably. Project / Group is every project plus every habit group
plus the unset value, which is why it is the one section carrying a scroller on the
desktop panel too (`scroll: true`, `max-h-64`). Flattened, the seeded account already
stands ~22 rows tall at the 44px touch floor — ~970px, past an 80vh sheet on most
phones — and it grows with the user's own data, burying Hide finished, Show paused,
Paused scopes and Reset under a list of their projects. Drilled, no pane but that one
exceeds seven rows. **If a later pass reduces the section count, this trade should be
re-derived rather than assumed**: flattening wins the moment the container filter is
the only long list left and it is gone.

**One body, two shells — and the body is now DATA.** The sections are described once,
as `Section` → `Entry` → `RowSpec` (label, state, what it writes, whether picking it
completes the choice), and each shell renders that description in its own idiom:
`MenuEntries`/`SubRow`/`ValueRow` for pointer, `SheetEntries`/`SheetSectionRow`/
`SheetRow` for touch. This is deliberate and it is the lesson of problem 3 above —
two popovers with one body drifted apart field by field until one of them was wrong.
**Adding, removing or reordering a section is an edit to `structure` / `filterSections`
/ `showEntries`, not to either renderer.**

**The ITEM roles are shared with the model, not with the shell.** A row's role says
what the row MEANS — a value in a set, an independent toggle, an action — and the
input device does not change that. So the sheet's rows carry the same
`menuitemradio` / `menuitemcheckbox` / `menuitem` the dropdown does, `roleOf()`
is the single answer both renderers ask, and the ruling above ("don't derive an ARIA
role from close-behaviour") holds in both. The CONTAINER is the shell's own business
and is `role="group"` here — see the gotcha below. It pays for itself twice: the escape row is
still an action on touch, and `pickDisplay` in `tests/e2e/view-matrix.spec.ts` —
trigger → `menuitem` section → `menuitemradio` value — is a verbatim description of
*both* shells, so no @mobile spec needed changing.

### Gotchas from the split

- **`keepOpen` means the same thing in both shells, and that is what makes single-
  select close the SHEET.** Multi-select stays on the pane so three container picks
  are three taps; single-select dismisses the whole sheet, exactly as it closes the
  dropdown — the choice is complete and the surface behind it has just changed shape.
  Returning to the root instead would leave the phone holding a sheet over a view it
  can no longer see.
- **The drilled pane is not a preference, and it is reset on the OPENING edge.** It
  is where you are standing inside a control that is currently open, so it lives in
  the sheet's own `useState` — but the reset belongs to the *next* opening, not to
  this one's close. Both spellings of "clear it on close" are wrong, and the branch
  shipped one of them for a commit. `open` is a controlled prop here, so vaul's
  `onOpenChange` fires for its OWN dismissals only (Escape, backdrop, swipe) —
  `useControllableState` calls `onChange` from vaul's setter and never from a prop
  change — so every close the component performs itself (`setOpen(false)`: a
  single-select pick, "Switch to List", Reset) skipped it. Picking a grouping value,
  the primary interaction this shell exists for, re-opened on the Grouping pane with
  Filter, Show, Paused scopes and Reset all behind a back chevron. And the close edge
  is the wrong edge anyway: `onOpenChange(false)` fires at the *start* of the exit, so
  the body flips to the root while the sheet is still sliding out. `if (next)
  setPaneId(null)` is one site, on one path (vaul's own trigger), batched with
  `setOpen(true)` so the first frame of the new sheet is already the root — whichever
  way the last one closed. `onAnimationEnd` is not the alternative: vaul schedules it
  off the same controlled `onChange`, so it is unreachable from a self-close, and a
  500ms timer that lands after a quick re-open would yank the user back to the root
  mid-interaction.
- **Focus does not follow an unmounting button.** Drilling in and coming back each
  unmount the row that was pressed, and the sheet had nothing to catch it: measured
  `document.activeElement === BODY` after both. Radix gives the desktop submenu this
  for free. The sheet does it in an effect keyed on `paneId` — the element to focus
  does not exist until the new level has rendered — landing on the pane's first
  enabled row going in and on the section row you came from coming back. It is not a
  touch-only nicety: `useIsMobile` is viewport-based, so any desktop window under
  768px reaches this shell with a physical keyboard. The first open is skipped; vaul's
  `autoFocus` owns that one, and the effect's `lastPane` ref is cleared alongside the
  pane so a stale pane from the previous opening cannot steal focus behind it.
- **The sheet's pane is `role="group"`, not `role="menu"` — item roles are shared,
  the container is not.** The ruling above (a row's role says what the row MEANS) is
  unchanged and still governs `roleOf()`. A `menu` CONTAINER is a different promise:
  roving tabindex, ArrowUp/Down, Home/End and typeahead, which Radix implements for
  the dropdown and this shell does not. Claiming it flips a screen reader into
  application mode, where the arrows it has just told the user to press do nothing;
  `group` keeps browse mode, where they work, and every row is a real button in the
  tab order. If roving focus ever lands here, it becomes `menu` again in the same
  commit.
- **A swipe-down cannot be simulated in jsdom.** vaul measures a drag through
  `getComputedStyle(el).transform`, which jsdom leaves undefined and `getTranslate`
  throws on. It is not unpinned: a swipe resolves through vaul's own `closeDrawer()`,
  the same controlled `onOpenChange(false)` that Escape and a backdrop tap take, and
  the close-path table in `tests/unit/display-menu.test.tsx` covers both of those.
- **A 44px sweep that walks only the root measures none of the radios.** The root
  draws sections, two checkboxes and Reset — no `menuitemradio` at all — so a sweep
  written against it stayed green with `SheetRow` mutated to `min-h-7` for exactly the
  rows a phone presses most: every Grouping / Ordering / Type value. The floor was
  genuinely met; the test just did not earn it. It walks all five panes now, and
  counts the radios it saw.
- **vaul's trigger opens on CLICK; Radix's `DropdownMenuTrigger` opens on
  POINTERDOWN.** The same gesture does not drive both, which is why
  `tests/unit/display-menu.test.tsx` carries two openers. Getting it wrong leaves the
  surface shut and every query beneath it failing for the wrong reason.
- **vaul holds its content through the exit transition and jsdom fires no
  `transitionend`, so a closed sheet never leaves the tree in a unit test.** Assert
  `data-state="closed"`, never absence — the same reading `tests/unit/mobile-dock.test.tsx`
  takes.
- **`useIsMobile` reports false until its first effect**, so a phone renders the
  pointer trigger for one frame. That costs nothing here only because both shells wrap
  the *same* trigger button — the mounts size it from outside (`mobile-header.tsx`
  grows the 24px icon trigger to its 30px row slot), so it must not change shape with
  the input device either.
- **44px is a floor with exactly two spellings, and a test enforces that.** Every
  pressable thing in the sheet carries `min-h-11` or `size-11` (the back affordance),
  asserted on the CLASS because jsdom lays nothing out. 44 rather than the mode
  sheet's 48 for the same reason this shell drills instead of flattening: the
  Project / Group pane is as long as the user's data.
- **The trigger itself is still the mount's business.** `mobile-header.tsx` draws it at
  30px inside a row of 30px slots, deliberately and with its own comment; growing it to
  44 is a header-layout decision, not this component's.

## Addendum (2026-08-26): the aspire axis — a goal FILTER and a goal grouping

Both group-by vocabularies gained **Goal**, and the Filter region gained a **Goal**
section. This is the first container filter since projects and habit groups, and the
first time anything outside the classify axis narrows a view — so it is worth stating
exactly what it does and does not borrow.

**It is a filter, unlike the gates, because the "deliberately not offered" rule was never
about many-to-many.** A routine filter is refused because the SCOPE RAIL already answers
"is this on today" per-date, through the DB, with a resume date; a client-side checkbox
would be a second, weaker answer to a question that already has one. Nothing anywhere
narrows a view to one goal, and a goal has no resume date, so that argument does not
transfer. What does transfer is the shape: a goal is many-to-many, so the clause UNIONS
the selected goals' members rather than choosing between them.

**Grouping is first-claim-wins, borrowed verbatim from `routineGroups`.** An item may
serve three goals; rendering it under each is two checkboxes for one obligation and a
second copy that shift-range and ⌘A skip. The row lands in the first ACTIVE goal that
claims it, in store order, and everything else falls into a trailing "No goal". A goal
section carries no `gate` — the header has no switch, because a goal switches nothing —
and the Schedule grid refuses to divide by it for the same reason it refuses routines and
programs: a lane cannot express insert-into-B versus move-to-B when membership is not a
partition. Focus-only, on every variant and width.

**Three decisions worth keeping:**

- **All three ROLES filter and group as members.** A role says what an item does FOR the
  goal, not whether it serves it; dropping milestones would hide exactly the checkpoints
  the goal is measured by. A milestone's `startDate` is its target date, so it appears on
  the day it is aimed at, and an undated one stays in the braindump — both are rows those
  surfaces already showed, now narrowed rather than moved.
- **The clause holds goal IDS, not refs.** `containerRef` is a NAME grammar for the
  classify axis; goal names are not unique and rename shipped with the feature. The
  registry already refuses goals a ref, so `filters.goals` is its own field and
  `passesContainerFilter` can never see a goal.
- **An unresolvable selection goes INERT, never empty.** A goal achieved (or deleted)
  while it was filtering resolves to `null` and narrows nothing, rather than blanking the
  surface with only a filter chip to explain it — the stale-container-ref failure
  `renameContainerRef` exists to prevent.

Membership lives in `goal_items`, so the pure predicate cannot ask an item row for it:
each surface resolves the selection ONCE (`goalFilterItemIds`) and hands the id set down,
the same bargain `inactiveItemIds` makes. One set serves all seven week columns, because
membership is dateless.

**The section is a `Section` in `filterSections`, which is what puts it on a phone.**
The addendum above made the menu's body DATA, and the touch sheet renders
`filterSections` and nothing else — so a Goal section written as inline `SubRow`/
`ValueRow` JSX would have existed on the desktop dropdown only, and a phone would have
had no goal filter at all. (Group-by Goal reached both shells for free, because it is
already data in `lib/view-options.ts`.) It carries `scroll: true` for the same reason
`container` does — its length is the user's own data — and its two footer strings are
`{kind:'note'}` entries rather than a bare `<div>`, because only Entries survive the
crossing.

**A selected goal ALWAYS has a row, whatever became of it.** The menu's own rule is
that hiding a row strands the clause: `activeFilterCount` keeps counting the id, and the
panel that set it has nothing to unset it with. A goal can leave the active list three
ways, and all three are answered by a row rather than by a store-side sweep:

| what happened | the row |
| --- | --- |
| achieved / abandoned while filtering | still in the store — listed by name, ticked |
| **deleted** — gone from the store entirely | an **"Unknown goal · not found"** row |
| the goals table never loaded (`goalsAvailable: false`) | the section renders anyway, on the selection alone |

Dropping the id inside `removeGoal` was the other candidate, following
`renameContainerRef`'s precedent. It loses on that precedent's own argument: the remap is
DRIVEN BY THE STORE because the call-site version had no inverse, and a delete-time sweep
has the mirror of that bug — undo restores the goal and the cleared clause does not come
back. It also cannot reach the third row above at all, since a table that never loaded
fires no delete to subscribe to. One untickable row answers all three and reverses
nothing.

## Addendum (2026-09-24): the braindump groups by Priority

`BraindumpGroupBy` gained **Priority**, placed after Project as on the canvas. It is the
same `groupRows` arm the canvas uses — High, Medium, Low, then "No priority" last, empty
levels omitted — so a habit, which carries no priority field, lands in "No priority"
rather than a section named after its type. The union is now a different vocabulary from
the canvas one rather than a smaller one: it has `type` and still lacks `bucket`.

## Addendum (2026-09-25): the braindump's Display shelf

**What it is.** A line of text inside the braindump header's grey capsule, under the white
pill, saying in words what the Display menu has set: "Grouped by …", "Sorted by …", the
priority values (the menu's dots; No priority is the hollow ring), the project values (the
menu's colour squares; No project is the ring), the goal values (lucide `Target`), and "Hide
finished" last. Values follow the menu's rows, never the order they were toggled in, and
that includes a goal id nothing answers to, which follows its "Unknown goal" row, after the
goals the store can name. A value with no row comes after those with one, in the order it
was stored: a string no Priority row offers, and for projects a deleted project, then a ref
of no project kind. No project is the exception, and stays last, where its row is. It is
there exactly when the trigger's lime dot is lit, in the sidebar and in the phone's
Braindump tab alike, so a braindump with nothing set keeps the bare capsule. Clicking the
text opens the Display menu; on a pointer the ✕ beside it resets (touch has no ✕ since
2026-09-26; see the canvas addendum). The dot says THAT the list is shaped and the shelf
says how, and one case makes it more than a convenience: a filter that matches nothing
leaves the list showing its "A clear head." empty-state poem, and the shelf is then the only
thing on screen that says why. The component is
[components/primitives/display-shelf.tsx](../../components/primitives/display-shelf.tsx). It
hangs in SurfaceHeader's `below` slot, which renders straight after the pill with no
wrapper, so a header that passes nothing (Beacon's) is unchanged and the pill stays the
capsule's first child.

**It sits IN FLOW.** The braindump's header stands over a scrolling list, which only starts
scrolling a line sooner. The canvas header stands over an hour grid that derives its row
height from the column's remaining height, so a shelf there re-scales every hour row as the
first setting goes on. That is why the canvas shipped without one; it has one now, with that
cost taken on purpose (see the next addendum).

**One line while everything fits, then a stack.** On one line the settings sit 16px apart
with no separators. When that does not fit, grouping and ordering share the first line, each
filter gets a line of its own, and Hide finished comes last, 5px apart. A multi-value
setting wraps only between its values; a single overlong value ellipsizes. Heights, for
checking by eye: one line makes the capsule 78px (6 + 37 pill + 8 + 18 + 3 + 6), each further
line of the stack adds 23px, and a wrap inside a setting adds 18px.

**Locked decisions:**

- **One derivation.** `useDisplaySummary(surface)` in
  [lib/display-summary.ts](../../lib/display-summary.ts) returns `{ activeCount, clauses }`,
  and the trigger's dot, its aria-label count and the shelf all read it. `activeCount > 0 ⇔
  clauses.length > 0` is an invariant of the model, so "visible exactly when the dot is lit"
  is structural, not two formulas that happen to agree. The model takes the EFFECTIVE
  group-by and the Goals gate, so a grouping or goal selection the switch is keeping is
  neither counted nor named. `clauseText` is the one spelling of each clause: the fit is keyed
  on it, and the tests read the screen against it.
- **The ✕ IS Reset display.** Both shells' Reset row and the ✕ call `resetDisplay(surface)`,
  so they cannot drift. With Goals off it keeps the stranded goal selection and the stored
  Goal grouping (off is lossless), and it never touches Show paused, which is app-wide. The
  ✕ moves focus to the trigger BEFORE it resets: a reset always takes the count to zero, so
  the shelf unmounts under the pressed button, and a focused element that unmounts leaves
  focus on `<body>`. On a pointer the ✕ wears the header's `RailTooltip` ("Reset display"),
  as every icon-only control in that header does, and never a native `title`, which would
  fire a second tooltip. On touch there is no ✕ at all (see the canvas addendum).
- **The text opens the menu through a handle, never a second trigger or lifted state.**
  `DisplayMenu` takes a React 19 `ref` prop exposing `open(from?)` and `focus()`. Radix keeps
  one trigger ref and one anchor per menu, so a second `DropdownMenuTrigger` would take both
  over (and duplicate `display-trigger-braindump`). Open state held by Braindump would
  re-render every row of its list on each open and close; held in a store it would outlive
  the menu, the armed-slot bug `useOpenConsole` exists to route around. The pointer shell
  opens through its local `menuOpen` state, because Radix's trigger opens on pointerdown and
  keys, never on click. The touch shell CLICKS vaul's own trigger, the sheet's one opening
  path, where vaul records the sheet as opened and the drilled pane resets, so a sheet opened
  from the shelf lands on the root however the last one closed. The dropdown stays anchored
  to the icon, so it opens where an icon-opened one does.
- **Focus goes back to whoever opened it.** `open(from)` takes a REF to the shelf's button,
  held by `DisplayShelf`, which stays mounted while its body comes and goes, and the menu
  reads it only as it closes. So both shells' close sends focus to whichever shelf is on
  screen by then: unticking the one priority takes the shelf away and ticking another brings
  a new one back, all while the menu stays open, and focus lands on the new one. With no
  shelf left, Radix sends focus to the trigger, which is what happens when a pick clears the
  last setting. An opening through the trigger itself clears the record, and so does a
  right- or ctrl-click outside, mirroring Radix's own rule that such a click leaves focus
  where it lands. The opening's clear is for a press on the trigger while the menu plays its
  exit, a close that has not reached its focus return yet. In Chromium that press also lands
  on the closing menu's outside-press listener, still armed, so the menu stays shut; with the
  clear, focus ends on the trigger just pressed, and without it, on the shelf. On the phone
  the overlay covers the trigger through the sheet's exit, so the sheet's clear is the same
  rule with no tap that reaches it.
- **Fit is imperative, and it is not state.** Whether the text fits changes on every frame
  of a sash drag, and React never hears about that: the column resizes through `--sidebar-w`
  precisely so the braindump does not re-render. So the shelf writes `data-fit` on its own
  root, React never renders the attribute, every stack rule keys off
  `group-data-[fit=stack]/shelf:`, and with no attribute the one-line layout applies. The
  one-line width is MEASURED: force `line`, then take the span from the first
  `[data-line]`'s left edge to the last one's right (not `scrollWidth`, which clamps to
  `clientWidth` whenever the content fits). That happens in a layout effect keyed on the
  FULL text, and again, per text, when `document.fonts.ready` settles: a new text can ask
  for a subset the page has not loaded (a Cyrillic goal name landing with the planner),
  which the layout effect measures in the fallback face. The sample below is drawn in the
  basic Latin face alone, so a face that loads for any other characters (another script, or
  accented Latin such as a Polish name) changes nothing it can hear. Keying on the full text
  rather than the clause labels is what re-fits when a value joins a multi-select that is
  already showing. A resize only COMPARES: a ResizeObserver on a zero-height probe
  (`absolute inset-x-0 top-0 h-0`, whose size is the root's width and never the fit's) has
  the cached width re-applied against the lines box in the frame after its delivery, never
  inside it (see the gotcha below). Its one exception is to measure once when the cached
  width is still 0, for a shelf that mounted where nothing was laid out. The same observer
  watches a SAMPLE: an invisible, out-of-flow, `whitespace-nowrap` span whose `::before`
  draws "Hide finished" in the shelf's own type with 1rem of left padding (on the
  pseudo-element, so the phrase adds no text to the page and the padding sits inside the box
  the observer reads). Its width answers to the font, to spacing and to the rem, never to
  the column or the fit, so a sample resize is the line changing size with its string
  unchanged: a WCAG 1.4.12 text-spacing override, text-only zoom, a minimum font size, a
  late font, or the browser's default font size, which leaves the 11px text alone and moves
  every rem-sized gap, priority dot and the ✕. That re-measures a frame later, outside the
  observer's delivery, in either fit and whatever else the delivery holds: a shelf stacks
  when an override widens its text and goes back to one line when it comes off, mid-drag or
  not. A drag never touches the sample, so it only ever compares. The first delivery carries
  the sample too, so a shelf that mounts laid out measures once more a frame later and finds
  the width it already had. A sample gone to 0 is the shelf being hidden, which has nothing
  to fit until the sample's return, itself a resize, measures it. The frame does nothing at
  all while the lines box is 0 wide: against 0 every line is too wide, so a fit there wrote
  the stack, and the shelf's return painted it for a frame before the next one put the line
  back (found in review, 2026-09-26). The first version watched the `[data-line]` spans and
  took a line resizing with no probe in the delivery for the text changing size. A review in
  Chromium found two holes in that: a stacked line stretches across the column, so the text
  changing size resized nothing there, and a change in a frame where the column also moved
  looked like a drag. The next review found one in the sample's first cut, a bare phrase:
  the browser's font-size setting moves the gaps and dots but not the 11px phrase, so it
  went unheard and the one line clipped its last glyphs. The rem of padding is that fix. The
  comparison allows one layout unit (1/64px) and no more: nothing on the one line truncates,
  so any overflow is a glyph cut off with no ellipsis, and neither side of the comparison
  depends on the fit, so there is no oscillation for a wider margin to damp.
- **The sidebar mount has a width floor, `SIDEBAR_MIN_WIDTH - 20` (260px)**, passed by the
  braindump as the shelf's `floor` prop (the primitive has none of its own). Collapse and
  hover-peek animate the column between `w-0` and its width over 300ms with the braindump
  still mounted. Without a floor, every frame of the fold would re-fit, and the collapsed
  shelf would sit in a one-value-per-row stack that every expand unfolds from. At rest the
  floor never binds: the column is never narrower than 280px, less the capsule's 10px sides.
  During the fold the column's own overflow clips. A shelf that is one line at rest still
  flips once mid-expand, which is accepted. The phone mount has no floor because it has no
  collapsing column.
- **Goals wear `Target`, in ink-2**, not the goal's colour. Goal colours can hash to lime
  `--accent-8`, and that would put a lime mark per goal on the resting surface.
- **Data glyphs may be lime at rest; the lime CHROME budget is unchanged.** The Low dot is
  `--priority-low` and a project square can be `--accent-8`. Both are data, as the list's
  priority bars and the menu's own squares already are, and the surface's lime chrome is
  still the trigger dot alone. Nothing in the shelf carries an opacity or a transition, and
  nothing between those glyphs and the section may fade them; a test walks up and checks.
- **The loaded gate.** A goal id that nothing answers to reads `…` until the planner's first
  load lands (`!!userId && !isLoading`), and "Unknown goal" only after that. "Unknown goal"
  reads as "gone", and before the load the store simply has not answered yet. The count is
  the same either way, so the dot and the shelf agree while it waits. A load that FAILED
  counts as landed, on purpose: the menu names the same id "Unknown goal" (its row for a
  goals table that could not be reached), and `…` would have the shelf disagree with the
  menu it opens for as long as the failure lasted.
- **The accessible name is the visible text** (WCAG 2.5.3, Label in Name), so an `aria-label`
  here would trip axe's `label-content-name-mismatch`. sr-only `"; "` and `", "` separators
  give the name its pauses. The nouns the glyphs stand for go in `aria-describedby` ("Display
  settings. Priority: High, Low. Project: Work, No project. …"). `aria-haspopup` comes from
  `useIsMobile()`, the hook DisplayMenu picks its shell with, and is `menu` or `dialog`. There
  is no `aria-expanded`, because what opens is modal and hides the section while it is up.
  There is also no live region and no heading.
- **The phone's text is a 28px target, through a `::before` hit area** (the header's
  existing idiom) on the BUTTON. The clipping `overflow-hidden` is on the lines box inside
  the opener, so it never cuts the reach off. (The phone's ✕ had one too, until touch lost
  its ✕.)

### Gotchas from the shelf

- **jsdom reports every width as 0, so the fit is always `line` there** (`0 > 0 + 1/64` is
  false). That is deterministic, and useless for testing a stack.
  `tests/unit/display-shelf.test.tsx` stubs `Element.prototype.getBoundingClientRect`, giving
  the lines box a chosen width and laying the `[data-line]` spans out in whichever fit the
  root holds as they are read (end to end on one line; stacked, each stretched across the
  box, as a column's children are, so a measure that forgot to force the one line reads the
  stack), and restores it after each case. It delivers the shelf's observer by hand, finding
  it by the probe it watches, because dnd-kit builds observers of its own around the
  braindump, and gives each entry the `contentRect.width` the shelf reads off the sample.
  A case that resizes the sample starts with `firstDelivery()`, the delivery a real
  observer makes at `observe()`, since that one asks for a frame of its own: a shelf that
  could re-measure only once would pass a case that skipped it.
- **The sample's classes are asserted EXACTLY.** A class that stretches it from `left-0`
  (`right-0`, `inset-x-0`, `w-full`) makes its width the column's, and then every frame of a
  drag resizes it and forces a one-line measure. A subset match would let one through.
- **The `typeof ResizeObserver === 'undefined'` guard is load-bearing.** jsdom has no
  ResizeObserver, and `tests/unit/braindump-grouping.test.tsx` mounts an ACTIVE braindump (a
  grouping is set, so the shelf renders) without stubbing one. Without the guard, all 11 of
  its tests throw `ReferenceError`. A shelf with no observer keeps the fit it measured.
- **Never read the handle in render.** `menu.current` is null on the first render and a
  commit behind after that. `react-hooks/refs` does not catch it: it flags `.current` on a
  `useRef` or on a prop named `…Ref`, and this prop is `menu`. Read it in handlers only.
- **A stacked multi-select must `shrink`.** A clause that keeps `shrink-0` in the stack holds
  its one-line width, so the values past the column's edge are clipped instead of wrapped.
  jsdom cannot lay this out, so the test asserts the classes, every one the stack lays out
  by: `flex-col` on the lines box, `shrink`/`min-w-0`/`flex-wrap` on each line and each
  multi-select, `min-w-0 max-w-full` on each value with `truncate` on its label, and
  `min-w-0 max-w-full truncate` on each single phrase.
- **Never write anything inside the observer's delivery, not even the fit.** Forcing the
  one-line layout there starts a measure, resize, measure loop. And a compare that flips the
  fit changes the shelf's height, which resizes what sits below it in the same delivery.
  Under the canvas header's pill that is the view's scroll viewport, which `useFitHourPx`
  (and, while the pointer is over it, Radix's scrollbar) observes at the probe's own depth,
  so the engine skips that observation and fires "ResizeObserver loop completed with
  undelivered notifications", which lands on every other observer on the page. The shelf's
  first version compared inside the delivery, which the sidebar never tripped; with the
  canvas mount, a Chromium review (2026-09-26) raised the error on every flip it forced in
  Day and Week × Schedule, and on each Week × List day-heading click that moved the
  capsule's width across a threshold. So the observer only notes what it heard, and the
  frame it asks for (one frame serves every delivery before it) measures if the sample
  resized and then compares, or, while the shelf is hidden, does nothing and keeps what was
  asked for. The cost is one frame in the old fit after a width change, in either direction:
  an unstack decided in the delivery to save that frame brings the error back on every
  widen.
- **`getByText('Priority')` is ambiguous**, because it is a sort label AND a group-by label.
  The tests query `[data-clause="…"]` instead.
- **jsdom's accessible-name computation trims each element's text.** So the space inside an
  sr-only separator does not survive it, and the computed name reads
  `Grouped by Project;High,Low;…`. The test lets those spaces be missing from the name and
  checks the separators' own text instead.
- **vaul keeps a closed sheet mounted in jsdom and leaves the page `aria-hidden`.** Steps after
  a close therefore go by test id and `data-state`, never by role. The sheet's focus return
  CAN be observed, though: Radix's Presence holds the closed content until an `animationend`
  naming its exit animation arrives, and jsdom computes vaul's (`slideToBottom`) from vaul's
  own stylesheet. Dispatch `animationend` with `animationName` set to
  `getComputedStyle(node).animationName`, wait for the node to unmount, and read
  `document.activeElement` a tick later (`finishExit` in the shelf test). A `<style>` that
  gives the dropdown's closed content an animation holds it mounted the same way, which is
  how a trigger reopening a menu mid-exit is tested.

**Manual QA states:** 406px and 280px sidebar and a 390px phone: one setting; everything on;
a 4+ value priority or project filter at 280px (wraps between values); a long project name
at 280px (ellipsizes); collapse and hover-peek with the shelf showing; open from the shelf and
Escape (focus back on the shelf); a text-spacing bookmarklet or text-only zoom applied with the
shelf on one line (it stacks rather than clip), then taken off (it goes back to one line);
the browser's default font size (Chrome: Settings, Appearance, Font size) raised with the shelf
on one line and a little room to spare (it stacks), then put back (one line).

## Addendum (2026-09-26): the canvas's Display shelf

**What it is.** The braindump's shelf, now in the canvas header too, on both shells. Kirby
asked for it on 2026-09-25 ("can we also add these active filters rail to the body header
too"). On the desktop it is the HeaderCapsule's third row, under the view pill, as the
braindump's sits under its own; on the phone it is the last thing in the Today card, after
the week strip and the review notice. It is the same component reading the same summary for
`surface="canvas"`, so it shows exactly when the canvas trigger's dot is lit, its text opens
the canvas menu through the same handle, and on a pointer its ✕ is the canvas's Reset
display. Nothing in it is canvas-specific except the one clause only the canvas has, the
type filter.

**No ✕ on touch, on either surface.** A touch mount (the phone's Today card, and the
Braindump tab, which had one from 2026-09-25) draws the text alone, and its reach runs the
whole row. The repo's rule for the dock's notices (`components/sidebar/dock-notices.tsx`) is
that a destructive target pressed up against a full-width tap target is a mis-tap generator
with no hover to tell them apart, and this ✕ sat 2px from the text's reach and wiped every
Display setting on the surface with nothing to undo it. The sheet the text opens has Reset
display, with its count, on its root pane: one tap further, the way each notice's tray
carries its own dismissal.

**Where, and what was weighed.** Three placements were rendered in the real header and put
to Kirby on a card: under the pill (built), beside the pill in the header row's bottom band,
and across the header as a full-width line under the row. Beside the pill costs no height on
a wide window but has no room once the item panel is docked, where it would have to fall
under the pill anyway. Across the header puts the ✕ at the far right, away from the menu it
resets. Under the pill won on parity with the braindump and on holding up at every width:
`<main>` animates its width with the sidebar and the item panel, and the capsule never does.

**Containment is load-bearing on the desktop.** The capsule is `inline-flex flex-col`, sized
by its content, and the shelf's fit needs its width to come from outside (see "Fit is
imperative" above). So the capsule's mount passes `contain-inline-size`, and the shelf adds
no inline size: the capsule stays exactly as wide as its date row or its pill, and the shelf
takes that. Without it, in Chromium, the capsule grew to the shelf's one line (382 to 793px
with every setting on) and the shelf never stacked. The phone card is stretched to the
screen, so it needs none. Each mount's insets come in through `className`, merged over the
root's with `cn`. The capsule's `px-4 pr-3.5 pt-1 pb-px` put the text under the Layout icon
and the ✕ under the Zen leaf (the pill insets the leaf 14px, not 16), 8px under the pill and
9px above the capsule's edge; the phone's `px-0 pt-0 pb-px` put the text on the date's edge.
`floor` is the sidebar's alone: the capsule never animates, so every width it takes is one
it rests at.

**The height it costs, taken on purpose.** The header row was a constant 135px, and the grid
under it (`lib/use-fit-hour-px.ts`) sizes Day and Week × Schedule's hour rows, and the
phone's DaySchedule's, to the height left. The shelf is in flow, so while anything is set
the row grows 27px for the shelf's one line and 23px for each line its stack adds (162, 185,
231 and 277px for 1, 2, 4 and 6 lines), and the rows re-fit as it comes, goes, or stacks.
One line is the usual case for one or two settings; with a type and two more, List and Day ×
Buckets often stack (see "Words" below). With every kind of setting on at once (six lines),
measured in Chromium on one sample day (the hour rows fit the span of the day's timed items,
so the px/h and overflow figures are that day's, and another day's differ; the header, card
and viewport heights do not): 1366×768 Week × Schedule's overflow goes from 101 to 243px
(Week × Schedule is already at the 40px/h floor on most laptops, so every line is scroll);
1440×900 Day × Schedule goes from 42 to 40px/h with one line; a 390×844 phone's card goes
from 106.5 to 248.5px and its hour rows from 53 to 40px/h; at 375×667 the day's viewport
goes from 463 to 321px, and with the keyboard up (375×407) from 203 to 61px. Those are
full-screen viewports; in a real laptop window, where the browser takes 90 to 160px, Day ×
Schedule is often already at the floor with nothing set (1280×610: the viewport goes from
449 to 422px with one line, and to 307px with six), so there every line is scroll on Day
too. There is no cap. A "+N" would break the shelf's one promise, that it names exactly what
the dot counts; if the stack proves too tall on the canvas, a cap or a wrapping fit for this
mount is the lever. `desktop-shell.tsx` records the shelf as the one thing in the header row
allowed to grow it.

**When it moves on its own.** The shelf flips between one line and the stack whenever the
capsule's width changes, and in List (and, by under 4px, Day × Buckets) that width follows
the date: a long off-today date with its Today button can outgrow the pill (Day × List 349
to 378px, the widest being "Wednesday, September 30"). So a shelf whose one line falls in
that band flips as you page dates or click Week × List's day headings, and the list moves
23px for each line its stack adds (46px for a three-line stack, 69 for four). In Schedule
the pill is always the widest row (by 4.1px at default fonts), and in Week × Buckets too, so
paging never flips it there. Accepted; the lever is a date button with the widest date's
min-width and a Today slot kept reserved, which would rest the capsule at about 378px in
List.

**Never write inside the observer's delivery.** The canvas mount is what surfaced the
gotcha above ("Never write anything inside the observer's delivery", under Gotchas from the
shelf): a flip decided inside the observer's delivery resized the grid's viewport in
that same delivery and raised the "ResizeObserver loop" error. The fit now waits a frame.

**Words.** The type clause reads "Showing Tasks" / "Showing Habits": the menu's own row (its
Type section says All, Tasks, Habits), led by a muted "Showing" as grouping is by "Grouped
by", and "Show" is the palette's name for the setting. The words cost width: "Showing Tasks"
is 78.4px against "Hide habits"' 59.2, and "Showing Habits" 81.4 against "Hide tasks"' 55.2,
so more states stack. Of the 84 states with a type set (both types, seven groupings, three
sorts, Hide finished on and off), measured with today's date on screen (Saturday, September
26, so no Today button), the ones that fit on one line fall from 38 to 24 in Day × List, 47 to 33 in Week × List, 56 to 40 in Day ×
Buckets, 58 to 48 in Day × Schedule, 58 to 52 in Week × Buckets and 60 to 56 in Week ×
Schedule, and none goes the other way. The capsule is as wide as the wider of its date row
and its view pill, and on today's date, which has no Today button, the pill always sets it,
as it does on most other dates. On the widest dates (Wednesday, September 30 with its Today
button, a 362px row), List and Day × Buckets all fit 57 before and 43 after; a row that
outgrows only Day × List's pill moves only that count, and by less (Monday, September 28:
28). The Schedule and Week × Buckets counts do not move with the date. "Grouped by Project ·
Showing Tasks · Hide finished" stacks three lines in Day × List on today's date (September
26), 2px over its one line, where "Hide habits" fit; the list starts 46px lower, and paging
to a wider date, or seeing September 26 from another day, puts it back on one line. A bare "Tasks"
beside "Grouped by Project" read as a group or a project name. "Tasks only" would be false
(Tasks keeps every task-like item, custom types included) and Settings already uses "Tasks
only — habits always stay" for something else. "Hide habits" was tried and dropped: the menu
the text opens has no row by that name to undo it under. The shelf names what is SET, never
what reaches the view: a sort outside List, or grouping by Time bucket on Buckets, is named
like any other setting, as the dot counts it. Notes saying so ("Sorted by Priority · List
only") were designed and dropped, and what a later version must get right closes this
addendum. Never named, as on the braindump: Show paused (app-wide, and the menu captions its
row so) and the palette's Hide completed tasks (a planner setting, not a Display one).
Palette commands change the named settings with no menu open, and the shelf follows them;
"Clear canvas filters" clears the filters only, so any grouping, ordering or type stays
named.

**Accepted, not fixed:**

- Two buttons named "Reset display" when both shelves are up, as the two "Display (N active)"
  triggers already were. Naming each surface in all three controls is one change for later.
- The ✕ is `text-muted-foreground` like every icon control in the capsule (2.65:1 on its
  ground in light mode), and wears the braindump header's label-only `RailTooltip`, while the
  capsule's own Zen tooltip is the plain one. A token change would restyle every icon control.
- The ✕ cannot be undone: Ctrl+Z is the planner's undo and never reaches view settings, the
  same as the menu's Reset row. It sits 14px under Zen.
- With the item panel docked, `<main>` can be narrower than the header row, and it clips the
  row's right end. How far depends on scope, layout and the sidebar's width. With the
  default sidebar, Zen is clipped up to 1275px windows in Day × Schedule, 1286 in Week ×
  Schedule and 1278 in Week × Buckets (the ✕ up to 1267, 1278 and 1270), WeekScale's
  controls up to 1488 (1480 in Buckets), and the Display trigger up to 1234 in Day ×
  Schedule and 1245 in Week × Schedule. With the sidebar at its widest, 720px, a 1440 window
  leaves `<main>` 252px, and the Display trigger is past the edge there too. A pointer
  cannot reach what is clipped; the text still opens the menu.
- The keyboard can. `<main>` stays `overflow-hidden`, which is still a scroll container, so Tab
  onto a clipped control scrolls it into view. Nothing ever scrolled it back, so the canvas
  stayed slid, about 38 to 242px at the default sidebar and 269 at 720px, until the panel
  closed, unless a later Tab happened to reveal something at the other end (in Week × Schedule
  the grid's first stop often did). `useFocusOnlyScroll` (`hooks/use-focus-only-scroll.ts`) now
  places `<main>` for whatever has focus, a frame after focus moves anywhere, a key goes down
  in `<main>`, `<main>` scrolls or resizes, or the focused control starts or stops showing
  entirely or at all. An IntersectionObserver at thresholds 0 and 1 hears that when nothing
  else fires. Its thresholds are exact, so it does not hear a move from cut to cut, including
  one from the half pixel a control at rest may overhang; that waits for the next key, focus
  move, scroll or resize. `<main>` goes to rest when focus leaves it for the sidebar, the item
  panel or nothing, and when the focused control shows there, unless it holds (below).
  Otherwise it moves only when it must, because Radix closes a tooltip on any scroll around its
  trigger and a tooltip is all the name Zen and the ✕ show. A control out of sight comes in to
  the least slide that shows it whole. So does whatever has focus when `<main>`'s width
  changes: the item panel docks a frame at a time, and a slide kept from an earlier frame left
  the focused ✕ a quarter showing once it had docked. So does a control the layout moves, once
  the move leaves it cut. Otherwise one that shows, whole or cut part-way, keeps the slide the
  hook last made, so Tab from Zen to the ✕ moves nothing and "Reset display" stays up (but see
  the bands below). A slide the hook did not make comes back as far as that least one: Chromium
  centres what it reveals (Zen slid Week 212px at 1240, where 47 shows it).
- The least slide is rounded up to whole pixels, so it shows its control to the last fraction,
  and the observer hears a later cut. An earlier version rounded to within half a pixel, which
  the observer counts as cut, so a view switch that cut the control further went unheard: Zen,
  placed 99.1% showing in Day × Buckets at 1240, was left 44% showing after store switches to
  Week × Buckets and then Week × Schedule. A control that overhangs `<main>`'s edge by half a
  pixel or less still counts as showing at rest. Rounding up can leave up to a pixel of the
  control after it showing, so a control that shows a pixel or less counts as out of sight.
  Without that, Tab from the program line onto the review notice in Day × Buckets kept the
  program line's slide and showed 0.7px of the notice's button (1200 and 1240 at the default
  sidebar, 1320 at 560, 1440 at 720).
- A control the layout moves while it still shows whole, at a slide the hook made, holds that
  slide for as long as it keeps focus and shows whole, even where it would show at rest.
  Earlier versions placed it afresh on every move, and then Enter on Next at the 720px sidebar
  slid the whole canvas on every press, because the date beside it changes width (135px over
  eight days in Day at 1440), and an arrow on WeekScale's thumb moved the canvas back and forth
  as it stepped, where Chromium alone never moves it: 102px a step in Week × Schedule up to
  about 1360, between two slides (40 and 142px at 1320), then between rest and a slide, 101px
  at 1361, 22 at 1440 and 2 at 1460, and not at all from 1462, where the thumb is no longer
  clipped. Only a slide the hook made is held. One the browser made is placed afresh: the
  reveal when a menu hands focus back to a control a pick in it moved, or the pull back when a
  switch to List leaves the canvas too short for the slide (Week × List at 1240 goes to 5, as
  it did before the hold; a draft of the hold that also kept slides the browser made held the
  browser's 27).
- The hold costs canvas: by the time focus moves on, the slide it keeps can be more than the
  control needs. Under a focused ✕, a switch from Week to Day × Schedule keeps 11px more than
  Day needs, a layout switch alone 8 (Week × Schedule to Buckets), and a scope switch and then
  a layout switch up to 18, the same at 1200 and 1240 with the default sidebar, 1320 with 560
  and 1440 with 720. While Next keeps focus, the canvas stays at the widest slide a date has
  needed: in Day at 1440 with the 720px sidebar, 82px from Wednesday, September 30 on, where
  Friday, October 2 needs 15; at 1300 with the 560px sidebar, 62, where Friday, October 2 needs
  none; in Week, at most 28 more than a date needs. WeekScale's thumb, after Home at 1340,
  keeps 123 where it needs 21, and at 1440 keeps 23 where it shows at rest. Chromium alone
  keeps its centring slide throughout, 108 to 208px.
- A click holds nothing. After a Tab slide onto Next, a click on it pages the date and the
  date's width moves Next. Holding the slide there let Go to today move under the pointer: an
  earlier version paged five days in Day at the 720px sidebar and then the sixth click landed
  on Go to today, which put the date back and `<main>` at rest, and in Week the second click
  undid the first. A button a click moves is placed afresh instead, which keeps it at
  `<main>`'s edge, under the pointer, so eight clicks page eight days, or eight weeks. Chromium
  alone pages four days and then opens the calendar, and in Week alternates Next and Go to
  today. A click counts until a key goes down in `<main>`, so Enter on Next still holds. A
  dragged thumb is not a button, and still holds: a variant that let go for every pointer move
  jumped the canvas on the release (62px to 0 at 1400, 122 to 20 at 1340) and back on the next
  arrow.
- Focus moving on from a held slide places the next control afresh if that slide cuts it,
  because the slide was held for the control focus left. After paging with Enter on Next, Tab
  onto Go to today showed as little as 3.6% of it under an earlier version, where Chromium
  alone showed it whole; it now shows whole in all 32 cases tried (Day and Week, 1440 with the
  720px sidebar and 1300 with 560, after one to eight presses). The same goes for Zen after
  scope switches moved a focused Display trigger, and that reveal closes Zen's tooltip.
- Chromium scrolls only for a control that is wholly hidden, so one cut part-way keeps the part
  it shows, as it did before, unless that is a pixel or less: the ✕ 19% of itself in Week at
  1265 (with its tooltip), the Display trigger 66% in Day at 1200. The hook's smaller slides
  add one: in Week, Shift+Tab back from the ✕ leaves Zen 76 to 78% showing, since the ✕'s least
  slide is 8px short of Zen's, where the browser's centring slide showed Zen whole. The shelf
  text keeps the slide of whatever stop came before it: Zen's on Tab, and on Shift+Tab the ✕'s,
  which is itself the slide of a notice after it when one is in the row. When the text is wider
  than `<main>` (the 720px sidebar) and no notice is in the row, it shows 67 to 71% of itself
  in Schedule and Buckets and 75 to 78% in List, cut at its start. With a notice in the row, in
  Day, it is cut at the default and 560px sidebars too, and most with the review notice, whose
  slide shows its icon, "Start" and ✕: in Day × Schedule, 58% with the program line and 38%
  with the review notice at 1440 with the 720px sidebar, and 81 to 94% and 62 to 75% at 1200 to
  1240 with the default one; walking back from the review notice past the program line, 34 to
  38% at 1440 with 720 (Chromium alone shows 35 to 39% there), 47% at 1320 with 560, and 58 to
  71% at 1200 to 1240.
- A reveal is itself a scroll, so Zen's tooltip closes on the Tab that reveals it, and the ✕'s
  on the Shift+Tab that reveals it from the grid. The hook's own moves close more. The ✕'s
  closes on Shift+Tab from the stop after it, when that stop needed a slide and the ✕ shows at
  rest: WeekScale's Narrower in Week × Schedule (1190 with a 280px sidebar, or 1310 with the
  default one), and in Day the program line or the review notice, in the same bands for either
  (at the default sidebar, Day × Schedule about 1268 to 1302, Day × List 1236 to 1268, Day ×
  Buckets 1260 to 1294). Just below those bands the ✕ is cut at rest, so it keeps the notice's
  slide and its tooltip stays up. Zen's closes on the Tab from the Display trigger at the 720px
  sidebar, where Chromium's centring slide for the trigger already showed Zen and the hook's
  least slide does not. And the ✕'s closes when a scope or layout switch leaves it cut and it
  is placed afresh. Tab from Zen to the ✕ keeps "Reset display" up at the QA widths, but not in
  a band of 9 or 10px of window just below where the ✕ starts to show at rest (default sidebar:
  Day × Schedule 1244 to 1252, Week × Schedule 1254 to 1263, Week × Buckets 1246 to 1255, Day ×
  List 1211 to 1219, Week × List 1221 to 1229, Day × Buckets 1236 to 1245). There Zen shows
  part-way at rest, so no slide was made, or the shelf text between them shows at rest and
  sends `<main>` back, and the ✕'s own reveal closes its tooltip. Without the hook it closed
  there too, in 8px of each band. The hook adds the lowest pixel in Week × Schedule, Week ×
  Buckets and Day × Buckets, where the text sends `<main>` back, and the highest in all six, where the
  ✕ shows a pixel or less at rest, which Chromium leaves alone and the hook brings in whole.
- It also holds still, whatever has focus, in four cases. While a pointer is down, found in
  review: a press moves focus on mousedown, and the first version slid `<main>` back before the
  release, so the click was lost (Next, a block's Mark complete) and a drag ran offset by the
  whole slide. While focus is in a layer outside the shell, such as a menu or the calendar,
  most often drawn against its control in `<main>`: Radix hands focus back with a plain
  `focus()`, which finds the control still showing. A menu drawn against a sidebar control,
  such as the braindump's Display menu, holds `<main>` too, which is harmless: Escape hands
  focus back to the sidebar and `<main>` goes to rest. Review found that focus going on from
  such a layer to the sidebar, or to nothing, never passes through `<main>`, so the focus
  listeners are on the document. The calendar is the exception: after Escape it drops focus to
  nothing while it fades out, and only then hands it back, so a canvas that was slid when it
  opened comes back at once, and the fading calendar moves with it. And while an ancestor of
  `<main>` is inert, which only Zen's switch does as it lifts the planner away: focus drops to
  nothing 130 to 220ms in, and an earlier version went to rest there, jumping the whole visible
  planner 36 to 150px sideways under the wave. If the switch is turned back mid-wave, `<main>`
  stays slid until the next key, focus move, scroll or resize (47px in Week × Schedule at
  1240). `<main>`'s own inert, under the overlaid item panel, does not count. And at rest, with
  nothing past either edge, there is nothing to do. Nothing is noted there but `<main>`'s
  width, so a control the layout moved back to a spot cut part-way after a spell at rest would
  stay as the browser leaves it; nothing in the shell does that today.
- Review first made `<main>` `overflow-clip min-w-0` to stop the slide, and that was reverted:
  a clip box never scrolls, so Tab landed on controls nobody could see, the ✕ among them, which
  resets every canvas Display setting. `tests/unit/desktop-main-scroll.test.tsx` pins the class
  and the hook together.
- Two notices share the row, and with the panel docked both buttons are squeezed below what
  they paint: the program line's (a paused program hiding items today) to 0px, where it still
  paints its Moon icon and its focus ring, and the review notice's ("Today's review is
  waiting") to its 16px of padding, where it paints its icon and "Start" past its box. The hook
  measures what a control paints past its box, unless it clips it, and slides that into view:
  the Moon at 74px in Day × Schedule at 1240, and the review notice's icon, "Start" and ✕ at
  135 (without the program line). Review caught earlier versions of the hook sending `<main>`
  to rest for the program line, which left its icon wholly past the edge, and sliding the
  review notice's 16px box into view and no more, which showed 57% of its icon and none of
  "Start"; Chromium alone showed both. The program line's text still never shows. That is older
  than this change (13aa588 does the same); a floor it cannot shrink below, or leaving the row
  when there is no room, would fix it.
- The least slide puts a control's edge within a pixel of `<main>`'s, and Chromium draws the
  focus ring 1px inside the box and 2px outside it, so on that side up to two of the ring's
  three pixels are cut. Room for the ring would have to be added only when a slide is made: a
  control flush with `<main>`'s edge at rest must still count as showing there.
- The phone skeleton is the card at rest (106.5px, which the skeleton rounds to 106); a
  first paint with the shelf or the review notice up grows the card downward by that much.

**Deferred: reach notes.** If the shelf is ever to say that a setting reaches nothing in the
current layout (a sort outside List, `sortByBlockedBy`; a grouping `groupBySupport` answers
`honoured: false` for), the reviews of 2026-09-26 settled how:

- The note is PART OF `clauseText`, so the fit key, the visible text and the test oracle stay
  one string. Rendered but left out, a layout switch changes the line's width with no
  re-measure, and the one line clipped its last clause (reproduced in Chromium on both shells).
- The layout reaches the hook as a plain value (`isCanvas ? s.layout : null`), never as a
  selected `groupBySupport(...)` result: three of its arms return fresh objects, and selecting
  one looped React on Buckets with the bucket grouping. Pin that `honoured` does not depend on
  scope, since the phone's stored scope can be stale.
- Say it to a screen reader as an aside: an `aria-hidden` " · " with an sr-only ", " in its
  place, and a sentence in the description. Draw it in the value's ink, not muted, which is
  2.65:1 on the capsule in light mode. A priority filter or sort while showing Habits
  reaches nothing either, and is the third case.
- Partial reach ("Untimed rows only", "Anytime only") stays the menu's to explain.

**Manual QA states:** 1440×900 and 1366×768, Day and Week × Schedule, List and Buckets: one
setting; everything on (six lines); page dates in Day × List and click Week × List's headings
with a shelf near its threshold, with a window `error` listener attached (no "ResizeObserver
loop"); the item panel docked at 1280 and 1200px, and Tab and Shift+Tab through the header
there (each control shows while it has focus, whole unless the edge cuts it part-way; the ✕'s
tooltip stays up on Tab from Zen; the canvas is back at rest once focus moves into the
schedule, and a click on Next while it is slid moves the date); open an item while the ✕ has
focus (it stays whole as the panel docks); with the 720px sidebar in Day, page dates with Enter
on Next (the canvas moves only when a wider date would cut Next, and does not come back while
Next has focus: from Saturday, September 26, once in eight presses, onto Wednesday, September
30, at 1440 and at 1366), then Tab onto Go to today (it shows whole), and after a Tab slide
onto Next, click it eight times at one spot (it pages eight days); at 1440 with the default
sidebar, press the arrows on WeekScale's thumb in Week × Schedule (at most one 23px slide, on
the Tab or on the first step that reaches 2 days, then none); with a paused program hiding
items today, Tab onto the program line at 1240 (its Moon shows); with today's review waiting,
Tab onto its notice at 1200 (its icon, "Start" and ✕ show); Enter on Zen while the canvas is
slid (the planner does not jump sideways as the switch lifts it away); open from the shelf and
Escape (focus back on the text); ✕ with the keyboard (focus lands on the Display trigger). A
390×844 phone: the same settings, the review notice owed and not, the sheet opened from the
text, and Reset display from the sheet (focus lands on the Display icon).

## Related

`unified-items.md` (the registry this extends), `organize-console.md` (shares Phase B),
`overlap-blocks.md` (the pass lanes nest into), `programs-routines.md` (durable hiding, and
the scope-rail retirement that moved these switches here).
