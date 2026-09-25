'use client';

import type { ComponentPropsWithRef, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { RailTooltip } from '@/components/primitives/pills';
import { cn } from '@/lib/utils';

/**
 * The hover controls on a row or a schedule block: small ghost icons sitting in
 * one quiet capsule (RowControlGroup), each answering on hover with the rail's
 * tooltip. They replaced a run of separate 22px bordered boxes, which read as
 * four buttons where there is really one strip of actions.
 *
 * Only neutral and destructive tokens in here, never the lime primary: in Week ×
 * Schedule these render inside day columns that the hover recede fades, and the
 * accent must not composite through that (CLAUDE.md, the week recede).
 */
export function RowControl({
  icon: Icon,
  label,
  detail,
  destructive,
  disabled,
  onClick,
  className,
  iconClassName,
  testId,
  tooltip = true,
  ...rest
}: {
  icon: LucideIcon;
  label: string;
  /** Optional second line for the tooltip (e.g. the target date). */
  detail?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
  iconClassName?: string;
  /**
   * Stable handle for e2e. These controls are otherwise addressed by their
   * `label` copy, and 'Delete' alone collides with the confirm dialog's button,
   * the mobile swipe action and the schedule sheet — four elements, one name.
   */
  testId?: string;
  /** Off on touch, where there is no hover to answer and a tap would open it. */
  tooltip?: boolean;
} & Omit<ComponentPropsWithRef<'button'>, 'onClick' | 'children' | 'title'>) {
  const button = (
    <button
      type="button"
      {...rest}
      // No native `title`: it fires a second, unstyleable tooltip beside the
      // rail one (pills.tsx).
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      onClick={(e) => {
        // The row and the block both open the editor on click; the rail wrapper
        // already swallows this for rows, and blocks rely on it here.
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-[4px] text-muted-foreground transition-colors',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-muted-foreground',
        // Hover styles are dropped entirely rather than overridden when
        // disabled: :hover still fires on a disabled button, so leaving them in
        // would light up a control that does nothing.
        disabled
          ? 'cursor-not-allowed opacity-40'
          : destructive
            ? 'hover:bg-destructive/10 hover:text-destructive'
            : 'hover:bg-accent hover:text-foreground',
        className
      )}
    >
      <Icon className={cn('h-3 w-3', iconClassName)} strokeWidth={2.25} />
    </button>
  );
  if (!tooltip) return button;
  // A disabled button gets no pointer events, so the tip hangs off a wrapper.
  return (
    <RailTooltip label={label} detail={detail}>
      {disabled ? <span className="flex">{button}</span> : button}
    </RailTooltip>
  );
}

/**
 * The capsule the controls sit in: one hairline pill on an opaque surface, so it
 * reads cleanly where it overlays a title (compact week rows, schedule blocks).
 */
export function RowControlGroup({
  children,
  className,
  ...rest
}: { children: ReactNode; className?: string } & Omit<ComponentPropsWithRef<'span'>, 'children'>) {
  return (
    <span
      {...rest}
      className={cn(
        'flex flex-shrink-0 items-center gap-px rounded-[6px] border border-border bg-surface-2 p-px shadow-sm',
        className
      )}
    >
      {children}
    </span>
  );
}

/** A hairline between groups inside the capsule (the count stepper | actions). */
export function RowControlDivider() {
  return <span aria-hidden className="mx-0.5 h-3 w-px flex-shrink-0 bg-border" />;
}
