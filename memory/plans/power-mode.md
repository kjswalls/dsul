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

Gaps found while designing, not yet scheduled: no free-slot finder on the grid
(for "on the calendar"), no web search for the model (for research packs).
