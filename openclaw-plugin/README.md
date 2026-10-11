# @dsul/openclaw-context

> OpenClaw plugin for [dsul](https://github.com/kjswalls/dsul) — chat with your agent from dsul's Ask, and wake it the moment you hand it an item.

Since 0.3.0 the plugin does only the two things that need code inside your
gateway. Your agent's dsul **tools** (reading your plan, adding and changing
tasks, habits, projects, routines, seasons and goals, and working on items you
hand it) come from **dsul's MCP server**, which you add to OpenClaw once (below).

## What it does

- **Chat from Ask.** dsul's Ask can talk to your agent through
  `/plugins/dsul/chat`, one OpenClaw session per saved conversation.
- **The hand-off wake.** When you hand an item to OpenClaw in dsul (right-click
  → AI → Hand off to OpenClaw, or Assign to OpenClaw in the item panel), dsul
  signs an `items.handedOff` event and POSTs it to `/plugins/dsul/webhook`. The
  plugin starts a run in the session `dsul:handoff:<itemId>` that tells the agent
  to pick the item up with `dsul_my_work`, report with `dsul_report_progress`,
  and ask with `dsul_ask_user` if it is blocked. It does not wait for the run.

  The wake **only** starts a run for a request signed with your `webhookSecret`.
  Without a secret it is off, and an unsigned request never spends your model
  budget. Missing a wake costs nothing but time: the agent still finds the item
  the next time it checks `dsul_my_work`.

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
setup again. It also creates a `webhookSecret` if you don't have one, so the
wake works out of the box.

It then asks for your gateway's **public URL** (e.g.
`https://midgar-1b4eaa3.turkey-rockhopper.ts.net`). Leave it blank for pull-only
mode: your agent still works through MCP, but there is no wake and no chat from
Ask. You can add `publicUrl` to `openclaw.json` later — re-running setup
preserves keys you've set by hand.

### Add dsul's MCP server

Make a key in dsul under **Settings → AI → Agent keys** ("Read and change"),
then:

```bash
openclaw mcp add dsul \
  --url https://do.dsul.app/api/mcp \
  --transport streamable-http
# then add the header through the scoped config editor or config:
#   mcp.servers.dsul.headers.Authorization = "Bearer <that key>"
#   (keep the key out of config literals — use the secret mechanism)
openclaw mcp doctor dsul --probe
```

`doctor --probe` is the real check: a working server lists the `dsul_*` tools.

Then restart the gateway:

```bash
openclaw gateway restart
```

## Upgrading from 0.2

0.2 registered its own `dsul_*` tools and kept a cache of your plan. Those are
gone: add dsul's MCP server (above) and your agent has the same tools and more
(projects, subtasks, notes, one-day ticks and skips, moving a task, the
delegation tools). `cacheTtlMs` is no longer read; an old config that has it
still loads. Re-run setup, or set `webhookSecret` yourself, to turn the wake on.

## Configuration

Config lives in `openclaw.json` under `plugins.entries.dsul-context.config.dsul-context`:

| Key | Required | Description |
|-----|----------|-------------|
| `dsulUrl` | ✅ | Base URL of your dsul deployment (written by setup) |
| `apiKey` | ✅ | Your personal dsul API key (written by setup) |
| `publicUrl` | Optional | Your gateway's public URL. Required for the wake and chat from Ask in dsul; omit for pull-only mode |
| `webhookSecret` | For the wake | HMAC secret dsul signs events with (setup writes one). **Without it the wake is off**: the plugin does not register for it, and refuses an unsigned hand-off |
| `agentId` | Optional | OpenClaw agent that answers in dsul's Ask (default: `main`) |

The chat route (`/plugins/dsul/chat`) does not accept `apiKey` itself. dsul's browser sends a chat token derived from it (an HMAC, `dsulchat_…`), so the key that reaches dsul's agent API is never in a web page. Plugin versions before this change accepted only the raw key, and dsul no longer sends it: update the plugin to keep chat from Ask working.

## Requirements

- OpenClaw ≥ 2026.0.0
- A dsul account with the OpenClaw API enabled

## License

MIT
