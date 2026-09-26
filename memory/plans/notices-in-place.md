# Notices in place — direction E, "back to the object"

**Status (2026-08-26):** built on `claude/notices-in-place`. Supersedes the dock
stack's two-row height ladder. Does **not** supersede the dock's membership rule,
which is unchanged and still load-bearing — see the doc comment on `DockNotice`
in [lib/dock-notices.ts](../../lib/dock-notices.ts).

---

## What this actually is, and what it is not

**The ask:** notifications should not be part of the dock. That is a placement
preference, and this delivers it: each notice goes back to the thing it is
about, and the dock keeps at most one line.

**The justification that was written under it — "every notice arriving or
leaving changed the capsule's height, so the omnibar moved under your cursor" —
was measured and is false.** It is recorded here rather than quietly deleted,
because it is the kind of story that gets re-invented by the next person reading
the same layout.

Measured in headless Chromium against the project's own compiled
`app/globals.css`, the omnibar's top edge moved **0px** when a notice arrived, on
the pre-change structure, at every viewport height from 720 down to 360, chat
closed, empty braindump and a full one alike. It cannot move: the capsule's
bottom is pinned by the column's `pb-[16px]`, and the notice stack sat *above*
`UserCard`/`Omnibar`, so a row grows the capsule **upward** into the braindump.

What did move was the **undo toast**. It was position-fixed at `--toast-bottom`,
a value measured off the capsule's *top* edge — so a notice arriving moved the
toast by exactly the notice's height. The complaint was real; the mechanism was
misattributed.

And the phone never had any version of this problem: its dock is the last child
of a fixed-height flex column, so it grows upward and the well's bottom edge
measured 0px of movement in every configuration, notices inside the well or
above it. On mobile this change is placement and consistency, nothing more.

## What E is

Each notice returns to the thing it is about. A notice standing next to the thing
it changed needs no words to say what it is about — which is already how the
day's suppression line ([components/views/program-notice.tsx](../../components/views/program-notice.tsx))
and a scope's pause switch work. The dock keeps **at most one line**: the
highest-ranked question with nowhere else to live.

E is the only one of the five directions studied that REDUCES total surface
rather than relocating it.

### E's stated tradeoff, and the four things that carry it

> A notice you never scroll to is a notice you never see, so anything genuinely
> urgent still needs the dock line — and deciding which is which is a judgement
> per notice rather than a rule the code can enforce.

1. **The judgement is a field, and the field is this document.** A notice declares
   `anchor?: NoticeAnchor`. Declining to name an anchor IS the judgement that this
   notice must not wait to be scrolled to. The table below is where each choice is
   argued; the code only executes it.
2. **Two parts of it are NOT judgement, and `placeNotices` takes those back.**
   A `blocked` notice never renders in place, whatever anchor it grows later. And
   a notice carrying a **tray** never renders in place, because an in-place row
   draws no tray and anchoring one would silently drop its body.
3. **The same two rules are enforced again at the place that DRAWS the row.**
   `NoticeSlot` asks `placeNotices`, never its own filter. This is not belt and
   braces: replacing that call with `notices.filter(n => n.anchor === anchor)`
   bypasses both rules at the only site where an in-place notice is ever
   rendered, and leaves every test of the pure function green.
   `tests/unit/notice-slot-rules.test.tsx` exists for exactly that mutation.
4. **An anchor that is not on screen is not an anchor.** Slots register themselves
   as they mount ([lib/notice-anchors.ts](../../lib/notice-anchors.ts)), so a
   notice whose object is not currently rendered — the braindump on the phone's
   Today tab, the date row while you are looking at next Thursday — falls back to
   the dock line by itself.

**And `blocked` is exempt from the fold, not just from the anchor.** With
`MAX_ROWS = 1`, the naive cap turned two dock notices into zero notice rows and
one "2 to answer" — moving "Couldn't load your data" from somewhere you have to
*scroll* to, to somewhere you have to *click* to. Same failure, different verb.
`capNotices` now keeps a blocked top row and spends the next slot on the summary:
one row plus "1 more". That is the cap's only deliberate overrun.

## Where things sit, and what it costs

The notice rows moved out of the dock capsule onto a strip above it, hung with
the capsule off one wrapper whose bottom edge is pinned to the column floor.
The `--toast-bottom` anchor ([hooks/use-toast-anchor.ts](../../hooks/use-toast-anchor.ts))
moved onto that wrapper, so the sonner toasts that remain (item dialog, bug
report, store errors) clear the strip.

**The undo row is not in the strip's flow on desktop.** It is
`absolute bottom-full`, overlaying the braindump's last row rather than
displacing it. That is measured, not reasoned: it is the one row that appears and
vanishes on a 5s timer the instant after the user acts, so it is the one whose
arrival genuinely lands under a moving cursor — and in the one configuration
where the sidebar column has no slack (chat expanded, short window) an in-flow
row displaced the omnibar by up to 41px, which is the original complaint being
caused by the fix for it. Out of flow it costs the column nothing.

Omnibar top-edge displacement, in px, versus the same structure with no rows
(headless Chromium, compiled `globals.css`; content stubbed, so thresholds carry
error bars but the ordering does not — all three structures use identical stubs):

| vh | chat | structure | +notice | +undo | +both |
|---|---|---|---|---|---|
| 720 / 480 | either | all three | 0 | 0 | 0 |
| 440 | expanded | before the fix | 0 | 0 | 1 |
| 440 | expanded | **after** | 0 | **0** | **0** |
| 400 | expanded | before the fix | 0 | 0 | 21 |
| 400 | expanded | **after** | 0 | **0** | **0** |
| 360 | expanded | before the fix | 9 | 9 | 41 |
| 360 | expanded | **after** | 9 | **0** | **9** |

The undo row now costs 0px in every configuration. The residual 9px at 360vh with
the chat panel open is the *notice* row, and it is honest: on the old structure
that row was inside the capsule where the chat panel's own flex could absorb it,
and taking notices out of the dock is the thing that was asked for. A 360px-tall
desktop window with a conversation open is over-constrained before any of this.

---

## The placement table

Every notice kind that exists today. "Goes to" is where it renders under E;
"dock" means it keeps the dock's one line.

| Notice | Rank | Goes to | Why |
|---|---|---|---|
| `sync-error` — "Couldn't load your data" / Retry | `blocked` (90) | **dock**, pinned, and never folded | There is no object: the failure is the store, not a row, a day or a list. It is also the only notice that says the app cannot proceed, so `placeNotices` pins every `blocked` notice here even if one later grows an anchor, and `capNotices` refuses to fold it behind a summary. This is the notice E's tradeoff is about. |
| `waiting` — "N items waiting" / Review | `decision` (50) | **dock**, pinned (tray) | The pile is items from days that are, by definition, not the day on screen. Its object is a set of past days no view renders, so putting it on today's canvas would be putting it next to something it is not about. It also carries the triage tray, which only the dock opens — so it is pinned twice over. It is the canonical "highest-ranked question with nowhere else to live". |
| `eod-review` — "Today's review is waiting" / Start | `decision` (50) | **`day-header`** — beside the date, in the canvas header row (desktop) and inside the date card (mobile) | The review's object is the day, and a day's handle is its date — the address `ProgramNotice` already argued its way to, which is the precedent E generalises. It is always on screen, and it costs the row nothing: the row's height is `max(children)` and the header capsule already sets that at 96 or more (more while its Display shelf shows). Live only on today; arrow to Thursday, or leave day scope, and the line returns to the dock. |
| `auto-age-receipt` — "N items put aside this morning" / Put back | `receipt` (30) | **`braindump`** — pinned under the braindump header, above the rows | The sweep's only effect is that N items are now in the braindump. That is the object: the receipt sits on the list it added to, directly above the rows it is a receipt for, with "Put back" next to what would move. **A deliberate divergence from E as drawn**, which put the receipt "on the day whose contents it changed" — the days it changed are past days, and no view renders them. Outside the scroller, so it cannot be scrolled past. |
| the undo row (22 action families, [hooks/use-undo-toast.ts](../../hooks/use-undo-toast.ts)) | — | **strip**, transient, out of flow on desktop | Not a notice — a receipt with an expiry, so it takes no rank and never occupies the dock's one line. It is the one thing here with genuinely no object: "Delete task: Swim" is about a row that no longer exists. |

### `day-foot` was built, measured, and removed

Direction E as drawn put the end-of-day line at the foot of the day's column.
That is wrong for a reason the drawing could not know:
[lib/use-fit-hour-px.ts](../../lib/use-fit-hour-px.ts) sizes the schedule grid's
hours to `viewport.clientHeight - anchorTop - BOTTOM_RESERVE` with
`BOTTOM_RESERVE = 24`, and it counts only chrome **above** the grid — so a row
below the grid inside the same scroller is structurally invisible to it. The slot
was `pt-2` + 26px = **34px**, overflowing the reserve by ~10px on every day the
grid is compressed to fit, which is the common case. A view that did not scroll
would have started scrolling.

A *sticky* foot slot is the wrong fix: it is the permanent rent this surface
rightly refused for the sidebar, it steals from `hourPx` forever, and Week ×
Schedule's pinned gutter is a standing demonstration of how fragile sticky boxes
are in that scroller. The header row has the opposite property — its height is
`max(children)`, already set at 96 or more by the capsule — so the line beside the
date is free. Removing `day-foot` also deleted the only anchor whose liveness had to be
re-derived per render from a timezone.

### What is deliberately NOT on this table

- The day's **suppression line** (`ProgramNotice`) was already in place, beside the
  date, and was already argued out of the dock. It is the precedent E generalises,
  not a thing E moves — and the end-of-day line is now its neighbour for the same
  reason it is there.
- A scope's **pause state** is a permanent fact, not a notice; it rides its own
  switch (the group header, the Display menu's Paused-scopes list). Unchanged.
- The **habit reminders** (cue, last call, nightly settlement) reach outward
  through push/voice/SMS and never render in the app at all. See
  [habit-reminders.md](habit-reminders.md). Nothing here touches them, and nothing
  here should ever be taken as a place to render one: a nudge is owed at a moment,
  and a surface you have to open is not a moment.

---

## The three amendments, as built

1. **Typewriter shimmer, in place only.**
   [components/primitives/typewriter-text.tsx](../../components/primitives/typewriter-text.tsx)
   reveals a line with a stepped `clip-path` wipe and one neutral sheen crossing
   it. **The dock line NEVER types** — the dock is where the urgent and the
   homeless live, and anything urgent must be legible immediately. Under either
   motion veto — the OS `prefers-reduced-motion` or dsul's own
   `[data-reduce-motion]` — the text simply appears, with no class for CSS to
   undo. The full sentence is in the DOM from the first frame in every case, so
   the reveal is a paint effect and never an availability one.
   *Divergence from the drawing:* the **undo row does type**. Two reasons, and the
   second is the better one: it is the least urgent thing the app ever says, and —
   since it is now visually identical to the dock line and stacked directly above
   it — without a difference in arrival, a new row appearing above a resting row
   is indistinguishable from the resting row having moved.
2. **Every notice is dismissible.** `onDismiss` was optional and the ✕ was
   suppressed wholesale on touch. In place there is room for it and nothing for it
   to collide with, so an in-place notice always draws its dismissal, on both
   platforms. The dock line keeps the old touch rule (its trays carry their own
   dismissal) because the dock row is still a full-width tap target with no hover
   to disambiguate a 24px ✕ from it.
3. **The undo toast is a strip row.** Same 26px, same ink, same glyph-then-line-
   then-verb shape as a notice — plus a lime expiry hairline that drains over the
   row's life. The hairline animates its **width**, never its opacity: lime never
   takes alpha in this palette, and it is its own element so no parent can fade it.
   It deliberately carries **no `title` attribute**: `tests/e2e/undo-redo.spec.ts`
   addresses the history control as `getByTitle('Undo')` and Playwright matches a
   title by substring, so a tooltip here would put a transient second match in
   front of it.

---

## Rules a future change must not break

- **The dock's membership rule is unchanged.** A line is earned by a pending
  DECISION, not by importance. Standing facts belong on the thing they are facts
  about — which under E is now true of nearly everything, so the rule binds
  harder, not less.
- **The dock line is one row**, plus a fold. `MAX_ROWS = 1` on both platforms.
- **`blocked` never renders in place, and never folds.** Pinned by
  `placeNotices`, pinned by `capNotices`, pinned at the render site, pinned by
  test in all three.
- **A tray-bearing notice never renders in place.** Same function, same render
  site, same tests.
- **`NoticeSlot` asks `placeNotices`; it never filters for itself.** See point 3
  above — this is the one place where a plausible simplification silently
  disables every rule on this page.
- **An anchor registers on mount, in a LAYOUT effect.** A passive effect is one
  commit late, which is one painted frame of the dock holding a notice that is
  about to move. Pinned by a sibling's own layout effect, which observes the
  registry before any passive effect in the commit can run.
- **The typewriter is never the reason text is missing.** Reveal by clipping text
  that is already there; never by withholding it.
- **Nothing measures `--toast-bottom` off a surface whose height tracks the
  notices.** That coupling is what actually caused the original complaint.
- **The notice strip lives outside `[data-dock-surface]`**, and the undo row lives
  outside the flow on desktop. Both are pinned by test.

---

## Known gaps, honestly

- **The reduced-motion CSS fallbacks are not exercised.** The component tests pin
  that no animation class is applied under either veto, and that the hairline is a
  width animation on its own full-strength lime element; the
  `@media (prefers-reduced-motion)` and `[data-reduce-motion]` blocks in
  `app/globals.css` are not, because jsdom loads no stylesheets.
- **"The omnibar does not move" is pinned structurally, not in pixels.** jsdom
  lays nothing out, so the unit tests pin the cause (the strip is outside the
  capsule; the undo row is outside the flow). The pixels are in the table above,
  measured out-of-band in headless Chromium against stubbed content.
- **Two live slots for one anchor would both draw the notice.** Nothing in the app
  can produce that today — the refcount stops one slot unregistering another, but
  it does not pick a winner. If a second slot for an anchor ever becomes possible,
  placement has to choose one, not merely stay registered.
