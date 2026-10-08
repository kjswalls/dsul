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
4 (browser recipes, `lib/recipes/`), 5a (user themes), 5b (user Looks), 6 (the
server runner), 7 (AI writes recipes, themes and Looks), 8 (the mod runtime) and 9 (the mod UI), each below. Where PR 4's code departs from the body:
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

**Build order 6, the server runner, is built** (`lib/recipes/server/`, migration
062). Where it departs from the body: a timed recipe's weekdays are its
`filters.weekdays` (already saved for every trigger, read on the user's own date),
not a field on the trigger, so the manifest did not change. Claim keys are
`time:<day>:<at>` and `item:<kind>:<itemId>:<date>` (claim row, then `<key>:done`), so
the server runs a recipe once per (recipe, item, date, trigger) where the browser runs
it on every transition; a claim won and then lost to a crash is lost for that day, as
a cue is. A timed recipe is due at any tick within 30 real minutes after its time on
the user's date (`window.ts`: spring forward runs 02:30 at 03:00, fall back's doubled
hour loses the second claim, 23:58 runs at 23:55). Its steps may only be create,
complete, skip and reschedule (validated at save); an item-trigger recipe run for a
phone or reminder tick skips other verbs (`skip:browser-only`) and counts screen steps
into `ui`. Server code cannot import `lib/item-verbs.ts` (planner and UI stores), so
the pure gates moved to `lib/verb-gates.ts`, which item-verbs re-exports, every verb's
`eligible` being the same function (no Swift logic change; `ItemVerbs.swift` now cites
`lib/verb-gates.ts` for the gates and the private helpers); the recipe rules split the same
way (`validate-core.ts`, `stake-rule.ts`). The phone's complete, skip and move writes
moved unchanged from `lib/app-api.ts` to `lib/item-intents.ts`, which the runner
shares, so a server step is the phone's write. The completion and skip RPCs filter on
id and type only and cannot be scoped, so the runner re-reads each item with
`user_id` before each one, and `updateItem` takes `{ownerId}`. `lib/app-api.ts` names
no recipe: its routes pass an `onCommitted` listener (`afterItemWrite`, the runner's one
door), called once per real transition after the write committed; the phone's
`complete` and `/api/reminders/act` read whether the day was done first, so a repeat
`done` starts nothing. The rate limit counts the account's result rows in `mod_runs`
(`summary.day`, which browser runs now carry too). Revert in Make applies the run's
inverse writes (`summary.undo`) through the store as one quiet `Revert: <name>` entry,
claimed as `revert:<run key>`; it needs the planner loaded (Make on a lean /settings
says so rather than claiming). The planner never refetches what the server changed, so
Revert first reads the run's items back and folds them in (`mergeServerItems`, the
`mergeAgentStates` pattern: no undo entry, no write-back), claims only if something
still applies, and claims as its last await; its result row (`revert:<run key>:done`)
is what the log trusts, and a claim spent while the planner went away logs `did: 0`
with `failed` rather than reading as Reverted. A timed run stops its remaining steps
past the tick's deadline (`stop:deadline`) so a claimed run always logs its result
and Revert. The cron route runs the recipe tier after the scan in
its own try, with its own `[cron/recipes]` line; the scan alone decides the status.

**Build order 7, AI writes recipes, themes and Looks, is built** (`app/api/ai/make/route.ts`,
`lib/ai-server/make-prompt.ts` and `make-context.ts`, `lib/make-ai.ts`, `lib/make-draft.ts`,
`lib/recipes/describe.ts`, `components/settings/make-write.tsx`). The gate is `canMake`
(`target === 'model'`), so a device that chose OpenClaw for chat sees no Write even with a working
model connected (D14; a one-line change in `lib/ai-registry.ts` if that should change). The route
reads `kind` and `ask` only, clips the ask to 1,000 characters, caps output at 2,000 tokens (and the
stream at 12,000 characters), and has its own `make` bucket, 30 an hour per user (a speed bump, as
the other buckets). The names the model sees are read server-side through the session client from
`projects`, `item_types` and `user_mods` (theme and Look names with their `u-` refs), each cleaned to
one line of at most 60 characters and framed as data; the person's Custom instructions are not sent,
since they are for chat. The prompt is generated from the schemas with a drift test, and keeps its own
exhaustive word tables because the server cannot import `lib/recipes/draft.ts` or `validate.ts`
(they reach mods-store). Where it departs from the body: a drafted step may act only on the item that
started the recipe (`item: 'trigger'`), since a named item needs an id and ids come with titles the
model never sees; a draft naming `{id}` is refused, and the person adds one in Edit. The AI never sets
`contrastOverride`: it is stripped, a contrast shortfall holds Install, and Edit opens the editor where
the person can choose it. Install goes through the existing `create*`, so it saves switched off; Edit
opens the builder for a new row with the draft prefilled (`initial`), and the Write box stays mounted
(hidden) underneath, so Cancel returns to the same card with no second AI call. A reply that names
another kind offers "Write it as a Look" (one press, which is the call); one that opens an object and
never closes it reads "cut short", since a reasoning model can spend the 2,000-token cap thinking.
The reader takes the last whole object of the asked kind, so a model that repeats the example first
still lands. Nothing is stored but what is
installed. Ask hands off through a ⌘K command, `make.write` ("Write a recipe with AI", no shortcut, in the "Made by you" group),
which opens `/settings/make?write=recipe` with the box focused and sends nothing; a chip on Ask home
is deferred (it touches the rail's layout and its e2e). `extractJsonObject` moved to the pure
`lib/json-extract.ts` (re-exported from `lib/openclaw-gateway.ts`) so the browser can use it.

**Build order 8, the mod runtime, is built** (`lib/mods/`: `runtime/` (QuickJS core, prelude, worker),
`sandbox/` (frame script, CSP, generated page), `protocol.ts`, `limits.ts`, `broker-core.ts`, `broker.ts`,
`runtime-manager.ts`, `sandbox-host.ts`, `faults.ts`, `labels.ts`; `components/mods/mod-host.tsx`;
`components/settings/mod-editor.tsx` and `mod-problems.tsx`; `app/mods/sandbox/[v]/route.ts`; no migration).
Where it departs from the body:

- **One self-contained frame page per runtime version, at `/mods/sandbox/<version>`,** not `script-src 'self'`
  and a postMessage of the wasm. The boot script is pinned by its sha256 (an opaque-origin frame's subresource
  requests are neither same-origin nor cookied, so `'self'` buys nothing). The worker glue and the wasm ride in
  the page as base64 `text/plain` blocks, so the two can never come from different deploys (emscripten's import
  names are minified). The version hashes the whole page and its CSP; the route serves only the current one
  (`dynamicParams = false`), so deploy skew is a 404, never a stale page cached as immutable. The frame echoes the
  version at boot and a mismatch reads "reload to save mods". A 404 frame never answers at all, so when the boot
  clock (from the iframe's load, never its creation) runs out, the host asks for the frame URL's HEAD
  (`lib/mods/sandbox-probe.ts`) and a 404 reads as that same reload, not "can't run in this browser". Whether Vercel keeps the route's `Cache-Control` is
  checked on the preview; if not, the route goes `force-dynamic` and checks the version by hand.
- **The worker is built at install, with no new bundler:** `scripts/build-mod-runtime.mjs` drives Next's vendored
  webpack and a loader around `next/dist/build/swc` (an `.mjs` loader, since the lint config refuses `.cjs`), runs
  on `postinstall` and `prebuild`, and fails on any chunk loading, `importScripts`, real `import(`, or app module
  (`zustand`, `@supabase`) in the bundle. A Next upgrade that moves those internals breaks the build; the fix is an
  `esbuild` devDependency, which needs Kirby's yes. The one package added is `quickjs-emscripten` 0.32.0, exact
  (not the core and variant packages separately); the release-sync variant is reached through it, and tree
  shaking keeps the debug and asyncify variants out.
- **The manifest is declared in the source** (`export const manifest = {...}`), read by the editor's scratch run
  at save and stored in `user_mods.manifest`. The stored copy is what ⌘K and the broker trust; it is Zod-checked at
  every load and must equal what the loaded code declares, or the load faults ("open it in Make and save"), which
  catches a `source` changed outside the editor. No `slug` or `name` in it (the row's, as a Look's), and no
  `panels[]` or `settings[]` until build order 9: the schema is strict, so either fails.
- **`$.store` never reaches the network inside a hook.** Reads come from a snapshot taken at load; writes go to a
  per-hook overlay that commits on success into a dirty set, flushed through `mod_store_set` one RPC per key, 5s
  after the first write since the last flush, and on `pagehide` or hide. Another device's writes show at the next
  load. Values are capped at 8KB and the whole store at 60,000 bytes as jsonb prints it (`store-bytes.ts`).
- **One handler per event, and `next` is a no-op** (a mod intercepts nothing, so chaining means nothing); a
  second handler for one kind is a load fault. A missing `manifest` or `register` export is a load fault, and so is
  top-level await.
- **The history label has a fixed host prefix,** `Mod: <name> · <hook>`, so a mod named like a built-in action
  cannot spoof the undo strip; `Mod: ` is a significant action for the undo toast. The name everywhere a mod is
  drawn is `modDisplayLabel` (the name if it passes the label rule, else the slug).
- **Mods cannot write `notes`** (the body's `$.items.edit` lists it), and projections leave notes out: notes a mod
  writes need the "untrusted" marker in the AI's context, which touches AI context code. Both come back together.
- **Saving keeps a switched-on mod on** and hot reloads it, unless the new manifest asks for a use the old one did
  not: then it saves switched off, and switching it on is the consent. Recipes differ (any manifest change).
- **Each loaded mod has its own Worker and runtime,** so a wall-clock kill takes one mod. At most 8 are loaded;
  a mod loads on its first event and unloads after 10 idle minutes with no timers. The frame compiles the wasm
  once and posts the module to each worker. Hooks a mod registered are remembered against the row's `updated_at`,
  so a mod that never listens for a kind is not loaded to hear it.
- **After boot, all traffic is on a MessageChannel port;** the boot message is checked with `event.source`. The
  frame stamps `modId` and `gen` from its own worker map, and the host takes identity, `uses` and the hook kind
  only from its own record of the one live (mod, gen, hook). `unload` may name a generation, so a hot reload's
  unload of the old one cannot kill the new. A `hook` for a worker the frame no longer has answers `done` and
  `gone`, which the host treats as a reload, never a strike.
- **Problems are `mod_runs` rows** with `claim_key = 'fault:<uuid>'` and `summary.kind = 'fault'` (061 already
  grants INSERT), left out of the run log. The "3 faults in 10 minutes" counter is per tab and in memory; a trip
  writes `enabled = false` with the reason "3 errors in 10 minutes. Last: <message>", and other devices see it on
  their focus refresh (`mods-store.refresh`, which drops an answer older than a local write). Fault logging is
  itself capped at 20 an hour per mod per tab. A `wall` fault while the tab was hidden or across a sleep does not
  count. Make draws everything after "Last:" and every fault's message under a host label, "Your mod reported:".
- **The undo event is on its own bus** (`ModOnlyEvent`, `item.uncompleted` with `origin: 'undo'`), so recipes can
  never hear it; a hook on it is read-only for items and Looks (any write would wipe redo), and undoing a mod's own
  entry does not wake that mod. Redo raises nothing.
- **No migration.** 061 already has `source`, `store`, `mod_store_set` and `mod_runs`, so this PR writes nothing
  to prod.
- **`day.opened` and `bucket.changed` are not mod events yet.** They are the recipe clock's (`recipe-host.tsx`,
  under `navigator.locks`), not `ModEvent` kinds; a mod clock needs a second leader-locked clock and cross-tab
  claims. `$.after` covers short timing. Mods hear the item events, `review.saved`, `command` and `timer`.
- **Every mod has a hook rate limit,** like recipes: more than 30 hooks a minute or 1,000 a day switches it off at
  once (the recipe wording), since only item writes are capped by the history rule (10 real entries per mod and 20
  across all mods in 10 minutes). Toasts: 1 a hook, 3 a minute. `look.set`, `nav.*` and `ui.openItem` work only
  during a ⌘K command.
- **Safe mode stops mods running, not being fixed:** the editor's scratch run and save work in safe mode; the saved
  mod does not run in that tab.
- **The wall clock lives in the frame** (500ms a hook, paused while a `$` call is out, 5s in all; 2s for a load or
  scratch), with a 6s host backstop that removes the whole frame; every mod then reloads lazily.
- **⌘K:** one provider (`modCommands`), ids `mod.<slug>.<id>`, labelled `Your mod · <name>: <label>` in the
  "Made by you" group, no shortcut and no alias. `run` is a reserved command id, so a mod's command never takes a
  recipe's `mod.<slug>.run`. A command loads its mod on demand through ModHost's slot (`lib/mods/command-run.ts`).
- **Make's editor** is a name and a plain monospace textarea, no syntax colouring and no AI of its own (a mod is
  written by AI only through Write with AI, build order 10, which opens this editor on the draft). A new
  mod starts from a Water counter (`lib/mods/template.ts`, which the QuickJS core test runs). The line under the
  code says what the manifest may do in plain words, from the stored manifest (or the template's) until a save has
  read the code. When the sandbox cannot run in this browser the editor says so and does not save; a mod name must
  pass the label rule (`lib/mods/labels.ts`: NFKC, no format characters, no mixed-script word, no links, bare
  domains or key shapes, none of AI, Settings, Sign in, Account, key, Beacon or a provider name).
- **The end-to-end** (`tests/e2e/mods-sandbox.spec.ts`) runs in Chromium only: the Playwright config has no Firefox
  or WebKit project yet. Adding them (with the CI browser installs) is the next step for cross-engine coverage; the
  spec already asserts "Mods can't run in this browser yet" outside Chromium rather than skipping. The preview-deploy
  checks (the route's `Cache-Control`, and the frame loading in the desktop shell) are Kirby's, on the PR's preview.
- **Electron needed no release.** `/mods/sandbox/<v>` is an app URL, so `guardSubframe` passes it; the preload
  does not run in subframes. The permission handler's `isApp` matches the frame too; refusing permissions to
  subframes is recorded in [desktop-app.md](desktop-app.md) for the next shell release.

**Build order 9, the mod UI, is built** (`lib/mods/ui/`: `tree.ts`, `icons-list.ts`, `icons.tsx`,
`panel-store.ts`, `panel-run.ts`, `surface-state.ts`, `card.ts`, `open-panel.ts`, `sheet-store.ts`;
`components/mods/`: `mod-tree.tsx`, `mod-surface.tsx`, `mod-item-ref.tsx`, `mod-rail.tsx`, `mod-opener.tsx`,
`mod-card.tsx`, `mod-sheet.tsx`; `components/settings/mod-settings-form.tsx`; the shadcn-shaped `checkbox`,
`progress` and `separator` wrappers; rail-store's `'mod'` mode; no migration, no new package). A mod declares
`panels[]` (at most 4, at most one `card: true`) and `settings[]` (at most 10); a `ui.resolve` hook returns an
element tree the host parses (UTF-8 size, an iterative walk against the caps, then Zod, never throwing) and draws
with its own components under its own chrome. Where it departs from the body:

- **The person's own hooks and the resolves are off the hook rate.** `ui.resolve` has its own coalescing (one in
  flight per panel, 250ms apart) and a cap of 60 a minute per mod, over which the last tree stays with "Paused,
  redrawing too often". `ui.action` and `atom.changed` have a budget of 60 a minute per mod, over which a press is
  dropped with "Slow down a little", never faulted. CPU, wall-clock and call caps and the fault counter still apply.
  `command`, `timer` and item events keep the 30 a minute and 1,000 a day switch-off. A fault never starts a resolve:
  while a panel shows its error only Try again, a save or a settings save draws it again, so a throwing panel cannot
  trip the 3-fault switch-off by itself.
- **`ui.action` and `atom.changed` writes skip the history window** (10 entries per 10 minutes), as the person's own
  gestures, like their own tick; a checklist panel would otherwise trip the switch-off. Commands keep it. Their
  history labels are `Mod: <name> · <panel label>` and `Mod: <name> · <atom key>`.
- **The rail reserve is the same 432px** (`RAIL_RESERVE_PX`) and the column the same 420px. "Its own share" is read
  as "it reserves while docked": a narrower column would make an item opened over the panel jump in width.
- **The `'mod'` mode is its own summon.** rail-store's `modPanel` is memory only and set only by an explicit open
  (the header key, ⌘K, a held `$.ui.open`, all through `lib/mods/ui/open-panel.ts`). It shows at any width, docked
  or as an overlay, with or without AI, and never writes Ask's `summoned` or `askOpen`. Precedence is
  `item > mod > ask > setup > hidden`: opening a panel closes an open item first, an item opened over the panel
  wears "‹ Your mod · <name>" (Back shows the panel, ✕ closes both), and Ask's summon replaces the panel. Closing
  the panel leaves a kept-open Ask as it was (docked, it shows again). An overlay's click-away, Escape there and a
  window narrowing into one go through `parkOverlay()`, which closes the panel and then parks. Ctrl+J
  (`toggleRail`) closes a panel before anything else; with no AI, where Ctrl+J is consumed before the toggle,
  ⌘K's "Close your mod's panel" (`mod.close-panel`) is the keyboard's way out.
- **`look.set` is allowed in `ui.action`** as well as `command`. `ui.open`, `ui.openItem`, `nav.go`,
  `nav.organize` and `look.set` are the `USER_ACTED` set: refused unless the hook is `command` or `ui.action`.
  While drawing (`ui.resolve`) a mod may only read (`RESOLVE_ALLOWED`, an allow-list, so a future method is refused
  there by default).
- **`atom.changed` may write items and the store but never navigate.** Atoms are the panel's UI state, mod-wide
  (no panel id), memory only, never persisted. The person's input sets them, and so does a mod's `$.atom.set`
  (never in `ui.resolve`); a mod's own writes fire no `atom.changed`. Every value is checked against the node that
  shows it, and the renderer shows the node's `initial` for one that does not fit.
- **Settings live in `store['@settings']`** (no migration), written by the existing `mod_store_set` from Make's
  form ("Set by your mod <name>"), and read by the mod only through `$.settings.get()`. `@`-prefixed store keys
  are unreachable to a mod's `$.store` (and left out of `store.keys`); a PR 8 mod that wrote one loses it, accepted
  rather than a migration. A settings save reaches a loaded mod in memory (`settingsChanged`), with no reload.
- **The braindump card picks the earliest-created switched-on mod with a card panel,** on the desktop only, in
  every layout, mounted only while the braindump is open (never in a hover peek); Make says which card is showing.
  A mod's first card panel needs re-consent: a save that adds one saves the mod switched off (`consentWidened`).
- **A stricter surface rule** (`passesSurfaceRule`, `lib/mods/labels.ts`) applies to every string PR 9 draws:
  the label rule's words plus sign-in, session, model and chat words, and a wider secret-shape test
  (`SECRET_SHAPED_RE`). What the person types is refused only when shaped like a secret (`isSafeTypedValue`, so
  "chat with mom" is fine). Fault text that fails it shows as "(message hidden)". Both are new functions, so PR 8's
  label rule, and the manifests stored under it, are unchanged.
- **`ui.resolve` carries no `presentation`.** There is one tree per panel, whatever mounts it; the rail, the card
  and the sheet share its cache and its atoms.
- **`itemRef` needs `items:read`,** and draws the item from the planner as it is now (title, type glyph, time),
  never from anything the mod sent but the id.
- **New method names:** `ui.open`, `atom.get`, `atom.set` and `settings.get`, appended to `MOD_METHODS`.
- **New UI wrappers** for checkbox, progress and separator, over Radix packages already installed. No new package.
- **A maximal manifest exceeds 8KB** (20 commands, 10 settings and 4 panels come to about 15KB). The cap stays, and
  the scratch run reports "manifest too large"; a realistic one (5 commands, 4 panels, 10 short settings) fits.
- **Clicks go only to what the person saw:** a press counts when the tree's sequence number is the one at
  pointerdown or keydown, the button has been unchanged for 500ms, and `(action, arg)` is unique in the tree. The
  manager checks a press against the host's cached tree and its sequence, never the runtime generation, so an idle
  unload or a reload never swallows a click.
- **The phone has no card and no rail.** A panel opens there in a vaul sheet (`components/mods/mod-sheet.tsx`,
  hosted by the phone shell through `setModSheetHost()`, a count), with nothing focused on open. An `itemRef` row,
  a held `openItem` or a held nav step closes the sheet first, so two drawers never stack.

Where the code departs from its own spec (the PR's three parts): `onPanelsStale(modId, why)` carries the reason
(`hook`, `saved`, `enabled`, `changed`, `settings`), which is how an errored panel tells a save from a hook; a tree
the host refuses becomes a counted fault through the manager's `panelFault`; `runAction` takes the press's sequence
and checks it through an injected `PanelBridge`, so the manager never imports the panel store; `atom.set` is allowed
in timer and item hooks too (only `ui.resolve` refuses it). The panel store keeps plain records rather than Maps,
draws once after a throttled minute ends, and holds a request for a hidden panel until it next mounts. The card's
chrome always wears the host's Puzzle glyph (the rail and sheet wear the panel's icon). A mod's Select is built from
the Radix primitives, since the shared trigger's chevron fades through an opacity the lime rule refuses.
`ModPanelRef` lives in `lib/rail-store.ts` (re-exported by `open-panel.ts`). The rail's mod panel never wears
`data-rail-view`, which means Ask. `mod.close-panel` is in the mods provider whenever any mod exists, hidden unless a panel
shows, since a panel stays open (saying it is off) after its mod is switched off. The end-to-end
(`tests/e2e/mods-panels.spec.ts`) runs in Chromium and the phone project, under the same "can't run here" rule as
build order 8's.

**Build order 10, AI writes mods, is built** (a fourth Make kind, `'mod'`, through build order 7's pipeline:
`lib/ai-limits.ts`'s `MAKE_CAPS`, `app/api/ai/make/route.ts`, `lib/ai-server/make-prompt.ts`'s `modSection()`,
`make-context.ts`, `lib/make-draft.ts`'s mod reader, `draftChecks` and `finishModDraft`, `lib/mods/words.ts`,
`components/settings/make-write.tsx`, `make-pane.tsx` and `mod-editor.tsx`, and ⌘K's `make.write-mod`; no new
package, no migration, no new table, no new endpoint). Between reading the reply and showing the card, the client
runs the code once in the sandbox (`modSandbox.scratch`: no `$`, no handler runs), and the card reads the manifest
that run declared, never one the reply wrote apart from the code. Decision 6 holds: the gate is `canMake`, a mod
gets 4,000 output tokens, and `$` has no AI, ever (`tests/unit/mods-no-ai.test.ts` locks `MOD_METHODS` and the
import graph).

What the safety rests on: Install saves switched off (`createMod` writes `enabled: false`); the runtime refuses
code whose manifest differs from the stored one (`manifestsEqual`); consent is re-checked; the broker gates every
call on `METHOD_USES` and `z.enum(MOD_METHODS)`. Everything the draft reader adds on top (the label rules, the
literal scan, the `$.x(` scan, hook and manifest agreement) is a quality and copy guard, not a security boundary,
and the card never words it as one. Where it departs from the body:

- **The route's deadline is 120s.** `maxDuration` on `/api/ai/make` went from 60 to 120: a mod gets 110s, recipes,
  themes and Looks keep 50s, since at 40 to 80 tokens a second a 4,000-token reply takes 50 to 100s. `vercel.json`
  is `{}`, so 120s depends on the Vercel plan, which Kirby confirms on the preview; if it is not allowed, the
  fallback is 60/50 and more "cut short" replies. A reasoning model spends part of the 4,000 on reasoning, so
  "cut short" is more common for it.
- **No project names for a mod, and none are even read.** `buildMakeContext(db, userId, kind)` skips the
  `projects` select for a mod. Projects are agent-writable, so their names may carry instructions, and an
  agent-writable name never reaches a prompt that writes code. Type labels and theme and Look names are owner-only
  and are still sent. The prompt says project names come from the ask or from `$.containers.list()` at run time.
  This is narrower than build order 7's privacy line (ai-vision.md, "Not stored", says so).
- **An AI draft meets stricter rules than a hand-written mod, in the editor too.** Command labels and keywords must
  also pass `passesSurfaceRule`, and a string literal shaped like a link (`URL_RE`) or a secret
  (`SECRET_SHAPED_RE`) holds Install. `BARE_DOMAIN_RE` is not used on source: it matches every dotted event name,
  `'ui.resolve'` included. These are `draftChecks()` in `lib/make-draft.ts`, and the mod editor runs them on every
  Save of a session opened from a draft (`fromAI`, which an edit never clears), so Edit then Save cannot step
  around them. A problem names a command by position and never repeats the model's text, except the `$.x` of an
  unknown call (identifier characters only, at most 40).
- **Panel trees are not checked before Install.** Scratch runs no hooks, so a bad `ui.resolve` tree shows later as
  a panel fault; under build order 9 a resolve fault never switches a mod off by itself.
- **One example in the prompt,** the Water template (`MOD_TEMPLATE`), the only mod the QuickJS test already runs.
  A reply whose source is the template (compared trimmed) is refused as an echo.
- **A mod costs two from the `make` bucket.** `takeToken` takes a `cost`, refusing without recording anything when
  fewer are left, so an hour's output ceiling stays at build order 7's 60,000 tokens. The bucket stays in memory
  per instance.
- **The name rule is stricter for a mod only.** `draftName` also requires `isModLabel` for a mod; recipes, themes
  and Looks keep `ModNameSchema` alone, so "Card rhythm" stays a recipe's name.
- **Scratch on the Write press can trip the 6s host backstop,** which removes the frame and stops every running mod
  in the tab (they reload lazily). Accepted; scratch never calls `$`.
- **The hooks the card shows are "as written now".** `register(on)` is ordinary code and may branch on
  `Date.now()`; the runtime compares manifests, never hooks. So the card's warnings come from the manifest ("It can
  change items when its code runs, including on its own." for `items:write`), and hooks only add detail.
- **An indirect AI path, noted.** A mod with `items:write` writes item titles, and `/api/chat` sends titles to the
  person's model. The chat context's "data, not instructions" framing is the backstop; the prompt adds that titles
  a mod writes are fixed short words, never text meant for a reader to follow.
- **A `$` call while loading does not always fault.** The prelude defines `$` as a global and the core refuses any
  call made while loading, so an un-awaited `$.items.create(...)` at the top level or in `register` loads without a
  fault. What always holds is that no call reaches the host; an awaited one, a missing global and top-level await
  all fault (`tests/unit/make-mod-roundtrip.test.ts`).
- **The reader repairs raw control characters for a mod only.** A raw newline, carriage return or tab inside a
  JSON string becomes its escape (other control characters `\u00XX`), since `json: true` has no effect for
  Anthropic and OpenRouter. An object left open at the end is "cut short" even after an earlier one closed, so an
  echoed example followed by a truncated draft never installs the example. A recipe keeps the old rules.
- **What the card and the editor show of the model's words.** A fault reads "It would not load." (or "It would not
  load: it hit an error." and the like), and its message only through `surfaceMessage` under "Your mod reported:";
  a manifest the schema refuses shows only the path, never Zod's message, which can quote the model's values. The
  editor passes every fault message and manifest issue through `surfaceMessage`, for every mod, not only AI ones.
- **A draft that would not load opens the editor with nothing read** ("Not read yet: save to check it."), never the
  template's uses or words.
- **Words shared by the card and the prompt are neutral** (`lib/mods/words.ts`: "when an item is ticked", not
  "when you tick an item"), since the same table speaks to the person and to the model. The tree size cap is
  printed as a raw byte count so a test can match it to the constant, and the icon list is printed once.
- **The import-graph test is split** (`tests/unit/mods-no-ai.test.ts`). Followed all the way, `broker.ts` and
  `ui/open-panel.ts` reach app-wide stores that import chat for the app's own Ask, so the test checks that nothing
  reachable reaches `lib/make-ai` or `lib/ai-server/**`, that no file under `lib/mods/` imports
  `conversations-store`, `chat-target`, `make-ai` or `ai-server` directly, and that from `lib/open-chat` they take
  only `leaveZen`.
- **⌘K's "Write a mod with AI"** (`make.write-mod`, the same group, glyph and `canMake` gate as `make.write`, no
  shortcut) opens `/settings/make?write=mod`; Make boots the sandbox when the kind becomes a mod and holds Write
  until it answers, saying why when it cannot run ("Mods can't run in this browser, so AI can't check one here.").
  No chip on Ask home. Safe mode changes nothing: scratch and Install work, and the mod saves switched off.
- **The end-to-end** (`tests/e2e/make-write-mod.spec.ts`) answers `/api/ai/make` with canned frames, so nothing
  leaves the machine, and runs under build order 8's "can't run here" rule.

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
cheap question waited for the PR that adds timed triggers (build order 6), since
no recipe could have one before then. 062 widens it, with a partial index on
switched-on timed recipes.

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
