# dsul AI Vision — the item is the unit of collaboration

**Goal:** dsul is "Linear for personal tasks", built for a neurodivergent audience:
scannable, low-overwhelm, guilt-free, but capability-rich. The AI is not a chatbot bolted
to a planner — it is a **collaborator on the planner itself**. Some items are yours, some
are Beacon's, and the grid tells you at a glance who is doing what and what needs you.

*Note 2026-10-01 (AI vision step 1, "Honest setup"):* "Beacon" above is this vision's history,
not the product's name. The AI has no name now: the user-facing noun is "AI", OpenClaw keeps
its own name, and `beacon` survives only in ids, file names and stored values (see resolved
decision 6, superseded).

**Status (2026-10-02): step 2a, "Move and save", BUILT.** Chat lives in the right rail as
**Ask**: a home (greeting, today's load, what needs you, AI activity), with items, History
and conversations pushed over it and "‹" to go back. Ask starts closed: the Ask button on
the canvas's header row, Ctrl+J (⌘J on a Mac) or `?` in the dock opens it, and it then stays
as the user leaves it across reloads. Starting closed is one constant, `ASK_OPEN_DEFAULT` in
`lib/sidebar-store.ts` (Kirby's call, 2026-10-02); flipping it makes Ask start open for
everyone who has not chosen, since only a choice is ever stored. While
Ask or an item is docked in the right column the braindump narrows (every layout but
Console, whose braindump is the fixed 300px pane), and it goes back to its own width when
the column closes. On the phone the Ask tab is the same home. Every
conversation is saved to the account, once per finished turn, in `chat_conversations` /
`chat_messages` (migration 057), kept until the user deletes it. Next: 2b (control: edit and
resend (built 2026-10-10: Edit under your latest question sends the changed words as a new
turn; the old question and its reply stay, saved and in what the model hears, since Kirby chose
to keep history append-only over replacing the pair), retry (built 2026-10-10: Try again under the latest reply when it was stopped or failed
in a way asking again might get past, `isRetryableReplyError`; the same question goes again as
a new turn, so nothing saved is rewritten), action lines, receipts with Undo (built
2026-10-10, below), a typed answer on every card) and 2c
(reach: @ items, / commands, the model chip, attachments, open wide). The section "Step 2a —
Move and save" below has what shipped and the privacy statement.

**Note 2026-10-10: what the chat can see, and its words.** Kirby tried free OpenRouter models and
the chat could not find tasks they named, and answered "break this into subtasks" with "make a
project". Two causes on dsul's side: `buildDsulContext` (lib/ai-context.ts) only rendered today,
overdue, habits and project names, while the prompt claimed "full visibility"; and the prompt never
said what a subtask or a project is, nor that chat cannot change anything. The context now adds
"Coming up" (open, dated, not subtasks, the next 14 days) and "Braindump" (open, undated, unbucketed:
the braindump's own membership rule), each capped at 40 with a count; the prompt says what the
snapshot holds, to say so rather than guess, the two nouns, and where the two acting buttons are.
Next, by Kirby's direction ("do anything in the app, like the MCP capabilities"): give chat the MCP
tool set, reads run at once and every write arrives as an accept card with Undo, gated on a model
that supports tool calling. Design first, for Kirby to look at.
Design: https://claude.ai/code/artifact/2e548916-b4d8-4554-ba6a-42ddb161aa77. Kirby took its three
recommendations (2026-10-10): every change waits on a tap at first; the action lines' words are saved
with the turn, raw tool results never are; a smaller today-only snapshot stays beside the tools.
Build order: (1) tool calls in the adapters, (2) lookups in `/api/chat` with action lines, (3) evals,
(4) item changes as cards, (5) containers, habits, pause, deletes. Step 1 is built:
`completeWithTools` on both adapters (non-streamed, one step, never runs a tool; malformed arguments
read as `null`, `tool-args.ts`), and `supportsTools` (lib/ai-server/tool-support.ts), decided per ask
and never stored: the three built-ins yes, a custom host no until a probe exists, OpenRouter by its
catalog's `supported_parameters` (an hour's cache; `openrouter/auto` no, since it may route to a model
without tools). Nothing calls either yet.
Step 2 is built: on a model `supportsTools` says yes to, `/api/chat` runs `lookupLoop`
(lib/ai-server/chat-loop.ts): up to 5 non-streamed rounds of `completeWithTools`, 4 calls a round, the
last round told to answer. The three lookups (lib/ai-server/chat-lookups.ts: `find_items`,
`planner_overview`, `item_activity`) read through the SESSION client under RLS, each table once a turn,
and every result opens with a line saying it is data, not instructions. Each lookup streams an
`{action}` frame (`SseFrame.action`, our words, capped at 200), and the reply comes as one `{content}`
frame: a turn with tools is not streamed token by token. A model without tools streams as before.
The action lines live on `ChatMessage.actions` and are saved with the reply: migration 068 teaches
`chat_append` an optional `actions` key per reply, written to `chat_messages.meta` as `{actions}` (at
most 16 lines of 200, `cleanActions` in lib/conversation-types.ts and the same rule in SQL), and
`toMessage` reads them back. 068 grants authenticated INSERT on `meta`, so meta is owner-asserted;
only `actions` is ever read from it, cleaned again. Before 068 is applied, 057's `chat_append` ignores
the key and a turn saves without its lines. The snapshot is unchanged
for now; trimming it to today waits on the evals (step 3).
Step 3 is built: `pnpm eval:chat` (tests/evals/chat/, its own vitest config, never in `pnpm test` or CI
because it spends real keys) asks 20 questions of a frozen planner (Wednesday 2026-10-14) through the
same prompt, loop and lookups as the route, against the models named in `EVAL_MODELS` with
`EVAL_KEY_<PROVIDER>` keys, and writes a report to tests/evals/chat/results/ (gitignored). Grading is
patterns, not a judge model: the lookups a case needs (by tool and arguments), what the reply must and
must never say, and three rules for every reply (no ids, no tool names, no claim to have changed the
planner). `tests/unit/chat-evals.test.ts` runs every case against a scripted ideal model in CI, so a red
eval is the model's and never the harness's. The three change asks (move, add, break down) are graded
as read-only today and flip to expecting a card in step 4. Building it caught `planner_overview`
promising an overdue count it never gave; its description no longer does.
Step 4 is built: the same loop offers `propose_changes` (lib/ai-server/chat-changes.ts), which never
writes. Its arguments are a ProposalDraft (a create with no type is a task; `clear: [...]` stands in for
the nulls, since not every provider's schema dialect takes a union type), parsed with
`ProposalDraftSchema`, capped at 8 changes and run through `validateProposalOperations` against the
user's own items under RLS, so the model is told what was left off and why and its reply can match the
card. One card a turn. A card streams as a `{proposal}` frame after its action line ("Suggested
"…""); the transport parses it again and `proposal-store.offer(draft, conversationId)` validates it
against the planner as it is then and shows it on that conversation's `conv:` surface, with intent
`'offer'` (no retry: the conversation is where they ask for something else). Accept is the existing
path, so it is one undo, counted on History and receipted with Undo. The card is never saved; its action
line is. With tools the base prompt's `NO_CHANGES_SENTENCE` is swapped for the card (`withToolsPrompt`).
Covered: create, update (title, day, time, part of day, priority, notes), steps under a task, complete or
cancel a one-off, and the braindump. Not yet: ticking or skipping one day of a repeating item, and habits
(step 5). The evals' three change asks now expect the right card, plus three more (finish, braindump,
and a habit tick that must say no).
Building it found that `applyProposal` gave a dated create, or a Braindump item moved to a day, no
bucket, so it stayed in the Braindump (day views list only bucketed items); it now takes moveTaskToDate's
fallback (`anytime`, or the bucket for its time). `find_items` reads "undated" by the Braindump's own
rule (neither scheduled nor bucketed).
Step 5a is built: a card can carry verb operations, `{kind:'verb', verb, itemId, date?}` with verb one of
complete, skip, unskip, pause, resume (`ProposalVerbOpSchema`). That is how a habit, or one day of a
repeating item, is ticked or skipped; a habit is never ticked through `status`. Each asks the verb's own
gate in lib/verb-gates.ts (the one the row and ⌘K ask) once the day is known, which is in the browser
only: the server knows no zone, so there it checks only that the item exists, is not a step, and can be
skipped or paused at all. Two rules on top of the gates: no tick on a day still to come, and skip keeps
the gate's "not on a past open day". Accepting runs the store verb itself (`toggleHabitStatus`,
`toggleTaskStatus`, `setItemSkipped`, `setItemPaused`, each with the op's day, never `selectedDate`), so
streaks and pause windows move exactly as by hand, and `batchHistory` folds them and the plan's field
writes into one undo. The evals' habit tick now expects a card, and a habit skip joins it.
Step 5b is built: a card can start a habit and change how anything repeats. Creates and updates take
`repeatFrequency`, `repeatDays`, `repeatMonthDay` and `timesPerDay`, and a pause takes `until`. A proposal
may create any type the user has, habits included (`canProposeType`), while `canCreateType` keeps
recipes and mods off habits: those write unseen, and a card is read and accepted (Kirby, 2026-10-10:
the AI does anything, each change behind a tap). Which repeats a type takes is the registry's
`allowedFrequencies` (a habit never `none`, and never a step); a repeating dated item needs a first
day; fields a type does not keep (a habit's priority and day, a task's daily count) are dropped, not
refused. A new habit is built as addHabit builds one (fresh streak and history), on `anytime` when
no part of the day is given, since an unbucketed repeating habit shows nowhere.

**Note 2026-10-04: "Ask AI" on the item's right-click menu.** One row, a submenu of at
most four asks, declared in `lib/item-asks.ts` (gate, label, wording) and run by
`lib/open-chat.ts` (`askAboutItem`, `breakDownItem`, `proposeForItem`): Ask about this… /
Continue conversation (the item's one conversation, its box focused), Break it down (the
panel's own card; one predicate, `canBreakDown`, for both), Help me start / Help me get
unstuck (sent into the item's conversation; "unstuck" only while it is sitting), Find a
time for this (a plan card on Ask home; not on paused work, a series, a milestone or a task
in a project block), and Make this easier to keep for a streak type instead of the
task-shaped asks. The console's member rows (which cannot host the panel) send the item to
its page and offer neither the compose ask nor Find a time. Containers and multiselection
are next.

**Note 2026-10-05: the item menu's row is "AI ▸", and it hands off.** The submenu reads
"AI" whoever answers (Kirby: "not loving the 'ask AI' menu name"). Under a line, a row hands
the item to the paired agent: "Hand off to OpenClaw" (`canDelegate`; offered only where
`lib/agent-handoff.ts` `canHandOff`, the agent queue's own filter, says the agent will see
it, and never on a repeating task, whose one agent status cannot re-enter the queue), then
"Take back from OpenClaw" with its status beside it, never gated on the agent being paired.
Opening the menu on a held item reads the agent's rows first, so a finished report is not
cleared on a stale "Queued". Both writes are named history entries with the undo strip.
The item panel's "Assign to OpenClaw" / "Unassign" is unchanged for now (it still offers
finished and paused tasks); naming the AI across the rest of the app is parked.

**Note 2026-10-07: connecting asks one test question (AI setup PR 4).** Every connect,
recheck and OpenRouter sign-in lists the models and then asks the chosen one a 1-token
question (`lib/ai-server/check.ts`), so "connected" means a model answered. The answers are
typed: key_rejected, wrong_provider (a key whose prefix names another company is refused
before anything is sent, `lib/ai-key-prefix.ts`), no_credit, daily_limit, region, network.
A free key's daily cap is read from Google's and OpenRouter's error bodies by fixed fields
only (`lib/ai-server/error-hints.ts`), written to `model_connections.limited_until` (060),
and the chat note says when it resets. Connecting lives in one card, `ConnectAI`
(`components/ai/connect/`), in the setup column and in Settings → AI; a free Google key
leads, pasting a sure key checks it at once, and the key field is uncontrolled so a key is
never in a `value` attribute. The pane's address is `/settings/ai` (an alias of the
permanent `beacon` id), and an OpenRouter sign-in returns to the pane or home (`r`, sealed
in the PKCE cookie). Both opens are closed (2026-10-09): a model that refuses only streamed
requests (an unverified OpenAI org) fails the check as `stream_refused`, falling back once to
the next default when dsul picked the model (#454); and the connect and check buckets also
take a token from a count every instance shares (migration 064's `take_ai_token`, a fixed
hour, failing open to the memory answer until 064 is applied).

**Note 2026-10-07: the doors into setup and the kept question (AI setup PR 5).** While
nothing answers and the gate offers setup, three doors open it besides the unlit key and
Ctrl+J: `?` in the dock or the launcher, whose one row "Set up AI to ask this" keeps the
question typed after it; Ctrl+K's "Set up AI" or "Fix AI" (`ai.setup`, `ai.fix`, no
shortcut), first in the launcher's Actions; and on the phone, the Ask tab itself. The kept
question (`lib/ask-pending.ts`) lives in the tab's sessionStorage, never a URL, cookie or
persisted store, shows in the setup home as YOUR QUESTION with Clear, and is asked at most
once: the watcher claims its id on a short localStorage list before it sends, so a reload,
a status flap or a duplicated tab finds nothing to send. It is sent only to the company the
consent line named ("Connecting sends your question … to Google."), pressed within the
hour: with a question kept a paste only fills the box, and Connect and ask, Check again or
the OpenRouter sign-in stamps the consent. Any other road to a working AI (Settings → AI,
another device, OpenClaw, another company, a stale press) leaves the question unsent in Ask
home's box, so it is never lost and never goes somewhere the person did not see named. On
the phone the third surface is offered while AI can be set up or fixed: the switcher reads
"Set up AI" (Optional) or "Fix AI" (Needs attention) with the unlit mark, the tab holds a
setup page built from the column's pieces (`components/mobile/setup-tab.tsx`) with the
dock's omnibar kept under it, and a key that works turns it into Ask in place. Leaving the
phone's Ask tab spends "It works.". Open: a question kept over an open item is sent without
the item, and the one-time "Connected to …" notice belongs to no PR yet.

**Note 2026-10-08: the tour ends on the AI invitation (AI setup PR 6).** The tour's last
step reads the gate once (`tourAIStep`, `components/onboarding/onboarding-tour.tsx`) and is
one of three cards or none: `ready` while something answers ("Your AI is ready", as before),
`invite` while the gate offers setup, `off` on a replay after No AI ("AI stays off", with Got
it), and otherwise no step 4 at all. An unknown or failed read, AI unavailable, chat Off on
this device, an OpenClaw agent key with no chat, or a key that needs fixing ends the tour on
step 3's last card, whose button then reads "Got it": no invitation while the gate cannot say
one is right. A card already up keeps its variant through a brief flap of the gate. No card
offers Settings any more, so the shell's `onOpenSettings` is gone. On the desktop the invite
card spotlights the unlit key (`data-tour="ask-key"` on its button, the cutout sealed so a
click through it cannot open setup under the tour) and hangs under it; on the phone it
spotlights the mode card and adds "Later, it waits under the mode button.". It is a dialog
that takes focus on its title and keeps Tab among its own buttons. Its two example questions
come from `buildTourOpenerPreviews` (`lib/ai-openers.ts`): Ask home's first two chips at the
real hour, with shorter lines that quote the task added at step 2, found by the id `addTask`
returned (never the typed text, so a Skip quotes nothing); triage, let-go and reflect keep
the column's lines. The three exits do everything that moves the rail, the tab or the gate
before their one await (`setOnboardingComplete`), so nothing opens a round trip late or under
the scrim. Set up AI puts back what the tour showed, then calls `openSetup` (the column, or
the phone's setup page), with no toast either way. Not now toasts "You're all set. One thing at a
time." with where Set up AI waits (at the top right, or under the mode button). No AI, thanks
calls `chooseNoAI` (the undo strip, no toast) and still writes `onboarding_completed`, so the
tour never comes back. The rituals intro waits for three things (`ritualsNudgeReady`'s
`setupOrUndoUp`, read in `FirstRunNudges`): setup on screen (the column on the desktop, the
setup page on the phone's Ask tab, each read on its own shell), the "It works." a connect
there ends on, and an undo row, so it never covers No AI's focused Undo. Each is spent when
the person moves on, and the intro comes after. Defaults awaiting Kirby: the real hour, so
before 16:00 the card offers "Plan my day" with a new line, "Drafts today from your
braindump, like “…”."; "AI stays off" on a replay after No AI, and no step 4 whenever the
gate cannot invite; and the intro's wait. Open: app shortcuts (Ctrl+J, Ctrl+K) still fire
under the tour, as on every step, and a replay with a key that needs fixing gets no fix card.

**Note 2026-10-08: Settings → AI is the pane F18 to F22 draw (AI setup PR 7).** The shell
draws no flat rows and no Advanced fold on the pane: `AIPane` (`components/settings/ai-pane.tsx`)
draws, top to bottom, What AI does (three tiles while nothing is connected, else one sentence),
Use AI in dsul, the AI-off card (only while AI is off), Connection (`ModelConnectionPanel`, always
mounted, drawing nothing while AI is off), OpenClaw (with the gateway rows in its own fold), and
On this device (Who answers in chat, Custom instructions). Which of them show, and where each
`beacon.*` record's one anchor sits in every state, is pure data in `lib/ai-pane-state.ts`
(`aiPaneLayout`, `connectionPill`, `connectionBody`). Use AI in dsul is a new permanent record,
`beacon.useAi`: it reads the account's `ai_hidden` inverted (on only once the server has said
false), has no `dbColumn`, and is written only by `setUseAI` (`lib/no-ai.ts`), never by
`chooseNoAI` and never by `setAIHidden` directly; while nothing is connected it is a "No AI,
thanks" button rather than a lit switch, in the pane and in search alike. The Connection pill
says one of `Checking…`, `Not set up`, `Working`, `Needs attention` or `Daily limit · back at
{t}` (the reset in the user's time zone), and search's `beacon.apiKey` reads the same words
(`Saved ({provider})` for Working, and no time on the limit). The frames'
data clauses that no column backs are dropped: no "Free key" (no provider gives a tier signal),
no "today’s limit reached at {t}" (no `limited_at`), and no "back tomorrow" (a daily limit
always carries its reset). Unpair shipped in PR 7b (below). The header mark lights only with
`canChat`, so F20's mark is unlit by rule while the frame draws it lit.

**Note 2026-10-09: Unpair (AI setup PR 7b).** Pairing still starts on OpenClaw's side (the
device code); Unpair ends it from Settings → AI, on the OpenClaw section's paired card and on
the AI-off card's "{name} is still paired · … Unpair it to stop that." row, both through one
confirm (`useUnpair`, `components/settings/disconnect.ts`). It is `DELETE /api/ai/openclaw`
(session and same origin, `app/api/ai/openclaw/route.ts`) running `unpairOpenClaw`
(`lib/ai-server/connections.ts`) in this order: every `plugin_registrations` row
(`deregisterAllPlugins`), `openclaw_chat_url` and `openclaw_agent_id`, any authorized
`connect_sessions` row still holding a copy of the key (expired, key nulled), the agent key
itself (`clearAgentKey`, `lib/supabase-service.ts`, in either column before 059), then the
registrations once more. The key goes last because it is what reads as paired: a failure part
way answers 503 with the Unpair button still on screen, and every step is idempotent. The
gateway URL and token are a separate connection and stay; the confirm says so when one is
saved. Other instances can keep a cached registration for up to a minute
(`CACHE_TTL_MS`). The browser's plugin chat token is dropped (`resetPluginTransport`), since it
derives from the deleted key. Pairing again mints a new key.

**Note 2026-10-09: Break it down before AI is set up (AI setup phase 2).** While the gate
invites (`askInvite`), the item panel's Subtasks heading offers the same "Break it down" an
item would get once something answers, unlit (a grey Split, nothing lime), and its press opens
setup through `openSetup` instead of asking. Which items is `canOfferBreakDown`
(`lib/item-asks.ts`), the real button's own item rule, so the two never disagree. Its ✕ is
the one-time nudge `break-it-down-offer` (`lib/nudges/registry.ts`, no toast row): closed
once, it is gone on every item and device, and it never shows before this account's
dismissals have loaded. It shows only in the item panel (`offerSetup` on
`ItemDetailSections`, passed by ItemDialog), never on `/item/[id]`, where no column or Ask
tab can open. `openSetup` now closes an open item on the phone too: the item there is a
drawer over the tabs, and the setup page switched to under it showed nothing. The setup
column's Fix card now sends the saved model with a new key, as the pane's does. Open: after a
connect the item is not reopened, so the real button is one tap back.

**Status (2026-10-01): step 1, "Honest setup", SHIPPED (#355).** dsul ships no AI of
its own any more: `process.env.OPENAI_API_KEY` is never read. Each user connects their own
model in Settings → AI: OpenAI, Anthropic, Google Gemini, OpenRouter (sign-in or key) or any
OpenAI-compatible base URL. The key is sealed server-side (AES-256-GCM under
`MODEL_KEYS_ENCRYPTION_KEY`, table `model_connections`, migration 053), is write-only from
the browser, and works on every device. Every AI surface hides until something that can
answer is connected and working (`lib/ai-registry.ts` fails closed). Rituals are opt-in for
new accounts (migration 054). Where this document says "an OpenAI key" or "BYOK", read "a
connected model". Right-rail chat and saved history are built in step 2a (above); tool
calling is not built.

**Status (2026-08-25):** **Phases 1, 2a and 2b SHIPPED.** Phase 1 — the proposal primitive
and the gateway transport (`da56e9b`, `4df4ca7`, `046adb4`, `01d254a`, `2b7dbd7`).
Phase 2a — dsul as a remote MCP server (`142810c`, `1081f5c`, `eddc778`, `9385854`).
Phase 2b — the delegation loop, built as a pull (`a376de5`, `00ec597`). This document
governs the work the same way [unified-items.md](unified-items.md) governs the items refactor.

**Nothing here has spoken to a real gateway yet.** Every protocol claim is pinned by tests,
not by a handshake — see the verification list in
[ai-vision-decisions.md](ai-vision-decisions.md).

**The re-baseline changed the plan more than the plan changed the code.** Delegation was
further along than this doc assumed: `assignee`/`aiStatus`/`aiResult`, `AgentSection`,
`item_events` and per-item chat threads had all shipped on main while Phase 1 was being
written. What Pillar 2 actually lacked was a transport and the needs-input loop, and both
now exist.

**What works right now, with no configuration at all:** the "Pick things back up" command
(omnibar, or `/catchup`) produces a catch-up proposal computed locally — no key, no
gateway, no network — and accepting it is one undoable gesture. Everything else needs
either an OpenAI key (assistant tier) or a gateway (agent tier).

---

## The core insight

What made Linear work is not features — it is that **the issue is the unit of
coordination**. Humans (and now agents) collaborate *on the issue*: status, assignee,
activity trail, comments. Nobody coordinates work in Linear through a chat window.

Applied to dsul: the **item** is where the user and the agent meet. This matters twice
over for the audience, because **chat is a hostile primary interface for neurodivergent
users**. It demands initiation (blank-box paralysis), produces walls of text (scanning
cost), holds no state you can glance at (out of sight, gone), and quietly manufactures
guilt ("I asked it to plan Monday and then ignored it"). The best AI surfaces in dsul
today are the ones that are *not* chat — morning triage and EOD review are app-initiated,
bounded, and one-decision-at-a-time. That is the pattern to bet on.

Note the codebase already leans this way: the chat panel is summoned from the omnibar and
unmounts when collapsed — "there is no persistent chat bar"
([components/sidebar/chat-panel.tsx](../../components/sidebar/chat-panel.tsx), deleted in
step 2a). Demoting
chat is finishing a direction the app already started, not a reversal.

## Three pillars

**Pillar 1 — Executive-function prosthetic (the core value).** The AI does the *planning
work*: triages the braindump, breaks down the overwhelming task, proposes a realistic day,
reschedules slipped items without ceremony. This is the product for this audience, and it
is cheap: each is a single completion over context the app already builds
([lib/ai-context.ts](../../lib/ai-context.ts)), so it works identically on **both tiers**.

The guilt-free mechanic falls out of it: an overdue task never shows a red badge, it shows
Beacon's *proposed new plan*, one tap to accept. The AI absorbs the shame-work of
rescheduling. This generalizes the tone already set by "Still waiting" in
[lib/item-registry.ts](../../lib/item-registry.ts) and `BarCopy` in
[components/ai/morning-check.tsx](../../components/ai/morning-check.tsx).

**Pillar 2 — Delegation (the differentiator).** Assign an item to the agent; it works in
the background and reports progress **on the item** — Linear-style assignee, status,
activity trail, needs-input. OpenClaw tier only. The plumbing largely exists: the plugin
already has tools to read context and mutate items, and webhooks already flow back. What
is missing is product, not infrastructure.

**Pillar 3 — Chat, demoted to an escape hatch.** Not deleted — *re-anchored*. What
disappears is the global, persistent, about-nothing transcript, which is precisely the
part that is hostile to the audience. Conversation reappears wherever it has an anchor:

- **Item threads (the workhorse).** Every item expands into an activity feed —
  status changes, agent actions, and conversation interleaved. Delegation collaboration
  happens here. Deep agent work does not need a chat app; it needs a good thread on the item.
- **The omnibar `?` ask (the front door).** One keystroke, ask anything, get a **card**
  back — an answer, or a proposal with accept/dismiss — not a transcript. Initiation is
  cheap; conversation is a consequence, not a destination.
- **Ritual conversations.** Morning triage and EOD review become conversational *inside a
  structure*: a finite deck of decisions, free-text replies allowed at any step, and a
  visible end. Chat with a progress bar and an exit.

The sidebar becomes an **agent activity feed** — recent proposals, delegated item status,
the needs-input queue — each entry linking into its item thread. The framing: *the sidebar
shows the agent's work; conversations live on the work items.*

## Capability tiers

Tiers, not "provider with a fallback". They are **not** equivalent, and the UI must never
pretend they are.

| Tier | Transport | Pillars |
|---|---|---|
| **assistant** (BYOK OpenAI, or none/mock) | Next.js route → provider | 1 only |
| **agent** (user's OpenClaw gateway) | Next.js route → gateway | 1 + 2 |
| *hosted (future)* | dsul-operated agent | 1 + 2, zero config |

Two traps to avoid. **Do not make BYOK do delegation** — that means rebuilding OpenClaw
inside dsul (tool loop, task queue, background workers). **Do not branch on provider
strings in the UI.** The house pattern is already established: do what
[lib/item-registry.ts](../../lib/item-registry.ts) does and ask a capability question
(`canDelegate()`, `canPropose()`, …). Adding the hosted tier must be config, not code paths.
`canMake` (2026-10-07, mods.md "AI writes it") is Settings → Make's "Write with AI": true only
for `target === 'model'`, so an OpenClaw-only account, or a device that chose OpenClaw, gets no
Write, and "No AI, thanks" hides it with everything else.

## Trust model

Predictability *is* the feature for this audience, so the default is conservative:

1. **The AI proposes; the user accepts with one tap.** Proposals are first-class objects
   (a diff + accept/dismiss), never silent mutations.
2. **The agent acts autonomously only on items explicitly delegated to it**, always with a
   visible activity trail and undo.
3. Everything else is read-only to the agent from the UI's perspective.

Looser policies ("Beacon may auto-reschedule overdue items") can be added per-user later.
Trust is easier to extend than to rebuild.

## Integration architecture — three surfaces

Researched against docs.openclaw.ai (2026-07-31). These facts are load-bearing:

- **Sessions have no TTL by default** (`session.reset.mode: "none"`); opt-in `daily`
  (`session.reset.atHour`, default 4) or `idle` resets. A reset keeps the sessionKey and
  starts a new sessionId; transcripts archive to disk. Long contexts are handled by
  compaction, not truncation.
- **Subagent sessions auto-archive after `archiveAfterMinutes` (default 60).** The current
  plugin chat endpoint is built on `runtime.subagent.run` + `waitForRun` +
  `getSessionMessages`, so **Beacon's server-side memory silently evaporates after ~an
  hour today.** This is a real bug, and it is not fixable inside that primitive: subagent
  runs do not stream, and the `subagent:` namespace gets cron-style maintenance aging
  rather than durable-conversation retention.
- **The docs draw a hard line:** external apps must not import `openclaw/plugin-sdk/*`.
  External apps use the Gateway WebSocket protocol (`@openclaw/gateway-client`, browser
  entry available, Ed25519 device pairing) **or** the OpenAI-compatible HTTP API.
- The OpenAI-compatible endpoint is **disabled by default**
  (`gateway.http.endpoints.chatCompletions.enabled`), supports real SSE streaming, and is
  **stateless per request** unless routed with a stable `user` string or the
  `x-openclaw-session-key` header. Docs warn it is **full operator access** — never expose
  its token to a browser.
- Background work: `POST /hooks/agent` (dedicated `hooks.token`, `sessionMode: "isolated"`,
  `idempotencyKey`) returns after runner admission (≤15s), not completion. Sub-agent
  announce is **best-effort and lost on gateway restart**.

Which yields three surfaces:

**1. Conversation → OpenAI-compatible `/v1/chat/completions`, proxied server-side.**
dsul's Next.js route handler calls the gateway with `stream: true` and translates the
OpenAI-shaped chunks into the `{content}` / `{error}` / `[DONE]` frames the client already
parses, so both tiers share one client code path and the operator token never reaches the
browser. A stable session key per thread gives every item thread durable gateway-side
memory under the no-TTL default.

*This also closes a live security gap:* today the browser holds a dsul API key and POSTs
directly to the gateway ([lib/chat-store.ts](../../lib/chat-store.ts), deleted in step 2a;
[app/api/agent/chat-url/route.ts](../../app/api/agent/chat-url/route.ts)). After this, the
browser talks only to dsul.

*Narrowed 2026-10-07 (#123, #142, migration 059), for accounts still on the plugin path:* the
browser no longer holds the agent key. `/api/agent/chat-url` hands it a plugin chat token, an
HMAC of the key ([lib/plugin-chat-token.ts](../../lib/plugin-chat-token.ts), mirrored in
`openclaw-plugin/src/chat-token.ts`), which the plugin's chat route accepts and dsul's agent API
does not. The key itself moved from `user_settings` (browser-readable under RLS) to
`user_secrets` (service role only), read and written only through the helpers in
[lib/supabase-service.ts](../../lib/supabase-service.ts); the old column is CHECKed null. The
plugin path stays browser-direct because a plugin on a tailnet is reachable from the user's
browser and not from Vercel, so a server proxy would break it.

**2. Delegation → `POST /hooks/agent`,** with the agent reporting results back through the
dsul items tools the plugin already registers. Because announce is best-effort,
**dsul's DB is the source of truth** for threads and delegation state; gateway reports
are notifications. Gateway sessions are disposable working memory, always re-primable from
stored thread history.

**3. The plugin stays — shrunk to what only in-process code can do.** The "external apps
shouldn't use the plugin SDK" rule is about *which code uses which surface*, not about who
wrote it. `openclaw-plugin/` runs **inside** the gateway process, so it is a legitimate
plugin and remains the only way to register agent tools. dsul's Next.js server is the
external app, and it talks HTTP. Two codebases, two roles.

Known third-party plugin limits (bundled-only, not available to us):
`api.session.workflow.scheduleSessionTurn`, `api.runtime.gateway.request`,
`sendSessionAttachment`, and any unprompted push to a channel. Anything needing those must
be driven from dsul's side via hooks/cron instead.

**ClawBoy-expo is not part of this architecture.** It is an independent OpenClaw client and
a place to borrow code from if a need arises; dsul requires no shared code with it. (Note
for that repo separately: current gateways pin operator clients to protocol v4; a v3-only
client will stop connecting.)

---

## Locked design decisions

1. **The item is the collaboration surface.** Conversation is anchored to an item, a
   ritual, or a one-shot ask. No global persistent transcript is reintroduced.

   *Superseded in part, 2026-10-02 (step 2a, Kirby's "Forever, with delete"):* conversations
   are now saved to the account and kept until deleted, general ones included, so the second
   sentence no longer rules out persistence. What still holds is the first sentence, and the
   schema now enforces it: an item's conversation is the item's, one per item (a partial
   unique index, migration 057), and it opens with the item in the rail. A general
   conversation is a thread the user started and can find again in History, not one global
   transcript, and nothing (no context endpoint, no MCP tool) hands it to an agent. "Global
   persistent transcript" meant a single never-ending chat that every surface appended to,
   and that is still not reintroduced.
2. **Propose-by-default.** Every AI mutation outside a delegated item is a proposal the
   user accepts. Accepting applies through **existing planner-store actions** — never a
   parallel mutation path.
3. **Accepting a proposal is ONE undo.** It must follow the batched-action pattern
   (`moveTasksToDate` / `unscheduleTasks` in
   [lib/planner-store.ts](../../lib/planner-store.ts)): one `set()` → one history entry →
   one Cmd+Z, with `setNextActionLabel` armed before the set.
4. **Tiers are a capability registry**, modeled on `item-registry.ts`. No `provider ===
   'openclaw'` checks in components.
5. **Delegation state must never overload `items.status`.** Task/habit status vocabularies
   are frozen external contracts (the plugin `safeParse`s the context response and
   **throws** on drift). Delegation rides its own columns.
6. **dsul's DB is the source of truth**; gateway sessions are disposable working memory.
7. **The operator/gateway token is server-side only.** It lives in `user_secrets`
   (service-role only, per migration 012) and must never enter a client component or the
   browser bundle.
8. **All context-response additions stay `.optional()`** — old plugin builds parse the
   whole response with one `safeParse`.
9. **The existing plugin chat path keeps working** until the user deliberately switches
   transports. No flag day.

## Resolved product decisions (2026-08-25 — Kirby took the recommendations)

Folded here from ai-vision-decisions.md, which now carries only what is still open.

1. **The chat panel keeps a free-form ask.** The agent activity feed takes the top of it;
   the transcript stays underneath. Removing free-form entirely would delete the only place
   to say "why do I keep avoiding this?", which is a real use even though it is not the
   main one.
2. **Proposals stay ephemeral** until item threads are server-persisted. Then the *thread*
   becomes the durable record and proposals stay transient. A resurrected card that
   proposes moving things to a date that has passed is worse than no card.

   *2026-10-02 (step 2a):* item threads are server-persisted now (057), so the thread is the
   durable record, as this decision said it would be. Proposals stay transient exactly as
   decided: a card is never saved and never resurrected. What a conversation keeps of an
   accepted proposal is four counters (added, steps, moved, changed) behind History's second
   line: the record that something changed, not the proposal. 2b's receipts with Undo will
   live in `chat_messages.meta`, not in a proposal table.

   *2026-10-10 (step 2b, receipts):* built memory-only instead (`lib/chat-receipts.ts`). A
   receipt's Undo names a planner history entry, and that history is per tab and gone on
   reload, so a saved receipt would come back with an Undo that can undo nothing; the
   counters stay the account's record. Undo shows only while the accept is the planner's
   latest entry, because the history is one line and undoing past a later change would take
   that back too. If receipts should outlive the tab, `meta` is still the place, read-only.
3. **Proposal scope grows in this order: unschedule → subtasks → habits.** Subtasks shipped
   in phase 2e, unschedule in 2h; habits remain out (decision 5 and `containerRequired`).

   *Both halves of the original note held up.* "Put it back in the Braindump" DOES have real
   semantics beyond writing NULL — it is the `unscheduleTask` verb, clearing startTime,
   timeBucket and isScheduled with the date, and a generic patch writing only the date leaves
   an item that is `isScheduled` with a bucket and no day: placeable on no surface, reachable
   from nowhere but the Braindump it was never actually put in.
4. **Delegation autonomy stays tight**: propose everywhere; act autonomously only on items
   explicitly delegated, always with a trail and undo. Trust is easier to extend than to
   rebuild, and nothing is built yet, so this is free to loosen later.
5. **Habits are not delegable.** Delegation suits one-shot work; a habit is a recurring
   commitment the user is trying to build, and having an agent do your meditation is
   incoherent. Expressed as the `agentAssignable` registry capability, never a type check.

   *Amended 2026-08-25:* this originally said custom types WERE delegable, and shipping it
   proved otherwise. `/api/agent/tasks/:id` filters on `.eq('type','task')` in both its
   ownership check and its update, and the agent write API does not expose custom types at
   all (a locked v1 decision in [unified-items.md](unified-items.md)) — so a delegated
   custom item appeared in the agent's queue and every progress report on it 404'd, forever,
   with the badge stuck on `queued`. `agentAssignable` is now false on the custom template.
   Flip it back when the agent API grows a type-agnostic item write path; that is the real
   fix, and it is a bigger change than this decision implied.
6. ~~**Beacon is the name on every tier.** The assistant should not appear to change identity
   because a settings toggle moved; the gateway is plumbing, Beacon is the character.~~

   *Superseded 2026-10-01 (AI vision step 1, decisions (d) and 10):* the AI has no name; the
   user-facing noun is "AI" (the settings pane, "Ask AI"); OpenClaw keeps its own name, because
   it is the agent's; `beacon` survives only in ids, files and stored values (the pane id and
   `/settings/beacon`, the `beacon.*` record ids, the assignee value `'beacon'`, which renders
   as "AI").
7. **BYOK stays.** On a gateway-owning account it is nearly dead weight, but every Pillar 1
   feature that works over a bare completion also works for a user who will never
   self-host — and it is the rehearsal for the hosted tier.

   *Amended 2026-10-01 (step 1, decisions (a) and (b)):* BYOK is now the ONLY way to a model.
   The app's own server key is gone. Keys are no longer kept in the browser: they are sealed
   server-side, never sent back (not even masked), and usable on every device.
8. ~~**Anthropic stays declared coming-soon** until there is a reason to wire it. The registry
   now says so explicitly, so no surface offers an action it cannot perform.~~

   *Superseded 2026-10-01 (step 1, decision (a)):* OpenAI, Anthropic, Google Gemini,
   OpenRouter (OAuth or key) and any OpenAI-compatible base URL are wired; the tier registry
   that declared coming-soon is gone (`lib/ai-registry.ts` is now the capability gate).

## Schema note — where delegation state lives (corrected twice; read the whole note)

*(2026-07-31, revision 3. Revision 1 said "adopt the unused 019 columns". Revision 2
reversed that and locked "delegation never becomes a field on `Item`". Revision 2 was
written against a stale tree and is WRONG — `assignee` / `aiStatus` / `aiResult` shipped
as `taskShape` fields on 2026-07-29 in item-surface-growth Phase 4, and they work.)*

What actually exists, and should be reused rather than rebuilt:

- **`assignee` / `aiStatus` / `aiResult` are fields on `taskShape`** — loose on read, strict
  on write (`aiStatus: 'queued'|'working'|'blocked'|'done'|'failed'`). `AgentSection` in
  [components/planner/item-detail-sections.tsx](../../components/planner/item-detail-sections.tsx)
  already renders assign/unassign and gives `blocked` the destructive treatment, because it
  is "the only state that wants something FROM you".
- **`item_events` (migration 023) is the activity trail.** Its own header anticipated this
  work — *"text (not CHECK) so a future action (completion, assignment, agent progress) is
  additive"* — and `eventLabel` already speaks `assignee` and `aiStatus`. `recordCheckin` is
  the precedent for a deliberate, non-trace event writer.
- **Item conversations exist and are saved** (migration 057; `resolveItemThread` in
  lib/conversations-store.ts), one per item, each keyed to its own gateway session via
  `conversationSessionKey(userId, conversationId)` (lib/openclaw-gateway.ts).

Revision 2's *reasoning* was not baseless, and the true part survives as the rule:

> `toLegacyTask` is a spread, so every `taskShape` field enters the frozen `tasks[]`
> projection and joins schema-derived `TASK_FIELDS` → `diffItem` → the 50-entry undo stack.

That is a real hazard for anything that changes *often*. It is not a hazard for these three,
because they are small, stable, and the frozen projection's schema already contains them (so
the plugin's `safeParse` sees no drift), and because agent writes land through
`/api/agent/*` → `lib/db.ts`, never through the store, so they push no history entries.

**Locked, replacing revision 2's rule:** the delegation *state machine* is three fields on
the item (`assignee`, `aiStatus`, `aiResult`) — a handful of transitions per delegation.
Everything **high-frequency** — progress notes, tool traces, partial findings — goes to
`item_events` as trace rows and NEVER to `items`. The split is not a compromise; it is what
the two stores are each for. If `aiStatus` ever needs sub-states that tick, they are events,
not statuses.

Two consequences worth stating: `aiStatus`'s vocabulary becomes a frozen external contract
the moment a real agent writes it, so extend it only additively; and `setItemCompletion` /
`setItemSkip` go through RPCs that bypass `updateItem`, so completions currently emit no
`item_events` — a gap to close when the trail is load-bearing.

## Unverified assumptions (test these first, with a real gateway)

Written down because none could be checked without a gateway, and each has a one-line fix:

1. **Does posting to a keyed session APPEND or REPLACE history?** The gateway holds session
   state, so resending a full transcript each turn may duplicate it. dsul currently sends
   the system prompt plus only the newest turn, behind
   `SEND_FULL_TRANSCRIPT_TO_GATEWAY` in `lib/openclaw-gateway.ts`. Under-sending costs
   context the gateway already has; over-sending corrupts it. **Flip the constant if a
   gateway turns out to be stateless per request.**
2. **Does the OpenAI-compatible endpoint accept `x-openclaw-session-key` from dsul's
   origin,** with `gateway.http.endpoints.chatCompletions.enabled: true`? If not, fall back
   to the OpenAI `user` field, which the docs say derives a stable key.
3. **What does `model` mean here?** dsul sends `agentId ?? 'default'`. If a gateway
   rejects that, it needs its own config field rather than reusing `openclaw_agent_id`.
4. **CORS/ingress**: dsul calls the gateway server-side, so browser CORS does not apply —
   but the gateway must be reachable from wherever dsul runs (Vercel), which a
   tailnet-only gateway is not. Local dev works; production may need Tailscale Funnel or
   equivalent. This is the most likely thing to be wrong.

## Phasing (the app must work at every step)

**Phase 1 — the proposal primitive + the transport fix. SHIPPED.**
- `lib/ai-registry.ts` — the capability registry.
- `lib/proposal.ts` / `lib/proposal-store.ts` / `components/ai/proposal-card.tsx` /
  `app/api/ai/propose/route.ts` — proposals, with the catch-up case computed locally.
- `planner-store.applyProposal` — batched, one undo.
- `lib/sse.ts` — one parser for every transport.
- `lib/openclaw-gateway.ts` + the `/api/chat` gateway branch + `/api/agent/gateway` +
  migration 023 — the server-side transport, alongside the plugin path, opt-in by config.

**Phase 2a — dsul as an MCP server.** The executor should be an adapter, not a
commitment. dsul's agent API is the durable asset; which runtime acts on it is not.
Exposing that API over MCP means OpenClaw *and* Claude, ChatGPT, Cursor and anything else
MCP-capable can act on the planner, with no per-vendor plugin each time — OpenClaw's own
docs describe consuming remote MCP servers (`mcp.servers.<name>`, `type: "http"`, OAuth).
Doing it BEFORE delegation matters: it decides whether delegation's contract is written
against a vendor-neutral tool surface or against one gateway's plugin API.

**Phase 2b — delegation, as a PULL. SHIPPED** (`a376de5`, `00ec597`).

The agent asks dsul what it owes; dsul never calls the gateway. Three MCP tools close
the loop: `dsul_my_work` (assigned, open items only), `dsul_report_progress` (writes
`aiStatus`/`aiResult`), `dsul_item_activity` (reads the trail, including the user's answer
to a blocked question). The UI half already existed — `AgentSection` — and gained a reply
box on `blocked`.

**Why pull and not `POST /hooks/agent`.** OpenClaw's built-in Tailscale integration
exposes only the Control UI and WebSocket — *"Serve/Funnel only expose the Gateway control
UI + WS"* — not `/v1/*` or `/hooks/*`. Making the push path work from Vercel would mean
hand-rolling a funnel across the whole gateway port, which publishes the endpoint the docs
call **full operator access** to the internet behind one shared password; OpenClaw's own
security audit lists that under *"fix immediately"*. Pull needs no ingress, no second
credential, and no attack surface. The cost is pickup latency, which for "book the dentist"
is not a cost. Funnel + hooks stays available as the upgrade if instant pickup ever matters.

**Phase 2c — chat can end in a card. SHIPPED.**

Pillar 3 said conversation reappears "wherever it has an anchor", and the omnibar `?` ask
was meant to return *"an answer, or a proposal with accept/dismiss"*. Only half of that had
ever been wired: `proposal-store.request('ask', …)` existed and nothing called it, so the
`catch-up` button was the sole producer of a card. Beacon could describe a plan and then
leave the user to go and enact it by hand.

- **`components/ai/chat-conversation.tsx`** (deleted in step 2a) — a "Turn this into a plan" affordance under
  the latest assistant reply. It hands over the EXCHANGE, not the raw question: what is
  worth acting on is usually in the reply ("push the two writing ones to Thursday"), and a
  proposer given only the question re-derives the answer and lands somewhere else. Both
  shells already mount `ProposalCard` above the transcript, so the card arrives where a
  decision belongs rather than at the bottom of scrollback.
- **`lib/ai-openers.ts`** — three planner-derived openers instead of a blank box. A blank
  input demands exactly the initiation this product exists to lend, and the audience
  section above is the reason it is not a static list: "What can I let go of?" is an offer
  on a day with things sitting past due and noise on a day without. Same copy contract as
  `BarCopy` and the proposal card, pinned by a test that greps the strings.
- **`/api/ai/propose` gained a gateway branch.** It had been refusing `provider ===
  'openclaw'` outright while `ai-registry` advertised `canPropose: true` for the agent
  tier — precisely the failure the registry's own header warns about ("a surface asks
  `canPropose`, gets true, offers the action, and the route answers with an error
  string"). It now asks the user's gateway through a non-streaming
  `/v1/chat/completions`, on `proposeSessionKey` rather than the chat key, and recovers
  JSON from fences and prose because an arbitrary agent will not honour
  `response_format`. Still never reroutes to OpenAI: that would send an OpenClaw user's
  planner to a provider they deliberately did not choose.

Untested against a real gateway, like everything else in the transport — the propose branch
shares `assertAllowedGatewayUrl` and the wire shape with chat, so the same first probe
exercises both.

**Phase 2d — three ways out of a card that is nearly right. SHIPPED.**

The card had exactly two exits, and both were all-or-nothing: take the whole plan, or close
it and be where you started. That is the wrong shape for a trust-building primitive — the
common failure is not a wrong plan, it is a plan with one wrong line in it.

- **Drop a line before accepting.** Every line is a toggle, all ticked by default (opting
  into each of six would turn one tap into six). `accept(operations?)` narrows to the ticked
  subset and still makes exactly ONE `applyProposal` call, so partial acceptance is still
  one `set()` and still one Cmd+Z. The button counts what will actually happen, so it can
  never promise more than what is ticked. Selection is tagged with the proposal id and
  derived during render — indices are positional, and an effect would reset a render late,
  after a paint showing the previous card's ticks on the new card.
- **"Something else"** re-asks with what was already turned down (`retry`, capped at three
  carried summaries). The original ask is stored verbatim and the rejections re-composed
  onto it each time, so retries do not decorate each other's decoration. Hidden on
  `catch-up`, which is a pure function of the planner and would return the same items — a
  retry that cannot differ is a button that lies.
- **A stop button for chat.** `chat-store.stop()` has always been able to abort, and
  `send`'s `finally` clears `isLoading` on either transport; there was simply no way to ask.
  It takes the slot the send button occupies while disabled during a stream.

**Phase 2e — "Break it down". SHIPPED.** Second on the locked proposal roadmap (decision 3:
unschedule → subtasks → habits), and the verb the ADHD-planner market research found every
competitor stopping at.

`ProposalCreateOpSchema` gains `parentItemId`. Everything else follows from one fact — *a
subtask has no independent presence*, since nothing outside its parent's detail panel
renders one:

- Validation refuses a parent whose type says `subtasks: false` (registry-derived, so a
  future type opts out by config), and refuses a parent that is itself a child — one level
  is all the panel draws, and `lib/db.ts:1026` already refused a grandchild independently.
- Scheduling fields on a step are **dropped, not rejected**: they would be written and never
  read, and the step is the useful part of the operation. The pre-existing rule that an
  *existing* subtask may never be the target of an `update` is untouched, and for the same
  reason.
- `applyProposal` carries the link through, so a whole breakdown is still ONE `set()` and
  one Cmd+Z.

**Two surfaces, one store.** A breakdown is asked for inside the item's detail dialog, so
answering into the sidebar behind it would put the suggestion where the user cannot see it.
Each request records a `surface` (`'chat'` | `` `item:${id}` ``) and each `<ProposalCard>`
renders only its own — checked before the loading state too, or a spinner appears in the
wrong place.

**A second system prompt**, selected by `mode`, rather than a paragraph bolted onto the
planning one: planning moves existing work and must not invent, breakdown invents and must
not touch anything else. The size guidance is load-bearing — three to six steps, first one
startable in five minutes. A fifteen-step decomposition of a task someone is already
avoiding is a fresh source of dread, which is exactly the failure the audience section
warns about.

**Adversarial review of 2c–2e (three lenses: correctness, security, UI state).** Both the
correctness and UI passes independently found the same top defect, which is the strongest
signal a review gives. What was real, and what it cost:

- **A superseded reply overwrote a newer card.** `askModel` wrote its result unconditionally,
  so the last request to RETURN won rather than the last one ASKED — and those differ,
  because `request('catch-up')` resolves synchronously. A slow breakdown could land on top
  of a catch-up card the user was reading, under a `lastRequest` describing a different
  intent, on a surface whose panel was closed, with retry hidden because the intent no
  longer matched. Dismissing mid-flight was worse: `lastRequest: null` passes the surface
  guard on EVERY mount, so the same card rendered twice. Fixed with a generation token that
  `request`, `retry`, `accept` and `dismiss` all claim.
- **The stop button was wired to nothing on the transport that serves almost everyone.**
  `chat-store.stop()` aborts `abortController`, which only the plugin branch ever armed;
  the `/api/chat` fetch passed no signal. An earlier comment in this repo asserted the
  opposite — it was wrong, and `tests/unit/chat-stop.test.ts` now checks the claim rather
  than repeating it. Aborting also stranded the empty placeholder turn in the transcript
  and in localStorage, which suppressed the openers permanently (they key on an empty
  transcript).
- **`parentItemId: ""` slipped every guard.** Truthiness, not presence. The "step" was
  created with a blank parent, rendered as a top-level task (the projection filters on
  `!parentItemId`), kept the scheduling fields the parent branch would have stripped, and
  then failed to persist because Postgres rejects `''` as a uuid — so it appeared, earned an
  undo entry, and vanished on next load. Closed at both the schema (`min(1)`) and the
  validator.
- **`operations[]` had no ceiling.** The producer is untrusted by design; 5,000 operations
  rendered six visible lines in a scroll box under a button reading "Do all of it", then
  fanned out 5,000 unthrottled inserts on one tap. Capped at 20, with length caps on every
  string.
- **Any registered account was an uncapped OpenAI proxy.** `model` travelled verbatim from
  the request body to the deployment's own key. Now: a user's own key buys any model they
  name, the server's key is restricted to what the settings UI offers, and `prompt` +
  `itemContext` are clipped.
- **Dead ends.** Loading had no exit while greying out AI buttons app-wide; the error state
  had no retry; the OpenAI branch had no deadline (the SDK defaults to ten minutes);
  `plannerContext()` sat outside the try, so a throw parked `status` at `'loading'` forever;
  accepting a plan whose items had since been deleted closed the card silently with no
  change and no undo entry; and "Break it down" then closing the panel stranded the answer
  where nothing mounts. All fixed; the busy-gating is now per-surface.
- **`openToday` disagreed with the grid** on recurring items — the doc comment claimed
  parity with `deriveDayItems` and it was false. Recurrence says which WEEKDAYS a series
  lands on, not when it begins, so a daily task starting in December read as "due today" all
  year before it.
- **SSRF spellings.** `[::a9fe:a9fe]` (IPv4-compatible), `[64:ff9b::a9fe:a9fe]` (NAT64 —
  genuinely translated on IPv6-only egress) and `metadata.google.internal` all passed.
  Theoretical, since the guard requires https in production and every cloud metadata service
  is http-only, but the guard's stated job is to block that address.

Judged real but not acted on: **prompt injection through item titles**. Items can be written
through the agent API, so injected text can steer a proposal — but the injector is already a
write-capable principal, and after double validation the worst a steered proposal achieves is
mass cancel/reschedule/create on the user's own items, behind an explicit tap, reversible
with one ⌘Z. It cannot delete, cannot touch recurring status, cannot cross a user boundary,
cannot write arbitrary columns, and renders as React children so it cannot script. Low.

**Phase 2f — a question you can answer with one tap. SHIPPED.**

`dsul_report_progress` with status `blocked` could always ask a question; what it could
not do is offer ANSWERS. Most of what actually stops delegated work is a choice — which
Dana, which of the two invoices, is Thursday still fine — and making the user retype a name
into a box is the difference between a loop that closes in a second and one that waits until
they have the energy to compose a sentence.

- **`dsul_ask_user`** → `POST /api/agent/items/:id/ask`. Blocks the item and posts the
  question in ONE call: a question without the block renders nowhere (nothing draws a reply
  box unless `aiStatus` is `blocked`), and a block without the question is the old
  behaviour — so two tool calls would make the half-done state reachable every time a run
  died in between.
- **Options ride in `item_events.payload`, not in a new column.** Every `taskShape` field
  spreads into the frozen `tasks[]` projection the OpenClaw plugin `safeParse`s, and that
  throws on drift. `payload` is `jsonb` with an open `action`, and migration 023's own header
  anticipated exactly this — *"a future action … is additive, not a migration"*. So this
  costs no schema change and cannot break a contract. `aiResult` still carries the question
  text, so an agent that only reports `blocked` is unchanged.
- **The text box never goes away.** An exhaustive-looking list usually isn't, and the tool
  description says so: offer options only when they genuinely cover the answer, because a
  question whose real answer is missing reads as a closed set and is worse than no options.
- **Stale choices are withdrawn.** `AgentReply` offers buttons only for a question with no
  `agent_reply` after it — otherwise the user is invited to answer something they already
  answered.

*Adversarial review, same day, five real findings — one of which refuted the claim above.*

- **The atomicity claim was false.** `recordItemEvent` is fire-and-forget by design, so the
  original route flipped the status and dropped the insert's promise: the block could stick
  while the question was lost (or never sent at all, if the serverless invocation froze the
  moment the response returned), leaving the user a question with no buttons and the agent a
  tool result saying it had offered them. The question is now written FIRST and **awaited**
  (`insertItemEvent`, the one awaitable event writer — the rest are traces, and a lost trace
  is a missing line in a feed; a lost question strands a human).
- **No item-type guard.** This is the only agent write that looks items up by id alone —
  every other one goes through `verifyItemOwnership`, which filters on type — so a worker
  could block a HABIT. Nothing renders a reply box for one (`AgentSection` is gated on
  `agentAssignable`), `selectAssignedWork` filters it out of the queue, and the follow-up
  `report_progress` 404s: a question nobody can answer and an agent waiting forever. The
  registry's own header names this hazard. Now guarded on `agentAssignable`, plus a 409 for
  an item assigned to nobody, which fails the same way in a different shape.
- **Options could attach to the wrong question.** The question the user reads comes from
  `aiResult`, which `dsul_report_progress` also sets — and that path writes no event. Ask
  with options, then ask again through the old tool, and the new question rendered above the
  OLD question's buttons; a tap filed "Dana Reyes" as the answer to "what's the invoice
  number". Options are now matched against the current `aiResult`, which also handles a lost
  event and a truncated feed the same safe way.
- **Options leaked across items.** The detail panel is reused — the dialog re-seeds on id
  change without unmounting — so opening blocked item B while A was up showed A's buttons
  with B's id already bound. Now derived during render from a key of `(itemId, question)`,
  which fixes the leak and the one-frame flash together.
- **The block skipped `updateItem`**, so it emitted no `tasks.updated` webhook (a permanent
  contract) and no Activity line — the one status change in the app that happened silently.

Not acted on: `fetchItemEvents`' `limit(50)` can push a question out of the window on a busy
item. It degrades to the text box, which is where the user was before any of this existed.

**Phase 2g — what the agent is doing, on the row. SHIPPED.**

Delegation state lived only inside the item's detail panel, so seeing which items were
moving meant opening each one — and the one state that wants something FROM the user
(`blocked`) was the most buried of all.

- **`lib/agent-status.ts`** is the pure derivation: label, elapsed, and two booleans
  (`needsUser`, `active`). `done` returns null on purpose — a row that keeps announcing
  finished work is the badge equivalent of a notification that will not clear.
- **`AgentPill` is a sibling of the title, not a rail column** — the same call the goal-role
  glyph made and for the same reasons: the rail's columns reserve width on every row of both
  types, so a sixth would cost space app-wide to say something true of a handful of rows;
  and this needs a word, because "Working" and "Needs you" are not distinguishable as icons.
  Honey is reserved for `blocked` alone; a row that shouts about work proceeding normally
  teaches you to stop reading it.
- **Migration 038 adds `ai_status_at`**, and `lib/db.ts` stamps it as a declared
  `COMPANION_COLUMNS` entry of `aiStatus` — the mechanism `db-allowlists.test.ts` already
  had for exactly this, so the drift detector can see it rather than having the assertion
  loosened around it. `aiStatusAt` is EXEMPT from the allowlist itself: nothing may write it
  alone, which is what keeps the clock from drifting from the state it timestamps.

**Why not `items.updated_at`** (which exists, is trigger-maintained, and would have needed no
migration): it answers *time since ANY edit*. Renaming a task mid-run would reset the clock
and the row would report a confident wrong number. The whole value here is that "working 4m"
and "working 3h" mean different things — a wrong number is worse than none.

The 60-second interval lives inside `AgentPill`, which only mounts for an item with a live
agent state, so a planner with nothing delegated runs no timers.

*Caught by its own tests:* `isAgentState` used `in`, which walks the prototype chain — an
agent writing `aiStatus: 'toString'` would have passed the guard and handed React a function
to render. `aiStatus` is a loose string by design (constraining it would let a future
vocabulary addition brick an old plugin's `safeParse`), so that was reachable. `Object.hasOwn`
now.

*Adversarial review — the worst batch so far. Two would have broken production.*

- **The migration never rebuilt `items_windowed`.** That view freezes its column list at
  creation and `fetchItems` reads `select('*')` from it, so a new `items` column is invisible
  to the client until the view is rebuilt. 031's header states the rule outright and 032 is
  the precedent; 038 was the first migration since to add a column and missed it. Every write
  would have succeeded, every read returned `undefined`, and the whole feature been silently
  dead — while working fine in any dev database that never ran 031.
- **`itemToRow` wrote the new column unconditionally**, so a build deployed ahead of the
  migration could not create ANY task. `pauseColumns`, `containerColumns` and
  `reminderColumns` are all conditional emitters and `containerColumns`' header says exactly
  why. Vercel deploys on push while `db:push` is manual, so that window is real, and
  `createItem`'s PGRST204 recovery only strips reminder columns — it would have rethrown.
- **`aiStatusAt` was agent-writable and unvalidated.** `TaskCreateSchema` spreads `taskShape`,
  so every new field becomes an accepted create-body field automatically: an unvalidated
  string reached a `timestamptz` column and 500'd at Postgres instead of 400ing at the
  boundary, and a well-formed past value let an agent manufacture a fake "Working 3h". Omitted
  now, on the same principle as `projectId` — it is derived, not declared.
- **The optimistic write left the clock stale for the session.** The store merges updates
  locally and nothing refetches — no realtime subscription, no polling, `initializeStore`
  early-returns. So a status change stamped only server-side left the store on the PREVIOUS
  time: answer a question asked six hours ago and the row reads "Queued 6h" for a state six
  seconds old. Exactly the confident wrong number this column exists to prevent.
- **Undo re-stamped instead of restoring.** `diffItem` carries both fields back, but the row
  mapper overwrote the stamp with `now`, so ⌘Z on an agent status change dated the restored
  state to the moment of the undo and lost the original irrecoverably. An explicit stamp now
  wins over `now`, which is what makes the pair honest in both directions.
- **The pill ran a timer on every task row.** Hooks cannot be skipped by an early return, so
  the interval was registered before the `return null` — 150 rows meant 150 timers ticking to
  re-render nothing. The comment and the paragraph above both claimed otherwise; splitting
  the decision (`hasAgentState`, clockless) from the clock (`AgentClock`) is what makes the
  claim true.

**Phase 2h — "put it back in the Braindump". SHIPPED.** Locked decision 3's first step, held
back until its semantics could be implemented properly rather than as a null write.

- **`applyProposal` expands a cleared date into the whole unschedule set**, exactly as the
  store's own verb does. `undefined`, not `null`: `updatesToRow` is presence-keyed, so a key
  present-and-undefined writes NULL while an absent key is left alone — dropping them would
  leave the database scheduled while the store showed the item in the Braindump.
- **Two refusals, both registry- or recurrence-derived.** A type that is not
  `braindumpEligible` cannot go there (that flag IS the question "can this item exist with no
  date"), and a RECURRING item cannot either — every day-scoped surface requires
  `startDate <= today` before recurrence is consulted, so a repeating series with no date
  lands on no day at all. The row's own unschedule control does not guard that; a suggestion
  the user accepts sight-unseen should not be how they discover it.
- **`timeBucket: null` stays stripped.** An item with a date and no bucket is precisely the
  unplaceable row above, and "clear the bucket" is not a request anyone makes — unscheduling
  is. `startTime: null` (keep the day, drop the clock) and `priority: null` are simple clears
  and are allowed.
- **The planner prompt now teaches the verb**, framed as what it is for: the kinder answer
  when something should not have a day yet, rather than shuffling it to a date nobody
  believes in. A capability the model is not told about is a capability nobody has.

*Adversarial review — three real, and the worst was a rule CLAUDE.md names by hand.*

- **A proposal could erase a goal milestone's target date.** `unscheduleTasks`,
  `moveTasksToDate` and `scheduleItemsAt` all subtract `milestoneItemIds` before touching a
  date; `applyProposal` is the same kind of verb and did not. `lib/goals.ts` states the rule
  outright — for a milestone `startDate` is the target date, not scheduling residue — and
  CLAUDE.md says to read that file before touching "anything that writes an item's
  `startDate` in bulk". The card would have given no warning either: `buildProposalContext`
  emits no goal membership, so "Ship the beta — move to Braindump" reads like any other row.
  `ProposalContext` now carries `milestoneIds` and both validation sites pass it — the card
  AND the write boundary, since an item can become a milestone between render and tap.
- **Two operations on one item re-created the unplaceable row.** The clear was expanded
  per-operation and then merged later-op-wins, so `[{startDate:null},{timeBucket:'afternoon'}]`
  left a bucket with no day: dropped by the grid (`!startDate`) AND by the Braindump
  (`isScheduled || timeBucket`). Invisible everywhere, and persisted. The expansion now runs
  on the MERGED patch, and the clear wins over a later reschedule — a plan saying both is
  incoherent, and only that reading leaves the item somewhere findable.
- **The prompt stated a rule the model could not follow.** "Not available for repeating
  items" was unobservable: `buildProposalContext` never emitted recurrence, so a recurring
  task was byte-identical to a one-shot — and the refusal that catches it is silent, because
  `validateProposal`'s `rejected[]` is dropped by the store. Recurrence is now in the
  context. **Closed 2026-08-26:** the card now says so — `refused` carries the count and the
  deduped reasons, and the empty card says "None of those would work here" rather than "no
  changes to suggest", which would be a lie about a reply that suggested plenty. Named
  `refused` rather than `dropped` because the user DROPS lines on the card and validation
  REFUSES operations before it — different actor, different meaning, and the two had already
  collided in one component.

Refuted: `'Accept plan:'` IS in `SIGNIFICANT_ACTIONS`, so accepting does raise an undo toast.
Also refuted, usefully: `updatesToRow` really is presence-keyed on all five cleared fields,
and `diffItem`'s `JSON.stringify` comparison does capture a value→undefined transition, so
undo round-trips for the right reason rather than by luck.

**Phase 2i — a run that dies without saying so. SHIPPED.**

Named as a known gap twice, and only solvable once `aiStatusAt` existed: a worker can die
mid-task (crash, reclaimed container, gateway switched off) and nothing cleans that up.

**Half of it turned out already to work**, which is worth recording because the gap was
being described wrongly. `working` is in `OPEN_AI_STATUSES`, so `dsul_my_work` never
stopped offering a stuck item; and `AgentSection`'s Unassign already cleared the state. What
was missing was narrower and more specific:

- **The worker had no way to tell a live run from a dead one.** `selectAssignedWork` omitted
  `aiStatusAt` — exactly the blindness the item row had before migration 041. It now travels,
  against the response's own `fetchedAt`, and `dsul_my_work` explains the reading: minutes
  old means leave it alone, hours old means that run died and you should finish it. A worker
  treating every `working` item as somebody else's leaves the user work they handed over and
  never got back; one treating every `working` item as abandoned double-runs whatever is
  genuinely in flight.
- **The user had no proportionate signal.** "Working 3h" looked like "Working 3m" apart from
  the digits. `agentStatusView` gains `stalled` past `AGENT_QUIET_AFTER_MS` (one hour,
  deliberately generous — a real research run takes many minutes, and calling a slow run dead
  invites re-queueing work that is still happening). The pill drops the spinner and takes the
  honey: a stopped run now wants something too.
- **Unassign was the only recovery, and it throws the delegation away.** "That run died, have
  another go" is the commoner want, so a stalled or failed item gets **Try again** —
  re-queues, keeps the assignee.

**Nothing automatic reads `stalled`, and that is the load-bearing part.** Nothing claims work
atomically, so a timer that re-queued a merely-slow run would put two workers on one task and
let the second overwrite the first's report. The user seeing "Gone quiet" is the evidence
that makes the manual button safe. An atomic claim is still the real fix and is still open.

`blocked` is never stalled however long it waits — it is waiting on the USER, exactly as
designed, and calling that a malfunction would blame them for it.

*Adversarial review — it found the feature's PREMISE wrong, not its details.*

The claim was: "nothing automatic reads `stalled`, so the manual gate makes Try again safe."
That argument had three holes and the review found all of them.

- **The double run it claimed to prevent was not prevented, and the loser's write won.** The
  agent PATCH verified only that the row belonged to the caller's ACCOUNT — no assignee
  check, no precondition. So a slow-but-alive worker's late `done` landed on top of the
  replacement run's result: the user reads a report written against a premise they discarded,
  with the real result gone from the panel. Reporting `blocked` was worse — the item flips
  back from finished to "needs you", asking a question from the run they killed. Fixed
  properly rather than argued away: `dsul_report_progress` now goes to its own route
  carrying `lastSeenAt`, a **compare-and-set on `ai_status_at`**, and a stale report is
  refused with the current value so the worker can re-read. The button is now safe by
  construction rather than by being rare.
- **The MCP instruction told workers to steal live work.** `dsul_report_progress` instructs
  reports at START, FINISH and STUCK only — there is no heartbeat — so a HEALTHY two-hour job
  has a two-hour-old stamp *by construction*. The text I added said hours-old means dead,
  pick it up and finish it: an instruction to double-run every long job, issued to a runtime
  with no user in the loop, and the exact failure the UI half was carefully gated to avoid.
  It also named no threshold, so the model chose a different one each run, and
  `selectAssignedWork` returns items assigned to ANYONE, so it applied to other workers' items
  too. Rewritten: leave a `working` item alone; the stamp is not a heartbeat; only past
  `QUIET_HOURS` **and** assigned to you may you take it, and then only by reporting `working`
  first and continuing if that call succeeds. `dsul_report_progress` now asks for periodic
  reports, which is what makes the stamp mean anything at all.
- **The surface offering the button never showed the evidence the argument rested on.**
  `AgentSection` printed the raw `WORKING` badge and then a Try again from nowhere — and
  `/item/[id]` has no row pill, so a deep link showed "WORKING" beside "Try again" with no
  hint anything was wrong. It now renders the view's label and its explanation.
- **On a `queued` item Try again was a placebo that hid the warning** — re-queueing something
  already queued only refreshes the stamp. `recoverable` (one definition, replacing the
  panel's private `stalled || failed`) excludes it: a queued item going quiet means nothing is
  picking work up at all, which no button on that item can fix.
- **The assistant tier offered delegation it cannot do.** Nothing consumes a `beacon`
  assignment, so the button queued work forever. Now gated on the registry's `canDelegate` —
  whose own header says a delegate button that silently does nothing is worse than no button.
- The panel's clock ticked every ten minutes against the row's sixty seconds, so the same
  item disagreed with itself for up to ten minutes. Both are a minute now.

Known and not fixed: the browser stamps `aiStatusAt` optimistically, so a badly wrong client
clock persists a wrong stamp. The compare-and-set makes the consequence a refused write rather
than a lost result, which is the right failure.

### Wiring it up (gateway side)

dsul's half is done; the agent needs a schedule. Roughly:

```bash
openclaw cron add dsul-work \
  --schedule '*/10 * * * *' \
  --prompt 'Call dsul_my_work. For each queued item: mark it working, do it, then report
            done with what you found, or blocked with the question you need answered.
            If dsul_my_work returns nothing, stop.'
```

Check `openclaw cron` for the exact flags — the shape above is from the automation docs,
not from a run. **Unverified:** that a cron turn can carry MCP tools. Test with a throwaway
job before relying on it.

**Phase 2c — what delegation still lacks.** It is the largest
surface in the plan (a thread table, delegation storage, agent + browser routes, plugin
tools, hooks kickoff, four UI surfaces) and it is **100% unverifiable without a migration
applied, a reachable gateway, and a hooks token with allowlisted prefixes**. It also
carries the only change that can brick the plugin's entire cached context (any addition to
the context response, which `openclaw-plugin/src/cache.ts` `safeParse`s and throws on).
Writing it blind, overnight, on top of a transport that has never spoken to a real gateway
would produce a large diff nobody can trust. It starts once Phase 1 is confirmed working.

Known gaps, none of them blocking a first run:

- **Nothing un-sticks a `working` item.** If a run dies mid-task the item stays `working`
  forever and later runs skip it. A staleness rule ("working for >N hours → back to
  queued") is the fix, and it wants a real run's timings before being guessed at.
- **Two overlapping runs could both claim the same item.** Claiming is read-then-write with
  nothing atomic behind it. On a personal planner with a ten-minute schedule this is
  unlikely and cheap when it happens; a conditional update is the fix if it ever bites.
- **Only plain tasks can be delegated**, gated by the `agentAssignable` registry capability.
  Custom types are excluded until the agent API can address them — see the amendment to
  decision 5. Habits are excluded permanently, and for a better reason.
- **Item threads are saved to the account (step 2a, migration 057), and the agent still
  cannot read them.** This is deliberate. Conversations are kept out of `/api/agent/context`
  and MCP: the context's projections are a frozen contract, transcripts are the most
  sensitive thing dsul holds, and an agent reading your chats is a product decision of its
  own. The "own review" this gap asked for was step 2a's design review.

**Step 2a — "Move and save". BUILT** (2026-10-02; the AI vision's step 2a, not Phase 2a
above). The chat leaves the left dock and becomes the right rail's Ask, and every
conversation is saved to the account.

*What shipped.*
- The right rail and the stack: Ask home (greeting, today's load, Needs you, With AI
  activity, two chips and the box), with an item, History and a conversation each pushed
  over it, and "‹" back down. One stack per surface with a level rule (history <
  conversation < item), in `lib/rail-store.ts`; `railMode()` is the one visibility rule.
- The item stays in ui-store's `edit-item` slot; only the Ask stack is new state. With no AI
  the right column is exactly the old item panel, Done included.
- **Ask starts closed.** It opens from the Ask button (`components/ai/rail/ask-opener.tsx`,
  the last thing on the canvas's header row, shown only while the right column is empty; a
  pointer's click on it holds Ask's header, and the button's own spot, against the pointer
  for 500ms, rail-store `holdRailHeader`, since that header opens where the button was and in
  Console the braindump slides under it as the column eases in, so a double-click's second
  click would land on History, "+", ✕ or the braindump), Ctrl+J (⌘J: the frozen `toggle_right_sidebar` id
  re-defaulted) and `?` in the dock (or "Ask AI" in ⌘K). Every one of those writes
  sidebar-store's persisted `askOpen`, and Ctrl+J or the rail's ✕ clear it, so Ask stays as
  the user left it across reloads; the tour's summon is the one open that persists nothing.
  Someone who has never chosen has `askOpen: null`, read (`askOpenOf`) as `ASK_OPEN_DEFAULT`
  (`false`, Kirby's call on 2026-10-02, over the design's "rests open"). The default is
  applied when read and never stored, so flipping that one constant makes Ask start open
  instead for every browser whose user has not chosen, including ones that have already run
  the build. Below 1180px (`PANEL_OVERLAY_QUERY`) it is an opaque overlay that shows
  only when summoned in this session, and parks on click-away or Escape.
- **The Ask button is a lit key, and the AI has a mark** (2026-10-03, the design study's
  "Capsule Twin" with the Aurora Key's rim light, carrying mark A, "Aurora step"): a raised
  key reading "Ask" with the chord printed beside it, whose rim is lit in the accent from the
  mark's lit tile and steps through the look's aurora partner (CSS in app/globals.css,
  "Ask's key"; the measured fit steps down full, key, icon, none: where the chord does not
  fit, the same key reads "Ask" on its plate without it, as the design study's narrow step
  did (Week x Schedule at 1280px in Classic); where that does not fit either, the 32px key
  alone; then nothing. Each step is a width read off what the button draws, and the title
  keeps the chord in every form). The mark is one component, `components/ai/ask-mark.tsx`,
  drawn in the key and before "Ask" on Ask home's header, so swapping it is a change to that
  one file. Since 2026-10-04 it is the AI's mark everywhere: every Lucide `Sparkles` that
  stood for the AI (the Ask rows in ⌘K and the right-click menu, a proposal, a general
  conversation in History, a new chat's greeting, the agent block, the AI settings pane, the
  AI notices, the phone's Ask glyph) renders it instead. Where the sparkle was honey the mark
  wears its own colours; where it took its row's ink (a muted list, a red failure notice,
  the colourless mode card) it takes that ink too (`tone="ink"`, or `AskMarkIcon` where a
  slot types its icon as a Lucide one). `Sparkles` survives only in the glyphs users pick
  for their own containers (lib/category-icons.ts), and a test holds it there.
- **The braindump narrows while the right column is docked**, for Ask and an item alike
  (every layout but Console, whose braindump is the fixed 300px pane): `renderedSidebarWidth` takes the column's 432px reserve off the braindump's ceiling so the
  canvas keeps `SIDEBAR_MIN_CANVAS`, and never writes the narrowed width back, so the
  braindump returns to the user's own width when the column closes.
- Saved conversations, written by the client once per finished turn through
  `/api/ai/conversations/**` (session cookie, RLS, SECURITY INVOKER RPCs, no service role).
- `/api/chat` stays stateless.
- One gateway session per conversation (`dsul:u:<uid>:chat:<id>`); the plugin path uses
  `dsul-chat-<id>`.
- `chooseChatTarget()` no longer deletes anything.
- On the phone the Ask tab is the same home, on its own stack: an item opened from it pushes
  over Ask (ui-store's `setEditItemInterceptor`, installed by rail-store's `hostPhoneAsk()`
  while the tab is mounted), while Today and Braindump keep the drawer. Arriving on the tab
  puts the caret in the dock's box only at a conversation or an item; an explicit open asks
  for it at any view, except catch-up ("Pick things back up"), which lands on a card to tap
  and asks for none, so no keyboard comes up over it (`revealChat(…, { boxOnPhone: false })`).
- End to end: `tests/e2e/rail.spec.ts` (desktop, Notepad's three styles included) and
  `tests/e2e/ask-mobile.spec.ts` (`@mobile`) run against the local stack only, with the gate
  and `/api/chat` stubbed in the browser (`tests/e2e/helpers/ai.ts`) and the conversations
  routes real; every conversation a spec saves carries a `testTitle` and is swept.

*Privacy: what is stored, and what is not.*
- *Stored, verbatim, until you delete it:*
  - what you type in Ask and in an item's conversation (up to 8,000 characters a message,
    the same cut the model is sent);
  - what the AI answered, including a partial answer you stopped (up to 40,000
    characters);
  - which answerer answered, and the model's id when it was your model (none for
    OpenClaw);
  - whether OpenClaw ever answered in a conversation;
  - when each message was sent, and when a conversation was started and last used;
  - a conversation's title, star, renamed flag, message count and four change counters;
  - the id of the item a conversation is about;
  - an item's conversation is titled with the item's title at the time, and deleting the
    item (even its 30-day purge) deletes neither the conversation nor that title; only
    Delete on the conversation does.
- *Not stored:*
  - the planner context sent with each message;
  - your custom instructions;
  - proposal cards;
  - error text (only a short error code);
  - your model key (which never leaves the server's sealed store, as before);
  - "Write with AI" in Settings → Make (mods build orders 7 and 10): neither the ask nor the reply.
    Only what you install is saved, switched off, as anything made in Make is. The model is sent the
    ask and the names of your projects, types, themes and Looks (for a mod, only types, themes and
    Looks; project names are not even read), never your items, notes or conversations. A mod it
    writes has no AI of its own.
- *Who can read it:*
  - you, on any device you sign in on;
  - the database's operators.

  It is protected by row-level security and TLS, and is **not end-to-end encrypted**.
- *Delete* removes a conversation and its messages from the database at once. Database
  backups age it out on the provider's backup schedule. Deleting the account deletes them at
  once, with everything else (memory/plans/account-deletion.md).
- *OpenClaw* keeps its own session memory, and dsul cannot delete that. Continuing a
  conversation with OpenClaw sends its last few turns to OpenClaw (at most 12, as context),
  so a conversation another answerer started becomes part of that memory too. A message
  sent to OpenClaw stays in that session even when no reply was kept (one stopped before
  it began), and so does the excerpt of a conversation a plan is asked from while an
  OpenClaw gateway makes the plans. The delete confirm's "OpenClaw may keep its own copy"
  counts both when they happened in this browser; across devices it knows only of a saved
  OpenClaw reply (`openclaw_seen`, which a turn with no reply never sets).
- *Disconnecting* a model or OpenClaw deletes no conversation (the model's disconnect
  confirm says so, and so does Unpair's; clearing the Gateway URL deletes none either).
  *Changing who answers* deletes nothing either.
- *History, and deleting from it,* is reachable only while a model or OpenClaw can answer.
  To delete conversations after disconnecting, reconnect first.
- *Device-local, as before:* who answers in chat and your custom instructions.

**Phase 3 — seams, not speculation.** Explicitly *not* building hosted-tier
infrastructure: it would sit on an unvalidated Phase 1. Phase 3 is this document, the
capability-registry seam that lets a hosted tier slot in as one config row, and an honest
statement of what a hosted tier actually needs before it is a product: server-held provider
keys with per-user cost accounting and rate limits, a dsul-operated agent runtime
(nobody else's gateway to lean on), abuse controls, and a support answer for "the agent did
something I didn't want". That is a business, not a sprint — the market read is that it is
also the only path off the power-user tier.

## Market context (2026-07, research summary)

Worth recording because it shapes priority, not just morale.

- **The composite is unoccupied.** Nobody ships personal day/week planner + habits +
  braindump + agent-as-assignee reporting on the item.
- **ADHD planners stop at breakdown/chat.** Tiimo (Apple's iPhone App of the Year, Dec
  2025; ~500k users / ~50k paid on ~€4.3M raised) does AI breakdown and a copilot, no
  agents. Structured is deliberately AI-minimal. Goblin Tools is free and beloved.
- **Agent products are chat-first.** ChatGPT Agent, Claude Cowork, Gemini Agent, Copilot
  background Tasks all execute, but work lives in transcripts — invisible and unauditable.
  That legibility gap is exactly what an item thread fixes.
- **"Agent as assignee" is proven, but only in B2B**: Linear's Agent API, Asana AI
  Teammates, Notion external agents. Motion is the one task-UI-plus-execution product and
  it went B2B at $49–599/mo, now drawing complaints that agents do irrelevant things.
- **Threats:** Google's unreleased "Remy" has ongoing/background-task sections; execution
  is commoditizing fast.
- **Therefore the moat is not execution.** It is the planning surface, the trust/legibility
  layer, and the neurodivergent design language. The Tiimo/Sunsama/Structured segment is
  evidence that for this audience, UI opinion beats raw capability.
- **Self-hosted does not convert to mainstream.** No consumer SaaS has converted the
  OpenClaw crowd (~380k stars). BYO-gateway is the evangelist/power tier and the personal
  daily driver; a mainstream product would need the hosted tier.

## Verification gates

- `pnpm lint`, `pnpm test`, `pnpm build` green at every commit.
- The app behaves **exactly as before** when the new migration is unapplied and no gateway
  is configured. Feature-detect; fail soft; never hard-500 an existing screen.
- Nothing may make the plugin's `safeParse` of `/api/agent/context` throw — one bad item
  bricks the entire cached context.
- No path may leak the gateway token into a client component or the browser bundle.

## Open questions for the user

Tracked in [ai-vision-decisions.md](ai-vision-decisions.md) — resolved answers get folded
back into the locked decisions above.
