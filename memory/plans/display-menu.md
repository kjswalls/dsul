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
menu's colour squares; No project is the ring), the goal values (lucide `Target`), and
"Hide finished" last. Values follow the menu's rows, never the order they were toggled in;
a value the store cannot resolve (a deleted project, a goal id nothing answers to, a string
no Priority row offers) comes after the rest, in the order it was stored. It is there
exactly when the trigger's lime dot is lit, in the sidebar and in
the phone's Braindump tab alike, so a braindump with nothing set keeps the bare capsule.
Clicking the text opens the Display menu; the ✕ beside it resets. The dot says THAT the list
is shaped and the shelf says how, and one case makes it more than a convenience: a filter
that matches nothing leaves the list showing its "A clear head." empty-state poem, and the
shelf is then the only thing on screen that says why. The component is
[components/primitives/display-shelf.tsx](../../components/primitives/display-shelf.tsx). It
hangs in SurfaceHeader's `below` slot, which renders straight after the pill with no
wrapper, so a header that passes nothing (Beacon's) is unchanged and the pill stays the
capsule's first child.

**It sits IN FLOW, which is why it is the braindump's and not the canvas's.** The canvas
header stands over an hour grid that derives its row height from the column's remaining
height, so a shelf there would re-scale every hour row as the first filter went on. The
braindump's header stands over a scrolling list, which only starts scrolling a line sooner.
The model supports a canvas shelf; none is mounted.

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
  last setting. An opening through the trigger itself clears the record, since a trigger
  can reopen a menu still playing its exit, whose close never reached its focus return. So
  does a right- or ctrl-click outside, mirroring Radix's own rule that such a click leaves
  focus where it lands.
- **Fit is imperative, and it is not state.** Whether the text fits changes on every frame of
  a sash drag, and React never hears about that: the column resizes through `--sidebar-w`
  precisely so the braindump does not re-render. So the shelf writes `data-fit` on its own
  root, React never renders the attribute, every stack rule keys off
  `group-data-[fit=stack]/shelf:`, and with no attribute the one-line layout applies. The
  one-line width is MEASURED: force `line`, then take the span from the first `[data-line]`'s
  left edge to the last one's right (not `scrollWidth`, which clamps to `clientWidth` whenever
  the content fits). That happens in a layout effect keyed on the FULL text, and again, per
  text, when `document.fonts.ready` settles: a late font swap resizes nothing the probe could
  hear, and a new text can ask for a subset the page has not loaded (a Cyrillic goal name
  landing with the planner), which the layout effect measures in the fallback face. Keying on
  the full text rather than the clause labels is what re-fits when a value joins a
  multi-select that is already showing. A resize only COMPARES: a ResizeObserver on a
  zero-height probe (`absolute inset-x-0 top-0 h-0`, whose size is the root's width and never
  the fit's) re-applies the cached width against the lines box. Its one exception is to
  measure once when the cached width is still 0, for a shelf that mounted where nothing was
  laid out. The same observer watches the `[data-line]` spans. A line that resizes in a
  delivery the probe is not part of resized with the column standing still, so its text
  changed size with its string unchanged (a WCAG 1.4.12 text-spacing override, text-only
  zoom, a late font), and that re-measures a frame later, outside the observer's delivery,
  in either fit: a shelf stacks when an override widens its text, and goes back to one line
  when the override comes off. A drag resizes the probe on every frame, and a stacked shelf's
  lines with it in the same delivery, so a drag only ever compares. The comparison allows one
  layout unit (1/64px) and no more: nothing on the one line truncates, so any overflow is a
  glyph cut off with no ellipsis, and neither side of the comparison depends on the fit, so
  there is no oscillation for a wider margin to damp.
- **The sidebar mount has a width floor, `SIDEBAR_MIN_WIDTH - 20` (260px).** Collapse and
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
- **The phone's targets are 28px, through a `::before` hit area** (the header's existing
  idiom) on the BUTTONS. The clipping `overflow-hidden` is on the lines box inside the opener,
  so it never cuts the reach off.

### Gotchas from the shelf

- **jsdom reports every width as 0, so the fit is always `line` there** (`0 > 0 + 1/64` is
  false). That is deterministic, and useless for testing a stack.
  `tests/unit/display-shelf.test.tsx` stubs `Element.prototype.getBoundingClientRect`, giving
  the lines box a chosen width and laying the `[data-line]` spans out in whichever fit the
  root holds as they are read (end to end on one line; each at 0, no wider than the box,
  when stacked, so a measure that forgot to force the one line reads the stack), and
  restores it after each case. It delivers the shelf's observer by hand, finding it by the
  probe it watches, because dnd-kit builds observers of its own around the braindump.
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
- **Never measure inside the observer's delivery.** Forcing the one-line layout there starts a
  measure, resize, measure loop, and the "ResizeObserver loop" errors it raises land on every
  other observer on the page. The observer compares; a change of text measures, and so does
  the frame the observer schedules when a line resized with the column standing still.
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
shelf on one line (it stacks rather than clip).

## Related

`unified-items.md` (the registry this extends), `organize-console.md` (shares Phase B),
`overlap-blocks.md` (the pass lanes nest into), `programs-routines.md` (durable hiding, and
the scope-rail retirement that moved these switches here).
