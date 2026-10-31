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
 *            the title shimmering lime into teal (globals.css). WorkingMark
 *            is the title's sibling that turns the sheen on and carries the
 *            words a screen reader hears; it draws nothing (Kirby,
 *            2026-10-31: the relay beside the title was too much motion on
 *            the plan). No dock line, no count.
 *   relay    six tiles with a glowing wave walking across them: the do stuff
 *            key's bolt while anything is worked on, a working row's hover
 *            dot (AiDot), and the open item's status, big (WorkingStatus).
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

/** The relay. `label` is for assistive tech (none where a sibling says it); the tiles are hidden. */
export function RelayRow({
  label,
  size,
  className,
  ...rest
}: { label?: string; size?: 'big'; className?: string } & Omit<React.ComponentPropsWithRef<'span'>, 'children'>) {
  return (
    <span data-testid="ai-relay" {...rest} data-ai-relay={size ?? ''} className={className}>
      {TILES.map((i) => (
        <i key={i} aria-hidden />
      ))}
      {label && <span className="sr-only">{label}</span>}
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
 * A row's working mark: the title shimmers (globals.css, `[data-ai-working]`,
 * which needs this to be the title's sibling). It draws nothing itself; the
 * label says what for to assistive tech.
 */
export function WorkingMark({ label }: { label: string }) {
  return (
    <span data-ai-working="" data-testid="ai-working">
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * The open item's line while the AI gets it ready (Kirby, 2026-10-31): the
 * relay, big, under the title. The panel is where you asked to look, so the
 * wave that left the rows plays here. An agent's run says it in its own
 * status line instead (item-detail-sections.tsx AgentStatus).
 */
export function PrepStatus({ itemId }: { itemId: string }) {
  const preparing = usePrepPacksStore((s) => s.preparing[itemId] === true);
  if (!preparing) return null;
  return (
    <div data-testid="prep-status" className="text-muted-foreground flex items-center gap-2.5 text-xs">
      <RelayRow size="big" aria-hidden />
      <span>Getting this ready</span>
    </div>
  );
}

/**
 * A row's AI mark while its hover buttons are up (Kirby's pick C,
 * 2026-10-31): the buttons sit where the chip does, so the chip steps
 * aside (globals.css, `[data-row-ai-fold]`) and this dot waits just left
 * of them, the status in its tooltip. aria-hidden: the row's own mark
 * still carries the words for a reader.
 */
export function AiDot({
  tone,
  className,
  ...rest
}: { tone: 'ready' | 'working' | 'question' | 'quiet'; className?: string } & Omit<
  React.ComponentPropsWithRef<'span'>,
  'children'
>) {
  return (
    <span {...rest} aria-hidden data-row-ai-dot={tone} data-testid="ai-dot" className={className}>
      {/* A live run plays the relay here, the one place a row still moves:
          only while you point at it (Kirby, 2026-10-31). */}
      {tone === 'working' ? <RelayRow /> : <span data-ai-dot={tone} />}
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
