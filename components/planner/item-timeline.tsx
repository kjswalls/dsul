'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { User, Workflow } from 'lucide-react';
import { AskMark } from '@/components/ai/ask-mark';
import { BandLabel } from '@/components/planner/item-bands';
import { itemThreadId } from '@/components/ai/item-conversation';
import { fetchItemEvents, getItemEventsAvailable, type ItemEvent } from '@/lib/db';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { useConversationsStore, type ChatMessage } from '@/lib/conversations-store';
import {
  ACTOR_LABEL,
  buildTimeline,
  talkLine,
  type TimelineActor,
  type TimelineFilter,
} from '@/lib/item-timeline';
import type { Item } from '@/lib/planner-types';
import { cn } from '@/lib/utils';

/**
 * An item's timeline (lib/item-timeline.ts): what changed on it and what was
 * said about it, oldest first, by day, each line with who did it. It took the
 * place of the Activity list and the panel footer's edit history.
 *
 * With AI, All · Talk · Changes filter it, and a day's conversation is one
 * folded line (the conversation itself is drawn under the details). With no
 * AI there is no filter and no talk: the changes alone, as before.
 *
 * Quiet when there is nothing: no heading over an empty list.
 */

const NO_MESSAGES: ChatMessage[] = [];

/** Fetched again this long after the item last changed, so a save shows up without a reload. */
const REFETCH_MS = 800;

function Avatar({ who }: { who: TimelineActor }) {
  const base = 'grid size-5 shrink-0 place-items-center rounded-full text-[9px] font-semibold';
  if (who === 'ai')
    return (
      <span className={cn(base, 'bg-secondary')} aria-hidden>
        <AskMark className="size-3" />
      </span>
    );
  if (who === 'agent')
    return (
      <span className={cn(base, 'bg-foreground text-background')} aria-hidden>
        OC
      </span>
    );
  if (who === 'recipe')
    return (
      <span className={cn(base, 'bg-secondary text-muted-foreground')} aria-hidden>
        <Workflow className="size-3" />
      </span>
    );
  return (
    <span className={cn(base, 'bg-secondary text-muted-foreground')} aria-hidden>
      <User className="size-3" />
    </span>
  );
}

const FILTERS: { id: TimelineFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'talk', label: 'Talk' },
  { id: 'changes', label: 'Changes' },
];

export function ItemTimeline({ item }: { item: Item }) {
  const [events, setEvents] = useState<ItemEvent[] | null>(null);
  const [filter, setFilter] = useState<TimelineFilter>('all');
  const { canChat } = useAICapabilities();
  const threadId = useConversationsStore((s) => itemThreadId(s, item.id));
  const messages = useConversationsStore((s) => (threadId ? s.threads[threadId]?.messages : undefined) ?? NO_MESSAGES);

  // The first read at once; later ones a moment after the item stops changing
  // (an autosave lands, a tick, a drag), so the line for it appears here too.
  const fetchedFor = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const run = () =>
      fetchItemEvents(item.id).then((rows) => {
        if (!cancelled) setEvents(rows);
      });
    if (fetchedFor.current !== item.id) {
      fetchedFor.current = item.id;
      void run();
      return () => {
        cancelled = true;
      };
    }
    const t = setTimeout(run, REFETCH_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [item]);

  const talk = canChat ? messages : NO_MESSAGES;
  const effective: TimelineFilter = canChat ? filter : 'changes';
  const days = useMemo(
    () =>
      buildTimeline(
        events ?? [],
        talk.map((m) => ({ role: m.role, createdAt: m.createdAt, answerer: m.answerer })),
        { filter: effective, now: new Date() }
      ),
    [events, talk, effective]
  );
  const anything = useMemo(
    () =>
      buildTimeline(
        events ?? [],
        talk.map((m) => ({ role: m.role, createdAt: m.createdAt, answerer: m.answerer })),
        { filter: 'all', now: new Date() }
      ).length > 0,
    [events, talk]
  );

  if (!anything || (!getItemEventsAvailable() && talk.length === 0)) return null;

  return (
    <section data-testid="item-timeline" aria-labelledby={`item-timeline-${item.id}`} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <BandLabel>
          <span id={`item-timeline-${item.id}`}>Timeline</span>
        </BandLabel>
        {canChat && (
          <div role="radiogroup" aria-label="Show" className="flex items-center gap-0.5">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={filter === f.id}
                data-testid={`item-timeline-filter-${f.id}`}
                onClick={() => setFilter(f.id)}
                className={cn(
                  'rounded-full px-2 py-0.5 text-[11px] transition-colors',
                  filter === f.id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {days.length === 0 ? (
        <p className="text-muted-foreground text-xs" data-testid="item-timeline-empty">
          {effective === 'talk' ? 'No conversation about this yet.' : 'No changes yet.'}
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {days.map((day) => (
            <li key={day.key} className="flex flex-col gap-1.5" data-testid="item-timeline-day">
              <p className="text-muted-foreground/80 font-mono text-[10px] tracking-wider uppercase">{day.label}</p>
              <ol className="flex flex-col gap-1.5">
                {day.entries.map((entry) =>
                  entry.kind === 'talk' ? (
                    <li key={entry.key} className="flex items-center gap-2" data-testid="item-timeline-talk">
                      <Avatar who={entry.with} />
                      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{talkLine(entry)}</span>
                    </li>
                  ) : (
                    <li
                      key={entry.key}
                      className="flex items-center gap-2"
                      data-testid="item-timeline-change"
                      data-by={entry.by}
                    >
                      <Avatar who={entry.by} />
                      <span className="min-w-0 flex-1 truncate text-xs">
                        <span className="text-foreground font-medium">{ACTOR_LABEL[entry.by]}</span>{' '}
                        <span className="text-muted-foreground">{entry.text}</span>
                      </span>
                      <time className="text-muted-foreground/70 shrink-0 font-mono text-[10px]">
                        {new Date(entry.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}
                      </time>
                    </li>
                  )
                )}
              </ol>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
