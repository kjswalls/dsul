# Handoff: YouTube plan in dsul (and the MCP gaps)

Thread: "YouTube plan in dsul" (started 2026-10-08). Updated 2026-10-09.

## Goal
Turn Kirby's "YouTube Weekly Devlog Plan" doc (https://claude.ai/code/artifact/12f1b5c7-c4b6-4877-a556-6840c4dcf6d6) into a dsul setup, created over dsul's MCP.

## Done
- Mapping written: memory/handoffs/youtube-in-dsul/setup.md. Kirby agreed: project "KW YouTube Channel"; 5 weekly habits (Capture Mon-Thu 5m, Record Fri 90m, Edit Sat 120m, Publish Sun 15m, Buffer check Sun 5m) with durations and the template/buffer rules in notes; "Episode week" routine; "Devlog Season 1" season, paused until launch; "Launch the devlog" task with 7 ordered subtasks. The goal is optional and was left out (the season does the work; the goal only adds a progress view).
- PR #440 merged 2026-10-08: MCP gained dsul_create_project / dsul_update_project, habit duration + reminderTime, task repeatFrequency/repeatDays/reminderTime (repeating task needs a startDate), case-folded project duplicate 409. MCP now has 17 tools (lib/mcp/tools.ts).
- Script: memory/handoffs/youtube-in-dsul/setup-youtube.mjs. Run `node setup-youtube.mjs` on Kirby's Mac. With no DSUL_AGENT_KEY it runs OpenClaw's device pairing (/api/agent/connect/init + poll), which reuses the existing agent key, then builds everything via /api/mcp tools/call. Idempotent (matches by title/name). Never prints the key.

## Waiting on Kirby
- Run the script (cloud sessions can't reach do.dsul.app, and the key must stay on his machine). Not yet confirmed run. After it runs, check the planner shows the project, routine and paused season.
- On launch Sunday: set the season's startsOn/endsOn (about 12 weeks) and state auto.
- Optional in the app: a recipe (Publish skipped -> create "minimum viable episode" task), a Beeminder stake on Publish.

## Open question (raised 2026-10-09, unanswered)
Other people can't use dsul's MCP: it accepts only the agent key, which only OpenClaw's pairing hands out (no screen shows it), and Claude.ai/ChatGPT connectors need OAuth (#261). AI plan step 5 covers OAuth sign-in, per-agent keys, read-only key, connection test. Recommended doing the sign-in part as its own small step before launch; asked Kirby whether to start now or wait for the AI work to resume.

## Next steps
1. If Kirby says start: build MCP OAuth sign-in (see memory ai-build-steps-2026-10, issue #261), its own PR.
2. Gap not fixed: no place to store "episodes banked" (lives in Buffer check notes for now).
