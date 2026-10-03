'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sun } from 'lucide-react';

import { MorningTriageList } from '@/components/ai/morning-triage-list';
import { usePlannerStore } from '@/lib/planner-store';
import { useMorningStore } from '@/lib/morning-store';
import { summarizeOverdue, type OverdueSummary } from '@/lib/overdue';
import { inactiveItemIdsOn } from '@/lib/active';
import { toDateStr } from '@/lib/recurrence';
import { NOTICE_RANK, type DockNotice } from '@/lib/dock-notices';

/**
 * The waiting notice — one line in the dock, with the list in a portal.
 *
 * "Waiting" to the reader, "past due" in the code: the predicate, the store, the
 * settings keys and the auto-age sweep all still use the internal name, because
 * that is what they compute. See the copy contract on BarCopy below for why the
 * visible word is different, and treat that contract as covering this file and
 * components/ai/morning-triage-list.tsx together.
 *
 * THE 50px CONTRACT IS GONE, AND SO IS THE REASON FOR IT. This surface used to
 * be a bar in the canvas column between the header block and the timeline, and
 * lib/use-fit-hour-px.ts:41 derives the schedule grid's hour height from
 * (viewport.clientHeight − anchorTop) — so every pixel of it was an input to the
 * grid, and its height had to be constant at every task count or hourPx fell to
 * its floor. It now lives in the sidebar dock, which nothing measures into. The
 * discipline survives the move anyway (components/sidebar/dock-notices.tsx caps
 * the stack), but it is now a choice about not crowding the braindump rather
 * than a load-bearing contract, and breaking it can no longer break the grid.
 *
 * Exports a HOOK, not a component: both docks render the same notice through
 * one row component, and only the tray body differs between them. See
 * lib/dock-notices.ts for the shape and the membership rule.
 */

/** Everything both platforms need, computed once. */
function usePastDue() {
  const items = usePlannerStore((s) => s.items);
  const morningCheckEnabled = useMorningStore((s) => s.morningCheckEnabled);
  const dismissedDate = useMorningStore((s) => s.morningCheckDismissedDate);
  const isOpen = useMorningStore((s) => s.isOpen);
  const open = useMorningStore((s) => s.open);
  const close = useMorningStore((s) => s.close);

  /**
   * The tray is state of THIS surface, so it dies with this surface.
   *
   * isOpen is one global flag and the notice mounts in two different docks:
   * AppShell swaps shells at the 768px breakpoint (app-shell.tsx:371 renders
   * exactly one), the desktop rows unmount when the sidebar column collapses,
   * and `goto.overdue` can flip isOpen from the omnibar. Without this, an open
   * tray leaks across every one of those boundaries and the NEXT mount inherits
   * it — narrow the window with the desktop tray open and the mobile Drawer
   * opens by itself; collapse the sidebar mid-triage and the Drawer is waiting
   * when you reopen it. Neither is anything the user asked for.
   */
  useEffect(() => close, [close]);

  /**
   * ...and it cannot open in the commit it mounts in, on EITHER surface.
   *
   * The unmount-close above means a stale isOpen can no longer SURVIVE to the
   * next mount, but it clears one commit late — it is a passive effect — so on
   * its own it still lets the incoming surface paint one frame with the
   * outgoing surface's open flag. Crossing the 768px breakpoint with a tray
   * open hits this in BOTH directions (app-shell.tsx:371 swaps the two shells
   * in a single commit), so the gate lives here in the shared hook rather than
   * on one platform: rendering closed until armed is what makes "never
   * auto-opens" literally true instead of merely intended.
   *
   * It costs nothing the rest of the time — `armed` is true long before any
   * user gesture, and `goto.overdue` (which reveals the surface first,
   * registry.ts:449) still opens on the commit after the mount.
   */
  const [armed, setArmed] = useState(false);
  useEffect(() => setArmed(true), []);

  /**
   * "Today" resolved through the user's SAVED timezone — the app-wide
   * convention (`toDateStr`), shared with hooks/use-day-items.ts,
   * week-schedule.tsx:256, task-row.tsx:77, planner-store.ts:350 and
   * lib/commands/entities.ts. `goto.overdue` and hooks/use-overdue-sweep.ts
   * resolve it the same way, so the notice, the command that opens it, and the
   * destructive auto-age sweep can never disagree about which day it is.
   *
   * Bare `format(new Date(), 'yyyy-MM-dd')` would read the MACHINE tz: for a
   * user travelling with a saved tz ≠ machine tz, an item would count as past
   * due here while the day view still showed it as today's.
   */
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const routines = usePlannerStore((s) => s.routines);
  const seasons = usePlannerStore((s) => s.seasons);
  const todayStr = toDateStr(
    new Date(),
    userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  );

  // Suppressed work is not past due — it is deliberately set aside, so it must
  // not appear in the count, the tray, or the copy. Resolved at TODAY (this is
  // a dateless surface; plan decision 3).
  const summary = useMemo(() => {
    const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    return summarizeOverdue(
      items,
      todayStr,
      inactiveItemIdsOn(items, todayStr, { userTimezone: tz, routines, seasons })
    );
  }, [items, routines, seasons, todayStr, userTimezone]);

  // n === 0 hides the notice — EXCEPT while the tray is open. The `|| isOpen` is
  // load-bearing: without it, actioning the last item yanks the tray out from
  // under the cursor mid-triage.
  const visible =
    morningCheckEnabled && dismissedDate !== todayStr && (summary.count > 0 || isOpen);

  // `isOpen` is the store's answer; `trayOpen` is the one any surface may
  // render from. `visible` deliberately keeps using the raw flag: the row must
  // stay on screen while a tray is open even at count 0, and that has to hold
  // in the pre-armed commit too or it would blink out from under the user.
  return { summary, todayStr, trayOpen: isOpen && armed, visible, open, close };
}

/**
 * dismiss(), with the keyboard put somewhere deliberate first.
 *
 * dismiss() writes morningCheckDismissedDate AND isOpen:false in one set
 * (lib/morning-store.ts:56), so `visible` flips false in the SAME render as the
 * click: the Popover root — the trigger Radix would restore focus to included —
 * unmounts before onCloseAutoFocus can run, and so does the ✕ / "Hide until
 * tomorrow" button the user just pressed. Focus falls to <body> and the next Tab
 * restarts at the top of the document.
 *
 * The old bar handed focus to its next sibling, which was the timeline column —
 * the thing that took its place. In the dock there is no such sibling to name:
 * when this is the only notice the whole stack unmounts, so the row's parent
 * dies with it. The dock capsule itself is what remains and what closes over the
 * gap, so that is the handoff target, found by name rather than by ref — one
 * fixed, labelled surface is a clearer thing to point at than a walk up a tree
 * whose shape depends on how many other notices happen to be present.
 *
 * Deliberately NOT ui-store's focusOmnibar(), the app's other focus verb: it
 * requires revealing the sidebar first (lib/commands/registry.ts:656), and
 * parking the caret in a text input makes hooks/use-command-shortcuts.ts:25
 * suppress n / e / Backspace / ⌘Z until the user blurs. Dismissing a line must
 * not cost you the keyboard.
 */
function useDismissWithFocus() {
  const dismiss = useMorningStore((s) => s.dismiss);

  return useCallback(() => {
    const host = document.querySelector<HTMLElement>('[data-dock-surface]');
    // Move focus out of the doomed subtree BEFORE the store update tears it
    // down: ordered this way the removal never has a focused node to orphan,
    // and Radix's restore-to-trigger then lands on a detached element, which is
    // a silent no-op rather than a reset to <body>.
    if (host) {
      host.tabIndex = -1;
      host.focus({ preventScroll: true });
    }
    dismiss();
  }, [dismiss]);
}

/**
 * THE COPY CONTRACT FOR THIS WHOLE SURFACE.
 *
 * This line is the first thing the user sees, every day, before they have done
 * anything. So it gets exactly one job: say how much is waiting, and open. It
 * does not grade the pile, it does not date the pile, and it never implies the
 * user owes anyone an explanation. If a future edit here needs a sentence to
 * justify itself, that is the signal it belongs somewhere else.
 *
 * What that rules out, and why each one was actually here:
 *  - "· oldest May 2". An aggregate age has one reading and it is "this is how
 *    far behind you are". The per-row stamps in the tray carry every bit of the
 *    USEFUL information (which day is this line about?) without summing it into
 *    a verdict. lib/overdue.ts has a longer note where the helper used to live.
 *  - "past due", as the visible noun. It is still the internal name of the
 *    predicate (lib/overdue.ts, useMorningStore, the auto-age sweep) because
 *    that is what it computes — but a bill is past due, and a bill has a
 *    penalty. "Waiting" is the same set of items with the blame taken out, and
 *    it is the word the drawer's own description has always used.
 *  - "from yesterday" was also a LIE: the predicate has no lower bound, which is
 *    exactly why April items once sat in a list titled "yesterday".
 *  - an unconditional "Good morning!" was a LIE — visibility gates on
 *    enabled && !dismissed && n > 0, never on the clock, so it greeted you at
 *    3pm. Conditioned on the hour it stays, because a greeting is the one thing
 *    on this line that costs the reader nothing.
 *  - "carry forward or clear them out?" is a question a collapsed row can't answer.
 */
function BarCopy({ summary }: { summary: OverdueSummary }) {
  const n = summary.count;
  if (n === 0) return <>All clear, nothing waiting</>;

  const beforeNoon = new Date().getHours() < 12;

  return (
    <>
      {beforeNoon && 'Good morning. '}
      <span className="font-semibold">{n === 1 ? '1 item' : `${n} items`} waiting</span>
    </>
  );
}

/**
 * The waiting pile as a dock notice, or null when there is nothing to answer.
 *
 * Ranked `decision`: this is a pile of items that will not move until the user
 * says what happens to them, which is the whole test for a line in the dock.
 */
export function useWaitingNotice(): DockNotice | null {
  const { summary, todayStr, trayOpen, visible, open, close } = usePastDue();
  const dismissAndMoveFocus = useDismissWithFocus();

  if (!visible) return null;

  return {
    id: 'waiting',
    rank: NOTICE_RANK.decision,
    icon: Sun,
    // The ONE coloured thing on this row. Everything else — the count, the
    // verb, the ✕ — is plain body ink, because honey in a container edge and
    // honey in body text is what made a planning surface read as a caution
    // strip. See the --sunrise-* note in app/globals.css.
    iconClassName: 'text-sunrise-glyph',
    label: <BarCopy summary={summary} />,
    actionLabel: 'Review',
    tray: (variant) => (
      // The page is NOT dimmed: there is no in-canvas scrim precedent, a scrim
      // would make this modal, and the day beside it is the DESTINATION of
      // every action taken in here.
      <MorningTriageList
        items={summary.items}
        todayStr={todayStr}
        variant={variant}
        onDismiss={dismissAndMoveFocus}
      />
    ),
    trayTitle: 'Still waiting',
    trayDescription:
      'Items still waiting from earlier days. Complete them, carry them to today, pick a new date, or move them to your Braindump.',
    open: trayOpen,
    onOpenChange: (o) => (o ? open() : close()),
    // Suppressed on touch by the mobile stack — a 24px destructive target
    // pressed up against a full-width tap target is a mis-tap generator, and
    // hover can't disambiguate them. Dismissal lives in the drawer footer's
    // "Hide until tomorrow" there instead.
    onDismiss: dismissAndMoveFocus,
    dismissLabel: 'Dismiss until tomorrow',
    // The suite has addressed this surface as `morning-bar` since it was a bar.
    // Changing where it lives and what it is called in the same commit would
    // make every failure ambiguous.
    testId: 'morning-bar',
    trayTestId: 'morning-tray',
  };
}
