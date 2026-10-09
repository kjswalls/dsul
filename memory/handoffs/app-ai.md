# Handoff: the app's AI ("App AI vision" thread)

Written 2026-10-09 by the thread's Claude while dsul work is paused. Nothing is in flight: every
PR from this thread is merged, no branch holds unmerged work, and the worktree matched `main`
at 89aa5466 (#443).

## Goal

dsul's AI is optional help that knows your planner, run on the person's own model ("bring your
own model") or their own OpenClaw agent. dsul ships no model key of its own and fails closed:
every AI surface hides until the server says something can answer. The AI has no name in the UI
("AI"; never "Beacon"). Chat lives in the right rail ("Ask"), mirrors Claude's chat, and every
planner change it makes has Undo. Rituals with an AI step are opt-in.

Read first, in this order:
1. `CLAUDE.md` in the repo, the "AI is bring-your-own, and it fails closed" section (four
   load-bearing rules: the key is write-only, server code stays server-side, one gate asked and
   never re-derived, the AI has no name).
2. `memory/plans/ai-vision.md` in the repo: the whole design, with dated notes at the top for
   each shipped step (PR 7's pane, PR 7b's Unpair).
3. `memory/handoffs/ai-setup/spec.md`: the AI setup round's copy, state
   rules (§3), build plan (§4) and risks.

## Shipped

**Step 1, Connect a model** (#355, 2026-10-02). OpenAI, Anthropic, Gemini, OpenRouter (PKCE
sign-in or key) or any OpenAI-compatible https URL. The key is sealed with AES-256-GCM under
`MODEL_KEYS_ENCRYPTION_KEY` into `model_connections` (migration 053, service role only) and never
comes back out. Production and Preview must share that env key.

**Step 2a, Ask in the right rail** (#371 storage, migration 057; #382 the rail, Ask home,
History, Ctrl+J, the phone's Ask tab). Ask starts closed with the key top right.

**Ask key look** (#390, #399, #408): the raised key with the Aurora mark, rolled to every AI spot.

**Agent side**: #413 moved the OpenClaw agent key into `user_secrets` (migration 059, NOT on
prod yet; code falls back to `user_settings` until it is). MCP server at `/api/mcp`: #440 and
#442 (other threads) added project, habit, reminder and one-day verbs.

**AI setup and first login** (design page https://claude.ai/artifact/SPhyCC4z8rrtH1313Go2LC,
Kirby picked "Ask is always there" on 2026-10-07):
- PR 1 #415: the streak toast waits for the tour; search finds the AI form.
- PR 2 #418: `user_settings.ai_hidden` ("No AI, thanks", account-wide, migration 060, on prod);
  the gate learns `askInvite` and `askFix`.
- PR 3 #423: the unlit "Set up AI" key, the setup column, No AI with an undo strip.
- PR 4 #429: the connect card (free Gemini key first), a one-token test question on every
  connect (`lib/ai-server/check.ts`), typed errors, `/settings/ai`.
- PR 5 #433: `?` and Ctrl+K open setup; the kept question (`lib/ask-pending.ts`); the phone's
  setup page.
- PR 6 #437: tour step 4 ends on the AI invitation.
- PR 7 #441: the Settings → AI pane (F18 to F22): What AI does, Use AI in dsul (new record
  `beacon.useAi`), Connection with one pill, the AI-off card, OpenClaw, On this device.
- PR 7b #443 (merged 2026-10-09): **Unpair** for OpenClaw. `DELETE /api/ai/openclaw` runs
  `unpairOpenClaw` (`lib/ai-server/connections.ts`): webhooks, chat URL and agent id, device
  sessions holding the key, then the agent key last, then webhooks again. The gateway URL and
  token stay. Unpair shows on the OpenClaw section and on the AI-off card.

## In progress

Nothing. No open PR, no unmerged branch. This thread's branch is `claude/ai-vision-r42oqg`; it
was deleted on GitHub after #443 merged. Restart it from `main` for the next PR.

## Waiting on Kirby

- **Migration 059 on prod** (moves the agent key into `user_secrets`). Until it runs, the agent
  key stays in `user_settings`, which the user's own browser can read. Prod writes need Kirby's
  typed go; past `apply_migration` calls were refused, so the usual route is Kirby pasting the
  SQL from `supabase/migrations/059_agent_key_to_secrets.sql`.
- **The old OpenAI key**: unused since #355, but live until Kirby revokes it at OpenAI and
  deletes `OPENAI_API_KEY` from Vercel.
- **Defaults to confirm** (none blocks anything):
  - PR 7 (#441 body): no "Free key" wording, "today's limit is used up", Disconnect as red text
    everywhere, the F20 header mark unlit, the house switch stays lime, the "Paired" naming
    rule, On this device hidden in F18 and F22 except while chat is Off here, "This browser
    only" in the desktop app, a grey modified bar on AI rows.
  - PR 7b (#443 body): Unpair leaves the Gateway URL alone; Unpair also shows on the OpenClaw
    section, not only the AI-off card.
- **Whether to start phase 2** now or after the weekly usage limit resets (Kirby dropped
  always-ultracode on 2026-10-08 to save usage: own lint/tsc/unit checks plus one self-review,
  Claude Code Review as the second check).

## Next steps

1. ~~Phase 2, "Break it down"~~: built 2026-10-09 (see ai-vision.md's note of that date),
   with the Fix card's model fix.
2. Small follow-ups left by the setup round:
   - "Use a different service" in the pane still holds the old `ConnectForm`; swap in the
     connect card's "I already use…" body.
   - Stream-only refusals pass the connect test; the connect rate limit is in memory, not
     durable.
   - CLAUDE.md says `chooseChatTarget()` is "the one path allowed to wipe transcripts"; it
     deletes nothing. Raise with Kirby rather than editing CLAUDE.md.
3. The older build order from the vision (each its own PR): step 2b (edit, retry, Undo,
   "Something else" in chat), 2c (@, /, images, open wide), 3 item timeline pane
   (https://claude.ai/artifact/3siWGNjqgVmPcjmmr7mucz), 4 attachments, 5 the OpenClaw loop with
   per-agent keys, a read-only key, OAuth for `/api/mcp` and a real-client probe (#261),
   6 ClawBoy's `[clawboy-options]` card format.

## Key files

- Gate and state: `lib/ai-registry.ts` (capabilities), `lib/ai-connection-store.ts` (one status
  read, never persisted; writes `connect`, `setModel`, `recheck`, `disconnect`, `unpair`,
  `setAIHidden`), `lib/ai-types.ts`, `lib/chat-target.ts`, `lib/no-ai.ts`.
- Server: `lib/ai-server/**` (imported only from `app/api/**`; `connections.ts`, `check.ts`,
  `secret-box.ts`, `providers/`), routes under `app/api/ai/**` and `app/api/chat`. Session
  checks in `app/api/ai/_shared/guard.ts` (lib may not call `.auth.getUser(`).
- Agent key: `lib/supabase-service.ts` (`readAgentKey`, `storeAgentKey`, `clearAgentKey`,
  `resolveUserIdFromApiKey`; the only place it is read or written), webhooks in
  `lib/openclaw-registry.ts`.
- Pane: `components/settings/ai-pane.tsx`, `lib/ai-pane-state.ts` (pure layout tables),
  `components/settings/model-connection-panel.tsx`, `components/settings/disconnect.ts`
  (`useDisconnect`, `useUnpair`).
- Connect and setup: `components/ai/connect/*`, `components/ai/rail/*`.
- Tests that guard the rules: `tests/unit/ai-routes-security.test.ts` (every AI route, register
  new ones by hand), `ai-server-boundary.test.ts`, `no-beacon-copy.test.ts`,
  `agent-key.test.ts`, `ai-pane.test.tsx`, `openclaw-unpair.test.ts`.
- E2E: `tests/e2e/helpers/ai.ts` `stubAIGate` answers every AI write. Never let a real write
  reach the shared e2e account (a real Unpair would delete the agent key global setup seeds).

## Working notes

- Checks: `pnpm lint`, `pnpm exec tsc --noEmit -p .` (about 60 errors already on main, none in AI
  files; compare by file), `pnpm test`. E2E runs only against a local Supabase
  (`./scripts/local-setup.sh e2e`; in a cloud container start `dockerd` by hand and apply any
  newer migrations with `supabase migration up --local`), then
  `CI=1 npx playwright test <spec> --project=chromium --no-deps --retries=0`, and
  `git checkout -- public/sw.js` afterwards.
- PRs open under Kirby's account, assigned to him, never with a review request. Merge with
  squash auto-merge once CI and Claude Code Review are clean; only "Unit tests (Vitest)" gates.
- Copy: "AI", no em dashes, lime never dims and nothing is lime while nothing answers (the
  house switch aside). Kirby uses Ctrl, not ⌘.

## Artifacts

- AI setup study (the picked direction): https://claude.ai/artifact/SPhyCC4z8rrtH1313Go2LC
- Chat in the right rail: https://claude.ai/artifact/MmqJ6RXnTMVWhyFqAyCeh4
- Plain-words plan: https://claude.ai/artifact/BKqVHhVkDMfxTgam6BuyJT
- Item conversations (timeline pane): https://claude.ai/artifact/3siWGNjqgVmPcjmmr7mucz
- Ask open and closed screenshots: https://claude.ai/artifact/DGZXKQXbpiGLiBZqwapm8J
- PR 7 design, maps and build reports: `/mnt/project-files/ai-vision/ai-setup/pr7/`
  (`design.md` is the source).
