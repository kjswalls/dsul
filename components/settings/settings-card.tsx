import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The one container settings are drawn in (direction A, Kirby's pick on
 * 2026-11-05: grouped cards, like macOS System Settings).
 *
 * A pane is a title and a few named sections, and each section is ONE card of
 * rows with hairlines between them. Every pane uses this, so "what belongs
 * together" reads the same everywhere instead of each pane inventing a heading
 * style and a box of its own.
 *
 * The card restyles the SettingRows inside it (flush to the card's edges,
 * square, a little more air) through child selectors (joined, never through
 * tailwind-merge, which has no idea these arbitrary variants are separate) rather than a prop, so a
 * row drawn anywhere else, the ⌘/ shortcuts overlay above all, is unchanged.
 */
export const SETTINGS_CARD_CLASS = [
  'bg-card border-border overflow-hidden rounded-xl border',
  // Hairlines between whatever the card holds: rows, chip groups, custom rows.
  '[&>*+*]:border-border [&>*+*]:border-t',
  // SettingRow is drawn for a bare list (-mx-3, rounded hover wash); in a card
  // it sits flush, and its ring is drawn inside the card's own edge.
  '[&_[data-setting-row]]:mx-0 [&_[data-setting-row]]:rounded-none [&_[data-setting-row]]:px-4 [&_[data-setting-row]]:py-3',
  '[&_[data-setting-row]]:after:rounded-none [&_[data-setting-row]]:after:ring-inset',
  // A root's chips line up with its label.
  '[&_[data-setting-chips]]:px-4',
].join(' ');

export function SettingsCard({
  children,
  className,
  ...rest
}: {
  children: ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div data-settings-card className={cn(SETTINGS_CARD_CLASS, className)} {...rest}>
      {children}
    </div>
  );
}

/** The one section heading style: a quiet sentence-case label above its card. */
export function SettingsSectionLabel({
  children,
  id,
  icon: Icon,
  as: Tag = 'h2',
  className,
  trailing,
}: {
  children: ReactNode;
  id?: string;
  icon?: React.ElementType;
  as?: 'h2' | 'h3' | 'p';
  className?: string;
  /** Drawn at the label's right end: a status pill, a count, a small action. */
  trailing?: ReactNode;
}) {
  return (
    <div className={cn('mb-2 flex min-h-5 items-center gap-2 px-1', className)}>
      <Tag
        id={id}
        className="text-muted-foreground flex items-center gap-1.5 text-[13px] font-medium"
      >
        {Icon && <Icon className="size-3.5" aria-hidden />}
        {children}
      </Tag>
      {trailing && <div className="ml-auto flex items-center gap-2">{trailing}</div>}
    </div>
  );
}

/** A label and its card. Leave `title` out for a pane whose rows need no name. */
export function SettingsSection({
  title,
  id,
  icon,
  trailing,
  children,
  className,
  cardClassName,
  ...rest
}: {
  title?: ReactNode;
  id?: string;
  icon?: React.ElementType;
  trailing?: ReactNode;
  children: ReactNode;
  className?: string;
  cardClassName?: string;
} & Omit<React.HTMLAttributes<HTMLElement>, 'title'>) {
  const headingId = id ? `${id}-label` : undefined;
  return (
    <section
      aria-labelledby={title ? headingId : undefined}
      className={cn('flex flex-col', className)}
      {...rest}
    >
      {title && (
        <SettingsSectionLabel id={headingId} icon={icon} trailing={trailing}>
          {title}
        </SettingsSectionLabel>
      )}
      <SettingsCard className={cardClassName}>{children}</SettingsCard>
    </section>
  );
}
