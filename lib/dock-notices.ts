import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * The surfaces that can hold a notice in place.
 *
 * Deliberately a closed union rather than a string: an anchor is a promise that
 * some component mounts a slot for it (lib/notice-anchors.ts), and a typo in a
 * free-text anchor is a notice that silently never renders anywhere.
 *
 *  - `braindump`  — pinned under the braindump header, above the rows.
 *  - `day-header` — beside the date, in the canvas header row.
 *
 * `day-foot` (the foot of today's column) was built and removed before this
 * shipped, and the reason is worth keeping: lib/use-fit-hour-px.ts sizes the
 * schedule grid's hours to `viewport - anchorTop - BOTTOM_RESERVE` with
 * BOTTOM_RESERVE at 24px, and it counts only chrome ABOVE the grid — so a 34px
 * row below the grid inside the same scroller cannot be seen by it and makes a
 * compressed day scroll that previously fit. The header row has the opposite
 * property: its height is max(children), which the capsule already sets at 96
 * or more, so a line beside the date costs nothing at all. That is the same argument
 * ProgramNotice makes for the same address.
 */
export type NoticeAnchor = 'braindump' | 'day-header';

/**
 * The shape of a thing the app says first.
 *
 * dsul has two directions of speech and they used to be scattered. The user
 * speaks to the app through one input at the bottom of the sidebar; the app
 * spoke back from a 50px strip in the canvas, a modal, a `text-xs` line two of
 * six layouts rendered, and a five-second toast. A notice is the app's half of
 * that conversation, given one shape so it can be given one home — the dock,
 * directly above the omnibar. See components/sidebar/dock-notices.tsx.
 *
 * The membership rule is narrow on purpose and it is about DECISIONS, not about
 * importance. A notice earns a line here only if there is something the user
 * has to answer. A permanent fact about the world ("Summer is off") is not a
 * notice — it belongs on the thing it is a fact about, which is why a scope's
 * pause state rides its own switch (its group header, and the Display menu's
 * Paused-scopes list) and the day's suppression line sits in the canvas header
 * beside the date. Put standing
 * facts in here and the dock silts up into a notification centre nobody reads,
 * which is the failure mode this surface exists to avoid.
 *
 * WHAT CHANGED WITH DIRECTION E, and what did not. The membership rule above is
 * unchanged and still load-bearing. What moved is the ADDRESS: a notice that
 * has an object on screen now renders on that object (`anchor`, and
 * {@link placeNotices}), and the dock keeps at most one line — the highest-
 * ranked question with nowhere else to live. So the rule binds harder than
 * before, not less: nearly everything that is a standing fact about a thing is
 * now literally drawn on that thing. See memory/plans/notices-in-place.md.
 */
export type DockNotice = {
  id: string;
  /** Higher sorts first — see {@link NOTICE_RANK}. */
  rank: number;
  /**
   * Where this notice's OBJECT is, if it has one on screen.
   *
   * Direction E: a notice standing next to the thing it changed needs no words
   * to say what it is about. Naming an anchor sends it there whenever that
   * surface is mounted; declining to name one is the judgement that this notice
   * must not wait to be scrolled to, and it keeps the dock's one line.
   *
   * That judgement is not a rule code can derive, so it is argued per notice in
   * memory/plans/notices-in-place.md. What code CAN enforce is the two ways an
   * anchor is overruled — see {@link placeNotices}.
   */
  anchor?: NoticeAnchor;
  icon: LucideIcon;
  /**
   * Colour for the GLYPH only. The label, the verb and the ✕ stay plain body
   * ink: honey (or any warning tint) in body text is what made the old waiting
   * bar read as a caution strip, and this surface inherits that ruling.
   */
  iconClassName?: string;
  /** The line. One clause; the row truncates rather than wraps. */
  label: ReactNode;
  /** Trailing verb — 'Review', 'Retry'. Omit for a row with nothing to press. */
  actionLabel?: string;
  /**
   * The expanded body, if this notice has one. A function of the variant
   * because the two shells present it differently — a Popover growing upward
   * out of the dock on desktop, a Drawer on touch — and the bodies genuinely
   * differ (see MorningTriageList's `variant`).
   */
  tray?: (variant: NoticeTrayVariant) => ReactNode;
  /** Drawer heading on touch. Required whenever `tray` is set. */
  trayTitle?: string;
  /** Screen-reader description for the Drawer. */
  trayDescription?: string;
  /** Controlled tray state. Owned by the notice's source, not by the dock. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** For a notice with no tray: what pressing the row does. */
  onSelect?: () => void;
  /** Present ⇒ the row grows a trailing ✕. */
  onDismiss?: () => void;
  dismissLabel?: string;
  /**
   * An extra handle on the row, beyond the `dock-notice` / `data-notice-id`
   * pair every row carries. Only the waiting notice sets one, and only so the
   * e2e suite keeps addressing it as `morning-bar` across the move — a surface
   * changing address should not also change name in the same commit.
   */
  testId?: string;
  trayTestId?: string;
};

export type NoticeTrayVariant = 'tray' | 'sheet';

/**
 * Rank by WHAT IS PENDING, not by which feature raised it.
 *
 * Sorting by kind is the obvious thing and it is wrong: it makes the order an
 * artifact of how the app happens to be factored, so a new feature's notice
 * lands wherever its module sorts rather than where its urgency puts it. These
 * four levels are about what the line is asking of the reader.
 */
export const NOTICE_RANK = {
  /** Something is broken and the app cannot proceed without you. */
  blocked: 90,
  /** A pile is waiting on a decision only you can make. */
  decision: 50,
  /** The app did something on your behalf and you may want it undone. */
  receipt: 30,
  /** A state of the world you should know about. Rarely belongs here at all. */
  statement: 10,
} as const;

/** Most-urgent first, ties broken by id so the order can't flicker. */
export function rankNotices(notices: readonly DockNotice[]): DockNotice[] {
  return [...notices].sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
}

/**
 * How many rows actually get drawn, and how many are folded away.
 *
 * The dock's height ladder is 0 / one row / `max` rows and never a function of
 * n — a surface in a column shared with the braindump does not get to grow
 * without asking. But the fold is a DEFAULT, not a ceiling: `expanded` lifts it
 * completely, because a message surface that hides messages to protect its own
 * geometry has stopped being a message surface.
 *
 * The subtlety is the last visible slot. At `max + 1` notices you cannot show
 * `max` rows AND an overflow row — that is `max + 1` rows, which is the thing
 * the cap exists to prevent — so the final slot goes to the overflow row and
 * one more notice folds into it. `overflow` is therefore 2, not 1, at that
 * count, and the caller must render the summary whenever it is non-zero.
 */
export function capNotices(
  notices: readonly DockNotice[],
  max: number,
  expanded = false
): { visible: DockNotice[]; overflow: number } {
  if (expanded || notices.length <= max) {
    return { visible: [...notices], overflow: 0 };
  }
  /**
   * ...with one exception, and it is the same exception `placeNotices` makes.
   *
   * A `blocked` notice is the one thing that must never be somewhere you have to
   * GO to. Pinning it to the dock and then folding it behind "2 to answer" moves
   * it from a place you have to scroll to, to a place you have to click to,
   * which is the same failure wearing a different verb. At `max` 1 that is
   * exactly what the fold did: two notices produced zero notice rows, and
   * "Couldn't load your data" was not on screen at all.
   *
   * So the top row survives the fold when it is blocked, and the summary takes
   * the slot after it: one row plus "1 more", which is `max + 1` rows. That is a
   * deliberate overrun of the cap, and the only one — the cap exists to stop a
   * message surface from growing without asking, not to hide the message that
   * says the app is broken.
   */
  const pinned = notices[0] && notices[0].rank >= NOTICE_RANK.blocked ? 1 : 0;
  const visible = notices.slice(0, Math.max(pinned, max - 1));
  return { visible, overflow: notices.length - visible.length };
}

/**
 * Where each notice actually renders: the dock's one line, or its own object.
 *
 * E's tradeoff is that a notice you never scroll to is a notice you never see,
 * and E's own answer is that deciding which is which is a judgement per notice.
 * That judgement is the `anchor` field and it is argued in
 * memory/plans/notices-in-place.md. Two parts of it are NOT judgement, and this
 * function is where the code takes them back:
 *
 *  1. **`blocked` never renders in place.** A notice that says the app cannot
 *     proceed is the one thing that must never be off-screen, whatever anchor it
 *     grows later. This is the rule E's tradeoff is actually about, and it is the
 *     one rule a rule can be.
 *  2. **A notice with a tray never renders in place.** A tray is a body that
 *     opens upward out of the dock (a Popover) or as a Drawer; an in-place row
 *     draws no tray at all, so anchoring one would silently drop its contents.
 *     Placement must not be able to lose a notice's body.
 *
 * And one that is neither judgement nor policy but simple honesty: an anchor
 * whose slot is not mounted is not an anchor (lib/notice-anchors.ts). The caller
 * passes the live set; anything unplaceable falls back to the dock, so a notice
 * is never routed to a surface nobody is looking at.
 *
 * Pure, and it ranks its own output, so a caller cannot place notices in one
 * order and draw them in another.
 */
export function placeNotices(
  notices: readonly DockNotice[],
  liveAnchors: ReadonlySet<NoticeAnchor> = new Set()
): { dock: DockNotice[]; anchored: Map<NoticeAnchor, DockNotice[]> } {
  const dock: DockNotice[] = [];
  const anchored = new Map<NoticeAnchor, DockNotice[]>();

  for (const notice of rankNotices(notices)) {
    const placeable =
      notice.anchor !== undefined &&
      notice.rank < NOTICE_RANK.blocked &&
      !notice.tray &&
      liveAnchors.has(notice.anchor);
    if (placeable) {
      const list = anchored.get(notice.anchor!);
      if (list) list.push(notice);
      else anchored.set(notice.anchor!, [notice]);
    } else {
      dock.push(notice);
    }
  }

  return { dock, anchored };
}
