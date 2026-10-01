'use client';

import { cn } from '@/lib/utils';
import { costLabel } from '@/lib/extension-catalog';
import type { ExtensionManifest } from '@/lib/extension-registry';
import type { ExtensionState } from '@/lib/settings/extension-state';

/**
 * The state word, drawn the way the settings index draws it: a dot marks a
 * value, and the lime rides its own element so it never inherits an opacity.
 */
export function ExtensionStatePill({ state }: { state: ExtensionState }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-[5px] px-1.5 py-0.5 text-[10px] font-medium',
        state.on ? 'bg-secondary text-foreground' : 'text-muted-foreground'
      )}
    >
      <span
        className={cn('size-[6px] rounded-full', state.on ? 'bg-primary' : 'bg-muted-foreground/40')}
        aria-hidden
      />
      {state.label}
    </span>
  );
}

/**
 * What an extension needs, what it can cost, and — when it is switched on but
 * doing nothing — why. The reason is the pane's own sentence, so the card and
 * the pane say the same thing.
 */
export function ExtensionChips({
  extension,
  state,
  className,
}: {
  extension: ExtensionManifest;
  state?: ExtensionState;
  className?: string;
}) {
  const cost = costLabel(extension);
  const reason = state?.reason;
  if (!extension.needs?.length && !cost && !reason) return null;
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {extension.needs?.map((need) => (
        <span key={need} className="bg-secondary text-secondary-foreground rounded-[5px] px-1.5 py-0.5 text-[11px]">
          Needs {need}
        </span>
      ))}
      {cost && (
        <span
          className="rounded-[5px] px-1.5 py-0.5 text-[11px]"
          style={{ background: 'var(--coral-tint)', color: 'var(--coral-ink)' }}
          data-extension-cost={extension.costs}
        >
          {cost}
        </span>
      )}
      {reason && (
        <span className="bg-secondary text-secondary-foreground rounded-[5px] px-1.5 py-0.5 text-[11px] first-letter:uppercase">
          {reason}
        </span>
      )}
    </div>
  );
}
