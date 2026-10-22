'use client';

import { useEffect } from 'react';
import { usePlannerStore } from '@/lib/planner-store';
import { useBackgroundPrep } from '@/hooks/use-background-prep';
import { usePrepPacksStore } from '@/lib/prep-packs-store';
import { cn } from '@/lib/utils';

/**
 * The AI work badges (Kirby's picks, 2026-10-20, then made quieter on
 * 2026-10-22, memory/plans/power-mode.md): what the AI is doing, said as
 * quietly as it can be.
 *
 *   working  on a row, the title alone: it shimmers lime into teal while the
 *            AI works on it (globals.css). WorkingMark is the title's
 *            invisible sibling that turns the sheen on, and the words a screen
 *            reader hears.
 *   relay    six tiles with a glowing wave walking across them. The account's
 *            mark, never a row's: the do stuff key's bolt and the dock's line
 *            while anything is being worked on.
 *   ready    nothing on the rows. One line in the dock counts what is ready
 *            (components/notices/ai-work-notice.tsx), and the item panel shows
 *            the pack. AiChip, the aurora word chip, is left to Do stuff's own
 *            lanes and the key's count.
 *
 * All of them are pure marks: what to say is decided by the caller
 * (agent-status.ts for a handed-off item, the prep store for a pack), never
 * here.
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
 * A row's working mark: the title beside it shimmers (globals.css,
 * `[data-ai-working]`), and this says what for to assistive tech. Nothing
 * else is drawn, so a list with work going on reads as a list, not a row of
 * badges.
 */
export function WorkingMark({ label }: { label: string }) {
  return (
    <span data-ai-working="" data-testid="ai-working" className="sr-only">
      {label}
    </span>
  );
}

/**
 * A row the AI is getting ready right now (lib/prep-packs-store.ts). One
 * selector per row, a boolean, so a row re-renders only when its own state
 * flips; nothing ticks.
 */
export function PrepWorking({ itemId }: { itemId: string }) {
  const preparing = usePrepPacksStore((s) => s.preparing[itemId] === true);
  if (!preparing) return null;
  return <WorkingMark label="Getting this ready" />;
}

/**
 * Reads the account's packs once at sign-in (a GET that asks no model), so a
 * the dock's ready line and the do stuff key's count are there on every surface,
 * the phone's Today included, before Do stuff is ever started. Mounted once,
 * in the app shell; renders nothing. It also runs background prep
 * (hooks/use-background-prep.ts), which does nothing until the person turns it on.
 */
export function PrepPacksBoot() {
  useBackgroundPrep();
  const userId = usePlannerStore((s) => s.userId);
  useEffect(() => {
    if (userId) void usePrepPacksStore.getState().load(userId);
  }, [userId]);
  return null;
}
