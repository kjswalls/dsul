# Proposed CLAUDE.md additions (instant planner)

Kirby applies these by hand. Nothing below has been written to CLAUDE.md.

## 1. "Conventions and gotchas": append this bullet

- **The planner can be a look-only preview.** On a reload, `/` paints this browser's copy of
  the last session (IndexedDB `dsul-planner-cache`, [lib/planner-snapshot.ts](lib/planner-snapshot.ts))
  while `load_planner` is in flight: `isPreview` is true and `isLoading` stays true, so
  settled implies not previewing. Every planner-store action not in `PREVIEW_ALLOWED_ACTIONS`
  ([lib/preview-write-guard.ts](lib/preview-write-guard.ts)) refuses while previewing: deny by
  default, so a new action is refused automatically, and widening the list means editing the
  literal in its test. Views mount on `usePlannerVisible()`, which is display only. A surface
  that ACTS on data gates on **loaded** (`selectPlannerLoaded`, `usePlannerLoaded`,
  `isPlannerLoaded`), never on visible, and never on settled alone, which counts a failed
  load's empty store. `data-loaded` stays fresh only; `data-preview` and `inert` mark the
  preview. Data dialogs are deferred and data commands greyed while it is up
  ([lib/ui-store.ts](lib/ui-store.ts), [lib/commands/types.ts](lib/commands/types.ts)), and quick
  capture is held while the load is in flight ([lib/held-captures.ts](lib/held-captures.ts)).
  Anything OUTWARD that carries the planner as context (Ask's send, an AI proposal, a recipe
  or mod event) waits for `whenPreviewEnds` ([lib/planner-ready.ts](lib/planner-ready.ts)),
  which only a cleared `isLoading` ends. While it waits, row titles marked
  `data-row-title="open"` (render them through
  [RowTitleText](components/primitives/row-title-text.tsx)) shimmer in one band of light
  ([lib/planner-shimmer.ts](lib/planner-shimmer.ts), its section in globals.css). It is
  title text only, through `background-clip: text`, so the lime accent is never dimmed.
  The swap animates `[data-settle-key]` participants in place ([lib/settle.ts](lib/settle.ts))
  with transform and clip-path, plus a lifted row's box-shadow set-down; a new row or frame
  needs a stable key. Glides run on the compositor (composite `replace`, unless the box has
  a transform of its own). While rows move the run also writes `z-index`, `position`,
  `background-color`/`-clip`/`-image` and `box-shadow` inline, and restores each exactly on
  every exit. `html[data-planner-settling]` stays up while anything animates or the 250ms
  landing shield runs, and `waitForAppReady` waits it out. Changing what
  `loadPlannerData` returns means bumping `SNAPSHOT_FORMAT` and appending its hash (the ledger
  in `tests/unit/planner-bundle.test.ts` fails until you do). Kill switch:
  `NEXT_PUBLIC_PLANNER_PREVIEW=on|static|off`. **Retire it only via `off`**, shipped for
  several weeks, then keep a one-line `indexedDB.deleteDatabase('dsul-planner-cache')` boot
  shim in the provider; never by a revert, because only this code ever deletes the cache. Read
  [instant-planner.md](memory/plans/instant-planner.md) before touching any of it.

## 2. "Plans": append this entry to the paragraph

[instant-planner.md](memory/plans/instant-planner.md) does the same for the look-only preview a reload paints from this browser's cache and the settle onto fresh data, including the deviations the build took from its design and the retirement rule; read it before touching `lib/planner-snapshot*.ts`, `lib/settle*.ts`, `lib/preview-write-guard.ts`, `lib/held-captures.ts`, `lib/planner-shimmer.ts`, `SNAPSHOT_FORMAT`, or anything that reads `isPreview`.
