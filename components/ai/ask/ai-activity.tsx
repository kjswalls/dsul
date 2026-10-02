'use client';

import { useId, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { ConversationGlyph } from '@/components/ai/ask/history-view';
import { ASK_SECTION_HEADING } from '@/components/ai/ask/needs-you';
import { clockTime, type ActivityRow } from '@/lib/ask-home';
import { openConversation, openItemFromAsk } from '@/lib/open-chat';
import type { AskSurface } from '@/lib/rail-store';
import { usePlannerStore } from '@/lib/planner-store';
import { cn } from '@/lib/utils';

type AgentRowState = Extract<ActivityRow, { kind: 'agent' }>['state'];

/**
 * Ask home's "With AI activity": what the AI has been doing, newest first, at
 * most five rows (lib/ask-home.ts `activityRows`). No "See all": History is one
 * tap away in the header, and a second way in would be invented UI.
 *
 *   ◌ Gift for Ari           OpenClaw · 12m   a run in flight
 *   ● Phone plans            back             came back today (the lime dot)
 *   ○ Find a plumber         Couldn't finish
 *   ✦ Plan for today         8:02             a conversation today
 *   ☐ File taxes             7:40             an item's conversation today
 *
 * A run's row opens its item. A conversation's opens it (`openConversation`):
 * an item's conversation opens the item on its Conversation section. Each row
 * is the `data-ask-focus` target Back hands focus back to.
 *
 * The glyphs are aria-hidden, so each row says what it is in words a screen
 * reader hears first ("Item conversation: File taxes"), and a state the
 * right-hand side already words ("back", "Gone quiet", "Couldn't finish") is
 * said once, by that prefix.
 */
export function AIActivity({ rows, surface = 'desktop' }: { rows: readonly ActivityRow[]; surface?: AskSurface }) {
  const timeFormat = usePlannerStore((s) => s.timeFormat);
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const headingId = useId();
  if (rows.length === 0) return null;
  const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <section aria-labelledby={headingId} data-testid="ai-activity" className="-mx-2 flex flex-col gap-1">
      <h3 id={headingId} className={cn(ASK_SECTION_HEADING, 'px-2')}>
        With AI activity
      </h3>
      <ul className="flex flex-col">
        {rows.map((row) => (
          <li key={row.kind === 'agent' ? `item:${row.itemId}` : `conv:${row.conversationId}`}>
            {row.kind === 'agent' ? (
              <ActivityButton
                focusKey={`item:${row.itemId}`}
                onClick={() => openItem(row.itemId)}
                glyph={<AgentGlyph state={row.state} />}
                kind={AGENT_KIND[row.state]}
                title={row.title}
                meta={row.meta}
                metaSaid={row.state !== 'working'}
                state={row.state}
              />
            ) : (
              <ActivityButton
                focusKey={`conv:${row.conversationId}`}
                onClick={() =>
                  openConversation(row.conversationId, surface === 'phone', { returnFocus: `conv:${row.conversationId}` })
                }
                // Lucide's, as History draws them: a text "☐" fell back to
                // each layout's face, about 6px in the monospace ones.
                glyph={<ConversationGlyph itemId={row.itemId} done={row.done} />}
                kind={row.itemId ? 'Item conversation' : 'Conversation'}
                title={row.title}
                meta={clockTime(row.at, tz, timeFormat === '24h' ? '24h' : '12h')}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * What a run's row is, in words, before its title. A run in flight is named by
 * the right-hand side's "OpenClaw · 12m"; the rest say their state here, and
 * the right-hand side, which says it again, is hidden from a screen reader.
 */
const AGENT_KIND: Record<AgentRowState, string> = {
  working: 'Working on',
  back: 'Came back',
  quiet: 'Gone quiet',
  failed: "Couldn't finish",
};

function openItem(itemId: string) {
  const item = usePlannerStore.getState().items.find((i) => i.id === itemId);
  if (item) openItemFromAsk(item);
}

function ActivityButton({
  focusKey,
  onClick,
  glyph,
  kind,
  title,
  meta,
  metaSaid = false,
  state,
}: {
  focusKey: string;
  onClick: () => void;
  glyph: ReactNode;
  /** The row's kind, said before its title ("Conversation", "Came back"). */
  kind: string;
  title: string;
  meta: string;
  /** The kind already says what `meta` does: shown, not read twice. */
  metaSaid?: boolean;
  state?: AgentRowState;
}) {
  return (
    <button
      type="button"
      data-ask-focus={focusKey}
      data-testid="ai-activity-row"
      data-state={state}
      onClick={onClick}
      className="flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <span className="flex size-4 shrink-0 items-center justify-center">{glyph}</span>
      <span className="min-w-0 flex-1 truncate">
        <span className="sr-only">{kind}: </span>
        {title}
      </span>
      <span aria-hidden={metaSaid || undefined} className="shrink-0 text-xs text-muted-foreground">
        {meta}
      </span>
    </button>
  );
}

/**
 * The run's state at a glance. The spinner only while the run is live, which
 * is the only time a spinner is honest; "Gone quiet" stands still. The lime
 * dot is its own element, never inside anything faded (CLAUDE.md: the accent
 * is never dimmed through a parent's opacity).
 */
function AgentGlyph({ state }: { state: AgentRowState }) {
  switch (state) {
    case 'working':
      return <Loader2 aria-hidden className="size-3.5 animate-spin text-ai motion-reduce:animate-none" />;
    case 'back':
      return <span aria-hidden data-lime-dot="" className="size-2 rounded-full bg-primary" />;
    default:
      return (
        <span
          aria-hidden
          className={cn('size-2 rounded-full border border-muted-foreground', state === 'quiet' && 'border-dashed')}
        />
      );
  }
}
