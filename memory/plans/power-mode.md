# Power mode: Do stuff, rebuilt

Kirby's ask (2026-10-10): make Do stuff the app's killer feature. One button,
and things get done, scheduled or handed off. Designed over four rounds of
mockups in a project thread, 2026-10-10 to 2026-10-12. The last round is the
reference: https://claude.ai/artifact/SqoYpgGefDTEvuByBKZdua (private to Kirby).

## What was decided

- **Concepts 1 and 2 merge and replace Do stuff.** "Clear the deck" sorts the
  braindump into one plan in lanes (done for you, do now, on the calendar,
  handed off, left alone) with one "make it so"; "Ready to go" attaches a prep
  pack to what the AI can get ready (an email draft, a call script and number,
  the subscriptions it found, a research summary, a booking link). The AI
  prepares; the user taps whatever leaves the app. Nothing leaves without a tap.
- **One mode, two places.** The plan shows in the braindump; the run shows as a
  strip on today.
- **The "needs you" inbox from concept 4**, fed by agents' questions
  (`dsul_ask_user`), with assignees beyond OpenClaw (Claude via MCP).
- **Concept 5 ("while you were away") is its own extension**, the secretary,
  designed in another thread.
- **No size dots at rest.**

## The pieces, as picked

- **Trigger: a keycap.** "⚡ do stuff ⌘↵" in the braindump's header, a small key
  with a 3px skirt that sinks when pressed, the chord printed inside it,
  vertically centred. Half lit at rest the way Ask's key is (the bolt is the
  light: lime over its corner, stepping down to the hairline before the word),
  lit all round on hover. Kirby is undecided between lit and plain white at
  rest, and wants to judge lit in the real app first. **Ask becomes the
  matching keycap** (its chord moves onto the key).
- **Start animation: Shuffle.** The rows shuffle into their lanes.
- **Moving between lanes:** a lane chip on each row plus number keys 1 to 5;
  swipe on the phone; "just say it" with AI.
- **Prep packs: peek cards on desktop** (a roomy, editable card beside the row,
  opened by click, ↑ ↓ between packs, the primary action carrying its key);
  **on the phone**, inline for one and a swipe review deck for many.
- **Needs you:** a header badge (the askers' avatars, "3 to answer") opening an
  inbox of ClawBoy-style option cards (the same card chat already draws,
  lib/chat-options.ts): a header with who asked and about which item, the
  question, lettered choices, a pencil row for your own words, Clear and
  Submit; once answered it folds to the answer with Undo. One card per asker
  (multi-question agents page "1 of 2" inside theirs). A short version of the
  card sits in the item's block on the grid.

## Build order

1. The two keycaps (this doc lands with it).
2. Plan in lanes, replacing Do stuff mode: lanes, lane chip and 1 to 5, swipe,
   Shuffle, no size dots at rest.
3. Prep packs: storage (a migration), the peek card, the phone's inline pack
   and deck.
4. Needs you: questions through MCP into the card inbox, the header badge, the
   card in the block.
5. Assignees beyond OpenClaw in the handed-off lane.

### What build order 2 shipped

Rules first, no AI (Kirby's decision card, 2026-10-12): lib/do-stuff-plan.ts
sorts each row by the size the user gave it or its title's guess. Quick goes
to "do now"; errands and big to "on the calendar"; fuzzy to "handed off" when
`canHandOff` says the agent would take it, else "left alone"; habits, what the
rules cannot read, and anything else are left alone. "Done for you" keeps key
1 but is offered nothing until packs exist, so the other keys never renumber.
Moves are memory only. "Make it so" (in the strip above the list) puts the
calendar lane on days, errands together on tomorrow and everything else a day
each from tomorrow, one undo per day, and hands the handed-off lane to the
agent; "do now" and "left alone" write nothing. The size menu on rows is gone:
sizes still sort, but nothing shows at rest.

### What build order 3 shipped

Drafts first (Kirby's decision card, 2026-10-12): the model works from title
and notes alone, so the kinds are an email or message draft, a call script
(a number only if the item gave one), and first steps; no research, no found
subscriptions, no booking links until web search exists. Migration 074
(`prep_packs`, one row per item, owner RLS, cap 200) holds them;
/api/ai/prep reads, writes (the user's own model, `canPrep`, never OpenClaw)
and deletes them. Do stuff asks when it starts, at most eight open rows, each
once a session. A row with a pack for its current title lands in "done for
you" with a "draft ready" chip that opens the peek card (desktop) or the card
in place (phone); the card's fields are editable but never saved, and its
primary action opens mail or the dialler, or copies. On the phone, with two
or more ready, "review N" on the lane deals them in a sheet: swipe right (or
tap) to take one out, swipe left for the next.

Gaps found while designing, not yet scheduled: no free-slot finder on the grid
(for "on the calendar"), no web search for the model (for research packs).

**Packs never saved until 2026-10-17.** The route upserted, and PostgREST's upsert assigns
every payload column in its ON CONFLICT DO UPDATE, `item_id` and `updated_at` among them; 074
grants `authenticated` INSERT on five named columns and UPDATE on four plus `updated_at`, and
Postgres checks the whole statement up front, so every save was refused (42501), the client
showed "Couldn't get things ready.", and no pack ever reached the table from the app. The route
now inserts with ON CONFLICT DO NOTHING (supabase-js's `upsert` + `ignoreDuplicates`; new items,
which is what the 200 cap counts) and
updates the four columns of each item the insert skipped. Not delete-then-insert: the cap
trigger spares only an item whose pack still exists, so a mixed batch at the cap would have
lost the regenerated packs. No migration.

### What build order 4 shipped

The questions already reached dsul (`dsul_ask_user` blocks the item and logs
an `agent_question` event with its options; lib/agent-question.ts reads them
back), so this is the surfaces. The canvas header shows a badge while any
agent waits on the user: the askers' avatars (their initial) and "N to
answer". It opens an inbox with one options card per asker
(components/ai/needs-you/): who asked and about which item, the question,
lettered choices (A to H on the keyboard), a pencil row for the user's own
words, Clear and Submit, and "1 of 2" paging for an asker with several. A
submitted answer folds to one line with Undo and goes to the agent after six
seconds, or when the page hides (lib/needs-you-store.ts); until then the item
is still `blocked`, and Ask home's list leaves it out. A grid block tall
enough for a third line shows "◐ OpenClaw: the question", and its first three
choices given two more; a choice answers with the same Undo, and the question
opens the inbox on that item (the item itself on the phone, which has no
badge). Ask home's own Needs-you cards are unchanged.

### What build order 5 shipped

An app connected over MCP (Claude, Cursor) or a named agent key is an agent
too once it may change the planner (lib/agent-assignees.ts). Its assignee is
its name as the user knows it ("Claude"), compared without case, so it
survives reconnecting and two Claude apps share one queue; names that already
mean something (openclaw, beacon, ai) are never an app's. `dsul_my_work` now
serves each caller its own queue (app/api/mcp/route.ts): the OpenClaw key gets
`openclaw` and the legacy `beacon`, an app or key gets items under its own
name, so nothing handed to Claude is picked up by OpenClaw. `/api/ai/agents`
lists who can take work (planner-scope apps and keys, by name). Do stuff's
handed-off lane is offered when anyone can, and its header says "to OpenClaw"
or opens a menu of everyone; "make it so" hands the lane to the pick, which is
remembered for the session. Apps find the item the next time they read their
queue, unless they have a wake (below). The right-click menu offers a "Hand off
to …" row per agent (2026-10-14).

### Waking an app (2026-10-14)

Kirby asked whether a hand-off to Claude could start it at once, as OpenClaw's
does. MCP cannot: the app always calls dsul, and only while a chat is open. A
Claude Code routine can be started over HTTP (a POST to its own /fire URL with
its own bearer token, https://code.claude.com/docs/en/routines), so a connected
Claude offers "Wake Claude when I hand it work" in Settings → AI → Connected apps
(components/settings/app-wake.tsx): make a routine with the dsul connector and
the instructions shown there, add an API trigger, paste its URL and token.
Saving fires it once as a test; a refused fire saves nothing. The pair lives in
`user_secrets.agent_wakes` (migration 075, service role only, never read back),
keyed by the app's folded name; only a routine URL on api.anthropic.com is
accepted, since dsul's server makes the call (lib/agent-wake.ts).

A hand-off to an app (any surface: every assignment leaves through
planner-store's `dbUpdateItem`) is gathered in the browser for 800ms, so make it
so's burst is one call to `/api/agent/app-wake`, which reads the items as the
user, groups the ones still queued by app, and fires each app's routine once
(at most once a minute per app; a routine allows 30 runs an hour). The fire
text names item ids only. `/api/ai/agents` marks an app with a wake, and Do
stuff's picker says "when opened" beside an app without one.

No other MCP app known on 2026-10-14 can be started from outside. A generic
"call this URL on hand-off" (any webhook, signed like OpenClaw's) would cover
self-built agents, n8n and Zapier; it is left until someone asks, since the
server would then call any address a user types.

## Round 5 (Kirby's picks, 2026-10-13)

Mocks: https://claude.ai/artifact/U4NbXhEeMHroAZd6KvMLYS (v5). Built in four PRs:

1. **The dock carries the key** (this section's first PR). Once the braindump wants the key
   (`wantsDoStuffRow`, published as `available`), the sidebar dock swaps the capture bar for
   the do stuff key, wide, and a small ⌘K launcher key with its chord, both keycaps with the
   aurora arc at rest and the whole rim lit on hover. The dock's RelayField stays, and ripples
   out from the key on every start (`starts`). Never while the bar is focused, never in a
   bottom-dock or page-foot layout, never on the phone (those keep the header key and strip).
   ⌘I, which focused the bar, opens the launcher in add mode while the keys are docked.
   While doing stuff the same place is **make it so**: a plain keycap (no light in the rim),
   the same chord, its plan in a tooltip, ✕ beside it to stop without writing, "finish" when
   nothing would move. The column opens, then the rows glide into their lanes together, then
   the lane labels rise into the gaps and their rules draw (`useSort`: sort, then label, Kirby's
   pick 2026-10-14 over the first ripple, whose labels landed before the rows moved). The column opens to
   two fifths of the window, at most 640px (`doStuffSidebarWidth`, ≥1180px; half until
   2026-10-23, never narrower, never below the canvas
   floor, never written back). No "doing stuff" strip while docked.
2. Ask reads "ask stuff", its light and mark violet into sky.
3. Seven lanes: ready / do it now ("yes u can", max 3) / today / another day / do it for me /
   later / whatever. Keys 1 to 7; the lane keys predate the words (`done` is ready, `calendar`
   another day, `handoff` do it for me, `leave` later, `archive` whatever). Past three open rows,
   do it now spills onto today, the rule's picks before the user's moves (`capNow`). Today lands
   today at make it so. **Whatever** is never suggested by the rules and never reached by a
   swipe (7 or the chip only); make it so lets it go: `letGoItems` marks the task `cancelled`
   (one undo, "Let go:" raises the toast), and the braindump drops cancelled tasks
   (lib/braindump-members.ts). dsul has no archive view yet; cancelled was the closest state
   with no new table, and the agent API already wrote it.
4. One do stuff over the braindump plus today's open one-shot tasks at no fixed time (a row
   with a start time stays out). They join the plan after the braindump's, wear a "today" tag,
   and the rules keep them on today (quick ones go to do it now). Their lane says where they go
   from today: another day moves them, later sends them back to the braindump
   (`unscheduleTasks`), whatever lets go, do it for me hands off; do it now and today write
   nothing. The plan publishes `marks`, and a today row in the grid draws its lane dot and
   "→ Thu" / "→ later" (components/sidebar/do-stuff-mark.tsx, in TaskRow). Do it now's next
   and the braindump rows coming onto today show in the canvas header as the up-next card and
   ghost "+" chips (components/sidebar/do-stuff-today.tsx), in the header row rather than on
   the grid, because nothing between the header and the timeline may change height.
5. First steps (components/sidebar/first-steps.tsx): a dialog over one item, its own
   memory-only slot (`firstSteps` in the do stuff store), mounted once in AppShell. Screen 1
   asks "Anything I should know first?" (optional); the answer rides along with Break it
   down's own request (proposal-store, `item:<id>`, the same surface the item panel's card
   uses). Screen 2 lists the create ops, step 1 lit in lime; "Start step 1" saves them as
   subtasks (one undo) and opens the item, "save as subtasks" just saves. "do it for me" hands
   the whole item to the do it for me pick on both screens, and each step's "hand off" saves
   the steps and hands that one subtask off. Opened by F (the hovered or focused row while
   doing stuff), "first steps" on both up-next cards, and "First steps" in the item menu's AI
   row while do stuff is on; everywhere only where Break it down is offered (`canBreakDown`),
   so it never shows without AI.

## The polish round (Kirby's picks, 2026-10-16)

Mocks in four rounds (the thread "Power mode polish"). Kirby turned down the floating
player (disconnected from the sidebar and from the day) and picked:

- **In the day.** While doing stuff, the current item opens inside today's schedule, in
  the free stretch between now and the next thing on the clock; its row in the list keeps
  a lime notch. The walk is do it now, then today's anytime rows.
- **Desk.** A room: the item on the left (notes, steps, a jot box), the real day column on
  the right, and chat about the task with the person's model, Claude or OpenClaw (the
  item's own conversation and the agent exchange, never a second chat).
- **Sprint**, an add-on: a ring sized to the gap before the next block.
- **Pocket**: an always-on-top mini window in the desktop app.
- **L1**, later: do it now open, the other lanes folded to one-line peeks.
- Still to come for the walk: a heads-up before a block, a missed block offered once with
  no guilt.

Build order: PR1 In the day (with the start and done motion fixes), PR2 Desk with chat,
PR3 Sprint, PR4 Pocket, PR5 L1.

### What PR1 shipped

- `lib/do-stuff-walk.ts`: `freeStretch(blocks, nowMin)` (a block on now pushes the start to
  its end, chained through back-to-back blocks; done blocks give their time back) and the
  slot's heading.
- `components/sidebar/do-stuff-slot.tsx`, drawn in DaySchedule's events field on today,
  never while dragging or resizing. It publishes the store's `slot`; while it is up, the
  header's up-next card stands down (the arriving chips stay) and the list's card is a
  row with a lime notch and no actions (its keys still work). With no free time left on
  the grid it is not drawn, and the card comes back.
- The walk falls back to the today lane once do it now is through.
- A done row leaves the walked lanes (now, today) for a "N done here" count under the
  lane. A struck row that stayed put was what slid through the others.
- Motion: the current item arrives after the sort (`SORT_SETTLE_MS`, `sortDelay()`): the
  list card's chrome, notch and actions, and the slot. On done the slot and the card stay
  still and the next item's content rises in place; the other rows, labels and counts
  glide to where they now stand (`useReflow`, measured every commit).

### What PR2 shipped (the Desk)

- `components/sidebar/do-stuff-desk.tsx`, mounted by the view router in place of the canvas's
  view while doing stuff with the store's `desk` set (memory only; `stop()` clears it). Opened
  from the slot's ⤢, the list card's "desk" (D), closed by Esc or "back to the day".
  `openDesk()` brings the canvas to today first: the desk is always today, as Zen is.
- Left: a kicker (lane · the free stretch · done count), the title with its lime notch, the
  notes, the steps (subtasks, read from `items` since `tasks` leaves them out, ticked through
  `toggleRowDone` on today), a jot box (↵ appends a line to the notes, one undo each), done /
  skip / first steps (↵ S F while nothing is being typed), and `ItemConversation` inline: the
  item's own conversation, with whoever answers (the model or OpenClaw), the agent's side
  when handed off, and nothing when nobody can answer.
- Right: the real `DaySchedule`, its slot showing the time and title only (the desk has the
  actions). It follows the walk: done or skip and the next item rises in.
- Polish (2026-10-17, after a code audit): the desk has one host, the desktop `ViewRouter`
  (`useDeskHost`, a count like the console's), so on the phone, whose router never mounts it,
  `openDesk()` is a no-op and the ⤢ and "desk" keys are not drawn; the last host leaving
  closes it. While it is open the braindump is the user's own width again
  (`doStuffSidebarWidth(…, desk)`), the day column is `minmax(320px,38%)` with the phone's
  gutter (`data-dense`), the header's up-next card stands down, the list card's D reads "back
  to the day" and toggles, and leaving today closes it. The jot writes on ↵ only (blur keeps
  the draft, Esc clears it) and grows from two lines to six. The kicker row is always drawn,
  the sprint ring at its start and the exit at its end, and T puts the item on today.

### What PR3 shipped (Sprint)

- `sprintFor(stretch, nowMin)` in `lib/do-stuff-walk.ts`: a sprint runs to 5 minutes before
  the next block (`SPRINT_LEAD_MIN`), or an open 25 with nothing after it, offered only while
  the stretch is free now and at least 10 minutes long.
- `components/sidebar/sprint-ring.tsx`: "sprint till Lunch with Ana" in the slot and the
  desk, then a lime ring that fills with the minutes left (in the slot's heading, and large
  on the desk). Time up says so ("time's up · Lunch with Ana next") and waits for a tap: no
  sound, no red. Store `sprint` (epoch ms, memory only); a tap or `stop()` ends it.
- The desk's day column is its own `canvas` container and turns Radix's table layout into a
  block, so its rows size to the column instead of overflowing it.

### What PR4 shipped (Pocket)

- In the desktop app, a pocket button (picture-in-picture icon) on the list's card, the slot
  and the desk opens a 320×104 window that floats over every app (`alwaysOnTop` 'floating',
  every Space on macOS) with the current item, done, skip, open dsul and ×. It shows without
  taking the focus, opens in the top-right corner of the primary display, and comes back where
  it was dragged to while the app runs. A running sprint shows its minutes left and a lime bar.
- The pocket is the shell's own page (`electron/pocket.html` + `pocket-preload.cjs`, a data:
  URL like the find bar), never do.dsul.app: it has no session and writes nothing. The page
  publishes `{ id, title, done, sprint }` through `setPocket` (`PocketSync`, mounted by
  `DesktopBridge`), main keeps only those fields (`electron/lib/pocket.cjs shapePocket`), and
  done/skip come back to the page with the id they were pressed on; the page acts only if that
  is still its current item. Stopping the mode, a reload or a crash closes it.
- Bridge members `setPocket`, `openPocket`, `onPocketAction` are optional (`desktopPocket` in
  lib/desktop.ts), so it reaches people only with the next shell release; until then the
  button never renders. No global chord yet: the pocket opens from the app.

### What PR5 shipped (L1, the calmer list)

- While doing stuff, only the lane being walked is open (do it now, or today once the walk has
  moved there). Every other lane folds to one line: its name, its count, the first three
  titles, and "N done" where rows were done there. A click unfolds a lane for the rest of the
  run (memory only), and a chevron in its header folds it again; the walked lane has none.
- A folded lane keeps its header action in reach: "to OpenClaw" on do it for me, and "review
  N" on the phone's ready lane. Its rule is still drawn, so the start's sort lands as before.
- `LanePeek` in components/sidebar/do-stuff.tsx; the lane tests unfold every lane before
  reading rows (`unfold()` in do-stuff-lanes and do-stuff-today tests).

### What PR6 shipped (walking the day: heads-up and a missed block)

- **Heads-up.** Within 5 minutes of a block (`HEADS_UP_MIN`, `headsUp()` in
  lib/do-stuff-walk.ts) the slot says "Standup in 3m". By then the stretch is a sliver and the
  slot is one line, so it sits beside the title; on a roomy slot it replaces the heading with
  "… · wrap up here". It asks nothing and makes no sound.
- **A missed block, offered once.** A one-off timed task that ended undone within the last 3
  hours (`missedBlock()`, `MISSED_WINDOW_MIN`) takes the slot's heading: "missed Call the
  bank? fit it in · let it go". Fit it in moves it to now (or after the block running now),
  keeping its length, in one undo labelled "Fit it in"; let it go writes nothing. Either way
  it is never asked about again this session (store `missedSeen`, memory only, kept across
  runs). Habits, series and project blocks are never offered (`WalkBlock.movable`): their
  time is every day's.

#### Fixes (2026-10-17, after a code audit)

- A sprint stays in view to its end: the one-line slot draws the small ring and its label
  beside the title (a sprint ends five minutes before the block, exactly when the stretch is
  a sliver), "time's up · Lunch next" included.
- A sprint that has ended clears itself once the block it ran to has started (five minutes
  after time is up; an open 25 gets the same), and done or skip on the item it was started
  for ends it. Until then it still says time's up and waits for a tap. The ring's and the
  pocket's second clocks stop at 0.
- Fit it in fits: the block is shortened to the gap before the next block or midnight
  (`fitIn`, never below ten minutes; under that the offer is "let it go" alone), and the
  write asks the shared reschedule gate first.
- One missed-block offer a run: answering it marks every block missed right now seen.
- The header's up-next card arrives after the sort, as the slot and the list card do
  (`useSortArrival`).
- The heads-up says "wrap up here" only when the stretch is free now; after a block that is
  on it just names what is coming.
- "N done" counts whatever got done in the walked lanes while the mode is on, from the
  planner store's own changes (the card, the slot, the desk, the pocket, a row's checkbox,
  the grid), and a today row ticked on the walk stays on the list for "N done here".


## AI work badges (Kirby's picks, 2026-10-20)

Ask's morning and last-night cards go; the AI's work shows on the rows it is
about, everywhere (braindump, today's lists, schedule blocks), not only while
doing stuff. Mockups: https://claude.ai/artifact/5ruP7iqrFH3s7vLRLcdso4.

- **Working = C + D:** the relay in one row (six tiles, a glowing wave) beside
  the title, and the title shimmering lime into teal. The title takes the sheen
  from the relay being its sibling (`[data-row-title='open']:has(~ [data-ai-relay])`),
  so a row only renders the mark. A run gone quiet or failed keeps the plain
  agent chip: the relay never claims work nobody is doing.
- **Ready = aurora fill:** a still word chip ("draft ready"); a question is the
  same chip warm, honey into coral, naming who asks.
- **The do stuff key:** the relay in the bolt's place while anything is being
  worked on, and "N ready" while packs wait (lib/ai-work.ts, the same rules as
  the rows). Packs are read at sign-in, a GET that asks no model.
- **Built (PR 1, #543):** the marks (components/ai/ai-work-badge.tsx), the rows,
  the blocks, the pack chip and the key. **PR 2:** a pack's ready chip on any
  row outside the mode (a tap opens the item, it is not a button of its own),
  the pack in the item panel (PackInPanel, above the agent's block), Not needed
  with an undo (the delete waits UNDO_MS), and packs read at sign-in from the
  app shell (PrepPacksBoot). **PR 3:** background prep, below.

### Background prep (PR 3, Kirby's "all together", 2026-10-20)

- **Rules:** prep only, never sends, books, buys or deletes; each item once
  until its title or notes change; DAILY_CAP (20) asks a day per browser; off by
  default (`extensions.doStuff.background`, Do stuff's config key `background`);
  "Hand off to…" still gives the whole job, and is offered again on an item
  whose get-it-ready run is over. lib/background-prep.ts is the pure half,
  hooks/use-background-prep.ts runs it (mounted in PrepPacksBoot) on mount, on
  becoming visible and every 10 minutes, only while the page is visible.
- **Candidates:** open, one-off, top-level tasks nobody holds, not paused or
  switched off: today's first, then the braindump's.
- **Who does it** (`extensions.doStuff.worker`): the person's model (only while
  it answers here, `canPrep`, D14) writes packs; an agent is handed the item
  with `aiMode: 'prepare'` (migration 078, `items.ai_mode`). MCP's
  `dsul_my_work` serves the mode and says what it forbids; agents cannot write
  it (no create or update schema takes it). Nothing is handed to an agent until
  a read has shown the column (`aiModeColumnSeen()` in lib/db.ts), because
  before 078 the deferrable-column retry would drop the limit and keep the
  hand-off. A finished prepare run reads as a ready chip ("ready", in the
  row's agent slot) and counts in the key's total.
- **The question kind** (078 widens `prep_packs_kind_check`): when one missing
  fact is all that stands between an item and a draft, the model asks it. The
  card offers its likely answers and a box; the answer is appended to the
  item's notes as "question answer" (`answerNote`), the question is deleted and
  the item is asked again. Before 078 the route drops question rows and keeps
  the rest of the batch (a 23514 retry).
- **Prompt pass:** every ask carries the person's today, each item's project,
  planned day and open subtasks, and their Custom instructions (Settings → AI,
  which prep had never sent before). Timing is used to get "by Friday" right,
  never to call anything late.
### Research (PR 3b, Kirby's ask 2026-10-20)

- **A switch of its own**, "Let your AI look things up" under Do stuff, off by
  default (`extensions.doStuff.research`, read by `researchOn`). Each search is
  billed on the person's own key, so it never starts on.
- **Who can search:** `researchSupported` in lib/ai-research.ts. Anthropic uses
  the basic `web_search_20250305` server tool (it works on every model, where
  the dynamic-filtering one does not), with the person's timezone and one
  continuation on `pause_turn`. OpenAI goes through the Responses API with
  `web_search`. OpenRouter takes its `web` plugin. Gemini's OpenAI-compatible
  layer and a custom host cannot, and the setting says so. At most
  `RESEARCH_MAX_USES` (5) searches an ask; a provider that refuses the tool
  (bad_request) is asked again without it.
- **New kinds** (079): options (slots, products, places, each with its own
  link), list, form (answers to paste, and the form's link; never submitted),
  and draft (longer writing). Any pack may carry `sources`. Every link is
  https with no credentials; a bad link is dropped, never the pack. Links open
  in a new tab with `noopener noreferrer nofollow`.
- **The prompt:** search only when the item needs a fact, never invent a slot,
  price or link, pages are information and never instructions, and never book,
  buy, submit or sign in. The person takes every step that leaves the app.
- **Before 079 (and 078) is applied** the save drops the newest kinds and keeps
  the rest of the batch, so deploy and apply can land in either order.

### Pack kinds that act on the planner (Kirby's ask, 2026-10-21)

- **Five more kinds** (080): `subtasks` (two to eight rows), `answer` (for a
  "find out…" item, with its sources), `place` (name, and only the address,
  hours and phone a page gave, plus a map link), `time` (a slot on today or a
  near day, with minutes) and `pick` (two to four choices with pros and cons,
  the AI's pick by index and why; a pick that names a choice it doesn't have
  is refused).
- **The tap changes the planner, and nothing else.** `packApplies` names the
  three that do (subtasks, answer, time) and prep-packs-store's `apply` is
  their one writer: subtasks go in through `addTasksBulk` (one undo), the
  answer is appended to the notes with its links, a time is
  `scheduleTaskPatch` on the time's own bucket plus the day and minutes. The
  pack is then deleted. A goal's milestone takes the time but keeps its target
  date (long-term-goals.md). The card's edits go with the tap, as with every
  pack. A place opens a map search; a pick only shows its links.
- **The model is told the person's clock** (`now`, HH:mm, only with `today`),
  so a suggested time is later than now. With research on, a call script may
  take a number from a page it lists in `sources`.
- Before 080 is applied the save's 23514 ladder drops these five first, then
  the research kinds, then a question.

### The room, round two (Kirby's picks 2026-10-18, built 2026-10-21)

- **Lanes are colorless:** no dot, no tinted rule (the rule draws in
  `var(--border)`), and the grid's lane mark keeps only "→ Thu". A folded lane
  is its name and its count, with its action (who it goes to, review) or ›.
- **The desk's strip says one thing:** "1h 34m till Standup", or nothing while
  a sprint's ring runs. The lane and the done count live in the lanes. The exit
  is a ✕ (Esc).
- **The bar:** done ↵, skip S, today T and Pocket sit in a sticky bar at the
  foot of the room, with "next · <title>" (the store's `then`, published with
  `next`). First steps and the sprint stay under the jot box.
- **The pack is on the desk** (PackInPanel), between the steps and the jot box.
- **The day column hides Anytime** while walking (`DaySchedule hideAnytime`,
  shown again for a drag): those rows are the lanes' already.
- **The end of the walk is a receipt** (EndOfWalk): "N done · N moved · N let
  go", the first three done and "and N more", a line per move with where it
  goes, then make it so (↵, `finishRun`, which also ends the mode). With
  nothing done and nothing to move it still says the rest can wait.

## Five more (Kirby's "all five", 2026-10-21)

Learning how you write, unsticking what keeps being carried, braindump to
prepped items, a one-tap finish, and an energy-aware walk. One PR each, in
that order.

### How you write (PR 1)

- **What is kept is a note, never the edits.** lib/writing-style.ts holds the
  keys (`writingStyle`, `learnStyle` in Do stuff's config, so every device
  writes the same way) and `styleEdit`, which decides what counts: an email,
  message, draft or call script, both sides written, more changed than a typo.
- **Off until the person says yes.** Each lesson is a call on their own model.
  The first time a changed draft leaves a card (Copy, Open in mail, the swipe),
  a toast asks once; asking writes `learnStyle: false`, so it never asks again
  on any device, and Learn writes true and learns from that very edit.
- **/api/ai/style is stateless:** the note so far, what the AI wrote and what
  the person sent go to their model, which answers the whole note (style only,
  at most eight lines, 800 characters). lib/learn-style.ts is the one writer:
  one lesson out at a time, only the newest waits, and a lesson that lands
  after the switch went off is dropped.
- **Prep follows it:** the store sends `style`, and the route adds it after the
  built-in rules and before the person's own instructions, so a drafted email
  opens and signs off the way they do.
- **Settings → Do stuff** shows the switch and the note, to change or to clear.

### Unstick (PR 2)

- **Stuck means moved to another day on three different days** in the last 30
  (lib/stuck.ts, `STUCK_AT`). The moves come from the activity feed: update
  events whose payload set `startDate` (`fetchMoveEvents` in lib/db.ts reads
  only the id and the moment). Nothing new is stored; lib/stuck-store.ts keeps
  the counts in memory and reads the feed at most once an hour.
- **Nothing on screen says it.** No count, no badge, no "still". What changes is
  the ask: the item goes to prep with `stuck: true`, and the prompt makes it
  smaller rather than better (a first step under two minutes that needs no
  decision, or the one question in the way).
- **Background prep takes stuck items first, on any day,** and an item already
  asked about is asked once more when it becomes stuck (the ledger signature
  gains a stuck mark). Do stuff's own start marks the stuck lanes' items too.

### Braindump to done (PR 3)

- **A paragraph splits into things.** Pasting one into the omnibar or the
  braindump's quick add, with a model connected, opens the bulk-add dialog
  leading with "Sort it out with AI" (`split: true` on the seed;
  `isParagraphPaste` in lib/braindump-split.ts: 120+ characters, one line, more
  than one sentence or clause). The button is also there for any text in the
  dialog. Nothing is sent until it is pressed.
- **/api/ai/split is stateless:** the person's own model answers drafts (a
  title in their words, notes only with details from the text, at most 30),
  checked by `splitDrafts`. They land in the dialog's table, "Sorted by your
  AI. Check it, then add.", and Add is the one write (one ⌘Z).
- **Then they are got ready.** With Do stuff on and the model answering, the
  items the split added go straight to prep, like the braindump's.

### The one-tap finish (PR 4)

- **A message opens filled in.** A message pack to a number gets an `sms:` link
  ("Open in messages", `smsNumber`: 7 to 15 digits, never a name or an
  address); one to a name, or a draft, offers the share sheet where the device
  has one ("Share"), and Copy otherwise. Email already opened in mail, and a
  call with a number already dialled.
- **Coming back asks "Sent it?"** After a pack that sends (`packSends`: an
  email, a message, a call with a number) leaves through its primary, the card
  waits for the page to come back (or 1.5s on a desktop, where the mail app
  opens beside it) and toasts "Sent it?" with Done, which ticks the item off
  through `doneNext`. dsul still never sends anything itself.

### The energy-aware walk (PR 5)

> **Skipped for now (Kirby, 2026-10-23):** the ask was one more step before you could do
> anything, so `EnergyAsk` is gone. `energy` in the store and `energyOrder` stay; with energy
> unset the walk is the rules' own. Bring it back only somewhere that costs no step.

- **"energy? low · okay · high"** sits above the lanes as a run starts
  (`EnergyAsk`). It is optional: until it is answered the walk goes exactly as
  the rules lay it out. Once answered it is one quiet word ("high energy") that
  asks again on a click. Memory only, `energy` in the do stuff store, reset by
  every start: energy is today's, not a setting.
- **What it changes is the order.** `energyOrder` (lib/do-stuff-plan.ts) is a
  stable sort by size: low walks quick, then errands, then fuzzy, then big;
  high the other way round. With an energy said, do it now and today are one
  walk in that order, so high starts on today's big thing. Okay changes
  nothing. Lanes, make it so and the three-row cap are untouched.

## Agents up to the model (Kirby's ask, 2026-10-21)

Kirby asked how OpenClaw and Claude compare with the person's own model, then "how could we close
this gap?". Four pieces were proposed; the first is built.

### Agents hand back real cards (PR 1)

- MCP's `dsul_save_prep` (lib/mcp/tools.ts) posts to `/api/agent/items/:id/prep`. The body is one
  pack in lib/prep-packs.ts's own shapes, checked by `PackSchema`; a bad one is a 400 that names the
  field, so the agent can fix it.
- The route is the one place a pack is written by the service role. It checks the item is the key
  holder's, delegable, and handed to someone, writes `user_id` from the key (never the body),
  `made_for` from the item's title and `model` as the assignee. One card per item, as for the model.
  The shared writer (insert, then update; the 074-to-080 kind fallback) is lib/prep-packs-save.ts.
- A `question` card is refused: its answer re-asks the person's own model. An agent asks with
  `dsul_ask_user`, which comes back to it.
- The page reads the packs again when an agent's finish lands (use-agent-freshness, after
  `mergeAgentStates` folds a 'done'; not PrepPacksBoot, which mounts on lean routes with no items). A row whose card shows
  drops the agent's own "ready" chip, so it says it once.
- `dsul_my_work`'s description, OpenClaw's work brief and the Claude routine prompt all say: for
  aiMode 'prepare', hand back a card, report done, never send or complete. An agent that skips the
  tool still has its written report, as before.

### Agents get the same brief (PR 2)

- The model's prep rules moved to lib/prep-rules.ts (`PREP_KIND_RULES`, `PREP_QUESTION_RULE_LIST`,
  `PREP_TONE_RULES`); /api/ai/prep's prompt is the same text, built from them.
- MCP's `dsul_prep_brief` reads `GET /api/agent/prep-brief`: those rules, with the question line
  swapped for `dsul_ask_user` and a line saying cards go back through `dsul_save_prep`; the learned
  style (`user_extensions.config.writingStyle`); and the handed-over open items that are stuck
  (lib/stuck.ts over item_events, the same 3-days-in-30 rule). Each part is best-effort.
- Custom instructions are not in it: they live in the browser (ai-settings-store), never on the server.
- `dsul_my_work`, OpenClaw's brief and the routine prompt say to read it once before preparing.

### Braindump split through OpenClaw (PR 3)

- `splitterFor(caps)` (lib/braindump-split.ts) picks who sorts a paragraph out: the model when it
  answers here (`canPrep`), else OpenClaw when this browser is paired (`openclawTransport ===
  'browser'`), else nobody (no button, and a paragraph paste stays a plain paste).
- lib/split-via-openclaw.ts asks OpenClaw over the browser link Ask uses, with /api/ai/split's own
  prompt (now `SPLIT_SYSTEM_PROMPT` in lib/braindump-split.ts) and `splitDrafts` checking. A fresh
  session key per split (`dsul:u:<uid>:split:<uuid>`), so one paragraph never leaks into the next.
  Nothing goes through dsul's server. The dialog says "Sort it out with OpenClaw" / "Sorted by OpenClaw".
- Claude is not offered: it cannot answer on the spot. A hand-off ("Claude adds the items when it
  runs") was proposed and is not built.

## Quieter AI badges (Kirby's picks, 2026-10-22)

Seen in the app, a word chip on every row the AI had touched was a lot for the
sidebar. Round 3 of the badges (claude.ai/artifact/1fxYEr6d1cNrcnPRHnDAb2)
offered five quieter readies; Kirby picked **D, one line in the dock**, with
the sheen on it but rarer, and **sheen only** for working.

- **Rows say nothing about what is ready.** No pack chip, no agent "ready".
  The item panel still shows the pack. Do stuff's lanes keep their own chips,
  and the do stuff key keeps its count: those are inside the mode or on its key.
- **One dock line counts it** (components/notices/ai-work-notice.tsx): "3 ready ·
  1 question", the words crossed by the title sheen once every eight seconds
  (`[data-ai-sheen-slow]`), Look starts Do stuff (whose ready lane holds those
  rows). Ranked a receipt, no anchor, gone while doing stuff. The glyph is the
  aurora dot, warm when only questions wait.
- **A working row is its title's sheen alone.** `WorkingMark` is an sr-only
  sibling of the title (`[data-ai-working]`) that turns the sheen on and carries
  the words for a screen reader.
- **The relay is the account's mark, never a row's.** Kirby likes it, so it
  stays where it means "the AI is working on your stuff" as a whole: the do
  stuff key's bolt, and the dock line's glyph ("Getting 2 things ready" while
  nothing is ready yet, and on the ready line while work goes on).
- An agent's question ("Claude asks") keeps its warm chip on the row: it is a
  request for the person, not a status, and it is rare.
