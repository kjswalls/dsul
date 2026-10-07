# dsul

A personal planning PWA — a day/week schedule grid, a braindump sidebar, recurring
habits, an end-of-day review, and an optional AI assistant (bring your own model).
Next.js App Router + Supabase, deployed on Vercel.

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
is republished. Both packages publish from the hand-dispatched `npm publish` workflow
([npm-publish.yml](.github/workflows/npm-publish.yml), main only, Kirby approves each run);
bump the version in a PR first, since a version already on npm is skipped.

## Setting up a new machine

```bash
pnpm install
vercel env pull .env.local        # gitignored, Vercel-generated — don't hand-copy
./scripts/local-setup.sh dev      # then point dev at a LOCAL Supabase (needs Docker)
```

Then run `/mcp` to authenticate. `.mcp.json` is committed but holds only hosted OAuth
URLs (Figma + Supabase), no secrets, so it works from any machine.

**`vercel env pull` writes PRODUCTION credentials, so `pnpm dev` talks to prod until
you run `local-setup.sh`.** Every hot-reload remount re-runs the planner's container
fan-out against the live project. `local-setup.sh dev` stands up a local stack and
swaps only the three Supabase keys in `.env.local`, carrying the VAPID pair and
`CRON_SECRET` through untouched. It keeps a usable `MODEL_KEYS_ENCRYPTION_KEY` and never
rotates one in place (that would make every sealed model key unreadable); a missing,
blank or malformed one (e.g. the `""` `vercel env pull` writes for a Sensitive variable)
is replaced with a fresh key, and the original file is backed up to `.env.local.bak`.
`.env.test` gets a fresh key on every run, since its database is reset too.
`vercel env pull .env.local` puts prod back.

The same script covers the e2e suite (`./scripts/local-setup.sh e2e`, writing
`.env.test` — see `.env.test.example`), or `both` from one stack.

**The e2e suite runs against loopback only, and has no override.**
`assertLocalTarget` ([tests/e2e/helpers/env.ts](tests/e2e/helpers/env.ts)), called
from `playwright.config.ts` before the web server starts, refuses a missing or
non-local `NEXT_PUBLIC_SUPABASE_URL`, and a non-local `E2E_BASE_URL` when one is set.
The config never adopts an already-running server (`reuseExistingServer: false`),
because a `pnpm dev` it did not start may be pointed at prod. CI used to run the
suite against PRODUCTION from repo secrets; on 2026-09-24 four PRs' runs overlapped
for hours and took the live project down (do.dsul.app logins timed out with a
Cloudflare 522). `localhost:3000` in the Supabase logs is the Playwright browser's
origin as much as a dev server's: the 5,917 requests once measured from it on
2026-09-18 were likely CI too, since several PRs ran E2E against prod that night.
CI's E2E job now starts its own stack on the runner with the same script (Supabase
CLI pinned in `.github/workflows/test.yml`). Never give it hosted keys back.

## Git workflow

Each chat does its changes on its own branch, never directly on `main`, and reaches
`origin/main` only through a pull request — never a direct push to `main`. Commits,
pushes, the PR and the merge need no separate go-ahead: Kirby set open-a-PR-and-merge
as the standard end of every task.

1. **Start of a chat**, before the first edit: branch off an up-to-date `main` —
   `git checkout main && git pull`, then `git checkout -b <descriptive-name>`.
2. **During the chat**: make changes on that branch, committing as the work warrants.
3. **When the work is finished**: commit on the branch, push it, and open a PR —
   `git push -u origin <branch>` then `gh pr create --base main`. Never push to `main`
   directly.
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

What still waits for Kirby's go-ahead, typed out in the chat: writes to prod (the
Supabase database or dashboard settings). The standing OK covers the branch, the PR and
the merge, not production.

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
container tables into three ROLES — classify (project), gate (routine, season), aspire
(goal) — and there is exactly ONE classify kind since migration 039 folded habit groups
into projects. Every type answers with `items.project`, and since 2026-10-01 it is optional
for every shipped type, habits included (`containerRequired` stays as a capability no type
sets). The `habit_groups` TABLE is frozen ballast — never query it. The
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
habit's own hour, a streak-at-risk last call, the end-of-day review's push, and a nightly
settlement all run unattended from one cron (`/api/cron/reminders` → [lib/reminders/scan.ts](lib/reminders/scan.ts)).
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

**AI is bring-your-own, and it fails closed.** dsul ships no model key of its own:
`process.env.OPENAI_API_KEY` is never read, and `tests/unit/ai-server-boundary.test.ts`
fails on the literal anywhere under `app/`, `lib/`, `components/` or `hooks/`, comments
included. Each user connects ONE model in Settings → AI
([model-connection-panel.tsx](components/settings/model-connection-panel.tsx)): OpenAI,
Anthropic, Google Gemini, OpenRouter (PKCE sign-in or a key), or any OpenAI-compatible
https base URL. Five rules are load-bearing:

- **The key is write-only.** It is sealed app-side with AES-256-GCM under
  `MODEL_KEYS_ENCRYPTION_KEY` ([secret-box.ts](lib/ai-server/secret-box.ts); never
  encrypt or decrypt in SQL, where a key lands in statement logs) into
  `model_connections` (migration 053: one row per user, service-role only, like
  `user_secrets`). No route, store, settings record or log ever carries it back to a
  browser, not even masked or as a last four. Production and Preview share one database,
  so they must hold the SAME `MODEL_KEYS_ENCRYPTION_KEY`; a mismatch reads as
  `key_unreadable` and is never written back.
- **Server code stays server-side.** Everything that talks to a provider lives in
  `lib/ai-server/**` and is imported only from `app/api/**` (a boundary test). Session
  checks live in `app/api/ai/_shared/guard.ts`, because `lib/` may not call
  `.auth.getUser(`.
- **One gate, asked, never re-derived.** The client asks `GET /api/ai/connection` once at
  sign-in; [ai-connection-store.ts](lib/ai-connection-store.ts) holds the answer and is
  never persisted, and [ai-registry.ts](lib/ai-registry.ts) turns it into capabilities.
  Every AI surface asks `useAICapabilities()` / `getAICapabilities()` and hides while the
  answer is unknown or failed. Who answers in chat is a device-local choice changed only
  through `chooseChatTarget()` ([chat-target.ts](lib/chat-target.ts)). It deletes
  nothing: it returns Ask to its home, so the next question starts a new conversation
  with the new answerer. Nothing in the app deletes a saved conversation except the
  user's own Delete.
- **Conversations are saved, once per turn, by the client.**
  [conversations-store.ts](lib/conversations-store.ts) writes each finished turn (user
  message plus reply, or the stopped or failed reply with an error *code*) in one
  `POST /api/ai/conversations/[id]/turns`, never per token, through the session client
  and RLS, never the service role. `/api/chat` stays stateless; the OpenClaw plugin path
  never reaches dsul's server, which is why the client is the writer. Error copy is never
  stored as content and never re-sent to a model. One conversation per item is a
  database rule (migration 057's partial unique index); a `409 conflict` rebinds the
  client to the existing one. The gateway session key is
  `dsul:u:<uid>:chat:<conversationId>`, built server-side from the verified user and a
  validated UUID. Conversations are not in `/api/agent/context` or MCP. If 057 is
  missing every conversations route answers 503 and the client latches saving off for
  the session; chat still works, unsaved. Content is clipped to the caps (8,000 a user
  message, 40,000 a reply) by the store before it is sent or saved, and by the route
  again; a length is never a 400. Every queued or keepalive save carries its owner, and
  the route refuses one whose owner is not the session user. Read the privacy statement
  in [ai-vision.md](memory/plans/ai-vision.md) before storing anything new.
- **The AI has no name.** The user-facing noun is "AI"; OpenClaw keeps its own name.
  `beacon` survives only in permanent ids and stored values (`/settings/beacon`, the
  `beacon.*` settings ids, the assignee value `'beacon'`, which renders as "AI"); never
  rename those, and never put "Beacon" in user-visible copy
  (`tests/unit/no-beacon-copy.test.ts`).

Read [ai-vision.md](memory/plans/ai-vision.md) before touching any of it.

**Deleting an account is one call.** `auth.admin.deleteUser` in
[lib/account-server/delete.ts](lib/account-server/delete.ts) (its only caller), and every table
that holds a user's data references `auth.users` ON DELETE CASCADE, so the database deletes the
rest in GoTrue's one transaction. A new table with a user column follows the rule (its own
cascading key, or a composite key to a table that has one), or
`tests/unit/account-deletion-migration.test.ts` fails; a column with no key at all would keep
its rows and take new ones from a service-role write in flight. Sign in with Apple is revoked
after the delete, never before, and never blocks it. Read
[account-deletion.md](memory/plans/account-deletion.md) before touching it.

**State.** Zustand stores in `lib/*-store.ts`, one per concern (planner, view, drag,
sidebar, eod, morning, conversations, rail, …). `planner-store.ts` is the big one: it
holds `items[]` with `tasks`/`habits` projections derived off it.

**Layout.** `app/` is thin — one main page plus `api/` routes. The UI lives in
`components/` (`views/`, `shell/`, `planner/`, `sidebar/`, `canvas/`, `mobile/`, `ai/`,
`primitives/`, `ui/` for shadcn).

**`electron/` is the desktop app's shell; `components/shell/desktop-shell.tsx` is the web
layout.** The shell is a standalone npm project outside the pnpm workspace (never run pnpm in
it), and it loads the live do.dsul.app. Read [desktop-app.md](memory/plans/desktop-app.md)
before touching it, `app/auth/desktop/`, or anything that reads `window.dsulDesktop`. The
shell's find bar (Ctrl/⌘ F) is an Edit-menu accelerator, which fires only for a key the page
leaves unhandled: a web handler that preventDefaults Ctrl/⌘ F or G (the settings search, the
Organize filter) keeps the key there, exactly as in a browser.

**`ios/` is the native iPhone app (SwiftUI, iOS 27); `ios/DsulCore` is its Linux-testable
Swift port of the pure planner logic.** XcodeGen generates the Xcode project from
`ios/project.yml` (never commit `*.xcodeproj`), and only GitHub's `xcode-27` runner compiles it
(`.github/workflows/ios.yml`), since cloud sessions can't. A Swift port cites the TS it mirrors:
changing that TS without the Swift is drift. The iOS checks aren't required, so merge a PR
touching `ios/` only once they're green. Read [ios-app.md](memory/plans/ios-app.md) before
touching `ios/`.

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

**Every migration must also replay onto an EMPTY database**, because CI's E2E job and
`local-setup.sh` build one from scratch with `supabase db reset`; a migration that only
works on top of prod's history turns that job red. `000_baseline.sql` creates what the
tree assumed from the pre-migrations `schema.sql` bootstrap (`tasks`, `habits`,
`projects`, `habit_groups`, `update_updated_at()`). It must never RUN on prod: it is
marked applied in the remote ledger instead (`supabase migration repair --status
applied 000`, or an insert into `supabase_migrations.schema_migrations`), and if
`db push` ever offers `--include-all` for 000, the ledger row is missing — add it
rather than taking the flag.

## Conventions and gotchas

- **`<ScrollArea>` ignores `max-h`.** The Radix wrapper silently drops the cap; use a
  plain `overflow-y-auto` container when you need a real height limit.
- **The lime accent never dims in dark mode**, and must never be faded through a parent's
  opacity — give it its own element if the container is being dimmed. **One exception,
  and it is narrow:** the week views' hover recede (next bullet) is an opacity on the six
  non-hovered day columns, and lime inside them composites for as long as the pointer
  is on another day. It is allowed because it is transient — pointer-only, under a
  `(hover: hover)` guard, never at rest — and because the token version that spared
  the lime cost ~250ms a hover. Nothing else may cite this exception.
- **The week views dim a day with a transient opacity, and nothing dims at rest.** Hovering
  one day column recedes the other six (`[data-week-cols]` / `[data-week-col]`, the rule
  is in [globals.css](app/globals.css), the dial is `--day-recede`). It is the accent rule's
  one exception, taken on measurement, not preference: the recede first shipped as a
  token swap — sixteen custom properties re-pointed per non-hovered column so every lime
  mark kept full strength — and on a real 40-item week that was 245–309ms of main-thread
  work per hover against ~22ms for opacity. ~50ms of it was pure style recalc with nothing
  repainting, because a custom property change re-styles every node under six columns;
  that is the floor for any token approach and it cannot be tuned away. Three things keep
  the exception narrow, and a test locks each: the opacity lives ONLY in the stylesheet
  under `:hover`, never in a className (the reverted `!selected && opacity-60` dimmed six
  days at rest — that is the regression); the rule sits under `(hover: hover) and
  (pointer: fine)`, because `:hover` sticks after a tap on a tablet wide enough for the
  desktop shell; and its only animation is a 150ms opacity fade whose return to rest is held
  100ms (off under reduced motion), because the untransitioned version flickered at each
  flex gap a sweep crosses. The fade is opacity-only, so it adds no recalc; never widen it
  to other properties.
- **The desktop app's top 43px is a window-drag band.** On macOS the Electron window has no
  title bar, and `.titlebar-drag` (first child of `<body>`, rule in [globals.css](app/globals.css))
  is what the window is dragged by; clicks there never reach the page. Anything interactive or
  hover-driven above y 43 takes `titlebar-hole`. It is all keyed off `env(titlebar-area-*)` with
  `0px` fallbacks, so browsers and the PWA never see it. The `-35px` in the sidebar wordmark's
  padding couples to `MAC_LIGHTS.x` in `electron/lib/window-chrome.cjs` — change one, change both.
  On a Mac the buttons follow page zoom (`macLights`: x and the row's midline scale, and y stops
  at 27 inside the fixed 43pt overlay), and env() is window points over the zoom, so the band's
  offsets stay subtractions from env(), never fixed lefts. The View menu's zoom items are click
  handlers that zoom the page, never roles: a role zooms without main hearing of it.
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
- **An item verb is declared once, in [lib/item-verbs.ts](lib/item-verbs.ts)** — its gate
  and its write, with the day it acts on passed in by the caller. The ⌘K item commands,
  the Organize console's member rows and the right-click menu
  ([item-context-menu.tsx](components/planner/item-context-menu.tsx)) all read it; a new
  surface that wants "may I tick / skip / carry this?" asks there rather than re-deriving.
  The right-click menus are pointer-only (long-press is drag on touch) and hold no Delete
  for containers — each Organize pane words its own delete consequence. The item menu's
  "AI ▸" asks are declared the same way, in [lib/item-asks.ts](lib/item-asks.ts), and
  run through `lib/open-chat.ts`, never a surface's own send; its "Hand off to OpenClaw" /
  "Take back" row asks [lib/agent-handoff.ts](lib/agent-handoff.ts), whose `canHandOff` is
  the agent's own queue filter (an item offered is an item the agent will see). Chromium on Linux and macOS
  opens a context menu on the right button's DOWN, and Radix selects a row released over,
  so the wrappers in [context-menu.tsx](components/ui/context-menu.tsx) swallow the release
  of the press that opened the menu (a menu shifted to fit lands under the pointer). Build a
  context menu from those wrappers (`ContextMenu`, `ContextMenuTrigger`,
  `ContextMenuContent`), never the bare Radix primitives, or the guard is gone.
- **The right rail is Ask, and an item opens on top of it.** The item is still ui-store's
  `edit-item` slot (on desktop, every reader and every `openEditFor` caller is unchanged);
  [rail-store.ts](lib/rail-store.ts) holds only what Ask shows under it (a stack per
  surface, with a level rule: history < conversation < item), and `railMode()` is the one
  visibility rule. On the phone, while the Ask tab is mounted (rail-store's
  `hostPhoneAsk()`, a count whose last release uninstalls it), `openEditFor` goes through
  ui-store's `setEditItemInterceptor` slot and pushes `{kind:'item'}` onto `stacks.phone`
  instead of filling the slot; Today and Braindump never mount the tab, so they keep the
  drawer. **Ask starts closed.** Whether it is open is sidebar-store v3's
  persisted `askOpen`: every explicit open writes it (the Ask button at the end of the
  canvas's header row, [ask-opener.tsx](components/ai/rail/ask-opener.tsx); Ctrl+J; `?` in
  the dock), Ctrl+J or the rail's ✕ clears it, and the tour's summon never touches it
  (`summon({persist:false})`). Someone who never chose has `askOpen: null`, read through
  `askOpenOf()` as `ASK_OPEN_DEFAULT` (false, Kirby's call on 2026-10-02); only a choice is
  ever stored, so making Ask start open is that one constant, even for a browser that has
  already run the build. Never read `askOpen` directly. Anything outside
  ItemDialog that closes the item (Ctrl+J, `?`, catch-up) goes through `closeItemPanel()`
  in ui-store, which flushes the queued autosave and applies the selection rule; a bare
  `closeDialog()` leaves the row selected and the save waiting out the unmount grace.
  Ctrl+J (⌘J) is the frozen `toggle_right_sidebar` id re-defaulted. With no AI the rail is
  exactly the old item panel, Done included; with AI the item's header is "‹ <view
  beneath> … ✕" and has no Done. While the column is docked (Ask or an item) the
  braindump narrows (every layout but Console, whose braindump is the fixed 300px pane):
  `renderedSidebarWidth` takes the column's reserve off its ceiling so the canvas keeps
  `SIDEBAR_MIN_CANVAS`, and never writes that back. Below 1180px (`PANEL_OVERLAY_QUERY`,
  the same query the column's `max-[1180px]:` classes compile to) Ask is an opaque overlay that appears only when summoned and
  parks on click-away or Escape, so it never locks the planner at boot. Every send goes
  through `sendFrom()` in [open-chat.ts](lib/open-chat.ts), the one place that decides
  which conversation a message lands in. The help bubble lives inside `<main>` so it can
  never cover the rail.
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
[programs-routines.md](memory/plans/programs-routines.md) is the plan for the two GATE
containers. **"Program" is now "Season"** (2026-09-27, migration 046) — code-deep: the
`seasons`/`season_items`/`season_routines` tables, the `Season` type, `/api/agent/seasons`,
`seasons[]` in the context (schemaVersion 6). The plan's body predates the rename and keeps
the old noun; its addendum at the top says what changed. A routine is things done
regularly, in order — not merely "items you pause together" — and has a Today checklist
and an optional `usualTime` (047) that labels and orders it but never moves a member.
[long-term-goals.md](memory/plans/long-term-goals.md) does the same for **goals** — the
third container role (`aspire`), where milestones and check-ins are ordinary items wearing
a membership role. Read it before touching `lib/goals.ts`, the goals store slice, or
anything that writes an item's `startDate` in bulk: a milestone's start date is a target
date, and the sweep and the carry verbs are excluded from it on purpose.
[mods.md](memory/plans/mods.md) is the plan for **mods and recipes** (Kirby's pick,
2026-10-03; decisions 2026-10-07): private, sandboxed mods (QuickJS-in-WASM behind a
capability broker, host-drawn UI, never CSS), no-code recipes over `ITEM_VERBS`, and
user themes and Looks as token values. It reverses plugins-themes-store.md's "skip
tier (c)" and "skip sidebar-panel slots" for private code only. Build orders 2 to 5 are built; read it before adding a mod
event, a recipe step, or anything that lets user-written code or values into the app.
[ai-vision.md](memory/plans/ai-vision.md) does the same for the AI: the model connection,
the capability gate, delegation to OpenClaw, saved conversations and their privacy
statement, and which earlier decisions steps 1 and 2a superseded. Read it before touching
`lib/ai-*`, `lib/ai-server/**`, `app/api/ai/**`, `app/api/chat`, the AI settings pane, the
right rail, or anything under `components/ai/`.
[sign-in-with-apple.md](memory/plans/sign-in-with-apple.md) holds the Apple provider: why the web's
button follows Supabase's own settings (the iPhone's is always shown), the desktop shell's provider
list, the iPhone's native id_token flow, the dashboard setup, and the client secret that must be
re-minted every six months (`scripts/apple-client-secret.mjs`) or Apple sign-in stops on the web
and the desktop (the iPhone's id_token grant needs no secret).
[account-deletion.md](memory/plans/account-deletion.md) holds Delete account on the iPhone and the
web: the one rule (one admin delete, every user column cascades, migration 062 and the test that
pins it), the account guard and the "gone" answers, exchange then delete then revoke for Sign in
with Apple, what stays outside the database, Kirby's setup and the App Review gate. Read it before
touching `lib/account-*`, `lib/account-server/**`, `app/api/account/**`, `app/api/app/account/**`,
or a migration that adds a table holding user data.
[reminders-platforms.md](memory/plans/reminders-platforms.md) is the plan for reminders on
every surface (web/PWA, Electron, the iPhone app, Android, Apple Watch): one server authority
on owed/discharged, a `devices` registry replacing `push_subscriptions`, device-local scheduling
on the phone, and a Phase 0 that brings the ticks migration 045 paused back as one merged
pg_cron job. Kirby decided its §7 on 2026-10-06; Phase 0 is built (migration 058 resumes the
tick once Kirby applies it), and its top addendum lists where Phase 0's code departs from the body. Read
it before touching `lib/reminders/**`, `lib/push-send.ts`, `app/api/cron/**`,
`/api/reminders/act`, `push_subscriptions`, or notification code in `electron/` or `ios/`.
