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

*Superseded 2026-10-01, in part: the line is a paragraph that wraps, and the ✕ at the end is
Reset display's ↺, drawn from four ✕s (see "the shelf as one paragraph" below).*
**What it is.** A line of text inside the braindump header's grey capsule, under the white
pill, saying in words what the Display menu has set: "Grouped by …", "Sorted by …", the
priority values (the menu's dots; No priority is the hollow ring), the project values (the
menu's colour squares; No project is the ring), the goal values (lucide `Target`), and
"Hide finished" last. Values follow the menu's rows, never the order they were toggled in,
and that includes a goal id nothing answers to, which follows its "Unknown goal" row, after
the goals the store can name. A value with no row comes after those with one, in the order it
was stored: a string no Priority row offers, and for projects a deleted project, then a ref of
no project kind. No project is the exception, and stays last, where its row is. It is
there exactly when the trigger's lime dot is lit, in the sidebar and in
the phone's Braindump tab alike, so a braindump with nothing set keeps the bare capsule.
Clicking the text opens the Display menu. Every setting and every value wears a ✕ of its own
that takes just that one off (added 2026-09-26, below), and the ✕ at the end resets them all. The dot says THAT the list
is shaped and the shelf says how, and one case makes it more than a convenience: a filter
that matches nothing leaves the list showing its "A clear head." empty-state poem, and the
shelf is then the only thing on screen that says why. The component is
[components/primitives/display-shelf.tsx](../../components/primitives/display-shelf.tsx). It
hangs in SurfaceHeader's `below` slot, which renders straight after the pill with no
wrapper, so a header that passes nothing (Beacon's) is unchanged and the pill stays the
capsule's first child.

**It sits IN FLOW.** The braindump's header stands over a scrolling list, which only starts
scrolling a line sooner. The canvas header stands over an hour grid that derives its row
height from the column's remaining height, so a shelf there re-scales every hour row as the
first setting goes on. That is why the canvas shipped without one; it has one now, with that
cost taken on purpose (see the next addendum).

*Superseded 2026-10-01: the shelf is one paragraph that wraps between settings, with no fit
and no stack, and a wrap inside a filter costs 23px like any line; its spacings and heights are
in "the shelf as one paragraph" below.*
**One line while everything fits, then a stack.** On one line the settings sit 16px apart
with no separators. When that does not fit, grouping and ordering share the first line, each
filter gets a line of its own, and Hide finished comes last, 5px apart. A multi-value
setting wraps only between its values; a single overlong value ellipsizes. Heights, for
checking by eye: one line makes the capsule 78px (6 + 37 pill + 8 + 18 + 3 + 6), each further
line of the stack adds 23px, and a wrap inside a setting adds 18px.

**Locked decisions:**

- *Superseded 2026-10-01, the last sentence: there is no fit to key on `clauseText`; it is still
  the opener's name and the tests' oracle.*
  **One derivation.** `useDisplaySummary(surface)` in
  [lib/display-summary.ts](../../lib/display-summary.ts) returns `{ activeCount, clauses }`,
  and the trigger's dot, its aria-label count and the shelf all read it. `activeCount > 0 ⇔
  clauses.length > 0` is an invariant of the model, so "visible exactly when the dot is lit"
  is structural, not two formulas that happen to agree. The model takes the EFFECTIVE
  group-by and the Goals gate, so a grouping or goal selection the switch is keeping is
  neither counted nor named. `clauseText` is the one spelling of each clause: the fit is keyed
  on it, and the tests read the screen against it.
- *Superseded 2026-10-01, in part: Reset is still `resetDisplay(surface)`, still sends focus
  to the trigger first, and still wears its tip on a pointer and none on the phone, but it is
  the menu row's ↺ now, at the end of the last line, and it shows from four ✕s, not two.*
  **The end ✕ IS Reset display.** Both shells' Reset row and the ✕ at the end of the shelf
  call `resetDisplay(surface)`, so they cannot drift. It shows only while the settings wear
  more than one ✕ between them: with one, it would be that setting's ✕ twice. With Goals off it keeps the stranded goal selection and the stored
  Goal grouping (off is lossless), and it never touches Show paused, which is app-wide. The
  ✕ moves focus to the trigger BEFORE it resets: a reset always takes the count to zero, so
  the shelf unmounts under the pressed button, and a focused element that unmounts leaves
  focus on `<body>`. On a pointer the ✕ wears the header's `RailTooltip` ("Reset display"),
  as every icon-only control in that header does, and never a native `title`, which would
  fire a second tooltip; on the phone it has none.
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
- *Superseded 2026-10-01: there is no fit. The paragraph wraps by CSS, so nothing is measured,
  observed or written behind React's back; what this cost and why it went are in "the shelf as
  one paragraph" below.*
  **Fit is imperative, and it is not state.** Whether the text fits changes on every frame
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
- *Superseded 2026-10-01, in part: the floor stays, for the same fold, but what it spares now
  is the paragraph re-wrapping all the way down to `w-0`, growing taller as the column closes,
  and the collapsed shelf sitting one value to a line. There is no fit: a shelf re-wraps a line
  at a time as the column closes down to the floor and again as it opens, where the fit flipped
  a one-line shelf once; at the 280px minimum the floor is the rest width and nothing moves.*
  **The sidebar mount has a width floor, `SIDEBAR_MIN_WIDTH - 20` (260px)**, passed by the
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
  here would trip axe's `label-content-name-mismatch`. Since the per-setting ✕s, the opener
  holds an sr-only copy of that text (`clauseText` joined with `"; "`, values with `", "`)
  and the words on screen are aria-hidden; see below. The nouns the glyphs stand for go in
  `aria-describedby` ("Display settings. Priority: High, Low. Project: Work, No project. …"),
  from a `hidden` node now that each value's ✕ says its noun in the reading order. `aria-haspopup` comes from
  `useIsMobile()`, the hook DisplayMenu picks its shell with, and is `menu` or `dialog`. There
  is no `aria-expanded`, because what opens is modal and hides the section while it is up.
  There is also no live region and no heading.
- **The phone's targets are 28px, through a `::before` hit area** (the header's existing
  idiom) on the BUTTONS: the opener's and the reset ✕'s. A per-setting ✕ is 25 × 28px, see
  below.

### Addendum (2026-09-26): a ✕ for each setting

*Superseded 2026-10-01, in part: on a pointer each ✕ is drawn only while its setting is under
the pointer, and the end ✕ is Reset display's ↺ at the end of the last line, from four ✕s.*
Each grouping, ordering and Hide finished phrase, and each priority, project and goal VALUE,
now carries a small ✕ after it that takes off that one thing. The end ✕ still resets them all.

- **One function, in the model.** The ✕ calls `removeDisplaySetting(surface, removal)` in
  `lib/display-summary.ts`, next to `resetDisplay`, through the same setters (so the canvas
  mirrors hold). A multi-select value is removed by its `DisplayValue.key` through the pure
  `withoutDisplayValue`, which takes off EVERY stored entry the value stands for: duplicates
  collapse into one drawn value, so removing only the spelling in the key would leave the
  twin, and the value, on the shelf. Projects compare folded (`sameContainerRef`, as the menu's
  tick does); a ref of no classify kind, the unset key, priorities and goals compare exactly,
  as they are deduped. `display-summary.test.ts` removes every drawn thing in every case of
  the matrix and checks that exactly that one disappears. The Goals gate needs no handling
  here, because no ✕ is drawn for a goal clause or a Goal grouping while Goals is off.
- *Superseded 2026-10-01, in part: each phrase and value takes the pointer itself now and opens
  the menu through the same handle, so only the gaps fall through to the opener; a setting's
  words light on their own (`group/unit`), so there is no `peer/open` to keep beside them; and
  the paragraph does not clip.*
  **The opener sits UNDER the words.** A button cannot hold buttons, so the opener is an
  `absolute inset-0` button behind the lines box. The lines box is `relative` (so it paints
  above) and `pointer-events-none` (so a click on the words falls through to the opener); the
  ✕s are `pointer-events-auto`. The opener's name is its own sr-only copy of the text, and the
  words on screen are aria-hidden, so a screen reader meets the opener once and then the ✕s,
  each named `Remove <phrase>` or `Remove <Noun>: <value>`. The opener is the `peer/open` the
  words' hover colour reads, so it must stay the lines box's previous sibling. It sits outside
  the clipping lines box so its focus ring is not cut off. `openerRef`, `open(from)` and the
  focus return on close are unchanged.
- *Superseded 2026-10-01, the last sentence: the ✕ is px now, like every spacing around it, and
  there is no sample or fit. On a pointer it hangs in the gap after its setting.*
  **A ✕ belongs to its setting.** The ✕ sits inside the clause span or value span, after the
  label, and never shrinks, so a phrase ellipsizes before its ✕ and a value never wraps away
  from its own. It is rem-sized, like the gaps and dots, so the sample's rem already accounts
  for it in the fit.
- *Superseded 2026-10-01, in part: Reset leaves once fewer than four ✕s are left, not with the
  second-to-last setting; focus still never goes to it.*
  **Focus moves on first, as the reset's does.** The pressed ✕ unmounts, so before removing
  anything, focus goes to the next per-setting ✕, or the previous one if this was the last, or
  the trigger if nothing is left. It never goes to the reset ✕, which leaves with the
  second-to-last setting. Every other ✕ survives because each is keyed by what it names. A
  repeated (held) Enter is cancelled on keydown; otherwise autorepeat would walk the focus
  from ✕ to ✕ and clear the shelf.
- *Superseded 2026-10-01, the last two sentences: the paragraph does not clip, so the
  `py-[5px]`/`-my-[5px]` pair and the cost of a ✕ flush against the clip are gone. The reach is
  unchanged, and a coarse pointer on the desktop shell takes it too.*
  **Phone reach: 25 × 28px, lopsided on purpose.** The reach is 7px to the right but only 4px
  to the left, which is the gap to its own words, so a tap at the end of a name still opens the
  menu. The lines box clips, so it carries `py-[5px]`, taken back by `-my-[5px]`, to keep the
  vertical reach from being cut. Accepted cost: a truncated phrase that fills a stacked line
  puts its ✕ flush against the clip, which shortens that ✕'s right reach.
- Per-setting ✕s wear the header's `RailTooltip` ("Remove") on a pointer and none on the
  phone, as the end ✕ does.
- **The menu unticks the way the ✕ removes.** A Project row is ticked by a folded match, so
  a row ticked by a stored `project:work` has to untick through `withoutDisplayValue` too.
  An exact-string toggle appended `project:Work` beside it and left the row ticked. Ticking
  still appends the store's own spelling.
- **The trigger ignores a held key.** The shelf's last ✕ (and its reset) hand focus to the
  trigger, and a key still held from that press would autorepeat into it: Radix toggles on
  every Enter/Space keydown regardless of `repeat`, so the menu would open and the repeat
  would go on into its first row. `ignoreHeldKey` prevents the default of a repeated keydown
  on both trigger variants; Radix's own handler runs after the child's under `asChild` and
  stands down on a prevented default.

### Gotchas from the shelf

- *Superseded 2026-10-01: there is no fit, so no stub and no hand-delivered observer; the tests
  read the paragraph's rules off its classes and check that it measures nothing.*
  **jsdom reports every width as 0, so the fit is always `line` there** (`0 > 0 + 1/64` is
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
- *Superseded 2026-10-01: there is no sample.*
  **The sample's classes are asserted EXACTLY.** A class that stretches it from `left-0`
  (`right-0`, `inset-x-0`, `w-full`) makes its width the column's, and then every frame of a
  drag resizes it and forces a one-line measure. A subset match would let one through.
- *Superseded 2026-10-01: the shelf makes no ResizeObserver, so there is nothing to guard, and
  an active braindump mounts in jsdom with nothing to stub.*
  **The `typeof ResizeObserver === 'undefined'` guard is load-bearing.** jsdom has no
  ResizeObserver, and `tests/unit/braindump-grouping.test.tsx` mounts an ACTIVE braindump (a
  grouping is set, so the shelf renders) without stubbing one. Without the guard, all 11 of
  its tests throw `ReferenceError`. A shelf with no observer keeps the fit it measured.
- **Never read the handle in render.** `menu.current` is null on the first render and a
  commit behind after that. `react-hooks/refs` does not catch it: it flags `.current` on a
  `useRef` or on a prop named `…Ref`, and this prop is `menu`. Read it in handlers only.
- *Superseded 2026-10-01: there is no stack. A filter in the paragraph needs `min-w-0
  max-w-full flex-wrap` instead (without `max-w-full` it never stops at the line's width to wrap
  its values), and the test asserts those for the same reason.*
  **A stacked multi-select must `shrink`.** A clause that keeps `shrink-0` in the stack holds
  its one-line width, so the values past the column's edge are clipped instead of wrapped.
  jsdom cannot lay this out, so the test asserts the classes, every one the stack lays out
  by: `flex-col` on the lines box, `shrink`/`min-w-0`/`flex-wrap` on each line and each
  multi-select, `min-w-0 max-w-full` on each value with `truncate` on its label, and
  `min-w-0 max-w-full truncate` on each single phrase.
- *Superseded 2026-10-01: the shelf has no observer. The lesson stands for anything that would
  resize what sits over the hour grid from inside a delivery.*
  **Never write anything inside the observer's delivery, not even the fit.** Forcing the
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
- *Superseded 2026-10-01: each phrase and value takes the pointer now, so a locator can hover
  and click the words, and the gaps are still the opener's. It is a pointer's ✕ that cannot be
  clicked cold (see "Gotchas from the paragraph" below).*
  **A click on the words cannot be `hover()`ed or `click()`ed by locator in Playwright.** The
  words are `pointer-events-none` and Playwright refuses them as "not receiving pointer
  events". Move or click the mouse at their coordinates instead, which is what a user does.
- **`getByText('Priority')` is ambiguous**, because it is a sort label AND a group-by label.
  The tests query `[data-clause="…"]` instead.
- **jsdom's accessible-name computation trims each element's text.** So a space inside a
  separate sr-only separator did not survive it (`Grouped by Project;High,Low;…`). Since the
  per-setting ✕s, the opener's name is ONE sr-only string with its separators inline, so the
  test pins it exactly. Keep it one string.
- **vaul keeps a closed sheet mounted in jsdom and leaves the page `aria-hidden`.** Steps after
  a close therefore go by test id and `data-state`, never by role. The sheet's focus return
  CAN be observed, though: Radix's Presence holds the closed content until an `animationend`
  naming its exit animation arrives, and jsdom computes vaul's (`slideToBottom`) from vaul's
  own stylesheet. Dispatch `animationend` with `animationName` set to
  `getComputedStyle(node).animationName`, wait for the node to unmount, and read
  `document.activeElement` a tick later (`finishExit` in the shelf test). A `<style>` that
  gives the dropdown's closed content an animation holds it mounted the same way, which is
  how a trigger reopening a menu mid-exit is tested.

*Superseded 2026-10-01, the last two states: there is no fit to flip. Text spacing or text-only
zoom re-wraps the paragraph, and the browser's font size leaves its px alone; the paragraph's
own states are in "the shelf as one paragraph" below.*
**Manual QA states:** 406px and 280px sidebar and a 390px phone: one setting; everything on;
a 4+ value priority or project filter at 280px (wraps between values, each ✕ staying with its
value); a ✕ press on the phone near the end of a name (opens the menu, not the ✕); each ✕ taken
off in turn with the keyboard (focus walks on, then lands on the trigger); a long project name
at 280px (ellipsizes); collapse and hover-peek with the shelf showing; open from the shelf and
Escape (focus back on the shelf); a text-spacing bookmarklet or text-only zoom applied with the
shelf on one line (it stacks rather than clip), then taken off (it goes back to one line);
the browser's default font size (Chrome: Settings, Appearance, Font size) raised with the shelf
on one line and a little room to spare (it stacks), then put back (one line).

## Addendum (2026-09-26): the canvas's Display shelf

*Superseded 2026-10-01, the end ✕: Reset display is the ↺ at the end of the paragraph's last
line now, while the settings wear more than three ✕s.*
**What it is.** The braindump's shelf, now in the canvas header too, on both shells. Kirby
asked for it on 2026-09-25 ("can we also add these active filters rail to the body header
too"). On the desktop it is the HeaderCapsule's third row, under the view pill, as the
braindump's sits under its own; on the phone it is the last thing in the Today card, after
the week strip and the review notice. It is the same component reading the same summary for
`surface="canvas"`, so it shows exactly when the canvas trigger's dot is lit, its text opens
the canvas menu through the same handle, each setting's ✕ (a filter's, one per value) takes
that one canvas setting off, and the end ✕, while the settings wear more than one ✕ between
them, is the canvas's Reset display. Nothing in it is canvas-specific except the one clause
only the canvas has, the type filter.

*Superseded 2026-10-01, the example: the usual three are one line on the phone now. Where two
✕s do sit on neighbouring lines, the lower one still takes the 5px between them.*
**Touch keeps its ✕s, as the Braindump tab's.** This branch first drew the text alone on
touch, on both surfaces, on the dock notices' rule (`components/sidebar/dock-notices.tsx`)
that a destructive target pressed up against a full-width tap target is a mis-tap generator:
the one ✕ then sat 2px from the text's reach and wiped every Display setting at once. The
per-setting ✕s (above, 2026-09-26, merged into this branch from main) answered that
differently: a setting's ✕ takes off that one setting, and its 25 × 28px reach runs only the
4px gap toward its own words, so a tap at the end of a name still opens the menu. The merge
took that design for the canvas's phone mount too, the reset ✕ with its 28px reach
included, so the phone's two shelves stay one component with one set of targets. Where two
✕s on neighbouring lines of the stack overlap, the lower one takes the 5px between the lines,
so the upper one reaches 25 × 23 (the usual three settings' "Showing Tasks" ✕). And the end
of a name is a boundary, not a margin: in Chromium a tap on a name's last pixel went to the ✕
for about half the names, and from a pixel and a half in, every one opened the sheet.

*Superseded 2026-10-01, in part: the 5px is in every mode now, between the paragraph's lines
and inside each filter, and there is no fit; the card heights here are the stack's.*
**Wrapped rows keep the reach's 5px on touch.** Review found worse where a line or a
multi-select wraps: those rows had no gap between them, so a ✕'s reach lay over the next row's
words, and a tap on a name took a different setting off (with every setting on at 390×844, a tap
low on "Home" took Wind-down off, on the Today card and the Braindump tab alike; of the names'
own pixels, 130 of "Home" went to Wind-down's ✕, 104 of "Wind-down" to Work's, and 104 of a long
goal's name to each of two other goals' ✕s). On touch those rows now keep the stack's 5px
between them, 5px a wrapped row (that card grows from 284.5 to 294.5px), and every tap from a
pixel and a half inside a name's top or bottom opens the sheet (32 of 32 on the card, 30 of 30
on the tab). Like its end, a name's top and bottom are a boundary, not a margin: a tap on its
last half pixel went to the ✕ of the row below for 5 names on each surface, among them "Home" to
Wind-down's. The fit measures widths only, so it is unchanged, and the braindump's phone tab
shares the rule.

*Superseded 2026-10-01, in part: the pass-through stays, since the paragraph's lines are 23px
apart too and a tip still hangs over the line below. But on a pointer a ✕ is neither drawn nor
hit until its own setting is under the pointer, so the walk down the stacked ✕s is the stack's,
and a click under a tip takes off only a ✕ that is drawn there.*
**A click passes through a ✕'s tip.** In the stack the lines are 23px apart, and a ✕'s tip
(below it, about 60 × 31px, 6px off) covers the ✕ on the line below, so moving the pointer down
from one ✕ to press the next pressed the tip instead, which removed nothing: both clicks down
the usual three settings were lost at 1440. The shelf's tips now let a click through to whatever
they cover, through `RailTooltip`'s `passThrough` and a rule on the wrapper Radix positions a
tip in (`app/globals.css`), and the same walk loses none. Review's fix made the tips unhoverable
instead, which would close one the moment the pointer left its ✕. Here the tip still stays up
while the pointer is over it, since Radix tracks that by where the pointer is, not by what it is
over, until the pointer rests on a control under it that has a tip of its own (the ✕ below; in
the sidebar, the resize sash), whose tip then takes its place. A click on it goes to what it
covers: the next ✕, or the words, which open the menu, and in the sidebar also the list's first
group heading, which it collapses, or the resize sash. Where a tip's own word, "Remove", lies
over the next ✕ (for about half the stacked ✕s), a click on the word before that ✕'s tip takes
over removes the next ✕'s setting; one taken off by mistake comes back from the menu. The
braindump header's own tips (the Display icon's, "Organize projects & groups" and "Add task")
still take the clicks, as on main: they hang over the braindump shelf's first line, so a click
on its words or a ✕ under one of them does nothing. Letting those through would put their own
words over the reset ✕, where a click on "Add task" would reset the braindump's display, so they
are left as they are.

**Where, and what was weighed.** Three placements were rendered in the real header and put to
Kirby on a card: under the pill (built), beside the pill in the header row's bottom band, and
across the header as a full-width line under the row. Beside the pill costs no height on a wide
window but has no room once the item panel is docked, where it would have to fall under the pill
anyway. Across the header puts the reset ✕ at the far right, away from the menu it resets. Under
the pill won on parity with the braindump and on holding up at every width: `<main>` animates
its width with the sidebar and the item panel, and the capsule never does.

*Superseded 2026-10-01, in wording: there is no fit, but containment is as load-bearing for
the paragraph, which would otherwise give the capsule its whole one-line width and never wrap.
Reset keeps the reset ✕'s right edge, in the Zen leaf's column at the end of the last line, so
it is right under the leaf only while the paragraph is one line.*
**Containment is load-bearing on the desktop.** The capsule is `inline-flex flex-col`, sized by
its content, and the shelf's fit needs its width to come from outside (see "Fit is imperative"
above). So the capsule's mount passes `contain-inline-size`, and the shelf adds no inline size:
the capsule stays exactly as wide as its date row or its pill, and the shelf takes that. Without
it, in Chromium, the capsule grew to the shelf's one line (382 to 793px with every setting on)
and the shelf never stacked. The phone card is stretched to the screen, so it needs none. Each
mount's insets come in through `className`, merged over the root's with `cn`. The capsule's
`px-4 pr-3.5 pt-1 pb-px` put the text under the Layout icon and the reset ✕ under the Zen leaf
(the pill insets the leaf 14px, not 16), 8px under the pill and 9px above the capsule's edge;
the phone's `px-0 pt-0 pb-px` put the text on the date's edge. `floor` is the sidebar's alone:
the capsule never animates, so every width it takes is one it rests at.

*Superseded 2026-10-01, in part: the row still grows 27px for the first line and 23 for each
after, and the grid still re-fits, but nothing stacks now. The usual three are one line (a
162px row, not 208) and everything on is three lines in Day × Schedule (208, not 277), so the
line counts, the 84-state counts and the six-line figures below are the stack's. The paragraph
is the "wrapping fit" this names as the lever; its heights are in "the shelf as one paragraph"
below.*
**The height it costs, taken on purpose.** The header row was a constant 135px, and the grid
under it (`lib/use-fit-hour-px.ts`) sizes Day and Week × Schedule's hour rows, and the phone's
DaySchedule's, to the height left. The shelf is in flow, so while anything is set the row grows
27px for the shelf's one line and 23px for each line its stack adds (162, 185, 231 and 277px for
1, 2, 4 and 6 lines), and the rows re-fit as it comes, goes, or stacks. One line holds one or
two settings while each wears one ✕. A filter wears one per value, so "Grouped by Project ·
Learn Chinese, Marathon" stacks in every layout (a 185px row), and a filter of four values alone
wraps in Day and Week × List (180px). Since each setting brought its own ✕ ("a ✕ for each
setting" above, merged into this branch), each of the 84 states with a type set (see "Words"
below) that has three or more settings stacks in every layout at default fonts, all but "Grouped
by Goal · Showing Tasks · Hide finished", which still fits one line in Week × Schedule, whose
pill is the widest. Settings with short names can still share a line: at 1440, "High · Work ·
Hide finished" fits one line in every layout. So the usual "Grouped by Project · Showing Tasks ·
Hide finished" costs 73px: the row is 208px, where it was 162 on one line (see "Words" below).
With every kind of setting on at once (six lines), measured in Chromium on one sample day (the
hour rows fit the span of the day's timed items, so the px/h and overflow figures are that
day's, and another day's differ; the header, card and viewport heights do not): 1366×768 Week ×
Schedule's overflow goes from 101 to 243px (Week × Schedule is already at the 40px/h floor on
most laptops, so every line is scroll); 1440×900 Day × Schedule goes from 42 to 40px/h with one
line; a 390×844 phone's card goes from 106.5 to 248.5px and its hour rows from 53 to 40px/h; at
375×667 the day's viewport goes from 463 to 321px, and with the keyboard up (375×407) from 203
to 61px. Those are full-screen viewports; in a real laptop window, where the browser takes 90 to
160px, Day × Schedule is often already at the floor with nothing set (1280×610: the viewport
goes from 449 to 422px with one line, and to 307px with six), so there every line is scroll on
Day too. Week × Schedule also pins its day heads and Anytime strip inside that viewport (164px
with the strip at its floor, 244 at its cap, and 18px of lane caps when grouped), so there the
stack comes out of a smaller band of hour rows. At 1280×610 the usual three settings leave 194px
of hour rows under the pin with the strip at its floor, and 114 on a busy week (eight untimed
tasks today), where nothing set leaves 285 and 205; six lines leave 143 and 63. So the shelf's
73px is 27 to 39% of that band, where against the viewport it reads as 16%. At 1366×768 a busy
week keeps 272px with three settings and 221 with six. If the band proves too small, the lever
that leaves the shelf's promise alone is in `week-schedule.tsx`: unpin the heads while the band
under them is a few hours or less, or lower the strip's cap while the canvas shelf stacks
(neither tried). There is no cap. A "+N" would break the shelf's one promise, that it names
exactly what the dot counts; if the stack proves too tall on the canvas, a cap or a wrapping fit
for this mount is the lever. `desktop-shell.tsx` records the shelf as the one thing in the
header row allowed to grow it.

*Superseded 2026-10-01, in part: the paragraph still re-wraps as the date moves List's
capsule, and the list moves 23px for each line it gains or loses, but there is no flip of the
whole stack (46 or 69px) at one threshold.*
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

*Superseded 2026-10-01: the shelf has no observer, and so no frame to wait.*
**Never write inside the observer's delivery.** The canvas mount is what surfaced the
gotcha above ("Never write anything inside the observer's delivery", under Gotchas from the
shelf): a flip decided inside the observer's delivery resized the grid's viewport in
that same delivery and raised the "ResizeObserver loop" error. The fit now waits a frame.

*Superseded 2026-10-01, the counts: which of the 84 states fit one line and which stacked are
the stack's, since the paragraph has no one-line threshold. The choice of words, and why,
stands.*
**Words.** The type clause reads "Showing Tasks" / "Showing Habits": the menu's own row (its
Type section says All, Tasks, Habits), led by a muted "Showing" as grouping is by "Grouped
by", and "Show" is the palette's name for the setting. The words cost width: "Showing Tasks"
is 78.4px against "Hide habits"' 59.2, and "Showing Habits" 81.4 against "Hide tasks"' 55.2,
so more states stack. Of the 84 states with a type set (both types, seven groupings, three
sorts, Hide finished on and off), measured with today's date on screen (Saturday, September
26, so no Today button), the ones that fit on one line fall from 38 to 24 in Day × List, 47
to 33 in Week × List, 56 to 40 in Day × Buckets, 58 to 48 in Day × Schedule, 58 to 52 in
Week × Buckets and 60 to 56 in Week × Schedule, and none goes the other way. The capsule is
as wide as the wider of its date row and its view pill, and on today's date, which has no
Today button, the pill always sets it, as it does on most other dates. On the widest dates
(Wednesday, September 30 with its Today button, a 362px row), List and Day × Buckets all fit
57 before and 43 after; a row that outgrows only Day × List's pill moves only that count,
and by less (Monday, September 28: 28). The Schedule and Week × Buckets counts do not move
with the date. All of those counts are from before the settings' ✕s, merged in since: a ✕
and its gap on every clause leave 20 of the 84 on one line in every layout, the states with
at most one setting beside the type, and a 21st in Week × Schedule, "Grouped by Goal ·
Showing Tasks · Hide finished", three settings on one line. "Grouped by Project ·
Showing Tasks · Hide finished" stacked three lines in Day × List on today's date (September
26), 2px over its one line, where "Hide habits" fit; the list started 46px lower, and paging
to a wider date, or seeing September 26 from another day, put it back on one line. With the
✕s it stacks in every layout, on any date. A bare "Tasks" beside "Grouped by Project" read
as a group or a project name. "Tasks only" would be false (Tasks keeps every task-like item,
custom types included) and Settings already uses "Tasks only — habits always stay" for
something else. "Hide habits" was tried and dropped: the menu the text opens has no row by
that name to undo it under. The shelf names what is SET, never what reaches the view: a sort
outside List, or grouping by Time bucket on Buckets, is named like any other setting, as the
dot counts it. Notes saying so ("Sorted by Priority · List only") were designed and dropped,
and what a later version must get right closes this addendum. Never named, as on the
braindump: Show paused (app-wide, and the menu captions its row so) and the palette's Hide
completed tasks (a planner setting, not a Display one). Palette commands change the named
settings with no menu open, and the shelf follows them; "Clear canvas filters" clears the
filters only, so any grouping, ordering or type stays named.

**Accepted, not fixed:**

- *Superseded 2026-10-01, in part: only while both shelves wear four ✕s or more.*
  Two buttons named "Reset display" when both shelves are up, as the two "Display (N active)"
  triggers already were. Naming each surface in all three controls is one change for later.
- The ✕s are `text-muted-foreground` like every icon control in the capsule (2.65:1 on their
  ground in light mode), and wear the braindump header's label-only `RailTooltip`, while the
  capsule's own Zen tooltip is the plain one. A token change would restyle every icon control.
- *Superseded 2026-10-01, the last sentence: Reset still ends in Zen's column, but on the
  paragraph's last line, so it sits right under Zen only while the paragraph is one line.*
  No ✕ can be undone: Ctrl+Z is the planner's undo and never reaches view settings, the same
  as the menu's Reset row. The reset ✕ sits 14px under Zen.
- *Superseded 2026-10-01, the shelf's figures only, here and in the bullets below: they were
  measured on the stack, with the reset ✕ beside the first line from two ✕s and every ✕ drawn.
  The hook and its rules are unchanged, Reset keeps the same right edge (at the end of the last
  line, from four ✕s), and a pointer's undrawn ✕s keep their boxes and their Tab stops, but the
  shelf's widths and percentages here are the stack's.*
  With the item panel docked, `<main>` can be narrower than the header row, and it clips the
  row's right end. How far depends on scope, layout and the sidebar's width. With the
  default sidebar, Zen is clipped up to 1275px windows in Day × Schedule, 1286 in Week ×
  Schedule and 1278 in Week × Buckets (the reset ✕ up to 1267, 1278 and 1270), WeekScale's
  controls up to 1488 (1480 in Buckets), and the Display trigger up to 1234 in Day ×
  Schedule and 1245 in Week × Schedule. With the sidebar at its widest, 720px, a 1440 window
  leaves `<main>` 252px, and the Display trigger is past the edge there too. A pointer
  cannot reach what is clipped; the text still opens the menu.
- The keyboard can. `<main>` stays `overflow-hidden`, which is still a scroll container, so Tab
  onto a clipped control scrolls it into view. Nothing ever scrolled it back, so the canvas
  stayed slid, about 38 to 242px at the default sidebar and 269 at 720px, until the panel
  closed, unless a later Tab happened to reveal something at the other end (in Week × Schedule
  the grid's first stop often did). `useFocusOnlyScroll` (`hooks/use-focus-only-scroll.ts`) now
  places `<main>` for whatever has focus, a frame after focus moves anywhere, a key goes down in
  `<main>`, `<main>` scrolls or resizes, or what the focused control paints starts or stops
  showing whole or at all. An IntersectionObserver at thresholds 0 and 1 hears that when nothing
  else fires. It watches the control and its children, which a squeezed control paints past its
  box (below), and its root reaches a pixel past `<main>`'s left and right edges, so what a
  slide shows whole to within a fraction counts as whole and a later cut is heard. Review found
  the first version, which watched the box alone at `<main>`'s exact edges, deaf to a move that
  cut only what the review notice paints: moves of 12, 30 and 56px left 84, 59 and 23% of it
  showing until the next key. It does not hear a cut of a pixel or less, nor a move from cut to
  cut, nor one out of sight that stays within a pixel of the edge; those wait for the next key,
  focus move, scroll or resize. `<main>` goes to rest when focus leaves it for the sidebar, the
  item panel or nothing, and when the focused control shows there, unless it holds (below).
  Otherwise it moves only when it must, because Radix closes a tooltip on any scroll around its
  trigger and a tooltip is all the name Zen and the ✕s show. A control out of sight comes in to
  the least slide that shows it whole. So does whatever has focus when `<main>`'s width changes:
  the item panel docks a frame at a time, and a slide kept from an earlier frame left the
  focused reset ✕ a quarter showing once it had docked. So does a control the layout moves, once
  the move leaves it cut. Otherwise one that shows, whole or cut part-way, keeps the slide the
  hook last made. A slide the hook did not make comes back as far as that least one: Chromium
  centres what it reveals (Zen slid Week 212px at 1240, where 47 shows it).
- A key moving focus along the row `<main>` slid for keeps that slide too, for a control that
  shows whole at it, even one that would show at rest, for as long as it keeps focus and shows
  whole. A row is a child of `<main>`, and the header's is the one that slides. So Tab from Zen
  across the shelf's text and its settings' ✕s to the reset ✕ moves nothing while each ✕ shows
  whole at Zen's slide, and each tooltip stays up (but see the bands and wide sidebars below).
  The settings' ✕s, merged in from main, are what asked for it: they show at rest, so without it
  the first one sent `<main>` back and closed its own tooltip, and the reset ✕ after them, out
  of sight at rest, came back in and closed "Reset display" at every width below where it shows
  at rest (default sidebar, Day × Schedule up to 1252, Week × Schedule up to 1263). Chromium
  alone keeps both up in Day and in Week × List, where revealing Zen scrolls `<main>` as far as
  it goes (50px in Day × Schedule at 1240) and every ✕ shows there, and closes them in Week ×
  Schedule and Week × Buckets, where it centres Zen (212px in Week × Schedule at 1240) and so
  cuts the ✕s. Focus moving on into the schedule puts `<main>` back at rest. Focus a pointer
  moves is placed by the rules above, as a click's always was, and so is focus a menu hands on,
  or that comes back from nothing: none of them comes along the row. The kept slide costs canvas
  while focus stays in the row, as the hold does. Shift+Tab from the schedule onto the reset ✕
  in Week × Schedule at 1240 slides 39px, and the row keeps that slide on across the header to
  the calendar button, past the settings' ✕s, the scope and layout buttons and the date's
  controls, which all show at rest, so the canvas's first 39px stay hidden until focus leaves
  the row. Before this rule `<main>` went back at the first ✕ it reached (the last setting's)
  and slid again for Zen, as Chromium alone does; Chromium then keeps its 212px from Zen to the
  scope button, and shows 47% of that button. From the season line in Day × Schedule at 1240 the
  row keeps 74px to the scope button, and the layout button, which that slide cuts, puts
  `<main>` back; Chromium alone keeps the 74 to the calendar button and shows 6% of it.
- The least slide is rounded up to whole pixels, so it shows its control to the last fraction.
  An earlier version rounded to within half a pixel, which the observer of that version, at
  `<main>`'s exact edges, counted as cut, so a view switch that cut the control further went
  unheard: Zen, placed 99.1% showing in Day × Buckets at 1240, was left 44% showing after store
  switches to Week × Buckets and then Week × Schedule. Its root now reaches a pixel past those
  edges, so it counts either as whole and hears a later cut of more than a pixel. A control that
  overhangs `<main>`'s edge by half a pixel or less still counts as showing at rest. Rounding up
  can leave up to a pixel of the control after it showing, so a control that shows a pixel or
  less counts as out of sight. Without that, Tab from the season line onto the review notice in
  Day × Buckets kept the season line's slide and showed 0.7px of the notice's button (1200 and
  1240 at the default sidebar, 1320 at 560, 1440 at 720).
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
  control needs. Under a focused reset ✕, a switch from Week to Day × Schedule keeps 11px more
  than Day needs, a layout switch alone 8 (Week × Schedule to Buckets), and a scope switch and
  then a layout switch up to 18, the same at 1200 and 1240 with the default sidebar, 1320 with
  560 and 1440 with 720. While Next keeps focus, the canvas stays at the widest slide a date has
  needed: in Day at 1440 with the 720px sidebar, 82px from Wednesday, September 30 on, where
  Friday, October 2 needs 15; at 1300 with the 560px sidebar, 62, where Friday, October 2 needs
  none; in Week, at most 28 more than a date needs. WeekScale's thumb, after Home at 1340, keeps
  123 where it needs 21, and at 1440 keeps 23 where it shows at rest. Chromium alone keeps its
  centring slide throughout, 108 to 208px.
- A click on a button holds nothing. After a Tab slide onto Next, a click on it pages the date
  and the date's width moves Next. Holding the slide there let Go to today move under the
  pointer: an earlier version paged five days in Day at the 720px sidebar and then the sixth
  click landed on Go to today, which put the date back and `<main>` at rest, and in Week the
  second click undid the first. A button a click moves is placed afresh instead, which keeps it
  at `<main>`'s edge, under the pointer, so eight clicks page eight days, or eight weeks.
  Chromium alone pages four days and then opens the calendar, and in Week alternates Next and Go
  to today. That keeps a button under the pointer only where the slide was made for it. Where
  the row only kept a slide and the button shows at rest, afresh is rest, so the click moves the
  canvas under the pointer by the whole slide: after Shift+Tab from the schedule to the reset ✕
  and on along the header to Next, a click on Next at 1240 moved it 11px in Week × Schedule and
  51 in Day, where a second click at the same spot opened the date picker. Accepted: it takes
  keys along the header and then the pointer on the same stop, and review's pin for it was one
  more rule for the others to be walked against. A click counts until a key goes down in
  `<main>`, so Enter on Next still holds. A dragged thumb is not a button, and still holds: a
  variant that let go for every pointer move jumped the canvas on the release (62px to 0 at
  1400, 122 to 20 at 1340) and back on the next arrow.
- Focus moving on from a held slide places the next control afresh if that slide cuts it by more
  than a pixel, because the slide was held for the control focus left. After paging with Enter on
  Next, Tab onto Go to today showed as little as 3.6% of it under an earlier version, where
  Chromium alone showed it whole; it now shows whole in all 32 cases tried (Day and Week, 1440
  with the 720px sidebar and 1300 with 560, after one to eight presses). The same goes for Zen
  after scope switches moved a focused Display trigger, and that reveal closes Zen's tooltip.
  A hold can be at rest too: a control the layout moves while it shows whole at rest holds rest,
  and focus moving on from it places afresh a control that rest cuts by more than a pixel. With
  the default sidebar, Enter on Next in Day × Schedule at 1240 and 1260, paging from Tuesday,
  September 29 to Wednesday, September 30, and then Tab brings Go to today in at 34 and 14px,
  where Chromium alone leaves 42 and 76% of it showing, and `v` under a focused Display trigger
  (Week × Schedule to Day at 1250 and 1260, Day to Week at 1270 and 1280) and then Tab brings Zen
  in at 7 to 26px, which closes its tooltip, where Chromium alone leaves 19 to 81% of it showing
  with the tooltip up. A width change, or a scroll something else makes, places a holding control
  again, and it still counts as holding when focus moves on. Review found this closing a tooltip:
  at 1230 with the default sidebar, Tab onto Zen, Shift+Tab back onto the Display trigger, `v`
  (Week × Schedule to Day) and the window widened to 1250, which put the trigger's hold at rest,
  and Tab onto Zen then slid 26px and closed "Enter zen", where forgetting the hold leaves Zen at
  rest, 19% showing, with its tooltip up. Forgetting it was built and reverted, because a switch
  to the narrower List with Zen focused pulls `<main>` back, which is a scroll something else
  makes too, and there forgetting the hold closed more tooltips. With the shelf text wider than
  `<main>`, the text then kept Zen's slide, cut at its start, as on a Tab from Zen with no switch,
  and a setting's ✕ after it closed its tooltip as `<main>` moved to show it: the first one in
  Day × List at 1307 to 1309 with the 720px sidebar, and the priority filter's "High" ✕ at 1273 to
  1275 with 560 and every setting on. Counting the hold places the text at its start instead. With
  the pixel rule below, that keeps the first ✕'s tooltip up at 1308 and 1309, and "High"'s at 1273
  to 1275; a ✕ that slide cuts by more than a pixel still moves `<main>` 2px and closes its own
  tooltip, the first one at 1307, and at 1273 the "Sorted by Priority" ✕ before "High".
- *Superseded 2026-10-01, one clause: Reset now mounts afresh when a fourth ✕ comes back, not a
  second setting.*
  So does focus coming to a control the layout has moved since the hook made the slide the row
  keeps, where the move shifts an edge the slide cuts. Review found a view switched from the
  Scope or Layout pill's menu by keys, after a slide made for Zen or the reset ✕: Enter hands
  focus back to the pill, whose label changed width, so the pill held the slide, and the Display
  trigger after it, which showed whole, kept it along the row. Zen and the reset ✕ then came in
  cut at a slide made for where they had been, 21 to 71% and 37 to 92% showing, where the build
  before the along rule showed both whole. The hook now notes where each control of the row sat
  when it made its slide. A control focus comes to that the kept slide cuts at an edge that has
  moved since, like one that follows a held control, is placed afresh; one whose every edge the
  slide cuts sits where it sat is cut as it was, and keeps the slide, cut part-way, as Chromium
  would leave it. In the fourteen cases tried (Day × Schedule, Buckets and List at 1200 to 1240
  with the default sidebar, one with every setting on, Day × Schedule at 1300 with 560, Week ×
  List at 1200), Zen and the reset ✕ now show whole; the reveal closes Zen's tooltip, as any
  reveal does. The rule's first version compared both ends, and review found it placing the
  shelf text afresh when only its end had moved, an end the slide left whole: Week to Day from
  the Scope menu by keys pulls the text's end back 10px, and a setting added from the Display
  menu runs it on. The text went to its least slide, and the reset ✕ two stops on, out of sight
  there, came in on a second move that closed "Reset display" (after the switch, Week × Schedule
  at 1200 to 1230 and Week × Buckets at 1200 and 1215; after the added setting, Day × Schedule
  at 1200 and 1215 and at 1300 with 560, Day × Buckets at 1200 and Week × Schedule at 1215),
  where the build before the rule moved nothing. Only the edges the slide cuts count now. A
  control that has appeared in the row since the slide was made has no place noted, and counts
  as moved: the shelf mounts its reset ✕ afresh when a second setting comes back, and after a
  switch that moved the header, the kept slide left it 87% showing with its tooltip up, where it
  now comes in whole. And a slide placed while a control wider than `<main>` has focus, which puts
  that control's start at the edge, or keeps a slide something else made short of it, whatever it
  cuts, counts as gone for any control focus comes to while it stands: with the 720px sidebar at
  1300, the shelf text placed at its start left the next setting's ✕ 36% showing, its tooltip up,
  where Chromium alone showed it whole (after a layout switch from the palette, which hands focus
  back to a held Zen; after the item panel docked under the focused text; and after a switch that
  moved the text), and the ✕ now comes in whole. Review then found that rule moving `<main>` a
  pixel for a ✕ the slide cut by less than one, which closed its tooltip where the build before
  the rule kept it up: the "Sorted by Priority" ✕, 96% showing, after a switch to Day × List at
  1274 with the 560px sidebar and every setting on, and the "Grouped by Project" ✕, 93% showing,
  after a switch to Day × List, or with the item panel docked under the focused text, at 1308 with
  the 720px sidebar. A control a gone slide cuts by a pixel or less, which the observer counts as
  whole, now keeps the slide.
- Chromium scrolls only for a control that is wholly hidden, so one cut part-way keeps the part
  it shows, as it did before, unless that is a pixel or less: the reset ✕ 19% of itself in Week
  at 1265 (with its tooltip), the Display trigger 66% in Day at 1200. The hook's smaller slides
  add one: Shift+Tab from the schedule onto the reset ✕ brings it in at its least slide, 8px
  short of Zen's, and the row carries that slide across the settings' ✕s and the text, so Zen
  shows 75 to 78%. That is wherever the reset ✕ needs a slide and every ✕ shows whole at it:
  with the default sidebar, every layout from 1200 up to where the reset ✕ shows at rest (1219
  in Day × List to 1263 in Week × Schedule); with the 560px sidebar, Day × Schedule at 1300 and
  1340 and Week × Schedule at 1340; with the 720px one, 1480; and the same with every setting on
  (Week × Schedule at 1215 and 1250). Chromium alone, sliding as far as it can or centring,
  showed it whole at most of those widths. Where the slide cuts a setting's ✕ (Week × Schedule
  at 1300 with 560, and Day and Week × Schedule at 1440 with 720), that ✕ puts `<main>` back and
  Zen comes in whole. The shelf text keeps the slide of whatever stop came before it, unless
  that slide is gone (above): Zen's on Tab, and on Shift+Tab the first setting's ✕'s. When the
  text is wider than `<main>` (the 720px sidebar), Tab from Zen shows 67 to 69% of it in Week ×
  Schedule and Buckets and 75% in Week × List, cut at its start. On Shift+Tab the settings' ✕s
  carry the slide the reset ✕ came with, a notice's or WeekScale's, only while they show whole
  at it. Where it cuts one, that ✕ shows at rest and puts `<main>` back, and the text then shows
  at rest, cut at its end: 60 to 62% in Week × Schedule and Buckets and 62 to 70% in Day, past
  either notice or both, at 1440 with the 720px sidebar (Chromium alone keeps an 11px slide
  there and shows 64 to 74%), 75 to 77% in Day × Schedule and Buckets at 1320 with 560, and 86
  to 89% past the review notice with the default sidebar (Day × Schedule at 1200 and 1210, Day ×
  Buckets at 1200). Where the ✕s show whole at it, the text keeps it: 78% in Week × List at 1440
  with 720, cut at its start, 81 to 94% past the season line at 1200 to 1240 where the slide
  cuts it (in Day × Buckets at 1240 and Day × List at 1220 it shows whole at rest and goes
  there, and Zen, next, then shows 12 to 29% at rest, where Chromium alone keeps the season
  line's slide and shows Zen whole), and past the review notice 77 to 85%, cut at its start, in
  Day × Schedule at 1220 to 1240, Day × Buckets at 1210 to 1230 and Day × List at 1200 and 1210
  (Chromium alone showed 69 to 75% of it in four of those eight, cut at its start, and 91 to 96%
  at rest in the other four); in wider windows it shows whole at rest and goes there. Shift+Tab
  that starts on the notice's own button, whose slide is larger and cuts the ✕s, finds the text
  at rest, 86 to 99% at 1200 to 1240.
- A reveal is itself a scroll, so Zen's tooltip closes on the Tab that reveals it, and the reset
  ✕'s on the Shift+Tab that reveals it from the grid. The hook's own moves close fewer since the
  row keeps its slide. Shift+Tab onto the reset ✕ from the stop after it, when that stop needed
  a slide and the ✕ shows at rest, used to put `<main>` back: WeekScale's Narrower in Week ×
  Schedule (1190 with a 280px sidebar, or 1310 with the default one), and in Day the season line
  or the review notice (at the default sidebar, Day × Schedule about 1268 to 1302, Day × List
  1236 to 1268, Day × Buckets 1260 to 1294). That closed "Reset display" in 10 of the 12 cases
  tried (1190 and 1310 in Week × Schedule, 1270, 1285 and 1300 in Day × Schedule, 1240 and 1255
  in Day × List, 1265 and 1280 in Day × Buckets); in the other two the scroll landed before the
  tooltip opened. Along the row it keeps that stop's slide now, and the tooltip stays up in all
  12, as it does in Chromium alone. Zen's closes on the Tab from the Display trigger at the
  720px sidebar, where Chromium's centring slide for the trigger already showed Zen and the
  hook's least slide does not. And the reset ✕'s closes when a scope or layout switch leaves it
  cut, or it mounts again cut, and it is placed afresh. Tab from Zen across the shelf keeps
  "Reset display" up at the QA widths, but not in a band of 8px of window just below where the
  reset ✕ starts to show at rest (default sidebar: Day × Schedule 1245 to 1252, Week × Schedule
  1256 to 1263, Week × Buckets 1248 to 1255, Day × List 1212 to 1219, Week × List 1222 to 1229,
  Day × Buckets 1238 to 1245). There Zen shows part-way at rest, so no slide was made, and the
  reset ✕'s own reveal closes its tooltip. Chromium alone closes it a pixel lower in Day and
  Week × List (Day × Schedule 1244 to 1251, Day × List 1211 to 1218, Day × Buckets 1237 to 1244,
  Week × List 1221 to 1228), and in Week × Schedule and Week × Buckets at every width below the
  band's top, where its centring slide for Zen cuts the settings' ✕s. The hook adds the top
  pixel, where the reset ✕ shows a pixel or less at rest, which Chromium leaves alone and the
  hook brings in whole, and in Day and Week × List saves the bottom one, where Zen shows a pixel
  or less at rest: Chromium leaves it alone, and the hook's slide for it carries along the row.
  A wider sidebar moves the band to wider windows (Week × List at 1380 with 560). And where
  `<main>` is 270px or narrower (1280 and 1300 with the 560px sidebar, 1440 with the 720px one),
  Zen's slide cuts a setting's ✕ at its start in Day and Week × Schedule and Buckets (all but
  Day × Buckets at 1300): that ✕ shows at rest and puts `<main>` back, closing its own tooltip,
  and the reset ✕ then comes back in and closes "Reset display". Day and Week × List keep both,
  as every layout does at 290px (1320 with 560, 1480 with 720). Chromium alone loses the same
  two in Day where the hook does, and in Week × Schedule and Week × Buckets wherever Zen needs a
  slide, since it centres Zen there; in Week × List it slides as far as it goes and keeps both
  (1300 with 560, 1440 with 720).
- It also holds still, whatever has focus, in four cases. While a pointer is down, found in
  review: a press moves focus on mousedown, and the first version slid `<main>` back before the
  release, so the click was lost (Next, a block's Mark complete) and a drag ran offset by the
  whole slide. While focus is in a layer outside the shell, such as a menu or the calendar, most
  often drawn against its control in `<main>`: Radix hands focus back with a plain `focus()`,
  which finds the control still showing. Not always: it hands focus back 33 to 58ms after the
  pick takes it from the menu, and a frame that falls in that gap finds focus on nothing and
  puts `<main>` at rest, so the pill it goes back to shows cut (87% in Day × Schedule at 1274
  with the 560px sidebar and every setting on). Review saw that in 1 of 21 picks at 36a4337 and
  1 of 24 at b521f76. Holding for a moment on focus that drops to nothing out of a layer would
  fix it; that was not built. A menu drawn against a sidebar control, such as the braindump's
  Display menu, holds `<main>` too, which is harmless: Escape hands focus back to the sidebar
  and `<main>` goes to rest. Review found that focus going on from such a layer to the sidebar,
  or to nothing, never passes through `<main>`, so the focus listeners are on the document. The
  calendar is the exception: after Escape it drops focus to nothing while it fades out, and only
  then hands it back, so a canvas that was slid when it opened comes back at once, and the
  fading calendar moves with it. And while an ancestor of `<main>` is inert, which only Zen's
  switch does as it lifts the planner away: focus drops to nothing 130 to 220ms in, and an
  earlier version went to rest there, jumping the whole visible planner 36 to 150px sideways
  under the wave. If the switch is turned back mid-wave, `<main>` stays slid (47px in Week ×
  Schedule at 1240) until focus moves, a pointer comes up (a click anywhere, even on nothing),
  the window loses focus, or `<main>` scrolls or resizes: with focus on nothing, a key never
  reaches `<main>`. `<main>`'s own inert, under the overlaid item panel, does not count. And at
  rest, with nothing past either edge, there is nothing to do. Only `<main>`'s width is noted
  there, and what was noted for the last slide, and any hold, is dropped: review found, in a
  unit test, a stale note placing afresh a control that a spell at rest left cut part-way, which
  the browser leaves alone. Nothing in the shell was found to do that.
- Review first made `<main>` `overflow-clip min-w-0` to stop the slide, and that was reverted: a
  clip box never scrolls, so Tab landed on controls nobody could see, the reset ✕ among them,
  which clears every canvas Display setting. `tests/unit/desktop-main-scroll.test.tsx` pins the
  class and the hook together.
- Two notices share the row, and with the panel docked both buttons are squeezed below what they
  paint: the season line's (a season that is off, hiding items today) to 0px, where it still
  paints its Moon icon and its focus ring, and the review notice's ("Today's review is waiting")
  to its 16px of padding, where it paints its icon and "Start" past its box. The hook measures
  what a control paints past its box, unless it clips it, and slides that into view: the Moon at
  74px in Day × Schedule at 1240, and the review notice's icon, "Start" and ✕ at 135 (without
  the season line). Review caught earlier versions of the hook sending `<main>` to rest for the
  season line, which left its icon wholly past the edge, and sliding the review notice's 16px
  box into view and no more, which showed 57% of its icon and none of "Start"; Chromium alone
  showed both. The season line's text still never shows. That is older than this change (13aa588
  does the same); a floor it cannot shrink below, or leaving the row when there is no room,
  would fix it.
- The least slide puts a control's edge within a pixel of `<main>`'s, and Chromium draws the
  focus ring 1px inside the box and 2px outside it, so on that side up to two of the ring's
  three pixels are cut. Room for the ring would have to be added only when a slide is made: a
  control flush with `<main>`'s edge at rest must still count as showing there.
- The phone skeleton is the card at rest (106.5px, which the skeleton rounds to 106); a
  first paint with the shelf or the review notice up grows the card downward by that much.

**Deferred: reach notes.** If the shelf is ever to say that a setting reaches nothing in the
current layout (a sort outside List, `sortByBlockedBy`; a grouping `groupBySupport` answers
`honoured: false` for), the reviews of 2026-09-26 settled how:

- *Superseded 2026-10-01, the reason: there is no fit key, and a paragraph wraps rather than
  clips, but the note still belongs in `clauseText`, which is the opener's name (Label in Name)
  and the tests' oracle.*
  The note is PART OF `clauseText`, so the fit key, the visible text and the test oracle stay
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

*Superseded 2026-10-01, in part: everything on is three lines in Day × Schedule now, not six;
the threshold walk's `error` listener has no shelf observer left to catch; the three settings
once stacked are one line, and on a pointer a ✕ is drawn only under its own setting; and "the
reset ✕" is Reset display's ↺, from four ✕s. The paragraph's own states are below.*
**Manual QA states:** 1440×900 and 1366×768, Day and Week × Schedule, List and Buckets: one
setting; everything on (six lines); page dates in Day × List and click Week × List's headings
with a shelf near its threshold, with a window `error` listener attached (no "ResizeObserver
loop"); the item panel docked at 1280 and 1200px, and Tab and Shift+Tab through the header there
(each control shows while it has focus, whole unless the edge cuts it part-way; at the default
sidebar each ✕'s tooltip stays up on Tab from Zen across the shelf; the canvas is back at rest
once focus moves into the schedule, and a click on Next while it is slid moves the date); with
three settings stacked, the pointer down the ✕s, clicking each once its tip shows (each click
takes its own setting off); open an item while the reset ✕ has focus (it stays whole as the
panel docks); with the 720px sidebar in Day, page dates with Enter on Next (the canvas moves
only when a wider date would cut Next, and does not come back while Next has focus: from
Saturday, September 26, once in eight presses, onto Wednesday, September 30, at 1440 and at
1366), then Tab onto Go to today (it shows whole), and after a Tab slide onto Next, click it
eight times at one spot (it pages eight days); at 1440 with the default sidebar, press the
arrows on WeekScale's thumb in Week × Schedule (at most one 23px slide, on the Tab or on the
first step that reaches 2 days, then none); with a season off and hiding items today, Tab onto
the season line at 1240 (its Moon shows); with today's review waiting, Tab onto its notice at
1200 (its icon, "Start" and ✕ show); Enter on Zen while the canvas is slid (the planner does not
jump sideways as the switch lifts it away); open from the shelf and Escape (focus back on the
text); a setting's ✕ with the keyboard (focus moves to the next ✕), and the reset ✕ (focus lands
on the Display trigger). A 390×844 phone: the same settings, the review notice owed and not, the
sheet opened from the text, a tap on each ✕ and at the end of a setting's words (the ✕ takes
that setting off, the words open the sheet), a filter whose names wrap onto a second row with a
tap on the top and bottom of each name (each opens the sheet), and Reset display from the sheet
(focus lands on the Display icon).

## Addendum (2026-10-01): the shelf as one paragraph

**Why.** Kirby, on 2026-10-01, of the stack above: "stacked looks a little crazy eh? even three
looks strange? any options for those, on both rails?" Three ways out were built into the real
header, each reviewed adversarially and then shot on the canvas (1440×900), in the braindump
(406px, its usual width) and on the phone (390×844) with its height beside the stack's, and put
to him as round 3 of <https://claude.ai/artifact/8GvLbx6bgiM7JPXgCyhecg> (the same page keeps
round 2, of 2026-09-24, where the stack was the recommendation). They were built and shot in a
throwaway Vite harness that bundles the real DesktopShell and MobileShell with seeded stores,
Next and Supabase stubbed, and an option's files standing in for the repo's. It is not in the
repo: it lives in the project's shared files, `/mnt/project-files/canvas-shelf/round-3/`, whose
README says how to build an option and shoot it.

- **A, Quiet paragraph, the recommendation.** The settings wrap like the words of a sentence
  instead of taking a line each. With a mouse no ✕ shows at rest: a setting's own ✕ appears
  after it under the pointer. A little extra room marks where each filter starts and ends, and
  from four ✕s a ↺ ends the last line (the page says "from four settings up"; the build counts
  ✕s, one per phrase and one per value, so two settings can bring it). On the phone every ✕
  stays. Three settings take 23px on the canvas (the stack's 69), and everything on 69 in Day ×
  Schedule (the stack's 138), 92 in Day × List.
- **B, Soft chips.** Each setting a soft chip with its ✕ inside, the chips wrapping in rows. A
  filter is one chip, so its one ✕ takes the whole filter off, and a quiet Reset sits at the top
  right. The clearest structure, with nothing waiting on a hover, but more boxes than words,
  three settings still take two rows (54px on the canvas, 82 with everything on), and one value
  of a filter comes off only through the menu.
- **C, Always one line.** Filters first, a long filter counted ("2 priorities"), and whatever
  is left behind a quiet +N whose "Also set" tooltip lists it. The filter that emptied the list
  always keeps its place on the line, and there is no Reset. The quietest header (23px on the
  canvas whatever is set), but part of what is set hides behind +N (on the phone, until the
  sheet opens), a filter wears one ✕, and it is the most new logic. It is the cap the canvas
  addendum held in reserve, at the price that addendum named: a "+N" names what the dot counts
  only behind a hover.

A paragraph is not new to this shelf. Round 1, which the same page shows beside round 2, was
one: middots between the settings, "+1" after a setting's first two values, and settings free to
break mid-way. Round 2 replaced it with the stack, partly because every setting ran together in
one paragraph and a setting could break across two lines. A answers that with spacing where the
middots were (20px between phrases, 16 between values, 28 at a seam), every value named, no
phrase ever broken, and a filter broken only between its values, once it is wider than a line.

**This branch builds A while Kirby's pick is pending**, and its merge waits on that pick (before
the merge, this sentence gives way to the pick itself, with its date and his words; if he picks
anything else, neither this addendum nor the 33 "Superseded 2026-10-01" notes above merge as
they stand). A is also the "wrapping fit" the canvas addendum named as the lever if the stack
proved too tall, taken for every mount at once.

**What it is now.** One paragraph, in
[components/primitives/display-shelf.tsx](../../components/primitives/display-shelf.tsx).
`[data-shelf-lines]` is a `flex-wrap` box and each setting (`[data-clause]`) is one item of it,
in the menu's order, so the settings wrap BETWEEN one another as words do. A filter is one item
whose values wrap inside it only once it is wider than a whole line (`inline-flex min-w-0
max-w-full flex-wrap`), so its values break apart only when they must. A phrase longer than a
line ellipsizes, and so does a value's name. Nothing is measured: no ResizeObserver, no probe or
sample, no `data-fit`, no `[data-line]`. In the shipped look, the usual three settings (the
Heights table's) take one line on the canvas, in the braindump and on the phone's Today card at
their usual widths, and everything on three or four lines where the stack took five or six;
Terminal's wider face and a coarse pointer's in-flow ✕s can take more (below).

**Locked decisions:**

- **Three spacings, glyph to glyph, and the eye groups by them.** On a fine pointer: 20px from
  one phrase to the next (`gap-x-[19px]` on the paragraph, plus the words' 1px of padding), 16
  between a filter's values (`gap-x-[15px]`, plus the 1px), and 28 at a seam. Where nothing
  hovers they are measured from the in-flow ✕ instead: 16, 10 and 24, the stack's own 16 and 10.
  Every one is px, and so are the ✕, Reset and the room before Reset: the 11px type ignores the
  browser's font-size setting, so a rem gap would spread the settings apart under a larger
  default font and, under a smaller one, put a drawn ✕ on the next value's glyph. The priority
  dot and its gap to the name stay in rem (`size-2`, `gap-1`), but they sit inside the words a ✕
  is placed from, so they carry the ✕ with them.
- **A seam sets a filter apart** from whatever is on either side of it, so the sort never reads
  on into "● High ● Medium" and one filter's values never run on into the next's: `mr-[8px]
  shrink-0` on every setting but the last where it or the next one is a filter, and never
  between two phrases (grouping, ordering, type, Hide finished), which read apart by their lead
  words and their 20px. A margin on the setting before, not a gap, so a line never starts
  indented; never shrunk, so a filter as wide as its line hangs the 8px past the line's end
  rather than take them from its values. A margin still counts at the end of a line, which is
  the seams' cost (below).
- **Lines are 5px apart in every mode**, on the paragraph and inside each filter's run
  (`gap-y-[5px]`). Where a ✕ is in flow (the phone, a coarse pointer), that is the reach it takes
  above and below itself, so no ✕'s reach lies over the next line's words. On a fine pointer,
  where a ✕ has no reach, the same 5px keeps the stack's 23px line pitch, so a line costs the
  same whatever the pointer (where the lines break still differs: an in-flow ✕ takes room). A
  line is 18px, so each one after the first costs 23px, as each line of the stack did.
- **On a fine pointer a ✕ is drawn only while its own setting is under the pointer, or while the
  ✕ has keyboard focus**, so at rest the shelf is words alone. It takes no room: it is out of
  flow (`absolute left-full top-0`) in the gap after its setting, 1px off the last glyph, and the
  gaps above are sized around its 14px. At rest it is `text-transparent` AND
  `pointer-events-none`. The gaps are the opener's ground, so a click aimed between two settings
  opens the menu, and a ✕ that was not drawn when the pointer arrived cannot be hit. Its setting
  under the pointer (`group-hover/unit:`) or keyboard focus (`focus-visible:`) gives it ink and
  hits together. Its box touches its setting's, so a sweep from the words onto the ✕ keeps both
  lit with no dead ground to cross, and the words' 1px of padding keeps the hit boundary off the
  last glyph (Chromium snaps a fractional edge up to half a pixel in), so a click on a name's
  last pixel opens the menu. The last ✕ on a line hangs into the shelf's right inset (15px in the
  sidebar, 14 on the canvas), so nothing between a ✕ and the shelf's edge may clip, and a test
  walks up from each ✕ to check. Tailwind compiles its hover variants under `(hover: hover)`, so
  on a tablet a tap never leaves a ✕ or a setting's ink stuck on.
- **Each phrase and each value is a unit** (`group/unit`), and takes the pointer where the
  stack's words let it through to the opener. A click on its words opens the menu through the
  same handle as the opener (`onClick={open}`), and it says what the opener did: the arrow
  (`cursor-default`), and no selection from a drag, a double-click or a long press
  (`select-none`). The words stay aria-hidden (`data-chip-label`). On a fine pointer a unit's
  words take full ink while it is under the pointer or its ✕ has keyboard focus
  (`group-hover/unit:text-foreground group-has-[:focus-visible]/unit:text-foreground`); the lead
  words keep their muted ink, and the phone lights nothing. A ✕'s click stops propagation, so
  taking a setting off never opens the menu too.
- **Where nothing hovers, every ✕ stays drawn, in flow.** The phone mount (`touch`) puts each ✕
  4px after its words (`relative ml-[4px]`), with the 25 × 28px reach of 2026-09-26 (4px left,
  7px right, 5px up and down) and no tooltip. The desktop mount takes the same under a coarse
  pointer, a tablet on the desktop shell, from the stylesheet alone: literal `pointer-coarse:`
  classes put the ✕ back in flow, drawn and hit, with the same reach, drop the words' 1px, set
  the phone's gaps and give the opener and Reset their 28px, so a tablet never paints a frame of
  the pointer's layout first.
- **Focus is drawn inside the control**, a 1.5px line in the app's ring colour (only the shape
  changes): 2px in on a ✕, so it clears the words to its left and the next value's glyph to its
  right, and on its own edge on Reset, which has room around it.
- **Reset display is a ↺ at the end of the last line, from four ✕s.** It is the menu row's own
  glyph (`RotateCcw`) and the menu row's own function (`resetDisplay(surface)`), so it reads as
  an action wherever the wrap leaves it, never as one more setting's ✕. It shows while the
  settings wear more than three ✕s between them, one per phrase and one per value. With one it
  would be that ✕ twice (the end ✕'s old rule); with two or three, the ✕s, or the menu and its
  Reset row, clear the lot in two or three clicks, and the glyph would push three settings onto a
  second line in Day × List's capsule, the narrowest. After a phrase it shares one unbreakable
  span with that phrase (`inline-flex … grow`, the TAIL), in a slot pushed to the line's end
  (`ml-auto flex shrink-0`) with 23px before it on a fine pointer (24 from the words, 9 clear of
  the drawn ✕) and 16 past an in-flow ✕, so after a phrase it never takes a line alone. After a
  filter the slot is the run's last item, 8px (6 in flow) on top of the run's own gap, and may
  wrap alone rather than take the last value with it. Its click stops propagation, moves focus to
  the trigger FIRST (the reset unmounts the shelf under the pressed button, as before), then
  resets. On a pointer it wears the "Reset display" `RailTooltip`, which lets a click through as
  the ✕s' tips do; on the phone, no tip, and a 28px reach around its 16 × 18px.
- **Unchanged:** it renders exactly when the trigger's dot is lit (`useDisplaySummary`). The
  opener is still the button under the words (`absolute inset-0`), named by its own sr-only copy
  of the text (`clauseText` joined with "; "), described by the hidden node, with `aria-haspopup`
  from `useIsMobile()`. Each ✕ takes off just its own setting or value through
  `removeDisplaySetting`, named by `removeLabel`, and hands focus on first (the next ✕, else the
  one before, else the trigger, never Reset); a held Enter is cancelled. The sidebar keeps its
  `floor`, the canvas its `contain-inline-size`, and the tips their pass-through. Nothing in the
  shelf carries an opacity or a transition, so the lime data glyphs stay at full strength at rest
  and under the pointer; an undrawn ✕ is a colour (`text-transparent`), never an opacity
  (forced colours excepted: see the gotchas).

**What it deleted, and why that is a win.** The measured fit, whole: `data-fit` written on the
root behind React's back and every `group-data-[fit=stack]/shelf:` rule keyed off it;
`shelfLines` and its `[data-line]` spans; the one-line measure (`measureLineWidth`, `applyFit`)
in a layout effect keyed on the full text; the `document.fonts.ready` re-measure, per text, for a
subset that landed after it; the ResizeObserver on the zero-height probe and the "Hide finished"
sample, with its frame-deferred compare and its rule never to write inside a delivery; the
`typeof ResizeObserver` guard; and the clipping lines box with its `py-[5px]`/`-my-[5px]` pair.
All of it answered one question, does the text fit on one line, which wrapping never asks: CSS
lays the paragraph out again on every width, every font load and every text-spacing or zoom
change by itself, in the same layout pass. So there is no frame in the old fit after a sash drag,
no face the sample could not hear, no hidden 0-wide shelf to skip, and nothing that resizes the
hour grid's viewport from inside an observer's delivery, which is what raised "ResizeObserver
loop completed with undelivered notifications" under the canvas header. The shelf's height still
follows its content and the grid still re-fits to it, through ordinary layout. The tests'
`getBoundingClientRect` stub and hand-delivered observer went too: "the paragraph" in
`tests/unit/display-shelf.test.tsx` and the canvas suite now assert the opposite, that the shelf
makes no observer, reads no layout (no rect, size, offset or computed style), waits on no font
and writes no `data-fit`, `[data-line]`, probe or sample, and read the layout's rules off its
classes.

**Heights**, measured in Chromium in that harness at default fonts in the shipped look (Paper)
on A's mockup, and checked again on the shelf as built, under all six themes, on 2026-10-01,
where its heights matched the mockup's: the shelf in px, the stack's in brackets. The canvas is
the Day header capsule at 1440×900, the braindump the sidebar at 406px and at its 280px minimum,
the phone 390×844. "Everything on" is Grouped by Project, Sorted by Priority, High and Medium,
Work and Home, one goal and Hide finished, with Showing Tasks on the canvas; "stress" has all
four priorities, five projects and two goals.

| Where | State | Paragraph (stack) |
|---|---|---|
| Canvas, Day × List | one setting; two | 23 (23); 23 (23) |
| Canvas, Day × List | three: Grouped by Project · Showing Tasks · Hide finished | 23 (69) |
| Canvas, Day × Schedule | everything on | 69 (138) |
| Canvas, Day × List | everything on | 92 (not measured) |
| Canvas, Day × Schedule | stress | 92 (156) |
| Braindump, 406px | three: Grouped by Project · High · Hide finished | 29 (29) |
| Braindump, 406px | everything on | 75 (121) |
| Braindump, 280px | three | 52 (75) |
| Braindump, 280px | everything on | 98 (139) |
| Braindump, 280px | stress | 167 (193) |
| Phone, Today card | three, as on the canvas | 19 (65) |
| Phone, Today card | everything on | 88 (134) |
| Phone, Braindump tab | everything on | 75 (121) |

The first line is 23px on the canvas, 29 in the braindump and 19 on the phone's Today card (their
insets; the phone's Braindump tab keeps the braindump's 29), and each line after it 23, so the
canvas header row is 162px with one line and 208 with everything on in Day × Schedule, which is
what the usual three alone cost on the stack. Heights follow the theme's face: in Terminal
(monospace) the canvas's three take two lines (46px) and the 280px braindump with everything on
144, while Studio and Sorbet fit the 406px braindump's everything on in 52.

**Accepted, not fixed:**

- **The seams cost room, and can add a line.** A margin counts at the end of a flex line too, so
  a seam can wrap the setting that carries it a line sooner than a plain gap would. With
  everything on, the braindump is 98px at 280 and 75 at 406, where a variant with plain 20px gaps
  and a hairline at each seam measured 75 and 52.
- **One place is taller than the stack.** On a touch tablet in portrait (820×1180, the desktop
  shell under a coarse pointer, the sidebar at 280px) the braindump with everything on is 144px
  against the stack's 139, six lines: every ✕ is in flow there, and "Sorted by Priority" wraps
  alone on its own seam's 8px.
- **After a filter, Reset can take a line alone**, when the run fills its line: five projects at
  406px stay on one line and the ↺ goes below it, 23px more. After a phrase it never does. That
  breaks the round-3 page's "No × or reset ever floats on a line of its own", which the build
  keeps for every ✕ but for Reset only after a phrase.
- **The fold re-wraps above the floor.** Collapse and hover-peek from a sidebar wider than its
  minimum re-wrap the paragraph a line at a time between its rest width and the 260px floor, so
  it grows as the column narrows for the 300ms of the fold (everything on from 406px: 75px at
  rest, 98 at the floor), where the fit flipped a one-line shelf once. At the 280px minimum
  nothing moves.
- **Where a setting lands depends on the width.** The same settings wrap differently at 406 and
  at 280px, where the stack always put grouping and ordering on the first line and each filter on
  a line of its own. The order never changes.
- **With a mouse a ✕ is found by pointing.** Nothing says a setting is removable until it is under
  the pointer, and a click where an undrawn ✕ would be opens the menu, a safe miss. A touchscreen
  laptop's primary pointer is fine, so a finger there gets no drawn ✕ and a tap opens the menu,
  from which anything comes off. A fine pointer that cannot hover at all (a basic stylus screen)
  never draws one outside keyboard focus, since `group-hover/unit:` compiles under
  `(hover: hover)` and `pointer-coarse:` does not match it; its words still open the menu.
- **Taking a setting off re-wraps the paragraph**, so after a click the next ✕ is seldom under the
  pointer. The keyboard's walk from ✕ to ✕ is unchanged.
- **Touch still draws every ✕**, so the phone, a tablet and a touch-first screen look busier than
  a desktop with a mouse.

**What no longer holds above.** Every paragraph or bullet in the earlier shelf addenda that this
changes now starts with an italic "Superseded 2026-10-01" note saying what changed, and nothing
was deleted. The 2026-09-25 addendum's one line or stack, its fit and every gotcha the fit brought
(the measure, the probe and sample, the observer and its delivery rule, the jsdom stub) are
history, as are the canvas addendum's stacking heights and counts and its own delivery rule.
Above, "the reset ✕" and "the end ✕" name what is now Reset display's ↺, which comes and goes
with a fourth ✕. What still binds: everything above that carries no Superseded note, and
whatever each note leaves standing of what it heads; among it the model and its invariant, the
handle and the focus rules, the per-setting ✕s and their removal, the opener's name and
description, the loaded gate, Goals' Target, the lime rule, no live region or heading, the
trigger's held-key guard, the menu's folded untick, the floor, containment, the tips'
pass-through, and the `<main>` hook's rules (only its shelf figures are the stack's).

### Gotchas from the paragraph

- **A ✕ must touch its setting.** It is drawn and hit only while its unit is hovered, and a hover
  ends where the unit's box does: a ✕ set off by a margin would go undrawn and unhittable as the
  pointer crossed the gap, and could never be reached from its words. So it sits at `left-full`,
  and the words' padding, not a margin, keeps it off the last glyph.
- **Clear ink is not hidden.** A `text-transparent` ✕ still takes clicks, so at rest it needs
  `pointer-events-none` as well, and the hover and `focus-visible:` rules must give back ink and
  hits together. A test pins all four on every ✕, with no plain ink or plain
  `pointer-events-auto` beside them to outrank the rest.
- **Forced colours draw clear ink.** In forced-colors mode (Windows High Contrast) the browser
  swaps `text-transparent` for a system colour, so a ✕ that is clear at rest is drawn there,
  and `pointer-events-none` then refused a click on a ✕ the user could see: the pointer moved
  onto it from the gap reached the opener, and the menu opened (measured in Chromium with
  forced colours emulated, 2026-10-01). `forced-colors:pointer-events-auto` lets a drawn ✕ take
  its click at rest, as a coarse pointer's does, so ink and hits stay together there too; a
  test pins it.
- **Focus and hover together take full ink.** `focus-visible:text-muted-foreground` comes after
  `hover:text-foreground` in the compiled sheet with the same specificity, so a focused ✕ under
  the pointer stayed muted where the old ✕ went to full ink.
  `hover:focus-visible:text-foreground` outranks both.
- **A coarse pointer's ✕ goes in flow, not in the gap.** The first cut drew every ✕ and let it
  take hits under a coarse pointer, but left it where a fine pointer's sits, out of flow in the
  gap and 1px from the next value's glyph: finger taps 1 to 3px left of "Medium" or "Home" took a
  setting off 5 times in 10. In flow, 4px after its words, with the phone's reach and the gaps
  measured from it, none did.
- **The `pointer-coarse:` classes are written out whole**, every one, because Tailwind builds only
  the class names it finds literally in the source. A variant assembled at runtime would never
  reach the stylesheet, and a tablet would get the pointer's layout, whose ✕s it could never draw.
- **jsdom lays nothing out**, so "the paragraph" asserts the classes each rule rests on:
  `flex-wrap` on the paragraph and `min-w-0 max-w-full flex-wrap` on each filter (without
  `max-w-full` a filter never stops at the line's width to wrap its values), `truncate` on every
  name, `shrink-0` on every ✕, the seam on exactly the settings that need one, and no indenting
  margin on any.
- **On a pointer a ✕ cannot be clicked cold.** It takes no hit until its words are under the
  pointer. A Playwright locator's `click()` on one cold never fires: its hit-target check finds
  the opener at the ✕'s centre (or the shelf's own inset, for a ✕ hanging past the paragraph),
  logs "… intercepts pointer events" and retries until it times out. `force: true` or
  `page.mouse.click` at its coordinates skips that check and clicks whatever is there, which over
  the paragraph is the opener: the menu opens and nothing comes off. Hover its words first and
  then move onto the ✕, as a user does. The words themselves now take a locator's `hover()` and
  `click()`.

**Manual QA states:** 1440×900, the canvas in Day × Schedule and Day × List and the braindump at
406px, light and dark: one setting, three, and everything on (the heights above, and nothing but
words at rest); the pointer onto each setting's words (they go to full ink and its own ✕ appears
1px after them, no other) and on along onto that ✕ (it stays drawn, "Remove" shows, and a click
takes just that one off and opens nothing); the pointer onto a ✕'s place from the gap or the line
below, not through its words (nothing drawn, and a click there opens the menu); a click on a
name's last pixel and in a gap (each opens the menu); Tab from the text through every ✕ to Reset
(each ✕ drawn while focused, its words at full ink, its ring inside it), Enter on each in turn
(focus walks on, never to Reset, which goes at three, then lands on the trigger), a held Enter
(one setting off), and Reset by mouse and by Enter (the shelf goes, focus lands on the Display
trigger, nothing opens); four ✕s ending in a phrase and four ending in a filter (Reset ends the
last line, and after a phrase never sits alone); the 280px sidebar with everything on and with
every value of every filter (settings wrap between one another, a filter's values only between
theirs, each ✕ with its own value, a long project name ellipsizes), and collapse and hover-peek
there (nothing moves) and from 406px (the paragraph re-wraps down to the floor and no further);
a tablet-width coarse pointer, the desktop shell at 820×1180 and 1180×820 with touch (every
✕ drawn in flow 4px after its words and over none, a tap on a name opens the menu and a tap on a
✕ takes it off, and no ink left behind after a tap); dark mode, Night and Terminal (the Low dot
and a lime project square at full strength at rest and under the pointer, an undrawn ✕ leaves no
trace, and Terminal's wider face wraps sooner); forced colours (DevTools, Rendering, Emulate CSS
media feature forced-colors: active) with the pointer moved onto a ✕ from the gap (every ✕ drawn
at rest, and a click on one takes its setting off and opens nothing); the browser's default font size raised (Chrome:
Settings, Appearance, Font size) with the pointer on a value (its ✕ still clear of the next
value); a text-spacing bookmarklet (the paragraph re-wraps, nothing clips); dates paged in Day ×
List with a window `error` listener attached (the paragraph re-wraps as the date moves the
capsule, and nothing is raised). A 390×844 phone, the Today card and the Braindump tab: three
settings on one line and everything on (every ✕ drawn, no tooltips); a tap on each setting's
words, at its start and at its very end (each opens the sheet), and on each ✕ (just that one
comes off); a filter whose names wrap onto a second row, with a tap on the top and bottom of each
name (each opens the sheet: the 5px between rows); Reset from four ✕s (the shelf goes, focus
lands on the Display icon) and Reset display from the sheet.

## Related

`unified-items.md` (the registry this extends), `organize-console.md` (shares Phase B),
`overlap-blocks.md` (the pass lanes nest into), `programs-routines.md` (durable hiding, and
the scope-rail retirement that moved these switches here).
