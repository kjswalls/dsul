# OpenClaw chat from the browser

Status: built (2026-10-15). Kirby asked for it on 2026-10-15 ("ok let's build this") after the hi-fi mocks. The
risk decision (this browser holds `operator.write`) was put to Kirby on the same day; see "What we tell people".

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
  live connection. It hydrates at sign-in beside the AI connection store and resets in `clearChatState`.
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

## Not done here

- Retiring the plugin, its chat transport, the `dsulchat_` token and the device-code sign-in. Kirby's decision
  card offers to keep it as a stricter option.
- Tool events (`caps: ['tool-events']`) for action lines in Ask.
- Proposals over the browser link (they still need the server gateway).
