'use client';

import { useState, useEffect, useRef } from 'react';
import { format, isToday, isTomorrow, isYesterday } from 'date-fns';
import { Rows3, List, Clock, ChevronsUpDown, Check, SlidersHorizontal } from 'lucide-react';
import { UserProfileDropdown } from '@/components/planner/user-profile-dropdown';
import { Calendar as CalendarComponent } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DisplayMenu, type DisplayMenuHandle } from '@/components/primitives/display-menu';
import { DisplayShelf } from '@/components/primitives/display-shelf';
import { usePlannerStore } from '@/lib/planner-store';
import { chatOffered, useMobileNavStore, shownMobileTab } from '@/lib/mobile-nav-store';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { useViewStore, type PhoneDensity, type ViewLayout } from '@/lib/view-store';
import { goToDate } from '@/lib/nav-commands';
import { DayHeaderNotice } from '@/components/notices/notice-slot';
import { AwayNotice } from '@/components/views/away-notice';

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
 * The Go to date popover's month grid reads it, so the phone's calendar starts
 * its weeks where the desktop's do; react-day-picker takes the en-US default
 * (Sunday) unless told otherwise.
 */
function weekStartIndex(day: 'sunday' | 'monday' | 'saturday'): 0 | 1 | 6 {
  return day === 'monday' ? 1 : day === 'saturday' ? 6 : 0;
}

/** How long a press on the layout capsule must last to open its menu. */
const HOLD_MS = 450;

/** The phone's two row heights, as the capsule's menu names them. */
const DENSITIES: { value: PhoneDensity; label: string }[] = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact', label: 'Compact' },
];

/**
 * Mobile header: on Today, the iPhone app's top row (mobile web round 3,
 * memory/handoffs/mobile-web.md) over the web's own views. A 17px title with
 * "date · layout" under it, which opens Go to date; a Today key when the day
 * shown is another one; the layout capsule; the avatar. Under the row, the
 * review notice, the away line and the Display shelf whenever any of them has
 * something to say. There is no week strip (Kirby's call, 2026-10-13): the
 * title is the date control, as on the iPhone.
 *
 * The capsule steps through the layouts on a tap and opens its menu on a hold
 * (or a right-click, or the context-menu key): the layouts, the row density,
 * and Display…, which opens the Display menu anchored on the capsule. A hold
 * here never collides with a drag: nothing in the header is draggable, and
 * the touch sensor's delay (TOUCH_ACTIVATION_DELAY_MS) only arms on items.
 *
 * Ask, or the setup page in its place, brings its own header, so this renders
 * only the safe-area inset there.
 */
export function MobileHeader({ settingsHref, onOpenBugReport }: MobileHeaderProps) {
  const { selectedDate, setSelectedDate, weekStartDay } = usePlannerStore();
  const { layout, setLayout } = useViewStore();
  const density = useViewStore((s) => s.phoneDensity);
  const setDensity = useViewStore((s) => s.setPhoneDensity);
  // The tab on screen, not the stored one: while the gate offers no chat tab
  // the shell shows Today for a stored 'chat', and Today needs its dated row
  // and user menu. The setup page in Ask's place is dateless, as Ask is.
  const storedTab = useMobileNavStore((s) => s.activeTab);
  const activeTab = shownMobileTab(storedTab, chatOffered(useAICapabilities()));
  const [mounted, setMounted] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // The Display menu's handle, shared with the shelf at the foot of the row.
  // Up here with the other hooks, above the early return for Ask: a hook
  // below it would run on Today and not on Ask.
  const displayRef = useRef<DisplayMenuHandle>(null);
  const capsuleRef = useRef<HTMLButtonElement>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set when a hold opened the menu, so the click that ends the same press
  // does not also step the layout.
  const held = useRef(false);

  useEffect(() => setMounted(true), []);
  useEffect(
    () => () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
    },
    []
  );

  const currentIndex = Math.max(
    0,
    LAYOUTS.findIndex((l) => l.value === layout)
  );
  const currentLayout = LAYOUTS[currentIndex];
  const nextLayout = LAYOUTS[(currentIndex + 1) % LAYOUTS.length];
  const LayoutIcon = currentLayout.icon;

  // A relative word where there is one, because "Today" is the phone's whole
  // orientation; otherwise the weekday carries it.
  const relativeDay = isToday(selectedDate)
    ? 'Today'
    : isTomorrow(selectedDate)
      ? 'Tomorrow'
      : isYesterday(selectedDate)
        ? 'Yesterday'
        : null;
  const title = relativeDay ?? format(selectedDate, 'EEEE');
  const subtitle = `${format(selectedDate, 'EEE, MMM d')} · ${currentLayout.label}`;
  const onToday = isToday(selectedDate);

  const cancelHold = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };

  if (activeTab !== 'today') return <header className="pt-safe" />;

  return (
    <header className="pt-safe">
      <div className="flex items-center justify-between gap-2 pb-2 pl-5 pr-4 pt-[10px]">
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
              // Composed FROM the visible words, not instead of them (WCAG
              // 2.5.3): the readout is the whole of what this button says.
              aria-label={mounted ? `${title}, ${subtitle}. Go to date.` : 'Go to date'}
              className="-ml-1.5 flex min-w-0 flex-col items-start rounded-lg px-1.5 py-0.5 text-left transition-colors hover:bg-accent"
            >
              {mounted ? (
                <>
                  <span className="truncate text-[17px] font-semibold leading-6 tracking-[-0.01em] text-foreground">
                    {title}
                  </span>
                  <span className="truncate text-[12px] leading-4 text-muted-foreground">{subtitle}</span>
                </>
              ) : (
                // Pre-mount the date is whatever the server rendered; hold the
                // space rather than paint a value the client may replace.
                <span className="h-10 w-40" />
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <CalendarComponent
              mode="single"
              selected={selectedDate}
              // Without this the picker opens on the CURRENT month whatever
              // the cursor is on (react-day-picker takes `today`, not
              // `selected`, as its initial month).
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

        <div className="flex shrink-0 items-center gap-2">
          {/* The way home from another day, now that no strip marks today. */}
          {mounted && !onToday && (
            <button
              type="button"
              data-testid="header-today"
              onClick={() => goToDate(new Date(), selectedDate > new Date() ? 'right' : 'left')}
              className="flex h-[34px] items-center rounded-full bg-surface-3 px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-accent"
            >
              Today
            </button>
          )}

          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <span className="relative flex">
              <DropdownMenuTrigger asChild>
                <button
                  ref={capsuleRef}
                  type="button"
                  data-testid="mobile-view-cycle"
                  data-layout={currentLayout.value}
                  aria-label={`View: ${currentLayout.label}. Tap for ${nextLayout.label}, hold for more.`}
                  // Radix opens a dropdown on pointerdown; this one opens on a
                  // hold instead, so its own handlers are replaced below and
                  // the menu is driven by `menuOpen`.
                  onPointerDown={(e) => {
                    e.preventDefault();
                    held.current = false;
                    cancelHold();
                    holdTimer.current = setTimeout(() => {
                      held.current = true;
                      setMenuOpen(true);
                    }, HOLD_MS);
                  }}
                  onPointerUp={cancelHold}
                  onPointerLeave={cancelHold}
                  onPointerCancel={cancelHold}
                  onKeyDown={(e) => {
                    // Enter and Space step, as a tap does; the menu is the
                    // context-menu key's (below) and ArrowDown's.
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setMenuOpen(true);
                    } else if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setLayout(nextLayout.value);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    cancelHold();
                    held.current = true;
                    setMenuOpen(true);
                  }}
                  onClick={(e) => {
                    e.preventDefault();
                    if (held.current) {
                      held.current = false;
                      return;
                    }
                    setLayout(nextLayout.value);
                  }}
                  className="flex h-[34px] select-none items-center gap-1.5 rounded-full bg-surface-3 px-3 text-foreground transition-colors [-webkit-touch-callout:none] hover:bg-accent"
                >
                  <LayoutIcon className="size-[17px]" strokeWidth={1.75} />
                  <ChevronsUpDown className="size-[13px] text-muted-foreground" strokeWidth={2} />
                </button>
              </DropdownMenuTrigger>
              {/* The Display menu, opened from the capsule's menu. Its own
                  trigger sits invisibly over the capsule so the panel anchors
                  there, and is inert so it is never a second tab stop. The
                  `scope="day"` is because this shell IS day-only; a stale
                  persisted `scope: 'week'` would otherwise report Grouping as
                  unavailable here. */}
              <span inert className="pointer-events-none absolute inset-0 opacity-0 [&>button]:size-full">
                <DisplayMenu ref={displayRef} surface="canvas" trigger="icon" scope="day" />
              </span>
            </span>
            <DropdownMenuContent align="end" sideOffset={8} className="w-52" data-testid="mobile-view-menu">
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Layout</DropdownMenuLabel>
              {LAYOUTS.map((l) => (
                <DropdownMenuItem key={l.value} onSelect={() => setLayout(l.value)} data-layout={l.value}>
                  <l.icon className="size-4" />
                  <span className="flex-1">{l.label}</span>
                  {l.value === layout && <Check className="size-4" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Rows</DropdownMenuLabel>
              {DENSITIES.map((d) => (
                <DropdownMenuItem
                  key={d.value}
                  onSelect={() => setDensity(d.value)}
                  data-testid={`mobile-density-${d.value}`}
                >
                  <span className="flex-1">{d.label}</span>
                  {d.value === density && <Check className="size-4" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                // After this menu has closed, so the Display menu's own focus
                // handling is not fighting this one's return.
                onSelect={() => setTimeout(() => displayRef.current?.open(capsuleRef), 0)}
              >
                <SlidersHorizontal className="size-4" />
                Display…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* 30px, as the iPhone's avatar is; the button keeps a 32px target. */}
          <span className="flex [&_[data-slot=avatar]]:size-[30px]">
            <UserProfileDropdown settingsHref={settingsHref} onOpenBugReport={onOpenBugReport} />
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-1 px-4 empty:hidden">
        {/* "Today's review is waiting", under the date it is about. Renders
            nothing on any other date, and nothing at all when the review is
            not owed. */}
        <DayHeaderNotice scope="day" />
        {/* Vacation mode's line, on every date (away-notice.tsx). */}
        <AwayNotice className="px-1 py-1" />
        {/* The Display shelf: what the Display menu has set, in words, while
            anything is. In flow, so the day under it re-fits its hour rows as
            the shelf comes and goes. */}
        <DisplayShelf surface="canvas" menu={displayRef} touch className="px-1 pt-0 pb-1" />
      </div>
    </header>
  );
}
