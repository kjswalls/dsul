'use client';

import { useId, type ReactNode } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { clockTime, type ActivityRow } from '@/lib/ask-home';
import { openConversation } from '@/lib/open-chat';
import { usePlannerStore } from '@/lib/planner-store';
import { openEditFor } from '@/lib/ui-store';
import type { Task } from '@/lib/planner-types';
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
 */
export function AIActivity({ rows }: { rows: readonly ActivityRow[] }) {
  const timeFormat = usePlannerStore((s) => s.timeFormat);
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const headingId = useId();
  if (rows.length === 0) return null;
  const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <section aria-labelledby={headingId} data-testid="ai-activity" className="-mx-2 flex flex-col gap-1">
      <h3 id={headingId} className="px-2 text-[11px] font-medium text-muted-foreground">
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
                title={row.title}
                meta={row.meta}
                state={row.state}
              />
            ) : (
              <ActivityButton
                focusKey={`conv:${row.conversationId}`}
                onClick={() =>
                  openConversation(row.conversationId, false, { returnFocus: `conv:${row.conversationId}` })
                }
                glyph={
                  row.itemId ? (
                    <span aria-hidden className="text-[13px] leading-none text-muted-foreground">
                      ☐
                    </span>
                  ) : (
                    <Sparkles aria-hidden className="size-3.5 text-ai" />
                  )
                }
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

function openItem(itemId: string) {
  const item = usePlannerStore.getState().items.find((i) => i.id === itemId);
  if (item) openEditFor(item as unknown as Task, item.type === 'habit' ? 'habit' : 'task');
}

function ActivityButton({
  focusKey,
  onClick,
  glyph,
  title,
  meta,
  state,
}: {
  focusKey: string;
  onClick: () => void;
  glyph: ReactNode;
  title: string;
  meta: string;
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
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{meta}</span>
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
