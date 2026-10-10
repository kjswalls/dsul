# Handoff: mobile web to match the iPhone app

Thread: "Mobile web to match iOS" (started 2026-10-02). Status as of 2026-10-09: **design only, waiting on Kirby.** Nothing is built, no branch, no PR.

## Goal

Decide how the phone web app (the `md:hidden` MobileShell) should look now that the native iPhone app exists. An Android app will follow iOS separately, so mobile web is designed on its own merits ("just the best design for mobile web").

## Kirby's direction so far

1. Round 1 (2026-10-02): proposed adopting the iPhone app's structure wholesale (Today · Ask · Organize tabs plus Search, capture bar that opens a braindump sheet, layout capsule by the avatar, title opens Go to date). Kirby: it "looks like a generic iOS app".
2. Round 2: keep the web's schedule-block flavour, and show a higher-density option. Round 2 kept the real web views and drew a new dock in the web dock's style (surface-3 well, radius-10 keys) plus a Compact density. Kirby: the dock "seems weird", use the iOS dock.
3. Round 3 (2026-10-07), **the current lead**: Kirby's middle ground. The iOS app's chrome around the web's own views:
   - Inline top row: 17px "Today", a subtitle "EEE, MMM d · Layout", a 34px layout capsule (tap steps layouts, hold opens the menu, as on iOS), a 30px avatar. Week strip optional.
   - Dock from iOS: a 50px capture pill (lime "+" disc, "Get it out of your head", unscheduled count), a floating Today / Ask / Organize pill with lime selected tab, and a Search circle. It minimizes on scroll to a lime Today circle, an inline "Capture" pill and Search.
   - Braindump opens as a sheet (no scrim, rounded top) holding the real `<Braindump variant="mobile" />`.
   - The web's real DayBuckets / DayList / DaySchedule views and schedule blocks underneath.
   - Compact density changes rows only (30px rows, flat buckets that keep the lime edge on the current one). Web-only for now; the iOS app has no density setting.

Kirby has not reacted to round 3 yet.

## Open questions for Kirby (A to D, from round 1, still open)

- **A.** Move mobile web to the iOS structure (braindump becomes capture bar plus sheet, chat becomes Ask, Organize gets a tab)? Recommend yes.
- **B.** Keep the week strip as a web option, or drop it to match iOS (title opens Go to date, a Today button shows on other days)? Recommend drop. Round 3 shows both.
- **C.** Ask with no model connected: show a setup screen (Connect a model or Pair OpenClaw) or hide the tab? Recommend setup screen; a device that turned chat off hides the tab; a failing key gets its repair screen.
- **D.** In a browser tab, fold the bottom chrome on scroll (like the app) or always one row? Recommend fold on scroll. Round 3's minimized dock is the folded state.

Plus implicit: is Compact density wanted at all?

## Links

- Design page (all three rounds, decisions, "must differ" table): https://claude.ai/artifact/2TuSFHHvXe5TJ2Ry4Yhir3 (v4). Source: memory/handoffs/mobile-web/mobile-web.html; republish with the page's pngs alongside (it references r3/a.png etc.).
- Memory: `mobile-web-2026-10` in team memory; iOS background `ios-app-2026-09`; iOS handoff memory/handoffs/ios-app.md.

## Key files

- memory/handoffs/mobile-web/round-3/: `prototype/components/shell/mobile-shell.tsx` (the round-3 MobileShell override; URL params `density=compact`, `sheet=1`, `strip=1`, `min=1`) and `prototype/compact.css`. The a.png, b.png, c.png boards and single shots stay in the project folder, `/mnt/project-files/mobile-web/round-3/`.
- memory/handoffs/mobile-web/round-2/: superseded round, same layout (PNGs in the project folder only).
- memory/handoffs/mobile-web/ (top level): round 1 sources (proposal.md, mobile-web.html, gen.py, mw.css, shoot.mjs). The shots/ and today/ screenshots stay in the project folder, `/mnt/project-files/mobile-web/`.
- memory/handoffs/mobile-web/harness/: the Vite harness that renders the REAL shells with sample data and file overrides. Run from a copy next to the repo: symlink `/home/claude/dsul/node_modules` into it, then `OVR=<prototype dir> EXTRA=<prototype>/compact.css OUT=p3 node build-variant.mjs`, then `DIR=<out dir> node p3-shots.mjs` (390×844 @2x, Chromium at /opt/pw-browsers/chromium). The import paths in build-variant.mjs pin the repo's pnpm vite path; adjust if the lockfile moved.
- Repo code the build would touch: components/shell/mobile-shell.tsx, components/mobile/mobile-header.tsx, mobile-bottom-dock.tsx, mobile-view-router.tsx, components/sidebar/braindump.tsx. iOS reference (read-only for this work): ios/Dsul.

## Next steps

1. Get Kirby's reaction to round 3 and answers to A to D (and Compact yes/no). Iterate directly in the thread, one self-review, no Workflows.
2. Once picked, build as a single PR against main (no migrations). Things the round-1 review found that a build must handle:
   - Things the dock holds today (notices, undo strip, catch-up ProposalCard "Do all of it / Not now / Something else") need new homes.
   - Braindump-tab call sites (goto command, onboarding tour, e2e helpers) need rewiring.
   - Organize when its extension is off stays inert, not hidden.
   - Touch long-press is drag (TOUCH_ACTIVATION_DELAY_MS 250), so the capsule's hold menu must not collide with it.
   - `compactMode` is persisted but read by nothing; a density setting could reuse it or be new.
   - Installed iPhone PWA email sign-in needs a 6-digit code (PKCE); the service worker is push-only.
3. Don't change ios/ or the iOS boards; that belongs to the iOS thread. The coordinator tells the iOS thread once mobile web settles the schedule look, since Kirby may want the iPhone's Schedule to keep the web's block flavour.
