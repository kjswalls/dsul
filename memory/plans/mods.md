# Mods and recipes: your own commands, workflows, panels, themes and Looks

**Status (2026-10-07): IN PROGRESS, see "Built so far" below.** Kirby asked on 2026-10-03 how
Claude Code shipped mods and how dsul could have them, so people can make their
own UI, workflows, commands, themes and looks. He picked **private mods plus
recipes** the same day, and on 2026-10-07 took all six recommendations below
("go with yours"). Design page: https://claude.ai/artifact/HDVLF7eYgJ6uGbMLDbtQag.
The research behind it (subsystem maps with file:line, a critique, three drafts,
three adversarial reviews) is in Kirby's project files, not the repo
(`/mnt/project-files/mods/`); everything a build needs is in this file.

**Built so far:** build order 2 (raise sites), 3 (storage, Make, safe mode),
4 (browser recipes, `lib/recipes/`), 5a (user themes) and 5b (user Looks), both below. Where PR 4's code departs from the body:
a clock run writes TWO `mod_runs` rows, the claim `<key>` and its result
`<key>:done`, because 061 grants no UPDATE; an event or ⌘K run writes one,
`run:<uuid>`, and the run log reads only `summary.kind === 'run'`. The ⌘K
trigger is `on: 'command'`. `<RecipeHost>` (not `<ModHost>`) mounts in
`app/layout.tsx`, gated on the planner having settled, so ticks on
/routine/[id] and /item/[id] start recipes too and lean routes run nothing.
`openConsole(target, navigate)` takes the router from its caller, and needed
no allow-list entry (console-door.ts is already on it). The ⌘K provider calls
the engine through a slot (`lib/recipes/command-run.ts`), so the registry does
not import the engine and its UI steps. The builder
fetches its own pick lists, because /settings never loads the planner. Parts
of day start at `BUCKET_START_TIMES` (05:00, 12:00, 17:00); before 05:00
nothing fires. The rate limit counts per tab. A clock claim that errors (offline)
is tried again the next minute; a claim won and then dropped by the re-check after
its await (switched off, safe mode, the planner reloading) does not run that day
anywhere, accepted rather than adding a release no grant allows. Clock keys use the
account's time zone, falling back to the device's while it is unset (the same
fallback every view uses, and hooks/use-timezone-sync.ts fills it), so two devices
in different zones before that sync could each claim their own day. An event recipe
first asks whether the event still holds (the item still ticked, unticked, skipped
or there), so a ⌘Z between a tick and its dispatch runs nothing. "Still open today"
is refused on a tick or skip trigger, which closes the loop it asks about. Saving
an edit that changes a switched-on recipe's manifest switches it off; a rename alone
does not. Write steps run before UI steps whatever their order in the list, and the
builder says so. Theme and Look steps import the settings manifest lazily, so
`<RecipeHost>` in the root layout does not pull it into every route.

**Build order 5a, user themes, is built.** Where it departs from the body: the
grammar (`lib/mods/theme-grammar.ts`) also allows bounded alpha (4% to 40%) on the
three hairlines (`border`, `input`, `sidebarBorder`), because every dark built-in
draws them in alpha; the other bounds are accent 2-20%, rowSelected 4-30%, scrim
12-60%. Those three are washes over content and must carry alpha (an opaque scrim
would black out the page under every dialog); the hairlines may be opaque, as the
light built-ins draw them. A base theme's token the CSS writes as a `var()` or `color-mix()` chain
(Paper's `--primary-foreground: var(--lime-ink)`) is left unprinted when unset, so
the shipped chain resolves through the theme's own values; an Ask ink that is its
partner (`same` in `lib/mods/theme-bases.ts`) follows the theme's partner. The root
rule repeats its attribute (`:root[data-look-light='u-x'][data-look-light='u-x']`,
(0,4,0)) so a tint left stamped never shows through whatever order the sheets land
in; the Ask partner rule is the one that wins by order, wrapped in `:where()` so
Notepad Retro's partner still beats it. Terminal's mono face for code
(`--font-mono` and its `:is(.font-mono, code, pre, kbd, samp)` rule) is not a
token, so a theme built on Terminal gets the UI face only. A theme keeps its switch
when edited (it is values, not code that runs), unlike a recipe. The CSS slug is
`u-` and the first 8 hex of the row id, never the owner-writable `slug` column (new
theme rows store the same value there); two rows sharing a prefix keep the older.
The store keeps a saved `u-` pick even while the theme is missing, off or held back
by safe mode, and `<html>` shows `resolveLightPick(pick)`; once switching off or
deleting a theme in Make has landed, the default pick is written
(`lib/user-themes/release.ts`; a failed write keeps the pick). A saved theme keeps its
mode: the editor locks Light/Dark when editing and `saveTheme` refuses a switch, since
it could be someone's pick of that mode. The editor's draft is a preview twin only and
never bumps the registry's `rev`.
`<ThemeInjector>` mounts in `app/layout.tsx` and loads the theme rows itself
whenever a pick names one, since /settings never loads the planner. The pre-paint
script is `lib/user-themes/prepaint.ts`, imported by the layout, after the look
stamp. The cache (`dsul-user-themes`) is cleared on account switch (RAW_CLEARERS),
and so is a device pick naming one of the last account's themes
(`lib/user-themes/forget-picks.ts`), which goes back to the default.

**Build order 5b, user Looks, is built** (`lib/user-looks.ts`, `applyUserLook` in
`lib/settings/manifest.ts`, `components/settings/look-builder.tsx`). Where it departs
from the body: the manifest is `{version, layout, light, dark}` with no `label`; the
name is the row's, as a theme's is, so the two cannot drift. A Look's ref is `u-` and
the first 8 hex of the row id (`themeSlugForId`), never the `slug` column (new Look
rows store the same value there; 061's unique is per kind, so it never clashes with a
theme's); the ref shares a theme slug's shape but not its namespace, since a ref only
ever appears in a recipe's applyLook step. The layout is one of `LAYOUTS` (decision 5);
each side is a built-in of that mode or a `u-` theme, and at save the theme must be one
of the owner's of that mode (it may be off). Applying writes all three parts through
the same store-plus-one-patch as a built-in Look (`applyPicks`), each theme as a pick:
one of the owner's themes is written by its slug even while it is off (it shows Paper or
Night until it is on again, the pick rule of look-store), and only a ref naming none of
the owner's themes of that mode is written as the default. That is asked of mods-store's
rows, never the theme registry, so a registry still on its cache (or empty) cannot
decide what is saved; the card says quietly when a side is not showing. It does nothing
in safe mode. Whether one is on compares the picks as saved. A user Look is only on or
off, never "Edited", since two can share a layout; while one is on, a built-in sharing
its layout draws off rather than Edited. On a phone there is no Looks row (parity with the
built-ins), and a recipe that applies a Look there still writes the layout, the
account's, which only a computer shows. No cache and no pre-paint: a Look is never
stamped, only the picks it writes. Switching off or deleting a Look releases nothing,
since no pick stores one; a recipe naming one that is off or gone does nothing.

**This amends [plugins-themes-store.md](plugins-themes-store.md)** in two places,
both in its Project B item 6 ("Skip indefinitely"): the tier (c) sandboxed
runtime, and sidebar-panel slots. Mods build that runtime and one sidebar card
plus a rail mode, but for **private** code only: a mod runs only for the account that made it. Nothing is
shared, listed, downloaded or reviewed, so the permanent review cost that kept
tier (c) off the board does not arise. Sharing mods stays behind the closed,
reviewed program that plan describes, and its "themes are token JSON, never CSS"
line holds unchanged.

## What a person can make

| Kind | Example | Code? |
|---|---|---|
| Recipe | "When I tick *Run*, add *Stretch 10 min* to today and toast *Legs next*." | No |
| Mod | *Water*: a "4 of 8 glasses" panel with +1, a ⌘K command, a glass counted when the Water habit is ticked. | Yes, sandboxed |
| Theme | *Moss*: green paper, warm ink, as token values. Shows under "Yours" in Look. | No |
| Look | *Deep work*: Notepad layout, Paper by day, Moss at night. | No |

All four live in **Settings → Make** (one static pane, beside Extensions), each
with a switch, Edit, Delete, recent runs and problems. Everything is saved
switched off. Nothing here goes into `OFFICIAL_EXTENSIONS` or the store.

## Kirby's decisions (2026-10-07, all as recommended)

1. **Mod panels** open in the right rail as a fourth `RailMode`, `'mod'`, plus one
   card under the braindump. No slots inside the planner grid.
2. **Phone ticks start recipes.** A server runner handles ticks that never pass
   through a browser (the iPhone, reminder buttons) and the timed triggers.
3. **Undo order.** A recipe run is its own history entry: the first ⌘Z undoes the
   recipe, the second undoes the tick that started it.
4. **A user theme may replace the lime accent**, as Studio already does. `--lime-solid`
   stays opaque.
5. **No layout remixes yet.** A Look pairs a layout with a light and a dark theme.
6. **AI limits.** "Write with AI" needs a connected model (not OpenClaw only),
   output is capped, and a mod can never call the AI itself.

## Recipes

**Events are raised only from the user's own actions**, in `lib/mod-events.ts`,
fed from the store actions every surface already goes through:
`toggleTaskStatus`, `toggleHabitStatus`, `setItemsCompleted`, `setItemSkipped`,
and `addItem` / `addTask` / `addHabit` / `addTasksBulk` (a test lists them).
Undo (`applyHistoryState`) and agent merges (`mergeAgentStates`, via
`use-agent-freshness`) never pass those sites, so neither ever fires a recipe.
Inside a quiet `batchHistory` the events queue and flush with
`flushBatchEffects`. Dispatch runs in a task queued after the user's action
returns, with `quietDepth === 0`, so a recipe never joins the user's own entry.
A quiet batch that throws still delivers the events of the writes it applied
(they are in its entry and on the wire); only the cosmetic effects drop.

**Triggers.**

| Trigger | Where it runs |
|---|---|
| item ticked, unticked, skipped, added | browser (or the server runner for phone and reminder ticks) |
| end-of-day review saved (`saveLastReviewDate`) | browser |
| a new day opens, the bucket changes | browser, one app-level clock in `<ModHost>` keyed on the user's time zone, one tab per browser via `navigator.locks` |
| at a time of day | server, a tier of `/api/cron/reminders` |
| run from ⌘K | browser |

Ticks made by a recipe, a mod or the AI trigger nothing. Recipe and mod steps
call the same store actions the raise sites live in, so the dispatcher sets a
module-level suppress depth around every recipe run, mod hook and AI apply, and
the raise site checks it. A test proves a recipe's own tick raises nothing.
The depth is synchronous and never held across an await, so an async step
re-enters `withSuppressed` for every write after one.
`addTasksBulk` delegates to `addTask`/`addItem` for a single item, so it raises
only on its multi-item path.

**Timed triggers ride the tick #407 resumed** (`058_resume_cron_tick.sql`).
`dsul_tick` short-circuits unless someone has reminders, stakes or the review on,
so the PR that adds timed triggers (build order 6) must widen that cheap question to "or any
enabled recipe with a timed trigger", or timed recipes never run for someone
with only a recipe on. The windows stay in TypeScript (`lib/reminders/due.ts`'s
rule: no `time + interval` in SQL). Claim, then act: the run is claimed in
`mod_runs` against a unique key before any step runs.

**Steps are verbs, never field writes.** From `ITEM_VERBS`: complete, skip,
unskip, pause, resume, nextDay, reschedule, braindump, each re-checking
`eligible` for the real today. Excluded: tick, delete, resetStreak,
leaveProjectBlock. "Open today" composes `isOpenLoopOn` + `isItemActiveOn` the
way `lib/stakes/day.ts` does. Create routes by type through `canCreateType` (module-private in
`lib/proposal.ts` today; export it or move it to the registry). It refuses
every streak-keeping type, so recipes and mods never create habits.
UI steps come from a closed allow-list checked at save and at run: toast, go to
a view, open Organize (a non-hook `openConsole()` added to the
`console-door.test.tsx` allow-list), set a theme, apply a Look. No recipe
argument reaches `setLayout(arg as ViewLayout)` unparsed.

**Filters:** type (asked of the registry), project, title, weekday, open today.

**Runs.** One run is one synchronous `batchHistory('Recipe: <name>', n, fn,
{quiet:true})`. A run stops at 25 writes and logs "did 25 of 31". More than 10
runs a minute or 100 a day switches the recipe off and says why.

**On the server** (phone ticks, reminder buttons, timed triggers) the steps are
create, complete, skip and reschedule through `lib/db.ts`, claimed per
(recipe, item, date, trigger). There is no undo there, so the run log offers
Revert. If a step's verb changes in `lib/item-verbs.ts`, `ItemVerbs.swift`
changes in the same PR.

## Mods

**Shape**, after Claude Code's function hooks: one file exporting
`register(on)`; `on(event, async ($, e, next) => …)`; `$` is the only door.

**Runtime.** `quickjs-emscripten` (MIT, free). A same-origin route,
`app/mods/sandbox/route.ts`, loads in `<iframe sandbox="allow-scripts">` and is
served with `Content-Security-Policy: sandbox allow-scripts; default-src 'none';
script-src 'self' 'wasm-unsafe-eval'; worker-src blob:; connect-src 'none'`. The
frame's origin is opaque, so no cookie travels and `isSameOrigin` already refuses
`Origin: null` (`app/api/ai/_shared/guard.ts`). An app URL, not `srcdoc`, because
Electron's `guardSubframe` refuses any subframe that is not an app URL
(`about:srcdoc` included). The WASM bytes arrive by
`postMessage`; the Worker deletes `fetch`, `XMLHttpRequest`, `WebSocket`,
`importScripts`, `indexedDB` and `caches` before QuickJS starts; the host checks
`event.source` on every message. One QuickJS runtime per mod. Per hook: 16MB,
50ms CPU, 500ms wall clock, 50 calls to `$`.

**Manifest** (`lib/mods/schema.ts`, not `@dsul/types`, so no external contract):
`slug`, `name`, `version`, `uses[]` (`items:read`, `items:write`, `ui`,
`storage`, `look`), `commands[]`, `panels[]`, `settings[]`, validated at every
load.

**Events.** The recipe triggers (user actions only), `command` and `ui.action`
(owning mod), `ui.resolve` (the mod that declared the panel, read-only `$`),
`timer` (`$.after`, at least 1s, 10 pending), `atom.changed` (never for the
mod's own writes), and `item.uncompleted` with `origin:'undo'` (mods only, never
recipes).

**`$`.** Async RPC to the broker, every call checked against `uses`:
`$.today()`, `$.items.get/query` (frozen projections, no AI fields),
`$.items.create` (recipe create rule), `$.items.edit(id, {title, notes,
priority, project})` via `updateTask`/`updateHabit`, `$.verbs.eligible/run`,
`$.containers.list()`, `$.atom`, `$.store` (64KB, persisted), `$.settings`,
`$.ui.*` and `$.ui.toast`, `$.ui.open/openItem` and `$.nav.go/organize` (only
during `command` or `ui.action`, never autofocus), `$.look.set`, `$.after`,
`$.log`. No `$.ai`, no network, ever.

**Writes are held per hook** and applied when it settles, in one synchronous
`batchHistory('<mod>: <hook>')`. A mod may add at most 10 history entries per 10
minutes, so it cannot push the user's own out of the 50 kept.

**UI is host-drawn**, as in Claude Code (a mod returns a tree of the host's own
pieces; the host draws it). Elements: `stack`, `row`, `list`, `divider`,
`heading`, `text`, `badge`, `progress`, `stat`, `button{action}`,
`checkbox{atom}`, `input{atom, text|number|date}` (no password kind), `select`,
`itemRef{id}`, `icon` (allow-listed lucide). Plain text, at most 300 nodes,
styling only through `tone: muted|accent|warn`, so the lime never dims and no
opacity reaches the week views. No CSS: a stylesheet alone can exfiltrate
keystrokes and redress the page, and it breaks with every redesign. If the kit
is too narrow, add style props, never CSS.

**Mounts.** The `'mod'` rail mode (independent of `canChat`, its own opener in
the canvas header row, its own share of `RAIL_RESERVE_PX`; an open item still
covers it), one card under the braindump, a sheet from ⌘K on the phone web
shell. Anything above y 43 on desktop takes `titlebar-hole`.

**Anti-spoofing.** Every mod surface and mod ⌘K title carries host chrome the
mod cannot remove: its name and a "Your mod" badge. Labels may not use AI,
Settings, Sign in, Account, key or a provider name, and never "Beacon"
(`no-beacon-copy.test.ts`). Values shaped like keys (`sk-`, `AIza`) are refused.

**Commands.** One memoised `CommandProvider` from cached manifests, ids
`mod.<slug>.<id>`, a new `'mods'` group, no shortcuts in v1 (shortcut ids are
permanent and only `STATIC_COMMANDS` may own a binding). Mod aliases lose to
built-in aliases.

**Hot reload.** Save validates and evaluates in a scratch runtime with no `$`,
then swaps runtimes and redraws. On any failure the old version keeps running.

**Faults.** Each hook is wrapped; faults go to Problems and the panel shows "This
mod hit an error". Three faults in ten minutes sets `enabled=false` with a
reason, picked up by other devices on their next focus re-read. "Turn all mods
off" is in Make and ⌘K; `?safe-mode` starts with every mod off.

## Themes and Looks

**A theme is token values, parsed and re-printed by the host.** The tokens are
every variable a built-in block restates in `app/globals.css` (the accent and
`--lime-solid`, ground and ink, `--priority-low-foreground`,
`--sidebar-primary-foreground`, `--relay-light`/`-quiet`/`--relay-dark`, the
`--shadow-elev-*` set, `--ask-icon-pair`/`-ink`), plus two that live elsewhere:
the UI font (set on `body`) and the `themeColor` field of `LookDef`
(`lib/theme-looks.ts`). Schema keys may be camelCase; each maps onto one of these. Grammar in
`lib/mods/schema.ts`: `#rgb`, `#rrggbb`, `oklch(L C H)`, and a bounded alpha form
only for `accent`, `rowSelected` and `scrim`; radius 0 to 24px; shadows from
presets; fonts the app already loads. `--lime-solid` opaque, `scrim` alpha no lower than the
built-in light scrim (12%). Contrast is checked on every pair the built-ins use; a failure warns and
can be overridden. Never `url()`, `image-set`, `@import`, selectors or `content`.

**Injection.** Slug `u-<8 hex>` of a client-minted row id. A tested
`ThemeInjector` writes one `<style>` under
`:root[data-look-light='u-x']:not(.dark)` plus its preview twin. The
localStorage cache holds only host-printed declarations; the pre-paint inline
script (`app/layout.tsx`) checks each against a per-token regex table generated
from the grammar (with a drift test) and inserts with `textContent`.
`lightLookDef`/`darkLookDef` read a merged registry, so a `u-` slug never falls
back to Paper's metadata. Tint rests while a user theme is on, and the picker
says so.

**Looks.** `UserLook {label, layout, light, dark}` beside `LookPreset`, with its
own apply and state, shown under "Yours".

## AI writes it

Gated on a new `canMake` (`target === 'model'`), not `canChat`, which is true for
OpenClaw-only users. "Write with AI" lives in Make; Ask hands off to it; drafts
are never parsed out of chat replies. `POST /api/ai/make` streams; a fixed prompt
in `lib/ai-server/make-prompt.ts` holds the `$` types, the elements and the
tokens, and prefers a recipe. Output cap 2,000 tokens, 4,000 for a mod. The
client Zod-checks the draft and shows a card: the steps or a theme miniature,
`uses` in plain words, the source. Install saves it switched off.

The concerns this answers (Kirby asked, 2026-10-07): an item title from outside
(a captured email, an agent's item) could carry instructions, so the model sees
the API and project and type names only, never notes or conversations, and the
card shows what the mod may touch; plausible but wrong code is why everything
starts off, runs sandboxed and capped, undoes in one ⌘Z and switches itself off
on faults; a mod calling the AI could run up the person's bill and would be a
path out of the box, so `$` has no AI.

## Safety

RLS is not the sandbox: the browser client can write all of `items` and read
saved conversations. The frame plus the broker (`lib/mods/broker.ts`) is the
wall: allow-listed methods, Zod-parsed arguments, projected results, today only,
the caps, and a rate limit whose breach is a fault.

**Stakes.** While any stake adapter is on, mods and recipes may not run any verb
on a `stakeEligible` item, edit its title or project, or create or rename an item
to a title in the Beeminder goal map (`parseGoalMap`/`goalForTitle` move to a
pure module, since `beeminder.ts` imports server delivery code).

**Never reachable:** saved conversations, `model_connections`, `user_secrets`,
`stake_events`, raw `completedDates`/`streak`, delete, other mods' state, the
frozen tables, CSS, the network, the AI. `user_mods` is never exposed to
`/api/agent/*`, MCP or `lib/app-api.ts` (a boundary test). Titles a mod writes are
at most 120 characters with no URLs; notes a mod writes are marked untrusted in
the AI's context.

## Data model

Two tables, owner-only RLS (`using` and `with check (user_id = auth.uid())`),
idempotent and replayable on an empty database. **Number:** 058 is
`resume_cron_tick` (#407), 059 is `agent_key_to_secrets` (#413), 060 is claimed
by AI setup's `ai_hidden`; take the next free number after checking main,
prod's ledger and open branches. Taken: **061**. Prod needs Kirby's typed go.

```sql
create table if not exists public.user_mods (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('recipe','mod','theme','look')),
  slug text not null check (slug ~ '^[a-z][a-z0-9-]{0,29}$'),
  name text not null check (char_length(name) between 1 and 60),
  enabled boolean not null default false,
  manifest jsonb not null default '{}',
  source text check (octet_length(source) <= 65536),
  store jsonb not null default '{}' check (octet_length(store::text) <= 65536),
  disabled_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, kind, slug));
create table if not exists public.mod_runs (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  mod_id uuid not null references public.user_mods(id) on delete cascade,
  claim_key text not null, summary jsonb not null default '{}',
  at timestamptz not null default now(),
  unique (mod_id, claim_key));
```

`$.store` writes go through a `mod_store_set(p_mod_id, p_key, p_value)` RPC
(security invoker, owner-checked `jsonb_set`; PostgREST matches arguments by
name, so callers send those names), one key at a time, so two devices never
overwrite each other. `mod_runs` is SELECT and INSERT only to its owner (no
DELETE: a deleted claim could run twice; deleting a mod cascades its runs).
Migration 061 ships the tables and `mod_store_set` only; widening `dsul_tick`'s
cheap question waits for the PR that adds timed triggers (build order 6), since
no recipe can have one before then.

## Build order (one PR each, each usable alone)

1. This plan, the CLAUDE.md rules, the `extension-registry.ts` header.
2. Raise sites and dispatch, with tests: undo raises nothing, a quiet batch
   raises each transition, ⌘Z undoes the recipe before the tick.
3. The migration, schemas, mods store, Settings → Make, `?safe-mode`.
4. Recipes: engine, caps, stake lock, clock, claims, builder, run log, ⌘K.
5. User themes, then user Looks (two PRs).
6. The server runner: phone and reminder ticks, timed triggers.
7. AI writes recipes, themes and Looks.
8. Mod runtime: sandbox, broker, commands, faults, a plain source editor.
9. Mod UI: renderer, rail mode, braindump card, phone sheet.
10. AI writes mods.

No paid service anywhere. The iPhone app draws no mod UI in v1; it runs recipes
through the server runner and shows user themes once the SwiftUI app reads them
(a later, separate step).
