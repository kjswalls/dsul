'use client';

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, type LucideIcon } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/**
 * One property of an item, as a chip that opens its own picker.
 *
 * The rule the whole dialog is built on: an UNSET chip shows the noun
 * ("Priority"), a SET chip shows the value ("High"). That is what lets the form
 * drop its labels without hiding anything — an empty control is literally the
 * word for what it does — and what keeps an untouched field from costing a full
 * labelled row of vertical space.
 *
 * `children` is a render prop so a picker can dismiss itself on choose without
 * every call site wiring up its own open state.
 */
export function PropertyChip({
  icon: Icon,
  id,
  ariaLabel,
  label,
  value,
  swatch,
  swatchShape = 'dot',
  glyph,
  align = 'start',
  className,
  contentClassName,
  disabled,
  alwaysChevron,
  children,
  testId,
  defaultOpen = false,
  onCloseAutoFocus,
}: {
  icon?: LucideIcon;
  /** Lets a <label htmlFor> point at the trigger. Without it the association is
   *  silently dropped and the chip's only accessible name is its own value. */
  id?: string;
  /** An explicit accessible name, for a chip whose visible text is just a value. */
  ariaLabel?: string;
  /** Shown when `value` is empty — the noun for this property. */
  label: string;
  /** The set value. Empty/undefined renders the unset (dashed) state. */
  value?: string;
  /** Small colour dot, for properties whose value carries a colour. */
  swatch?: string;
  /** Swatch form — 'square' marks identity (type, project), 'dot' a value (priority). */
  swatchShape?: 'dot' | 'square';
  /** Leading glyph node (a project/group icon), replacing `icon`. */
  glyph?: ReactNode;
  align?: 'start' | 'center' | 'end';
  className?: string;
  contentClassName?: string;
  disabled?: boolean;
  /** Keep the caret on a chip that is always set — a switcher, not a value. */
  alwaysChevron?: boolean;
  children: (close: () => void) => ReactNode;
  /** Stable e2e handle. Chips are otherwise addressed by their value copy,
   *  which is registry-driven and differs per item type. */
  testId?: string;
  /** Mount with the picker already open. Read once, at mount — a chip the user
   *  just summoned from a menu opens itself instead of costing a second click. */
  defaultOpen?: boolean;
  /** Radix's close-time focus return, for a picker whose close should not pull
   *  focus back to its own trigger. */
  onCloseAutoFocus?: (e: Event) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const isSet = !!value;

  // These pickers are portalled outside the Dialog, so the modal's scroll lock
  // (react-remove-scroll) preventDefaults wheel/touchmove over them and a long
  // list — a dozen projects — cannot be scrolled by wheel at all. Drive it
  // ourselves, same as IconPicker does for the identical reason. Ref CALLBACK,
  // not an effect: an effect races the portal mount.
  const wheelCleanup = useRef<(() => void) | null>(null);
  const scrollRef = useCallback((el: HTMLDivElement | null) => {
    wheelCleanup.current?.();
    wheelCleanup.current = null;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const box = el.querySelector<HTMLElement>('[data-chip-scroll]') ?? el;
      if (box.scrollHeight <= box.clientHeight) return;
      e.preventDefault();
      box.scrollTop += e.deltaY;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    wheelCleanup.current = () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          aria-label={ariaLabel}
          disabled={disabled}
          data-testid={testId}
          data-set={isSet || undefined}
          className={cn(
            'inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-sm border px-2.5',
            'text-xs transition-colors disabled:pointer-events-none disabled:opacity-50',
            // No ring-offset: --tw-ring-offset-color defaults to #fff and would
            // paint a white hairline over the lime ring in dark mode. Matches
            // ChipOption below.
            'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
            isSet
              ? 'border-transparent bg-secondary text-foreground hover-wash'
              : 'border-input border-dashed text-muted-foreground hover-wash',
            className
          )}
        >
          {swatch ? (
            <span
              className={cn(
                'shrink-0',
                swatchShape === 'square' ? 'size-[9px] rounded-[3px]' : 'size-2 rounded-full'
              )}
              style={{ background: swatch }}
              aria-hidden
            />
          ) : glyph ? (
            <span className="flex shrink-0 items-center">{glyph}</span>
          ) : Icon ? (
            <Icon className="size-3 shrink-0" aria-hidden />
          ) : null}
          <span className="truncate">{value || label}</span>
          {!isSet || alwaysChevron ? (
            <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={scrollRef}
        align={align}
        className={cn('w-60 p-1', contentClassName)}
        // The dialog submits on Enter; a picker's own keystrokes are its
        // business. (Radix portals this outside the dialog, so this is belt
        // and braces for the focus-return case.)
        onKeyDown={(e) => e.stopPropagation()}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {children(() => setOpen(false))}
      </PopoverContent>
    </Popover>
  );
}

/** A row inside a chip's picker. `selected` renders the check. */
export function ChipOption({
  selected,
  onSelect,
  children,
  className,
  tone = 'default',
  testId,
  value,
}: {
  selected?: boolean;
  onSelect: () => void;
  children: ReactNode;
  className?: string;
  tone?: 'default' | 'muted' | 'primary';
  testId?: string;
  /** Machine-readable option value, so a test never matches on label copy. */
  value?: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={testId}
      data-value={value}
      data-selected={selected || undefined}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm hover-wash',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
        selected && 'font-medium',
        tone === 'muted' && 'text-muted-foreground',
        tone === 'primary' && 'text-primary',
        className
      )}
    >
      {children}
    </button>
  );
}

/** Section label inside a picker — "Day of month", "Specific days". */
export function ChipSectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-muted-foreground px-2 pt-2 pb-1 text-[10px] font-medium tracking-wider uppercase">
      {children}
    </p>
  );
}
