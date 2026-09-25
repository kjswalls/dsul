'use client';

import { useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { format } from 'date-fns';
import { ArrowRight, Check, Link2, Plus, X } from 'lucide-react';
import { Calendar } from '@/components/ui/calendar';
import { ChipOption, PropertyChip } from '@/components/primitives/property-chip';
import { ACCENT_NAMES, ColorSwatchGrid } from '@/components/primitives/color-swatch-picker';
import { ACCENT_RAMP } from '@/lib/accent-colors';
import { formatShort, parseDay, useToday } from '@/lib/collections';
import { cn } from '@/lib/utils';
import { useEscapeRung } from '@/components/planner/organize/escape-ladder';

/**
 * The chip-and-section vocabulary the organizer surfaces share — the "new"
 * dialog's goal/routine/program/project bodies and the console's detail panes.
 * Everything here is built on PropertyChip, so an organizer's window or colour
 * reads exactly like an item's date or project: unset shows the noun, dashed;
 * set shows the value.
 *
 * Dates cross these props as `yyyy-MM-dd` strings, the shape goals and programs
 * store them in, and are only turned into Dates (local noon, via parseDay) for
 * the calendar.
 */

const toDay = (d: Date) => format(d, 'yyyy-MM-dd');

/** `Today` for today, else the short month-day. */
function dayCopy(dateStr: string, today: string): string {
  return dateStr === today ? 'Today' : formatShort(dateStr);
}

/**
 * Plain-text form of a range: "Sep 20 → Mar 1", "From Sep 20", "Until Mar 1".
 * `today` should be the USER's (useToday) — the browser's is only the fallback
 * for a caller with no store to ask; the two differ for a traveller near midnight.
 */
export function rangeCopy(
  start?: string,
  end?: string,
  today: string = toDay(new Date())
): string | undefined {
  if (start && end) return `${dayCopy(start, today)} → ${dayCopy(end, today)}`;
  if (start) return `From ${dayCopy(start, today)}`;
  if (end) return `Until ${dayCopy(end, today)}`;
  return undefined;
}

/**
 * A start → end pair of days as one chip. One calendar, not two: a
 * two-segment switch above it picks which side the next click sets, and each
 * side's days are fenced so the range can never invert (a program whose start
 * falls after its end is live on no date at all — lib/active.ts).
 */
export function DateRangeChip({
  start,
  end,
  onChange,
  startLabel,
  endLabel,
  emptyLabel,
  label,
  testIdPrefix,
  disabled,
}: {
  start?: string;
  end?: string;
  onChange: (start: string | undefined, end: string | undefined) => void;
  /** Segment names — "Started" | "Target", "Starts" | "Ends". */
  startLabel: string;
  endLabel: string;
  /** The noun the dashed chip shows with neither side set — "Target", "Runs". */
  emptyLabel: string;
  /** Optional muted key ahead of a SET value — the dialog's "Window Today → Mar 1". */
  label?: string;
  testIdPrefix: string;
  disabled?: boolean;
}) {
  // Open on the side that still wants a value: a goal born with today as its
  // start is here to be given a target.
  const [side, setSide] = useState<'start' | 'end'>(start && !end ? 'end' : 'start');
  // The user's today, so the chip says "Today" for the same day the dialog and
  // the console seed as a goal's start — not the browser's.
  const { todayStr } = useToday();
  const text = rangeCopy(start, end, todayStr);
  const startDate = parseDay(start);
  const endDate = parseDay(end);
  const selected = side === 'start' ? startDate : endDate;

  const display = text ? (
    <span className="inline-flex items-center gap-1.5">
      {label && <span className="text-muted-foreground">{label}</span>}
      {start && end ? (
        <>
          <span className="font-num">{dayCopy(start, todayStr)}</span>
          <ArrowRight className="text-muted-foreground size-3" aria-hidden />
          <span className="font-num">{dayCopy(end, todayStr)}</span>
        </>
      ) : (
        <span>
          {start ? 'From' : 'Until'}{' '}
          <span className="font-num">{dayCopy((start ?? end)!, todayStr)}</span>
        </span>
      )}
    </span>
  ) : undefined;

  return (
    <PropertyChip
      label={emptyLabel}
      value={text}
      display={display}
      ariaLabel={text ? `${emptyLabel}: ${text}` : emptyLabel}
      disabled={disabled}
      testId={`${testIdPrefix}-chip`}
      contentClassName="w-auto p-0"
    >
      {(close) => (
        <div>
          <div className="p-2 pb-0">
            <div className="bg-surface-3 flex h-8 items-center gap-0.5 rounded-[10px] p-1">
              {(['start', 'end'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSide(s)}
                  data-testid={`${testIdPrefix}-${s}`}
                  data-active={side === s ? '' : undefined}
                  aria-pressed={side === s}
                  className={cn(
                    'h-6 flex-1 rounded-[8px] px-3 text-xs transition-[background-color,box-shadow] duration-150',
                    'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                    side === s
                      ? 'bg-surface-2 text-foreground font-medium shadow-[var(--shadow-elev-sm)]'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {s === 'start' ? startLabel : endLabel}
                  {(s === 'start' ? start : end) && (
                    <span className="text-muted-foreground font-num ml-1.5 font-normal">
                      {formatShort((s === 'start' ? start : end)!)}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
          <Calendar
            // Re-key per side so the month jumps to that side's day.
            key={side}
            mode="single"
            selected={selected}
            defaultMonth={selected ?? (side === 'end' ? startDate : endDate)}
            disabled={
              side === 'start'
                ? endDate && { after: endDate }
                : startDate && { before: startDate }
            }
            onSelect={(date) => {
              if (!date) return;
              if (side === 'start') {
                onChange(toDay(date), end);
                // Setting the start is usually the first half of a pair.
                if (!end) setSide('end');
                else close();
              } else {
                onChange(start, toDay(date));
                close();
              }
            }}
            initialFocus
          />
          {(start || end) && (
            <div className="border-t p-1">
              {start && (
                <ChipOption
                  tone="muted"
                  testId={`${testIdPrefix}-clear-start`}
                  onSelect={() => {
                    onChange(undefined, end);
                    setSide('start');
                  }}
                >
                  <X className="size-3.5" />
                  Clear {startLabel.toLowerCase()}
                </ChipOption>
              )}
              {end && (
                <ChipOption
                  tone="muted"
                  testId={`${testIdPrefix}-clear-end`}
                  onSelect={() => {
                    onChange(start, undefined);
                    setSide('end');
                  }}
                >
                  <X className="size-3.5" />
                  Clear {endLabel.toLowerCase()}
                </ChipOption>
              )}
            </div>
          )}
        </div>
      )}
    </PropertyChip>
  );
}

/** The ramp's display name for a stored colour, "Custom" for legacy free text. */
export function colorName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const i = ACCENT_RAMP.indexOf(value);
  return i >= 0 ? ACCENT_NAMES[i] : 'Custom';
}

/**
 * An organizer's colour as a chip: the identity square plus the colour's name.
 * Unset (Auto — the name-hash default) reads as the dashed noun, so a chip row
 * never claims a colour the user did not choose.
 */
export function ColorChip({
  value,
  onChange,
  testId,
  disabled,
}: {
  value?: string;
  /** `undefined` = Auto — clear the stored colour. */
  onChange: (color: string | undefined) => void;
  testId?: string;
  disabled?: boolean;
}) {
  return (
    <PropertyChip
      label="Color"
      value={colorName(value)}
      swatch={value}
      swatchShape="square"
      disabled={disabled}
      testId={testId}
      contentClassName="w-auto p-2"
    >
      {(close) => (
        <ColorSwatchGrid
          value={value}
          onPick={(color) => {
            onChange(color);
            close();
          }}
        />
      )}
    </PropertyChip>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  /** A css colour, or the two named tones: 'lime' (live) and 'muted' (at rest). */
  dot?: string;
}

function dotColor(dot: string | undefined): string | undefined {
  if (dot === 'lime') return 'var(--lime-solid)';
  if (dot === 'muted') return 'var(--muted-foreground)';
  return dot;
}

/**
 * One-of-n as a chip — a status. Always set, so always filled; the dot carries
 * the state's tone and the caret stays, because it is a switcher.
 */
export function ChoiceChip<T extends string>({
  value,
  options,
  onChange,
  testIdPrefix,
  label,
  disabled,
}: {
  value: T;
  options: readonly ChoiceOption<T>[];
  onChange: (value: T) => void;
  testIdPrefix: string;
  /** The property's noun — the accessible name and the fallback copy. */
  label: string;
  disabled?: boolean;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <PropertyChip
      label={label}
      value={current?.label}
      swatch={dotColor(current?.dot)}
      ariaLabel={current ? `${label}: ${current.label}` : label}
      alwaysChevron
      disabled={disabled}
      testId={`${testIdPrefix}-chip`}
      contentClassName="w-48"
    >
      {(close) =>
        options.map((o) => (
          <ChipOption
            key={o.value}
            selected={o.value === value}
            value={o.value}
            testId={`${testIdPrefix}-${o.value}`}
            onSelect={() => {
              if (o.value !== value) onChange(o.value);
              close();
            }}
          >
            {o.dot ? (
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: dotColor(o.dot) }}
                aria-hidden
              />
            ) : null}
            {o.label}
            {o.value === value && <Check className="ml-auto size-3.5" aria-hidden />}
          </ChipOption>
        ))
      }
    </PropertyChip>
  );
}

/**
 * A labelled run of rows in an organizer pane — "Milestones · 2 of 5" with an
 * optional action on the right. The heading is the item edit pane's BandLabel
 * (components/planner/item-bands.tsx); an empty section is the heading and its
 * add row, never a "Nothing in here yet" block.
 */
export function OrganizerSection({
  label,
  count,
  action,
  children,
  testId,
  className,
}: {
  label: string;
  /** Number or phrase after the dot — `3`, `2 of 5`. Omitted, no dot. */
  count?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <section className={cn('flex flex-col gap-1.5', className)} data-testid={testId}>
      <div className="flex min-h-5 items-center justify-between gap-2">
        <p className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">
          {label}
          {count !== undefined && count !== null && (
            <>
              {' · '}
              <span className="font-num tracking-[0.04em]">{count}</span>
            </>
          )}
        </p>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * The small "Link existing" pill beside a section heading. Every button prop
 * (onClick, ref, aria-*) is forwarded, so it works bare or under a
 * PopoverTrigger asChild.
 */
export function LinkExistingPill({
  testId,
  className,
  label = 'Link existing',
  ...rest
}: {
  testId?: string;
  className?: string;
  label?: string;
} & Omit<ComponentProps<'button'>, 'className' | 'children'>) {
  return (
    <button
      type="button"
      {...rest}
      data-testid={testId}
      className={cn(
        'text-muted-foreground inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium',
        'hover-wash hover:text-foreground transition-colors',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
        className
      )}
    >
      <Link2 className="size-3" aria-hidden />
      {label}
    </button>
  );
}

/**
 * The last row of a section: a muted plus and a borderless input, the same
 * 30px as the member rows above it so the list does not jog. Enter adds and
 * clears, Escape clears. The small submit button only appears with text in the
 * field — it is there for a pointer (and for e2e's `…-add` clicks), not as a
 * second place to look.
 */
export function InlineAddRow({
  placeholder,
  onAdd,
  testIdPrefix,
  disabled,
  className,
}: {
  placeholder: string;
  onAdd: (title: string) => void;
  testIdPrefix: string;
  disabled?: boolean;
  className?: string;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const submit = () => {
    const title = text.trim();
    if (!title) return;
    onAdd(title);
    setText('');
  };

  // Inside the Organize console the onKeyDown below is too late for Escape —
  // Radix has already decided to close on the capture path (escape-ladder.tsx)
  // — so the clear is ALSO a rung. Outside the console there is no ladder, the
  // hook is inert, and the local stopPropagation is what holds the press.
  useEscapeRung(() => {
    if (!text || document.activeElement !== ref.current) return false;
    setText('');
    return true;
  });

  return (
    <div className={cn('flex h-[30px] items-center gap-[9px]', className)}>
      <span className="text-muted-foreground grid w-4 shrink-0 place-items-center" aria-hidden>
        <Plus className="size-4" />
      </span>
      <input
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Our keystrokes: an enclosing dialog or console must not also see
          // this Enter (submit) or Escape (close).
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            e.stopPropagation();
            submit();
          } else if (e.key === 'Escape' && text) {
            e.preventDefault();
            e.stopPropagation();
            setText('');
          }
        }}
        placeholder={placeholder}
        aria-label={placeholder.replace(/…$/, '')}
        disabled={disabled}
        data-testid={`${testIdPrefix}-new-name`}
        className="placeholder:text-muted-foreground text-foreground -mx-1 min-w-0 flex-1 border-0 bg-transparent px-1 text-[13.5px] outline-none disabled:opacity-50"
      />
      {text.trim() && (
        <button
          type="button"
          onClick={submit}
          disabled={disabled}
          data-testid={`${testIdPrefix}-add`}
          className={cn(
            'text-muted-foreground hover:text-foreground hover-wash h-6 shrink-0 rounded-sm px-2 text-xs font-medium',
            'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
          )}
        >
          Add
        </button>
      )}
    </div>
  );
}
