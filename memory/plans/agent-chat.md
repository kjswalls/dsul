# Talk to any agent from any chat box

Kirby, 2026-11-14: "ideally you'd be able to talk to whatever agent (Claude over MCP,
OpenClaw, dsul's own model) over any interface", with one easy switcher. Mockups:
https://claude.ai/artifact/N1MoAZvs6FZNVbX6Nyw7iA (boards 2a to 2c, then the To popover
rounds: B frosted, a face-and-name chip on the right of the box, mic on the left).

## Step 1 (shipped, #695)

An item's box talks to the agent holding the item in every state, and a reply after done
puts the item back in its queue (lib/agent-question.ts `messageAgent`). The chip on the
right (components/ai/answerer-chip.tsx) flips it to the user's own model, which then sees
the agent exchange as context. Everything lives on the item's trail (`item_events`).

## Step 2: one To picker on every chat box

A message from Ask home has no item, so it needs a home of its own. Built in two PRs.

### PR A: storage and the agent's side (migration 089)

- `agent_messages`: one row per message the user sends an agent from Ask. The browser
  saves the message in the conversation as always, then POSTs `/api/ai/agent-messages`
  with ids only; the route COPIES the text from the saved `chat_messages` row through the
  session client, so the inbox holds exactly what the conversation does.
- The agent reads `GET /api/agent/messages` (MCP `dsul_my_messages`): its own waiting
  messages, each with `earlier`, its own earlier exchanges in the same conversation. It
  answers with `POST /api/agent/messages/:id/reply` (MCP `dsul_reply`), a compare-and-set
  from waiting, so two runs never both answer.
- A send wakes the app's routine when it has a wake (lib/agent-wake.ts), sharing the
  hand-off's one-a-minute cooldown (`claimWake`).
- The browser saves the answer into the conversation itself (chat_append, reply id = the
  inbox row's id so a second device lands once, answerer `agent:<name>`), then stamps
  `delivered_at` (`POST /api/ai/agent-messages/delivered`). `GET ?pending=1` finds
  answers that came while no browser was open.
- 089 widens both answerer CHECKs to take `agent:<name>`.
- OpenClaw has no inbox: it answers Ask live, as it always has.

### PR B: the To picker (built)

- `AskToChip` (components/ai/ask-to-chip.tsx) on the right of every non-item box (Ask
  home, the rail, the phone's Ask, the dock's and Ctrl+K's `?`), drawn only once the
  account has a connected app (`/api/ai/agents`): your model (or OpenClaw), then each app
  with its speed ("~1 min" with a wake, "when opened" without). While it shows, it takes
  the model chip's place; the model is changed in Settings → AI.
- The pick lives in `lib/ask-to-store.ts`, memory only: `home` for a box with no
  conversation (carried onto the one the first message starts) and `byThread` per
  conversation. `askToFor` falls back to whoever the conversation last talked to. It never
  resets Ask the way `chooseChatTarget` does, so a conversation can mix answerers, each
  reply labelled with who wrote it (a divider before an agent's first reply).
- `sendFrom` routes a message to an app through `lib/agent-chat.ts`: saved first
  (conversations-store `sendToAgent`, saving must be on), then handed on by ids. "Sent to
  Claude" sits under it while it waits, "Not sent to Claude" if the inbox refused it.
- `hooks/use-agent-replies.ts` (app shell) looks for answers on start and on every return
  to the page, every 20s while a message waits and the page is visible, and reads a
  conversation's own rows when it is opened. `landAgentReply` saves each answer.
- Pictures are not sent to an app.

## The boundary (load-bearing)

- No agent route, MCP tool or service-role path reads `chat_conversations` or
  `chat_messages`. An agent reads only `agent_messages` rows addressed to its own queue
  name (`inQueueOf`, as dsul_my_work).
- What the user says to their own model, or to another agent, never reaches an agent.
- Deleting a conversation deletes its inbox rows (composite FK cascade). What the agent
  kept on its side is outside dsul, as OpenClaw's session memory is. The delete confirm
  says so ("Claude may keep its own copy."), as it does for OpenClaw.
