# Plugins, Themes & the Store — extensibility across dsul (and future apps)

> **Addendum (2026-10-01): the in-app extensions store is NOT Project C.**
> `/extensions` (components/extensions/) is a storefront over the eleven
> FIRST-PARTY entries in `OFFICIAL_EXTENSIONS`: a featured slot, four shelves
> grouped by what an extension does for you (`shelf` on the manifest), a live
> preview per extension (inert sample scenes, CSS-animated, still under either
> motion veto), and a card per extension that links to its settings pane. The
> pane gained a header (`components/settings/extension-hero.tsx`) with the
> preview, what changes, needs/cost chips and a maker's note; the switch is still
> the pane's own record. Nothing here registers, downloads or runs third-party
> code — Project C's registry, review and payments questions are untouched.
>
> **Open question 9 (telemetry vs privacy) is answered for this store:**
> migration 051 keeps an append-only, owner-readable history of extension
> switches (`extension_toggle_events`, written by a trigger), and
> `extension_adoption()` — service role only — returns per-slug COUNTS.
> `/api/extensions/adoption` turns them into fractions rounded to 5% and withholds
> any figure resting on fewer than 20 people or with fewer than 5 on either side
> of the split (lib/extension-adoption.ts). "Kept on after 30 days" is never
> computed for a default-on extension, and backfilled history is left out of it.
> Before launch the store shows no figures at all, which is the intended state.
> Reviews: no stars; the maker's note is the store's only "review" until then.

**Status (2026-08-12): Projects A and B have v1 implementations in the working
tree** (curated preset palettes + the official-extensions framework — see the
build ledger at the end). Research complete (five-researcher sweep + adversarial
critique + safety-model research). Store (Project C) and payments (Project D)
remain unbuilt, gated on demand per the sequencing below. This plan answers three questions Kirby asked: what kind of solution a
plugin/theme store is, whether third-party infrastructure exists for it, and whether
the whole thing is too big — and lays out a phased path for both the store and the
in-app plugin/theme system. Read [unified-items.md](unified-items.md) for the item
registry's locked decisions; nothing here amends them.

**The honest headline:** the full vision (in-app runtime + community store + payments)
is a real product in itself, but it phases unusually well *for this codebase
specifically* — the token system means themes need near-zero refactoring, and the
OpenClaw plugin means a versioned external plugin API already exists and has a
production consumer. The killer at solo scale is not hosting or code; it is **ongoing
human review time** and **support burden**. Every sequencing decision below exists to
defer those two costs until demand proves they're worth paying.

## The three questions, answered

1. **What kind of solution is this?** Three separable projects on different clocks:
   (a) an in-app theme system (weeks, all value accrues to dsul even if no store
   ever exists), (b) an in-app plugin system (mostly *already built* if "plugin" is
   scoped to declarative config + the agent API; a money-pit if it means sandboxed
   third-party JS), and (c) a store, which at v1 is **a GitHub repo with CI, not a
   platform** — one public registry repo shared across all apps, a JSON index
   compiled on merge, files served from authors' GitHub releases. That is the shape
   Obsidian, Raycast, Zed, Sublime Package Control, Flow Launcher, and HACS all
   converged on, at near-zero hosting cost.

2. **Does third-party infrastructure exist?** For the *store itself*: effectively no —
   "plugin marketplace as a service" is not a product category in 2025–2026. What
   exists is either enterprise integration-marketplace SaaS (Pandium/Prismatic —
   wrong shape, enterprise pricing), format-specific registries (Open VSX is VS
   Code-only), or bare package registries (Verdaccio/Nexus — package storage plus
   Docker/TLS/backup ops, no store UX). Don't buy any of it; the GitHub-registry
   pattern is genuinely less work. For the *payments layer*: yes, turnkey —
   merchant-of-record services (Polar.sh, Stripe Managed Payments née Lemon Squeezy,
   Paddle) and that is exactly the layer worth outsourcing.

3. **Is it too big?** As one project, yes. As the three projects above built in
   demand order, no. The trap (named explicitly by the critique) is building the
   marketplace before the audience: a store's success everywhere we studied followed
   app popularity, never created it. Build the parts that make dsul better today
   (themes, registry config, API hardening); gate the store parts on a real
   community existing.

## What the research found

### Store prior art (web sweep)

- **Obsidian is the canonical solo-scale model.** Its entire store is one GitHub repo
  (`obsidianmd/obsidian-releases`): `community-plugins.json`,
  `community-css-themes.json`, stats JSON, and `-removed` blocklist files. Submission
  = PR adding a JSON entry; a bot validates in minutes; staff merge. Version updates
  after acceptance need no re-review — the app pulls straight from the author's
  GitHub release. Payments don't exist; manifests carry donation links.
- **Obsidian's bottleneck is the human first review** — 3-week to 3-month waits are
  chronically reported. WordPress survives 500 submissions/week only via heavy
  scanner automation and still left 38.7% of reviews unanswered by authors. Review
  time is the one real ongoing cost of this model.
- **Obsidian's known supply-chain hole is unreviewed auto-updates** (the app trusts
  whatever the author releases next). **Zed closes it cheaply**: its registry pins
  every extension version — a version bump is a registry PR, and Zed's CI packages
  and hosts the artifact on merge. Pin versions; record the reviewed tag or content
  hash.
- **HACS's failure teaches index design**: clients crawling the GitHub API directly
  hit the 60 req/hr unauthenticated limit so hard every user now needs a GitHub
  token. Serve a **pre-compiled index** (built on merge, hosted via jsDelivr/Pages or
  a cached Vercel route); never let clients call GitHub's API.
- **Even giants refuse to run store payments**: Google killed Chrome Web Store
  payments outright (2020–21) and VS Code never built them — both push authors to
  external license keys. The platforms that do run payouts (Figma: 15% cut via
  Stripe, ~1-month reviews, $2 minimum, 30-business-day payout delay; Elgato: 70/30
  via Stripe Connect) absorb fraud monitoring, disputes, and payout ops in exchange.
- **Every store studied separates one-time admission review from ongoing updates**,
  and the sustainable solo configuration automates everything except the merge
  click: CI schema validation + release-asset checks + static scans on the PR, human
  merge as the only manual step, and a blocklist JSON the app checks as the
  kill-switch.

### Payments (web sweep)

- **Three stages with a phase change in the middle.** Stage 1 (sell *your own* paid
  items): a merchant of record absorbs global sales tax/VAT, refunds, chargebacks —
  Polar.sh free tier (5% + $0.50, native license keys + entitlement "benefits",
  developer API) is the best current fit; Stripe Managed Payments (Lemon Squeezy's
  successor, same 5% + $0.50) entered public preview Feb 2026 and is where new
  stores should look once it opens. Avoid Paddle (strict vetting, heavyweight,
  post-FTC-settlement) and Gumroad (10% + processing) for this shape.
- **Lemon Squeezy itself is mid-migration** (Stripe acquired it July 2024; support
  decay and account freezes reported through 2025) — don't build new on it.
- **Stage 2 is the phase change: no MoR supports multi-seller marketplaces.**
  Paddle's AUP bans enabling third-party sellers outright. The moment community
  authors get paid *through* the store, the MoR shelter is gone and the store owner
  becomes the platform: Stripe Connect Express ($2/active account/mo + 0.25% +
  $0.25/payout on top of base processing), KYC via Stripe, 1099-K filings
  ($20k/200-txn threshold post-OBBBA), and **marketplace-facilitator sales-tax duties**
  in every US state once platform-wide gross sales cross nexus thresholds (typically
  ~$100k/state/yr). Long runway for a niche PWA, but nobody waives it.
- **The escape hatch most indie ecosystems actually use is link-out**: community
  authors sell independently (own Gumroad/Polar store, own license keys); the store
  lists the item with a "Buy from author" button plus a small key-redemption
  contract so externally-sold items still unlock in-app. Zero tax/KYC/refund
  liability. This is where Obsidian still sits and Figma sat for years.
- **Rev-share norms cluster at 15%** (Figma 15%, JetBrains 15%, Shopify 0% to $1M
  then 15%) — if a true marketplace ever happens, 15% is the defensible number; 30%
  reads extractive for an indie store.
- **Piracy is a non-issue for a server-backed PWA**: entitlements enforced
  server-side (a Supabase table checked by API routes/RLS) mean there's no binary to
  crack — copying requires account sharing. A one-time key redemption writing an
  entitlement row is the right ceiling; anything more is wasted effort.

### Theming readiness (codebase sweep)

dsul is **unusually theme-ready** — the color-refactor sprint most apps would need
does not exist here:

- Tailwind v4 CSS-first (no `tailwind.config.*`; everything in
  [app/globals.css](../../app/globals.css), ~1262 lines) with a disciplined
  three-layer token system: raw ramps (`--paper-*`, `--ink-*`, `--lime-*`,
  `--honey-*`, `--coral-*`) → surfaces (`--surface-0..3`, `--canvas`) → full shadcn
  aliases plus dsul domain tokens (~90 color properties per mode, fully restated
  in `:root` and `.dark`).
- **Zero hardcoded Tailwind palette utilities repo-wide** — 747 token-class usages
  across 74 component files; the only literals are deliberate (destructive
  `text-white`, one AlertDialog scrim, onboarding overlay/confetti, one shadow rgb
  in week-schedule).
- **The lime accent is 100% token-fed** (`--lime-solid/-ink/-tint` feed `--primary`,
  `--success`, `--ring`, `--day-today`, `--accent-8`); dark mode deliberately
  *raises* lime energy. Any theme must inherit the never-dim/own-element contract.
- **Shadows are bimodal physics, not colors**: light mode uses black drop shadows;
  dark replaces them with inset white light-catch lips (`--shadow-elev-*`,
  `--sched-*`, `--bkt-*` families, deliberately outside `@theme`). A theme must
  declare itself light-like or dark-like; free-form is not on the table for v1.
- Dark mode is next-themes class-based; the choice round-trips through
  `user_settings.theme` (open text column) via
  [lib/settings-service.ts](../../lib/settings-service.ts) with its documented
  `STABLE_SETTINGS_COLUMNS` / `PENDING_SCHEMA_COLUMNS` footgun (a column skipping
  PENDING silently resets every user's settings).
- **Prior art already in-repo**: `data-type-mode` on the html element (app-shell
  stamps it, globals.css keys off it) is exactly the mechanism a `data-theme`
  attribute would use, and [lib/relay-palettes.ts](../../lib/relay-palettes.ts) is a
  committed catalog of 8 named oklch palettes whose header comment says it exists
  "to back a future user-theming control". The relay field already reads live tokens
  via `getComputedStyle` and detects dark by parsing `--background` lightness — it
  survives new themes for free.
- JS branch points a third theme must survive: relay-field's `isDarkContext()`,
  onboarding's `useIsDarkMode()`, use-command-context's dark|light collapse,
  sonner's theme prop, and the **static PWA `themeColor` hex in app/layout.tsx**
  (needs a dynamic `<meta name="theme-color">` updater).

### Plugin extension points (codebase sweep), ranked easiest → hardest

1. **External agent-API consumer — works today, zero new code.** The OpenClaw plugin
   is complete prior art: RFC-8628-style device flow issuing an `dsul_` key,
   Zod-validated `schemaVersion: 4` context contract, CRUD routes, HMAC-signed
   webhooks, drift-throwing `safeParse` in the client. This *is* the official plugin
   surface; a second consumer needs nothing built.
   **Known gaps:** [lib/openclaw-registry.ts](../../lib/openclaw-registry.ts) holds
   webhook registrations in an in-process `Map` — a live bug on serverless (dies on
   cold start, absent on other instances, flagged by its own comment); one unscoped
   plaintext API key per user in `user_settings.openclaw_api_key`; closed webhook
   event enum (programs/routines writes deliberately emit no webhooks).
2. **Custom item types via config — 80% built.** `item_types` (migration 021) has
   RLS and a `config` jsonb column *reserved for capability overrides that nothing
   reads yet* — every custom type hydrates a fixed task-shaped template. Waking
   `config` one capability at a time (start where no DB CHECK or external contract
   bites: `allowedFrequencies`, `braindumpEligible`, `defaultBlockMinutes`) is pure
   product value regardless of any store. Hard limits: `items_status_check` pins
   non-built-in types to the task status vocabulary (new statuses = migration), and
   the legacy `tasks[]`/`habits[]` projections + webhook names are frozen contracts.
3. **Command palette — pattern exists.** `resolveCommands(ctx)` already composes
   static commands + `CommandProvider` outputs (custom types, routines, programs are
   live providers). A plugin provider slots straight in. Constraints: providers run
   per keystroke (cheap/sync only) and may not own keyboard shortcuts (bindings
   persist by command id; a vanishing command strands overrides).
4. **Beacon AI — context yes, tools no.** The registry's `ai.renderContextSection`
   means any registered type narrates itself to Beacon already. But
   [app/api/chat/route.ts](../../app/api/chat/route.ts) has **no tool-calling
   loop** — in-app Beacon cannot execute anything; all 10 agent tools live on the
   OpenClaw side. "Plugins add AI tools" is config-only on the OpenClaw path but
   gated on building a tool-use loop in-app — decide that as an app feature on its
   own merits, not as store scope.
5. **Per-plugin settings/toggles — idiom clear, table missing.** Copy the
   021_item_types.sql shape (numbered migration, idempotent guards, per-user RLS,
   `enabled boolean`, jsonb config). Do NOT add user_settings columns per plugin
   (the PostgREST missing-column reset footgun).
6. **Sidebar panels — no slot system exists.** Fixed composition, Figma-pinned
   dimensions.
7. **Canvas views — hardest.** Closed `ViewLayout` unions, canvas-container
   1100px/data-wide invariants, DnD, fit-to-height, and everything built twice
   (desktop-shell + mobile-shell). Worst effort-to-value on the board.

### Safety model (dedicated security sweep) — three tiers with honest price tags

The organizing insight comes from Figma's plugin-system history: they rejected
iframes for plugin *logic* (serializing a big document across the boundary took 14
seconds before the plugin could even run), shipped the Agoric Realms shim
(same-realm isolation), got a privately-disclosed sandbox escape in it, and landed
on **plugin code running inside a QuickJS interpreter compiled to WebAssembly** —
"JavaScript doesn't have to be dangerous; it's the *Browser APIs* that are
dangerous." The VM has no `window`/`document`; a ~500-line audited opaque-handle
membrane is the only door, so new APIs can be added without re-auditing the
sandbox. The WASM boundary is a hard memory boundary: even a memory-corruption bug
in QuickJS can't escape it. Cost: ~10–50× interpreter slowdown (fine for short
event-driven actions, wrong for hot loops), and maintained wrappers exist
(`quickjs-emscripten`, `@sebastianwessel/quickjs`).

Other load-bearing facts:

- **Web Workers are not a security sandbox** — same-origin, free `fetch()` to
  anywhere, `importScripts`. They isolate jank and crashes, not authority. Useful
  as a layer (host the VM in one), useless as the only barrier.
- **SES/LavaMoat (MetaMask's school)** hardens the same realm: freeze intrinsics,
  run each dependency in a Compartment, gate powerful APIs per-package. Strongest
  *same-thread* option, native speed, proven in production — but same-realm shims
  are exactly where Figma's escape happened, and policies are ongoing work. Right
  tool for *your own* supply chain, not for hostile code.
- **Obsidian/VS Code are the honest no-sandbox datapoints.** Obsidian's docs admit
  it "is unable to reliably restrict plugins to specific permissions"; mitigations
  are social and reactive (Restricted Mode on by default, one-time review,
  community reporting, **no kill-switch**). VS Code extensions run in a
  full-privilege Node host; one study flagged 26.5% of analyzed extensions
  high-risk. Cheap to build, permanent exposure to operate.
- **UI extension is a clean three-way**: null-origin sandboxed iframe (hard
  isolation, async friction — Figma's choice for untrusted UI), host-rendered
  declarative UI from a JSON/DSL (safest, most on-brand, caps expressiveness,
  requires a versioned widget vocabulary), remote React / module federation
  (**zero isolation — never for community code**).
- **Capability-passing beats permission-declaring; do both.** Plugins act only
  through unforgeable handles the host granted (attenuable, namespaced — a handle
  to *this plugin's* storage, not the store); a manifest declares intent up front
  (Figma's `networkAccess.allowedDomains` is the model: default `"none"`,
  undeclared domains CSP-blocked, declarations shown to users at install and
  reviewers at review). Note dsul-specific: RLS is per-user, so any plugin
  running as the user inherits the user's full data reach unless every read/write
  is mediated through capabilities.
- **CSS is an active exploit surface, and VS Code vs Obsidian is the exact A/B
  test.** Attribute selectors + `background-image: url()` form a scriptless
  keylogger (`input[value^="a"]{background:url(/log/a)}`); the same trick
  exfiltrates DOM state, and `:has()`/overlays enable phishing redressing — no JS,
  so script blockers never fire. VS Code themes are JSON assigning values to a
  **fixed registered palette** — a theme literally cannot emit a selector or URL.
  Obsidian themes are arbitrary CSS and pay with a permanent attack surface plus a
  no-auto-update policy. dsul's token-JSON theme shape (Project A) is the VS Code
  side of this test by construction: strict value grammar (color/length/number/
  enumerated keywords), reject `url()`, `image-set`, `@import`, selectors,
  `content`.
- **Supply-chain hygiene a solo dev can run**: pin version + content hash
  (SRI-style — the browser refuses bytes that don't match), sign releases,
  re-review update *diffs* (the gap Obsidian names), static analysis as triage
  (never verdict), and a remote blocklist checked before every load, shipped
  **before** the first third-party plugin, not after the first incident.

**The tiers, priced:**

| Tier | Model | Cost | Precedent |
|---|---|---|---|
| (a) Themes | Closed token set, validated grammar, no raw CSS ever | ~1–3 days | VS Code (don't copy Obsidian) |
| (b) Official plugins | In-realm for speed; SES/LavaMoat around deps; same capability API as tier (c) so it's dogfooded | ~1–2 weeks, mostly reusable | VS Code/Obsidian posture, fine when you author every byte |
| (c) Community plugins | QuickJS-in-WASM logic (in a Worker) + null-origin iframe UI + manifest permissions + capability handles + hash pinning + kill-switch | **4–8+ weeks build, permanent review/incident ops** | Figma (the gold standard; they host untrusted code at scale) |

The sober staged path: ship (a) and (b); if community code ever happens, start as a
**closed, invite-only "verified plugins" program** — full isolation, kill-switch
live from day one, you personally review everything — and widen only after the
pipeline proves itself. Isolation is built once; review is paid forever, so the
sandbox must be strong enough that a *missed* review can't become a catastrophe.

## The keystone decision (decide before any store work)

**What is an in-app plugin, concretely?**
(a) **Declarative-only**: manifest-driven theme tokens, item-type config, palette
command entries, agent-API connections — zero third-party JS executes in-process; or
(b) **Sandboxed code**: iframe/worker RPC runtime, capability brokering, CSP work.

Everything downstream waits on this. The critique's position: (a) covers most
realistic extension ideas at a tenth of the cost, and *saying it out loud publicly*
prevents a community from building against a runtime that will never exist. Also
decisive: Vercel/Next.js constraints — bundles compile at build time, remote ESM
against the app's CSP has no clean way to share the host React instance, and
arbitrary third-party *server* code on Vercel is effectively impossible. The
declarative scope is not just cheaper; it is what the deployment platform wants.

The safety research sharpens rather than overturns this: **declarative-only now**,
and if community code is ever justified by demand, the only acceptable shape is the
Figma model (QuickJS-in-WASM + null-origin iframe + capabilities + kill-switch,
tier (c) above) entered via a closed verified-plugins program — never the
Obsidian/VS Code full-trust model, whose permanent exposure is exactly what a solo
operator cannot absorb. The recommended public vocabulary: "themes" (token JSON),
"extensions" (declarative manifests: item types, palette commands), and
"integrations" (agent-API consumers à la OpenClaw) — reserving the word "plugin"
until/unless tier (c) exists.

## The plan — three projects, three clocks

### Project A — themes in-app (BUILD NOW; weeks; zero store dependency)

1. Theme = `{ slug, name, baseMode: 'light'|'dark', tokens: Record<token, value> }`
   overriding the **raw ramp + standalone semantics only** (~45–60 values). Surfaces,
   shadcn aliases, and the wash/schedule/bucket families derive via
   `var()`/`color-mix` and come along for free — the derivation chain is the
   codebase's biggest theming asset.
2. **`.dark` stays the physics switch; `data-theme` becomes the palette switch.** A
   dark-based theme stamps both. The 24 `dark:` variants, shadow light-catch system,
   and every JS isDark branch keep working untouched.
3. Apply via a `ThemeInjector` client component emitting
   `:root[data-theme='slug'] { … }`, with the active token map cached in
   localStorage and a blocking inline script in layout.tsx to kill pre-hydration
   flash (next-themes only pre-applies the class, not token values).
4. **Persistence: a separate `user_settings` column for active theme slug** (started
   in `PENDING_SCHEMA_COLUMNS`!) rather than overloading `theme` — the critique
   flagged that `'custom:slug'` in the existing column feeds arbitrary strings into
   four places that parse a tri-state. Installed themes: a `user_themes` table
   (jsonb tokens, RLS), numbered migration, ledger recorded.
5. **Ship curated preset themes first** (token JSON in-repo, picked in the settings
   dialog next to the existing Light/Dark/System select — relay-palettes is the
   intended pattern). Presets exercise injection + persistence with zero validation
   burden. User-imported theme JSON comes later, just before any community pipeline,
   with a value grammar (color/length whitelist, no `url()`), contrast checks, and
   accent-contract validation.
6. **Safe mode from the first preset**: a broken theme must be resettable from an
   always-readable path (URL- or keyboard-level reset) — you cannot fix a theme from
   UI you can't see.
7. Dynamic `<meta name="theme-color">` updater; decide whether the 4 deliberate
   literals become tokens; shadows overridable per baseMode at most.

### Project B — plugin foundations in-app (BUILD NOW, as ordinary app work)

1. **Fix the webhook Map** → Supabase table (next migration number; model on
   021_item_types.sql: per-user rows, RLS, jsonb config, `enabled boolean`). This is
   a live serverless bug *and* it doubles as the plugin manifest + per-user
   enable/disable store — the toggle UX Kirby asked for rides this table.
2. **Wake `item_types.config`** one capability at a time (safe first:
   `allowedFrequencies`, `braindumpEligible`, `defaultBlockMinutes`) — dsul
   features for dsul users, independent of any store.
3. **Defer per-plugin hashed/scoped API keys until a second real consumer exists** —
   and when migrating off the plaintext single key, dual-read the old key through a
   deprecation window with a coordinated OpenClaw npm release, or the drift-throwing
   client bricks the one production integration.
4. If/when durable webhooks matter: delivery from stateless functions needs
   retries/dead-lettering (QStash/cron), and the event surface is narrower than it
   looks (programs/routines emit nothing) — scope deliberately, or document events
   as best-effort.
5. Plugin SDK, when real: `packages/plugin-sdk` mirroring `packages/types` exactly
   (Zod schemas, committed dist/, CI drift gate) — the safeParse-and-throw pattern
   is what has kept the one existing plugin honest.
6. **Skip indefinitely**: sidebar-panel and canvas-view plugin slots (built twice
   across shells against fragile invariants), and the tier-(c) sandboxed runtime —
   confirmed by the safety research as a 4–8+ week build plus permanent review ops;
   revisit only behind a closed verified-plugins program if demand ever justifies it.

### Project C — the store/registry (BUILD WHEN DEMAND SHOWS)

Trigger: a real community around dsul, or a second app actually shipping. Not
before.

1. One public GitHub registry repo shared across all apps. Index entries:
   `{ id, name, type: theme|plugin, app, repo, version (pinned tag or content
   hash), minAppVersion, permissions, pricing: free|donate|paid-external }`.
2. **Themes only at first, token-JSON only** with CI value-grammar validation.
   Plugins (declarative manifests + agent-API integrations) join once the theme
   pipeline has shaken out the UX.
3. CI on registry PRs: schema validation, release-asset existence + version match,
   static scans. Human merge is the only manual step. **Publicly frame automated
   checks as validation, not vetting** — the appearance of review without its
   substance is a shared-brand blast radius across every app on the store.
4. Pre-compiled index on merge → CDN/cached route; clients never call the GitHub
   API. **Blocklist checked on every load via a short-TTL fetch that deliberately
   bypasses the Serwist service worker and jsDelivr's 12h–7d edge caches** —
   kill-switch latency is the retrofit-after-incident failure mode; wire it into
   the client on day one.
5. **Pin-and-prompt updates (Zed), not auto-pull (Obsidian).**
6. **No published review SLA** (or an embarrassingly large one you can keep) — the
   silent-queue reputation damage is the documented failure mode.
7. Store UI cost is real even though hosting is ~$0: browse/detail/install/toggle
   built per app — and twice in dsul (desktop + mobile shells). Budget it.
8. Legal scaffolding before opening submissions: license grant on submission (right
   to redistribute/patch/fork abandoned items), takedown process, store ToS.
9. Data lifecycle policy: what disable/uninstall/blocklist does to
   extension-created data (custom-type items can be stranded by
   `items_status_check`) — retain-and-hide is the likely default; decide explicitly.

### Project D — payments (BUILD LAST AND SMALLEST)

1. **Stage 0 (with Project C):** everything free; per-item "Support the author"
   links + Obsidian's Free/Optional-payments/Paid labeling. No money moves.
2. **Stage 1:** paid *official* items via MoR — Polar.sh today, Stripe Managed
   Payments when open. Webhook writes a row to a Supabase `entitlements` table;
   API routes/RLS gate delivery. **Design `entitlement_source:
   official_mor | external_author | connect` into the first migration** — MoRs are
   contractually single-seller, so the rails must be swappable without schema
   surgery, and entitlements must be reconstructible from our own rows if a rail
   dies or freezes the account.
3. **Stage 2:** community authors earn via **link-out** (own store, own keys; we
   define a small key-redemption/webhook contract so external purchases unlock
   in-app). Zero marketplace liability. This stage can hold indefinitely.
4. **Stage 3 (defer indefinitely; only if volume demonstrably pays for part-time
   ops):** Stripe Connect Express, 15% platform fee, Stripe Tax; accept
   marketplace-facilitator registration duties as states are crossed. A business
   entity should exist before this stage.
5. Never architect the shared store's payment layer on an MoR expecting to add
   community sellers later; that migration is a phase change, not an increment.

## Open decisions for Kirby (roughly in order of when they bite)

1. **Keystone:** declarative-only plugins, or sandboxed code? (Safety research
   informs; critique says declarative, loudly and publicly.)
2. Theme contract: token-JSON only forever, or CSS files someday? (Communities will
   ask for CSS; that request is where theme safety dies. Recommend holding the line.)
3. Which tokens are public API, and the breaking-change policy while the design
   language is still churning (recent history: bucket band, quiet rail, overlap
   blocks — every redesign breaks community themes, or worse, quietly stops).
4. Which concrete apps share the store; per-app purchases or a shared
   identity/entitlement backend (the latter is a new cross-app service that must
   exist before the store does)?
5. Store surface: in-app browser per app, standalone site, or both? Which discovery
   features are v1, knowing each nonzero one (stats, ratings, screenshots) implies a
   backend and moderation?
6. Monetization timeline: own-paid-items within ~6 months (pick MoR now, design
   entitlements migration now) or aspirational (ship free-only and stop)? Entity
   formation before money moves?
7. Data policy on disable/uninstall/blocklist (especially custom-type items pinned
   by the status CHECK).
8. Update semantics (pin-and-prompt recommended) and index/blocklist re-check
   cadence given SW/CDN caching.
9. Telemetry stance: install counts / error attribution vs the app's privacy
   posture (Obsidian scrapes GitHub stats instead).
10. Is the in-app Beacon tool-calling loop worth building as an app feature? (It
    gates "plugins extend Beacon in-app" but should be decided on its own merits.)

## Risks the critique flagged (the ones most likely to actually bite)

- **Building the marketplace before the audience** — a quarter on store plumbing
  instead of the features that attract the users a store needs.
- **Freezing the design language too early** — publishing the token contract turns
  globals.css into a public API mid-redesign-era.
- **CSS-file themes silently inverting the "themes are safe" premise.**
- **Bricking OpenClaw while hardening auth** (dual-read window + coordinated npm
  release, or don't).
- **Kill-switch latency** via SW/CDN caching (design the bypass in from day one).
- **Payment-rail platform risk** (LS mid-migration, Polar repricing, MoR account
  freezes) — entitlements must be reconstructible from our own Supabase rows.
- **Custom-item-type plugins overpromising** — "task-shaped types with cosmetic
  config" until a migration and versioned webhook contract land; announce
  accordingly.
- **The review SLA as a promise your calendar makes.**
- **Shared-brand blast radius** — one bad store approval taints every app at once.

## Build ledger

**2026-08-12 — Project A v1 (preset palettes) + Project B v1 (official
extensions), built together on `feat/programs-routines`:**

- **Palettes**: three curated presets (slate / dune / iris) as mode-scoped CSS
  blocks in globals.css (`:root[data-theme='slug']:not(.dark)` +
  `:root[data-theme='slug'].dark` — the compound is load-bearing: a bare
  attribute selector at (0,2,0) beats `.dark` at (0,1,0) and leaks light values
  into dark). Presets override paper/ink ramps + ground-hued literals only; the
  lime triad is deliberately not restated. Catalog in lib/theme-palettes.ts,
  active slug in lib/palette-store.ts (no persist — raw localStorage key
  `dsul-palette` written by the single DOM-writer effect in
  supabase-provider). Pre-hydration inline script in layout.tsx (next-themes
  pattern) with `?reset-theme` as the always-readable escape hatch. Server truth
  `user_settings.theme_palette` (migration 025), started in
  PENDING_SCHEMA_COLUMNS and deliberately absent from DEFAULT_SETTINGS so a
  never-set column can't clobber a device choice. Settings row `look.palette`;
  PWA `theme-color` metas re-pointed per palette. `data-theme` was pre-wired:
  relay-field's MutationObserver already watched it.
- **Extensions**: user_extensions table (migration 026, the 021 idiom + 023's
  `default auth.uid()`), fetchItemTypes-style null-latch in
  lib/db.ts:fetchUserExtensions, manifest catalog in lib/extension-registry.ts,
  enabled-state store in lib/extensions-store.ts (no persist; server is truth;
  hydrated from supabase-provider beside hydrateSettings — deliberately NOT in
  initializeStore's Promise.all). New settings pane `extensions` (the
  DESTINATIONS six-pane budget spent once, consciously — its comment was
  amended). Two proof extensions, both default-OFF: **habit-heatmap** (26-week
  completion grid as a gated section in ItemDetailSections, streak-strip visual
  vocabulary) and **completion-confetti** (lazy-imported canvas-confetti behind
  the two completion funnels in planner-store, complete-direction only, double
  reduced-motion veto).
- Tests: tests/unit/theme-palettes.test.ts (catalog↔CSS↔inline-script drift
  contracts), tests/unit/extensions-store.test.ts (latch, optimistic write,
  stale-drop, duplicate-guard). Unit suite green except 5 pre-existing
  organize-sections failures unrelated to this work; lint 0 errors; build green.
- **Adversarially reviewed** (4 find dimensions × verify panel; 17 confirmed
  findings deduping to 9, all fixed): `?reset-theme` now sets a one-shot
  sessionStorage flag that hydrateSettings consumes by persisting
  `theme_palette:'default'` (otherwise the server row re-applied the broken
  palette one round-trip later); flushSettings gained loadSettings'
  missing-column retry so a pre-025 palette write can't take a co-batched
  `theme` write down with it; applyThemeChange now honors `data-reduce-motion`
  (fixes the pre-existing theme toggle too); fetchUserExtensions discriminates
  42P01/PGRST205 from transient errors, and the store leaves transient
  failures retryable instead of latching "needs a database update"; hydrate
  merges server rows UNDER in-flight optimistic toggles; a bare account switch
  clears the previous user's toggles synchronously; one-off task confetti is
  transition-guarded; user_extensions.enabled defaults false; the default
  palette's theme-color pair now actually matches --paper-0 (layout viewport
  updated in the same change — the shipped #eeede9 had drifted).
- **DEPLOYED 2026-08-12**: migrations 025 + 026 applied to the `anchor` prod
  project via the Supabase MCP. The MCP stamps timestamp versions, so the
  ledger rows were corrected to `025`/`026` afterwards (the CLAUDE.md rule —
  otherwise `db push` replays them). Verified post-apply: `theme_palette` text
  column; `user_extensions` with RLS + its policy, slug CHECK, unique
  (user_id, slug), `updated_at` trigger, `enabled` default false. Security
  advisor showed no new findings. `theme_palette` was then promoted from
  PENDING_SCHEMA_COLUMNS to STABLE_SETTINGS_COLUMNS (no preview branches
  exist, so prod is "everywhere"); the morning auto-age pair from 022 remains
  pending, which costs nothing.
- **Still deferred** (Project A tail): command-palette "Set palette" command
  (deliberately kept out of the alias namespace for now), LookPreview not yet
  wired to preview the palette, per-palette dark-mode literals still inherited
  rather than tuned, user-imported theme JSON + the value-grammar validator
  (the gate before any community pipeline), and a palette-aware login/relay
  surface.

## Research provenance

Five-researcher sweep + adversarial critique, 2026-08-11 (prior-art, payments,
codebase-theming, codebase-extension, sandboxing/safety researchers + completeness
critic). Full structured findings with ~95 sources archived in the session
transcript; key sources: obsidianmd/obsidian-releases, zed-industries/extensions,
Figma's "How we built the Figma plugin system" engineering post, Figma Community
seller docs, Chrome Web Store payments deprecation, Polar/Paddle/Lemon Squeezy
pricing docs, Stripe Connect pricing, marketplace-facilitator tax guides,
WordPress plugin-team 2025 report, VS Code theme-color reference and
extension-runtime-security docs, Obsidian plugin-security docs, PortSwigger and
OWASP CSS-injection research, hardenedjs.org/LavaMoat, quickjs-emscripten.
