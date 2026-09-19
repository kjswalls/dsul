# Item surface growth — dialog → panel → page

Direction approved 2026-07-29. Design study (interactive scrim/position lab + specimens):
https://claude.ai/code/artifact/78950192-5a7b-4ce8-93ad-2f9f6add5703

The item surface grows in place rather than multiplying: the capture dialog stays a
two-second command, a right-docked panel becomes edit's home, and a full page carries the
item when it is the day's actual work (subtasks, activity, an agent's running progress).
All three sizes render the same `ItemDialogState` and write through the same save
adapters — growth is a presentation, not a fork.

## Locked decisions

1. **Frost scrim (on trial, 2026-07-29).** Dialog + drawer overlays:
   `bg-scrim backdrop-blur-[7px] backdrop-saturate-[1.1]`, where `--scrim` is only a
   faint ink-hued tint (light `oklch(0.22 0.012 272 / 12%)`, dark `oklch(0 0 0 / 30%)`).
   **AlertDialog keeps `bg-black/50`** — destructive confirms earn the heavier curtain.
   Watch-points: compositing cost over the fit-to-height grid, and the vaul drawer
   animating under live blur on mobile. If it janks, the previously-shipped self-veil
   values are the fallback: light `color-mix(in oklab, var(--paper-0) 55%, transparent)`,
   dark `oklch(0.13 0.008 264 / 55%)`, no backdrop-filter.
2. **Capture at the top.** The item dialog sits at `top-[14vh]` (className override on
   ResponsiveModalContent; tailwind-merge drops the primitive's centered pair). Mobile
   drawer unaffected.
3. **Edit's eventual home is the panel** — right-docked over the canvas, no scrim; the
   page (`/item/[id]`) is for deliberate sessions and is deep-linkable so Beacon can
   answer with a URL. Until the panel ships, edit stays in the dialog.
4. **Identity is a square, a value is a dot.** Type/container color squares come from
   `ItemTypeConfig.accent` / `getProjectColor` / `getHabitGroupColor`; user-chosen colors
   are `var(--accent-N)` tokens picked via `ColorSwatchPicker` ("Auto" = clear → name-hash).
5. **Registry gates the new sections as config, not code paths** — capability flags
   (`subtasks`, `agentAssignable`) join the existing capability list.
6. **Contracts carried from unified-items.md:** any new item field lands in
   `packages/types` first, *optional*, then its committed dist is rebuilt (the OpenClaw
   plugin safeParses and throws on drift; CI gates dist-matches-src). New webhook event
   names silently never deliver — agent progress rides `tasks.updated` or extends the
   plugin registration *and* `DsulChangeEventSchema` in lockstep.
7. **The layout is a registry question too (locked 2026-08-27, Phase 10; still
   holds).** Which container kinds an item may join, their order and their labels
   are derived from `CONTAINER_KINDS` — role for the order and the gating, kind for
   the noun. A list written out by hand is the defect this replaces, and the fifth
   kind is the test of it: it must arrive with no edit to a component. Its CONTROL
   is the one thing that cannot be derived, so `bandControls` in item-dialog.tsx is
   a full `Record<ContainerKind, …>` — the compile error that stops a new kind
   reaching the field with nothing behind its name. Phase 11 raised the stakes on
   the noun rather than lowering them: with no band label beside a chip, the
   registry noun is the ONLY thing naming an unset control.
8. ~~**An empty band renders; a missing capability does not (locked 2026-08-27).**~~
   — **narrowed 2026-09-18, Phase 11.** It still governs `/item/[id]`'s
   `ContainerBandsReadout`, where an empty row is a way in. On every surface you
   EDIT on it is reversed: an unset property is absent, folded behind one seed. The
   rule cost most exactly where it was least true — the capture modal, where
   nothing is set yet, so "the shape is what the item CAN be" drew the whole
   ladder empty. The gate exception (nothing to join, no console to open) survives
   both readings, because it is a door rule, not a content rule.

## Phase ledger

- [x] **Phase 0 — Scrim, placement, category color** (shipped 2026-07-29).
      `--scrim` token + `bg-scrim` on dialog/drawer overlays; item dialog `top-[14vh]`,
      `max-h-[80vh]`; `Project.color` plumbed end-to-end (schema → db.ts → store, stored
      color wins over name-hash in `getProjectColor`); `ColorSwatchPicker` rows in all
      three manage-categories tabs (projects / groups / types — the latter two were
      already plumbed, only the UI was missing).
- [x] **Phase 1 — The panel** (shipped 2026-07-29). Edit mode of the item dialog is the
      right-docked panel: a className override on ResponsiveModalContent
      (`inset-y-3 right-3 …` — tailwind-merge drops the centered base) plus a new
      `overlayClassName` passthrough (dialog.tsx → responsive-modal) that makes the
      panel's scrim transparent. Add mode stays the top-[14vh] dialog. Overlays the
      canvas — no reflow, fit-to-height untouched. Mobile keeps the bottom drawer.
      New ⤢ "open as page" button in the edit header.
- [x] **Phase 2 — Subtasks** (shipped 2026-07-29). Four fields woken end-to-end:
      `taskShape` (optional → auto-enrolls TASK_FIELDS → undo diffing) → dist → db.ts
      (ItemRow, three mappers, task update allowlist) → registry `subtasks` flag →
      SubtasksSection in `item-detail-sections.tsx`. Subtasks are excluded from the
      `tasks` projection (invisible in braindump/buckets/schedule/EOD); `items[]` still
      carries them. Parent delete cascades (explicit soft-delete of children).
- [x] **Phase 3 — Activity** (shipped 2026-07-29). Migration **023_item_events** applied
      remotely and ledger-aligned to version `023`. Write-through in db.ts
      create/update/delete (fire-and-forget; availability flag goes quiet if the table
      is missing). ActivitySection renders the last events, hidden when empty.
      Known gap: `set_item_completion` RPC bypasses updateItem — completion toggles
      produce no events yet.
- [x] **Phase 4 — Agent assignment** (shipped 2026-07-29, transport-lite).
      `assignee`/`aiStatus`/`aiResult` live end-to-end; AgentSection assigns/unassigns
      (honey styling); agents can PATCH them via the task update API (aiStatus strictly
      `queued|working|done|failed` on writes, loose on reads so future vocabulary can't
      brick old plugin parses). No push transport: progress lands when the agent PATCHes
      and the app refetches.
- [x] **Phase 5 — Per-item threads** (shipped 2026-07-29, client-persisted).
      chat-store is now a factory: `itemChatStore(id)` gives each item its own transcript
      (`dsul-item-chat-<id>`, 24h TTL) and OpenClaw sessionKey (`dsul-item-<id>` —
      the plugin passes client sessionKeys through verbatim, zero plugin changes).
      `buildDsulContext` gained `focusItemId` (a "### Focused item" section; base
      output byte-identical). Server-side thread persistence deliberately deferred.
- [x] **Phase 6 — The page** (shipped 2026-07-29). `/item/[id]`: client route, static
      chips + ItemDetailSections | ItemThread columns, Edit opens a locally-mounted
      ItemDialog (the shell's instance lives in AppShell, which this route doesn't
      render). Client-side auth model, sign-in link on the not-found state.
- [x] **Phase 7 — Notes** (shipped 2026-07-30). `notes` had existed in
      `packages/types`, the db mappers, the update API and the Beacon context since
      unification, with **no UI anywhere** — the same dormant-column shape as Phase 2's
      four. Added to `ItemDraft` (seed, carry-across-type-switch, all four save adapters)
      as a borderless auto-growing textarea under the chips, plus a read-only rendering
      on `/item/[id]`. `TASK_FIELDS`/`HABIT_FIELDS` are schema-derived, so
      `config.fields.includes('notes')` gated it with zero registry work. The focused-item
      context line moved out of the non-habit branch: habits carry notes too.
- [x] **Phase 8 — The non-modal panel** (shipped 2026-07-30). Desktop edit is a bare
      `<aside>` laid out as a THIRD FLEX SIBLING after `<main>` in `desktop-shell.tsx`, in
      a wrapper whose width animates 0↔420px — so opening it **compresses** the canvas
      instead of covering it (the braindump collapse is the same mechanic). Under 1180px
      the wrapper goes `absolute` and overlays instead: there is no day left worth
      compressing once panes cross the ~200px wrap threshold. Mobile keeps the drawer;
      add stays the top-[14vh] modal. `ItemDialog` gained `presentation: 'modal' | 'panel'`
      and three wrapper components (`SurfaceRoot`/`SurfaceContent`/`SurfaceHeader`) that
      swap Radix for the `<aside>` while the body JSX stays shared — the split is at the
      wrapper, so growth stayed a presentation and not a fork. Deliberately **not**
      `role="dialog"`. `/item/[id]`'s Edit uses the panel too (a modal there made the
      page's own subtasks and thread inert behind an invisible overlay).

      **Selection is the ui-store's dialog slot.** No new selection store: `openEditFor`
      already replaces the single `activeDialog`, so clicking another row retargets the
      one panel for free. The slot's payload is now only an ADDRESS — the surface
      re-resolves the item from the store every render and re-seeds the draft only when
      the **id** changes (identity would re-seed on the panel's own autosave and eat
      keystrokes). When the item moves under an open panel and nothing is queued, the
      draft follows it.

      **Autosave, and why it is scoped.** No Save button (the footer button is "Done").
      Picked values commit after 500ms; typed ones (title/notes) commit on blur with a
      4s backstop, because *every* commit that changes anything pushes a deep clone of
      the whole `items` array onto a 50-entry undo stack — a save per typing pause would
      spend a session's history recording one sentence. Writes carry **only the fields
      touched in this panel session** (`taskUpdatesFromDraft`/`habitUpdatesFromDraft`,
      pinned in tests/unit/item-panel-writes.test.ts). That is the load-bearing rule: the
      canvas behind the panel is live, so a whole-item write would silently revert a drag,
      a resize, an undo or an agent write on the next keystroke. The modal passes
      `DRAFT_KEYS` and keeps its original whole-item save.

## Deferred decisions (made provisionally 2026-07-29 — revisit)

1. **`aiStatus` vocabulary** — `queued | working | done | failed`, enforced only on agent
   writes. Becomes a frozen external contract the moment a real agent writes it.
2. **Subtasks are invisible outside their parent** — excluded from the `tasks`
   projection wholesale. "Schedule a subtask on the grid" is explicitly out; revisit if
   wanted. They DO still appear as plain tasks in the agent context `tasks[]` (items[]
   carries `parentItemId` for smarter clients).
3. **Subtask ordering** — creation order (`created_at`), no manual reorder.
4. **Parent delete cascades to subtasks** (explicit soft-delete; undo restores both).
5. ~~**The edit panel is modal**~~ — **resolved 2026-07-30, Phase 8**: it is non-modal and
   compresses the canvas. What that cost: autosave (no moment of commitment), scoped
   writes (the canvas can change the open item), a live-following draft, and Escape that
   only claims the key from inside the panel.
6. **Assign-to-agent writes fields only** — it does not notify OpenClaw; the thread is
   how you brief it. Real dispatch needs a transport decision (locked decision 6).
7. **Threads are localStorage-only** (24h TTL, per item). `item_messages` server
   persistence deferred — first stored chat data deserves its own review.
8. **Legacy projections now carry the four fields when set** (rest-spread projections).
   Additive-optional, old plugins strip unknown keys; if byte-exactness must return, the
   projections become pick-lists. Note: the agent-context `tasks[]` includes subtasks as
   ordinary tasks (the plugin can't distinguish them without adopting `items[]`).
9. **Subtask display order can shuffle across reloads** — subtasks inherit
   `order = tasks.length` (a projection that excludes them), so their order values can
   collide and `fetchItems`' order-then-created_at sort may differ from append order.
   Harmless to visible tasks (reorderTasks skips them); fix together with #3 if manual
   subtask reordering ever lands.
10. **Completion toggles produce no activity events** — `set_item_completion` (RPC)
    bypasses updateItem. Additive fix later: record the event beside the RPC call.

- [x] **Phase 9 — Cheap wins** (shipped 2026-07-30).
      `aiStatus` gains **`blocked`** — a state that wants something *from* you, added
      while the vocabulary is still free (an independently-deployed agent writing it makes
      renaming a coordinated release; growing the set stays cheap forever). It gets the
      only loud chip in the agent block. Thread transcripts are capped at 100 messages and
      swept at boot — the 24h TTL only ran when a thread was *opened*, so threads for
      items you never revisit accumulated forever against an origin quota eight other
      stores share. `inert` on `<main>` while the panel overlays it (under 1180px), via a
      new `useMediaQuery` on `useSyncExternalStore` — a class can't drive an attribute.
      **⌘\\** focuses the panel (`workspace.focusItemPanel`, a ui-store focus token like
      the omnibar's), which is the keyboard's only way in given the panel deliberately
      never steals focus.

- [x] **Phase 10 — The bands** (shipped 2026-08-27, ticket D4).
      The chips stop being one flat wrapping row and become a stack of labelled
      BANDS: `When` over the schedule chips, then one band per CONTAINER KIND —
      Project, Routine, Program, Goal — ordered by the container registry's own
      ROLE order (classify → gate → aspire). Same rows, same order, same nouns on
      the edit panel and on `/item/[id]`. New: [lib/item-bands.ts](../../lib/item-bands.ts)
      (pure: what exists, in what order, and when) and
      [components/planner/item-bands.tsx](../../components/planner/item-bands.tsx)
      (what one looks like, plus the page's readout).

      **Why bands at all.** Every chip already asked the item registry whether it
      may exist — the house rule — but *nothing asked about order or grouping*,
      so Project (classify) sat beside Routine (gate) sat beside Goal (aspire) as
      five identical pills in source order, and the three roles
      [container-registry.ts](../../lib/container-registry.ts) spends four screens
      distinguishing reached the user as no distinction at all. The design study
      measured the rest: the chips were never the weight (a fresh account shows
      5–6, not 10), so this is a legibility change, not a diet.

      **Nouns, not role-verbs.** The study's Direction B labelled the bands
      "filed" / "gated by" / "serves". Kirby refused: *"Let's just use nouns like
      'program' and 'goal'"*. The verbs are true and they are also vocabulary
      nobody asked for. So a band's label is `CONTAINER_KINDS[kind].label` and
      nothing else — CLAUDE.md's rule that the user-facing noun lives ONLY there
      is what keeps a rename a string edit, and it is pinned by a test that
      compares every band's label against the registry record.

      **The role still decides everything a noun cannot.** It orders the bands,
      and it decides when one renders (`visibleContainerBands`, written per role,
      never per kind). Kind supplies the word; role supplies the behaviour.

      **Two gate kinds, two bands.** `gate` covers routine AND program, so a
      role-driven layout would draw one row. Three arguments for two, and the
      first is decisive: a merged band has no name the registry can supply, so it
      would need an invented literal — the exact thing the rule above forbids.
      Then: they are different questions (the item dialog already said so where
      the chips were declared — "which routine is this part of" vs "which stretch
      of life does this belong to"), and they are separate stores, join tables and
      write paths.

      **An empty band still renders** — Direction A's rule, kept while the rest of
      A was refused. A band with no memberships draws its chip's unset state, the
      dashed `+ Add` affordance the dialog already uses everywhere for "you may".
      So the surface's shape is what the item CAN be: it does not jump as you fill
      it in, and a band you have never used is still one you can find. Rejected
      alternatives: an em-dash or a greyed placeholder (both read as a half-loaded
      row, which is precisely the failure the rule exists to avoid), and hiding
      the band until used (that is what A traded discovery away for).

      **The one exception, and it is inherited.** A GATE band with zero containers
      AND the Organize console off does not render: its only content would be the
      "Organize routines…" door, and the dialog already deletes that door while
      the console is off because "a door that cannot open is not worth the row it
      costs". A band whose affordance opens an empty popover is the broken-looking
      state the empty-band rule exists to prevent. The aspire band has no such
      clause — its door rides EXT_GOALS rather than EXT_ORGANIZE, so it renders
      from zero, which is the argument the Goal chip already shipped with.

      **"Group" is stale vocabulary, and the registry is the arbiter.** Kirby's
      words were "nouns like 'program' and 'goal,' 'group'". There is no `group`
      kind any more — migration 039 folded habit groups into projects, leaving
      exactly ONE classify kind — so the band reads **Project**, which is what
      `CONTAINER_KINDS.project.label` says. If he wants the noun to be "Group"
      after all, that is a rename of the CLASSIFY kind rather than a band
      decision, and it is one string here plus the ~8 places 039 deliberately
      left spelling it by hand (listed in container-registry.ts). Flagged, not
      assumed.

      **What this does NOT change: the always-on empty sections.** The study's
      Finding 2 was that Subtasks, Agent and Thread render a heading and a
      control for every item, used or not. Under the empty-band rule that is no
      longer a defect to fix — it is the same rule, applied one section earlier.
      They stay, and Activity and the heatmap stay quiet-when-empty, because a
      feed with nothing in it offers nothing to act on.

      **Priority left the row.** It is neither a time nor a container, and a band
      of its own would have spent a labelled row saying "Priority" twice — once in
      the label, once in the chip's own unset state. It rides the identity line
      beside the type chip, in both shells. (The unset chips inside a band say
      "Add" rather than the noun for the same reason; the ACCESSIBLE name stays
      the noun, so a control read out of its row still says which band it is in.)

      **The page finally says where an item belongs.** `/item/[id]` rendered a
      project and nothing else: an item could sit in three routines, a program and
      two goals and its own page never mentioned it. It now renders the same bands
      as a READOUT, and an empty band's `+ Add` opens the editor rather than
      growing a second write path onto the page. Its `capitalize` on habit
      containers went with it — 039's argument (Tailwind's `capitalize` upper-cases
      every word, so "e2e tests" reads "E2e Tests") applies to one kind as much as
      it did to two.

      **Refuted: "bands make the doubling impossible to ship".** Direction B
      claimed the page's chips should BE the editable chips, deleting
      `withDetailSections` and the page's locally-mounted ItemDialog. Phase 6's
      own measurement kills it: that editor is a deferred chunk worth **90.3 kB
      gzip** of the route's first load, and it opens on a button press that most
      visits never make. Making the page's chips live would charge every read-only
      visit for the editor. So the page keeps a readout plus the panel, and the
      doubling SHRINKS (the two renderings are now the same bands in the same
      order under the same nouns) rather than disappearing. Still open, and now
      cheaper to close if it ever earns it.

      Also closed here: **focus restoration on panel unmount**, the strongest
      entry on the list below. The `<aside>` has no FocusScope, so closing the
      panel dropped the cursor on `<body>` and the next Tab restarted at the top
      of the document. The opener is captured on the closed→open edge (the panel
      RETARGETS without closing, so re-capturing would remember the third row you
      clicked) and restored only when nothing else has claimed the cursor.

- [x] **Phase 11 — Clearing** (panel + /item editor shipped 2026-08-28, #266;
      extended to the capture modal and the mobile drawer 2026-09-18).
      The labelled band ladder gives way to **one label-less field** of only the
      properties the item actually carries, with everything unset folded behind a
      single **"+ Add property"** seed. Serif title and notes, a quiet type
      whisper, and — on the autosaving surfaces only — Done in the top rail and
      the edit history collapsed into one expandable line in the footer.

      **Why the gate came off.** #266 shipped this gated on `clearing = isPanel &&
      mode === 'edit'`, leaving the add-capture modal and the mobile drawer on the
      bands deliberately — a redesign is cheaper to judge on one surface. Kirby's
      read of the surface it was held back from: *"The new task dialog has a lot of
      different empty rows for things you can add to the task or habit."* That is
      Phase 10's empty-band rule stated as a complaint, and the capture modal is
      where it is most obviously right: NOTHING is set on a new item, so a layout
      keyed on what the type COULD carry drew five labelled rows — When, Project,
      Routine, Program, Goal — between the title and the button, every one of them
      holding a single dashed "Add". Discovery was the rule's whole defence, and
      an empty band's bare "Add" never actually said what it would add. **The seed
      discovers BY NAME**, which is strictly more than the bands offered, in one
      chip instead of five rows.

      **What the field shows in add mode, which is not nothing.** The seed is not a
      diet: `makeAddDraft` seeds real values and they show at rest. A task captured
      from a day carries that date, so Date and Time are chips; a habit carries a
      required container (the first project), its default frequency and its daily
      count. A task captured with no date — from the braindump — shows the seed
      alone, which is correct: that item genuinely has nothing but a name yet.

      **`clearing` is gone; `autosaves` does the only asking left.** They were
      always the same boolean and always two different questions, and the flag
      that named the layout could not survive the layout becoming universal. What
      still differs between surfaces is PERSISTENCE, so `autosaves` is asked
      directly at the two places it decides something: the top rail carries Done
      (flush + close) only where there is nothing to submit, and Activity stays in
      the body wherever `ClearingFooter` is not there to fold it into its history
      line. The capture modal and the mobile drawer keep their Enter hint and their
      submit button — they have a moment of commitment and still say so.

      **The one thing `mode` still decides** is the identity mark. Add offers the
      type as a control (task vs habit reshapes the whole form); edit only whispers
      it, because converting an item is a data decision — streaks, completion
      history — not a control. Priority left the identity line for the field, where
      it is a property like any other: set, it is a chip; unset, it is a name in
      the seed. That reverses Phase 10's "Priority left the row", and for the same
      reason it was true then — a labelled row for Priority would have said the
      word twice. The field says it once, and only when it applies.

      **Caught in review, not shipped:** the desktop Dialog parks Radix's close X
      absolutely at `top-4/right-4`, straight through the header row's right end
      where "Open as page" and the overflow menu sit. The type-first header this
      replaced carried `pr-8` for exactly that; the unified header has to carry it
      too, on the desktop modal only — the panel has no such X, and vaul's drag
      handle is centered ABOVE the drawer's content, so it costs no width.

      **Two corners the rule bit, fixed on review (2026-09-18).** Both were
      live on the panel since #266 and only became universal here; both are
      "show what is SET" taken more literally than it should be.

      · **Emptying a property made its chip vanish from under the pointer.**
        Clear a date from inside the date chip and it fails `set`, `required`
        and `revealed` at once, so it unmounts — and the value you were about
        to replace is now two clicks away behind the seed. `clearProp` routes
        the "no value" options through the same `revealed` set the seed menu
        writes: deliberately emptying a property is the same statement as
        summoning one, so the chip stays put, empty, for the rest of the
        session. The Time chip still goes with a cleared date, and should —
        `showTime` is a capability question, not a value one.

      · **A goal that ended took its own explanation with it.** `endedGoals`
        exists for one sentence — "a still-scheduled milestone of a set-aside
        goal is otherwise a row with no explanation anywhere in the app" — and
        the chip's value read ACTIVE memberships only, so an item serving only
        ended goals showed no chip at all and the field deleted the very
        explanation that comment describes. The value now falls back to the
        ended names and MARKS them: `Ship v2 (ended)`, borrowing the word from
        the popover's own divider, because a bare name would read as a live
        membership and trade a missing explanation for a wrong one. Only the
        fallback is marked. This DIVERGES from `/item/[id]`'s readout on
        purpose: the readout draws its Goal band whether or not it holds
        anything, so an ended membership costs it no explanation there.

      **The bands are not deleted.** `lib/item-bands.ts` and
      `components/planner/item-bands.tsx` stay, and Phase 10's derivation is still
      the answer to "which containers may this item join, in what order": the field
      wraps into one row and the seed menu is flat, so ROLE order is now the only
      thing deciding what the eye meets first. `/item/[id]` keeps rendering them as
      bands, where `ContainerBandsReadout` is a readout rather than a form and the
      empty-band rule still reads correctly. `BandLabel` still supplies the detail
      sections' headings.

## Open after Phase 8 (2026-07-30)

- ~~Keyboard reach~~ / ~~inert~~ — closed the same day, see Phase 9.
- ~~No focus restoration when the panel unmounts~~ — closed in Phase 10. Radix's
  FocusScope used to return focus on close; the `<aside>` dropped it to `<body>`, so Tab
  restarted at the top of the document.
- **Escape during a pointer drag** can close the panel (dnd-kit cancels the drag without
  `preventDefault`, and focus is often `<body>`). Cosmetic; noted so it isn't rediscovered.
- **No drop shadow on the panel card** — the animating column has to clip, which would eat
  an outer cast. The border carries the edge. Revisit if it reads flat beside `<main>`.
- **Undo of an autosave is per-commit, not per-session.** Undo after a chip pick restores
  the pre-pick snapshot; there is no "undo everything I did in this panel".

## Review (2026-07-29)

Adversarially reviewed (3-agent pass + build gate) after the initial build; all
confirmed findings fixed in the same session: DB-layer subtask delete cascade (agent
deletes no longer orphan children), `validateParentItemId` referential guard on the
agent API (self-parent / cross-tenant / habit-parent / nesting → 400), strict
`parentItemId`/`aiStatus` on TaskCreateSchema, subtask guards in `selectOverdue` and
Beacon's task section, deep-link loading state on /item/[id], Enter-key containment and
scroll containment in the detail sections, provider-switch localStorage sweep for
unopened threads, undefined-safe event payloads. `pnpm build` passes; 241/241 unit
tests including new pins in tests/unit/item-growth.test.ts.

## Review (2026-07-30, Phases 7–8)

Four review lenses (data loss / layout / a11y / contracts), each finding adversarially
refuted by an independent agent. What survived and was fixed:

- **Whole-item writes reverted the live canvas** — the defect the non-modal design
  creates and the reason `commitEdit` is now key-scoped. Reachable by dragging or
  resizing the open item, or by pressing ⌘Z, and then touching anything in the panel.
- **`d.startTime !== live.startTime` compared `''` to `undefined`**, so the scheduling
  second pass fired on every save for every bucket-only task — one phantom
  `Updated startTime` activity row per chip click, in the feed the panel itself renders.
- **The habit branch had no equality guard at all**: `scheduleHabit` ran on every commit
  on top of `updateHabit`, doubling every habit write.
- **"Done" committed unconditionally** after the timer had already committed.
- **A deleted item left the panel open**, reporting saves that `updateItemAction` was
  silently dropping.
- **`/item/[id]`'s Edit opened a modal**, making the page's own subtasks and thread inert
  behind an overlay whose tint edit mode removes — dead controls, nothing to explain why.
- **Enter cancelled every button's activation** inside the surface (`preventDefault` on
  the bubbled keydown), so keyboard users got a save instead of the chip they pressed.
  Pre-existing in the modal; the panel made it reachable.
- **Escape closed the panel from anywhere**, including out of the braindump or the chat
  composer.
- **Two `ml-auto` siblings** split the free space and parked the header buttons mid-row.
- **Habit notes reached no AI context** — the focused-item line sat inside the non-habit
  branch while the panel renders the field for habits.

Refuted and left alone: a claimed lost-note race on dialog-slot swap (blur flushes first),
and a claimed Escape collision with the delete confirm (Radix `DismissableLayer`
`preventDefault`s on document capture, before the panel's window listener).

Verified: 304/304 unit (6 new in tests/unit/item-panel-writes.test.ts), lint 0 errors,
`pnpm build` clean, and the e2e specs that touch the surface — smoke, task-dates, omnibar,
habits, undo-redo — plus three new ones in tests/e2e/item-panel.spec.ts covering the notes
round-trip through autosave, the canvas staying operable behind the panel, and retargeting.
