'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Flame, Loader2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { agentStatusView, hasAgentState } from '@/lib/agent-status';
import type { Priority, RepeatFrequency } from '@/lib/planner-types';
import { cn } from '@/lib/utils';

/**
 * Row metadata primitives — the "quiet rail".
 *
 * The old boxed pills (border + fill + 11px label, one per datum) were replaced
 * because their widths were content-driven: sitting left-aligned inside
 * fixed-width columns they produced ragged right edges and unequal gaps, and
 * tasks and habits used different column sets so a mixed list never shared an
 * edge. The fix is de-chroming, not more columns — every datum becomes either a
 * fixed-size glyph or bare tabular text, so alignment comes from identical box
 * sizes rather than from lining up unlike content.
 *
 * Color is quarantined: it lives in a 6px dot, three 2px bars, a flame, or the
 * single lime bead marking today in the weekday run — never in a container and
 * never in body text. See components/primitives/task-row.tsx for how these
 * compose into the trailing rail, and which of them reserve width.
 */

/**
 * The rail's tooltip shell. Every column in the quiet rail is a de-chromed glyph
 * or a bare numeral — which is what buys the alignment, and what costs the reader
 * any label saying what they are looking at. This is where the label goes: an
 * eyebrow naming the COLUMN over the value spelled out in words.
 *
 * It wears `TooltipContent`, which deliberately wears the popover shell rather
 * than shadcn's inverted chip (see components/ui/tooltip.tsx), so a rail tooltip,
 * the DayDots keycap panel and the sidebar's History popover are one object.
 *
 * Native `title` is NOT an option for these and the callers below drop theirs:
 * it renders in a system font at the OS's own delay, unstyleable, and having both
 * fires two tooltips for one hover.
 */
export function RailTooltip({
  label,
  detail,
  side = 'top',
  children,
}: {
  /** What this column IS — the muted eyebrow. */
  label: string;
  /** The value in words. Omit for a label-only tip. */
  detail?: React.ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** The trigger. Cloned via asChild, so it must take a ref and spread props. */
  children: React.ReactNode;
}) {
  const tip = useQuietTip();
  return (
    <Tooltip open={tip.open} onOpenChange={tip.onOpenChange}>
      <TooltipTrigger asChild {...tip.triggerProps}>
        {children}
      </TooltipTrigger>
      <RailTipContent side={side} label={label} detail={detail} />
    </Tooltip>
  );
}

/**
 * The rail tooltip's panel on its own: muted eyebrow over the value. Split out
 * for a trigger that is already some other Radix trigger (the Display menu's
 * icon button), where the Tooltip root, the trigger and this panel cannot sit
 * in one wrapper — see components/primitives/display-menu.tsx.
 */
export function RailTipContent({
  label,
  detail,
  side = 'top',
}: {
  label: string;
  detail?: React.ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  return (
    <TooltipContent side={side} align="center">
      <div className={cn('px-0.5 text-2xs font-medium text-muted-foreground', detail && 'mb-1')}>
        {label}
      </div>
      {detail && <div className="px-0.5 text-xs text-foreground">{detail}</div>}
    </TooltipContent>
  );
}

/**
 * Open on hover and on KEYBOARD focus, never on focus handed back.
 *
 * Radix opens a tooltip on any focus. A button that opens a menu or a dialog
 * gets focus back when that closes, so a mouse user who picked something from
 * the Display menu, or saved the Add dialog, found the button's tooltip popped
 * open over the list they had just changed. `:focus-visible` is the browser's
 * own answer to "did the keyboard put focus here" — set when you Tab in, not
 * when focus returns after a click — so a focus-driven open is let through
 * only when the trigger matches it, and a hover always is.
 */
export function useQuietTip() {
  const [open, setOpen] = useState(false);
  const hovered = useRef(false);
  const onOpenChange = useCallback((next: boolean) => {
    if (!next || hovered.current) {
      setOpen(next);
      return;
    }
    const el = document.activeElement;
    let keyboard = true;
    try {
      keyboard = !el || el.matches(':focus-visible');
    } catch {
      // An engine without the selector: behave as Radix does.
    }
    if (keyboard) setOpen(true);
  }, []);
  const triggerProps = {
    onPointerEnter: () => {
      hovered.current = true;
    },
    onPointerLeave: () => {
      hovered.current = false;
    },
  };
  // For a trigger that also opens something: the pointer that was on it is now
  // on a menu, so forget the hover along with the open state.
  const reset = useCallback(() => {
    hovered.current = false;
    setOpen(false);
  }, []);
  return { open, onOpenChange, triggerProps, reset };
}

const PRIORITY_LABEL: Record<Priority, string> = { high: 'High', medium: 'Med', low: 'Low' };

/** Unabbreviated, for the tooltip — 'Med' is a glyph label, not a word. */
const PRIORITY_LABEL_FULL: Record<Priority, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/** How many of the three bars are lit. Count encodes level redundantly to hue,
 *  so the glyph survives colorblindness and low-contrast displays. */
const PRIORITY_BARS: Record<Priority, number> = { low: 1, medium: 2, high: 3 };

/* Static class names — Tailwind's JIT only keeps classes it can see as
   literals, so these must not be built by template interpolation. */
const PRIORITY_FILL: Record<Priority, string> = {
  low: 'bg-priority-low',
  medium: 'bg-priority-medium',
  high: 'bg-priority-high',
};
const BAR_HEIGHT = ['h-1', 'h-[7px]', 'h-2.5'];
/** Height of the tallest bar — the real vertical extent of the glyph's ink. */
const BAR_STACK_HEIGHT = 'h-2.5';

/**
 * Priority as a 16px cell-signal glyph — replaces the old solid PriorityPill.
 * Occupies the row's fixed glyph slot, so it aligns with the habit flame that
 * takes the same slot on habit rows.
 *
 * Two boxes, not one. The outer 16px square is the SLOT (and the hit/tooltip
 * target) and matches the flame's; the inner box is only as tall as the tallest
 * bar and is what actually gets centered. Bottom-aligning the bars directly
 * inside the 16px square — which is what this did before — centered the box but
 * not the ink: the bars only fill its lower 10px, so the glyph rendered 3px
 * below the row's optical center while every other rail item sat on it.
 */
export function PriorityGlyph({ priority, className }: { priority: Priority; className?: string }) {
  const lit = PRIORITY_BARS[priority];
  const label = `${PRIORITY_LABEL[priority]} priority`;
  return (
    <RailTooltip label="Priority" detail={PRIORITY_LABEL_FULL[priority]}>
      <span
        aria-label={label}
        role="img"
        className={cn('flex h-4 w-4 flex-shrink-0 items-center justify-center', className)}
      >
        <span className={cn('flex items-end gap-px', BAR_STACK_HEIGHT)}>
          {BAR_HEIGHT.map((h, i) => (
            <span
              key={h}
              className={cn('w-0.5 rounded-full', h, i < lit ? PRIORITY_FILL[priority] : 'bg-muted-foreground/25')}
            />
          ))}
        </span>
      </span>
    </RailTooltip>
  );
}

/**
 * Habit streak in the row's glyph slot: presence says "this is a habit", colour
 * says the streak is alive, and the numeral says how long.
 *
 * The count used to live two columns outboard, in the quantity slot, so that the
 * flame could never change width. It moved here when habits gained a duration
 * (see memory/plans/unified-items.md) and the quantity column became duration for
 * every type — a column holding minutes on one row and days on the next can't be
 * scanned as either. Flame and count are one datum and now read as one mark; the
 * slot is still fixed-width, so the rail is intact.
 *
 * The count element renders even at streak 0 (empty). It is the only observable
 * output of the streak counter — see MetaText's testId note.
 */
export function StreakFlame({ streak, className }: { streak: number; className?: string }) {
  const active = streak > 0;
  return (
    <RailTooltip
      label="Streak"
      detail={active ? `${streak} ${streak === 1 ? 'day' : 'days'} in a row` : 'No streak yet'}
    >
      <span
        role="img"
        aria-label={active ? `${streak}-day streak` : 'No streak yet'}
        className={cn('flex flex-shrink-0 items-center gap-1', className)}
      >
        <Flame
          aria-hidden
          className={cn('h-3.5 w-3.5 flex-shrink-0', active ? 'text-warning-text' : 'text-muted-foreground/40')}
        />
        <MetaText testId="item-streak">{active ? streak : ''}</MetaText>
      </span>
    </RailTooltip>
  );
}

/**
 * Quantitative / contextual metadata: duration, start time, habit progress,
 * streak count. Bare mono text, no chrome — right-aligned in a fixed slot by
 * the caller so digits form one hard rail down the list.
 */
export function MetaText({
  children,
  className,
  testId,
  tooltip,
}: {
  children?: React.ReactNode;
  className?: string;
  /**
   * Stable handle for e2e. These slots are the ONLY observable output of the
   * habit counters (progress, streak), and the rail is right-anchored, so
   * without a testid they can only be read by DOM position in a column that is
   * actively being redesigned.
   */
  testId?: string;
  /**
   * Names the column this numeral belongs to, on hover. Optional because the
   * schedule blocks reuse MetaText inside a pane that already labels its own
   * metadata by position; it's the ROW rail where a bare figure needs saying.
   */
  tooltip?: { label: string; detail?: React.ReactNode };
}) {
  const text = (
    <span data-testid={testId} className={cn('font-num text-2xs text-muted-foreground', className)}>
      {children}
    </span>
  );
  if (!tooltip) return text;
  return (
    <RailTooltip label={tooltip.label} detail={tooltip.detail}>
      {text}
    </RailTooltip>
  );
}

/**
 * MetaText for a figure that is being EDITED live, rather than merely reported —
 * the duration on a schedule block under a resize drag.
 *
 * A resize snaps in 15-minute steps, so a plain text node swaps between strings
 * that share no glyphs ("45m" → "1h") with nothing connecting them: the readout
 * flickers, and at 10px it's easy to miss that it moved at all. Here the slot
 * turns over instead — the old figure leaves the way the value went and the new
 * one arrives from the other side (see meta-roll-in/out in globals.css). The
 * DIRECTION is the whole point: it ties the numeral to the edge under the cursor,
 * so the readout reads as one value moving rather than as a stream of unrelated
 * ones.
 *
 * Takes the value and its formatter, not formatted text, for two reasons: the
 * direction has to be derived by comparing numbers, and "1h" appearing for both
 * 60 and 60-after-59 must be told apart from "1h" that hasn't changed.
 *
 * `active` is what makes the turn worth watching, and it is not decoration. A
 * resize expands the grid to the full day at a frozen scale, which drops the hour
 * height to ~29px and pins every block under ~78 minutes at PANE_MIN_H — so the
 * block barely changes size and this figure is the ENTIRE readout for the gesture.
 * At the rail's resting 10px muted grey it is missable, so for the duration of the
 * drag it steps up to 11px ink: the one datum on the block that is currently an
 * instrument rather than a report.
 */
export function RollingMetaText({
  value,
  format,
  active,
  className,
  testId,
}: {
  value: number;
  format: (value: number) => string;
  /** The value is being edited right now — promote it out of the quiet rail. */
  active?: boolean;
  className?: string;
  testId?: string;
}) {
  // Render-phase state adjustment (React's supported "derive state from a changed
  // prop" pattern) rather than an effect or a ref: the outgoing figure has to be
  // captured on the SAME commit that paints the incoming one. An effect would
  // start the turn a frame late — visibly behind a pointer the user is still
  // moving — and a ref would already hold the new value by the time the outgoing
  // layer rendered.
  const [roll, setRoll] = useState({ value, from: null as string | null, dir: 1, seq: 0 });
  if (roll.value !== value) {
    setRoll({
      value,
      from: format(roll.value),
      dir: value > roll.value ? 1 : -1,
      seq: roll.seq + 1,
    });
  }

  return (
    // inline-block, not inline: `overflow` is ignored on inline boxes, and the
    // clip to a single line box is what makes the two figures pass through a slot
    // instead of crossing over each other in the open. (Both call sites are flex
    // rows, which blockify this anyway — it's stated so the primitive doesn't
    // depend on its parent to work.)
    <span
      data-testid={testId}
      data-rolling={active ? 'true' : undefined}
      className={cn(
        'relative inline-block overflow-hidden font-num',
        // Size and colour are the promotion; the transition is only on colour,
        // because the size step has to be instant — the slot's height IS the
        // roll's travel distance, and easing it would ease the travel with it.
        active ? 'text-xs text-foreground' : 'text-2xs text-muted-foreground',
        'transition-colors duration-150',
        className
      )}
      style={{ '--roll-dir': String(roll.dir) } as React.CSSProperties}
    >
      {/* The outgoing figure. Keyed on the step counter, so a drag that ticks
          faster than the turn REPLACES it rather than queueing another one — a
          flick spins the slot and settles on wherever the pointer stopped. Left
          mounted once it finishes: it costs no layout (absolute) and ends at
          opacity 0, so there is nothing to clean up and no timer to race the next
          step. aria-hidden because the live figure below is the accessible one. */}
      {roll.from !== null && (
        <span
          key={`out-${roll.seq}`}
          aria-hidden
          className="animate-meta-roll-out pointer-events-none absolute left-0 top-0 whitespace-nowrap"
        >
          {roll.from}
        </span>
      )}
      {/* The live figure, and the one that sets the slot's width and height.
          Unanimated until the value has actually changed once, so a block
          scrolling or mounting into view doesn't announce a turn that never
          happened. */}
      <span
        key={`in-${roll.seq}`}
        className={cn('block whitespace-nowrap', roll.from !== null && 'animate-meta-roll-in')}
      >
        {format(value)}
      </span>
    </span>
  );
}

/**
 * Project / habit-group identity as a 6px color dot + muted name. The dot
 * carries the category color at full saturation (a tiny area reads in both
 * themes); the name stays muted gray so a list of tags never shouts. Callers
 * hide `nameClassName` at narrow widths, leaving the dot as a presence
 * indicator with the name on hover.
 *
 * Callers pass a FIXED width in `className` (see task-row.tsx). That is what
 * turns the dot into a rail: with the slot width constant, the dot's left edge
 * is constant too, and a name longer than the slot ellipsizes instead of pushing
 * its neighbours. Sizing this to content is what left the column ragged before.
 */
export function TagDot({
  name,
  color,
  label,
  className,
  nameClassName,
}: {
  name: string;
  color?: string;
  /**
   * What KIND of container this is — 'Project' for tasks, 'Group' for habits,
   * from the type registry's `form.containerLabel`. The dot and name alone can't
   * say which namespace they came from, and below lg the name is hidden entirely
   * and the tooltip is the only reading of the column there is.
   */
  label?: string;
  className?: string;
  nameClassName?: string;
}) {
  const tag = (
    <span className={cn('flex min-w-0 flex-shrink-0 items-center gap-1.5', className)}>
      <span
        aria-hidden
        className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
        style={{ backgroundColor: color ?? 'var(--muted-foreground)' }}
      />
      <span className={cn('truncate text-2xs font-medium text-muted-foreground', nameClassName)}>{name}</span>
    </span>
  );
  if (!label) return tag;
  return (
    <RailTooltip label={label} detail={name}>
      {tag}
    </RailTooltip>
  );
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Two-letter keycap faces. Every label is the same width at a mono size, which
 *  is what lets the seven caps sit on one even pitch without a fixed width. */
const DAY_KEYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/** Which weekday indices a recurrence lands on; null when it isn't a weekly pattern. */
function recurrenceDays(frequency?: RepeatFrequency | string, repeatDays?: number[]): number[] | null {
  switch (frequency) {
    case 'daily':
      return [0, 1, 2, 3, 4, 5, 6];
    case 'weekdays':
      return [1, 2, 3, 4, 5];
    case 'weekends':
      return [0, 6];
    case 'weekly':
    case 'custom':
      return repeatDays ?? [];
    default:
      return null;
  }
}

/**
 * Seven beads — which days an item repeats on. Scheduled days are a filled 5px
 * dot, the rest are drawn as a 1px ring.
 *
 * All seven positions ALWAYS render. That's the fix for what made the old boxed
 * version the worst offender in the row audit: printing only the active days
 * made the run swing 40px ("Sa Su") to 120px ("Su M T W Th F Sa"), so it never
 * lined up. Rendering all seven says strictly more, too — you can see which days
 * are *off*, not just which are on.
 *
 * Off-days are a ring rather than a faded fill so presence is carried by SHAPE,
 * not opacity: a 25%-alpha 5px dot dissolves on a dimmed laptop or a glare-lit
 * screen, an outlined one doesn't. Ring weight is theme-specific — see --day-off
 * in app/globals.css for why the two grounds can't share one alpha.
 *
 * WIDTH CONTRACT: this always occupies exactly 59px (7 × 5px + 6 × 4px gap),
 * including when the item doesn't repeat at all — it renders an empty slot
 * rather than nothing. Reserving the void is what lets a mixed task+habit list
 * put the tag column on a straight edge; see the rail comment in task-row.tsx.
 *
 * Hovering the run opens a real tooltip (not the native `title`) that expands
 * the beads into named keycaps. 5px beads are as compact as a weekly pattern
 * can get, but they cost you WHICH days without counting positions — and a
 * browser tooltip could only have handed back the same sentence in a system
 * font, at the OS's own half-second delay, unstyleable. The keycaps put the
 * letters back on the marks they belong to.
 */
const DAY_DOTS_WIDTH = 'w-[59px]';

/**
 * Hit-area bleed for the tooltip trigger. The beads are 5px tall, which is a
 * cruel target to have to land on with a mouse, so the trigger stretches to
 * the rail's height and then bleeds 6px past it in each direction — the row's
 * own py-1.5 — making the whole 59px column hoverable edge to edge.
 *
 * The negative margin is what keeps this free: flexbox sizes the line from the
 * items' OUTER hypothetical heights, so -my-1.5 cancels the py-1.5 and the rail
 * measures this slot at its 5px content height exactly as before. Nothing moves.
 *
 * The 6px is task-row's padding, and this is coupled to it — safe only because
 * DayDots renders in one place, the default-density bucket row. If it ever gets
 * a compact caller (py-1), this has to come from the caller instead.
 */
const DAY_DOTS_HIT = 'self-stretch -my-1.5 py-1.5';

export function DayDots({
  frequency,
  repeatDays,
  highlightDay,
  className,
}: {
  frequency?: RepeatFrequency | string;
  repeatDays?: number[];
  /** Weekday index to emphasize — the day this row is being rendered for. */
  highlightDay?: number;
  className?: string;
}) {
  const days = frequency === 'monthly' ? null : recurrenceDays(frequency, repeatDays);

  // Monthly recurs on a date, not a weekday, so there is nothing to plot. It
  // borrows the same fixed box and spends it on a word — "Monthly" sets to
  // ~42px at text-2xs, comfortably inside 59px, so the rail is unaffected.
  if (frequency === 'monthly') {
    return (
      <span
        /* justify-, not text-center: callers switch this slot to a flex box at
           lg, where the bare text is an anonymous flex item that text-center
           can't reach. */
        className={cn(DAY_DOTS_WIDTH, 'flex-shrink-0 justify-center text-2xs text-muted-foreground/70', className)}
      >
        Monthly
      </span>
    );
  }

  // One-off items reserve the slot and draw nothing in it.
  if (!days || days.length === 0) {
    return <span aria-hidden className={cn(DAY_DOTS_WIDTH, 'flex-shrink-0', className)} />;
  }

  const label =
    days.length === 7 ? 'Repeats every day' : `Repeats ${days.map((d) => DAY_NAMES[d]).join(', ')}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          className={cn(DAY_DOTS_WIDTH, DAY_DOTS_HIT, 'flex flex-shrink-0 items-center gap-1', className)}
        >
          {DAY_NAMES.map((name, day) => {
            const on = days.includes(day);
            const today = day === highlightDay;
            return (
              <span
                key={name}
                aria-hidden
                /* border-box keeps every bead exactly 5px whether it is filled or
                   outlined, so the run never reflows between states. */
                className={cn(
                  'h-[5px] w-[5px] flex-shrink-0 rounded-full border',
                  on ? 'bg-day-on border-day-on' : 'border-day-off',
                  today && (on ? 'bg-day-today border-day-today' : 'border-day-today')
                )}
              />
            );
          })}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="center">
        {/* Same eyebrow as the History popover's label — one panel language. */}
        <div className="mb-1.5 px-0.5 text-2xs font-medium text-muted-foreground">
          {repeatSummary(days)}
        </div>
        <DayKeycaps days={days} highlightDay={highlightDay} />
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The pattern in words — what the beads can't say. Deliberately NOT a list of
 * day names: the caps below it already spell those out, so this line carries
 * the shape of the recurrence (and, for custom sets, how many days a week)
 * instead of repeating them.
 */
function repeatSummary(days: number[]): string {
  const has = (d: number) => days.includes(d);
  if (days.length === 7) return 'Repeats every day';
  if (days.length === 5 && [1, 2, 3, 4, 5].every(has)) return 'Repeats on weekdays';
  if (days.length === 2 && has(0) && has(6)) return 'Repeats on weekends';
  if (days.length === 1) return 'Repeats once a week';
  return `Repeats ${days.length}× a week`;
}

/**
 * The seven weekdays as keycaps — the expanded reading of the bead run, shown
 * only inside its tooltip. Scheduled days are a pressed key (recessed
 * surface-3 fill + full hairline, the boxed language RowControl already uses);
 * off days keep the cap outline but leave it empty, so the row still reads as
 * seven keys rather than as a gappy word.
 *
 * Recessed-for-on, rather than raised, because the panel is surface-2 and
 * surface-3 sits BELOW it in both themes — a raised treatment would have to
 * invert between light and dark to stay visible, and this doesn't.
 *
 * Today is marked the same way the bead is: the --day-today accent, on the
 * border and the face, independent of whether the day is on.
 */
function DayKeycaps({ days, highlightDay }: { days: number[]; highlightDay?: number }) {
  return (
    <span aria-hidden className="flex items-center gap-1">
      {DAY_KEYS.map((key, day) => {
        const on = days.includes(day);
        const today = day === highlightDay;
        return (
          <span
            key={key}
            className={cn(
              'flex h-[19px] min-w-[23px] items-center justify-center rounded-[5px] border px-1 font-num text-2xs leading-none',
              on ? 'border-border bg-surface-3 text-foreground' : 'border-border/50 text-muted-foreground/45',
              today && 'border-day-today text-day-today'
            )}
          >
            {key}
          </span>
        );
      })}
    </span>
  );
}

/** "15m" / "1h" / "1h 30m" — the one duration format used everywhere. */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** The same value in words, for a tooltip body: "45 minutes" / "1 hour 30 minutes". */
export function formatDurationLong(minutes: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (minutes < 60) return plural(minutes, 'minute');
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${plural(h, 'hour')} ${plural(m, 'minute')}` : plural(h, 'hour');
}

/**
 * A count beside a label — the one piece of metadata in the app that keeps a
 * container.
 *
 * It went bare when the bucket card's 45px header band was deleted, on the
 * argument that a chip out-weighs the label it belongs to. That was right about
 * the old 20px chip and wrong about the chip as such: with the bucket caption
 * muted down to sit under the rows in the reading order, a bare numeral beside a
 * faint label stops reading as a count at all — it reads as part of the word.
 * The container is what separates them, so it comes back, sized to the caption
 * rather than to the band it used to live in.
 *
 * `--surface-3` deliberately, not a border: it is the app's well value, so the
 * chip is recessed in light and raised in dark. That polarity flip is the same
 * one every other surface-3 chip in the app already has (see DayKeycaps), and it
 * keeps the count reading as a slot the number sits in rather than as a control.
 *
 * `size` tracks the caption it sits in: 18px in the day view's 22px row, 16px in
 * week's 16px one, where a 20px chip could not fit at all. Both are min-widths —
 * a three-digit count grows sideways only, so the caption never reflows
 * vertically.
 */
export function CountBadge({
  count,
  className,
  testId,
  size = 'md',
}: {
  count: number;
  className?: string;
  testId?: string;
  size?: 'sm' | 'md';
}) {
  if (count <= 0) return null;
  return (
    <span
      data-testid={testId}
      className={cn(
        'inline-flex flex-none items-center justify-center rounded-[5px] bg-surface-3 font-num text-2xs text-muted-foreground tabular-nums',
        size === 'md' ? 'h-[18px] min-w-[18px] px-1.5' : 'h-4 min-w-4 px-1',
        className
      )}
    >
      {count}
    </span>
  );
}


/**
 * How often the elapsed reading refreshes.
 *
 * `agentStatusView` is coarse — minutes, then hours, then days — so a
 * per-second tick would re-render the row sixty times for one changed digit.
 * A minute is the smallest interval that can ever change what it says.
 */
const AGENT_CLOCK_MS = 60_000;

/**
 * The delegated-work badge: what the agent is doing with this item, and for how
 * long.
 *
 * A sibling of the title, NOT a rail column — the same call the goal-role glyph
 * made, for the same two reasons. The rail's columns reserve width on EVERY row
 * of both types, so a sixth would cost horizontal space app-wide to say
 * something true of a handful of rows; and this needs a word, not a glyph,
 * because "Working" and "Needs you" are not distinguishable as icons.
 *
 * "Working" alone is not information — an agent four minutes into a task is
 * fine and the same agent three hours in has died somewhere. The elapsed
 * reading is the entire point, which is why it comes from a dedicated
 * `aiStatusAt` stamp (migration 041) rather than the item's `updated_at`:
 * that one moves whenever anything is edited, so renaming the task mid-run
 * would silently reset the clock and the row would report a confident wrong
 * number. No number beats a wrong one.
 *
 * The interval lives in `AgentClock` below, which this renders only for an item
 * that actually HAS a live agent state — so a planner with nothing delegated
 * starts no timers. That split is load-bearing rather than tidy: hooks cannot
 * be skipped by an early return, so a single component would have run an
 * interval on every task row in the app to render nothing.
 */
export function AgentPill({
  item,
  className,
}: {
  item: { aiStatus?: string; aiStatusAt?: string; assignee?: string };
  className?: string;
}) {
  // NO HOOKS HERE. This runs on every task row in the app, and hooks cannot be
  // skipped by an early return — an interval declared above this line would run
  // for all of them, ticking every minute to re-render a component that returns
  // null. An earlier version of this file said the opposite, and was wrong.
  // Splitting the decision from the clock is what makes the claim true: a
  // planner with nothing delegated mounts no <AgentClock> and starts no timers.
  //
  // `hasAgentState` is the clockless half of the same decision — reading
  // `Date.now()` during render is impure, and nothing about WHETHER to show the
  // pill depends on the time. Only the elapsed reading does, and that lives
  // below the mount boundary.
  if (!hasAgentState(item)) return null;
  return <AgentClock item={item} className={className} />;
}

function AgentClock({
  item,
  className,
}: {
  item: { aiStatus?: string; aiStatusAt?: string; assignee?: string };
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), AGENT_CLOCK_MS);
    return () => clearInterval(id);
  }, []);

  const view = agentStatusView(item, now);
  if (!view) return null;

  return (
    <RailTooltip label="Agent" detail={view.detail}>
      <span
        data-testid="item-agent-status"
        data-agent-state={item.aiStatus}
        data-agent-stalled={view.stalled || undefined}
        className={cn(
          'flex flex-shrink-0 items-center gap-1 text-[10px] font-medium',
          // Honey is reserved for the ONE state that wants something from the
          // user. Everything else is the agent's business and stays muted —
          // a row that shouts about work proceeding normally is a row that
          // teaches you to stop reading it.
          // Honey for the one state that wants something from the user, and
          // for a run that has stopped — because that one now wants something
          // too. Everything else is progress they are free to ignore.
          view.needsUser || view.stalled ? 'text-warning-text' : 'text-muted-foreground/70',
          className
        )}
      >
        {view.stalled ? (
          // No spinner on a run that has stopped — a spinner is a claim that
          // something is happening, and this is the row saying it is not.
          <Bot aria-hidden className="size-3 flex-shrink-0" />
        ) : view.active ? (
          <Loader2
            aria-hidden
            className={cn('size-3 flex-shrink-0', item.aiStatus === 'working' && 'animate-spin')}
          />
        ) : (
          <Bot aria-hidden className="size-3 flex-shrink-0" />
        )}
        <span>{view.label}</span>
        {view.elapsed && view.elapsed !== 'just now' && (
          <span className="tabular-nums opacity-70">{view.elapsed}</span>
        )}
        {/* The tooltip never fires on touch and never reaches a screen reader. */}
        <span className="sr-only">{view.detail}</span>
      </span>
    </RailTooltip>
  );
}
