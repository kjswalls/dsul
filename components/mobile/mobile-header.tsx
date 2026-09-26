'use client';

import { useState, useEffect, useRef } from 'react';
import {
  format,
  addDays,
  subDays,
  startOfWeek,
  isSameDay,
  isToday,
  isTomorrow,
  isYesterday,
} from 'date-fns';
import { useSwipeable } from 'react-swipeable';
import { Rows3, List, Clock, ChevronDown } from 'lucide-react';
import { UserProfileDropdown } from '@/components/planner/user-profile-dropdown';
import { Calendar as CalendarComponent } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DisplayMenu, type DisplayMenuHandle } from '@/components/primitives/display-menu';
import { DisplayShelf } from '@/components/primitives/display-shelf';
import { usePlannerStore } from '@/lib/planner-store';
import { useMobileNavStore } from '@/lib/mobile-nav-store';
import { useViewStore, type ViewLayout } from '@/lib/view-store';
import { goToDate } from '@/lib/nav-commands';
import { DayHeaderNotice } from '@/components/notices/notice-slot';
import { cn } from '@/lib/utils';

interface MobileHeaderProps {
  /** Passed straight through to UserProfileDropdown — see its note. */
  settingsHref: string;
  /**
   * Opens the bug-report/feature-request dialog. Dogfooding affordance for
   * #196; it lives inside the user menu now rather than in its own header
   * slot, which is what let the header collapse to one card.
   */
  onOpenBugReport: () => void;
}

/**
 * The layouts a phone offers, in cycle order. Mobile is day-only, so this is a
 * subset of the desktop capsule's matrix — there is no scope axis to cross.
 */
const LAYOUTS: { value: ViewLayout; label: string; icon: typeof Rows3 }[] = [
  { value: 'buckets', label: 'Buckets', icon: Rows3 },
  { value: 'list', label: 'List', icon: List },
  { value: 'schedule', label: 'Schedule', icon: Clock },
];

/**
 * The week-start preference as date-fns' index.
 *
 * Both date controls in this card read it — the strip's seven columns and the
 * calendar popover's month grid. A picker that put Aug 24 in a different column
 * than the strip directly above it is exactly the confusion the strip's fixed
 * columns exist to prevent, and react-day-picker takes the en-US default
 * (Sunday) unless told otherwise.
 */
function weekStartIndex(day: 'sunday' | 'monday' | 'saturday'): 0 | 1 | 6 {
  return day === 'monday' ? 1 : day === 'saturday' ? 6 : 0;
}

/**
 * The week the strip shows, and the day cells in it.
 *
 * Seven cells, always the calendar week containing the cursor — not a rolling
 * window — so the weekday initials stay in their columns as the cursor moves
 * and the strip never re-orders under a thumb. Paging is a horizontal swipe;
 * the calendar popover in the row above is the arbitrary jump.
 */
function WeekStrip() {
  const selectedDate = usePlannerStore((s) => s.selectedDate);
  const weekStartDay = usePlannerStore((s) => s.weekStartDay);

  const weekStart = startOfWeek(selectedDate, { weekStartsOn: weekStartIndex(weekStartDay) });
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  // A week per swipe, keeping the weekday: land on the same column one week
  // over, so the underline does not jump across the strip as it pages.
  const swipe = useSwipeable({
    onSwipedLeft: () => goToDate(addDays(selectedDate, 7), 'left'),
    onSwipedRight: () => goToDate(subDays(selectedDate, 7), 'right'),
    // The header card sits OUTSIDE the shell's swipeable content container, so
    // a strip swipe cannot reach the tab swipe by bubbling today. Stopping it
    // here anyway makes that independent of where the header ends up sitting:
    // a swipe that pages the week must never also change tab.
    onTouchStartOrOnMouseDown: ({ event }) => event.stopPropagation(),
    trackMouse: false,
    delta: 40,
    preventScrollOnSwipe: false,
  });

  return (
    <div {...swipe} className="flex touch-pan-y justify-between px-1">
      {days.map((day) => {
        const selected = isSameDay(day, selectedDate);
        const today = isToday(day);
        const dateStr = format(day, 'yyyy-MM-dd');

        return (
          <button
            key={dateStr}
            type="button"
            onClick={() => goToDate(day)}
            // The strip is the mobile date control now that the chevrons are
            // gone, so each cell is addressable by the date it moves to —
            // tests/e2e/helpers/app.ts:navigateToDate clicks these.
            data-testid="week-day"
            data-date={dateStr}
            data-selected={selected ? 'true' : 'false'}
            aria-current={selected ? 'date' : undefined}
            aria-label={
              today ? `Today, ${format(day, 'EEEE, MMMM d')}` : format(day, 'EEEE, MMMM d')
            }
            className="flex flex-1 flex-col items-center gap-[3px] rounded-lg py-0.5"
          >
            <span
              className={cn(
                'text-[9px] font-medium',
                // --lime-ink is near-black in dark mode, so the lime accent
                // reads as ink only through --day-today, which flips to the
                // bright lime there. Never through an opacity — this is the
                // card's one lime mark of chrome besides the Display dot (the
                // Display shelf's priority and project glyphs are data).
                selected ? 'text-day-today' : 'text-muted-foreground'
              )}
            >
              {format(day, 'EEEEE')}
            </span>
            <span
              className={cn(
                'flex h-5 items-center justify-center text-[12px]',
                // Today is marked even when the cursor is elsewhere — in ink
                // and weight, not a second badge, so the lime underline stays
                // the one thing that means "selected". The mini-week-nav this
                // replaced distinguished the two (bg-primary vs bg-secondary);
                // without it, a week paged away from now renders seven
                // identical cells and nothing on the card says where today is.
                selected
                  ? 'font-semibold text-day-today'
                  : today
                    ? 'font-semibold text-foreground'
                    : 'font-medium text-foreground/70'
              )}
            >
              {format(day, 'd')}
            </span>
            <span
              aria-hidden="true"
              className={cn(
                'h-[3px] w-4 rounded-[2px]',
                selected ? 'bg-primary' : 'bg-transparent'
              )}
            />
          </button>
        );
      })}
    </div>
  );
}

/**
 * Mobile header: on Today, one card carrying the date row and the week strip,
 * and under them the review notice and the Display shelf whenever either has
 * something to say. It replaces the two stacked pills (header + mini week nav) the phone used to
 * open with; two bordered, shadowed surfaces competing above the first row of
 * content is what made the shell read busy. The other two tabs bring their own
 * header and get no card at all (see the gate below).
 *
 * pt-safe lives on the outer <header> and the card carries its own top margin,
 * so the notch inset and the card's gap add rather than collide.
 */
export function MobileHeader({ settingsHref, onOpenBugReport }: MobileHeaderProps) {
  const { selectedDate, setSelectedDate, weekStartDay } = usePlannerStore();
  const { layout, setLayout } = useViewStore();
  const activeTab = useMobileNavStore((s) => s.activeTab);
  const [mounted, setMounted] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  // The Display menu's handle, shared with the shelf at the foot of the card.
  // Up here with the other hooks, above the early return for the dateless
  // tabs: a hook below it would run on Today and not on the others.
  const displayRef = useRef<DisplayMenuHandle>(null);

  useEffect(() => setMounted(true), []);

  const currentIndex = Math.max(
    0,
    LAYOUTS.findIndex((l) => l.value === layout)
  );
  const currentLayout = LAYOUTS[currentIndex];
  const nextLayout = LAYOUTS[(currentIndex + 1) % LAYOUTS.length];
  const LayoutIcon = currentLayout.icon;

  // A relative word where there is one, because "Today" is the phone's whole
  // orientation; otherwise the weekday carries it. The secondary line then
  // supplies whatever the primary did not — the weekday is already spelled out
  // above on a dated day, so repeating it there would be noise.
  const relativeDay = isToday(selectedDate)
    ? 'Today'
    : isTomorrow(selectedDate)
      ? 'Tomorrow'
      : isYesterday(selectedDate)
        ? 'Yesterday'
        : null;

  const primaryDate = relativeDay ?? format(selectedDate, 'EEEE');
  const secondaryDate = relativeDay
    ? format(selectedDate, 'EEE, MMM d')
    : format(selectedDate, 'MMM d');

  // The dateless tabs get NO card. Braindump already opens with the header this
  // redesign ports — its own surface-3 capsule (components/sidebar/braindump.tsx)
  // — and Beacon wears the same shape; a dated card above either is two
  // stacked headers, the upper one offering a calendar for a surface with no
  // date, where the chevron moved the Today cursor with no visible effect on the
  // tab you were looking at. The user menu goes with the card: the shell hands
  // those two tabs their own to mount inside their capsule, as the artboards
  // show (design/mobile-redesign/BraindumpTab.dc.html). The empty wrapper stays: it
  // carries the notch inset, plus the 10px the card's own top margin used to put
  // between the inset and whatever opens below — those surfaces need both
  // whether or not there is a card in it.
  if (activeTab !== 'today') return <header className="pb-[10px] pt-safe" />;

  return (
    <header className="pt-safe">
      <div className="mx-[10px] mt-[10px] flex flex-col gap-2 rounded-[20px] border border-surface-3 bg-surface-2 px-3 pb-2 pt-[10px] shadow-[var(--shadow-elev-sm)]">
        <div className="flex items-center justify-between gap-2">
          <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-testid="header-date"
                // Same machine-readable date as the desktop capsule, so one
                // navigation helper works across both shells. The visible copy
                // is a relative word as often as not, which no format-string
                // assertion could match.
                data-date={mounted ? format(selectedDate, 'yyyy-MM-dd') : ''}
                // Composed FROM the visible words, not instead of them: an
                // aria-label replaces an element's contents in the accessible
                // name, so a bare "Change date" left the date — the whole
                // readout — unannounced, and left voice control with no
                // "tap Today" to match (WCAG 2.5.3). Pre-mount there is no date
                // to name yet, so the verb stands alone for that one frame.
                aria-label={
                  mounted ? `${primaryDate} ${secondaryDate}. Change date.` : 'Change date'
                }
                className="-ml-1 flex min-w-0 items-center gap-2 rounded-lg px-1 py-0.5 text-left transition-colors hover:bg-accent"
              >
                {mounted ? (
                  <span className="flex min-w-0 items-baseline gap-[7px]">
                    <span className="truncate text-[16px] font-semibold tracking-[-0.01em] text-foreground">
                      {primaryDate}
                    </span>
                    <span className="shrink-0 text-[13px] text-muted-foreground">
                      {secondaryDate}
                    </span>
                  </span>
                ) : (
                  // Pre-mount the date is whatever the server rendered; hold the
                  // space rather than paint a value the client may replace.
                  <span className="h-6 w-40" />
                )}
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <CalendarComponent
                mode="single"
                selected={selectedDate}
                // Without this the picker opens on the CURRENT month whatever
                // the cursor is on (react-day-picker takes `today`, not
                // `selected`, as its initial month) — so paging a few weeks out
                // and reaching for the calendar threw you back to this month.
                defaultMonth={selectedDate}
                weekStartsOn={weekStartIndex(weekStartDay)}
                onSelect={(date) => {
                  if (date) setSelectedDate(date);
                  setCalendarOpen(false);
                }}
                initialFocus
              />
            </PopoverContent>
          </Popover>

          <div className="flex shrink-0 items-center gap-2.5">
            {/* Both icons answer for the canvas, which is why the whole card
                rides Today only: on Braindump the display menu would be a
                second, pixel-identical trigger beside the braindump's own,
                writing canvasFilters while the list below reads
                braindumpFilters; on Chat both would configure a canvas nobody
                is looking at. */}
            <div className="flex items-center gap-0.5">
              {/* The button IS the layout readout: it shows where you are and
                  tapping moves you on. A picker would need a second tap to
                  say anything, on a surface with exactly three states.

                  rounded-sm, not rounded-lg: --radius is 1rem here, so
                  `rounded-lg` on a 30px box is a circle — three round slots
                  where the artboard sets these two at 8px against the one
                  round avatar. */}
              <button
                type="button"
                onClick={() => setLayout(nextLayout.value)}
                data-testid="mobile-view-cycle"
                data-layout={currentLayout.value}
                aria-label={`View: ${currentLayout.label}. Tap for ${nextLayout.label}.`}
                className="flex size-[30px] items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <LayoutIcon className="size-4" />
              </button>

              {/* `scope="day"` because this shell IS day-only —
                  MobileViewRouter reads `layout` and hardcodes
                  data-view-scope="day". Without it a stale `scope: 'week'` in
                  the persisted blob reports Grouping as unavailable on a
                  surface that honours it, and nothing here can correct it:
                  the only writers of scope are the desktop capsule and two
                  palette commands hidden on mobile.

                  The wrapper grows the shared 24px icon trigger to the 30px
                  touch slot its neighbour uses, without changing what the
                  braindump and the desktop capsule get. */}
              <span className="flex [&>button]:size-[30px] [&>button]:rounded-sm">
                <DisplayMenu ref={displayRef} surface="canvas" trigger="icon" scope="day" />
              </span>
            </div>

            <UserProfileDropdown
              settingsHref={settingsHref}
              onOpenBugReport={onOpenBugReport}
            />
          </div>
        </div>

        <WeekStrip />

        {/* "Today's review is waiting", inside the date card — the same address
            as the desktop's header row, which is the date this shell is showing.
            `scope="day"` for the same reason DisplayMenu takes it above: this
            shell is day-only and a stale `scope: 'week'` in the persisted blob
            has no writer here to correct it. Renders nothing on any other date,
            and nothing at all when the review is not owed. */}
        <DayHeaderNotice scope="day" />

        {/* The Display shelf, the desktop capsule's line under its pill: what
            the menu above has set, in words, while anything is. Last in the
            card, so the date, its week and the review notice about that date
            stay one cluster and the line sits over the content it describes.
            The card is as wide as the screen whatever its content, so, unlike
            the desktop capsule, it needs no containment. px-0 puts the text on
            the date's edge; the card's gap is the 8px above it, and pb-px with
            the card's pb-2 the braindump's 9px below. In flow, like the
            desktop's: the day under this card re-fits its hour rows as the
            shelf comes and goes. */}
        <DisplayShelf surface="canvas" menu={displayRef} touch className="px-0 pt-0 pb-px" />
      </div>
    </header>
  );
}
