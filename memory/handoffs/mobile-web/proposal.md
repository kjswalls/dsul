# Mobile web, aligned with the iOS app (proposal, 2026-10-02)

## Answer
Yes: align the STRUCTURE (same places, same names, same capture bar), keep the web's own LOOK (Look themes, Inter, paper cards) and use web interactions where iOS ones don't exist in a browser. Reasons: one person moving between the iPhone app and a phone browser should find things in the same place; mobile web is also the Android app (there is no Android build), so it can't copy iOS chrome.

## Today's mobile web (components/shell/mobile-shell.tsx)
- Three surfaces: Braindump, Today, Chat (Chat only while something can answer, lib/ai-registry.ts). No tab bar: a mode card in the bottom dock opens a "Go to" sheet (mode-switcher-sheet.tsx); a horizontal swipe walks Braindump · Today · Chat.
- Header card: title + date (calendar popover), a layout icon cycling Buckets/List/Schedule, the Display menu (sliders), avatar; the week strip under it. Day scope only.
- Bottom dock: mode card + omnibar ("Add a task or search…").
- Organize is a console dialog, opened from the braindump's folder button; it is an extension and can be off.

## Proposed (the iOS structure)
- Tabs: Today · Ask · Organize, plus a Search circle. Braindump stops being a tab and becomes the capture bar ("Get it out of your head", count on the right) that opens a braindump sheet.
- Top row: title + "date · layout", a layout capsule (List/Buckets/Schedule + Display…) beside the avatar; tapping the title opens the date picker. The week strip stays.
- Ask = today's chat (MobileChatPanel), with the iOS Ask header (load, needs you, agents at work).
- Organize = the console's panes as full pages: routines, seasons, goals, projects. Sections follow the extensions (Goals/Organize off → hidden or shut).
- Search = the ⌘K launcher (omnibar variant 'launcher') full-screen, with the four modes as chips.

## Where mobile web must differ
1. Browser chrome. In a Safari or Chrome tab, the capture bar + tab bar + the browser's own bar would stack three bars. In a browser tab the capture bar folds into the tab row as a lime + button carrying the braindump count; installed to the Home Screen it gets the full two rows like the app. (Detect with display-mode: standalone.)
2. Taps, not holds. iOS's press-and-slide menus don't exist on the web, and on touch a long-press is a drag (TOUCH_ACTIVATION_DELAY_MS 250). The capsule and title open on tap; a sideways swipe on the capsule may step layouts.
3. No swipe between tabs. Today's horizontal swipe fights Safari's edge swipe (back) and row swipes; drop it.
4. Braindump to an hour. Same drag as iOS (hold, the sheet slides down to a peek, drop on an hour), plus a tap path: the existing ScheduleSheet grows a time row, because touch drag in a browser is the least reliable gesture we have.
5. Back button. Android back and browser back close the open sheet or menu first (history entry per sheet).
6. Notifications. Web push reaches an iPhone only once dsul is added to the Home Screen; Android gets it in the browser. Done / Snooze 15m buttons show on Android; iPhone web push shows the text and opens the item. No Live Activity: Focus stays an in-app room.
7. Week. iOS has Day/Week; mobile web stays day-only until the iOS week view ships, then follows it.
8. Sign-in: same three ways (Apple, Google, email link); Apple on the web is needed anyway.

## Decisions for Kirby
A. Align at all? Recommend yes (structure only).
B. Bottom in a browser tab: one row with a + (recommended) vs the app's two rows everywhere.
C. Ask without a model: show the Connect a model setup in the tab (iOS does this) vs hide the tab as today. Recommend show the setup; the gate rule "AI surfaces hide while unknown or failed" still holds, since this only shows once the answer is a known "not connected".
D. Braindump as a sheet instead of a tab: recommend yes; the sheet keeps the Display shelf and grouping.
