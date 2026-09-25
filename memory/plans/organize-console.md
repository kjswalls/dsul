# Organize — one console for every container and label

**Status (2026-08-11): APPROVED FOR BUILD. All seven open questions answered by
Kirby (below). No code written yet.**

> **Note (2026-08-23):** the **ScopeRail** component (`components/sidebar/scope-rail.tsx`)
> and its `tests/e2e/scope-rail.spec.ts` are retired — scope toggling moved onto group
> headers and the Display menu's "Paused scopes" list (see `programs-routines.md`'s
> 2026-08-23 addendum). This doc's line-anchored references to that component are history.

Design pass run 2026-08-11: three container directions designed to their strongest
form (modal command-center, non-modal docked panel, `/organize` route), each attacked
by three independent reviewers — codebase fit, user journey, visual craft. Nothing
scored above 5/10. The recommendation is the modal spine with the panel's IA and the
route's addressing semantics grafted on, and every fixable flaw raised against it
corrected.

Interactive study (live prototype at real size, both themes):
<https://claude.ai/code/artifact/1c32e594-4686-4e1a-892f-a11e53d47a8b>

Read [programs-routines.md](programs-routines.md) and [unified-items.md](unified-items.md)
first. This plan **amends** programs-routines locked decision 1: routines and programs
were deliberately id-referenced *because* projects and habit groups are name-referenced
and therefore unrenameable. Kirby's decision 5 below closes that asymmetry rather than
living with it.

**Goal:** replace `ManageCollectionsDialog` (Routines & Programs, 680px) and
`ManageCategoriesDialog` (Projects/Groups/Types, 400px) with a single fixed **938×640**
plate — six sections in two groups, plus Trash — reached from seven doors that all
resolve to one call.

---

## Product decisions (Kirby, 2026-08-11)

1. **The name is "Organize", not "Manage."** Every existing door says Manage;
   they all change. The two legacy palette commands keep their **ids and aliases**
   (`app.collections` / `/routines`, `app.categories` / `/projects` `/groups`) and get
   new labels — the ids are a test contract *and* a shortcut-rebinding persistence key.
2. **Seed defaults on first run.** A brand-new account gets a small, realistic,
   fully deletable starter set rather than six empty sections. Named after real
   behaviour, never `Example 1`.
3. **Restore participates in undo.** A Trash restore stamps a normal history entry;
   `⌘Z` after a restore re-deletes the row. (The two rejected alternatives were
   "clears the redo stack, not itself undoable" and "stamps no label at all".)
4. **Ship the corrected delete copy once, with the 30-day clause, in Phase 1.**
   No two-step edit. All phases land before anything ships, so the forward reference
   to a Trash that doesn't exist yet is never user-visible.
5. **Migrate to stable container ids first.** `items.project` / `items."group"` stop
   being name references. This is a new **Phase 0** and it delays everything — accepted
   knowingly. It is what lets projects and habit groups get real name fields in the
   console instead of the honest-sentence mitigation.
6. **Build the section filter.** Scoped to the current section, `/` and `⌘F`.
7. **Swap Item types and Habit groups in the rail order** — LABELS reads Projects,
   Item types, Habit groups. Folding habit groups into routines stays deferred, but
   the order that makes folding cheap is free now and awkward later.

---

## The four answers

**Does it need to be a modal? Yes — keep it, but stop treating it as a dialog.**
Not because the content wants a scrim, but because every alternative costs more than it
returns at this visit frequency. All three journey reviewers landed independently on the
same fact: this surface is *periodic*. Under thirty objects, one person, monthly.

- The **docked panel** buys a permanent column and a second Escape arbiter to deliver a
  live-preview gesture the ScopeRail already performs daily, and violates the written
  `SIDEBAR_MIN_CANVAS = 520` floor the moment the item panel is also open.
- The **route** dies on arithmetic, not principle: it inherits `<main>`, so its width is
  `viewport − sidebar − 442`. At the shipped 406px sidebar on a 1440px laptop that is a
  592px console, below the route direction's own 760px drill-in threshold — a *worse*
  editing surface than the 680px dialog it replaces, collapsing further any time the
  sidebar is dragged wider. Its headline win is also partly false: below 1180px
  `desktop-shell.tsx:63` marks `<main>` `inert` when the item panel overlays, and the
  console *is* main's body.

**The escape hatch stays open on purpose.** Build the console as
`components/planner/organize/` rather than a dialog body, and `/organize` later becomes a
page that renders the same component — an additive PR, not a rebuild. Buy the URL when
the URL is wanted, not before.

**Size: 938 × 640, fixed aspect.** Sized from the columns up —
**rail 180 | 1px | list 300 | 1px | detail 456**; vertically **48 header + 560 body +
32 footer**. Needs a 1002×720 viewport, so it fits 1280×800 with 278×80 to spare, fits
1366×768, and fits 1024×768 exactly. Fixed is the point: the frame never resizes on a
section change, which is the single loudest un-premium tell in both current dialogs.

**Access: seven doors, one call** — `openDialog({ type: 'console', tab, focusId?, focusNew?, returnTo? })`.

**Contents: six sections in two groups, and nothing else.** Settings stays out
(preferences change how the app behaves; containers are data whose state changes what
work exists). The daily on/off switchboard stays on the ScopeRail.

---

## Layout law

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Organize                                                             ✕  │  48
├─────────────────┬────────────────────────────┬───────────────────────────┤
│ CONTAINERS      │ ROUTINES              4    │  ⟳  Morning reset  ▪▪▪▪ ▫ │
│  Routines   ←   │  ⟳ Morning reset      6    │  Routine · 6 items ·      │
│  Programs       │  ⟳ Wind-down  ☾Paused 4    │  in 1 program             │
│                 │  ⟳ Sunday admin       3    │  ───────────────────────  │
│ LABELS          │  ⟳ Gym block          3    │  Status   [Active|Paused] │
│  Projects       │                            │  ☾ On here — your Deep    │  560
│  Item types     │                            │    work program is        │
│  Habit groups   │                            │    holding it off today.  │
│ ─────────────   │                            │  IN 1 PROGRAM             │
│  Trash          ├────────────────────────────│  6 ITEMS          + Add   │
│                 │ ⊞  New routine…         ↵  │  ▫ Stretch  7:00  ⌃ ⌄ ✕  │
├─────────────────┴────────────────────────────┴───────────────────────────┤
│  Morning reset · routine        Open item ↵   Filter /   Close Esc       │  32
└──────────────────────────────────────────────────────────────────────────┘
      180                    300                          456
```

**Ground.** Every pane sits on `bg-modal`. **There is no background step anywhere
inside the plate — depth is the hairline, full stop.** This is not taste: a rail on
`--surface-1` over `--modal` is a 0.6% step in light (invisible) and a clear 3.2-point
step in dark, giving a two-tone dark mode and a flat light one; the obvious fix inverts,
because `--surface-3` at 0.245 is *lighter* than `--modal` at 0.21 in dark. Removing the
step removes the per-theme problem entirely.

**Two elevation levels only.** Level 0 = the plate and everything in it, hairlines only.
Level 1 = popovers, menus, Calendar, IconPicker, AlertDialog — `bg-popover`,
`rounded-[10px]`, `shadow-soft-md`, declared once. The **only** raised element inside the
plate is the segmented control's thumb.

**Four radii, all existing app literals.** 20px plate · 10px controls and popovers (the
app's capsule signature) · 5px rows · 4px keycaps. **3px and 7px are banned** — grep
returns zero of either in `components/`.

**One new token.** `--shadow-elev-plate`, both themes, a plain custom property consumed
as `shadow-[var(--shadow-elev-plate)]` — *never* a named `@theme` shadow utility, or
Tailwind inlines light's value into `--tw-shadow` and dark never re-tunes.

```css
:root { --shadow-elev-plate: 0 24px 64px oklch(0 0 0 / 14%), 0 4px 12px oklch(0 0 0 / 10%); }
.dark { --shadow-elev-plate:
  inset 0 1px 0 oklch(1 0 0 / 10%), 0 24px 64px oklch(0 0 0 / 50%), 0 4px 12px oklch(0 0 0 / 40%); }
```

The dark `inset 0 1px 0` light-catch is mandatory — on the near-black ramp a drop shadow
alone does not read, and the whole dark elevation system is a lighter surface plus that
1px catch.

**Responsive.** 768–1023px: plate at `calc(100vw-48px)`, **the rail never collapses**
(the moment it does, discoverability falls back to the palette, which is what killed the
third-column direction), list and detail become one drill-in pane behind a *container*
query — not a viewport query, so dragging the sidebar can't lie to it. Below 768px:
`ResponsiveModal` hands over to the vaul sheet, three levels, free — which
`ManageCategoriesDialog` has never had (it is a 400px centered box on a phone today).

---

## Navigation

A grouped left rail built on `Radix Tabs orientation="vertical"`, **never a tab strip**.
Chosen because it costs nothing: vertical Tabs still emits `role="tab"`, so
`getByRole('tab', { name: 'Routines' })` in `programs.spec.ts:76` keeps resolving; it
gives roving tabindex and ↑/↓ free; and `key={tab}` remains the remount trick that makes
a second open with a different section actually land there.

Import `@radix-ui/react-tabs` **directly**, not `components/ui/tabs.tsx` — the wrapper's
`TabsList` is `bg-muted inline-flex h-9 w-fit rounded-lg p-[3px]` with `flex-1` triggers,
i.e. exactly the full-width segmented strip the reference set names as the loudest clone
tell, and every one of those classes has to be nulled anyway.

```
CONTAINERS                    ← role=presentation eyebrow
  Routines        routines
  Programs        programs
LABELS
  Projects        projects
  Item types      types       ← decision 7: types above groups
  Habit groups    groups
──────────────                ← role=presentation, mt-auto
  Trash           trash
```

Group eyebrows and the Trash rule are wrapped in `role="presentation"` so the tablist's
children are all tabs and Radix's RovingFocusGroup skips them. **Slugs are the five
existing `tab` string values plus one** — every `openDialog({..., tab})` call site keeps
its literal; this is a variant rename, not a value translation.

**Rail rows carry no icon and no count.** Five near-identical grey lucide glyphs is the
clone tell; counts reflow as data loads, put two numeric columns 300px apart in a fight,
overflow a 22px slot the moment a project's usage count goes three digits, and — load-
bearingly — **join the tab's accessible name**. `getByRole('tab', { name: 'Routines' })`
matches by substring so `"Routines 4"` would pass, but that is a silent dependency on
Playwright's default matching. Counts live on the list head and the detail meta line.

**Taxonomy: CONTAINERS / LABELS.** Grouped by what the thing does to your work, not by
feature area. Containers switch work on and off — stateful, with members, the only two
that get a state control and a member list. Labels name work. Trash is a lifecycle
surface, not a peer of either, so it is pinned to the foot behind a rule. Two levels
maximum; there is no third.

**Deep-linking.** `ActiveDialog` gains one variant, replacing two:

```ts
{ type: 'console'; tab?: ConsoleSection; focusId?: string;
  focusNew?: boolean; returnTo?: ActiveDialog }
```

- `tab` alone → that section, list focused on row 1, detail shows the teaching line.
- `tab` + `focusId` → that object **selected**, row `scrollIntoView({block:'nearest'})`.
  Closes the recorded deferral where the manager focused a *tab* rather than a row.
- `focusNew` → the create row's input focused on arrival (what ScopeRail's `+` has
  always meant).
- `returnTo` typed as **`ActiveDialog`, not `Item`** — typing it as `Item` cannot restore
  an add draft, which is exactly the case that matters.
- No `tab` → `routines`. **Never a last-used-section memory:** at monthly frequency a
  remembered destination is a coin flip, and it makes the braindump door unlearnable.

---

## The object row — one primitive, all six sections

Full-bleed in the 300px column, hairline-separated, **no card, no per-row fill at rest**.
A stack of grey pills is the fastest way to look like a bootstrapped admin panel, and
this app already reserves rounded fills for *nav* rows (the rail, the ScopeRail).

`h-[34px]` at md and up (`min-h-[44px]` below md and under `(pointer:coarse)`), `gap-[9px]`,
`rounded-[5px] px-[7px]`. 34 is chosen against *this* type ramp, not Linear's — `text-sm`
here is 12px, not 13px, so 34 reads at the density Linear gets from 36–40.

| slot | spec |
|---|---|
| glyph | `w-[18px]` centering a 14px `CategoryIcon` in the container's accent (stored `color` first, else `accentColorForName`) |
| name | `min-w-0 flex-1 truncate text-sm font-medium`, `title` attr |
| pill | `StatePill`, reused verbatim, **only when not live** |
| count | `w-[22px]` fixed, `font-num text-2xs tabular-nums`, always rendered incl. `0` |

- **One mark per row, never two.** The glyph carries identity *and* colour. An identity
  square *plus* a grey glyph accumulates two marks for one meaning.
- **No halo on the glyph.** The `shadow-[0_0_0_1px_var(--modal)]` trick works elsewhere
  because the ground genuinely is the token; here it becomes `modal + 4%` on hover and
  `+9%` on selection, so the ring would become a visibly *brighter* outline exactly when
  the row is active.
- **Every count runs through `countLive`**, never a raw `.length` — join rows outlive an
  item's soft delete by design. A program's count is items **+** routines.
- **Paused dimming rides the NAME only.** Not the row (that fades the focus ring and the
  pill, the one thing that must stay readable) and **not the glyph** — the accent may
  resolve to `--accent-8`, which is lime, and lime never dims.
- **Selected suppresses hover.** `data-[selected]:hover:bg-[var(--row-selected)]`.
  Without it, hovering a selected row swaps 9% for 4% and the row gets *lighter* — the
  documented inversion all three source directions committed.
- **Focus ring is 1px inset, not 2px.** At 2px a lime rectangle around a 300px row is the
  largest chromatic mark in an app that quarantines colour to ≤14px glyphs.

**NO per-row actions anywhere.** No trash, no gear, no swatch, no overflow `…`. Every
verb lives in the detail pane one pixel away. This buys ~30px of name width, removes every
hover-only affordance (touch and keyboard parity solved by *deletion*, not duplication),
removes the mis-tap delete, and gives the list exactly one interaction: select. It is a
deliberate regression against today's categories rows, which carry three controls each;
the cost is one extra click per delete, which is correct for a destructive verb.

**One named exception:** Trash rows carry an always-visible inline `Restore`
(`h-[22px] px-2 rounded-[5px] text-xs`) — there is nothing to select into, and hiding the
only path to the only verb is the anti-pattern.

**The draft row** is `h-11`, pinned at the **foot of the list column, outside the
scroller**, `border-t`, and **unconditionally mounted**. That last part is law:
`programs.spec.ts:111-112` fills `${kind}-new-name` with no preceding click, so making the
create row conditional times out every container-creating test in both spec files.
Creation gates on `collectionsAvailable && userId && !isLoading` — the three-part signal,
not the flag alone, because a container created inside the load window is silently erased
by `initializeStore`'s `set()` and the user then owns two.

---

## The detail pane

`flex-1 min-w-0 overflow-y-auto px-6 py-5` → 408px content ≈ 58ch. Blocks 20px apart,
`h-px bg-border` only where the subject changes. **Content swaps at 0ms.**

1. **Identity row** — `h-8`, IconPicker trigger (`hover-wash`, *not* `hover:bg-accent`:
   it carries a resting fill and a background-*color* swap makes controls on a well get
   lighter on hover) + name + ColorSwatchPicker flush right.
   Name is a **borderless buffered input styled as a heading** — `text-lg font-semibold`,
   commits on blur and Enter, Escape resets, blank or unchanged reverts, draft resets on
   `[id, name]`. Live binding is forbidden: every update action stamps a history label and
   the subscriber deep-clones the whole snapshot, so one rename becomes ~15 undo entries
   and ~15 PATCHes against a 50-deep stack.
   **After Phase 0, projects and habit groups get this same field** — the honest-sentence
   mitigation is deleted, not shipped.
2. **Meta line** — `text-2xs`, `font-num` on numerals.
   `Routine · 6 items · in 1 program` · `Program · 4 items · 2 routines` ·
   `Project · 11 tasks` · `Habit group · 6 habits` · `Item type · goal · 7 items`.
   **This is where projects and habit groups finally get a usage count**, which makes
   their delete the informed action it has never been.
3. **State block** *(containers only)* — settings rows, label left + optional description,
   control flush right, `h-11`, hairline between. Segmented = the app's capsule-over-pill
   at console scale: `h-8` well `rounded-[10px] bg-surface-3 p-1`, `h-6` thumb
   `rounded-[8px] bg-surface-2 shadow-[var(--shadow-elev-sm)]`. **4px clearance** —
   `elev-sm` is a 4px offset and at 2px it clips on the radius.
   - Routine `Status` → `Active | Paused`, calling **`setRoutinePaused` directly** (it
     stamps its own history label; routing through `updateRoutine` stamps "Edit routine"
     and lands the intended label on the user's *next* action).
   - Routine `Comes back` *(new, paused only)* → DayField calling
     `setRoutinePaused(id, true, format(date,'yyyy-MM-dd'))` — **the third argument the
     store has always taken and no call site has ever passed**, while `pausedUntil` is
     *read* in three places. Write with `format`, never `toDateStr` on a react-day-picker
     Date; parse at local noon, never `new Date('yyyy-mm-dd')`.
     **A pause's upper bound is EXCLUSIVE; a program's range is inclusive at both ends.**
     Not an inconsistency — resolving them the same way makes one read wrong by a day.
   - Program `Status` → `On | Off | Dates`; `Runs` renders **only** under Dates, each
     field strictly bounding the other so a one-day program stays legal and an inverted
     range is impossible.
   - Swap verb renders only when this program is not live *and* at least one other is.
4. **Effective-state block** *(new, routines only — the highest-value correctness fix)*.
   Today `RoutineDetail` resolves only the local pause, so a routine held off by a live
   program shows `Active` with un-greyed members while the ScopeRail one column away
   reports `local=on / effective=off`. The segmented control keeps showing **local** truth
   (that is the value it writes), one muted line names the override, and **the member list
   greys on EFFECTIVE state** because effective is what the rest of the app obeys.
   Beneath it, `IN N PROGRAMS` — a reverse view that **does not exist anywhere today**.
5. **Member rows** — `h-[30px]`, type glyph (**new**: today a member row is a bare title,
   so two same-titled items are indistinguishable here *and* in the add-search results),
   title, `w-[64px]` meta (`font-num` **only when numeric** — mono on `anytime` is
   developer-tool cosplay), `w-[72px]` control rail **width reserved always**.
   `⌃⌄` are **routines only** — `routine_items` carries `sort_order`, `program_items` does
   not, and offering it on a program lets a user arrange an order that survives until the
   next fetch and then silently reshuffles. Swaps **by id**, never by index. End-of-list
   arrows take **`aria-disabled`, not `disabled`** — a real `disabled` drops focus to body,
   `focus-within` fades the pair out, and a keyboard user walking a member down loses
   their place.
6. **Danger zone** — label + outline `Delete`. Only the item-type confirm is
   `bg-destructive`; it is the one delete in the app that genuinely cannot be undone.

---

## Type, motion, keyboard

**Three registers, no fourth.** 16/600 detail title · 14/600 plate title · 12 (`text-sm`)
rail label + row name + body · 11 (`text-xs`) notes · 10.5 eyebrows and pills · 10
(`font-num text-2xs`) counts and meta.

- The **plate title is smaller than the object title** — chrome vs subject, 1.33:1.
- **One name size everywhere: 12px. 12.5px is banned from the console.**
- 10 and 10.5 never sit adjacent **as the same family** — the count keeps 10 only because
  `font-num` changes the family, and a mono numeral beside a sans word is legible at any
  size where two sans marks half a pixel apart are jitter.

**Motion: two durations, three existing curves.** 150ms in / 100ms out, popovers
120/80, segmented thumb 150ms on `--ease-roll` (the console's one true crossover).
Stock `DialogContent` ships `duration-200 zoom-95` — **95% on a 938px plate is a 47px
lurch**; both are overridden to `duration-150` / `zoom-[0.98]`. Tailwind v4 presses via
the standalone `translate` property, not `transform`. Exit is always faster than entrance.

**Deliberately not animated** — plate height on section change (the plate is fixed-aspect
precisely so this never happens), section switching, rail selection, detail arrival, row
hover (**no transition property on background-color at all** — anything over ~80ms trails
the pointer across a 12-row list, and TaskRow already omits one deliberately), the focus
ring, list reflow, member reorder, counts, skeletons, spring overshoot.

### The keyboard blocker, and its fix — ships in Phase 1, before the console exists

`hooks/use-command-shortcuts.ts:61-99` is the app's one `window` keydown dispatcher and
its only guard is `isFocusedOnInput()`. Console list rows are `<button>`s, so they are not
"typing": pressing `n` on a focused row opens the add dialog and **replaces the console in
the single `ActiveDialog` slot**; `v` switches the planner view behind the plate; `?`
opens the shortcuts modal; `⌫` matches the registered `delete_hovered` binding, which
`preventDefault`s before any local handler runs, and `lib/hovered-item.ts` is a module ref
cleared only by TaskRow's `onMouseLeave` — so it can still be pointing at a task on the
canvas. **Typing a routine's name would destroy the surface you are typing into.**

```ts
// after `const typing = isFocusedOnInput();`
const localKeys = !!document.querySelector('[data-keys-local="true"]');
// inside the loop, after `const command = ...`:
if (localKeys && !binding.keys.some(k => k === 'mod' || k === 'shift' || k === 'alt')) return;
```

The console root carries `data-keys-local="true"`. Scoped, unit-testable, changes nothing
for any surface that doesn't opt in.

**Model, calibrated down:** `↑ ↓` walk the list, `Home`/`End`, `↵` into the detail's first
control, `⌥↑`/`⌥↓` reorder a focused member (routines only), `/` or `⌘F` filter, `⌘⇧,`
opens the console. **Deliberately absent: type-ahead, `⌫`, `⌘↵`, and any bare-letter
global.** Spending a single-letter global on a monthly surface, in an app whose bare
letters are daily verbs, is a frequency claim the surface cannot back.

**Escape ladder — four rungs, one per press, rungs SKIPPED when inapplicable.** That last
clause is load-bearing: `closeManager` in `programs.spec.ts:93-103` and
`scope-rail.spec.ts:85-92` loop at most four presses waiting for the overlay to reach 0,
so a no-op rung that consumed a press would exhaust both helpers.
(1) popover/calendar/picker/menu → (2) member-add input or filter text clears →
(3) *drill-in and mobile only* detail pops back to list → (4) console closes, re-opening
`returnTo` if set. **No "clear selection" rung** — nobody presses Escape to deselect.

---

## The seven doors

All resolve to `openDialog({ type: 'console', tab, focusId?, focusNew? })`.

1. **Braindump header folder button** (`braindump.tsx:521-529`) — same `h-6 w-6` ghost,
   same one-slot budget in a width-critical row, now reaching all six sections instead of
   three. Opens on `projects`, **permanently** — a door whose destination changes cannot
   be learned at monthly frequency. `aria-label="Organize"`, tooltip + `⌘⇧,` KeyCap.
2. **ScopeRail `+` and every row name** (`scope-rail.tsx:121`, `:156-161`) —
   `+` → `{tab:'routines', focusNew:true}`; name → `{tab, focusId: row.id}`.
   **Closes the recorded `focusId` deferral.** Both testids unchanged.
3. **Command palette** — new `app.console` ("Organize", aliases `/organize /manage
   /programs /types /trash`). `app.collections` and `app.categories` keep their **exact
   ids and aliases**, re-pointed, relabelled.
4. **`mod+shift+,`** — free after normalization, reads as a sibling of `⌘,` for Settings,
   which is exactly the relationship. Auto-appears in the shortcuts modal, rebindable.
5. **Item dialog chips — restructured, not just retargeted.** Drop the
   `routines.length > 0` / `programs.length > 0` terms from the gates
   (`item-dialog.tsx:1188`, `:1242`); keep `collectionsAvailable && collectible`. Add
   inline **`New routine…` / `New program…` / `New type…`** in *both* modes, mirroring the
   `addProject`/`addHabitGroup` inline path that already ships at `:1006-1015`. Keep
   **`Organize routines…` in EDIT mode only**, where the panel autosaves so nothing is in
   flight, carrying `returnTo`. **This is where the single-slot draft-loss defect actually
   gets fixed** — not by buying a second store slot.
6. **User-card dropdown** (`user-card.tsx:141-163`) — an `Organize` row above `Settings`,
   KeyCap flush right. Adjacency, not nesting, preserves the "management stays out of
   Settings" line.
7. **ProgramNotice** (`program-notice.tsx:54`) → `{tab:'programs', focusId}`. A
   consequence→cause link must land on the specific program hiding your work.

**Trash's door is separate and deliberate:** a `Recently deleted` row at the foot of the
user-card history popover, where in-session undo already lives and where a panicking user
already goes. A recovery feature only reachable from a rail nobody has opened is not one.

**Mobile:** doors 1, 2, 6 and 7 all exist on touch already. **No fourth bottom tab** —
`MOBILE_TAB_ORDER` drives swipe nav and `OnboardingTour` drives tabs by name.

---

## What is NOT in the console

- **Everything in Settings, in both directions.** Settings contains *zero* management of
  user-created objects today. The console is a new **peer** of Settings, not a carve-out.
- **The daily switchboard.** No state toggle on any list row, in any section. State lives
  in the detail pane only. Building the rail's live-flip gesture as the console's
  centrepiece re-merges the two surfaces `scope-rail.tsx:13-31` exists to keep split, and
  would ship the same switch twice with *different* semantics — the console's could only
  ever publish local state; the rail publishes local **and** effective.
- **Item editing.** Member rows are addresses, not editors. `↵` opens the item and the
  console closes — an honest exit, named in the footer bar so it is never a surprise.
  (`item-panel.spec.ts:104` asserts a second `role="dialog"` cannot coexist with the panel.)
- **The common membership add-path.** Bulk `Collect` already exists in the selection bulk
  bar and is tri-state and correct. The console's member lists are for *curation*.
- **Container creation, exclusively.** Creation stays distributed. *(Updated 2026-09-25.)*
  The "new" dialog makes goals, routines, programs and projects: its type chip's menu lists
  them under an "Organizers" heading after the item types, and picking one swaps the body
  (`ContainerDialog`, components/planner/container-dialog.tsx, its own `new-container`
  slot in the same shell) — reached by `n`, an empty omnibar `+`, and the palette's New
  goal / routine / program. The item dialog's membership chips still mint them inline, and
  the console keeps its own "+ New". Item *types* are made in the console only; the four
  organizer nouns are reserved as slugs for new types so the menu never lists two "Goal"s.
  The console owns the *destructive and structural* verbs.
- **An Archive state** — refused. Paused/off is already the app's way of setting something
  down, and a second inactive state would double every object's vocabulary.

---

## Build order

Each phase independently shippable and green on its own. Nothing ships until all land
(decision 4), but each must stand alone in CI.

### Phase 0 — Stable container ids *(new; decision 5)*

**Status 2026-08-12 — BUILT AND APPLIED.** `027_container_ids.sql` is live on the remote
(`7e12c2d`); the app half is `c24e92b`. 874 unit tests, lint clean, types `dist/` rebuilt.
The ledger was realigned to `027` by hand — `apply_migration` stamps a timestamp version,
which `db push` would later try to replay.

**All four survey findings held up, and the DB answered the three questions the plan could
only infer.** `(user_id, name)` IS unique on `projects`, `habit_groups` **and**
`item_types`; `deleted_at` exists on projects/habit_groups/items but **not** on
`item_types`; the server is **PostgreSQL 17**. Finding 1 was the live one: `cron.job` 3
really does hard-delete from both container tables nightly, so a bare `on delete set null`
would have nulled `items.user_id` and aborted the whole job with 23502. Verified by probe
against real rows inside a self-rolling-back block — `project_id` nulls, `user_id` survives,
the name text is kept.

**What no amount of reading could have found: the backfill linked 18 of 30 project
references and only 5 of 228 group references.** 223 of the misses belong to one account
with **zero `habit_groups` rows** — `DEFAULT_HABIT_GROUPS` is declared in
`lib/planner-types.ts` and imported nowhere, so those groups have only ever existed as a
client-side constant. Those rows correctly take a NULL `group_id` and keep working off the
text column. **The backfill is written re-runnable specifically so Phase 6's seeding adopts
them — Phase 6 must re-run it rather than assume this pass finished the job.** The other 12
misses name a project ("Housework") with no row at all; left dangling rather than invented,
which is exactly today's behaviour.

**Two implementation facts worth not re-deriving.** The fan-out shares ONE `set()` with the
rename, because undo restores a whole snapshot — split across two, undoing a rename would
restore the old container name while every member kept the new one, i.e. the orphaning bug
through the back door. And a name write resolves the id at the *write*, not at the call
sites: key presence is the test, so clearing `project` clears both halves, and an unmatched
name resolves to `undefined` rather than inventing a link that the next container created
with that name would inherit.

**Agents cannot write these ids, permanently.** The agent surface speaks in names and holds
no id↔name map, so a body carrying both could only disagree with itself. Both create
schemas `.omit()` the field (the pause precedent); the update schemas are hand-enumerated
and never accepted it.

**Review 2026-08-12 (commit `81c5c21`). Eleven confirmed, nine refuted — and six of the
eleven were one root cause, which was mine.** I wrote, in the types comment justifying the
`.omit()` and again in the commit body, that `lib/db.ts` resolved the name to an id
server-side. **It did not** — `grep project lib/agent-api.ts` returns nothing. The omission
was right; it is only SAFE beside a resolver, and I shipped it without one. `lookupContainerId`
now exists on both the create and update paths.

**The update half was new harm, not an omission.** An agent PATCH re-filing an item wrote
the name and left the old id. Pre-027 that was inert; after the fan-out it is not, because
the fan-out treats the id as truth — renaming the PREVIOUS container would rewrite that
item's name and pull it back. An unmatched name now clears the id: *"no such container"*
and *"cannot ask"* are different answers and the caller needs both.

Two bugs found while writing that fix, neither of them reported: **filters must precede
`.limit()`** (supabase-js returns a transform builder with no `.eq()`, and `DbClient` is
`any`, so nothing would have flagged the throw), and **a failed lookup must never take an
item create down with it**.

**I also wrote another vacuous test** — the same shape the Phase 3 review caught. The
case-insensitive group assertion checked a value the fixture had already seeded, so
deleting the whole resolution left it green. Now it moves the habit to a *different* group.

### Phase 0b — renaming is unparked *(commit `61c9a8f`)*

The payoff. Both details lose their honest sentence and the field goes live.

**`takenBy` is not optional, and why is the interesting part.** Both tables are
UNIQUE (user_id, name), and a rename's two writes **do not fail together**: the container
UPDATE raises 23505 and is swallowed by `.catch(console.error)`, while the id-keyed member
fan-out succeeds. Rename Work→Home when Home exists and the container keeps its name while
every one of its items claims Home's — which reads as the items having moved. Nothing
downstream can detect it. Case-insensitive (the app's own lookups are), excluding self (so
fixing your own capitalisation is still legal). A refused name keeps what you typed.

**`editable` and `parkedNote` are deleted, not left true.** All five call sites passed the
same value; the read-only span had no test or e2e reference.

**Review 2026-08-12 (commit `0a38733`). Five lenses, sixteen confirmed, four refuted —
seven distinct defects.**

**`takenBy` could not see the trash.** The store never loads soft-deleted containers, while
`projects_user_id_name_key` is a plain unique index that **spans** them — 6 of 10 projects
on the live database are trashed and still holding their names. Renaming onto one passed
the guard and produced exactly the split write it exists to prevent; the review reproduced
it against production inside a rolling-back block (container write 23505, fan-out 12 rows
succeeded). **The two writes are now chained**, so a rejected container rename can never
leave the members rewritten. A better *message* needs the trashed names — Phase 4.

**Undo of a rename NULLed every member's id, and that was mine.** 81c5c21 put the
resolution in `updateItem` behind *"a name write with no id is an agent re-file — the store
always sends both halves."* False: the fan-out rewrites members' `project` in the same
`set()`, so undo's `diffItem` yields exactly `{project: <old name>}`. Resolved there it
read as a re-file into a container whose name had not been restored yet (the item loop runs
before `syncContainers`, both unawaited) and wrote `project_id = null` across the
membership. **Moved to `updateTask`/`updateHabit`** — `lib/agent-api.ts` is their only
caller — so an explicit entry point decides, not the shape of a patch. *Second time a
comment of mine asserted something the code did not do.*

**`lookupContainerId` folded case for projects but not groups** — and on update that wrote
NULL over an already-correct id. Groups now fold with a second small query rather than
`ilike`, because a group named `100%` or `a_b` would otherwise become a wildcard.

**A rename invalidated persisted filters.** `canvasFilters`/`braindumpFilters` store
`project:<NAME>` in localStorage; a stale ref matches nothing, so the view **empties** with
only a chip naming a vanished project as the clue. `renameContainerRef` lives in view-store
and is called from the rename site — view-store imports planner-store, so the reverse would
close a cycle.

Plus: a refusal sentence outlived its draft and was re-parented onto the next container;
Enter blurred even when refused, stranding the name (the Escape rung needs focus); and one
more test that could not fail — the PGRST204 guard's create-path assertion collapses "no
such container" and "cannot ask" into the same output.

### The review pattern has a hole: FIX commits were never reviewed

**Three fix commits in a row introduced a bug**, and each was caught only because a later
phase happened to sweep the same code:

| commit | was fixing | introduced |
|---|---|---|
| `81c5c21` | Phase 0's review | undo NULLing every member's `project_id` |
| `0a38733` | Phase 0b's review | the chained fan-out outrunning undo; the filter remap with no inverse |
| `49705b0` | *(Phase 4 itself)* | a subtask-restore rule keyed on two clocks agreeing; an unlatch that could never fire |
| `2b65db4` | Phase 4's review | a rollback that could soft-delete the whole account on one ⌘Z |
| `ced2230` | `2b65db4`'s review | a name the app then refused to let the user retry, all session |
| `198a259` | *(Phase 5 itself)* | a delete confirm promising the return of items that never left |
| `4dff3c3` | *(Phase 6 itself)* | a seed that could commit one account's plan into another account's store |

**`2b65db4` is the one to remember, because the defect was in the SAFETY NET.** It
healed a phantom container the database had refused — a real data-loss bug — and to do
that it popped the failed create's history entry. Two ways that went wrong:

*It cleared `isUpdatingUndoRedo` unconditionally.* That flag is a plain boolean, not a
counter, and `initializeStore` holds it true across its **entire** fetch while `userId`
is already stamped — so a create issued in the load window really does reach the
database. Rejecting there handed the flag back unblocked, woke the history subscriber's
lazy-baseline branch mid-load, and left `historyIndex` naming a snapshot the store did
not hold. One ⌘Z then soft-deleted **every row the load had just brought in.** Reproduced
by an A/B probe whose only variable was whether the create resolved.

*And popping an entry needs preconditions that hand every other case back to the bug.*
The entry must still be the top and the user must not have moved — but the item dialog's
own Save flow guarantees they have. In every refused branch the store lost the phantom
while the snapshots kept it, so one ⌘Z put it back and fired `dbRestoreProject` against a
row that never existed. All three tests stopped one keystroke short of it.

The rewrite does no index arithmetic at all: it strips the phantom from every snapshot
and relabels the entry. Stack length, log length and `historyIndex` are untouched, so the
invariant cannot be broken by that function under any interleaving.

**The lesson that generalises: a fix for a data-loss bug is itself a data-loss risk, and
it deserves a heavier review than the feature it patches — not a lighter one.** The
instinct is the opposite, because a fix feels small.

`0a38733` was the first fix commit to get a review of its own (`18dad7f`), and it found two
HIGH defects immediately. **Review the fix, not just the build.**

**Five for five now** — `ced2230`, the rewrite that removed the index arithmetic, was itself
the fifth. It is a milder bug than the one it replaced (an unusable create row, not lost
data), but it is the same shape: the rollback removes a container from `state.projects`, and
`useTrashedNames` cannot tell that apart from a delete, so a refused name stayed refused for
the visit. **A fix that makes a store look like it did something is a fix that lies to every
subscriber watching for that something.**

**And the shape repeats: the bug is always in the part that looked most
carefully reasoned.** Every one of these was a deliberate mechanism with a paragraph of
justification above it — the resolution moved to `updateItem` "because the store always
sends both halves"; the fan-out chained "so the writes cannot split"; the cascade matched on
a timestamp "because the delete already encoded which children belong to which gesture". The
comment is what made each one survive a read. **A mechanism that needs a paragraph to defend
is the first place to point a mutation probe**, and the paragraph should be treated as a
claim to test rather than as evidence.

### Vacuous tests are the other half of the same pattern

Seven now, across the branch. Two were caught during Phase 4's own build (a stale label is
only observable through a mutation that does not self-label; a second `set()` has nothing to
change until the member exists), and four more by the review's mutation pass: `rounds DOWN`
used 25 hours, where `floor` and `round` agree; the clock-skew guard used one hour, already
covered by the `hours < 1` branch; nothing pinned any mapped entity field but `itemIds`; the
group re-file had no end-to-end case.

**The rule that catches them: write the test, then break the code and watch it go red.** Nine
probes during the build, six more during the fix — every claim in Phase 4's suite has a
recorded red behind it. A test whose failure you have never seen is a guess about what the
code does.

**Phase 5 found the subtlest one yet, and it was green for a reason no reading would catch.**
`sorts a holder with no return date LAST` used two blockers and passed with the comparator's
`!da` branch INVERTED — because a two-element `Array.sort` calls the comparator exactly once,
in whichever direction the engine chooses, so one of the two undefined branches is never
evaluated and is free to say the opposite thing. The generalisation is worth carrying:
**a comparator test whose fixture count equals its branch count proves nothing about the
branch that did not run** — assert the same answer from a reversed input, and add a third
element so the sort actually sorts.

Phase 5's other probe was the opposite result and just as useful: the picker's cursor clamp
survived deletion entirely, because every path the *user* can move a cursor along was already
bounded at the point of the `setCursor`. Rather than delete it, the reachable trigger was
identified — the candidate pool shrinking beneath an open picker, which the "stays open after
an add" change made a much longer window — and pinned. **A guard nothing can break is either
dead code or an untested case; deciding which is the point of the probe.** (The review then
found the clamp had a hole on the *other* side, which that reasoning had walked straight past:
the comment asserted the user could not move the cursor out of range, and ↓ on an empty list
does exactly that. **The probe proves what it mutates and nothing else.**)

**Phase 5's review added three more, ten across the branch, and one is a new species: a test
that cannot fail because there is nothing to discriminate.** The `isConnected` branch in the
confirm dialog was written with a paragraph explaining what it prevented; it prevents nothing,
because on a trigger-less Radix dialog "preventDefault then focus a detached node" and Radix's
own "preventDefault then `trigger?.focus()`" land focus in the same place. Measured both ways.
**When a test for a guard cannot be made to fail, the next question is whether the guard does
anything at all** — the honest outcomes are to delete it or to say plainly that it is
contract, not effect. What is not honest is a comment claiming a behaviour and a green test
implying it was checked.

The other two were ordinary and both about fixtures too weak to reach the claim: the type-glyph
test compared two rendered icons and passed with the entire registry half deleted, because
`CategoryIcon`'s name-hash fallback already distinguishes "Task" from "Habit" — *it tested the
fallback and was named after the feature*; and "stays open after an add" never typed, so its
`toHaveValue('')` was true before the add as well as after.

**Phase 6's review found five more — fifteen across the branch — and one of them let a HIGH
through.** The account-switch test gave its `snapshot` dep a CONSTANT thunk, so nothing ever
changed under any await: it proved the guard existed and never that it fires, and the defect
walked straight past it. ***A test for a race whose fixture cannot race is a test for the
absence of a race.*** Two more were a hand-rolled fake Supabase client that could not produce
an error, which made both "this THROWS" claims in `lib/db.ts` untestable — replacing either
`throw` with `void error` left the whole file green. **A fake that can only succeed tests the
happy path while reading as if it covered the contract**; the fix was a `writeFails` flag, not
a new assertion. The fourth named itself after a PostgREST guarantee no fake can demonstrate
("so it cannot clobber settings") and was renamed to what it actually checks. The fifth was a
plain gap: the trim was untested, which is exactly why its divergence from the database
survived to be found by someone else.

**The chained fan-out outran undo.** Chaining fixed the split write but moved the dispatch
AFTER undo's per-item writes, so a ⌘Z inside the container write's round trip was
overwritten when the chain resumed — container reverted, members kept the undone name, and
**it survives a reload** because `items.project` is plain text with no join. The deferred
write now re-checks the container still holds the name it is fanning out.

**`renameContainerRef` was optimistic with no inverse** — a NEW way to empty the canvas, and
worse than a stale ref because localStorage survives the repairing reload. Now driven by a
planner-store subscription keyed on container **id**, so rename/undo/redo are one case.
*Gap left open:* a DB-rejected rename leaves the store optimistic, so a reload can still
strand a ref. Carrying ids in the refs is the real fix and is a persisted-format change.

### The e2e spec ran for the first time (`ba632fd`) — and static review had missed both

Three phases of adversarial review passed over a spec that had never executed. Its first run
found an **app-level data race no lens caught**, because no lens ran the app.

- **`initializeStore` replaces `projects`/`habitGroups`/`items` wholesale** when its fetch
  resolves, so anything written between mount and that resolve is silently discarded.
  Reachable by a real user on a slow connection. `data-loaded` on `view-root` is the signal
  `waitForAppReady` was missing — note `userId && !isLoading`, because `isLoading` is FALSE
  at rest and the bare check passes before the fetch is even issued.
- **The suite could not run honestly from a worktree.** `localhost:3000` was hardcoded in
  four places and `reuseExistingServer` ADOPTS whatever owns the port — so a second checkout
  silently tests another branch. All four derive from `BASE_URL` now (`E2E_BASE_URL` to
  override). The worst was `global-setup`'s storageState **origin**: a mismatch is not an
  error, the localStorage seed just never applies.
- The dedicated e2e user is `a2afc7e7` / `dsul-e2e@dsul.test`, confirmed separate from
  the personal account, and owns **zero habit groups** — which is why `removeHabitGroup`'s
  `'Personal'` fallback fires there.

*Full suite:* 82 passed / 22 failed / 22 did not run. **None attributable to the readiness
gate** (its message appears nowhere), and the pass count is up on the config's documented
79/13 baseline. The residue is the shared-test-user contention the config already describes.

*Still open, deliberately:*
- Delete clears both halves in the store while the DB row keeps them, so a restore can
  reconnect members. Pre-existing; **027 makes fixing it possible and does not fix it.**
- **Renaming through the agent API does not fan out** — the fan-out lives in the store
  action, and `/api/agent/projects/[id]` calls `dbUpdateProject` directly. No shipped agent
  can reach it (the plugin registers no project/group tools), but it is a live endpoint.
- **Undoing a rename cannot revert soft-deleted members** — the store fan-out maps over
  `state.items`, which never holds trashed rows, while the DB fan-out is unfiltered.

All three are Phase 4's.

`items.project` / `items."group"` stop being name references. **The text columns are
KEPT, not dropped** — rollback ballast, and the permanent legacy agent projection still
has to emit a *name*. `/api/agent/context`'s `tasks[]`/`habits[]` and the
`tasks.updated`/`habits.updated` webhooks must stay **byte-identical**: the OpenClaw plugin
`safeParse`s the whole response and throws on drift — and a uuid would still *parse*,
because both fields are `z.string()`, so the failure would be silent and would feed ids to
a model with no id↔name map.

Unblocks: renaming projects and habit groups, which deletes the two honest-sentence
mitigations from the detail spec.

**Four findings from the blast-radius survey. Each one is a way this lands looking
correct and is not.**

1. **`ON DELETE SET NULL` on a composite FK nulls EVERY referencing column** unless given
   a column list — and `items.user_id` is `NOT NULL`. So the obvious
   `foreign key (project_id, user_id) references projects (id, user_id) on delete set null`
   makes the nightly `purge-deleted-items` cron abort with `23502` on the first purged
   project that outlived its children. Use `on delete set null (project_id)`, which is
   **PostgreSQL 15+**, and have the migration *assert* the version rather than silently do
   the wrong thing. The composite key itself is not optional: Postgres validates FKs with
   table-owner privileges and **ignores RLS**, so a bare `references projects(id)` plus
   own-row RLS is a cross-tenant existence oracle.
2. **No migration creates `projects` or `habit_groups`.** Thirteen tables are created
   across `supabase/migrations/`; neither of those is among them. They exist only in the
   stale `schema.sql` that CLAUDE.md forbids authoring against — so their live shape,
   including whether `(user_id, name)` is unique, is *inferred*. The backfill needs
   `to_regclass` guards (the SQL mirror of 024's `unavailable()`), and must not depend on
   a uniqueness constraint that may not be there.
3. **The id column must also enter `taskShape` AND `habitShape` in `packages/types`**,
   additive-optional, following the `parentItemId` precedent — or **undo silently
   reverts wrong**. `diffItem` (`planner-store.ts:576`) iterates
   `getItemTypeConfig(...).fields`, which is `Object.keys(taskShape)`, so a field outside
   the shape never enters an undo patch: undo would send the *old name* back and leave the
   id pointing at the new container. Then `pnpm --filter @dsul/types build` with
   `dist/` committed **in the same commit** — CI fails on drift.
4. **The deploy window is real.** Vercel builds on push; `db:push` is manual. The app must
   omit the id columns from every insert row until something actually sets them (the
   `pauseColumns` pattern 024 introduced for exactly this), because PostgREST rejects an
   INSERT naming a column absent from its schema cache with `PGRST204` — which would take
   out *every* item create, not only container-bearing ones.

**Scope discipline:** make the ids authoritative and have rename fan the new name out to
members' text column keyed on the id. Do **not** convert the ~15 name-keyed UI call sites
in this pass. The orphaning bug is fixed by the fan-out alone, and every name-keyed
surface keeps working unchanged because the text column stays correct. Converting the UI
is separate work and should not ride along.

### Phase 1 — Foundations and truth fixes. No new surface.

Ships against the two dialogs that exist today.

**Status 2026-08-11 — done: the risk spike (green, see below), `lib/collections.ts`, both
live bugs, the delete-copy debt, the keyboard guard, `--shadow-elev-plate`. Remaining:
`focusId` threading and the item-dialog chips.** Suite at 757/757, lint clean, build green.

> **Risk spike result: PASSED.** `tests/unit/organize-rail.test.tsx` proves
> `getByRole('tab', { name })` resolves against `TabsPrimitive.Root orientation="vertical"`
> whose list holds `role="presentation"` group headers, that roving focus steps over those
> headers, and that no eyebrow text leaks into a tab's accessible name. Two jsdom gaps had
> to be closed to get there and both are now shared: `Element.prototype.scrollIntoView`
> does not exist in jsdom and Radix calls it *before* `.focus()`, so arrow traversal died
> silently mid-handler (stub now in `tests/unit/setup.ts`, which the console needs anyway
> for `focusId`); and Radix defers roving focus into a `setTimeout`, so every arrow
> assertion needs a macrotask tick.

- **Risk spike first:** prove `getByRole('tab', { name: 'Programs' })` resolves against a
  `TabsPrimitive.Root orientation="vertical"` whose list contains `role="presentation"`
  group headers. Everything in Phase 2 rides on it.
- Extract `swapMembers`, `countLive`, `useLiveItemIds`, `useLiveRoutineIds`,
  `useNameDraft`, `parseLocalNoon`, `programPillLabel` → **`lib/collections.ts`**; update
  the single import at `tests/unit/group-by-routine.test.ts:3`. **No re-export left
  behind** — that is how dead paths survive for a year.
- **Two live bugs:** `useEffect(() => { setAdding(false); setQuery(''); }, [ownerId])` on
  both member lists (today an open search box and its typed query survive a two-pane
  selection switch, and Enter adds to the **wrong container**); and a **Cancel** on the
  routine-attach list (today `setAdding(false)` runs only inside `requestAttach`, so the
  only escapes are attaching something or leaving).
- **Pay the copy debt** (`manage-categories-dialog.tsx:329-333`) — with the 30-day clause,
  once (decision 4). Projects and groups **are** `⌘Z`-undoable and 30-day recoverable;
  `removeHabitGroup` **reassigns** habits to the first remaining group (falling back to
  the literal `'Personal'`) rather than unassigning them; item types genuinely cannot be
  undone and carry **no** warning today.
- Thread `focusId` through both existing variants; point `scope-rail.tsx:156-161` and
  `program-notice.tsx:54` at objects rather than tabs.
- Restructure the item-dialog chips (door 5).
- The two-line `use-command-shortcuts.ts` guard **+ a unit test**.
- Add `--shadow-elev-plate` to `globals.css`, both themes.

*Gate:* `pnpm test`, plus `programs.spec.ts` and `scope-rail.spec.ts` **unchanged** and
green.

### Phase 2 — The plate

**Status 2026-08-12 — built and wired. Build green, 845 unit tests, lint 0 errors.**
**Ten of the twelve doors are live. Two are NOT built and are not "retargeting" —**
door 4 (`⌘⇧,`) and door 6 (the user-card row) are net-new affordances that never existed
for either dialog, so there was nothing to retarget. Nothing advertises either one, so no
affordance lies; they are outstanding work, not a regression. Recorded here rather than
left implied by a ledger line that said "wiring included".

**Door 4 as specced cannot be built, and the plan was wrong to call `⌘⇧,` free.**
`lib/commands/keys.ts` deliberately does NOT push `shift` for a shift-produced symbol —
`e.key` already carries it, which is why `report_bug` registers `['?']` and not
`['shift','/']`. `⌘⇧,` emits `e.key === '<'` on a US layout, so `pressedKeys` returns
`['<','mod']` while `['meta','shift',',']` normalizes to `[',','mod','shift']`;
`matchesBinding` compares lengths first and can never match. Registering the specced
binding would paint a keycap in the shortcuts modal for a shortcut that never fires. A
working binding is `['mod','<']` — layout-dependent, and therefore a design decision to
take rather than wiring that was skipped.
Work moved to its own worktree (`D:/Code/v0-anchor-organize`, branch `feat/organize-console`)
after a parallel session in the shared checkout committed one of these edits into its own
history by accident. Branches are per-worktree, so a branch alone could not have isolated it.

**Twelve doors, not seven.** The settings-route rewrite added five `DESTINATIONS` records
(`dest.projects`, `dest.groups`, `dest.types`, `dest.routines`, `dest.programs`) between
the survey and the build. Their `action` union collapsed from
`manage-categories | manage-collections` to a single `organize`, and `tab` became `section`.
Their `where` now reads `Organize` rather than `Planner` — the old value described a dialog
reachable from two unrelated places; these five now live in one console with a name.

`ActiveDialog` gained `organize` (NOT `console`, as originally specced — `console` reads as
the browser's, and the variant should carry the product's name) and lost both old variants
outright rather than keeping aliases: two variants pointing at one component is how a
caller ends up opening the right surface on the wrong section for a year. Palette command
**ids and aliases are frozen** per decision 1 (`app.categories`, `app.collections`,
`projects`, `groups`, `routines`); only labels followed the rename.

**`focusId` is threaded and now reveals its row.** The ScopeRail's rows and the program
notice deep-link to a specific object, so `ObjectRow` scrolls itself into view with
`block: 'nearest'` when selected — a no-op when it is already visible, so ordinary
clicking never jumps the list. Scroll only, never focus: the plate's focus trap runs on
open and a second claim on the same tick lands the ring somewhere nobody intended.

**One defect found while moving, invisible to every reviewer.** `lib/collections.ts`
contained a literal **NUL byte** — `` `${id}\0${name}` `` where a separator was meant. It
parsed, ran, and passed every test, but git classified the file as binary and stopped
producing diffs for it, which is why five review lenses reading it as text saw nothing.
The composite key is gone; the two values are compared as two values.

Original status line: **the whole tree is built and green; only the WIRING is left.**
`organize-console.tsx`, `console-rail.tsx`, `primitives.tsx`, `detail-parts.tsx`,
`member-list.tsx`, `escape-ladder.tsx`, `sections/{routines,programs,labels}.tsx`.
184 unit tests green across the console files and their neighbours, lint 0/0, tsc clean.

Three departures from the file list below, each for a reason worth keeping:

1. **`sections/labels.tsx`, not three files.** Projects, types and groups are the same
   section three times over; the differences (a project's time block, a type's frozen
   slug and un-undoable delete) are a dozen lines each. Three files would have been
   three copies of identical scaffolding — the drift that put `lib/collections.ts` in
   the tree in the first place.
2. **`object-row.tsx`/`state-pill.tsx`/`key-cap.tsx` collapsed into `primitives.tsx`.**
   Every geometry in them is picked against the others; separate files hide that.
3. **The section filter moved UP from Phase 3.** The footer bar teaches `/`, so leaving
   it unbuilt shipped a promise the plate did not keep. It brought the Escape ladder
   with it.

**The load-bearing discovery, and it invalidates a comment in the old dialog too:**
Radix's `DismissableLayer` binds Escape with
`ownerDocument.addEventListener('keydown', handler, { capture: true })`
(`@radix-ui/react-use-escape-keydown`). It runs on the **capture** path at the document,
*before* the event descends toward the focused input — so **every `e.stopPropagation()`
Escape "rung" is dead code**, including the four in `manage-collections-dialog.tsx` that
have been shipping since it landed. A capture listener of our own on `document` does not
help either: same target, same phase, Radix registered first. The ladder therefore goes
through Radix's own `onEscapeKeyDown` prop (`escape-ladder.tsx`), where `preventDefault()`
keeps the plate open. Each rung self-guards on focus, so no ordering rule is needed and
two rungs can never both claim one press.

Original file list, kept for the record:
`console-dialog.tsx`, `console-rail.tsx`,
`object-row.tsx`, `member-list.tsx`, `state-pill.tsx`, `key-cap.tsx`,
`sections/{routines,programs,projects,types,groups}.tsx`.

Routine and program detail bodies are **moved, not rewritten** — every testid travels with
them. Projects, types and groups ship at today's capability **plus** the usage count and
(post-Phase-0) a real name field. `EditProjectDialog` stays mounted one more phase, opened
from the project detail's `Time block` row.

`ActiveDialog` gains `console` and **loses both** `manage-categories` and
`manage-collections`; `app-shell.tsx`'s two unconditional mounts collapse to one. Retarget
all seven doors. **Delete both dialog files in the same commit** so no dead surface
lingers. Add testids to the projects/types/groups half — **it has zero today and nothing
in `tests/` reaches it.**

*Gate, and this is the acceptance criterion, not a visual review:* `programs.spec.ts` and
`scope-rail.spec.ts` run **unchanged** and green, including both `closeManager` helpers
and the `getByRole('tab')` clicks. **Not yet met — it cannot be until the wiring lands**,
since the specs still drive the old dialogs. One change was needed to keep it reachable:
`ConfirmRequest` gained an optional `testId`, because the console routes its confirms
through the shell's single `ConfirmDialog` and `program-routine-attach-confirm` is a
selector `programs.spec.ts:207` depends on.

**Adversarial review, 2026-08-12 — five lenses, twelve findings, nine confirmed after an
independent refutation pass. All five distinct defects fixed; each has a regression test.**

1. **`setRoutinePaused`'s third argument could never be written — the store rejected it.**
   Found by four of the five lenses independently, all of which verified by *running* the
   action rather than reading it. The action opened with
   `if (isPausedOn(routine, todayStr, tz) === paused) return;`, an idempotence guard that
   also swallowed the one request that is not a no-op: a resume date on a pause already
   running. A resume date can only be picked while something is paused, so the parameter
   was unreachable from any UI, and the console shipped a picker that wrote nothing. Fixed
   by routing the action through `active.ts`'s **`resolvePauseWrite`** — the module that
   already defines what the pause verb means in columns, and which already documented this
   exact case ("Already paused: honour a new resume date, but leave `pausedAt` where it
   is"). Every previously-supported call resolves identically. `until` is now
   `string | null | undefined`: undefined is "not specified" (keeps the toggles
   idempotent), null is "clear", a string is a day.

   *The test that missed it is the lesson.* It replaced `setRoutinePaused` with a
   `vi.fn()` and asserted the call — proving the button was wired to a **name** while the
   column never moved. Store-writing controls get tested against the real action.

2. **`Auto` on the colour picker was a silent no-op for all three label sections.**
   `ColorSwatchPicker` says "clear the stored colour" by calling `onSelect(undefined)`,
   and the defensive key-by-key patch rebuild filtered on `patch.color !== undefined` —
   dropping precisely that case, producing an empty patch that the store spreads to
   nothing and `dbUpdateProject` discards before building a query. A swatch you could set
   and never unset, and a regression against the dialog being replaced. The discriminator
   is **key presence** for the optional colour and **value** for the NOT NULL glyph; both
   now live in one `renameIconKey` helper that states why they differ.

3. **`focusNew` re-fired on every return to the opening section**, because it was a prop
   rather than a latched arrival and Radix remounts a section's subtree. Arrowing back to
   Routines ripped focus off the rail into the create field. Now spent on the first
   section change and re-armed by a fresh open.

4. **480px of fixed columns inside a 393px bottom sheet.** A 180px rail plus a `shrink-0`
   300px list, in a vaul wrapper that is `overflow-x-hidden` — so the add button, the
   count column, the state pill and the drill-in chevron sat in 119px of unpannable,
   untappable space. The list is now `flex-1` below `md` and exactly `w-[300px] shrink-0`
   above it, so the desktop 180 | 300 | 456 arithmetic is untouched. The fuller mobile
   answer (the rail becoming its own drill-in level) is still open.

5. **`created()` matched names exactly while `addHabitGroup` de-duplicates
   case-insensitively**, so "personal" against an existing "Personal" created nothing,
   returned null, and wiped the selection with no explanation anywhere. Exact-first then
   case-folded — projects compare exactly and really do create a second row, so a
   fold-only lookup would select the older one.

Three findings were refuted and the reasoning is worth keeping: gating
`RoutineMemberList`'s Escape rung on focus would **break** it (nothing in its candidate
list ever takes focus, so the rung would decline and the plate would close instead);
`focusFilterOnSlash`'s bare-`ctrlKey` test mirrors the already-shipped
`settings-shell.tsx` predicate and the `keys.ts` MOD rule governs the binding registry,
not ad-hoc handlers; and `focusId` not scrolling its row into view is unreachable until
the doors are retargeted, which is the wiring this phase still owes.

**A hazard that turned out not to exist, recorded so nobody re-derives the fear.**
Radix's `Tabs.Content` renders `{present && children}`: the panel element exists for
every section but only the ACTIVE one has a subtree. Probed, not assumed — a render of
the plate finds one `organize-list`, one filter field, and five panels with zero
children. So no `data-testid` is duplicated and Playwright strict mode has nothing to
trip on. Two consequences worth knowing: switching sections **unmounts** the outgoing one
(filter text and half-typed drafts clear, which is the behaviour we want), and adding
`forceMount` later to preserve scroll would flip all of this — which is why the Escape
rungs and the `/` handler are scoped to `[data-state="active"]` even though nothing
requires it today.

### Phase 3 — Labels get depth, and the filter

**Status 2026-08-12 — built. 854 unit tests, lint 0 errors, tsc clean.**
`EditProjectDialog` is absorbed into `project-time-block.tsx` and **deleted**, ending the
modal-inside-a-modal. Item types gained label AND plural editing; slug validation speaks.
The section filter arrived early, in Phase 2.

**Absorbing it fixed three TypeScript errors that had been sitting in the file** — and the
reason they were there matters. `RepeatFrequency` has no `'weekly'`, so
`repeatFrequency === 'weekly'` was flagged as impossible; but `lib/day-items.ts:182` says
`'weekly' comes through the DB as free text on some rows`. The type lies about the data.
The new component therefore asks **"is this value day-driven?"** (`isDayDriven` — anything
NOT in `none|daily|weekdays|weekends|monthly`), which mirrors day-items.ts's `default` arm
exactly. Hard-coding `=== 'custom'` would have rendered a legacy row's block on the grid
while hiding the only control that says which days, leaving it uneditable forever. The
repeat `<Select>` also keeps an unrecognised stored value as a selectable option, because
Radix renders an EMPTY trigger when the value matches no item — "weekly" would have read
as "no repeat".

**The save contract converted as specced.** Discrete controls patch live; text and number
inputs buffer on blur and Enter (`BufferedInput`). The custom-minutes field is the one
this protects: live-binding writes `6` on the way to `60` and puts a six-minute block on
the grid for as long as the second digit takes.

**Two behaviours are new rather than moved.** The time-block switch writes all THREE fields
the resolver needs (`startTime`, `timeBucket`, `repeatFrequency`) — the old form could
leave `repeatFrequency` unset and the switch would read on with nothing on the grid. And
turning it OFF now clears only the two fields the predicate reads, so the duration and the
repeat survive: the old form wrote `undefined` across all of them, making the toggle
quietly destructive.

**Renaming an item type carries its plural, but only an untouched one.** `labelPlural`
follows a rename when it is still exactly `${label}s`; once someone has written "People"
for "Person", a later rename leaves it alone. That pair is why label editing waited for
the plural field instead of shipping alone.

*Gate status:* `tests/e2e/organize.spec.ts` is **written but NEVER EXECUTED** — the
worktree has no `.env.test` and no Supabase access, so nothing has run it. Treat it as a
draft that needs one green run before it means anything. `cleanupTestLabels` is new
alongside it: `cleanupTestCollections` only ever swept `routines`/`programs`, so a spec
creating projects would have littered the shared test user every run.

**Review 2026-08-12 (commit `9485675`). Four lenses, seven findings confirmed, four
refuted.** Three defects, and each is a different way for a control to look correct.

**"Custom…" was an inert menu option.** Absorbing `EditProjectDialog` dropped the one piece
of state it carried (`isCustomDuration`). Derived from the stored duration alone, picking
Custom… wrote nothing → `isPreset` never moved → the controlled Select snapped back → the
field never mounted. Every project starts at a preset and this console is the app's ONLY
writer of `Project.duration`, so no custom length was reachable anywhere, and a project
already holding one lost it permanently on the next preset click. The mode is state again,
reset on `project.id` change (the detail pane reuses the instance across selections) and
latched on commit, so typing 90 into a field you deliberately opened does not collapse it.

**A confirming click on the lit part-of-day segment discarded the start time.** A segment
is a `<button>`, not a Radix Select, so a re-pick fires the handler and it re-seeded the
band opening — 14:30 under Afternoon → 12:00, on a gesture that changes nothing. The old
dialog was accidentally safe: Radix's `useControllableState` suppresses `onValueChange` on
a re-pick. Guarded at the call site, not in `SegmentedOption` — the routines/programs users
re-pick into idempotent writes and should keep working the way they do.

**Both new e2e tests were vacuous, identically.** Neither filed its fixture under the label
it deleted, so each ran the `n === 0` arm of the copy and then asserted an unrelated row
still existed. The project test would have stayed green if delete had removed every item it
owned. Fixed by naming the doomed container at create time (both columns are free text with
no FK, so the item may precede the row) and asserting the count clause, which fails loudly
if the association ever breaks again. The habit test now reads the destination out of the
copy and watches that row's count grow — **in-session, deliberately**: the reassignment is
store-only (`dbDeleteHabitGroup` stamps `deleted_at`, `items."group"` has no FK or trigger),
so a reload assertion would go RED on correct code. That is the parked
name-reference limitation; **Phase 0 is what would let these assert after a reload.**

**Why the entry path had never been tested: jsdom ships no Pointer Capture API.** Radix
Select's trigger calls `hasPointerCapture` on pointerdown, and a missing method THROWS
inside React's dispatch — so the menu silently never opens and the test still reports
green. Stubbed in `tests/unit/setup.ts` beside the `scrollIntoView` and `matchMedia` gaps,
which is what made a `pick()` helper possible. The new tests drive the real control instead
of calling `onValueChange`, because a synthetic handler call cannot reproduce a *controlled*
value snapping back — the whole bug. Three of the four fail against the unfixed component;
that was verified, not assumed.

**Refuted, and worth keeping refuted:** that `NON_DAY_REPEATS` mis-mirrors day-items.ts on
`'none'` (`lib/recurrence.ts` is canonical and agrees with the console; day-items.ts's
missing `case 'none'` is pre-existing and unobservable); that buffered fields commit twice
on Enter (they do — both writes are identical, the history subscriber JSON-diffs, and
`notifyPlugins` runs client-side against an empty registry, so it is one redundant idempotent
PATCH, not a defect); and that a committed `0100` sticks in the field (it self-corrects the
moment the value actually moves, and the deleted dialog held it longer).

Absorb `EditProjectDialog` into the project detail and **delete it**, ending a
modal-inside-a-modal. Convert its buffered `Cancel`/`Save Changes` contract to the
console's single save rule — **discrete controls patch live, every text and number input
buffers on blur and Enter** — which specifically protects the custom-minutes field. Add
item-type `label`/`labelPlural` editing (`updateItemType` has always supported it; the UI
only ever offered create/recolour/delete, so nobody can fix an irregular plural), and make
slug validation **speak** instead of silently disabling a button.

**Section filter** (decision 6): one field at the top of the list column, filtering the
**current section only**, placeholder naming the scope (`Filter projects…`), `/` and `⌘F`
to focus, `↓` onto the first match, and rung 2 of the Escape ladder to clear.

*Gate:* a new `tests/e2e/organize.spec.ts` covering the projects/types/groups half — the
coverage that half has never had. Release note: the project time block loses its `Cancel`;
the net is `⌘Z` plus the undo toast, which the buffered form never offered.

### Phase 4 — Trash

**Status 2026-08-15 — BUILT (`49705b0`), REVIEWED, FIXED (`1587e42`).** 959 unit tests,
lint 0 errors, build green, `organize.spec.ts` 10/10. A blast-radius survey ran before a
line was written (six lenses, 26 confirmed of 55) and six of its findings changed the
design; the adversarial review after found 35 more, of which the biggest was mine.

**`packages/types` was NOT touched, against this plan's own instruction — and that line
was the single instruction generating every types-side hazard in the phase.** Adding
`deletedAt` to `taskShape` turns `tests/unit/db-allowlists.test.ts` red, because
`TASK_FIELDS` is `Object.keys(taskShape)` and that suite asserts every field survives
`updatesToRow` (verified by running it: 907 passed, 1 failed). The natural way to make it
green — teaching `taskUpdatesToRow` the column — hands undo the ability to write
`deleted_at`, so a snapshot holding a stale stamp could silently soft-delete a LIVE item
with the purge clock part-spent. `Program.updatedAt` is the in-repo precedent for exactly
that trap and is deliberately kept OUT of `updateProgram`'s allowlist. And nothing would
ever read it: `fetchItems` filters `deleted_at`, so the field would be permanently
undefined in every Task the app or the plugin sees. The bin's row type is local to
`lib/db.ts`, which it had to be anyway — `itemFromRow`, `projectFromRow`,
`habitGroupFromRow` and the `RoutineRow`/`ProgramRow` interfaces are all module-private.

**`listDeleted` JOINS MEMBERSHIP, and the plan's literal spec would have destroyed data.**
`itemIds` is not a column — only `fetchRoutines` produces it, from `routine_items`, and it
hard-filters `deleted_at` — so a trashed routine has no other source for its members
anywhere in the codebase. A union over the five container tables alone seats it with
`itemIds: []`, and `reconcileMembership` writes membership ABSOLUTELY (`removed = current \
desired`): the first member added back, or a plain redo replaying the full shape, hard-
DELETEs every join row `deleteRoutine`'s soft delete exists to preserve. No soft delete to
recover from. **The stated gate passes either way** — the row is back on the canvas without
a reload — which is what makes it worth writing down.

**The subtask cascade, and the coupling that had to go.** `deleteItem` soft-deletes a parent
AND its children; `restoreItem` cleared one row, so a restored parent came back childless.
The first fix matched children on the parent's exact `deleted_at`, so a subtask thrown away
earlier would stay behind. The review killed it twice over: (1) `planner-store`'s
`deleteTask` fires its own `dbDeleteItem` per child AFTER the parent's, each computing a
fresh timestamp, and that write is unguarded while the parent's cascade is
`.is('deleted_at', null)` — so the child's own stamp always lands last, and the two diverge
in 0.3–2% of ordinary deletes; (2) `listDeleted` skipped a child whenever its parent was
trashed but rolled it up only when the stamps matched — **two predicates that are not
complements**, so a subtask binned before its parent appeared in NO bin row and no restore
could reach it. **The bin, the roll-up and the cascade now ask one question between them**
("is the parent in the bin"), which makes an invisible row impossible by construction. Cost:
a subtask deleted deliberately before its parent comes back with the parent.

**A live bug fixed on the way, and Trash is what made it fixable.**
`projects_user_id_name_key` and `habit_groups_user_id_name_key` are PLAIN unique btrees over
`(user_id, name)` — no `WHERE deleted_at IS NULL` — so a deleted container reserves its name
for 30 days while being invisible to the store. `addProject` de-dupes against live rows,
passes, `set()`s optimistically, and only then does the insert 23505 into a
`.catch(console.error)`. The user gets a project that opens, accepts a colour and a whole
time block — every write an `.eq('id', …)` matching zero rows — while any item filed into it
fails on `items_project_id_fkey`. Gone on reload, silently. Both create rows and both rename
fields consult the bin now. **Exact match only:** the index is case-SENSITIVE, so folding
would refuse names Postgres accepts.

The guard is a UNION of the server's bin with every container that left the live arrays this
session — not a fetch. The first version fetched once per section mount and justified it
with a comment that had the mechanism backwards ("the store still knows about it live, so
the sibling check catches it"): `removeProject` FILTERS the row out, so deleting a project
and retyping its name without leaving the section reproduced the phantom two clicks apart.
The union is fed by a store subscription rather than a refetch because `removeProject` does
not await its DB write and a refetch would race it.

**A tab switch was wiping the whole undo history, app-wide and pre-existing.** Supabase
re-emits `SIGNED_IN` on every hidden→visible transition (`_recoverAndRefresh` on a
visibility change, re-broadcast across tabs), and `initializeStore` clears `historyStack`,
`actionLog` and `historyIndex` and lands `canUndo: false` — while `hydrateSettings` five
lines above has guarded against exactly that event class all along. ⌘Z is the entire safety
net this console's delete confirms promise. **The unlatch reads `error`, not a rejection:**
the first version hung it on `.catch()` and was dead code, because `initializeStore` catches
internally and RESOLVES on failure. A net that cannot fire is worse than none.

Deferred items **(a)** and **(b)** close here: the rename guard can see the trash, and the
agent API's rename fans out — chained after the container write, never in parallel, since
the two do not fail together. Both agent routes now answer **409** with a sentence naming
the trash instead of a raw 23505 string, because the holder may be a row no endpoint can
show the caller.

*Still open, deliberately:*
- ~~`addProject`/`addHabitGroup` still seat a phantom for callers outside the console.~~
  **Closed by `2b65db4` + `ced2230`** — a refused create now rolls itself back out of the
  store, which covers the item dialog, the palette and anything added later; the item
  dialog also gained the proactive refusal. See the fix-commit table for what that cost.
  Residual, and narrower: if the user's Save wins the race against the rejection, that item
  is already lost to 23503 and nothing recovers it — the proactive guards are the plan, the
  rollback is the net. ~~And a rolled-back name is treated by `useTrashedNames` as
  deleted-this-session, so it stays refused for the rest of the visit.~~ **Closed by
  `d5dc2c5`** — see the rollback-leftovers entry below.
- **⌘Z after a restore severs the members' DB link.** `applyHistoryState`'s per-item diff
  yields `{project: undefined, projectId: undefined}` against the pre-restore snapshot and
  writes both NULL, so a second trip through the Trash returns an empty container. Rare
  (you have just deliberately restored the thing) and consistent with what the delete
  confirm promised. Fixing it means teaching the history diff that membership is the
  container's to own.
- **The trash door is desktop-only.** `UserCard` mounts in the desktop shell alone; touch
  reaches Trash through the `dest.trash` settings destination. A dedicated touch door is
  unbuilt.
- **`item_types` can never appear in Trash** — the table has no `deleted_at`. Their delete
  already says so, and it is the only one wearing the filled destructive button.

*Gate:* delete → find in Trash → restore → the row is back on the canvas without a reload,
and `⌘Z` re-deletes it. **Met, and the member half nearly was not tested.** The first
version of the gate created the task BEFORE the project, so `items.project` held the name
while `project_id` stayed NULL — the parked name-reference case — and the re-file had
nothing to reconnect: the claim was not merely unasserted but unreachable. Creating the
project first makes the agent-side create resolve a real id.

### The rollback's leftovers (`d5dc2c5`)

Four findings from the rollback's review, and one was a bug the rollback itself created.

**The name it refused to give back.** `useTrashedNames` watches containers LEAVING the live
arrays, because one binned mid-visit is gone from the store and not yet in the fetched bin.
`undoFailedCreate` makes a container leave the live arrays too — and from outside, the two
are indistinguishable. So a create the database refused blacklisted its own name for the
rest of the session: the user, having just read "Nothing was saved", tries again and is
refused with a sentence that is false, pointing at a Trash the row is not in. Only a reload
cleared it. The store now publishes `wasNeverCreated(id)`. A 23505 loses nothing by the
exemption — a trashed row really does hold that name, and the server list already carries it
under its own real id.

**The undo toast was already safe, but nothing was holding it that way.**
`useUndoToast` decides "is this new?" from `actionLog[0].id`, so POPPING an entry slides the
previous one into the front and re-raises its toast minutes late, with Undo now wired to a
different step. Real against the first design; dead since `ced2230` replaced the pop with a
relabel. But the reason it is dead is a property of the LOG — ids stable, length never
shrinks — not of the rollback. Three tests hold that property now; restoring the pop turns
all three red, the first with the original symptom.

**Four SELECTs before anything was open.** Both `ItemDialog` instances (app-shell's modal,
desktop-shell's docked panel) are mounted all session, and each bin lookup is two queries.
Gated on `!!state`, which also makes the answer fresher than a mount-time read; co-mounted
hooks share one in-flight request, dropped on settle — sharing a pending request is free,
sharing a settled one would hide a container binned since.

**And three tests that would have passed anyway.** `keeps the undo flags honest` watched
`canUndo`/`canRedo` in ONE state each for the whole test, so it passed against a rollback
that did nothing AND against one that corrupted the index. The label reordering from
`2b65db4` (`setNextActionLabel` moved after the de-dupe guard) was pinned by nothing at all
— armed before the guard, a duplicate create leaves the label on a module-level variable for
the next unlabelled mutation to be logged and undone under.

### Phase 5 — Routine correctness and reach

**Status 2026-08-16 — BUILT (`198a259`).** 1019 unit tests, lint 0 errors, build green;
e2e scope-rail 5/5, programs 3/3, organize 10/10.

**(a) was already done** — Phase 2 shipped the `Comes back` DayField wiring
`setRoutinePaused`'s third argument. **(b) is the phase**, and the fix is architectural
rather than local: `routineStandingOn` in `lib/active.ts` is now the ONE derivation of
local-vs-effective, and `buildScopeRows` was rewired to call it. The console had its own
partial copy — `isPausedOn` alone — which is why it rendered `Active` with un-greyed members
and a delete confirm claiming nothing would return, one column from a rail saying `off`.
Two implementations of a disjunctive rule is exactly how that happened, and the disagreement
is invisible unless someone has both surfaces open.

The switch still shows LOCAL (it is the value it writes); the note, the greying and the
delete consequence read EFFECTIVE. **The delete copy was wrong in the program case
specifically:** deleting the routine removes the whole activation path, so program-held items
DO come back — the local-only check stayed silent about the half a user most wants before
pressing Delete.

`IN N PROGRAMS` navigates. `onNavigate` sets section AND selection, deliberately unlike
`onSectionChange`, which clears it — clearing is right for the rail and wrong here, where the
id is the entire point of the move.

**(c)/(d)** landed with the type glyph coming off the REGISTRY (`glyph` on `ItemTypeConfig`,
a custom type's own icon) rather than a `type === 'habit'` ternary, so a new type needs no
code. The picker browses on an empty query, shares one cursor between pointer and keyboard,
and stays open across adds — which broke two e2e helpers that re-clicked the opener, now
idempotent.

***A focus bug the gate found, and it was app-wide.*** The confirm prompt is shared and
store-driven, so it has no `<AlertDialogTrigger>` — and Radix closes modal content with
`preventDefault(); trigger?.focus()`, which cancels FocusScope's own restore and then focuses
nothing. Dismissing ANY confirm in the app dropped the cursor on `<body>`, so the next Tab
restarted from the top of the document. Deciding *not* to delete is the ordinary outcome of
reading a delete prompt. Fixed by capturing in `onOpenAutoFocus` (before FocusScope moves
focus) and restoring in `onCloseAutoFocus`, guarded on `isConnected` so a confirmed delete
does not chase the control it just unmounted.

**Two mutation probes changed what shipped**, which is the practice earning its keep again:
- The picker's cursor **clamp survived deletion** — every path the *user* can move the cursor
  along is already bounded, so the clamp's only reachable trigger is the pool shrinking
  underneath an open picker (an item deleted in another tab, the agent API, a redo). Now
  tested that way.
- The blocker ranking **passed with its `!da` branch inverted**. A two-element sort calls the
  comparator ONCE, in whichever direction the engine picks, so a two-item fixture exercises
  one of the two undefined branches and leaves the other free to say the opposite. The
  ranking assertions now run both array orders and a three-item case. *Generalisation: any
  test of a comparator with fixture-order-dependent branches is suspect until it asserts the
  same answer from a reversed input.*

**Status 2026-08-16 — REVIEWED, FIXED (`bea1b25`).** 1025 unit tests over five
consecutive green full-suite runs, lint 0 errors, build green; e2e organize 10/10,
scope-rail 5/5, programs 3/3.

***The review's HIGH was mine, and it was the same shape as every other one on this
branch: the false claim was inside the longest comment the phase added.***
`routineStandingOn` answers *is this ROUTINE carrying anything*; the pane spent that
answer as *is this ITEM on the user's day*. Those differ exactly when an item has a
second live path — the situation the disjunctive rule exists to create. A habit in
Morning **and** Evening, with Morning inside an out-of-season program, was greyed,
described as hidden, and carried a delete confirm promising *"and they come back into
view"*. It never left. The mirror is worse: an item reached both through the routine and
directly by the same off program is dead either way, and the confirm promised its return
too. **So the commit's headline was half true — it swapped one disagreement with the rail
for another.**

The right shape was in the repo twice already (`ScopeRow.flips`, `wouldHide`), which is
the tell: *when a correct pattern exists and the new code does not use it, the question
is why, not whether.* It is now `membersRevealedByRemoving` so there is no third copy.
The held note also had to split into TWO SENTENCES with two subjects — "every program
holding it is off" is true of the routine while "its items are hidden" is only true of
some of them, and running them together is what made it lie.

*Also found:* the picker cursor had no LOWER clamp (`Math.min(1, -1)` on an empty list
parks it at −1, and it stays there when the list refills); a live program was reported
as "carrying" a routine the user had paused, three lines under "hidden until you
resume"; the picker lost its only touch-reachable exit when it started staying open
across adds (no Escape key below `md`); the routines LIST column still answered
local-only, so one section's two columns disagreed; and `TypeGlyph` hashed the LABEL
while the accent ramp hashes the slug.

**And the suite's 5s default was the real cause of the intermittent reds** — always by
timeout, never by assertion, and in `eod-dismiss` as well as the new gate, so a per-file
exemption would have patched whichever file happened to be measured. Raised globally to
30s in `vitest.config.ts`: it costs nothing on a green run and only bites on a genuine
hang. *A flaky gate is worse than a missing one — it teaches everyone to re-run a red
suite rather than read it.*

*Original plan text, for reference:*
(a) **Pause-until** — wire `setRoutinePaused`'s third argument.
(b) **The effective-state note and `IN N PROGRAMS`** — the highest-value correctness fix.
(c) **Member rows gain the type glyph and the meta column.**
(d) **Member picker rewrite** — browse on an empty query, ↑/↓ + ↵ with a visible cursor,
stays open after an add, and a `Nothing matches` row *inside* the list so arrow keys keep
meaning something.

*Gate:* an E2E case asserting the console and the ScopeRail agree about the same routine,
plus the focus-return case (open a row's delete confirm, Escape, assert the row still holds
the cursor) — the most commonly broken thing in web consoles and the most felt.

### Phase 6 — Seed defaults on first run *(decision 2)*

**Status 2026-08-16 — BUILT (`4dff3c3`), REVIEWED, FIXED (`62b9d92`).** 1080 unit tests,
lint 0 errors, build green. **Migration `028_containers_seeded.sql` is authored and NOT
applied** — the app is safe unapplied because the latch read fails closed on the missing
column, at the cost of one 400 in the network log per load.

***The live data changed the rule before a line was written, and reading it first is the
whole lesson of this phase.*** The plan said "seed when the sections are empty". The
database says the main account carries **763 items, ZERO container rows, and 119 habits
whose `group` text reads "Personal" with nothing behind it**. That rule would have written
three projects into an account that has visibly never used projects — inventing containers
to fix a problem about one. So there are three outcomes, not one: `new-account` (the full
starter set), `adopt` (only the containers existing items already name, glyphless so
nothing on screen changes), and `none`. 027 predicted the adopt half in its own comments
and left its backfill re-runnable for it; a migration cannot do it, because the rows appear
at an arbitrary later moment.

**The latch is a column, not an inference.** "No containers, so seed" makes the seeds
*undeletable* — delete them, reload, they return. Decision 2's "fully deletable" is a claim
about the NEXT load. localStorage fails the same way one device over.

**Numbered 028, not 025.** The remote ledger already carried 025 (`theme_palette`) and 026
(`user_extensions`) from branches whose files are not in this worktree. Numbering from the
local directory would have collided with two live migrations. *Ledger first, directory
second* — and this is the second time that check has paid.

***The review's two HIGHs were both mine, and the second explains the first.*** The
orchestrator re-checked the account and then did two more awaits with nothing re-checking
after, so a bare SIGNED_IN for a different user — which the provider already handles in two
other places — could carry one account's plan into another's store; with adoption in the
mix, account B receives a container named after account A's data. And `commit` returned
void, so every guard inside it was a silent refusal the caller could not see *after it had
already latched*: the account ended with zero containers and **no path that could ever
retry**.

That second one forced me to invert my own ordering argument. I had written a paragraph
defending latch-before-commit; the durable idempotence guard was never the latch, it is
`projects.length > 0` read back from the database, so rows landing without the latch
self-heal on the next load. **A long defence of an ordering is not evidence the ordering is
right.**

**The seed stopped touching history, and that fix had a bug of its own.** One entry meant a
brand-new account arrived with `canUndo: true` and one action its owner never performed —
and ⌘Z, the first thing many people try, soft-deleted all six rows into a Trash they have
never opened and reserved all six names for thirty days. Suppressing the entry then left
`historyStack[historyIndex]` holding the PRE-seed snapshot, so the first real edit plus one
⌘Z erased the starter set anyway. Caught by writing the test for the change; the
'Session start' snapshot is now rewritten in place.

*Also from the review:* a refused seed insert is rolled back like a hand-made one
(reachable with no fault at all — two tabs both read the latch as false and the second
insert meets the unique index); an account whose BIN holds containers is not brand new
(the e2e account has five trashed projects and zero live); and `planSeed` no longer trims,
because the adopting UPDATE filters on the name it is given and trimming made the store
link `" Personal"` while the database matched nothing.

*Original plan text, for reference:*

`DEFAULT_PROJECTS` and `DEFAULT_HABIT_GROUPS` are declared at `lib/planner-types.ts:87-97`
and **imported nowhere**, so a brand-new user opens a six-section console containing
nothing. They are also **stale in format** — bare emoji (`💼`, `🧘`) from before the
`icon:PascalName` token system; they need `makeIconToken` values before use.

Seeds must be named after real behaviour, fully deletable, and created through the normal
store actions so they are undoable like anything else.

---

## Empty states

**Law: the empty and populated states are the same layout with rows missing.** The list
head, the create row and the plate never change shape, so creating the first object never
makes the pane jump. No centered spot illustration, no dashed drop zone, no vertically
centered card in a void.

**The empty detail is the permanent home for the entity definitions.** Today those two
sentences live only in an empty state and vanish the moment one container exists, taking
the only in-app explanation of what a routine or a program *is* with them.

- Routines — `A routine groups items you want to pause together.` *(verbatim)*
- Programs — `A program is a stretch of life — a summer, a term — that switches whole routines on and off.` *(verbatim)*
- Projects — `Projects file your tasks, and can carry a repeating block on the grid.`
- Item types — `Custom types work like tasks — they get their own tab in the add dialog and their own section in Beacon's context.` *(verbatim)*
- Habit groups — `Habit groups decide how your habits are stacked in the sidebar.`
- Trash — `Anything you delete waits here for 30 days, then goes for good.`

**Copy law, throughout:** always an article + name — `your Summer term program`, never a
bare `Program`. `Program` is entity-only vocabulary; grid-side names (`isScheduled`,
`scheduleTask`, `ScheduleBlock`, "Add to schedule") never adopt it.
