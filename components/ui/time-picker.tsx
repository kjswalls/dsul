'use client';

/**
 * THE TIME PICKER — every place dsul asks for a time of day (Kirby's pick "B,
 * type or pick", 2026-10-30, over the browser's own time field).
 *
 * `TimeList` is the body: a field that takes a time as people type it ("930",
 * "2pm", "noon", "in 2h" — lib/time-text.ts) over a list of the day's half
 * hours with a line at now. A click or Enter sets the time; there is no Apply.
 * It drops straight into a menu flyout or a chip popover, where it IS the
 * picker. `TimeField` is the same list behind a small pill that shows the time,
 * for a row or a form that has no popover of its own.
 *
 * Both read the user's 12/24-hour setting and hand back "HH:mm", the one shape
 * every stored time has.
 *
 * Keys: the field keeps focus and owns ↑ ↓ Enter (the rows are its listbox,
 * pointed at with aria-activedescendant). A host that is a Radix menu claims
 * printable keys for typeahead, so it must keep key events from bubbling out —
 * bulk-edit-menu's RemindPane does.
 */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps, KeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { usePlannerStore } from '@/lib/planner-store';
import { formatClock, timeRows, toMinutes } from '@/lib/time-text';
import { cn } from '@/lib/utils';

/** A mouse or trackpad: the field takes focus on open. A phone keeps its keyboard down. */
const finePointer = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: fine)').matches;

const nowMinutes = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};

export function TimeList({
  value,
  onPick,
  ariaLabel,
  placeholder,
  testId,
  autoFocus,
  className,
  listClassName,
  ...inputProps
}: {
  /** "HH:mm", or '' for none. */
  value: string;
  onPick: (hhmm: string) => void;
  ariaLabel: string;
  /** Defaults to an example in the user's clock, so it reads as a place to type. */
  placeholder?: string;
  /** On the field; each row is `${testId}-option-HH:mm`. */
  testId?: string;
  /** Focus the field on open. Defaults to on with a mouse, off on touch. */
  autoFocus?: boolean;
  className?: string;
  listClassName?: string;
} & Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'className' | 'placeholder' | 'autoFocus'>) {
  const format = usePlannerStore((s) => s.timeFormat);
  const listId = useId();
  const [query, setQuery] = useState('');
  const [now] = useState(nowMinutes);
  const { rows, typed } = useMemo(() => timeRows(query, value, format, now), [query, value, format, now]);

  // The highlight starts on the current value, or the first time still ahead.
  const startIndex = () => {
    const at = rows.indexOf(value);
    if (at >= 0) return at;
    const ahead = rows.findIndex((r) => (toMinutes(r) ?? 0) > now);
    return ahead >= 0 ? ahead : 0;
  };
  const [active, setActive] = useState(startIndex);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Opens scrolled so the highlighted row sits a couple of rows down, with the
  // times before it in view. The list is the rows' offsetParent (it is
  // `relative`), and the scroll is set again a frame later: a menu flyout lays
  // its content out after mounting it, and a scroll set before that is lost.
  useLayoutEffect(() => {
    const scroll = () => {
      const list = listRef.current;
      const row = list?.querySelector<HTMLElement>(`[data-index="${Math.max(0, active - 2)}"]`);
      if (list && row) list.scrollTop = row.offsetTop;
    };
    scroll();
    const frame = requestAnimationFrame(scroll);
    return () => cancelAnimationFrame(frame);
    // Once, on open; later moves scroll only as far as they need to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [focusOnOpen] = useState(() => autoFocus ?? finePointer());
  useEffect(() => {
    if (!focusOnOpen) return;
    // A frame later too, for the same reason: a flyout that is still being
    // placed can drop focus given to it on mount.
    inputRef.current?.focus({ preventScroll: true });
    const frame = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [focusOnOpen]);

  const move = (to: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, to));
    setActive(next);
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${next}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  };

  const pick = (hhmm: string) => {
    setQuery('');
    onPick(hhmm);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(active + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(active - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[active];
      if (row) pick(row);
    }
    inputProps.onKeyDown?.(e);
  };

  const nowAt = query ? -1 : rows.findIndex((r) => (toMinutes(r) ?? 0) > now);
  const optionId = (i: number) => `${listId}-${i}`;

  return (
    <div className={cn('flex flex-col', className)}>
      <div className="border-border mx-1 mb-1 flex h-8 items-center border-b px-0.5">
        <input
          {...inputProps}
          ref={inputRef}
          type="text"
          inputMode="text"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={rows[active] ? optionId(active) : undefined}
          autoComplete="off"
          spellCheck={false}
          data-testid={testId}
          placeholder={placeholder ?? (format === '24h' ? 'Type a time, like 14:30' : 'Type a time, like 2pm')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            if (listRef.current) listRef.current.scrollTop = 0;
          }}
          onKeyDown={onKeyDown}
          className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent px-1 text-xs outline-none"
        />
      </div>
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={ariaLabel}
        className={cn('relative max-h-48 overflow-y-auto py-0.5', listClassName)}
      >
        {rows.length === 0 && (
          <p className="text-muted-foreground px-2 py-1.5 text-xs">
            {format === '24h' ? 'Try 9:30 or 14:00' : 'Try 9:30, 2pm or noon'}
          </p>
        )}
        {rows.map((r, i) => {
          const selected = r === value;
          return (
            <div key={`${r}-${i}`}>
              {i === nowAt && i > 0 && (
                <div aria-hidden className="relative mx-2 my-1.5 border-t border-dashed border-[color-mix(in_oklab,var(--lime-solid)_70%,var(--muted-foreground))]">
                  <span className="text-muted-foreground absolute -top-[7px] right-0 rounded bg-[color-mix(in_oklab,var(--popover)_85%,transparent)] px-1 text-[9px] font-semibold tracking-wide uppercase">
                    now
                  </span>
                </div>
              )}
              <div
                id={optionId(i)}
                role="option"
                aria-selected={selected}
                data-index={i}
                data-time={r}
                data-testid={testId ? `${testId}-option-${r}` : undefined}
                // The field keeps focus, so the keys keep working after a hover.
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => active !== i && setActive(i)}
                onClick={() => pick(r)}
                className={cn(
                  'font-num flex h-7 cursor-default items-center gap-2 rounded-[8px] px-2 text-xs',
                  i === active && 'bg-accent',
                  r === typed && 'font-medium'
                )}
              >
                {formatClock(r, format)}
                <span className="ml-auto flex items-center gap-1.5">
                  {r === typed && i === active && (
                    <kbd className="text-muted-foreground border-border rounded border px-1 font-sans text-[10px] leading-4">
                      ↵
                    </kbd>
                  )}
                  {selected && <Check className="size-3.5" />}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A time behind a pill: the value in the user's clock, opening the list. For
 * rows and forms; a menu or a chip popover uses `TimeList` directly.
 */
export function TimeField({
  value,
  onChange,
  ariaLabel,
  id,
  testId,
  disabled,
  placeholder = 'Set a time',
  className,
  bare,
  align = 'end',
  'aria-describedby': describedBy,
  'data-setting': dataSetting,
}: {
  value: string;
  onChange: (hhmm: string) => void;
  ariaLabel: string;
  id?: string;
  /** On the trigger; the list's field is `${testId}-input`. */
  testId?: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** No pill of its own: the time sits as text inside a host's pill. */
  bare?: boolean;
  align?: 'start' | 'center' | 'end';
  'aria-describedby'?: string;
  'data-setting'?: string;
}) {
  const format = usePlannerStore((s) => s.timeFormat);
  const [open, setOpen] = useState(false);
  const shown = toMinutes(value) != null ? formatClock(value, format) : '';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          id={id}
          data-testid={testId}
          data-setting={dataSetting}
          data-value={value}
          aria-label={`${ariaLabel}: ${shown || 'not set'}`}
          aria-describedby={describedBy}
          disabled={disabled}
          className={cn(
            'font-num inline-flex items-center gap-1 text-xs whitespace-nowrap',
            'focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
            // Bare sits in a host pill that draws the focus ring for it.
            bare
              ? 'rounded-[4px] font-medium'
              : 'bg-secondary hover-wash focus-visible:ring-ring h-8 rounded-[8px] border border-transparent pr-1.5 pl-2.5 focus-visible:ring-2',
            !shown && 'text-muted-foreground font-sans',
            className
          )}
        >
          {shown || placeholder}
          {!bare && <ChevronDown className="text-muted-foreground size-3" aria-hidden />}
        </button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-56 rounded-[12px] p-1">
        <TimeList
          value={value}
          ariaLabel={ariaLabel}
          testId={testId ? `${testId}-input` : undefined}
          onPick={(hhmm) => {
            onChange(hhmm);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
