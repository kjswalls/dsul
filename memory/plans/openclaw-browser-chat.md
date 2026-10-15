# OpenClaw chat from the browser

Status: built (2026-10-15). Kirby asked for it on 2026-10-15 ("ok let's build this") after the hi-fi mocks. The
risk decision (this browser holds `operator.write`) was put to Kirby on the same day, and Kirby chose "Build browser
chat" over keeping plugin chat; see "What we tell people". The plugin was removed the same day (see "The plugin, retired").

## What it is

Ask can chat with the person's own OpenClaw straight from the browser. There is no plugin, and dsul's server
plays no part. It is OpenClaw's documented third-party browser client (docs.openclaw.ai/gateway/clients, package
`@openclaw/gateway-client/browser`, pinned exactly with `@openclaw/gateway-protocol`).

Setup, in Settings → AI → OpenClaw → Chat in Ask (`components/settings/openclaw-browser-chat.tsx`), is three steps:
1. `openclaw config set gateway.controlUi.allowedOrigins '["<origin>"]' --strict-json`. Without it the gateway
   refuses the socket with CONTROL_UI_ORIGIN_NOT_ALLOWED, even when the token is right.
2. The person enters the address and the gateway's shared token. The page connects with that token, a fresh
   Ed25519 device key and client `webchat`/`webchat`, and the gateway answers PAIRING_REQUIRED with a request id.
3. `openclaw devices approve <id>`. The link polls every 2.5s, the next connect is let in, and the gateway issues
   a device token.

Approving makes OpenClaw the answerer on this browser (`chooseChatTarget('openclaw')`).

## Where things live

- `lib/openclaw-browser/device-store.ts`: IndexedDB `dsul-openclaw/devices`, one record per dsul user id. Each
  record holds the address, a CryptoKeyPair (private key non-extractable) and the issued device token. It never
  holds the shared token.
- `lib/openclaw-browser/link.ts`: `GatewayLink` wraps `GatewayProtocolClient` and
  `GatewayBrowserDeviceAuthLifecycle`. It holds the shared token in memory only until the first hello, then
  drops it. `chat()` sends `chat.send` and reads `chat` events (`delta.deltaText`, then `final.message`,
  `error` or `aborted`), and a stop sends `chat.abort`.
- `lib/openclaw-browser-store.ts`: zustand, device-local. `paired` feeds the gate (`browserChat` on
  `AIInputs`, transport `'browser'`, ahead of the server gateway and the plugin). `browserLink()` is the one
  live connection. It hydrates at sign-in beside the AI connection store and resets in `clearChatState`. Sign-out and an account switch delete the whole database (`clearBrowserPairings` in `lib/local-state.ts`'s RAW_CLEARERS). A device token is a credential for the person's agent, so it does not outlive their session on a shared machine.
- `lib/chat-transport.ts` `viaBrowser`:
  - The session key is the server path's `dsul:u:<uid>:chat:<conversationId>`.
  - chat.send has no system prompt, so the planner rides in the message inside `<dsul_planner>`. The first send
    of a conversation on a page carries everything (plus the person's instructions). After that, only a changed
    day is sent.
  - Errors are codes: `gateway_offline` and `gateway_error` (both retryable), and `gateway_unpaired`.
- `lib/openclaw-browser-copy.ts`: every sentence about what an approved browser can do. The setup dialog,
  Settings and /docs/openclaw all read it.

## What we tell people (measured, OpenClaw 2026.10.3, local gateway)

- `operator.sessions.write` (chat-only) fails with "requires a verified user profile", which exists on team
  gateways only. So `operator.read` + `operator.write` is the narrowest grant that can chat.
- With it, a browser can call `config.get` (secrets redacted), `logs.tail`, `sessions.list/send`, `node.list`
  and `tools.invoke`.
- It is refused `config.patch`, `device.pair.*` and `exec.approvals.*`. Never request `operator.admin`,
  `operator.pairing` or `operator.approvals`.
- So code injected into dsul (XSS, a bad deploy) can do what the person can do from OpenClaw's own chat, but
  only while dsul is open in an approved browser. dsul's servers hold nothing for this.
- The plugin's chat token was narrower (chat only), but chat drives the agent's tools anyway.
- Rotating the shared token closes every browser connection (4001, then AUTH_DEVICE_TOKEN_MISMATCH). The link
  reads that as unpaired, and Settings offers setup again.
- `openclaw devices remove <id>` closes the socket at once and is read the same way.
- From an https page a plain `ws://` socket only reaches loopback (mixed content), so setup asks for `wss://`.

## The plugin, retired (2026-10-15)

Removed with it: `openclaw-plugin/`, the `'plugin'` transport and `openclaw.pluginChat` on the gate, the
`dsulchat_` token (`lib/plugin-chat-token.ts`, `GET /api/agent/chat-url`), and the device-code sign-in (the
`/connect` page, `/api/agent/connect/{init,authorize,poll}`, `GET /api/openclaw/status`). OpenClaw now answers in Ask
from this browser's pairing or through dsul's server gateway (Advanced), and pairs for hand-offs through Connect.

Kept on purpose:
- `connect_sessions` (017) and `user_settings.openclaw_chat_url` stay as ballast; dropping them is a prod write.
  Unpair still sweeps both, so an account paired the old way unpairs cleanly.
- An older plugin pairing's key in `user_secrets.openclaw_api_key` still counts as paired and still works on the
  agent API, MCP and `/api/agent/events`, until the person unpairs.
- `POST /api/agent/register` (webhooks) still accepts `chatUrl`, so an older install keeps registering; nothing
  reads it.
- The `plugin_*` error codes and their copy stay in `lib/chat-errors.ts`, since saved turns may carry them.

## Not done here

- Tool events (`caps: ['tool-events']`) for action lines in Ask.
- Proposals over the browser link (they still need the server gateway).
