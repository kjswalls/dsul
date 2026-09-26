'use client';

import { useState, useEffect, useRef } from 'react';
import { format, isToday } from 'date-fns';
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Check,
  Leaf,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Calendar as CalendarComponent } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DisplayMenu, type DisplayMenuHandle } from '@/components/primitives/display-menu';
import { DisplayShelf } from '@/components/primitives/display-shelf';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { LAYOUT_OPTIONS, SCOPE_OPTIONS, type ViewOption } from '@/lib/view-options';
import { goToDate, stepScope } from '@/lib/nav-commands';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useShortcutKeys } from '@/lib/keyboard-shortcuts-store';
import { formatKeys, isApplePlatform } from '@/lib/commands/keys';

/**
 * Floating header capsule at the top of the canvas (Figma view controls
 * #56:51): gray capsule r10; date nav on top, then a white pill (r10, shadow
 * 0 4 4 rgba(0,0,0,.15)) holding the view's shape — layout · scope — and, at
 * its far end, Display and the door into Zen. Under the pill, while any
 * Display setting is on, the Display shelf says which.
 */

function SelectMenu<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: ViewOption<T>[];
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  const current = options.find((o) => o.value === value) ?? options[0];
  const Icon = current.icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={ariaLabel}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
        >
          <Icon className="h-4 w-4" />
          {current.label}
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[144px]">
        {options.map((o) => {
          const OptIcon = o.icon;
          return (
            <DropdownMenuItem
              key={o.value}
              onClick={() => onChange(o.value)}
              className="gap-2 text-sm"
            >
              <OptIcon className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1">{o.label}</span>
              {/* Inherited colour, not `text-primary-foreground` — that token is
                  --lime-ink, dark-green ink meant to sit ON a lime fill, and on
                  the popover ground it is very nearly invisible. */}
              {o.value === value && <Check className="h-3.5 w-3.5" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The door into Zen, at the end of the view pill: Zen is one more way of
 * looking at the day, so it sits with the controls that choose the view.
 * `data-zen-toggle` is also where the Relay Lift wave starts when the item Zen
 * will show is not on screen to lift (components/zen/zen-stage.tsx).
 *
 * The hint reads the live binding — every shortcut is rebindable — and prints
 * it per platform, so a Ctrl user never sees a ⌘.
 */
function ZenButton() {
  const toggleZen = useViewStore((s) => s.toggleZen);
  const keys = useShortcutKeys('toggle_zen');
  // Safe to read the platform in render: tooltip content only mounts on hover,
  // on the client, so there is no server markup for it to disagree with.
  const hint = formatKeys(keys, isApplePlatform()).join(' + ');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={toggleZen}
          aria-label="Enter zen"
          data-zen-toggle
          data-testid="header-zen"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Leaf className="h-4 w-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="flex items-center gap-2">
        Enter zen
        {hint && <kbd className="font-sans text-[11px] opacity-70">{hint}</kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

export function HeaderCapsule() {
  const selectedDate = usePlannerStore((s) => s.selectedDate);
  // Type and the canvas filters left with the popover — DisplayMenu reads them
  // from the store itself rather than taking them through here.
  const { scope, layout, setScope, setLayout } = useViewStore();
  const [mounted, setMounted] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  // The Display menu's handle, shared with the shelf under the pill, as in the
  // braindump: the shelf's text opens the menu through it, and its ✕ parks
  // focus on the trigger before the reset takes the shelf away.
  const displayRef = useRef<DisplayMenuHandle>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const goPrevious = () => stepScope(-1);
  const goNext = () => stepScope(1);

  return (
    <div className="inline-flex flex-col gap-1 rounded-[10px] bg-surface-3 p-2 shadow-[var(--shadow-elev-bar)]">
      {/* Row 1 — calendar + date nav */}
      <div className="flex items-center gap-1 px-1">
        <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="relative h-8 w-8 text-muted-foreground hover:text-foreground"
              aria-label="Open calendar"
            >
              <CalendarIcon className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <CalendarComponent
              mode="single"
              selected={selectedDate}
              onSelect={(date) => {
                if (date) goToDate(date);
                setCalendarOpen(false);
              }}
              initialFocus
            />
          </PopoverContent>
        </Popover>

        <Button
          variant="ghost"
          size="icon"
          onClick={goPrevious}
          className="h-8 w-6 text-muted-foreground hover:text-foreground"
          aria-label="Previous"
          data-testid="header-prev"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>

        <button
          onClick={() => setCalendarOpen(true)}
          title="Open calendar"
          data-testid="header-date"
          // The machine-readable selected date. The visible text is a format
          // string ('EEEE, MMMM d') with no delimiter after the day number, so
          // asserting on it needs an anchored regex — an unanchored one matches
          // 'Fri, Aug 15' for a target of 'Friday, August 1', i.e. a 14-day
          // overshoot reads as success. Also empty before hydration; this
          // attribute is not.
          data-date={mounted ? format(selectedDate, 'yyyy-MM-dd') : ''}
          className="cursor-pointer rounded-md px-1.5 font-sans text-base font-semibold text-foreground transition-colors hover:bg-accent"
        >
          {mounted ? format(selectedDate, 'EEEE, MMMM d') : <span className="inline-block w-44" />}
        </button>

        <Button
          variant="ghost"
          size="icon"
          onClick={goNext}
          className="h-8 w-6 text-muted-foreground hover:text-foreground"
          aria-label="Next"
          data-testid="header-next"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>

        {mounted && !isToday(selectedDate) && (
          <button
            onClick={() => goToDate(new Date())}
            className="ml-1 inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Go to today"
            data-testid="header-today"
          >
            <span aria-hidden="true" className="inline-block -scale-x-100 font-mono text-[11px] leading-none">
              ↵
            </span>
            Today
          </button>
        )}
      </div>

      {/* Row 2 — white pill: shape on the left, content on the right.
          Type used to sit alone on the far left while the filter popover sat on
          the far right, so the pill held one filter at each end with the two
          shape controls between them. Type is a content question and now lives
          in Display with the rest of them; what stays out here is the pair that
          changes the view's SHAPE. */}
      <div className="flex items-center rounded-[10px] bg-surface-2 px-1.5 py-1.5 shadow-[var(--shadow-elev-sm)]">
        <SelectMenu
          value={layout}
          options={LAYOUT_OPTIONS}
          onChange={(v) => setLayout(v)}
          ariaLabel="Layout"
        />
        <SelectMenu
          value={scope}
          options={SCOPE_OPTIONS}
          onChange={(v) => setScope(v)}
          ariaLabel="Scope"
        />
        <div className="ml-auto flex items-center">
          <div className="mx-1 h-4 w-px bg-border" />
          <DisplayMenu ref={displayRef} surface="canvas" />
          <div className="mx-1 h-4 w-px bg-border" />
          <ZenButton />
        </div>
      </div>

      {/* The Display shelf: what the menu has set, in words, under the pill —
          the braindump's line, in the braindump's place. It is there only while
          something is set, so a canvas with nothing set keeps the bare
          capsule, and the capsule's gap adds nothing.

          It sits IN FLOW, and this header stands over the hour grid, which
          sizes its rows to the height left below it (lib/use-fit-hour-px.ts):
          the rows re-fit as the shelf comes and goes, and as it moves between
          one line and a stack, 27px for its one line and 23px for each line
          the stack adds. That cost was taken on purpose (2026-09-25, measured
          in memory/plans/display-menu.md): the shelf is worth that much grid
          while the view is narrowed, and at rest nothing moves.

          contain-inline-size is load-bearing. This capsule is sized by its
          content, and the shelf in its one-line fit is as wide as its whole
          line, so without containment the capsule would grow to the line and
          the shelf would never stack — its fit needs its width from outside.
          Contained, the capsule keeps the width its two rows give it and the
          shelf takes that. px-4 puts the text under the Layout icon and the ✕
          under the Zen leaf; pt-1 and pb-px keep the braindump's 8px above
          and 9px below. */}
      <DisplayShelf
        surface="canvas"
        menu={displayRef}
        className="contain-inline-size px-4 pt-1 pb-px"
      />
    </div>
  );
}
