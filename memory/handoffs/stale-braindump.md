# Handoff: helping a braindump that sits (thread "what can we do about a stale braindump")

Last updated 2026-10-09. Design stage only: no code, no branch work, no PR yet.

## Goal
Kirby's braindump had 15 undated items sitting for weeks (quick calls, errands, big projects and vague ones all looking the same weight). Find app features that make it less overwhelming and get things moving, then design and build the chosen one so it feels elegant and matches the app.

## Where things stand
1. Brainstorm: `memory/handoffs/braindump-ideas/brainstorm.md` (full idea list). Top picks were weekly sweep, size chips + quick wins, first step line, daily pick.
2. Kirby picked **size chips** to start, then asked to polish the idea.
3. Round 2: sizes as quiet sections (quick / errands / big / fuzzy) with always-visible "lenses". Kirby asked for subtle tint/shimmer on section headers and a single mode button instead of always-on lenses.
4. Round 3, **"do stuff" mode** (Kirby likes this flow): at rest the braindump is unchanged plus one "do stuff" button. Turning it on groups items by size under softly tinted headers (lime quick, blue errands, honey big, lilac fuzzy) with a one-time shimmer, shows an "up next" card (done / skip / put on today) walking quick, then errands, then big; only the current section is open; fuzzy items never come up next and point to "find a first step". Unsized items get sized first (4 tinted buttons, guess outlined, "keep all guesses"). Guesses come from the connected AI if any, else keywords like "call" / "pick up".
5. Kirby now wants to **iterate the UI piece by piece**, elegant, "a mix of Linear/Raycast and our existing chips/tags/buttons", and suggested the button be a rounded-rectangle chip **below the header, above the list**.
6. Piece 1 (the do stuff button) has four directions posted, awaiting Kirby's pick: A quiet chip, B ink bar, C hairline row with size dots (recommended), D Raycast command row. Each shows rest / hover / on.

## Links
- Design canvas (all rounds, boards 1 to 11 plus A to D): https://claude.ai/artifact/BePKEybXoucTnbNSdbSxcP (a Design-type canvas; edit by publishing files under `project/` to that url).
- Board sources (copy of the canvas files): `memory/handoffs/braindump-ideas/mocks/` (`canvas.json` + `*.dc.html`). Piece 1 is `BtnA..BtnD.dc.html`; the mode flow is `DoRest/DoMode/DoSort/DoDark.dc.html`.

## Open questions for Kirby
- Piece 1: which button direction (A, B, C, D or a mix)?
- Keep the "up next" walkthrough card, or only the tinted sections?
- Size vocabulary: quick / errand / big / fuzzy ("project" avoided, it is the app's container noun).

## Next steps
1. Get the piece 1 pick, refine it.
2. Piece 2: tinted size section headers (tint + shimmer variants, light and dark).
3. Piece 3: the "up next" card. Piece 4: sizing new items (and the hover 1 to 4 / size menu on rows).
4. Then build: likely a `size` field on items (migration; next free number per memory, check main and prod ledger), registry capability for braindump-eligible types, the mode in `components/sidebar/braindump.tsx`, guesses via `lib/item-asks.ts`-style AI ask with a no-AI keyword fallback. Single feature PR unless it grows; it touches stored data, so per the project rule that part may warrant the ultracode workflow.

## Style rules learned (match the app)
- Real header: `SurfaceHeader` (components/primitives/surface-header.tsx): grey well radius 10, white pill 37px radius 10, shadow-elev-sm. Chips: `PropertyChip` 28px, half radius, set = filled, unset = dashed. Buttons: ink default (#436), lime only as the Enter keycap or as state. Row metadata colour lives only in small dots/glyphs (components/primitives/pills.tsx "quiet rail").
- Lime never dims or fades through a parent's opacity. No em dashes or AI-isms in copy; lowercase playful voice; no time-of-day assumptions. Avoid Ctrl+D (browser bookmark).
