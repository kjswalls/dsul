# dsul

A personal planning PWA — a day/week schedule grid, a braindump sidebar, recurring
habits, an end-of-day review, and an AI assistant ("Beacon"). Next.js App Router +
Supabase, deployed on Vercel.

## Commands

```bash
pnpm dev            # next dev --webpack
pnpm build          # next build --webpack
pnpm lint           # eslint .
pnpm test           # vitest run  (unit)
pnpm e2e            # playwright test
pnpm db:list        # supabase migration list
pnpm db:push        # supabase db push
pnpm db:new <name>  # supabase migration new
```

pnpm workspace (Node 24). `packages/types` is `@dsul/types`, and its `dist/` is
**committed** — CI rebuilds it and fails on any drift from `src`, so a schema edit
without `pnpm --filter @dsul/types build` is a red build. `openclaw-plugin/` is a
separate consumer of the agent API; its `dist/` is gitignored and built at publish time,
so CI does not gate it — a plugin `src` change reaches users only when the npm package
is republished.

## Setting up a new machine

```bash
pnpm install
vercel env pull .env.local        # gitignored, Vercel-generated — don't hand-copy
./scripts/local-setup.sh dev      # then point dev at a LOCAL Supabase
```

Then run `/mcp` to authenticate. `.mcp.json` is committed but holds only hosted OAuth
URLs (Figma + Supabase), no secrets, so it works from any machine.

**`vercel env pull` writes PRODUCTION credentials, so `pnpm dev` talks to prod until
you run `local-setup.sh`.** That is not theoretical: of the API requests in one
ten-minute window on 2026-09-18, 5,917 came from `localhost:3000` and two came from
the deployed app — every hot-reload remount re-runs the planner's container fan-out
against the live project. `local-setup.sh dev` stands up a local stack and swaps only
the three Supabase keys in `.env.local`, carrying `OPENAI_API_KEY`, the VAPID pair and
`CRON_SECRET` through untouched. `vercel env pull .env.local` puts prod back.

The same script covers the e2e suite (`./scripts/local-setup.sh e2e`, writing
`.env.test` — see `.env.test.example`), or `both` from one stack. See
[scripts/README.md](scripts/README.md).

## Git workflow

Each chat does its changes on its own branch, never directly on `main`, and reaches
`origin/main` only through a pull request — never a direct push to `main`. This
composes with the standing rule that commits wait for Kirby's go-ahead.

1. **Start of a chat**, before the first edit: branch off an up-to-date `main` —
   `git checkout main && git pull`, then `git checkout -b <descriptive-name>`.
2. **During the chat**: make changes on that branch. Leave them uncommitted unless
   Kirby asks otherwise — committing waits for the "done" signal.
3. **When Kirby says the work is done** (and only then): commit on the branch, push
   it, and open a PR — `git push -u origin <branch>` then `gh pr create --base main`.
   Never push to `main` directly.
4. **Let the review bots run.** Wait for the automated reviewers (CodeRabbit, bug
   bots, CI checks — whatever the PR triggers) to weigh in. Read every comment, then
   fix or explicitly address each one and push the fixes to the same branch.
5. **Auto-merge once everything is resolved.** When all bot comments are handled and
   checks are green, merge to `origin/main` — prefer `gh pr merge --auto --squash` so
   GitHub completes the merge the moment required checks pass. Because auto-merge lands
   asynchronously, wait until the PR actually shows as merged, then sync local with
   `git checkout main && git pull --ff-only origin main`.

`main` is branch-protected: no direct pushes, PRs required, and **Unit tests (Vitest)**
must pass before merge (native auto-merge is enabled). Docs-only PRs skip CI — the
`Tests` workflow ignores `**.md`, so that required check never reports and `--auto`
won't fire; for a Markdown-only PR, once the bots are clean, merge with
`gh pr merge --admin --squash` (admin override — there's no code to gate).

"Done" is Kirby's word, not your own read that the task looks finished. Until he says
so, no commits, pushes, PRs, or merges.

## Architecture

**Unified items.** Tasks and habits are one entity. There is a single `items` table with
a `type` discriminator; `type` is open text, so users can define custom types via the
per-user `item_types` table. The old `tasks`/`habits` tables are **frozen, not dropped** —
they exist as rollback ballast. Never query them.

**The type registry is the extension point.** [lib/item-registry.ts](lib/item-registry.ts)
declares what each type *can do* — allowed statuses, recurrence rules, whether it's
date-anchored, orderable, braindump-eligible, resizable on the grid, and so on. Any code
that wants to branch on `task` vs `habit` should ask the registry a capability question
instead. Adding a type means adding config, not adding code paths.

Custom types travel under a closed `{type:'custom', customType}` envelope app-side so
discriminated-union narrowing keeps working, but the DB stores the bare slug in
`items.type`. `itemDbType()` in [lib/db.ts](lib/db.ts) is the boundary.

**One CLASSIFY kind.** [lib/container-registry.ts](lib/container-registry.ts) sorts the
container tables into three ROLES — classify (project), gate (routine, program), aspire
(goal) — and there is exactly ONE classify kind since migration 039 folded habit groups
into projects. Every type answers with `items.project`; `containerRequired` is what still
makes a habit different. The `habit_groups` TABLE is frozen ballast — never query it. The
`items."group"` COLUMN is ballast too, but `itemFromRow` ([lib/db.ts](lib/db.ts)) still reads
it in exactly one place, as a fallback (`row.project ?? row.group`), so a build landing ahead
of the migration — a fresh clone, a rolled-back 039 — shows a habit's container instead of
blanking it. That read is load-bearing, not dead code. The name falls back; the id never does.
The user-facing noun lives only in `CONTAINER_KINDS.project.label`, so moving
it is a string edit. The kind folds case (`caseFold: true`), which is why `Work` and
`work` are one container to every lookup.

**Legacy projections are permanent.** `/api/agent/context` still serves `tasks[]` and
`habits[]` as exact-legacy-schema views over items, and webhooks still emit
`tasks.updated`/`habits.updated`. The OpenClaw plugin `safeParse`s these and *throws* on
drift, so status vocabularies (`pending|completed|cancelled` for tasks,
`pending|done|skipped` for habits) are external contracts — don't merge or translate them.
`habits[].group` and the required `habitGroups[]` array are the same kind of contract: a
habit answers with `project` internally and `toLegacyHabit` renames it on the way out
(lib/db.ts), while `habitGroups[]` is a projection of the one container list.

**Reminders reach outward; everything else in the app waits to be opened.** A cue at the
habit's own hour, a streak-at-risk last call, and a nightly settlement all run unattended
from one cron (`/api/cron/reminders` → [lib/reminders/scan.ts](lib/reminders/scan.ts)).
The one exception is Beeminder, which also posts the instant a habit is ticked
([lib/stakes/live.ts](lib/stakes/live.ts), hooked at `setItemCompletion`) because a
datapoint that arrives after the goal's midnight deadline arrives after the money is
gone. Four rules are load-bearing and are not obvious from the code shape:

- **Nothing re-derives "does this want doing".** `lib/reminders/due.ts` and
  `lib/stakes/day.ts` compose `isOpenLoopOn` + `isItemActiveOn` from
  [lib/active.ts](lib/active.ts). A nudge about a habit the grid has hidden is the app
  arguing with a decision the user made.
- **Claim, then act.** Cues are taken with a conditional update and only delivered if the
  database actually changed a row; stake rows are inserted against a unique index and only
  the newly-claimed ones reach the outside world. A cron is at-least-once, and the naive
  order rings a phone twice or charges a pledge twice.
- **Two writers, one row.** The live Beeminder path and the nightly settlement both claim
  the same `stake_events` row (unique on user+date+subject+channel) and never coordinate:
  whichever gets there first posts, the other finds it committed and does nothing. Keep
  the settlement — it is the backstop for every completion that never passes through a
  browser. `stake_events` is read at `/ledger` and is SELECT-only to its owner; a ledger
  the subject can edit is not a ledger.
- **Channels and stake adapters are declarative and isolated.** One is a manifest entry in
  [lib/extension-registry.ts](lib/extension-registry.ts), a field list in
  [lib/extension-settings.ts](lib/extension-settings.ts), and a `deliver()`/`plan()`+
  `commit()`. They must return a failure, never throw it — an expired token in one must
  not cost the others. Non-secret config lives in `user_extensions.config` (browser-
  readable); credentials live in `user_secrets`, which is service-role only, and
  `/api/reminders/secrets` will say which keys are set and never what they are.

Read [habit-reminders.md](memory/plans/habit-reminders.md) before touching any of it — the
copy contract, the midnight clamp and the snooze day-gate all exist because the obvious
version was wrong.

**State.** Zustand stores in `lib/*-store.ts`, one per concern (planner, view, drag,
sidebar, eod, morning, chat, …). `planner-store.ts` is the big one: it holds `items[]`
with `tasks`/`habits` projections derived off it.

**Layout.** `app/` is thin — one main page plus `api/` routes. The UI lives in
`components/` (`views/`, `shell/`, `planner/`, `sidebar/`, `canvas/`, `mobile/`, `ai/`,
`primitives/`, `ui/` for shadcn).

## Database

**Migrations in `supabase/migrations/` are the single source of truth.**
`supabase/schema.sql` is stale and missing columns, CHECKs, RPCs, and cron — never author
SQL against it.

Migrations are numbered `NNN_name.sql` and the remote ledger
(`supabase_migrations.schema_migrations`) is kept aligned to those numbers. If you apply
something out-of-band via the SQL editor or MCP, record it in the ledger with the matching
`NNN` version, or `db push` will try to replay it later. Write migrations idempotently
(`add column if not exists`, `drop … if exists`, `do $$ … end$$` guards) — they're
expected to be safe to re-run.

## Conventions and gotchas

- **`<ScrollArea>` ignores `max-h`.** The Radix wrapper silently drops the cap; use a
  plain `overflow-y-auto` container when you need a real height limit.
- **The lime accent never dims in dark mode**, and must never be faded through a parent's
  opacity — give it its own element if the container is being dimmed.
- **The week views dim a day by re-pointing tokens, never with an opacity.** Hovering one
  day column recedes the other six (`[data-week-cols]` / `[data-week-col]`, the rule is in
  [globals.css](app/globals.css)). It cannot be `opacity` on the siblings, and that is the
  accent rule above rather than a preference: a column opacity composites the block rails,
  completion checkboxes, multi-select marks and `--accent-8` projects inside it, and
  excluding the selected and today columns saves none of them. So the rule assigns ONLY
  custom properties, and only the neutral ones — ink, surfaces, hairlines — each pointed at
  a `--recede-*` twin derived at `:root` (a self-referencing custom property is a cycle, so
  they cannot be written inline). Every chromatic token is left alone. A filter or a scrim
  is the same violation wearing a different hat. The `(hover: hover) and (pointer: fine)`
  guard is load-bearing too — `:hover` sticks after a tap on a tablet wide enough for the
  desktop shell, and what would stick is six days dimmed. And it does NOT animate: a
  transition on the columns' descendants makes the browser repaint every node under six
  columns for eight frames, which measured 297ms of worst-frame jank at 40 items a column
  against 23ms without — the cost scales with the item count, so the recede lands on one
  frame, the way task-row's hover wash does.
- **`canvas-container` caps the canvas at 1100px**, which is why seven week columns never
  fit on any monitor. The week COLUMN views opt out with `data-wide="true"`; every
  `canvas-container` on the page must flip together (header capsule, past-due bar, grid)
  or they lose the shared left edge the utility exists to guarantee. Its `padding-inline`
  is mirrored in JS as `CANVAS_PAD_PX` — change one, change both. Week × Schedule's pinned
  hour gutter depends on this: a sticky box is constrained to its containing block, so
  restoring the cap would unstick it mid-scroll.
- **The omnibar is one component in two shells.** `components/sidebar/omnibar.tsx` takes a
  `variant: 'dock' | 'launcher'` and renders both the resting sidebar capture bar and the
  summoned ⌘K launcher modal (`components/shell/omni-launcher.tsx`, an `activeDialog` slot).
  All four modes (search · `+` add · `/` command · `?` chat) work in both; only emphasis,
  Enter semantics, panel direction, and copy differ off `variant`. Bindings: ⌘K opens the
  launcher, `/` opens it in command mode, ⌘I focuses the dock — all in
  `lib/commands/registry.ts`, whose shortcut ids are frozen by a test (add, never rename).
  Tests scope by `data-omnibar-variant` since both shells share testids.
- **The shortcuts table is one component in two shells, too.** The bindings are settings
  records (`SHORTCUT_RECORDS` in [lib/settings/manifest.ts](lib/settings/manifest.ts),
  derived 1:1 from `DEFAULT_SHORTCUTS` — never a second copy of the list), and
  `components/settings/shortcuts-panel.tsx` renders them in the Keyboard settings pane and
  in the ⌘/ overlay off a `variant: 'pane' | 'overlay'`. A shortcut id is now BOTH the
  persistence key for a rebinding and the second half of a permanent settings id
  (`keys.<shortcutId>`), so renaming one breaks two things at once. Tests scope by
  `data-shortcuts-variant`. See [keyboard-shortcuts.md](memory/plans/keyboard-shortcuts.md).
- **The Organize console is a component, not a route**, mounted once inside `AppShell` —
  which only `app/page.tsx` renders. So on every other route the console does not
  exist, and `openDialog({type:'organize'})` there is worse
  than a no-op: `ui-store` is a module singleton, so the armed slot survives the navigation
  and springs the console open unasked on the next trip home. Open it through
  `useOpenConsole()` ([lib/console-door.ts](lib/console-door.ts)), which arms the slot and
  then goes where the console lives. `OrganizeConsole` registers itself as the host, so
  nothing else has to declare one; a test enumerates every file still allowed to arm the
  slot directly and fails on any new one. The console's own outward links must
  `closeDialog()` on the way out (via `onNavigate`, so a ⌘-click into a new tab
  doesn't shut the one you are looking at), and `ConsoleSlotGuard` in the root
  layout drops a stranded slot when you leave `/` by any other means.
- **Design source of truth is the Figma file, not the mockup PNGs in the repo.** Pull
  specs live via the Figma MCP; the checked-in PNGs drift.
- Some settings persist but are read by no view. That's deliberate — leave them alone
  rather than surfacing or deleting them.
- Recurring items track completion per-date in `completedDates`, never via scalar
  `status`. Habit `streak` is an opaque stored counter (`+1`/`-1` on toggle), not
  recomputable from `completedDates` — resetting a streak must not touch `completedDates`.

## Plans

Longer-running design docs live in [memory/plans/](memory/plans/) and are committed.
[unified-items.md](memory/plans/unified-items.md) carries the phase ledger and the locked
design decisions for the items refactor — read it before touching item types, the
registry, or the agent API.
[keyboard-shortcuts.md](memory/plans/keyboard-shortcuts.md) records why the shortcuts
table lives in the settings manifest and renders in two shells — read it before touching
`lib/commands/keys.ts`, the `keys` control kind, or anything that derives a binding list.
[long-term-goals.md](memory/plans/long-term-goals.md) does the same for **goals** — the
third container role (`aspire`), where milestones and check-ins are ordinary items wearing
a membership role. Read it before touching `lib/goals.ts`, the goals store slice, or
anything that writes an item's `startDate` in bulk: a milestone's start date is a target
date, and the sweep and the carry verbs are excluded from it on purpose.
