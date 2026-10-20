'use client';

import { usePrepPacksStore } from '@/lib/prep-packs-store';
import { cn } from '@/lib/utils';

/**
 * The AI work badges (Kirby's picks, 2026-10-20, memory/plans/power-mode.md):
 * what a row says while the AI works on it, and once something is waiting.
 *
 *   working  the relay in one row, six tiles with a glowing wave walking
 *            across them, and the title beside it shimmering lime into teal
 *            (globals.css, `[data-ai-relay]`). The title takes the sheen from
 *            the relay being its sibling, so a row only has to render this.
 *   ready    a word chip on an aurora fill ("draft ready"), still. A question
 *            is the same chip warm, honey into coral, because it is the one
 *            that wants something from the person.
 *
 * Both are pure marks: what to say is decided by the caller (agent-status.ts
 * for a handed-off item, the prep store for a pack), never here.
 */

const TILES = [0, 1, 2, 3, 4, 5];

/** The working mark. `label` is for assistive tech; the tiles are hidden. */
export function RelayRow({
  label,
  className,
  ...rest
}: { label: string; className?: string } & Omit<React.ComponentPropsWithRef<'span'>, 'children'>) {
  return (
    <span {...rest} data-ai-relay="" data-testid="ai-working" className={className}>
      {TILES.map((i) => (
        <i key={i} aria-hidden />
      ))}
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** The ready chip: a few words on the aurora fill, or the warm one for a question. */
export function AiChip({
  tone = 'ready',
  className,
  children,
  ...rest
}: { tone?: 'ready' | 'question'; className?: string; children: React.ReactNode } & Omit<
  React.ComponentPropsWithRef<'span'>,
  'children'
>) {
  return (
    <span {...rest} data-ai-chip={tone} data-testid="ai-chip" className={cn(className)}>
      {children}
    </span>
  );
}

/**
 * A row the AI is getting ready right now (lib/prep-packs-store.ts). One
 * selector per row, a boolean, so a row re-renders only when its own state
 * flips; nothing ticks.
 */
export function PrepWorking({ itemId, className }: { itemId: string; className?: string }) {
  const preparing = usePrepPacksStore((s) => s.preparing[itemId] === true);
  if (!preparing) return null;
  return <RelayRow label="Getting this ready" className={className} />;
}
