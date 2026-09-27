# @dsul/openclaw-context

> OpenClaw plugin — brings your [dsul](https://github.com/kjswalls/dsul) tasks, habits, and projects into every AI conversation.

Once installed, your OpenClaw agent automatically knows what's on your plate — from any channel (Discord, WhatsApp, webchat, wherever). No more copy-pasting your to-do list into chat.

## How it works

- **On startup:** fetches your full dsul context and caches it locally
- **On demand:** the agent calls the `dsul_get_context` tool when it needs your
  plate — the model decides when, rather than the plugin guessing from keywords.
  Repeat calls inside one conversation return a short "context unchanged"
  acknowledgement instead of re-spending the tokens.
- **On data change:** dsul pushes a webhook → cache invalidates instantly (zero polling, always fresh)

## Install

```bash
openclaw plugins install @dsul/openclaw-context
```

## Setup

```bash
openclaw dsul-context setup
```

The wizard prints a link and waits. Open it, sign in to dsul, check that the
code on screen matches the one in your terminal, and authorize. The terminal
picks it up and writes the config for you — there is no API key to copy by hand.
The code is single-use and expires after 15 minutes; if you miss it, just run
setup again.

It then asks for your gateway's **public URL** (e.g.
`https://midgar-1b4eaa3.turkey-rockhopper.ts.net`). Leave it blank for pull-only
mode: your agent can still read your tasks, but dsul can't push changes to it
and the dsul sidebar chat stays off. You can add `publicUrl` to `openclaw.json`
later — re-running setup preserves keys you've set by hand.

Then restart the gateway:

```bash
openclaw gateway restart
```

That's it. Your agent now sees your tasks from Discord, webchat, Signal — everywhere.

## What the agent sees

`dsul_get_context` returns a compact summary of your day:

```
## Today's Tasks
- Fix login bug [high] (dsul project) @ 10:00
- Review PR
- Write release notes [medium]

## Habits
- ✅ Morning walk (12 day streak)
- ⬜ Read 30 min (5 day streak)

## Projects
- 🪝 dsul
- 🎮 Side project

## Collections
- Routine: Morning [id: …]
- Season: Summer [id: …] (auto 2026-06-01 → 2026-08-31)

## Set aside
Deliberately paused — NOT overdue and not missed. …
- Read 30 min [id: …] — paused until 2026-09-01
- Swim [id: …] — set aside with the Summer season
```

**Set aside** is there so an absence never has to be guessed at. Paused work is
filtered out of the lists above — an agent shouldn't plan around a habit you put
down for the summer — but an agent asked about one BY NAME with no other
information will answer that it was finished, dropped, or never existed, and the
last two invite a "helpful" recreate that duplicates the row.

Alongside it the plugin registers write tools, so the agent can act on what it
reads rather than just describe it: `dsul_create_task`, `dsul_update_task`,
`dsul_delete_task`, and the matching `dsul_*_habit` trio. Deletes are soft —
dsul keeps them in the trash for 30 days.

`dsul_pause` puts a task, habit, or routine down without deleting it —
streak, history and dates all survive, and resuming brings it back exactly as it
was. `dsul_create_collection` / `dsul_update_collection` /
`dsul_delete_collection` manage routines and seasons. Membership arrays
REPLACE the whole set rather than adding to it, so a retried call can't
double-add.

Seasons aren't switched through `dsul_pause`, deliberately: they carry a
tri-state where `auto` follows the date range and `active`/`paused` override it
until changed back. Writing `active` onto a season that was following its dates
would silently end that, so switching one is an explicit `state` on
`dsul_update_collection` rather than a boolean that hides the difference.

## Configuration

Config lives in `openclaw.json` under `plugins.entries.dsul-context.config.dsul-context`:

| Key | Required | Description |
|-----|----------|-------------|
| `dsulUrl` | ✅ | Base URL of your dsul deployment (written by setup) |
| `apiKey` | ✅ | Your personal dsul API key (written by setup) |
| `publicUrl` | Optional | Your gateway's public URL. Required for webhook push and the dsul sidebar chat; omit for pull-only mode |
| `webhookSecret` | Optional | HMAC secret for verifying change event payloads. **Without it the webhook endpoint accepts unsigned requests** — set it if your gateway is reachable from the internet |
| `agentId` | Optional | OpenClaw agent that backs the dsul sidebar chat (default: `main`) |
| `cacheTtlMs` | Optional | Max cache age before re-fetch (default: `300000` = 5 min) |

## Requirements

- OpenClaw ≥ 2026.0.0
- A dsul account with the OpenClaw API enabled

## License

MIT
