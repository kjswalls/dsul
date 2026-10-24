'use client';

import { useRef, useState, type ComponentType, type MouseEvent } from 'react';
import { Moon, Palmtree, Sunrise } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DayHeaderNotice, useDayHeaderNotices } from '@/components/notices/notice-slot';
import { SeasonNotice, useSeasonSuppression } from '@/components/views/season-notice';
import { AwayNotice, useAwayLine } from '@/components/views/away-notice';
import { BackNotice, useBackToday } from '@/components/notices/back-notice';
import { cn } from '@/lib/utils';

/**
 * Everything the planner has to say about the day on screen, behind one quiet
 * key in the date capsule.
 *
 * Three lines used to sit beside the date in the canvas header row (the
 * season's "Summer is off, so 5 items are hidden", the vacation line, and "Today's review is
 * waiting"), and the season line was drawn a second time at the top of the
 * Schedule and List day views. Kirby asked for one place, and picked this one
 * (2026-10-17): a glyph per message at the end of the capsule's date row, and
 * the sentences in a popover on click. At rest the canvas says nothing; the
 * glyphs are the only sign. A fourth joined on 2026-10-23: "Back today", what
 * a pause hands back on this day (components/notices/back-notice.tsx).
 *
 * The split it keeps: what is about THIS DAY lives here; everything else (the
 * waiting pile, sync and AI failures, undo and History) stays in the sidebar's
 * dock (lib/dock-notices.ts has the rule).
 *
 * The popover's rows are the same components the lines always were, so each
 * keeps its own words, verbs and test ids. Out here their hooks are asked only
 * whether there is anything to say, plus one thing the closed popover cannot do
 * for itself: the end-of-day line is an anchored notice, and its anchor must
 * stay registered while the popover (and the slot inside it) is unmounted, or
 * the line would fall back to the dock every time the popover shut
 * (useDayHeaderNotices).
 *
 * It costs the capsule nothing in height: an h-8 key in a row of h-8 keys.
 *
 * `scope` overrides the view store for the phone, whose day-only router can sit
 * under a stale persisted `scope: 'week'`.
 */
export function DayMessages({
  scope,
  className,
}: {
  scope?: 'day' | 'week';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Where the popover opens (Kirby's pick B, 2026-10-24): BESIDE the capsule,
  // its top level with the capsule's and a caret pointing at the key. That
  // space is always empty canvas, so the note covers neither the toolbar nor
  // the day. It replaced, in turn, a card off the key that opened over the
  // capsule's second row, and one hung below the whole capsule (2026-10-23).
  //
  // Measured from the key on each open. Where the canvas has no room to the
  // capsule's right it hangs below the capsule instead, right edge on the
  // capsule's; the phone's date row has no capsule, so there it simply opens
  // below the key.
  const [place, setPlace] = useState<Placement>(BELOW_KEY);
  const onOpenChange = (next: boolean) => {
    if (next) setPlace(placementFor(triggerRef.current));
    setOpen(next);
  };
  const dayNotices = useDayHeaderNotices(scope);
  const season = useSeasonSuppression(scope);
  const away = useAwayLine();
  const back = useBackToday(scope);

  // Most pressing first: an answerable notice (the review), then the day's
  // statement, then the trip, which is about you rather than the day.
  const glyphs: { key: string; Icon: ComponentType<{ className?: string }>; className?: string }[] = [
    ...dayNotices.map((n) => ({ key: n.id, Icon: n.icon, className: n.iconClassName })),
    ...(season ? [{ key: 'season', Icon: Moon }] : []),
    // What a pause hands back on this day (Kirby, 2026-10-23). After the
    // season, which is the day's other statement about what is (not) here.
    ...(back ? [{ key: 'back', Icon: Sunrise }] : []),
    ...(away ? [{ key: 'away', Icon: Palmtree }] : []),
  ];
  if (glyphs.length === 0) return null;

  const label = glyphs.length === 1 ? '1 note about this day' : `${glyphs.length} notes about this day`;

  // Every row's action leads somewhere else (a console, a card, the review), so
  // any button pressed inside closes the popover behind it.
  const closeOnAction = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          data-testid="day-messages"
          data-count={glyphs.length}
          aria-label={label}
          title={label}
          className={cn(
            'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
            className
          )}
        >
          {glyphs.map(({ key, Icon, className: iconClass }) => (
            <Icon key={key} className={cn('h-3.5 w-3.5', iconClass)} aria-hidden />
          ))}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={place.side}
        align={place.align}
        sideOffset={place.sideOffset}
        alignOffset={place.alignOffset}
        // Placed, not flipped: Radix's flip would turn "beside" into "over the
        // capsule"; placementFor already chose a side that fits.
        avoidCollisions={place.side === 'bottom'}
        data-testid="day-messages-popover"
        data-side={place.side}
        className="relative flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-0.5 p-1.5"
        onClickCapture={closeOnAction}
      >
        {/* The caret, pointing at the key. Drawn here rather than with Radix's
            Arrow, whose fill-only triangle vanishes against the canvas: this
            one carries the card's own border. */}
        {place.side === 'right' && (
          <span
            aria-hidden
            data-testid="day-messages-caret"
            className="bg-popover absolute -left-[6px] size-[10px] rotate-45 border-b border-l"
            style={{ top: place.caretTop - 5 }}
          />
        )}
        <DayHeaderNotice scope={scope} />
        <SeasonNotice
          scope={scope}
          className="hover-wash min-h-[26px] w-full rounded-[6px] px-2 py-1.5 text-left"
        />
        <BackNotice scope={scope} className="min-h-[26px] px-2 py-1.5" />
        <AwayNotice className="h-[26px] px-2" />
      </PopoverContent>
    </Popover>
  );
}

interface Placement {
  side: 'right' | 'bottom';
  align: 'start' | 'end';
  sideOffset: number;
  alignOffset: number;
  /** Where the key's middle falls, from the card's top (beside only). */
  caretTop: number;
}

const BELOW_KEY: Placement = { side: 'bottom', align: 'end', sideOffset: 6, alignOffset: 0, caretTop: 0 };

/** The popover's width (w-80) plus the gap to the capsule and a margin to the window's edge. */
const BESIDE_ROOM = 320 + 10 + 16;

/** Beside the capsule when there is room, else below it; below the key with no capsule. */
export function placementFor(key: HTMLElement | null): Placement {
  const capsule = key?.closest('[data-header-capsule]');
  if (!key || !capsule) return BELOW_KEY;
  const k = key.getBoundingClientRect();
  const c = capsule.getBoundingClientRect();
  if (window.innerWidth - c.right >= BESIDE_ROOM) {
    return {
      side: 'right',
      align: 'start',
      sideOffset: c.right - k.right + 10,
      alignOffset: c.top - k.top,
      caretTop: k.top + k.height / 2 - c.top,
    };
  }
  return { side: 'bottom', align: 'end', sideOffset: c.bottom - k.bottom + 6, alignOffset: k.right - c.right, caretTop: 0 };
}
