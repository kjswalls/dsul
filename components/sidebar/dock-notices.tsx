'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp, MoreHorizontal, X } from 'lucide-react';

import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useWaitingNotice } from '@/components/ai/morning-check';
import {
  useEodNotice,
  useSweepNotice,
  useSyncErrorNotice,
} from '@/components/notices/notice-sources';
import { useSidebarStore } from '@/lib/sidebar-store';
import { capNotices, placeNotices, type DockNotice } from '@/lib/dock-notices';
import { useLiveNoticeAnchors } from '@/lib/notice-anchors';
import { cn } from '@/lib/utils';

/**
 * The dock's ONE line: the highest-ranked question with nowhere else to live.
 *
 * It used to be the app's only voice, a stack of up to two rows INSIDE the dock
 * capsule. It is a strip ABOVE the capsule now, absorbed by the braindump's
 * flex-1 (desktop) and by the content area's (mobile).
 *
 * BE CAREFUL WHAT YOU CLAIM FOR THAT MOVE. The story this change was first
 * written under — "a notice arriving moved the omnibar" — was measured and is
 * false: the capsule's bottom is pinned by the column and this stack sat ABOVE
 * the UserCard, so a row grew the capsule upward into the braindump and the
 * omnibar held still at every viewport height down to 360px. What actually
 * jumped was the undo TOAST, which was position-fixed at `--toast-bottom`,
 * measured off the capsule's top edge — so it moved by exactly the row's height.
 * That is now a strip row of its own and no longer measures anything.
 * The move itself is a placement decision (notices are not part of the dock);
 * see memory/plans/notices-in-place.md for the numbers.
 *
 * WHY NOT THE CANVAS, which is where the waiting bar lived. lib/use-fit-hour-px.ts
 * derives the schedule grid's hour height from (viewport bottom − whatever sits
 * above the timeline), so anything in that column has to hold a fixed height
 * forever or it drives hourPx to its floor. The bar's famous 50px contract was
 * never a design decision — it was rent. This strip sits in the sidebar column,
 * which nothing measures into.
 *
 * WHAT IS LEFT HERE, after direction E. Most notices now render on the thing
 * they are about (components/notices/notice-slot.tsx). What reaches this line is
 * what has no object on screen — plus the two categories `placeNotices` pins
 * here whatever they claim: anything `blocked`, because a notice saying the app
 * cannot proceed must never be somewhere you have to scroll to, and anything
 * carrying a tray, because only the dock opens one. The membership rule is
 * unchanged: a line is earned by a pending DECISION, not by importance.
 *
 * THE HEIGHT LADDER, and it is not a function of n:
 *   0 notices → 0     (nothing renders at all)
 *   1+        → 26    (one row; past one the row becomes a "+N more")
 * The fold is a DEFAULT, not a ceiling — expanding lifts it — and because the
 * strip is absorbed by a flex-1 neighbour, expanding it still does not move the
 * omnibar.
 */

/**
 * Rows shown before the stack folds into a "+N more". ONE, on both platforms.
 *
 * Two was the desktop's answer when this was the app's only voice and a second
 * notice had nowhere else to go. Under E it does: the dock is the fallback, so
 * a second line here means two homeless questions at once, which is rare enough
 * to be worth a fold row and not worth a taller strip.
 */
const MAX_ROWS = 1;

/**
 * Every source, in one place. Adding a notice kind is adding a line here.
 *
 * Order in this array is irrelevant — `rankNotices` sorts by what is pending,
 * not by which module raised it, which is the whole reason the rank exists.
 *
 * The three that can live somewhere better come from
 * components/notices/notice-sources.tsx, which the in-place slots also call. The
 * waiting notice stays here because `useWaitingNotice` closes its tray on
 * unmount, so it must be called from exactly one place in the tree.
 */
function useDockNotices(): DockNotice[] {
  const waiting = useWaitingNotice();
  const eod = useEodNotice();
  const sweep = useSweepNotice();
  const syncError = useSyncErrorNotice();
  const live = useLiveNoticeAnchors();

  // What is left after every notice with a mounted object has gone to it. The
  // dock is the fallback, never the default: it holds the highest-ranked
  // question with nowhere else to live, plus anything `blocked` (pinned) and
  // anything carrying a tray (which only the dock can open).
  return placeNotices(
    [waiting, eod, sweep, syncError].filter((n): n is DockNotice => n !== null),
    live
  ).dock;
}

/* ── the row ─────────────────────────────────────────────────────────── */

/**
 * 26px, transparent, one coloured glyph.
 *
 * No filled tint and no border, unlike the honey bar this replaces. That bar
 * could afford a container because it was alone on the canvas; in a stack of
 * rows, n filled strips read as an alert list, which is the one thing the
 * guilt-free ruling forbids this surface from becoming. The glyph carries the
 * kind, the count carries the weight, and everything else is body ink — the
 * same reading the recent bucket work landed on: a thing on a line, not a band.
 */
function NoticeRow({
  notice,
  open,
  onOpenChange,
  asTrigger,
  dismissible = true,
}: {
  notice: DockNotice;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Desktop wraps the pressable region in a PopoverTrigger; mobile doesn't. */
  asTrigger?: boolean;
  /**
   * Touch turns every ✕ off, whatever the notice asked for. It is a property of
   * the input device, not of the message: a 24px destructive target pressed up
   * against a full-width tap target is a mis-tap generator, and there is no
   * hover to disambiguate them. Each notice's tray carries its own dismissal
   * there instead.
   */
  dismissible?: boolean;
}) {
  const Icon = notice.icon;
  const hasTray = !!notice.tray;
  const Chevron = open ? ChevronUp : ChevronDown;

  const content = (
    <>
      <Icon className={cn('h-3.5 w-3.5 flex-shrink-0', notice.iconClassName)} />
      <span className="min-w-0 flex-1 truncate text-left font-num text-xs tracking-[0.04em] text-foreground">
        {notice.label}
      </span>
      {notice.actionLabel && (
        <span className="flex flex-shrink-0 items-center gap-1 font-num text-xs tracking-[0.04em] text-muted-foreground">
          {open && hasTray ? 'Close' : notice.actionLabel}
          {hasTray && <Chevron className="h-3.5 w-3.5" />}
        </span>
      )}
    </>
  );

  const button = (
    <button
      type="button"
      onClick={hasTray ? () => onOpenChange?.(!open) : notice.onSelect}
      className="hover-wash flex h-[26px] min-w-0 flex-1 items-center gap-2 rounded-[6px] px-2 text-left"
    >
      {content}
    </button>
  );

  return (
    <div
      data-testid={notice.testId ?? 'dock-notice'}
      data-notice-id={notice.id}
      className="flex items-center"
    >
      {asTrigger && hasTray ? <PopoverTrigger asChild>{button}</PopoverTrigger> : button}
      {dismissible && notice.onDismiss && (
        <button
          type="button"
          onClick={notice.onDismiss}
          aria-label={notice.dismissLabel ?? 'Dismiss'}
          title={notice.dismissLabel ?? 'Dismiss'}
          className="hover-wash flex h-[26px] w-6 flex-shrink-0 items-center justify-center rounded-[6px] text-muted-foreground hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

/**
 * Desktop row + its tray, growing UP out of the dock.
 *
 * PopoverAnchor carries the box rather than the trigger, for the reason the
 * waiting bar discovered: the trigger is only the pressable region, so a width
 * measured off it comes up short of the row once a ✕ is present.
 */
function DesktopNotice({ notice }: { notice: DockNotice }) {
  const open = !!notice.open;

  if (!notice.tray) return <NoticeRow notice={notice} />;

  return (
    <Popover modal={false} open={open} onOpenChange={(o) => notice.onOpenChange?.(o)}>
      <PopoverAnchor asChild>
        <div>
          <NoticeRow notice={notice} open={open} onOpenChange={notice.onOpenChange} asTrigger />
        </div>
      </PopoverAnchor>

      <PopoverContent
        data-testid={notice.trayTestId ?? 'dock-notice-tray'}
        side="top"
        align="start"
        sideOffset={8}
        // Never flip to `bottom`: below this anchor is the omnibar, and a tray
        // that lands on the input the user is about to type into is worse than
        // one that runs tall. The bodies cap their own height instead.
        avoidCollisions={false}
        /* Floors at 420px rather than inheriting the dock outright. The triage
           rows are a title beside a 52px date column and a 124px action column,
           which is habitable at 420 and cramped at the 386 a default-width
           sidebar would hand it. Widening past the anchor overhangs to the
           right, over the canvas — the same place this tray has always
           opened over, just from the other side. */
        style={{ width: 'max(var(--radix-popover-trigger-width), 420px)' }}
        /* Every PopoverContent default is overridden (the primitive ships
           w-72 p-4 rounded-md border shadow-md). Opaque bg-popover, because
           this floats over a live grid. */
        className="z-50 flex max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-[6px] border border-border bg-popover p-0 shadow-[var(--shadow-elev-md)]"
        /* The per-row "Pick a date" Popover portals to <body>, so its content
           is outside this layer's subtree and both the pointerdown and the
           auto-focus register as "outside" — the tray would slam shut the
           instant a calendar opened. Everything else stays Radix's job. */
        onInteractOutside={(event) => {
          const target = event.detail.originalEvent.target as HTMLElement | null;
          if (target?.closest?.('[data-radix-popper-content-wrapper]')) event.preventDefault();
        }}
      >
        {notice.tray('tray')}
      </PopoverContent>
    </Popover>
  );
}

/* ── the stack ───────────────────────────────────────────────────────── */

function useCappedStack(notices: DockNotice[], max: number) {
  const [expanded, setExpanded] = useState(false);
  // Derived, not stored: the cap coming back on its own when the pile drains
  // means there is no stale "expanded" to reset in an effect.
  const isExpanded = expanded && notices.length > max;
  const { visible, overflow } = capNotices(notices, max, isExpanded);
  return { visible, overflow, isExpanded, setExpanded };
}

/**
 * The fold. Same 26px, same ink, no glyph colour — it is chrome, not a message.
 *
 * Two readings, because "2 more" is only true when there is something for them
 * to be more THAN. On mobile the cap is one row, so a second notice folds the
 * first away with it and this row stands alone: "2 to answer" then, which is
 * also the membership rule for this surface said out loud.
 */
function OverflowRow({
  count,
  expanded,
  standalone,
  onToggle,
}: {
  count: number;
  expanded: boolean;
  /** True when no notice rows are drawn above this one. */
  standalone?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      data-testid="dock-notice-overflow"
      data-overflow-count={count}
      className="hover-wash flex h-[26px] items-center gap-2 rounded-[6px] px-2 text-left"
    >
      <MoreHorizontal className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-num text-xs tracking-[0.04em] text-muted-foreground">
        {expanded ? 'Show less' : standalone ? `${count} to answer` : `${count} more`}
      </span>
    </button>
  );
}

/**
 * Desktop mount: components/sidebar/sidebar-dock.tsx, on the strip ABOVE the
 * capsule — not inside it. The braindump above is flex-1 and gives up the row's
 * height, so the capsule's top edge moves and its bottom edge does not, exactly
 * as it did when the row was inside.
 *
 * Renders nothing while the sidebar is away. This is the accepted cost of the
 * placement and it is deliberately NOT patched with a force-open: a rule where
 * some notices reopen your collapsed sidebar and others don't is one no user
 * can hold in their head, and the palette still reaches every one of these but
 * the failed load. That one has no command; the provider retries it on the
 * next SIGNED_IN, which Supabase sends when the tab is shown with a live
 * session.
 */
export function DockNotices() {
  const notices = useDockNotices();
  const { visible, overflow, isExpanded, setExpanded } = useCappedStack(notices, MAX_ROWS);
  const leftSidebarOpen = useSidebarStore((s) => s.leftSidebarOpen);
  const leftSidebarHovered = useSidebarStore((s) => s.leftSidebarHovered);
  const leftSidebarHoverEnabled = useSidebarStore((s) => s.leftSidebarHoverEnabled);

  // The column is clipped to w-0 when collapsed, not unmounted — so without
  // this a tray left open would keep floating over the canvas, anchored to a
  // zero-width box. Unmounting the rows closes every Popover with them.
  const columnVisible = leftSidebarOpen || (leftSidebarHoverEnabled && leftSidebarHovered);
  if (!columnVisible || notices.length === 0) return null;

  return (
    <div
      data-testid="dock-notices"
      className={cn(
        // mb rather than the old mb-[14px]: this is a strip row above the
        // capsule now, not the top of the capsule's own stack of rows.
        'mb-1.5 flex flex-col gap-1.5',
        // Only ever scrolls once the cap has been lifted by hand. A plain
        // overflow container, not <ScrollArea> — the Radix wrapper silently
        // drops max-h (CLAUDE.md).
        isExpanded && 'max-h-[132px] overflow-y-auto'
      )}
    >
      {visible.map((notice) => (
        <DesktopNotice key={notice.id} notice={notice} />
      ))}
      {overflow > 0 && (
        <OverflowRow
          count={overflow}
          expanded={false}
          standalone={visible.length === 0}
          onToggle={() => setExpanded(true)}
        />
      )}
      {isExpanded && <OverflowRow count={0} expanded onToggle={() => setExpanded(false)} />}
    </div>
  );
}

/**
 * Mobile mount: components/mobile/mobile-bottom-dock.tsx, above the well rather
 * than inside it. A placement change, not a geometry one — this dock is the last
 * child of a fixed-height flex column, so it grows upward and the well's bottom
 * edge measured 0px of movement in every configuration either way.
 *
 * Trays are Drawers rather than Popovers — a 420px tray does not exist here.
 */
export function DockNoticesMobile() {
  const notices = useDockNotices();
  // max 1, so capNotices' last-slot rule folds the FIRST notice away as soon as
  // there is a second, and the single row becomes "2 to answer". That is the
  // right trade at this width: one row speaking for itself, or one row speaking
  // for the pile — never one row silently standing in for another.
  const { visible, overflow, isExpanded, setExpanded } = useCappedStack(notices, MAX_ROWS);

  if (notices.length === 0) return null;

  return (
    <>
      <div
        data-testid="dock-notices"
        className={cn(
          'mb-1.5 flex flex-col gap-1',
          isExpanded && 'max-h-[110px] overflow-y-auto'
        )}
      >
        {visible.map((notice) => (
          <NoticeRow
            key={notice.id}
            notice={notice}
            open={!!notice.open}
            onOpenChange={notice.onOpenChange}
            dismissible={false}
          />
        ))}
        {overflow > 0 && (
          <OverflowRow
            count={overflow}
            expanded={false}
            standalone={visible.length === 0}
            onToggle={() => setExpanded(true)}
          />
        )}
        {isExpanded && <OverflowRow count={0} expanded onToggle={() => setExpanded(false)} />}
      </div>

      {/* Drawers live outside the scroller so an expanded stack can't clip one,
          and are mounted for EVERY notice rather than the visible ones: a tray
          opened from the palette (`goto.overdue`) must still appear when its
          row is folded away under "+N more". */}
      {notices.map((notice) =>
        notice.tray ? <MobileNoticeTray key={notice.id} notice={notice} /> : null
      )}
    </>
  );
}

function MobileNoticeTray({ notice }: { notice: DockNotice }) {
  return (
    <Drawer open={!!notice.open} onOpenChange={(o) => !o && notice.onOpenChange?.(false)}>
      {/* max-h-[80vh] comes free from components/ui/drawer.tsx. */}
      <DrawerContent data-testid={notice.trayTestId ?? 'dock-notice-tray'}>
        <DrawerHeader className="pb-2">
          <DrawerTitle className="text-left text-base">{notice.trayTitle}</DrawerTitle>
          <DrawerDescription className="sr-only">{notice.trayDescription}</DrawerDescription>
        </DrawerHeader>
        {notice.tray?.('sheet')}
      </DrawerContent>
    </Drawer>
  );
}
