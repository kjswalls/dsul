# Signing in to dsul's MCP server with OAuth

Built 2026-10-10 (Kirby: "an MCP server that Claude or other agents can use"; the AI handoff's
build step 5 and issue #261). Migration 069 must be applied on prod before it works there.

## What it is

`/api/mcp` (app/api/mcp/route.ts) has served dsul's 23 planner tools since #440. Until now the
only way in was the OpenClaw agent key: one per user, plaintext, unscoped, never expiring, and
only obtainable through OpenClaw's pairing flow. Claude (claude.ai, the desktop and phone apps,
Claude Code), Cursor and other MCP clients connect to a remote server through OAuth 2.1 instead,
so dsul is now an OAuth authorization server for its own MCP resource:

1. The client calls `/api/mcp` with no token and gets a 401 whose `WWW-Authenticate` names
   `/.well-known/oauth-protected-resource` (RFC 9728).
2. That names this origin as the authorization server; `/.well-known/oauth-authorization-server`
   (RFC 8414) lists the endpoints. Both are rewrites in next.config.mjs to `app/api/oauth/*`, and
   `/.well-known/` is a signed-out path in proxy.ts so the redirect to /login never catches them.
3. The client registers itself, anonymously, at `POST /api/oauth/register` (RFC 7591; public
   clients only, PKCE instead of a secret; a per-address limit in memory).
4. It sends the user to `/oauth/authorize` (app/oauth/authorize/page.tsx). Signed out, proxy.ts
   sends them through /login and back. The page shows the app's name and asks what it may do:
   **See and change your planner** (`planner`) or **See your planner, without changing it**
   (`planner:read`). The redirect URI is checked against the app's registered list before the
   page shows anything, and the browser only goes to a URL the server built.
5. Allow mints a ten-minute one-time code; `POST /api/oauth/token` trades it, with the PKCE
   verifier, for an access token (1 hour) and a refresh token (90 days, rotated on every use).

Settings → AI → **Connected apps** (components/settings/connected-apps.tsx) shows the address to
give an app, lists every connected app with its access and dates, and Disconnect revokes the
grant and every token under it at once. An app can sign itself out through
`POST /api/oauth/revoke` (RFC 7009), which does the same.

## Rules that are load-bearing

- **Beside the OpenClaw key, never instead of it.** The plugin throws on drift and the key has no
  migration window (ai-vision-decisions.md, decision 1), so nothing about it changed. OAuth tokens
  are prefixed `dsul_at_` / `dsul_rt_` and can never be mistaken for it.
- **Routes opt in.** `resolveUserIdFromApiKey(token, client, access)` takes `'key'` (the
  default: the OpenClaw key only), `'read'` (any OAuth token too) or `'write'` (an OAuth token
  with `planner`). The context and an item's history read; the item, container, goal, project
  and delegation-verb handlers write; registering a gateway or webhook (`/api/agent/register`,
  connect, habit-groups) stays OpenClaw's alone, so a connected app can never make itself the
  thing chat answers through.
- **A read-only app sees only the reading tools** (`READ_TOOL_NAMES` in lib/mcp/tools.ts: the
  context, my work, item activity; a test holds that each plans only a GET). Asking for another
  tool by name is "Unknown tool", and the agent handlers refuse its token on every write besides.
- **Only hashes are stored.** Codes and tokens are sha256'd before they reach the database; a
  code and a refresh token are each spent with a conditional update that succeeds once.
- **069's tables are service-role only**, like user_secrets; Settings reads them through
  `/api/oauth/grants`, which checks the session. Every user column cascades from auth.users.

## Not done yet

- A real-client probe (#261): connect Claude to a preview or prod once 069 is applied.
- Per-agent keys for OpenClaw and retiring the plaintext key: still decision 1, still needs a
  coordinated plugin release.
