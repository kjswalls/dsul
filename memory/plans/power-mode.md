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
remembered for the session. Apps are never woken (lib/handoff-wake.ts is
OpenClaw's); they find the item the next time they read their queue. The
right-click menu still hands off to OpenClaw only.

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
   nothing would move. The list ripples into lanes from the bottom, and the column opens to
   half the window (`doStuffSidebarWidth`, ≥1180px, never narrower, never below the canvas
   floor, never written back). No "doing stuff" strip while docked.
2. Ask reads "ask stuff", its light and mark violet into sky.
3. Seven lanes: ready / do it now ("yes u can", max 3) / today / another day / do it for me /
   later / whatever (archive, with Undo, and the plan never suggests it). Keys 1 to 7.
4. One do stuff over the braindump plus today's unfixed open items: "today" tags, lane dots,
   "→ Thu" and ghost "+" blocks on the grid, and do it now as the up-next card on today.
5. First steps: one question, then 3 to 5 steps with step 1 lit; do it for me on both
   screens, and a single agent-doable step can be handed off on its own.
