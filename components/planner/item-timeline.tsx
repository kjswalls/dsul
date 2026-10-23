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
  foldLine,
  foldTimeline,
  talkLine,
  type ChangeEntry,
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
 * Where the item's conversation is on screen, the timeline is drawn INSIDE it,
 * as one stream (components/ai/item-conversation.tsx, `buildStream`), and this
 * section is not mounted. This is the timeline everywhere else: with no AI, the
 * changes alone; with AI and no conversation here, a day's talk as one line.
 * Either way, a long history shows its newest lines under "Show N earlier".
 *
 * Quiet when there is nothing: no heading over an empty list.
 */

const NO_MESSAGES: ChatMessage[] = [];

/** Fetched again this long after the item last changed, so a save shows up without a reload. */
const REFETCH_MS = 800;

/** "OC" for OpenClaw, the first letter for any other agent ("C" for Claude). */
function agentInitials(name: string): string {
  return name === 'OpenClaw' ? 'OC' : (name.trim()[0] ?? '?').toUpperCase();
}

export function TimelineAvatar({ who, agent = 'OpenClaw' }: { who: TimelineActor; agent?: string }) {
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
        {agentInitials(agent)}
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

export const TIMELINE_FILTERS: { id: TimelineFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'talk', label: 'Talk' },
  { id: 'changes', label: 'Changes' },
];

/**
 * The item's `item_events`, read at once and again a moment after the item
 * stops changing (an autosave lands, a tick, a drag), so the line for it
 * appears without a reload. Null until the first read lands.
 */
export function useItemEvents(item: Item, enabled = true): ItemEvent[] | null {
  const [events, setEvents] = useState<ItemEvent[] | null>(null);
  const fetchedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // A failed read keeps what is on screen: the timeline is never worth an error.
    const run = () =>
      fetchItemEvents(item.id).then(
        (rows) => {
          if (!cancelled) setEvents(rows);
        },
        () => {}
      );
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
  }, [item, enabled]);
  return events;
}

/** All · Talk · Changes. */
export function TimelineFilterTabs({
  value,
  onChange,
}: {
  value: TimelineFilter;
  onChange: (f: TimelineFilter) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Show" className="flex items-center gap-0.5">
      {TIMELINE_FILTERS.map((f) => (
        <button
          key={f.id}
          type="button"
          role="radio"
          aria-checked={value === f.id}
          data-testid={`item-timeline-filter-${f.id}`}
          onClick={() => onChange(f.id)}
          className={cn(
            'rounded-full px-2 py-0.5 text-[11px] transition-colors',
            value === f.id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

/** A day's heading in the stream. */
export function TimelineDayLine({ label }: { label: string }) {
  return (
    <p
      className="text-muted-foreground/80 font-mono text-[10px] tracking-wider uppercase"
      data-testid="item-timeline-daylabel"
    >
      {label}
    </p>
  );
}

/** One change: who, in full colour, then what, in grey, and the time. */
export function TimelineChangeLine({ entry, as: Tag = 'li' }: { entry: ChangeEntry; as?: 'li' | 'div' }) {
  return (
    <Tag className="flex items-center gap-2" data-testid="item-timeline-change" data-by={entry.by}>
      <TimelineAvatar who={entry.by} agent={entry.agent} />
      <span className="min-w-0 flex-1 truncate text-xs">
        <span className="text-foreground font-medium">
          {entry.by === 'agent' && entry.agent ? entry.agent : ACTOR_LABEL[entry.by]}
        </span>{' '}
        <span className="text-muted-foreground">{entry.text}</span>
      </span>
      <time className="text-muted-foreground/70 shrink-0 font-mono text-[10px]">
        {new Date(entry.at).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })}
      </time>
    </Tag>
  );
}

/** "Show 9 earlier changes": opens the older lines of this run where they are. */
export function TimelineFoldLine({ hidden, onOpen }: { hidden: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="item-timeline-fold"
      className="text-muted-foreground hover:text-foreground flex items-center gap-2 self-start text-xs transition-colors"
    >
      <span className="grid size-5 shrink-0 place-items-center" aria-hidden>
        <span className="bg-border size-1.5 rounded-full" />
      </span>
      {foldLine(hidden)}
    </button>
  );
}

export function ItemTimeline({ item }: { item: Item }) {
  const events = useItemEvents(item);
  const [filter, setFilter] = useState<TimelineFilter>('all');
  const [unfolded, setUnfolded] = useState(false);
  const { canChat } = useAICapabilities();
  const threadId = useConversationsStore((s) => itemThreadId(s, item.id));
  const messages = useConversationsStore((s) => (threadId ? s.threads[threadId]?.messages : undefined) ?? NO_MESSAGES);

  const talk = canChat ? messages : NO_MESSAGES;
  const effective: TimelineFilter = canChat ? filter : 'changes';
  const built = useMemo(
    () =>
      buildTimeline(
        events ?? [],
        talk.map((m) => ({
          role: m.role,
          createdAt: m.createdAt,
          answerer: m.answerer,
        })),
        { filter: effective, now: new Date() }
      ),
    [events, talk, effective]
  );
  const { days, hidden } = useMemo(
    () => (unfolded ? { days: built, hidden: 0 } : foldTimeline(built)),
    [built, unfolded]
  );
  const anything = useMemo(
    () =>
      buildTimeline(
        events ?? [],
        talk.map((m) => ({
          role: m.role,
          createdAt: m.createdAt,
          answerer: m.answerer,
        })),
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
        {canChat && <TimelineFilterTabs value={filter} onChange={setFilter} />}
      </div>
      {days.length === 0 ? (
        <p className="text-muted-foreground text-xs" data-testid="item-timeline-empty">
          {effective === 'talk' ? 'No conversation about this yet.' : 'No changes yet.'}
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {hidden > 0 && (
            <li>
              <TimelineFoldLine hidden={hidden} onOpen={() => setUnfolded(true)} />
            </li>
          )}
          {days.map((day) => (
            <li key={day.key} className="flex flex-col gap-1.5" data-testid="item-timeline-day">
              <TimelineDayLine label={day.label} />
              <ol className="flex flex-col gap-1.5">
                {day.entries.map((entry) =>
                  entry.kind === 'talk' ? (
                    <li key={entry.key} className="flex items-center gap-2" data-testid="item-timeline-talk">
                      <TimelineAvatar who={entry.with} />
                      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{talkLine(entry)}</span>
                    </li>
                  ) : (
                    <TimelineChangeLine key={entry.key} entry={entry} />
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
