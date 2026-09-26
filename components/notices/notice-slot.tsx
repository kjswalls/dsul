'use client';

import { X } from 'lucide-react';

import { TypewriterText } from '@/components/primitives/typewriter-text';
import { useAnchorableNotices } from '@/components/notices/notice-sources';
import { placeNotices, type DockNotice, type NoticeAnchor } from '@/lib/dock-notices';
import { useLiveNoticeAnchors, useNoticeAnchor } from '@/lib/notice-anchors';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { toDateStr } from '@/lib/recurrence';
import { cn } from '@/lib/utils';

/**
 * A notice standing on the thing it is about.
 *
 * Same 26px, same ink, same glyph-carries-the-kind reading as the dock's row —
 * they are the same sentence and they should read as the same kind of row. Two
 * differences, both deliberate:
 *
 *  1. **It types.** Here there is room and there is context, and the reveal is
 *     what makes a line that appeared under your cursor read as having been said
 *     rather than as having always been there. The dock's line never types (see
 *     TypewriterText).
 *  2. **The ✕ is always drawn**, on touch as well as pointer. The dock
 *     suppresses it on touch because a 24px destructive target pressed against a
 *     full-width tap target is a mis-tap generator and its trays carry their own
 *     dismissal instead. In place there is neither a tray nor a full-bleed row
 *     to collide with, and "every notice must be easily dismissible" is the
 *     amendment this surface exists under.
 */
function InPlaceNotice({ notice }: { notice: DockNotice }) {
  const Icon = notice.icon;

  return (
    <div
      data-testid="in-place-notice"
      data-notice-id={notice.id}
      data-notice-anchor={notice.anchor}
      className="flex items-center"
    >
      <button
        type="button"
        onClick={notice.onSelect}
        className="hover-wash flex h-[26px] min-w-0 flex-1 items-center gap-2 rounded-[6px] px-2 text-left"
      >
        <Icon className={cn('h-3.5 w-3.5 flex-shrink-0', notice.iconClassName)} />
        <TypewriterText
          revealKey={notice.id}
          className="min-w-0 flex-1 font-num text-xs tracking-[0.04em] text-foreground"
        >
          {notice.label}
        </TypewriterText>
        {notice.actionLabel && (
          <span className="flex-shrink-0 font-num text-xs tracking-[0.04em] text-muted-foreground">
            {notice.actionLabel}
          </span>
        )}
      </button>
      {notice.onDismiss && (
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
 * "There is a place for a notice here, and here is what is in it."
 *
 * Mounting a slot is the whole of what makes an anchor real. It registers in a
 * layout effect (lib/notice-anchors.ts), so within the same commit the dock
 * already knows this notice has somewhere better to be and never paints the
 * frame where it is still on the dock line.
 *
 * `active` is how a slot says "my object is the one this notice is about" — the
 * day-header slot is live only on today, so arrowing to another day takes the
 * anchor down and the notice goes back to the dock rather than sitting beside a
 * date it has nothing to do with.
 *
 * Renders nothing at all when there is nothing placed here, so a slot costs an
 * empty fragment and no layout on every surface that mounts one.
 */
export function NoticeSlot({
  anchor,
  active = true,
  className,
}: {
  anchor: NoticeAnchor;
  active?: boolean;
  className?: string;
}) {
  useNoticeAnchor(anchor, active);
  const live = useLiveNoticeAnchors();
  const notices = useAnchorableNotices();

  // Placement runs through the same pure function the dock uses, so the two
  // cannot disagree about who owns a notice: exactly one of them finds it in
  // its own bucket. `blocked` and tray-bearing notices never reach here — see
  // placeNotices.
  const { anchored } = placeNotices(notices, live);
  const mine = active ? (anchored.get(anchor) ?? []) : [];
  if (mine.length === 0) return null;

  return (
    <div
      data-testid="notice-slot"
      data-anchor={anchor}
      className={cn('flex flex-col gap-1', className)}
    >
      {mine.map((notice) => (
        <InPlaceNotice key={notice.id} notice={notice} />
      ))}
    </div>
  );
}

/**
 * Beside the date, in the canvas header row.
 *
 * The end-of-day line's object is the DAY, and the day's canonical handle is its
 * date — not the geometric foot of a grid. This is the address ProgramNotice
 * already argued its way to ("it is bound to a date… so it belongs beside the
 * date"), and E generalises that precedent rather than inventing a second one.
 *
 * It costs the row nothing: the row's height is max(children) and the header
 * capsule already sets that at 96 or more (more while its Display shelf shows),
 * so an h-8 line beside it is free. The foot of
 * the day column, which this replaced, was not free — lib/use-fit-hour-px.ts
 * reserves 24px below the schedule grid and counts only the chrome above it, so
 * a 34px row down there made a compressed day scroll.
 *
 * `scope` overrides the view store, for the mobile shell: MobileViewRouter is
 * day-only and hardcodes it, while a stale `scope: 'week'` can persist in that
 * shell's blob with nothing able to correct it (see the same note on
 * DisplayMenu in components/mobile/mobile-header.tsx).
 *
 * Live only on today. On any other date the anchor goes dark and the line falls
 * back to the dock, which is the honest place for a question about a day that is
 * not the one on screen.
 */
export function DayHeaderNotice({
  scope: scopeOverride,
  className,
}: {
  scope?: 'day' | 'week';
  className?: string;
}) {
  const selectedDate = usePlannerStore((s) => s.selectedDate);
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const storeScope = useViewStore((s) => s.scope);
  const scope = scopeOverride ?? storeScope;

  const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const isToday = toDateStr(selectedDate, tz) === toDateStr(new Date(), tz);

  return (
    <NoticeSlot anchor="day-header" active={scope === 'day' && isToday} className={className} />
  );
}
