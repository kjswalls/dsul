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
 *   working  on the row itself, wherever the item is (Kirby, 2026-10-24):
 *            the relay beside the title, and the title shimmering lime into
 *            teal (globals.css). WorkingMark is the title's sibling that draws
 *            the relay, turns the sheen on, and carries the words a screen
 *            reader hears. Nothing else says it: no dock line, no count.
 *   relay    six tiles with a glowing wave walking across them: a working
 *            row's mark, and the do stuff key's bolt while anything is.
 *   ready    nothing on the rows. One line in the dock counts what is ready
 *            (components/notices/ai-work-notice.tsx), and the item panel shows
 *            the pack. AiChip, the aurora words, is left to Do stuff's own
 *            lanes and the key's count.
 *
 * All of them are pure marks: what to say is decided by the caller
 * (agent-status.ts for a handed-off item, the prep store for a pack), never
 * here.
 */

const TILES = [0, 1, 2, 3, 4, 5];

/** The relay. `label` is for assistive tech; the tiles are hidden. */
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

/** The ready words: a few words in aurora ink (no fill since 2026-10-23), or the warm one for a question. */
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
 * A row's working mark: the relay, beside the title, and the title shimmers
 * (globals.css, `[data-ai-working]`, which needs this to be the title's
 * sibling). The label says what for to assistive tech.
 */
export function WorkingMark({ label }: { label: string }) {
  return <RelayRow label={label} data-ai-working="" />;
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
