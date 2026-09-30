# Mobile redesign — implementation spec

The design was settled across ~12 rounds on a design canvas; the artboards live in
[design/mobile-redesign/](../../design/mobile-redesign/) (`.dc.html`, one per screen —
`Main` = Today × Buckets, `ViewList`, `ViewSchedule`, `BraindumpTab`, `ChatTab`). Those
files are the pixel reference: **read the relevant artboard before implementing a
surface.** This document is the contract; where prose and artboard disagree, the
artboard wins on pixels and this document wins on behaviour.

## The problem being solved

Mobile shipped two stacked header pills (`mobile-header` + `mini-week-nav`), a floating
canvas panel, and a dock well holding notices + omnibar + a three-tab bar. That is five
bordered, shadowed surfaces competing before any content appears — it reads busy rather
than professional. The redesign collapses the chrome to **two** surfaces (one header
card, one dock card) and puts content directly on the paper backdrop.

## The shell, on every screen

```
┌─ header card ─────────────┐   white pill, radius 20, 1px surface-3 border,
│  Today  Mon, Aug 24  ⌄    │   --shadow-elev-sm, m-[10px], p-[10px_12px_8px]
│  S  M  T  W  T  F  S      │   (Today screens: date row + week strip)
└───────────────────────────┘
   content, bare on the paper backdrop
┌─ dock ────────────────────┐   surface-3 well, radius 10, --shadow-elev-bar,
│ [◎]  Add, search, or /…   │   inset 10px, p-[10px]
└───────────────────────────┘
```

Nothing else floats. The header card and the dock card bookend every screen.

### Header card

- **One card**, replacing today's two pills. Radius 20, `bg-surface-2`, `border-surface-3`,
  `shadow-[var(--shadow-elev-sm)]`, `mx-[10px]`, `pt-safe` stays on the outer element so
  the safe-area inset and the card's top gap do not collide.
- **Row 1 (Today screens)**: `Today` (Inter 16/600) + the date (`Mon, Aug 24`, 13px,
  muted) + a chevron, the whole group opening the existing calendar popover. Right
  cluster, in order: **view cycle button**, **display menu**, **user menu**.
- **Row 2 (Today screens)**: the week strip — seven evenly spaced columns, each a
  weekday initial (9px, muted) above the numeral (12px), and a **lime underline**
  (16×3, radius 2) under the selected day. No filled circle, no chevrons.
- **Under the strip, only while they have something to say**: the day's review notice
  (`notices-in-place.md`), then the canvas's Display shelf (`display-menu.md`, the
  2026-09-26 addendum). Both grow the card downward, and the day under it re-fits its
  hour rows.
- **Dateless tabs (Braindump, Beacon)** use the *desktop braindump header* verbatim
  instead: a `surface-3` capsule (radius 10, `px-[10px] py-[6px]`,
  `shadow-[var(--shadow-elev-bar)]`) framing a 37px `surface-2` row-pill (radius 10,
  `px-[15px]`, `shadow-[var(--shadow-elev-sm)]`, title at Inter Medium 13). Braindump
  already renders exactly this in `components/sidebar/braindump.tsx` — reuse it, do not
  duplicate it, and do not stack an app header on top of it.

**View cycle button.** One ghost icon button (30×30, no well/box, `text-muted-foreground`)
showing the *current* layout's glyph — `Rows3` buckets / `List` list / `Clock` schedule.
Tap cycles buckets → list → schedule → buckets. The button IS the state readout. The
previous dropdown picker is replaced by this; keep a long-press or context path only if
it falls out for free.

**Display menu.** `<DisplayMenu surface="canvas" trigger="icon" scope="day" />`, the
second ghost icon, same 30×30 treatment. It stays gated to the Today tab exactly as it is
today (see the comment in the current `mobile-header.tsx` — an ungated mount writes
`canvasFilters` while a braindump list reads `braindumpFilters`).

**User menu.** The existing `UserProfileDropdown` is now the *one* menu: profile, settings
**and the bug-report/feature-request entry** (`openDialog({ type: 'bug-report' })`), which
loses its standalone header button. Do not delete the bug-report dialog — only its
dedicated trigger moves inside this menu.

### Dock

- Well capsule: `bg-surface-3`, `rounded-[10px]`, `p-[10px]`,
  `shadow-[var(--shadow-elev-bar)]`, `mx-[10px]`, owns `pb-safe`. NOT `overflow-hidden`
  (the omnibar's results panel opens upward through it).
- Inside, in one row: a **44×44 mode card** (`bg-surface-2`, radius 10,
  `shadow-[var(--shadow-elev-sm)]`) then the **omnibar**, styled as the desktop pill:
  48px tall, radius 10, `bg-surface-2`, `px-[22px]`, the desktop key-rest shadow.
- The mode card shows the **current surface's glyph** — `Sun` today / `AlignLeft`
  braindump / `Sparkles` beacon — in `text-foreground`, **no lime tint**. Tapping it opens
  a **mode switcher sheet** listing Braindump · Today · Beacon.
- `DockNoticesMobile` keeps its place inside the well, above the bar row.
- The omnibar loses its trailing sparkle/Ask-Beacon button on mobile. The Ask-Beacon
  **row inside the results list stays** — free text must still be routable to Beacon.
- The three-tab bar (`MobileTabBar`) is retired; the mode card + sheet replace it.

### Content

Content sits **directly on the paper backdrop** — the floating `bg-canvas` rounded panel
in `mobile-shell.tsx` goes away.

- **Buckets** keeps its bucket cards (there the card *is* the bucket).
- **List**, **Schedule**, **Braindump** render rows straight on the paper, exactly as the
  desktop components already do — slash-label group headings, no wrapper card.
- **Schedule** blocks are the desktop schedule panes unchanged; the time-of-day rail and
  dot sit *outside* the pane in the gutter with a gap, as on desktop.
- **Beacon** puts the conversation on the paper and uses the dock's bar as its input
  (placeholder `Message Beacon…`), which is why the omnibar has never hidden on Chat.

### Motion

`components/primitives/relay-field.tsx` (the radial relay, already used by the dock,
braindump, omnibar, user card and login) is the motion vocabulary. Earn it on discrete
events before anything ambient: **capture submit in the command bar** first, **mode-card
tap** second. No always-on ambient motion behind the header — it fights the calm the
redesign buys. Respect `[data-reduce-motion]`.

### Dark mode

No new tokens. Every surface above already has a dark value in `app/globals.css`
(`surface-2/3`, the `--shadow-elev-*` ramp, `--lime-solid`). The lime underline and the
mode card's foreground glyph must be checked in both themes; **the lime accent never dims
and must never be faded through a parent's opacity.**

## Invariants that must not break

- `data-testid="header-date"` with a machine-readable `data-date="yyyy-MM-dd"` is the
  app's mount signal for **both** shells (`tests/e2e/helpers/app.ts`). It stays.
- `tests/e2e/helpers/app.ts:navigateToDate` steps dates by clicking
  `header-prev`/`header-next`. The redesigned strip has no chevrons, so **the helper and
  the mobile path must be made coherent** — give the day cells a stable testid plus
  `data-date`, and teach the helper the mobile route. Any spec that navigates dates on
  mobile must still pass. Never leave hidden, sighted-user-invisible controls in the DOM
  purely to satisfy a test.
- `[data-tour="tab-braindump" | "tab-today" | "tab-chat"]` are used by
  `components/onboarding/onboarding-tour.tsx` **and** by three `@mobile` e2e specs
  (`pause.spec.ts`, `scope-rail.spec.ts`) to switch tabs with a single click. With the tab
  bar gone these must land on the mode-switcher sheet's items, and both the tour and the
  specs must be updated to open the sheet first. The tour's mobile steps should point at
  a surface that is actually visible when the step runs.
- `view-root`'s `data-testid` / `data-view-scope` / `data-view-layout` / `data-shell` /
  `data-loaded` contract in `mobile-view-router.tsx` is shared with the desktop shell.
- Swipe between tabs (`react-swipeable` in `mobile-shell.tsx`) and `rowSwipeActive`
  suppression stay working; a week-strip swipe must not fire a tab swipe.
- Recurring items track completion per-date in `completedDates`; habit `streak` is an
  opaque stored counter. This work touches no item mutation logic — if a change here
  starts writing item state, it has gone wrong.
- `<ScrollArea>` silently drops `max-h`; use a plain `overflow-y-auto` container when a
  real height cap is needed.
- Desktop must not regress. Every shared component (`Braindump`, `DayList`,
  `DaySchedule`, `DayBuckets`, `Omnibar`, `DockNotices`, `DisplayMenu`,
  `UserProfileDropdown`) is used by both shells: gate mobile-only changes on the mobile
  shell rather than editing shared behaviour in place, and where a shared component needs
  a mobile look, add a variant rather than a branch on viewport inside shared logic.

## Phases

1. **Header** — the carded header, week strip, view cycler, merged menus.
2. **Dock** — well capsule, mode card + switcher sheet, omnibar restyle, tab-bar retirement.
3. **Content** — panel removal, per-view flattening, Braindump and Beacon shells.
4. **Polish** — relay motion, dark-mode pass, reduced motion, safe areas, full validation.

Each phase ends with an adversarial review and a green `pnpm lint`, `pnpm test`,
`pnpm build`.
