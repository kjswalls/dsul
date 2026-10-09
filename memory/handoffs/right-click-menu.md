# Handoff: item right-click menu tidy

Thread: "Right-click menu tidy" (started 2026-10-07 by Kirby). State: shipped, idle, waiting on Kirby's pick of follow-ups.

## Shipped

- **PR #431** (merged to main 2026-10-07): https://github.com/kjswalls/dsul/pull/431
- Project, Routine, Season and Goal now sit under one **Organize ▸** row on the item right-click menu, when more than one of them applies. A lone container stays a plain row (nesting it adds a hop and saves no line).
- The Organize row previews what is set in the house "first +N" form (`membershipSummary` from `lib/item-bands.ts`): e.g. "Work +1", "Mixed" when a multiselection disagrees on any container, else "None".
- Priority and Remind stay on the menu. The multiselection menu gets the same grouping (both bodies share `EditSection`).
- Testids: group trigger `item-menu-edit-organize`, its flyout `item-menu-organize-content`; the inner rows keep `item-menu-edit-<key>`.

## Waiting on Kirby (proposed, not built)

Kirby was asked to reply with the numbers they want; no answer yet. Do them as one small follow-up PR off a fresh main.

1. **Copy link + Copy title → one "Copy ▸" row.** Both are rare. (recommended)
2. **Move "Reset streak" down beside Delete.** It's destructive and rare; today it sits next to Copy. (recommended)
3. **Drop "Open as page".** The item panel already has its own expand-to-page button (`components/planner/item-dialog.tsx` ~line 3085). (recommended)
4. Leave the rest alone: Done/Skip/Pause, Next day/Reschedule/To braindump and AI ▸ are everyday rows.

All three live in `SingleBody` in `components/planner/item-context-menu.tsx`. For #3, keep the `openHref` variant ("Open item", used by the Organize console's member rows) since the console can't host the item panel.

## Key files

- `components/planner/item-context-menu.tsx`: the menu. `SingleBody` (one item), `SelectionBody` (multiselection), `EditSection` + `CONTAINER_PANES` + `organizeSummary` (the grouping).
- `components/shell/bulk-edit-menu.tsx`: `useEditModel`, the shared property rows and option lists (`visibleRows`, `optionsFor`).
- `tests/unit/item-context-menu.test.tsx`: helpers `openSub` / `rowOf` (opens Organize first when present) / `openPane` / `summaryOf`; tests "keeps the containers under one Organize row…" and "leaves a lone container on the menu…".
- CLAUDE.md rules that apply: verbs come from `lib/item-verbs.ts`; build menus from the wrappers in `components/ui/context-menu.tsx`, never bare Radix; menu is pointer-only; no em dashes in app copy.

## Notes

- A CI unit-test failure on #431 was in `tests/unit/model-connection-panel.test.tsx` (unrelated): a `mcp-switch-panel` `toBeNull` assertion straight after a `waitFor` on status text races the panel's `onDone` close. One re-run passed. If it recurs, wrap those `toBeNull` checks (around lines 624 and 1097) in `waitFor`.
- Branch used: `claude/right-click-menu-tidy-2z9l44` (merged; restart it from main for follow-ups).
