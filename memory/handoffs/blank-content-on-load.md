# Handoff: blank content on load and the instant planner (from the "Instant planner" thread, 2026-10-09)

## The problem
Kirby: on login or reload the app chrome shows with no content for seconds. #341 added a skeleton and a single `load_planner()` RPC (1.3 to 1.7 s after idle; the rest is the free-tier database waking).

## What shipped
- **#435, merged 2026-10-08** (squash `f21a40c`). A reload paints this browser's IndexedDB copy of the last session as a look-only preview, then settles onto the fresh data:
  - while waiting, titles dim and one band of light sweeps them (Kirby picked "Shimmer + glide" on 2026-10-07);
  - when the data lands, moved rows glide, new rows type in, and titles rise back to full ink.
- Nothing can write while the preview is up:
  - store actions are deny-by-default;
  - data dialogs are deferred;
  - captures are held and filed once after the landing.
- The full design, its departures and its known limits are in the repo at `memory/plans/instant-planner.md`. Read its "Main's features during the preview" section before adding a store action, a dialog, a door into the right rail or an outward call.
- Kill switch: `NEXT_PUBLIC_PLANNER_PREVIEW=on|static|off` (unset means on). Retire it only via `off`, never by a revert.
- Proposed CLAUDE.md text, which a thread can't apply itself, is waiting for Kirby: `memory/handoffs/instant-planner/claude-md-additions.md`.

## Open now (2026-10-09)
Kirby: "I still see skeletons, is that intended?", seen on a browser reload. It is not intended. Findings come from a code audit plus a production build measured in headless Chromium against the local Supabase. The repro data is in the session scratchpad, not shared.

1. **The bars fade in while the preview itself renders (main cause).**
   - The skeleton's fade-in starts 250 ms after it mounts and runs on the compositor.
   - Putting the cached planner on screen is one blocking render of about 100 ms plus about 5 ms per row.
   - So with more than about 20 rows the bars show before the preview paints.
   - Desktop at 1x CPU: 80 rows show bars every time (about 0.2 s); 236 rows show them for 1.3 to 2.3 s.
   - Phone speed (4x CPU): bars show even at 12 rows.
2. **The preview delays the fresh data.** supabase-js takes its auth lock before sending each request, and the preview's render gets in first. Fresh data for 300 items lands at 3.7 to 4.5 s, against about 2.9 s with no cache. The comment at `lib/planner-store.ts` (around line 3048) and plan step 4 say the fetch starts first; that holds for the call, not for the network send.
3. **The server's pre-JS shell** (`components/shell/app-shell.tsx`, the `mounted` gate) draws blank panels until hydration:
   - about 0.1 to 0.2 s on a desktop, 0.6 to 1 s at phone speed;
   - its sidebar is `w-80` (320 px) where the real braindump defaults to 406 px, so the canvas edge jumps.
4. **Smaller gaps:**
   - reloading within about 2 s of a first landing saves no snapshot;
   - a failed snapshot write is never retried (`lib/planner-snapshot-writer.ts`);
   - a page left open over 7 days writes snapshots that read as expired.
5. **By design, keep:**
   - no preview on a first visit, after sign-in or an account switch, or in a private window;
   - the preview waits for a confirmed session, so a revoked account's planner never shows;
   - deep-link pages show "Loading…".

## Next steps (the planned fix, on branch `claude/faster-first-load-wpmqt9` restarted from main)
- **A1:** while a preview is expected (an owner stamp on disk), hold the skeleton bars back up to about 1.5 s. Release them as soon as the read comes back empty, the preview is refused or the load settles.
- **B1:** let the data requests leave before the preview renders, for example by gating the preview's `set()` on an auth `getSession()` queued after the fetches.
- **C1:** size the pre-JS shell's sidebar from `--sidebar-w`.
- **D1:** retry a failed snapshot write.
- **Then A3, the root fix:** profile and cut the preview render's per-row cost, which also speeds up every first render. Don't virtualize the braindump: the glide needs its rows mounted.
- **Optional A2:** open the IndexedDB read in an inline pre-hydration script (saves about 120 to 180 ms).
- **Can't be checked from cloud sessions:** whether `NEXT_PUBLIC_PLANNER_PREVIEW` is set on Vercel Production. The agent proxy blocks do.dsul.app; Kirby can check it in the Vercel dashboard.

## Key files
- `lib/planner-snapshot.ts`: read, write, TTL, crash marker, kill switch.
- `lib/planner-snapshot-writer.ts`: when snapshots are written.
- `lib/planner-store.ts`: `offerPreview`, `initializeStore`, and the write barrier via `lib/preview-write-guard.ts`.
- `components/providers/supabase-provider.tsx`: `loadPlanner`, `warmPlannerSnapshot`, `getSession`.
- `components/primitives/planner-skeleton.tsx` and the `.planner-skeleton` rules in `app/globals.css` (the 250 ms grace).
- `components/shell/app-shell.tsx`: the pre-mount shell. `components/shell/settle-host.tsx` and `lib/settle.ts`: the glide.
- `lib/planner-shimmer.ts`: the waiting shimmer.
- `lib/held-captures.ts`: captures over the preview.

## Working notes
- Local runs use the loopback Supabase only. `scripts/local-setup.sh e2e` writes `.env.test`.
- After a cloud container restart, start `dockerd` by hand; the supabase containers come back with their data.
- Local migrations are applied through 063.
- A production build rewrites `public/sw.js`, and `next dev` rewrites `next-env.d.ts`. Put both back before committing.
- Films of the settle and the shimmer options: `/mnt/project-files/instant-planner/`.
